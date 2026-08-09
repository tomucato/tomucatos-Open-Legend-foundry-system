const { ActiveEffectConfig } = foundry.applications.sheets;

/**
 * Open Legend Active Effect config. Departures from core, all on the Changes
 * tab — each change row is authored as Subject + Action + Modifier:
 *
 *   1. The "key" field is a dropdown of SUBJECTS (attributes, defenses,
 *      resources, and the "All Rolls"/"All Attacks" roll scopes) from
 *      CONFIG.OPENLEGEND.effectChangeKeys — no raw data paths. An off-catalog
 *      key already on the effect is kept as an option so nothing breaks.
 *
 *   2. "Action" (renamed from the native "type") offers Bonus (+) / Penalty (−)
 *      / Override (=). It is mapped to a native change type and value sign at
 *      submit: bonus → add, penalty → add with the value negated, override →
 *      override.
 *
 *   3. "Modifier" (new) offers Flat / Adv-Dis, stored in
 *      flags.openlegend.changeModes parallel to system.changes. A flat modifier
 *      changes the stat number; an adv/dis modifier grants advantage (bonus) or
 *      disadvantage (penalty) on the subject's rolls (resolved at apply time by
 *      OpenLegendActiveEffect.resolveTarget). Adv/dis on a flat-only subject is
 *      a no-op.
 *
 *   4. Every effect can scale by power level: each row has a Level column
 *      (flags.openlegend.changeLevels) and the tab carries the effect's Power
 *      Level (flags.openlegend.powerLevel). For each resolved target, the
 *      strongest unlocked row applies. Level 0 rows are an always-active
 *      baseline.
 *
 * The application phase is still assigned automatically from the subject: flat
 * changes to values recomputed in prepareDerivedData (defenses, max HP) get the
 * "final" phase so derivation doesn't overwrite them.
 */
export class OpenLegendActiveEffectConfig extends ActiveEffectConfig {

  /** @override Keep the per-row Modifier flag array aligned when rows are added/removed. */
  static DEFAULT_OPTIONS = {
    classes: ["ol-effect-config"],
    window: { resizable: true },
    position: { width: 620 },
    actions: {
      addChange: OpenLegendActiveEffectConfig.#onAddChange,
      deleteChange: OpenLegendActiveEffectConfig.#onDeleteChange
    }
  };

  /** @override Swap the changes-tab template for ours (adds Power Level + Level
   *  column), and the details tab for ours (drops the unused Effect Origin +
   *  Status Conditions fields this system never reads). */
  static PARTS = {
    ...ActiveEffectConfig.PARTS,
    details: {
      template: "systems/tomucatos-open-legend-rpg-system/templates/effects/details.hbs",
      scrollable: [""]
    },
    changes: {
      template: "systems/tomucatos-open-legend-rpg-system/templates/effects/changes.hbs",
      templates: ["systems/tomucatos-open-legend-rpg-system/templates/effects/change.hbs"],
      scrollable: ["ol[data-changes]"]
    }
  };

  /** @override Expose the effect's current level (power level, or stack level if
   *  this is a stacking condition) + the stacking flag to the changes tab. */
  async _preparePartContext(partId, context) {
    const partContext = await super._preparePartContext(partId, context);
    if ( partId === "changes" ) {
      const fl = this.document.flags?.openlegend ?? {};
      const stacking = !!fl.stacking;
      partContext.stacking = stacking;
      partContext.currentLevel = Math.max(0, Math.floor(Number(stacking ? fl.stackLevel : fl.powerLevel) || 0));
    }
    return partContext;
  }

