import { buildFormula } from "../dice/roll-dialog.mjs";

export class OpenLegendActor extends Actor {
  /**
   * @override
   * prepareData runs the full data-preparation cycle (base then derived).
   */
  prepareData() {
    super.prepareData();
  }

  /**
   * @override
   * Seed a new minion's current HP from its default power level, so it doesn't show the
   * base-template 10 against a PL-derived max (e.g. 4) until first edited. Defenses are
   * derived each cycle, so only HP needs seeding here.
   */
  async _preCreate(data, options, user) {
    const allowed = await super._preCreate(data, options, user);
    if ( allowed === false ) return false;
    if ( this.type === "minion" ) {
      const b = CONFIG.OPENLEGEND?.minionBuildForPowerLevel?.(this.system?.powerLevel);
      if ( b ) this.updateSource({ "system.health.value": b.hp, "system.health.lethal": 0 });
    }
    // Player characters default to LINKED tokens (token data = actor data), so
    // damage/conditions on the canvas hit the real character. Only when the
    // creator didn't explicitly choose a link setting themselves.
    if ( (this.type === "character") && (data?.prototypeToken?.actorLink === undefined) ) {
      this.updateSource({ "prototypeToken.actorLink": true });
    }
    return allowed;
  }

  /**
   * @override
   * Lethal Damage rules: lethal damage reduces BOTH current HP and the maximum by
   * the same amount, and healing lethal restores both. The accrued lethal total is
   * stored in `system.health.lethal`; the max is derived from it. So when the lethal
   * total is edited DIRECTLY (e.g. a GM/player typing into the sheet's Lethal field),
   * mirror the change onto current HP: increasing lethal by N drops current HP by N;
   * decreasing it by N restores N (e.g. 17/20 → set 5 lethal → 12/15 → set 7 → 10/13
   * → clear → 17/20).
   *
   * The damage Apply path (applyLethalDamageToToken) sets `value` AND `lethal`
   * together in one update; we must NOT double-adjust there, so we only cascade when
   * the update changes `lethal` WITHOUT also explicitly setting `value`.
   */
  async _preUpdate(changes, options, user) {
    // XP ↔ Level are linked on actor types that track BOTH (character, companion).
    // Level 1 costs 0 XP; every level AFTER the first is worth 3 XP — so
    // XP = (LEVEL − 1) × 3, and LEVEL = floor(XP / 3) + 1. Editing one field mirrors
    // into the other so budgets keyed on level track XP automatically.
    //
    // IMPORTANT: this sheet uses submitOnChange, so EVERY edit re-submits the whole
    // form — BOTH system.level and system.xp arrive in `changes` on every keystroke,
    // even the field you didn't touch. So we can't decide by presence; we compare
    // each incoming value against the actor's CURRENT stored value and mirror off
    // whichever one actually CHANGED. If (somehow) both changed, LEVEL wins. NPC/
    // boss/minion have a level but no XP — skipped so we never write a phantom field.
    if ( (this.system?.xp !== undefined) ) {
      const curLevel = Math.max(1, Math.floor(Number(this.system?.level ?? 1)));
      const curXp = Math.max(0, Math.floor(Number(this.system?.xp ?? 0)));
      const rawLevel = foundry.utils.getProperty(changes, "system.level");
      const rawXp = foundry.utils.getProperty(changes, "system.xp");
      const inLevel = (rawLevel !== undefined) ? Math.max(1, Math.floor(Number(rawLevel) || 1)) : curLevel;
      const inXp = (rawXp !== undefined) ? Math.max(0, Math.floor(Number(rawXp) || 0)) : curXp;
      const levelChanged = inLevel !== curLevel;
      const xpChanged = inXp !== curXp;
      if ( levelChanged ) {
        // Level edited → XP becomes that level's exact cost.
        foundry.utils.setProperty(changes, "system.level", inLevel);
        foundry.utils.setProperty(changes, "system.xp", (inLevel - 1) * 3);
      } else if ( xpChanged ) {
        // XP edited → level is what that XP has fully paid for.
        foundry.utils.setProperty(changes, "system.xp", inXp);
        foundry.utils.setProperty(changes, "system.level", Math.floor(inXp / 3) + 1);
      }
    }

    // Minion power-level change: HP & defenses are fixed by the new PL, so set current
    // HP to the new max and clear lethal (a fresh statline). Only when the caller isn't
    // already setting health explicitly.
    const nextPL = foundry.utils.getProperty(changes, "system.powerLevel");
    if ( (this.type === "minion") && (nextPL !== undefined)
      && (foundry.utils.getProperty(changes, "system.health.value") === undefined) ) {
      const b = CONFIG.OPENLEGEND?.minionBuildForPowerLevel?.(nextPL);
      if ( b ) {
        foundry.utils.setProperty(changes, "system.health.value", b.hp);
        if ( foundry.utils.getProperty(changes, "system.health.lethal") === undefined ) {
          foundry.utils.setProperty(changes, "system.health.lethal", 0);
        }
      }
    }

    const nextLethalRaw = foundry.utils.getProperty(changes, "system.health.lethal");
    const touchesValue = foundry.utils.getProperty(changes, "system.health.value") !== undefined;
    if ( (nextLethalRaw !== undefined) && !touchesValue ) {
      const base = Math.max(0, Math.floor(Number(this.system?.health?.maxBase ?? this.system?.health?.max ?? 0)));
      const prevLethal = Math.max(0, Math.min(base, Math.floor(Number(this.system?.health?.lethal ?? 0))));
      const nextLethal = Math.max(0, Math.min(base, Math.floor(Number(nextLethalRaw) || 0)));
      // Write back the clamped lethal so the stored value matches what we computed.
      foundry.utils.setProperty(changes, "system.health.lethal", nextLethal);
      const delta = nextLethal - prevLethal;            // +N lethal accrued, −N healed
      if ( delta !== 0 ) {
        const curHp = Number(this.system?.health?.value ?? 0);
        const newMax = Math.max(0, base - nextLethal);
        // Drop current HP by the lethal gained (floor 0); when healing lethal, give
        // the HP back but never above the restored max.
        const nextHp = Math.min(newMax, Math.max(0, curHp - delta));
        foundry.utils.setProperty(changes, "system.health.value", nextHp);
      }
    }

    // Healed to FULL → the character carries no damage, so clear any switch-floor
    // excess (flags.openlegend.formHpExcess — damage banked when a form switch
    // clamped HP up to 1). Without this, a fully-healed character would still carry
    // the banked damage into their next form switch (full main heal → alternate form
    // came back 1 short). Skipped when the update writes the flag itself (the
    // form-switch update manages value + excess together).
    const nextHpRaw = foundry.utils.getProperty(changes, "system.health.value");
    if ( (nextHpRaw !== undefined)
      && (foundry.utils.getProperty(changes, "flags.openlegend.formHpExcess") === undefined)
      && (Number(this.flags?.openlegend?.formHpExcess ?? 0) > 0) ) {
      const base = Math.max(0, Math.floor(Number(this.system?.health?.maxBase ?? this.system?.health?.max ?? 0)));
      const lethalNow = Math.max(0, Number(foundry.utils.getProperty(changes, "system.health.lethal") ?? this.system?.health?.lethal ?? 0));
      const effMax = Math.max(0, base - lethalNow);
      if ( (effMax > 0) && (Number(nextHpRaw) >= effMax) ) {
        foundry.utils.setProperty(changes, "flags.openlegend.formHpExcess", 0);
      }
    }
    return super._preUpdate(changes, options, user);
  }

