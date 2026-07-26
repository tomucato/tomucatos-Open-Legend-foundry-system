/**
 * Open Legend Active Effect: every effect can be a power-level-scaled
 * condition.
 *
 * Each change row may carry a Level (edited on the effect config's Changes
 * tab, stored in `flags.openlegend.changeLevels` parallel to system.changes),
 * and the effect has a current Power Level (`flags.openlegend.powerLevel`).
 * At application time, a row applies when its level is at or below the current
 * power level AND no same-key row has a higher qualifying level — i.e. for
 * every key, the strongest row the current level unlocks wins. Rows at level 0
 * (the default) are an always-active baseline.
 *
 * Example — Demoralized: rows "disadvantage 1 @ level 3", "disadvantage 2
 * @ level 6", "disadvantage 3 @ level 8". At PL 6 only the second row applies;
 * stepping the effect's power level up or down (Effects tab) re-applies the
 * matching row. Below level 3 the condition is purely descriptive.
 */
export class OpenLegendActiveEffect extends ActiveEffect {

  /**
   * Decorate each change row with its per-row level and modifier type from the
   * parallel flag arrays, so both survive the deepClone the Actor's
   * change-application loop makes and are visible to {@link
   * OpenLegendActiveEffect.applyChange}.
   * @override
   */
  prepareDerivedData() {
    super.prepareDerivedData();
    const levels = this.flags?.openlegend?.changeLevels;
    const modes = this.flags?.openlegend?.changeModes;
    (this.system?.changes ?? []).forEach((change, i) => {
      if ( Array.isArray(levels) ) change.level = Math.max(0, Math.floor(Number(levels[i]) || 0));
      if ( Array.isArray(modes) ) change.modifierType = (modes[i] === "advdis") ? "advdis" : "flat";
    });
  }

  /**
   * Resolve a change row (subject in change.key + its modifier type) to the
   * actual data path it writes and the signed delta it contributes. Returns
   * null when the row is a no-op (e.g. an adv/dis modifier on a flat-only
   * subject like Speed, or a flat modifier on a roll scope).
   *
   * Mapping:
   *   - FLAT      → the subject's `flat` data path; value as authored.
   *   - ADV/DIS   → per-attribute or global roll flag; a "penalty" action
   *                 flips the sign so it grants DISADVANTAGE. (For flat, the
   *                 penalty sign is already baked into change.value at submit
   *                 time, so adv/dis is the only place we re-sign here.)
   * @param {object} change  A change row carrying `modifierType` (defaults flat).
   * @returns {{key: string, signed: boolean}|null}
   */
  static resolveTarget(change) {
    // Unresolved drop-time placeholder (e.g. Bolster before an attribute is
    // chosen): a no-op until the apply path rewrites it to attr.<chosen>.
    if ( change.key === "attr.__prompt__" ) return null;
    const subjects = CONFIG.OPENLEGEND?.effectSubjects ?? {};
    const subject = subjects[change.key];
    if ( !subject ) return { key: change.key, signed: false }; // off-catalog: apply as-authored

    // Half / Double (native "multiply") scale the subject's NUMBER, so they only
    // make sense on a flat-numeric subject — a no-op on roll scopes (which have
    // no number). The modifier type is irrelevant for these.
    if ( change.type === "multiply" ) {
      return subject.flat ? { key: subject.flat, signed: false } : null;
    }

    const advdis = (change.modifierType === "advdis");
    if ( !advdis ) {
      // Flat modifier: change the stat number in place. No-op on roll scopes.
      return subject.flat ? { key: subject.flat, signed: false } : null;
    }

    // Adv/dis modifier: grant advantage / disadvantage on the relevant rolls.
    // The sign of the value selects which (negative → disadvantage); the config
    // sheet has already negated "penalty" values, so we just route by subject.
    if ( subject.attr ) return { key: `flags.openlegend.attrMod.${subject.attr}`, signed: true };
    if ( subject.rollScope === "all" ) return { key: "flags.openlegend.rollMod", signed: true };
    if ( subject.rollScope === "attack" ) return { key: "flags.openlegend.attackMod", signed: true };
    if ( subject.rollScope === "non-attack" ) return { key: "flags.openlegend.nonAttackMod", signed: true };
    return null; // adv/dis on a flat-only subject (defense, Speed, HP) does nothing
  }