  /** @override Render a change row with the subject/action/modifier dropdowns and Level input. */
  async _renderChange(context) {
    const { change, index } = context;
    if ( typeof change.value !== "string" ) change.value = JSON.stringify(change.value);
    Object.assign(
      change,
      ["key", "type", "value", "phase", "priority"].reduce((paths, fieldName) => {
        paths[`${fieldName}Path`] = `system.changes.${index}.${fieldName}`;
        return paths;
      }, {}));

    const groups = CONFIG.OPENLEGEND?.effectChangeKeys ?? [];
    context.keyGroups = groups;
    // Preserve an off-catalog key (hand-written, or from a module) as its own
    // selectable option rather than silently rebinding the change.
    const known = groups.some(g => change.key in g.keys);
    context.unknownKey = (!known && change.key) ? change.key : "";

    context.actions = CONFIG.OPENLEGEND?.effectActions ?? {};
    context.modifierTypes = CONFIG.OPENLEGEND?.effectModifierTypes ?? {};

    // Action (bonus/penalty/override/half/double) is DERIVED from the native
    // value + type — it is not stored. A negative ADD reads back as a "penalty";
    // a "multiply" by ½ / 2 reads back as half / double. The value box shows the
    // native (signed) value, which is what core persists; the Action <select>
    // posts nothing — _onChangeForm rewrites the native value + type live when
    // the Action changes, so everything survives save / add / delete with no
    // parallel value array.
    const numeric = Number(change.value);
    const factors = CONFIG.OPENLEGEND?.effectFactorActions ?? {};
    if ( change.type === "multiply" ) {
      change.action = (numeric === 2) ? "double" : "half";
    } else if ( change.type === "override" ) {
      change.action = "override";
    } else {
      change.action = (Number.isFinite(numeric) && (numeric < 0)) ? "penalty" : "bonus";
    }
    // Half / Double are self-contained factor operations: no value or modifier
    // input. The template disables those fields when one is selected.
    change.factorAction = change.action in factors;

    // Toggle subjects (e.g. "Lose Attribute Defense Bonuses") are pure on/off
    // flags. Behind the scenes we force value 1 / override so the flag is truthy;
    // the user never edits the Action / Value / Modifier — the template disables
    // them and the value shows the canonical 1.
    change.toggleAction = (CONFIG.OPENLEGEND?.toggleSubjectKeys ?? new Set()).has(change.key);
    if ( change.toggleAction ) {
      change.action = "override";
      change.value = "1";
    }

    // Modifier type (flat/advdis), from the flag array parallel to changes.
    // Toggle subjects are always flat.
    const modes = this.document.flags?.openlegend?.changeModes;
    change.modifierType = (!change.toggleAction && Array.isArray(modes) && (modes[index] === "advdis")) ? "advdis" : "flat";
    change.modePath = `flags.openlegend.changeModes.${index}`;

    // Per-row level, from the flag array parallel to system.changes.
    const levels = this.document.flags?.openlegend?.changeLevels;
    change.level = Math.max(0, Math.floor(Number(Array.isArray(levels) ? levels[index] : 0) || 0));
    change.levelPath = `flags.openlegend.changeLevels.${index}`;

    return foundry.applications.handlebars.renderTemplate(
      "systems/tomucatos-open-legend-rpg-system/templates/effects/change.hbs", context
    );
  }

  /**
   * @override
   * Normalize the per-row Modifier and Level flag arrays (object-with-numeric-
   * keys → array) and align them to the change rows; assign each change's
   * application phase from its subject + modifier. Native key/value/type/
   * priority are submitted directly (value carries its sign), so core's
   * add/delete keep working; we only manage the two parallel flag arrays.
   */
  _processFormData(event, form, formData) {
    const submitData = super._processFormData(event, form, formData);
    const fl = submitData.flags?.openlegend ?? {};
    const changes = submitData.system?.changes;
    const changeList = foundry.utils.isPlainObject(changes)
      ? Object.values(changes)
      : (Array.isArray(changes) ? changes : []);
    const changeCount = changeList.length;
    const factors = CONFIG.OPENLEGEND?.effectFactorActions ?? {};

    // Read the parallel flag arrays BY INDEX (not Object.values) — a disabled
    // Modifier <select> on a Half/Double row isn't posted, leaving a gap in the
    // sparse object; collapsing with Object.values would misalign later rows.
    const byIndex = (obj, i) => foundry.utils.isPlainObject(obj) ? obj[i] : (Array.isArray(obj) ? obj[i] : undefined);

    const finalKeys = CONFIG.OPENLEGEND?.finalPhaseChangeKeys;
    const toggleKeys = CONFIG.OPENLEGEND?.toggleSubjectKeys ?? new Set();
    const subjects = CONFIG.OPENLEGEND?.effectSubjects ?? {};
    const modes = [];
    const levels = [];
    changeList.forEach((change, i) => {
      // Toggle subjects (boolean flags): their Action / Value / Modifier inputs are
      // disabled, so backfill the canonical override 1 / flat / initial here — this
      // is what makes the flag reliably truthy regardless of what's posted.
      const isToggle = toggleKeys.has(change?.key);
      if ( isToggle ) {
        change.type = "override";
        change.value = "1";
        modes[i] = "flat";
        levels[i] = Math.max(0, Math.floor(Number(byIndex(fl.changeLevels, i)) || 0));
        change.phase = "initial";
        return;
      }

      // Half / Double rows post type="multiply"; their value input is disabled,
      // so backfill the factor here and force flat (adv/dis is meaningless).
      const isFactor = (change?.type === "multiply");
      if ( isFactor ) {
        const v = Number(change.value);
        change.value = String((v === 2) ? 2 : ((v === 0.5) ? 0.5 : (Math.abs(v) >= 1.5 ? 2 : 0.5)));
      }
      modes[i] = isFactor ? "flat" : ((byIndex(fl.changeModes, i) === "advdis") ? "advdis" : "flat");
      levels[i] = Math.max(0, Math.floor(Number(byIndex(fl.changeLevels, i)) || 0));

      // Phase: a flat change to a derived value (defenses, Speed, max HP) applies
      // "final"; adv/dis writes a flag (never derived) → always initial. Factor
      // ops on a derived subject are flat too, so they follow the same rule.
      const flat = (modes[i] !== "advdis");
      change.phase = (flat && finalKeys?.has(change.key) && subjects[change.key]?.flat) ? "final" : "initial";
    });

    foundry.utils.setProperty(submitData, "flags.openlegend.changeModes", modes.slice(0, changeCount));
    foundry.utils.setProperty(submitData, "flags.openlegend.changeLevels", levels.slice(0, changeCount));
    return submitData;
  }