  /* -------------------------------------------- */

  /**
   * Clamp current HP down to the effective maximum when the max has shrunk — e.g.
   * removing or lowering the Tough as Nails feat drops the derived max, and current
   * HP must follow it down (30 current / 20 max → 20/20). Only writes when current
   * exceeds max, and only as the user who triggered the change (so a single client
   * performs the follow-up update). The derived layer must never mutate current HP
   * (it re-runs on every prepare); this is a one-shot reconcile at the change point.
   * @param {string} userId  The user who triggered the originating change.
   * @returns {Promise<void>}
   * @private
   */
  async #reconcileMaxHp(userId) {
    if ( userId !== game.user?.id ) return;
    const max = Number(this.system?.health?.max ?? 0);
    const cur = Number(this.system?.health?.value ?? 0);
    if ( !Number.isFinite(max) || (cur <= max) ) return;
    await this.update({ "system.health.value": Math.max(0, max) });
  }

  /**
   * @override
   * After an embedded item (e.g. a feat) is deleted, the derived max HP may have
   * dropped — clamp current HP down to it.
   */
  _onDeleteDescendantDocuments(parent, collection, documents, ids, options, userId) {
    super._onDeleteDescendantDocuments(parent, collection, documents, ids, options, userId);
    if ( collection === "items" ) this.#reconcileMaxHp(userId);
  }

  /**
   * @override
   * After an embedded item is updated (e.g. lowering a feat's purchased tier), the
   * derived max HP may have dropped — clamp current HP down to it.
   */
  _onUpdateDescendantDocuments(parent, collection, documents, changes, options, userId) {
    super._onUpdateDescendantDocuments(parent, collection, documents, changes, options, userId);
    if ( collection === "items" ) this.#reconcileMaxHp(userId);
  }

  /**
   * Whether an owned item's Extraordinary grants are currently active on the
   * actor: the item must be flagged extraordinary, and — for equippable types
   * (weapon/armor) — equipped. Gear has no equip toggle, so its grants apply
   * whenever it is owned.
   * @param {Item} item
   * @returns {boolean}
   */
  static #extraordinaryActive(item) {
    if ( !item?.system?.extraordinary ) return false;
    if ( (item.type === "weapon") || (item.type === "armor") ) return !!item.system.equipped;
    return true; // gear
  }

  /**
   * @override
   * All ActiveEffects that may apply to this actor. Mirrors the core generator
   * but SKIPS transferred effects from a weapon/armor that isn't equipped — an
   * item's effects should only modify its wielder while it is actually worn.
   * Gear (and any other owned item) transfers whenever owned, as in core.
   * @yields {ActiveEffect}
   * @returns {Generator<ActiveEffect, void, void>}
   */
  *allApplicableEffects() {
    for ( const effect of this.effects ) yield effect;
    for ( const item of this.items ) {
      // Equippable items only contribute their effects while equipped.
      const equippable = (item.type === "weapon") || (item.type === "armor");
      if ( equippable && !item.system?.equipped ) continue;
      for ( const effect of item.effects ) {
        if ( effect.transfer ) yield effect;
      }
    }
  }

  /**
   * @override
   * Compute defenses, hit-point maximum, and per-attribute dice from the
   * raw attribute scores. Open Legend SRD formulas:
   *   Guard     = 10 + Agility + Might
   *   Toughness = 10 + Fortitude + Will
   *   Resolve   = 10 + Presence + Will
   *   HP max    = 10 + 2 * (Fortitude + Presence + Will)
   * These are derived every prepare cycle so they always track the attributes.
   */
  prepareDerivedData() {
    super.prepareDerivedData();
    const sys = this.system;
    const attrs = sys.attributes ?? {};
    const cfg = CONFIG.OPENLEGEND ?? {};
    const dice = cfg.attributeDice ?? {};
    const maxScore = cfg.maxScore ?? 10;

    // Clamp every attribute score to the legal 0-maxScore range. Done in-place so
    // the clamped value is what feeds dice, defenses, HP, and the sheet display.
    // Capture a breakdown per attribute first: the entered base (from _source,
    // before any initial-phase Active Effect modified attr.value), the net flat
    // Active Effect contribution (current − base), and a clamp note when the
    // 0–max range caps the result.
    const srcAttrs = this._source?.system?.attributes ?? {};
    // Legendary Attribute bonus/penalty: each ACTIVE legendary item's mods, summed
    // per attribute key. Unlike granted item attributes (a separate rollable set,
    // below), these modify the owner's OWN score — so they feed HP, defenses,
    // dice, and substitution like any other score change.
    const legendaryMods = {};
    for ( const item of this.items ) {
      if ( !OpenLegendActor.#extraordinaryActive(item) ) continue;
      for ( const p of (item.system.legendaryProperties ?? []) ) {
        if ( p?.name !== "attributeBonus" ) continue;
        const mod = cfg.parseLegendaryAttrMod?.(p.value);
        if ( !mod || !(mod.key in attrs) ) continue;
        (legendaryMods[mod.key] ??= []).push({ amount: mod.amount, source: item.name });
      }
    }
    sys.attributeBreakdown = {};
    for ( const [key, attr] of Object.entries(attrs) ) {
      const base = Math.floor(Number(srcAttrs[key]?.value ?? 0));
      const withAe = Math.floor(Number(attr.value ?? 0));
      const rows = [{ label: "Base", value: base }];
      const ae = withAe - base;
      if ( ae !== 0 ) rows.push({ label: "Active effects", value: ae });
      let preClamp = withAe;
      for ( const mod of (legendaryMods[key] ?? []) ) {
        preClamp += mod.amount;
        rows.push({ label: mod.source, value: mod.amount });
      }
      const clamped = Math.max(0, Math.min(maxScore, preClamp));
      if ( clamped !== preClamp ) {
        rows.push({ label: `Clamped to ${preClamp < 0 ? 0 : maxScore}`, value: clamped - preClamp });
      }
      sys.attributeBreakdown[key] = rows;
      attr.value = clamped;
      // Preserve the player's own (clamped) score before any substitution swaps
      // the effective value below — the sheet still lets you roll your own score.
      attr.ownValue = clamped;
    }

    // Attribute Substitution feat (hard-coded). Each link makes a DEPENDENT
    // attribute's effective score equal a stronger PRIMARY's score (only when the
    // primary leads — substitution never lowers a score). The substituted value
    // becomes attr.value (so it feeds HP, defenses, dice, and the sheet display);
    // attr.ownValue keeps the player's own score for rolling. The feat TIER is
    // stamped on the attribute so roll time can gate by purpose (Tier 1 excludes
    // attack/defend/invocation — see cfg.substitutedAttributeScore).
    sys.substitutions = [];
    const _subs = cfg.attributeSubstitutions?.(this) ?? [];
    for ( const sub of _subs ) {
      const dep = attrs[sub.dependent];
      const pri = attrs[sub.primary];
      if ( !dep || !pri ) continue;
      const primaryScore = Number(pri.value ?? 0);
      const depOwn = Number(dep.ownValue ?? dep.value ?? 0);
      dep.substitutionTier = sub.tier;
      dep.substitutionPrimary = sub.primary;
      // Substitution only ever raises the dependent's effective value.
      if ( primaryScore > depOwn ) dep.value = primaryScore;
      sys.substitutions.push({
        dependent: sub.dependent, primary: sub.primary, tier: sub.tier,
        primaryScore, ownScore: depOwn, active: primaryScore > depOwn
      });
    }

    // Read attribute scores defensively (0 if missing). After substitution this
    // returns the SUBSTITUTED (effective) score — what HP / defenses / secondary
    // stats use (all Tier-1 purposes). Attack/defend/invocation gate at roll time.
    const score = key => Number(attrs[key]?.value ?? 0);

    // Extraordinary Focus feat: each focused attribute is treated as ONE GREATER
    // for ATTRIBUTE DICE on action rolls only (the score is untouched everywhere
    // else). We bump the dice-ladder index by 1 (capped) for the attribute's roll
    // dice below; the score (attr.value/ownValue) stays as-is for HP/defenses/etc.
    const focusedAttrs = cfg.extraordinaryFocusAttributes?.(this) ?? new Set();

    // Attach the bonus-dice formula to each attribute. The main attribute row on
    // the sheet rolls the player's OWN score (attr.ownValue), so its dice/formula
    // come from that. For a substituted dependent attribute, attr.subDice carries
    // the SUBSTITUTED dice for the separate locked row the sheet adds.
    for ( const [key, attr] of Object.entries(attrs) ) {
      const own = Number(attr.ownValue ?? attr.value ?? 0);
      // Extraordinary Focus: +1 step on the dice ladder for this attribute's rolls.
      const focused = focusedAttrs.has(key);
      attr.extraordinaryFocus = focused;
      const diceFor = s => dice[Math.max(0, Math.min(maxScore, s + (focused ? 1 : 0)))] ?? "";
      attr.dice = diceFor(own);
      // The full roll for an attribute action is a d20 plus the bonus dice.
      attr.rollFormula = attr.dice ? `1d20 + ${attr.dice}` : "1d20";
      // Substituted dice (only when the effective value exceeds the own value).
      const eff = Number(attr.value ?? own);
      attr.subDice = (eff > own) ? diceFor(eff) : "";
    }

    // Extraordinary-item attributes: a SEPARATE set of attributes the actor's
    // active extraordinary items grant (they do NOT modify the actor's own
    // scores). One entry per attribute key, taking the highest item score.
    //
    // Comparison rule: if the actor's OWN score in that attribute exceeds the
    // item's by exactly 1 or 2, they roll their own (higher) attribute and the
    // item instead grants Advantage 1 on rolls with it (mode "own+adv").
    // Otherwise (item >= own, or own leads by 3+) the item's attribute is
    // offered for rolling at its own score (mode "item") — always shown. An
    // item-attribute roll counts as that attribute type, so attrMod adv/dis
    // effects apply either way (handled at roll time via the attribute key).
    const itemAttrScores = {};   // key -> { score, source }
    for ( const item of this.items ) {
      if ( !OpenLegendActor.#extraordinaryActive(item) ) continue;
      for ( const ga of (item.system.extraordinaryAttributes ?? []) ) {
        const k = ga?.key;
        const v = Math.floor(Number(ga?.score) || 0);
        if ( !k || !(k in attrs) || (v <= 0) ) continue;
        if ( !itemAttrScores[k] || (v > itemAttrScores[k].score) ) itemAttrScores[k] = { score: v, source: item.name };
      }
    }
    sys.itemAttributes = Object.entries(itemAttrScores).map(([key, { score: itemScore, source }]) => {
      const ownScore = score(key);
      const lead = ownScore - itemScore;
      const useOwnWithAdv = (lead === 1) || (lead === 2);
      const effScore = useOwnWithAdv ? ownScore : itemScore;
      const effDice = dice[effScore] ?? "";
      return {
        key,
        label: cfg.attributeLabels?.[key] ?? attrs[key]?.label ?? key,
        source,
        itemScore,
        ownScore,
        // What is actually rolled, and how it's presented.
        mode: useOwnWithAdv ? "own+adv" : "item",
        score: effScore,
        dice: effDice,
        rollFormula: effDice ? `1d20 + ${effDice}` : "1d20",
        advantage: useOwnWithAdv ? 1 : 0
      };
    }).sort((a, b) => a.label.localeCompare(b.label));

    // Aggregate equipped armor: defense bonus adds to Guard, speed penalty
    // subtracts from Speed. Both stack across all equipped armor pieces. The
    // Required Fortitude is informational (the bonus applies regardless); the
    // sheet flags any equipped armor whose requirement the actor does not meet.
    let armorDefenseBonus = 0;
    let armorSpeedPenalty = 0;
    let wearingArmor = false;
    for ( const item of this.items ) {
      if ( (item.type !== "armor") || !item.system?.equipped ) continue;
      wearingArmor = true;
      armorDefenseBonus += Number(item.system.defenseBonus ?? 0);
      armorSpeedPenalty += Number(item.system.speedPenalty ?? 0);
    }

    // Armor Mastery feat (hard-coded passive), per the feat text. While wearing
    // armor: a +tier armor bonus to Guard (Tier 1 → +1, Tier 2 → +2). At Tier 2
    // ONLY, the armor movement penalty is reduced by a flat 5' — it offsets the
    // penalty (never below 0); it does NOT lower your base speed. The Fortitude-
    // prerequisite reduction is informational, applied where it's checked (sheet).
    const armorMasteryTier = (CONFIG.OPENLEGEND?.armorMasteryTier?.(this)) ?? 0;
    let armorMasteryGuard = 0;
    let armorMasterySpeedReduction = 0;
    if ( wearingArmor && (armorMasteryTier > 0) ) {
      armorMasteryGuard = armorMasteryTier;
      armorDefenseBonus += armorMasteryGuard;
      // Movement-penalty relief is a flat 5' and only at Tier 2+. Capped at the
      // actual penalty so Armor Mastery can zero it out but never add speed.
      if ( armorMasteryTier >= 2 ) {
        armorMasterySpeedReduction = Math.min(5, armorSpeedPenalty);
        armorSpeedPenalty -= armorMasterySpeedReduction;
      }
    }

    // Wielding (equipping) a Defensive weapon grants a +1 armor bonus to Guard,
    // regardless of the Defensive value listed. Passive benefits from multiple
    // defensive items don't stack ("use the best of the two benefits"), so it's
    // a flat +1 however many are equipped. The Defensive Mastery feat grants an
    // ADDITIONAL +1 armor bonus while wielding a defensive weapon (so +2 total).
    const wieldsDefensive = this.items.some(i =>
      (i.type === "weapon") && i.system?.equipped &&
      (i.system.properties ?? []).some(p => p.key === "defensive")
    );
    const defensiveMastery = wieldsDefensive && !!(CONFIG.OPENLEGEND?.hasDefensiveMastery?.(this));
    const defensiveArmorBonus = wieldsDefensive ? (defensiveMastery ? 2 : 1) : 0;
    armorDefenseBonus += defensiveArmorBonus;

    // Two Weapon Defense feat: +1 armor bonus to Guard while wielding a weapon you
    // have Attack Specialization for in each hand. An armor bonus like the above, so
    // it joins armorDefenseBonus before the Battle Trance floor and the report.
    const twoWeaponDefense = !!(CONFIG.OPENLEGEND?.wieldsTwoWeaponDefense?.(this));
    const twoWeaponDefenseBonus = twoWeaponDefense ? 1 : 0;
    armorDefenseBonus += twoWeaponDefenseBonus;

    // Battle Trance feat (toggled on): advantage 1 on attacks (applied at roll
    // time), Toughness & Resolve +3, and the total armor bonus to Guard floored
    // at 3 ("if your total armor bonus is less than 3, it becomes 3"). The roll
    // advantage lives in action-roll.mjs; the defensive bonuses are applied here.
    const battleTrance = !!(CONFIG.OPENLEGEND?.battleTranceActive?.(this));
    let battleTranceArmorFloor = 0;
    if ( battleTrance && (armorDefenseBonus < 3) ) {
      battleTranceArmorFloor = 3 - armorDefenseBonus;   // raise the total to 3
      armorDefenseBonus += battleTranceArmorFloor;
    }

    // Carrying capacity (Wealth & Equipment rules). Only weapons and armor count
    // toward the 20-item cap, heavy count, and bulky count — adventuring gear is
    // excluded. Limits: 20 items, heavy <= Might score, bulky <= 2.
    const might = score("might");
    let carriedCount = 0, heavyCount = 0, bulkyCount = 0;
    for ( const item of this.items ) {
      if ( (item.type !== "weapon") && (item.type !== "armor") ) continue;
      carriedCount += 1;
      if ( item.system?.heavy ) heavyCount += 1;
      if ( item.system?.bulky ) bulkyCount += 1;
    }
    sys.carry = {
      count: carriedCount,        max: 20,
      heavy: heavyCount,          heavyMax: might,
      bulky: bulkyCount,          bulkyMax: 2,
      overCount: carriedCount > 20,
      overHeavy: (might === 0 && heavyCount > 0) || (heavyCount > might),
      // At or over the heavy maximum (and carrying at least one), speed halves.
      heavyEncumbered: (heavyCount > 0) && (heavyCount >= might),
      overBulky: bulkyCount > 2,
      // A second bulky item reduces speed by 5'.
      bulkyEncumbered: bulkyCount >= 2
    };

    // NPCs and bosses use the Simple Build: their HP and defenses are set directly
    // by the GM (guided by the per-level table), NOT derived from attributes.
    // Characters derive both from their attribute scores per the SRD formulas. For
    // NPCs/bosses the stored defense values are left untouched here (free-form);
    // the equipped-armor Guard bonus is applied for DISPLAY only via the sheet's
    // derived.guard (mirroring how the character sheet separates base vs. derived
    // Guard), so it never compounds into the stored base across prepare cycles.
    // Characters/companions derive HP & defenses from attributes. NPCs/bosses use
    // free-form (GM-set) values. Minions use FIXED values from the power-level table
    // (set in the minion branches below), so they're excluded from derivation too.
    // Mounts/vehicles are GM-set like NPCs (the SRD examples list literal HP/defenses).
    const derivedStats = (this.type !== "npc") && (this.type !== "boss") && (this.type !== "minion")
      && (this.type !== "mount");
    const isMinion = this.type === "minion";
    const minionB = isMinion ? (CONFIG.OPENLEGEND?.minionBuildForPowerLevel?.(this.system?.powerLevel) ?? null) : null;

    // Itemized contribution breakdown per defense, for the sheet's "how was this
    // calculated?" report. Each entry is {label, value}; the components here are
    // everything known PRE-final-phase. A flat Active Effect on a defense applies
    // in the final phase (after this), so its contribution is reconstructed by
    // the sheet as (final value − sum of these components). Defensive-weapon and
    // armor bonuses are folded into a single "Armor / shield" line on Guard.
    const wieldsDefensiveBonus = defensiveArmorBonus;
    const equippedArmorBonus = armorDefenseBonus - wieldsDefensiveBonus - twoWeaponDefenseBonus - armorMasteryGuard - battleTranceArmorFloor;
    const shieldRows = [];
    if ( equippedArmorBonus ) shieldRows.push({ label: "Equipped armor", value: equippedArmorBonus });
    if ( wieldsDefensiveBonus ) shieldRows.push({
      label: defensiveMastery ? "Defensive weapon + Mastery (+2 armor)" : "Defensive weapon (+1 armor)",
      value: wieldsDefensiveBonus
    });
    if ( twoWeaponDefenseBonus ) shieldRows.push({ label: "Two Weapon Defense (+1 armor)", value: twoWeaponDefenseBonus });
    if ( armorMasteryGuard ) shieldRows.push({ label: `Armor Mastery (+${armorMasteryGuard})`, value: armorMasteryGuard });
    if ( battleTranceArmorFloor ) shieldRows.push({ label: `Battle Trance (armor floor 3)`, value: battleTranceArmorFloor });

    // Battle Trance: +3 Toughness and +3 Resolve while entranced.
    const battleTranceDefense = battleTrance ? 3 : 0;
    const btRow = battleTranceDefense ? [{ label: "Battle Trance", value: battleTranceDefense }] : [];

    // Extraordinary Defense feat: +1 to ALL defenses (Guard, Toughness, Resolve)
    // per tier. Applies uniformly, so it's added to every defense + breakdown.
    const xtraDefense = (CONFIG.OPENLEGEND?.extraordinaryDefenseBonus?.(this)) ?? 0;
    const xtraRow = xtraDefense ? [{ label: `Extraordinary Defense (+${xtraDefense})`, value: xtraDefense }] : [];

    // Indomitable Resolve feat: +1 to the RESOLVE defense per tier possessed
    // (multi-take, summed). Resolve-only, so it joins just the Resolve value/breakdown.
    const indomResolve = (CONFIG.OPENLEGEND?.indomitableResolveBonus?.(this)) ?? 0;
    const indomRow = indomResolve ? [{ label: `Indomitable Resolve (+${indomResolve})`, value: indomResolve }] : [];

    // Natural Defense feat: +tier to GUARD and TOUGHNESS, but ONLY while not wearing
    // armor. Guard+Toughness only (not Resolve).
    const naturalDefense = (!wearingArmor ? (CONFIG.OPENLEGEND?.naturalDefenseBonus?.(this)) : 0) || 0;
    const naturalRow = naturalDefense ? [{ label: `Natural Defense (+${naturalDefense})`, value: naturalDefense }] : [];

    // Fatigued Level 4 (defenseAttrLoss flag, set in the INITIAL Active Effect
    // phase): the target loses the ATTRIBUTE bonuses to all defenses but keeps
    // armor, extraordinary, and feat bonuses. We drop the attribute terms (and
    // their breakdown rows) when the flag is set.
    const loseDefAttr = !!this.flags?.openlegend?.defenseAttrLoss;
    const defAttr = key => loseDefAttr ? 0 : score(key);
    const defAttrRows = (...rows) => loseDefAttr ? [] : rows;
    const fatigueRow = loseDefAttr ? [{ label: "Fatigued (no attribute bonus)", value: 0 }] : [];

    if ( sys.defenses && derivedStats ) {
      sys.defenses.guard.value = 10 + defAttr("agility") + defAttr("might") + armorDefenseBonus + xtraDefense + naturalDefense;
      sys.defenses.toughness.value = 10 + defAttr("fortitude") + defAttr("will") + battleTranceDefense + xtraDefense + naturalDefense;
      sys.defenses.resolve.value = 10 + defAttr("presence") + defAttr("will") + battleTranceDefense + xtraDefense + indomResolve;
      sys.defenseBreakdown = {
        guard: [
          { label: "Base", value: 10 },
          ...defAttrRows({ label: "Agility", value: score("agility") }, { label: "Might", value: score("might") }),
          ...fatigueRow,
          ...shieldRows,
          ...xtraRow,
          ...naturalRow
        ],
        toughness: [
          { label: "Base", value: 10 },
          ...defAttrRows({ label: "Fortitude", value: score("fortitude") }, { label: "Will", value: score("will") }),
          ...fatigueRow,
          ...btRow,
          ...xtraRow,
          ...naturalRow
        ],
        resolve: [
          { label: "Base", value: 10 },
          ...defAttrRows({ label: "Presence", value: score("presence") }, { label: "Will", value: score("will") }),
          ...fatigueRow,
          ...btRow,
          ...xtraRow,
          ...indomRow
        ]
      };
    } else if ( sys.defenses && isMinion ) {
      // Minion: all three defenses are FIXED from the power-level table (same value),
      // never attribute-derived or free-form. Write them, then build the breakdown.
      const def = minionB ? minionB.defense : Number(sys.defenses.guard?.value ?? 0);
      sys.defenses.guard.value = def;
      sys.defenses.toughness.value = def;
      sys.defenses.resolve.value = def;
      sys.defenseBreakdown = {
        guard: [{ label: `Base (Power Level ${minionB?.powerLevel ?? "?"})`, value: def }],
        toughness: [{ label: `Base (Power Level ${minionB?.powerLevel ?? "?"})`, value: def }],
        resolve: [{ label: `Base (Power Level ${minionB?.powerLevel ?? "?"})`, value: def }]
      };
    } else if ( sys.defenses ) {
      // NPC / boss: the stored value is the GM-set base; armor/shield, Battle
      // Trance, and Extraordinary Defense are applied for display only (see the
      // sheet's derived.* values).
      sys.defenseBreakdown = {
        guard: [{ label: "Base (GM-set)", value: Number(sys.defenses.guard?.value ?? 0) }, ...shieldRows, ...xtraRow, ...naturalRow],
        toughness: [{ label: "Base (GM-set)", value: Number(sys.defenses.toughness?.value ?? 0) }, ...btRow, ...xtraRow, ...naturalRow],
        resolve: [{ label: "Base (GM-set)", value: Number(sys.defenses.resolve?.value ?? 0) }, ...btRow, ...xtraRow, ...indomRow]
      };
    }
    // Expose the armor bonus for the NPC sheet's derived Guard display, and the
    // Battle Trance + Extraordinary Defense bonuses for the NPC/boss derived defenses.
    sys.armorDefenseBonus = armorDefenseBonus;
    sys.battleTranceDefense = battleTranceDefense;
    sys.extraordinaryDefense = xtraDefense;
    sys.indomitableResolve = indomResolve;
    sys.naturalDefense = naturalDefense;

    // Speed pipeline (order per the carrying rules): start from base, halve if at
    // the heavy maximum, subtract 5' for a second bulky item, then apply the
    // armor speed penalty. Round up, never below 0. Record each step's delta for
    // the breakdown report; a flat Active Effect on Speed applies in the final
    // phase (after this), surfaced by the sheet as (final − sum of these rows).
    if ( sys.speed ) {
      const base = Number(this._source?.system?.speed?.value ?? sys.speed.value ?? 0);
      const rows = [{ label: "Base", value: base }];
      let spd = base;
      // Fleet of Foot feat: speed permanently +5' per tier. Added before the
      // encumbrance / armor penalties (it raises your actual speed).
      const fleet = (CONFIG.OPENLEGEND?.fleetOfFootBonus?.(this)) ?? 0;
      if ( fleet ) {
        rows.push({ label: `Fleet of Foot (+${fleet}')`, value: fleet });
        spd += fleet;
      }
      if ( sys.carry.heavyEncumbered ) {
        const after = spd / 2;
        rows.push({ label: "Heavy encumbered (×½)", value: after - spd });
        spd = after;
      }
      if ( sys.carry.bulkyEncumbered ) {
        rows.push({ label: "Bulky encumbered", value: -5 });
        spd -= 5;
      }
      if ( armorSpeedPenalty ) {
        const label = armorMasterySpeedReduction
          ? `Armor speed penalty (Armor Mastery −${armorMasterySpeedReduction}')`
          : "Armor speed penalty";
        rows.push({ label, value: -armorSpeedPenalty });
        spd -= armorSpeedPenalty;
      }
      const ceil = Math.max(0, Math.ceil(spd));
      if ( ceil !== spd ) rows.push({ label: "Rounded", value: ceil - spd });
      sys.speed.value = ceil;
      sys.speedBreakdown = rows;

      // Climbing / Flying / Swimming feats: a climb / fly / swim speed equal to the
      // (final, effective) speed. Derived each prepare; 0 when the feat isn't owned
      // (the sheet hides it).
      sys.speed.climb = (CONFIG.OPENLEGEND?.hasClimbSpeed?.(this)) ? ceil : 0;
      sys.speed.fly = (CONFIG.OPENLEGEND?.hasFlySpeed?.(this)) ? ceil : 0;
      sys.speed.swim = (CONFIG.OPENLEGEND?.hasSwimSpeed?.(this)) ? ceil : 0;
    }

    // Initiative is derived from Agility (overridable later).
    if ( sys.initiative ) {
      sys.initiative.value = score("agility");
      sys.initiativeBreakdown = [{ label: "Agility", value: score("agility") }];
      // Lightning Reflexes (feat): advantage 1 per tier on initiative rolls. Note it
      // in the breakdown (it's roll-time advantage, not a flat bonus — value 0).
      const lrAdv = (CONFIG.OPENLEGEND?.lightningReflexesAdvantage?.(this)) ?? 0;
      if ( lrAdv > 0 ) sys.initiativeBreakdown.push({ label: `Lightning Reflexes (advantage ${lrAdv})`, value: 0 });
    }

    // Hit-point maximum. Characters derive it from attributes; NPCs use the GM-set
    // value (free-form, per the Simple Build table).
    if ( sys.health ) {
      // The UNREDUCED maximum: derived for characters, the GM-set value for NPCs.
      // (For NPCs the stored `max` IS the base; for characters we just computed it.)
      let base;
      if ( derivedStats ) {
        base = 10 + (2 * (score("fortitude") + score("presence") + score("will")));
      } else if ( isMinion ) {
        // Minion: HP is FIXED from the power-level table (also write the stored max so
        // current HP defaults sensibly on a fresh minion).
        base = minionB ? minionB.hp : Number(sys.health.max ?? 0);
        sys.health.max = base;
      } else {
        base = Number(this._source?.system?.health?.max ?? sys.health.max ?? 0);
      }

      // Tough as Nails feat: permanently +5 HP per tier, added to the unreduced max
      // (before lethal reduction). Applies to characters and NPCs alike (minions can't
      // take feats, so toughAsNailsBonus is 0 for them).
      const toughBonus = CONFIG.OPENLEGEND?.toughAsNailsBonus?.(this) ?? 0;
      if ( toughBonus > 0 ) base += toughBonus;

      // Lethal damage (Lethal Damage rules): each point reduces the effective max HP.
      // Accrued lethal is capped at the base max; the effective max never goes below
      // 0. `maxBase` keeps the unreduced max for the sheet/report; `max` is effective.
      const lethal = Math.max(0, Math.min(base, Math.floor(Number(sys.health.lethal ?? 0))));
      sys.health.lethal = lethal;
      sys.health.maxBase = base;
      sys.health.max = Math.max(0, base - lethal);
      // Unconscious from lethal damage: lethal ≥ full max (the creature is out until
      // it heals at least 1 point of lethal damage).
      sys.health.lethalUnconscious = (base > 0) && (lethal >= base);

      // NOTE: current HP is NOT clamped here. Lethal damage moves current HP in
      // lockstep via _preUpdate (and the damage/heal apply paths), so the stored
      // value is always already valid. Clamping in the derived layer would silently
      // shave HP on every recalc (e.g. when base max rises) — that's a mutation the
      // derived pass must never make.
    }

    // Mount/vehicle damage track (SRD Damage Threshold): clamp the stored level and
    // threshold, and derive the disabled state (level ≥ threshold → unable to act
    // until healed/repaired at 1 day per wealth level per damage level).
    if ( (this.type === "mount") && sys.damage ) {
      const state = CONFIG.OPENLEGEND?.mountDamageState?.(this);
      if ( state ) {
        sys.damage.level = state.level;
        sys.damage.threshold = state.threshold;
        sys.damage.disabled = state.disabled;
      }
    }
  }

  /**
   * The initiative roll formula for this actor: 1d20 plus the bonus dice granted
   * by its (derived) initiative attribute score. Used by the sheet and by the
   * Foundry combat tracker via the custom Combatant class.
   * @returns {string}
   */
  get initiativeFormula() {
    const dice = CONFIG.OPENLEGEND?.attributeDice ?? {};
    const score = Math.max(0, Math.min(10, Number(this.system?.initiative?.value ?? 0)));
    const bonus = dice[score] ?? "";
    // Lightning Reflexes (feat): advantage 1 per tier on ALL initiative rolls —
    // build the Open Legend advantage formula (extra d20/bonus dice kept highest,
    // with the usual explosion) rather than a plain "1d20 + Nd6".
    const adv = (CONFIG.OPENLEGEND?.lightningReflexesAdvantage?.(this)) ?? 0;
    if ( adv > 0 ) return buildFormula(bonus, adv);
    return bonus ? `1d20 + ${bonus}` : "1d20";
  }
}