  /**
   * Whether a change row is active at the effect's current power level: its
   * level must be reached, and no row resolving to the SAME target may have a
   * higher level that is also reached (the strongest unlocked row per resolved
   * target wins — so an attribute's flat and adv/dis rows don't compete).
   * @param {object} change  A change row (or its clone) carrying `level`.
   * @returns {boolean}
   */
  isChangeActive(change) {
    const fl = this.flags?.openlegend ?? {};
    const level = Math.max(0, Math.floor(Number(change.level) || 0));

    // Stacking condition (e.g. Fatigued): the current level is the STACK count,
    // a separate axis from power level. Every row whose tier ≤ the stack is
    // active — effects accumulate (no strongest-wins filter).
    if ( fl.stacking ) {
      const stack = Math.max(0, Math.floor(Number(fl.stackLevel) || 0));
      if ( !OpenLegendActiveEffect.resolveTarget(change)?.key ) return false; // no-op rows
      return level <= stack;
    }

    // Normal leveled effect: the level is a POWER-LEVEL threshold, and for each
    // resolved target only the strongest unlocked row wins.
    const pl = Math.max(0, Math.floor(Number(fl.powerLevel) || 0));
    if ( level > pl ) return false;
    const target = OpenLegendActiveEffect.resolveTarget(change)?.key;
    if ( !target ) return false; // no-op rows never "win"
    return !(this.system?.changes ?? []).some(other =>
      (OpenLegendActiveEffect.resolveTarget(other)?.key === target)
      && (Math.max(0, Math.floor(Number(other.level) || 0)) > level)
      && (Math.max(0, Math.floor(Number(other.level) || 0)) <= pl)
    );
  }

  /**
   * Apply a change row, after (1) skipping rows the current power level doesn't
   * activate and (2) rewriting the row's key/value from its subject + modifier
   * type (see {@link resolveTarget}). A resolved no-op row applies nothing.
   * Rows from effects without our flags fall through to core behavior.
   * @override
   */
  static applyChange(targetDoc, change, options) {
    const effect = change.effect;
    if ( (effect instanceof OpenLegendActiveEffect) ) {
      if ( !effect.isChangeActive(change) ) return {};
      const resolved = OpenLegendActiveEffect.resolveTarget(change);
      if ( !resolved ) return {};
      if ( resolved.key !== change.key ) {
        // Apply against the resolved path. Adv/dis flags accumulate by ADD so
        // multiple sources stack; preserve the authored type for flat targets.
        const rewritten = foundry.utils.mergeObject(change, {
          key: resolved.key,
          type: resolved.signed ? "add" : change.type
        }, { inplace: false });
        return super.applyChange(targetDoc, rewritten, options);
      }
    }
    return super.applyChange(targetDoc, change, options);
  }

  /**
   * Keep a bane/boon condition's name tag in sync when its level changes
   * (Effects tab steppers, config sheet, macros). A stacking condition shows
   * "Name Level N" off stackLevel; a normal one shows "Name PL N" off powerLevel.
   * @override
   */
  async _preUpdate(changed, options, user) {
    const source = this.flags?.openlegend?.fromBane ?? this.flags?.openlegend?.fromBoon;
    if ( !source || ("name" in changed) ) return super._preUpdate(changed, options, user);

    const stacking = foundry.utils.getProperty(changed, "flags.openlegend.stacking")
      ?? this.flags?.openlegend?.stacking;
    if ( stacking ) {
      const newStack = foundry.utils.getProperty(changed, "flags.openlegend.stackLevel");
      if ( newStack !== undefined ) {
        const n = Math.max(1, Math.floor(Number(newStack) || 1));
        changed.name = `${source} Level ${n}`;
      }
    } else {
      const newPl = foundry.utils.getProperty(changed, "flags.openlegend.powerLevel");
      if ( newPl !== undefined ) {
        const pl = Math.max(0, Math.floor(Number(newPl) || 0));
        changed.name = pl ? `${source} PL ${pl}` : source;
      }
    }
    return super._preUpdate(changed, options, user);
  }
}