  /**
   * @override
   * When the Action <select> changes, rewrite the row's native value + type to
   * match (so the choice lives in fields core persists), and enable/disable the
   * Value and Modifier inputs:
   *   - bonus   → type add, value = +|v|
   *   - penalty → type add, value = −|v|
   *   - override→ type override
   *   - half    → type multiply, value 0.5, Value + Modifier disabled
   *   - double  → type multiply, value 2,   Value + Modifier disabled
   */
  _onChangeForm(formConfig, event) {
    const el = event.target;

    // Subject (key) changed: if it's now a toggle subject, force the row to the
    // canonical override 1 / flat and disable the Action / Value / Modifier so the
    // user can't (and needn't) touch them. Re-enable them otherwise.
    if ( el?.matches?.('select[name$=".key"]') ) {
      const toggleKeys = CONFIG.OPENLEGEND?.toggleSubjectKeys ?? new Set();
      const row = el.closest("li");
      const isToggle = toggleKeys.has(el.value);
      const actionSelect = row?.querySelector('select[data-action-select]');
      const valueInput = row?.querySelector('input[name$=".value"]');
      const typeInput = row?.querySelector('[name$=".type"]');
      const modeSelect = row?.querySelector('select[name*=".changeModes."]');
      if ( isToggle ) {
        if ( typeInput ) typeInput.value = "override";
        if ( valueInput ) valueInput.value = "1";
        if ( actionSelect ) actionSelect.value = "override";
        if ( modeSelect ) modeSelect.value = "flat";
      }
      if ( actionSelect ) actionSelect.disabled = isToggle;
      if ( valueInput ) valueInput.readOnly = isToggle;
      if ( modeSelect ) modeSelect.disabled = isToggle;
    }

    if ( el?.matches?.('select[data-action-select]') ) {
      const row = el.closest("li");
      const valueInput = row?.querySelector('input[name$=".value"]');
      const typeInput = row?.querySelector('[name$=".type"]');
      const modeSelect = row?.querySelector('select[name*=".changeModes."]');
      const action = el.value;
      const factors = CONFIG.OPENLEGEND?.effectFactorActions ?? {};
      const isFactor = action in factors;

      if ( typeInput ) typeInput.value = isFactor ? "multiply" : ((action === "override") ? "override" : "add");
      if ( valueInput ) {
        if ( isFactor ) valueInput.value = String(factors[action]);
        else if ( action !== "override" ) {
          const mag = Math.abs(Number(valueInput.value) || 0);
          valueInput.value = String(action === "penalty" ? -mag : mag);
        }
        // readonly (not disabled) so the factor value still submits on save.
        valueInput.readOnly = isFactor;
      }
      // Half / Double are inherently flat number operations — disable (and reset)
      // the Modifier select so it can't claim adv/dis.
      if ( modeSelect ) {
        if ( isFactor ) modeSelect.value = "flat";
        modeSelect.disabled = isFactor;
      }
    }
    super._onChangeForm(formConfig, event);
  }

  /**
   * Add a change row, then keep the Modifier / Level flag arrays aligned by
   * appending a default entry for the new row.
   * @this {OpenLegendActiveEffectConfig}
   */
  static async #onAddChange() {
    const submitData = this._processFormData(null, this.form, new foundry.applications.ux.FormDataExtended(this.form));
    const changes = Object.values(submitData.system?.changes ?? {});
    changes.push(this.document.system.schema.fields.changes.element.getInitialValue());
    const modes = [...(submitData.flags?.openlegend?.changeModes ?? []), "flat"];
    const levels = [...(submitData.flags?.openlegend?.changeLevels ?? []), 0];
    return this.submit({ updateData: { system: { changes }, flags: { openlegend: { changeModes: modes, changeLevels: levels } } } });
  }

  /**
   * Delete a change row, splicing the same index out of the Modifier / Level
   * flag arrays so they stay aligned.
   * @this {OpenLegendActiveEffectConfig}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onDeleteChange(event, target) {
    const submitData = this._processFormData(null, this.form, new foundry.applications.ux.FormDataExtended(this.form));
    const changes = Object.values(submitData.system?.changes ?? {});
    const index = Number(target.closest("[data-index]")?.dataset.index);
    if ( !Number.isInteger(index) ) return;
    changes.splice(index, 1);
    const modes = [...(submitData.flags?.openlegend?.changeModes ?? [])]; modes.splice(index, 1);
    const levels = [...(submitData.flags?.openlegend?.changeLevels ?? [])]; levels.splice(index, 1);
    return this.submit({ updateData: { system: { changes }, flags: { openlegend: { changeModes: modes, changeLevels: levels } } } });
  }
}
