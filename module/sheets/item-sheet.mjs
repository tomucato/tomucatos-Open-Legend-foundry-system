import { prepareActionRoll } from "../dice/action-roll.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ItemSheetV2 } = foundry.applications.sheets;

/**
 * Open Legend item sheet, built on ApplicationV2 + HandlebarsApplicationMixin.
 * Serves all four item types (boon, bane, perk, flaw); the body template is
 * chosen per-type in {@link _configureRenderParts}.
 */
export class OpenLegendItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["openlegend", "sheet", "item"],
    position: { width: 520, height: 480 },
    // ApplicationV2 defaults windows to resizable: false; opt back in.
    window: { resizable: true },
    form: {
      // Auto-save named inputs on change, matching the old V1 behavior.
      submitOnChange: true,
      closeOnSubmit: false
    },
    actions: {
      weaponToggleCategory: OpenLegendItemSheet.#onWeaponToggleCategory,
      weaponRemoveProperty: OpenLegendItemSheet.#onWeaponRemoveProperty,
      stepField: OpenLegendItemSheet.#onStepField,
      effectCreate: OpenLegendItemSheet.#onEffectCreate,
      effectEdit: OpenLegendItemSheet.#onEffectEdit,
      effectToggle: OpenLegendItemSheet.#onEffectToggle,
      effectDelete: OpenLegendItemSheet.#onEffectDelete,
      attackAdd: OpenLegendItemSheet.#onAttackAdd,
      attackDelete: OpenLegendItemSheet.#onAttackDelete,
      attributeAdd: OpenLegendItemSheet.#onAttributeAdd,
      attributeDelete: OpenLegendItemSheet.#onAttributeDelete,
      powerEffectAdd: OpenLegendItemSheet.#onPowerEffectAdd,
      powerEffectDelete: OpenLegendItemSheet.#onPowerEffectDelete,
      xtraAttributeAdd: OpenLegendItemSheet.#onXtraAttributeAdd,
      xtraAttributeDelete: OpenLegendItemSheet.#onXtraAttributeDelete,
      xtraBoonAdd: OpenLegendItemSheet.#onXtraBoonAdd,
      xtraBoonDelete: OpenLegendItemSheet.#onXtraBoonDelete,
      xtraBaneAdd: OpenLegendItemSheet.#onXtraBaneAdd,
      xtraBaneDelete: OpenLegendItemSheet.#onXtraBaneDelete,
      xtraPropertyAdd: OpenLegendItemSheet.#onXtraPropertyAdd,
      xtraPropertyDelete: OpenLegendItemSheet.#onXtraPropertyDelete,
      xtraLegendaryAdd: OpenLegendItemSheet.#onXtraLegendaryAdd,
      xtraLegendaryDelete: OpenLegendItemSheet.#onXtraLegendaryDelete,
      xtraAreaStep: OpenLegendItemSheet.#onXtraAreaStep,
      xtraPersistentToggle: OpenLegendItemSheet.#onXtraPersistentToggle,
      xtraGenerateBoon: OpenLegendItemSheet.#onXtraGenerateBoon,
      xtraGenerateBane: OpenLegendItemSheet.#onXtraGenerateBane,
      clearMacro: OpenLegendItemSheet.#onClearMacro
    }
  };

  /** @override */
  static PARTS = {
    body: {
      template: "systems/tomucatos-open-legend-rpg-system/templates/item/boon-sheet.html",
      root: true,
      // Required partials the body references; the mixin loads (and thereby
      // registers) these before first render.
      templates: [
        "templates/generic/tab-navigation.hbs",
        "systems/tomucatos-open-legend-rpg-system/templates/item/parts/extraordinary.hbs",
        "systems/tomucatos-open-legend-rpg-system/templates/item/parts/item-effects.hbs"
      ],
      // The whole sheet scrolls as one document (.window-content). Listing the
      // root as scrollable makes the mixin save & restore its scroll position
      // across the re-render that submitOnChange triggers, so editing a field
      // (e.g. a select) no longer jumps the form back to the top.
      scrollable: [""]
    }
  };

  /**
   * Tab groups per item type. boon/bane carry a Description + Effects pair;
   * perk/flaw have only a Description tab. Resolved per-instance in
   * {@link _getTabsConfig} so a single sheet class covers all four types.
   * @type {Record<string, Array<{id: string, label: string}>>}
   */
  static ITEM_TABS = {
    boon: [
      { id: "details", label: "Details" },
      { id: "powerEffects", label: "Power Effects" },
      { id: "effects", label: "Effects" }
    ],
    bane: [
      { id: "details", label: "Details" },
      { id: "powerEffects", label: "Power Effects" },
      { id: "effects", label: "Effects" }
    ],
    perk: [
      { id: "description", label: "Description" },
      { id: "effects", label: "Effects" }
    ],
    flaw: [
      { id: "description", label: "Description" },
      { id: "effects", label: "Effects" }
    ],
    feat: [
      { id: "details", label: "Details" },
      { id: "description", label: "Description" },
      { id: "effects", label: "Effects" }
    ],
    effect: [
      { id: "effects", label: "Effects" },
      { id: "description", label: "Description" }
    ],
    weapon: [{ id: "stats", label: "Stats" }, { id: "extraordinary", label: "Extraordinary" }, { id: "effects", label: "Effects" }, { id: "description", label: "Description" }, { id: "notes", label: "Notes" }],
    armor: [{ id: "stats", label: "Stats" }, { id: "extraordinary", label: "Extraordinary" }, { id: "effects", label: "Effects" }, { id: "description", label: "Description" }, { id: "notes", label: "Notes" }],
    gear: [{ id: "description", label: "Description" }, { id: "extraordinary", label: "Extraordinary" }, { id: "effects", label: "Effects" }, { id: "notes", label: "Notes" }]
    // `action` intentionally omitted: its sheet is a single flat form (no tabs).
  };

  /**
   * Physical item types (weapon/armor/gear) share one template; map them to it.
   * @type {Record<string, string>}
   */
  static TEMPLATE_FOR_TYPE = {
    weapon: "weapon",
    armor: "armor",
    gear: "gear",
    action: "action"
  };

  /** Armor type options (light/medium/heavy). */
  static ARMOR_TYPES = { light: "Light", medium: "Medium", heavy: "Heavy" };

  /** @override */
  static TABS = {
    primary: {
      tabs: [{ id: "description", label: "Description" }],
      initial: "description"
    }
  };

  /* -------------------------------------------- */

  /** @override */
  _getTabsConfig(group) {
    const config = super._getTabsConfig(group);
    const tabs = OpenLegendItemSheet.ITEM_TABS[this.item.type];
    // Open each type on its first tab (e.g. bane/boon opens on "details").
    if ( config && tabs ) {
      const initial = tabs[0].id;
      // `tabGroups[group]` (the ACTIVE tab) is seeded once from the static
      // TABS.initial ("description"), independent of this per-type config. If
      // that active tab isn't one this item type has, snap it to this type's
      // first tab so the sheet opens there instead of showing no active tab.
      if ( !tabs.some(t => t.id === this.tabGroups[group]) ) this.tabGroups[group] = initial;
      return { ...config, tabs, initial };
    }
    return config;
  }

  /* -------------------------------------------- */

  /**
   * Render the template matching this item's type.
   * @override
   */
  _configureRenderParts(options) {
    const parts = super._configureRenderParts(options);
    // weapon/armor/gear all use the shared gear-sheet template.
    const templateType = OpenLegendItemSheet.TEMPLATE_FOR_TYPE[this.item.type] ?? this.item.type;
    parts.body = {
      ...parts.body,
      template: `systems/tomucatos-open-legend-rpg-system/templates/item/${templateType}-sheet.html`
    };
    return parts;
  }

  /* -------------------------------------------- */

  /**
   * The bane/boon editors post indexed array paths (e.g. system.attacks.0.defense),
   * which expandObject turns into a PARTIAL {"0":{defense:…}} object — only the
   * changed cell, for one row. Foundry's mergeObject would then both (a) drop the
   * unchanged fields/rows and (b) persist an object instead of an array, breaking
   * every later `.map`/`.filter`/`.push`. So for each of these fields we merge the
   * partial edit onto the CURRENT stored row, rebuild the full dense array, and
   * submit that whole array (which mergeObject stores as an array — see case B).
   * @override
   */
  _prepareSubmitData(event, form, formData, updateData) {
    const submitData = super._prepareSubmitData(event, form, formData, updateData);
    const sys = submitData?.system;
    if ( !sys ) return submitData;
    for ( const key of ["attacks", "attributes", "powerEffects",
      "extraordinaryAttributes", "extraordinaryBoons", "extraordinaryBanes", "extraordinaryProperties",
      "legendaryProperties"] ) {
      if ( !(key in sys) ) continue;
      const edit = sys[key];
      // A full array already (add/delete handlers, or all rows posted): keep it.
      if ( Array.isArray(edit) ) { sys[key] = OpenLegendItemSheet.#toArray(edit); continue; }
      // Partial indexed-object edit: overlay it onto the current stored rows.
      const current = OpenLegendItemSheet.#toArray(this.item.system[key]);
      for ( const [idx, val] of Object.entries(edit) ) {
        const i = Number(idx);
        if ( !Number.isInteger(i) ) continue;
        current[i] = (val && (typeof val === "object") && !Array.isArray(val))
          ? { ...(current[i] ?? {}), ...val }   // merge changed cell into the row
          : val;                                 // scalar (boon attributes)
      }
      sys[key] = current;
    }
    // Aura radiated-invocation fields only apply while a boon row IS Aura, and
    // the radiated PL must respect the SRD cap (half the aura's PL) — enforce
    // both whenever the boons array is part of the submit (e.g. the row's power
    // level just changed, moving the cap).
    if ( Array.isArray(sys.extraordinaryBoons) ) {
      sys.extraordinaryBoons = sys.extraordinaryBoons.map(b =>
        OpenLegendItemSheet.#sanitizeXtraBoonAura(b));
    }
    // A property whose name was just set/changed to a ranks- or choices-valued
    // kind must carry a concrete value: the value-select SHOWS its first option,
    // but nothing is stored until the user changes it — so default an empty /
    // invalid value to that first option (fixes "Deadly shows 1 but grants 0").
    if ( Array.isArray(sys.extraordinaryProperties) ) {
      // Area rows post their shape/size as _areaShape / _areaSize sub-fields — combine
      // them into the row's "shape:size" value (snapped to whole 5' squares for
      // cone/cube, whole lines for a line) and strip the temp keys. This keeps the
      // Area editor on the normal submit path (no separate write that races the form).
      sys.extraordinaryProperties = sys.extraordinaryProperties.map(p =>
        OpenLegendItemSheet.#combineAreaSubFields(p));
      sys.extraordinaryProperties = sys.extraordinaryProperties.map(p =>
        OpenLegendItemSheet.#normalizePropertyValue(p));
      // Augmenting items MUST have the Expendable property (SRD). When Augmenting is
      // present but Expendable is not, add an Expendable row automatically.
      const props = sys.extraordinaryProperties;
      if ( props.some(p => p?.name === "augmenting") && !props.some(p => p?.name === "expendable") ) {
        props.push({ name: "expendable", value: "" });
      }
    }
    // Legendary Attribute-bonus/penalty rows post their attribute/amount as
    // _attrKey / _attrAmount sub-fields — combine them into the row's
    // "key:amount" value (same pattern as the Area sub-fields above).
    if ( Array.isArray(sys.legendaryProperties) ) {
      sys.legendaryProperties = sys.legendaryProperties.map(p =>
        OpenLegendItemSheet.#combineAttrModSubFields(p));
    }
    return submitData;
  }

  /**
   * Combine an Area property row's posted `_areaShape` / `_areaSize` sub-fields into
   * its `value` ("shape:size"), snapping the size to the shape's grid: cone/cube to
   * whole 5' squares (multiples of 5, min 5); a line to whole lines (min 1). Non-area
   * rows (or rows without the temp sub-fields) pass through unchanged. Always strips
   * the temp keys so they never persist.
   * @param {object} p
   * @returns {object}
   */
  static #combineAreaSubFields(p) {
    if ( !p || (typeof p !== "object") ) return p;
    if ( !("_areaShape" in p) && !("_areaSize" in p) ) return p;
    const { _areaShape, _areaSize, ...rest } = p;
    // Only the Area property carries these; guard by the meta flag anyway.
    const meta = (CONFIG.OPENLEGEND?.itemProperties ?? {})[rest.name];
    if ( !meta?.area ) return rest;   // drop stray temp keys from a since-changed row
    // A partial submit may carry only ONE sub-field (e.g. size-only change). Fall
    // back to the row's existing "shape:size" value for whichever is missing, so a
    // size edit doesn't reset the shape (or vice-versa).
    const prev = CONFIG.OPENLEGEND?.parseItemArea?.(rest.value) ?? null;
    const prevSize = prev ? (prev.shape === "line" ? prev.lines : prev.length) : 0;
    const shape = String((_areaShape ?? prev?.shape) || "cone");
    const rawSize = ("_areaSize" in p) ? _areaSize : prevSize;
    const step = (shape === "line") ? 1 : 5;
    const snapped = Math.max(step, Math.round((Number(rawSize) || 0) / step) * step);
    return { ...rest, value: `${shape}:${snapped}` };
  }

  /**
   * Combine a legendary Attribute-bonus/penalty row's posted `_attrKey` /
   * `_attrAmount` sub-fields into its `value` ("key:amount", e.g. "might:2").
   * A partial submit may carry only one sub-field — fall back to the row's
   * existing parsed value for the other. A missing key or zero amount stores ""
   * (no effect). Non-attrMod rows pass through; temp keys never persist.
   * @param {object} p
   * @returns {object}
   */
  static #combineAttrModSubFields(p) {
    if ( !p || (typeof p !== "object") ) return p;
    if ( !("_attrKey" in p) && !("_attrAmount" in p) ) return p;
    const { _attrKey, _attrAmount, ...rest } = p;
    const meta = (CONFIG.OPENLEGEND?.legendaryProperties ?? {})[rest.name];
    if ( !meta?.attrMod ) return rest;   // drop stray temp keys from a since-changed row
    const prev = CONFIG.OPENLEGEND?.parseLegendaryAttrMod?.(rest.value) ?? null;
    const key = String(("_attrKey" in p) ? (_attrKey ?? "") : (prev?.key ?? ""));
    let amount = Math.trunc(Number(("_attrAmount" in p) ? _attrAmount : prev?.amount));
    // Key chosen but no amount ever posted: use the select's visible default (+1).
    if ( key && !Number.isFinite(amount) ) amount = 1;
    const valid = key && Number.isFinite(amount) && (amount !== 0);
    return { ...rest, value: valid ? `${key}:${amount}` : "" };
  }

  /**
   * Sanitize an extraordinary-boon row's Aura radiate fields: a non-Aura row
   * carries none (strip strays left by a name change), and an Aura row's
   * radiated power level may not exceed HALF the aura's PL — an over-cap value
   * resets to 0 (unset; the action builder defaults it to the lowest level the
   * radiated invocation defines within the cap).
   * @param {object} b  An extraordinaryBoons row.
   * @returns {object}
   */
  static #sanitizeXtraBoonAura(b) {
    if ( !b || (typeof b !== "object") ) return b;
    if ( String(b.name ?? "").trim().toLowerCase() !== "aura" ) {
      if ( !("auraRadiateUuid" in b) && !("auraRadiateKind" in b) && !("auraRadiateName" in b)
        && !("auraRadiatePowerLevel" in b) && !("auraRadiateResistanceType" in b) ) return b;
      const { auraRadiateKind, auraRadiateUuid, auraRadiateName, auraRadiatePowerLevel,
        auraRadiateResistanceType, ...rest } = b;
      return rest;
    }
    const cap = Math.floor(Math.max(0, Math.floor(Number(b.powerLevel) || 0)) / 2);
    const pl = Math.max(0, Math.floor(Number(b.auraRadiatePowerLevel) || 0));
    return (pl > cap) ? { ...b, auraRadiatePowerLevel: 0 } : b;
  }

  /** Default an extraordinary-property row's value to its first valid option when
   *  the property has ranks/choices but the value is empty or out of range. */
  static #normalizePropertyValue(p) {
    const meta = (CONFIG.OPENLEGEND?.itemProperties ?? {})[p?.name];
    if ( !meta ) return p;
    if ( meta.ranks?.length ) {
      const v = Math.floor(Number(p?.value) || 0);
      if ( !meta.ranks.includes(v) ) return { ...p, value: meta.ranks[0] };
    } else if ( meta.choices ) {
      const keys = Object.keys(meta.choices);
      if ( !keys.includes(String(p?.value)) ) return { ...p, value: keys[0] };
    } else if ( !meta.text && !meta.area && !meta.bane && !meta.boon && p?.value ) {
      // Flag property (no ranks/choices/text/area/bane/boon): carries no value —
      // clear any stale one (e.g. switching a row from a ranked property to
      // Reliable). A `text` (Special), `area` (Area), `bane` (Baneful/Cursed), or
      // `boon` (Persistent) property keeps its own value.
      return { ...p, value: "" };
    }
    return p;
  }

  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.item = this.item;
    context.system = this.item.system;
    // Wealth Level select options (1-9) for physical items. Use an object map
    // so {{selectOptions}} uses the number itself as the option value — passing
    // a bare array makes it use the array index, which is off-by-one.
    context.wealthLevels = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [i + 1, String(i + 1)])
    );
    // Armor type select options.
    context.armorTypes = OpenLegendItemSheet.ARMOR_TYPES;

    // Enriched HTML for the rich-text fields. The templates render these inside
    // <prose-mirror toggled> elements — the AppV2 replacement for the V1
    // {{editor}} helper, whose edit button relied on V1 Application listeners
    // and is inert under ApplicationV2. `notes` only exists on physical items;
    // enriching the empty string elsewhere is harmless.
    const TextEditor = foundry.applications.ux.TextEditor.implementation;
    // Banes / boons: any plain dice notation in their text becomes a clickable
    // (exploding) inline roll — Heal's "1d4", Persistent Damage's "1d6 damage
    // per round", Barrier's "Damaging (1d8)", anywhere dice appear.
    const isInvocation = (this.item.type === "bane") || (this.item.type === "boon");
    const linkify = isInvocation ? (CONFIG.OPENLEGEND?.diceToInlineRolls ?? (t => t)) : (t => t);
    context.enrichedDescription = await TextEditor.enrichHTML(linkify(this.item.system.description ?? ""), {
      relativeTo: this.item, secrets: this.item.isOwner
    });
    context.enrichedNotes = await TextEditor.enrichHTML(this.item.system.notes ?? "", {
      relativeTo: this.item, secrets: this.item.isOwner
    });

    // Bane / boon: the full effect text, per-power-level rows, and special
    // text, all with dice rendered as roll links — plus the Effects tab's
    // editable Active Effect rows (what is applied when dropped on a token).
    if ( isInvocation ) {
      await this._prepareInvocationRolls(context, TextEditor, linkify);
      this._prepareItemEffects(context);
      this._prepareInvocationEditing(context);
    }

    // Physical items (weapon/armor/gear): the Extraordinary-item editor — its
    // granted attributes, boons/banes, and properties — plus the Effects tab's
    // embedded Active Effect rows (applied to the wielder while active).
    if ( OpenLegendItemSheet.#isPhysical(this.item.type) ) {
      await this._prepareExtraordinaryContext(context);
      this._prepareItemEffects(context);
    }

    // Feats / perks / flaws: the Effects tab's embedded Active Effect rows
    // (transferred to the owning character while the item is owned). A
    // standalone "effect" item lists the same rows, but they are CLONED onto
    // whatever token/actor the item is dropped on instead of transferring.
    if ( ["feat", "perk", "flaw", "effect"].includes(this.item.type) ) this._prepareItemEffects(context);

    // Weapon: category checkboxes (with checked state) and property rows.
    if ( this.item.type === "weapon" ) this._prepareWeaponContext(context);

    // Action: enum option maps + derived range display (+ bane options, async).
    if ( this.item.type === "action" ) await this._prepareActionContext(context);

    // Feat: a readable per-tier breakdown (cost + prerequisites) for the sheet.
    if ( this.item.type === "feat" ) this._prepareFeatContext(context);

    // `editable`/`document`/`source`/`fields` are provided by super.
    return context;
  }

  /**
   * Enrich a bane/boon's display text with clickable roll links: the full
   * effect HTML (rendered in its own section — Barrier's damage dice live only
   * there), the per-power-level rows, and the bane's special text. Dice
   * notation was converted to inline-roll enrichers by `linkify` (see
   * diceToInlineRolls); enrichHTML turns those into anchors. Mutates `context`.
   * @param {object} context
   * @param {TextEditor} TextEditor  The TextEditor implementation.
   * @param {Function} linkify       Dice-notation → inline-roll transformer.
   * @private
   */
  async _prepareInvocationRolls(context, TextEditor, linkify) {
    const sys = this.item.system;
    const opts = { relativeTo: this.item, secrets: this.item.isOwner };
    context.enrichedEffect = await TextEditor.enrichHTML(linkify(sys.effect ?? ""), opts);
    context.enrichedSpecial = await TextEditor.enrichHTML(linkify(sys.special ?? ""), opts);
    context.powerEffectRows = await Promise.all((sys.powerEffects ?? []).map(async pe => ({
      powerLevel: pe.powerLevel,
      enriched: await TextEditor.enrichHTML(linkify(pe.effect ?? ""), opts)
    })));
  }

  /**
   * Build the Effects tab's rows: the item's embedded Active Effects — the
   * very effects cloned onto a token when the bane/boon is dropped on it (see
   * leveledEffectData). Each row resolves its change keys to the readable
   * labels from CONFIG.OPENLEGEND.effectChangeKeys and pairs every change with
   * its level from flags.openlegend.changeLevels. Mutates `context`.
   * @param {object} context
   * @private
   */
  _prepareItemEffects(context) {
    const describe = CONFIG.OPENLEGEND?.describeChange ?? (c => ({ subject: c.key, detail: c.value }));

    context.effectRows = this.item.effects.contents.map(e => {
      const levels = e.flags?.openlegend?.changeLevels ?? [];
      const modes = e.flags?.openlegend?.changeModes ?? [];
      return {
        id: e.id,
        name: e.name,
        img: e.img,
        disabled: e.disabled,
        changes: (e.system?.changes ?? []).map((c, i) => {
          const d = describe({ ...c, modifierType: modes[i] });
          return {
            label: d.subject,
            value: d.detail,
            level: Math.max(0, Math.floor(Number(levels[i]) || 0))
          };
        })
      };
    });
  }

  /**
   * Option maps + raw rows for editing a bane/boon's Details and Power Effects
   * tabs. Attacks (banes) store their attribute/defense as capitalized labels
   * (e.g. "Agility" / "Guard"), so the select options are keyed by label =
   * label. Boons store invoking attributes the same way. Mutates `context`.
   * @param {object} context
   * @private
   */
  _prepareInvocationEditing(context) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    // Attack/invoke attributes: bane attacks and boon attributes both store the
    // capitalized label, so the option value IS the label.
    const attrOptions = { "": "—" };
    for ( const label of Object.values(cfg.attributeLabels ?? {}) ) attrOptions[label] = label;
    context.attackAttributeOptions = attrOptions;
    // Defenses, likewise stored capitalized on bane attacks.
    context.defenseOptions = { "": "—", Guard: "Guard", Toughness: "Toughness", Resolve: "Resolve" };
    // Raw (unenriched) rows for the editable Power Effects table — the inputs
    // need the plain stored text, not the roll-linked HTML. submitOnChange posts
    // indexed paths (system.attacks.0.defense) which mergeObject turns the array
    // into a {"0":…} object; toArray restores a real array for .map here and for
    // the add/delete handlers (and _prepareSubmitData re-arrayifies on save).
    const toArray = OpenLegendItemSheet.#toArray;
    context.powerEffectsRaw = toArray(this.item.system.powerEffects).map((pe, i) => ({
      index: i,
      powerLevel: pe.powerLevel ?? 0,
      effect: pe.effect ?? ""
    }));
    context.attacksRaw = toArray(this.item.system.attacks).map((a, i) => ({
      index: i,
      attackingAttribute: a.attackingAttribute ?? "",
      defense: a.defense ?? ""
    }));
    context.attributesRaw = toArray(this.item.system.attributes).map((a, i) => ({ index: i, value: a }));
  }

  /** Whether an item type is a physical item (weapon/armor/gear) — the types
   *  that can be Extraordinary Items. */
  static #isPhysical(type) {
    return (type === "weapon") || (type === "armor") || (type === "gear");
  }

  /** A weapon's Deadly Extraordinary value (0 unless it is an equipped
   *  extraordinary weapon with the Deadly property), capped at 3. Mirrors
   *  deadlyAdvantage() in action-roll.mjs. */
  static #weaponDeadly(weapon) {
    if ( (weapon?.type !== "weapon") || !weapon.system?.extraordinary || !weapon.system?.equipped ) return 0;
    const prop = (weapon.system.extraordinaryProperties ?? []).find(p => p.name === "deadly");
    if ( !prop ) return 0;
    return Math.max(0, Math.min(3, Math.floor(Number(prop.value) || 0)));
  }

  /** The damage type a weapon's Damage (type) Extraordinary property grants, or
   *  "" (only for an equipped extraordinary weapon carrying the property). Mirrors
   *  weaponDamageType() in action-roll.mjs. */
  static #weaponDamageType(weapon) {
    if ( (weapon?.type !== "weapon") || !weapon.system?.extraordinary || !weapon.system?.equipped ) return "";
    const prop = (weapon.system.extraordinaryProperties ?? []).find(p => p.name === "damageType");
    return prop?.value ? String(prop.value) : "";
  }

  /**
   * Build the Extraordinary-item editor context for a physical item: the
   * granted-attribute rows (key + score), boon/bane rows (name + power level),
   * property rows (name + value), and the option maps that drive their selects.
   * Mutates `context`.
   * @param {object} context
   * @private
   */
  async _prepareExtraordinaryContext(context) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    const toArray = OpenLegendItemSheet.#toArray;
    const sys = this.item.system;

    // Option maps (value → label) for the selects. Score starts unset ("—").
    context.attributeOptions = { "": "—", ...(cfg.attributeLabels ?? {}) };
    context.scoreOptions = {
      0: "—",
      ...Object.fromEntries(Array.from({ length: Number(cfg.maxAttributeScore) || 9 }, (_, i) => [i + 1, String(i + 1)]))
    };
    // Power levels 1..9 for boons/banes (independent of the actor's attribute cap).
    context.powerLevelOptions = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [i + 1, String(i + 1)])
    );
    context.boonOptions = { "": "—", ...Object.fromEntries((cfg.boonNames ?? []).map(n => [n, n])) };
    context.baneOptions = { "": "—", ...Object.fromEntries((cfg.baneNames ?? []).map(n => [n, n])) };
    context.areaShapeOptions = { ...(cfg.areaShapes ?? {}) };
    context.propertyOptions = {
      "": "—",
      ...Object.fromEntries(Object.entries(cfg.itemProperties ?? {}).map(([k, p]) => [k, p.label]))
    };
    // For each property, whether it takes a rank and its rank options — used to
    // show/hide the value select per row.
    context.itemPropertyMeta = cfg.itemProperties ?? {};

    // Editable rows (toArray restores arrays mangled by submitOnChange). Values
    // start UNSET (0 → the "—" option) so the user must explicitly choose a score
    // / power level; the invoke buttons refuse to fire until one is picked.
    context.xtraAttributes = toArray(sys.extraordinaryAttributes).map((a, i) => ({
      index: i, key: a?.key ?? "", score: Math.max(0, Math.floor(Number(a?.score) || 0))
    }));
    // Each boon/bane row's power-level select offers ONLY the levels that the
    // chosen boon/bane actually defines (e.g. Fear → 5; Persistent Damage → 2,4,
    // 6,8,9; Invisible → 5,6), with a leading "—" (unset).
    context.xtraBoons = await Promise.all(toArray(sys.extraordinaryBoons).map(async (b, i) => {
      const pl = Math.max(0, Math.floor(Number(b?.powerLevel) || 0));
      const row = { index: i, name: b?.name ?? "", powerLevel: pl,
        plOptions: await OpenLegendItemSheet.#invocationLevelOptions("boon", b?.name, pl) };
      // An Aura boon row radiates a single bane OR boon — surface the radiated-
      // invocation picker (capped at half the aura's PL, SRD: Aura) on the row.
      if ( String(row.name).trim().toLowerCase() === "aura" ) {
        Object.assign(row, await OpenLegendItemSheet.#xtraAuraRadiateContext(b, pl));
      }
      return row;
    }));
    context.xtraBanes = await Promise.all(toArray(sys.extraordinaryBanes).map(async (b, i) => {
      const pl = Math.max(0, Math.floor(Number(b?.powerLevel) || 0));
      return { index: i, name: b?.name ?? "", powerLevel: pl,
        plOptions: await OpenLegendItemSheet.#invocationLevelOptions("bane", b?.name, pl) };
    }));
    context.xtraProperties = toArray(sys.extraordinaryProperties).map((p, i) => {
      const meta = (cfg.itemProperties ?? {})[p?.name];
      const choices = meta?.choices;
      // Area sub-values: parse once. cone/cube are FEET in 5' steps (like the action
      // dialog — a size must be a whole number of 5' squares); a line is a whole
      // number of lines (step 1, min 1). Unset defaults to the minimum.
      const areaDef = meta?.area ? cfg.parseItemArea?.(p?.value) : null;
      const areaShape = areaDef?.shape ?? "cone";
      const isLineArea = areaShape === "line";
      const areaStep = isLineArea ? 1 : 5;
      const areaMin = isLineArea ? 1 : 5;
      const areaSize = areaDef
        ? (isLineArea ? areaDef.lines : areaDef.length)
        : areaMin;
      return {
        index: i,
        name: p?.name ?? "",
        value: p?.value ?? "",
        hasRanks: !!meta?.ranks,
        rankOptions: meta?.ranks ? Object.fromEntries(meta.ranks.map(r => [r, String(r)])) : null,
        // A choices-valued property (e.g. Damage (type)) renders a select.
        hasChoices: !meta?.ranks && !!choices,
        choiceOptions: (!meta?.ranks && choices) ? { "": "—", ...choices } : null,
        // A text-valued property (e.g. Special) renders a free-text area.
        isText: !meta?.ranks && !choices && !meta?.area && !!meta?.text,
        // An area-valued property (Area) renders a shape select + size input;
        // the value is stored as "shape:size".
        isArea: !meta?.ranks && !choices && !!meta?.area,
        areaShape,
        areaSize,
        areaStep,
        areaMin,
        areaIsLine: isLineArea,
        // A bane-valued property (Baneful, Cursed) renders a bane select; the value
        // is the chosen bane's NAME (matched against the shared baneOptions map).
        isBane: !meta?.ranks && !choices && !meta?.area && !!meta?.bane,
        // A boon-valued property (Persistent) renders a boon select; the value is
        // the chosen boon's NAME (matched against the shared boonOptions map).
        isBoon: !meta?.ranks && !choices && !meta?.area && !meta?.bane && !!meta?.boon,
        // Persistent auto-apply toggle (default ON): whether the turn-start
        // automation applies this item's chosen boon to the wielder.
        isPersistent: p?.name === "persistent",
        persistentAutoOn: this.item.flags?.openlegend?.persistentAuto !== false,
        // A known FLAG property (e.g. Reliable, Sentient) takes no value: no
        // control at all. Unknown / not-yet-picked rows keep the free-text input.
        isFlag: !!meta && !meta.ranks && !choices && !meta.area && !meta.bane && !meta.boon && !meta.text,
        hint: meta?.hint ?? ""
      };
    });

    // Legendary properties (SRD: legendary items may possess any extraordinary
    // property, plus these). Same row model as the properties above; the
    // Attribute-bonus/penalty row edits _attrKey/_attrAmount sub-fields that
    // _prepareSubmitData combines into "key:amount".
    context.legendaryOptions = {
      "": "—",
      ...Object.fromEntries(Object.entries(cfg.legendaryProperties ?? {}).map(([k, p]) => [k, p.label]))
    };
    // Signed bonus/penalty amounts (−5…+5, no 0). An ARRAY (not an object) so the
    // select keeps this order — integer-like object keys would enumerate first.
    context.attrModOptions = [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5]
      .map(n => ({ value: n, label: n > 0 ? `+${n}` : `−${Math.abs(n)}` }));
    context.xtraLegendary = toArray(sys.legendaryProperties).map((p, i) => {
      const meta = (cfg.legendaryProperties ?? {})[p?.name];
      const mod = meta?.attrMod ? (cfg.parseLegendaryAttrMod?.(p?.value) ?? null) : null;
      return {
        index: i,
        name: p?.name ?? "",
        value: p?.value ?? "",
        // Attribute bonus/penalty: attribute + signed amount selects.
        isAttrMod: !!meta?.attrMod,
        attrKey: mod?.key ?? "",
        attrAmount: mod?.amount ?? 1,
        // Intelligent: free-text psyche/attributes/communication description.
        isText: !meta?.attrMod && !!meta?.text,
        // Slaying: the creature type, as a plain text input.
        isCreature: !meta?.attrMod && !meta?.text && !!meta?.creature,
        // Unfailing (or any valueless legendary property): no control.
        isFlag: !!meta && !meta.attrMod && !meta.text && !meta.creature,
        hint: meta?.hint ?? ""
      };
    });
  }

  /**
   * Coerce a value that should be an array but may have been turned into an
   * index-keyed object by mergeObject (Foundry's submitOnChange expansion of
   * `field.0`, `field.1`, …) back into a dense array, dropping empties.
   * @param {Array|object|undefined} v
   * @returns {Array}
   */
  static #toArray(v) {
    if ( Array.isArray(v) ) return v;
    if ( v && (typeof v === "object") ) {
      return Object.keys(v)
        .filter(k => /^\d+$/.test(k))
        .sort((a, b) => Number(a) - Number(b))
        .map(k => v[k]);
    }
    return [];
  }

  /**
   * Build weapon-specific view data: a checkbox list of all categories (marking
   * the ones this weapon has), the weapon's structured properties resolved to
   * labels, and its referenced banes. Mutates `context`.
   * @param {object} context
   * @private
   */
  _prepareWeaponContext(context) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    const sys = this.item.system;
    const have = new Set(sys.categories ?? []);

    // All categories with checked state, for the multi-select editor.
    context.categoryOptions = Object.entries(cfg.weaponCategories ?? {}).map(([key, c]) => ({
      key, label: c.label, ranged: !!c.ranged, checked: have.has(key)
    }));

    // The weapon's properties resolved to display rows {key, label, value, detail}.
    const propDefs = cfg.weaponProperties ?? {};
    context.weaponProperties = (sys.properties ?? []).map(p => {
      const def = propDefs[p.key] ?? { label: p.key };
      return {
        key: p.key,
        label: def.label,
        valued: !!def.valued,
        parameterized: !!def.parameterized,
        value: p.value ?? null,
        detail: p.detail ?? ""
      };
    });
    // Full property catalog for the "add property" picker (excluding ones present).
    context.propertyChoices = Object.entries(propDefs)
      .filter(([key]) => !(sys.properties ?? []).some(p => p.key === key))
      .map(([key, d]) => ({ key, label: d.label }));

    // Referenced banes (stored as {name, uuid}); shown as links.
    context.weaponBanes = sys.banes ?? [];
  }

  /**
   * Build the feat sheet's per-tier breakdown: each tier's cost and a readable
   * prerequisite string. Mutates `context`.
   * @param {object} context
   * @private
   */
  _prepareFeatContext(context) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    const sys = this.item.system;
    context.featTiers = (sys.tiers ?? []).map(t => ({
      tier: t.tier,
      cost: t.cost,
      prerequisite: cfg.formatPrerequisite ? cfg.formatPrerequisite(t.prerequisites) : "—"
    }));
    context.featMultiTier = (Number(sys.maxTier) || 1) > 1;
  }

  /* -------------------------------------------- */

  /**
   * Build action view data: enum option maps for the selects, the attribute
   * label map, and the derived range. For "non-physical" range the value is
   * derived from the owning actor's score in the chosen attribute (per the
   * 1-3/4-6/7-9 → 25/50/75 table); off-actor it shows the table is score-based.
   * Bane actions also get a filtered bane picker + power-level range (async, as
   * it reads the banes compendium). Mutates `context`.
   * @param {object} context
   * @private
   */
  async _prepareActionContext(context) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    const sys = this.item.system;

    context.actionCategories = cfg.actionCategories ?? {};
    context.actionTypes = cfg.actionTypes ?? {};
    context.rangeModes = cfg.rangeModes ?? {};
    context.rangeBands = Object.fromEntries(
      Object.entries(cfg.rangeBands ?? {}).map(([k, b]) => [k, b.label])
    );
    context.targetModes = { ...(cfg.targetModes ?? {}) };
    // Summon Creature (boon): its multi-targeting is special — one invocation
    // may summon several creatures at disadvantage 2 per creature beyond the
    // first (see CONFIG.multiTargetDisadvantage "summon"). Offer the extra
    // targeting mode only when the chosen boon is a Summon.
    const isSummonBoon = (sys.actionCategory === "boon") && /summon/i.test(String(sys.boonName ?? ""));
    if ( isSummonBoon || (sys.targets === "summon") ) context.targetModes.summon = "Summon Monster";
    context.showSummonCount = (sys.targets === "summon");
    context.summonCount = Math.max(1, Math.floor(Number(sys.summonCount ?? 2) || 2));
    context.areaShapes = cfg.areaShapes ?? {};
    context.targetDefenses = cfg.targetDefenses ?? {};
    context.attributeLabels = cfg.attributeLabels ?? {};
    context.interruptTypes = cfg.interruptTypes ?? {};
    // On-roll macro: resolve its name for the field hint (null if the uuid is
    // unset or no longer resolves).
    context.macroName = sys.macroUuid
      ? (await fromUuid(sys.macroUuid).catch(() => null))?.name ?? null
      : null;
    // Interrupt actions are either a Defend or an Improvise.
    context.showInterruptType = (sys.actionCategory === "interrupt");
    // An interrupt action's economy type is always "interrupt" — the select is
    // rendered disabled, and a disabled <select> doesn't submit, so force the
    // stored value here (once) to keep it consistent.
    if ( context.showInterruptType && (sys.actionType !== "interrupt") ) {
      await this.item.update({ "system.actionType": "interrupt" });
    }
    // Damaging and bane actions are resolved against a chosen target defense.
    context.showTargetDefense = (sys.actionCategory === "damaging") || (sys.actionCategory === "bane");

    // Mount/vehicle-owned attack action: a Pilot select, offering the mount's
    // seated pilots (the sheet's Pilots slots). Targeted Weapons reads the chosen
    // pilot's live Agility at roll time for its advantage.
    const mountOwner = this.item.actor;
    context.showMountPilot = (mountOwner?.type === "mount") && context.showTargetDefense;
    if ( context.showMountPilot ) {
      const opts = { "": "—" };
      for ( const uuid of (mountOwner.system.pilots ?? []) ) {
        if ( !uuid ) continue;
        const p = fromUuidSync(String(uuid));
        if ( p ) opts[uuid] = p.name;
      }
      // A stored pilot no longer seated (or deleted) stays visible so it can be
      // seen and cleared, rather than silently snapping to "—".
      if ( sys.pilotUuid && !opts[sys.pilotUuid] ) {
        const p = fromUuidSync(String(sys.pilotUuid));
        opts[sys.pilotUuid] = p ? `${p.name} (no longer seated)` : "(missing pilot)";
      }
      context.mountPilotOptions = opts;
    }

    // Damage type, shown for damaging actions. The selectable types are scoped
    // strictly to the action's chosen attribute (damage types are grouped
    // per-attribute) — unless the "Show All Damage Types" world setting is on,
    // which offers the full catalog. Attributes with no damage group offer no
    // types at all. A leading blank option means "none", so an attribute without
    // a matching group — or whose stored value no longer fits — reads as unset
    // rather than silently showing a stale type.
    context.showDamageType = (sys.actionCategory === "damaging");
    if ( context.showDamageType ) {
      const all = cfg.allDamageTypes ? cfg.allDamageTypes() : (cfg.damageTypes ?? {});
      const byAttr = cfg.allDamageTypesByAttribute ? cfg.allDamageTypesByAttribute() : (cfg.damageTypesByAttribute ?? {});
      const unfiltered = game.settings.get("tomucatos-open-legend-rpg-system", "unfilteredDamageTypes");
      const forAttr = unfiltered ? Object.keys(all) : (byAttr[sys.attribute] ?? []);
      const opts = { "": "—", ...Object.fromEntries(forAttr.map(k => [k, all[k] ?? k])) };
      // A selected weapon with the Damage (type) Extraordinary property lets this
      // attack inflict that type INSTEAD of its normal one — so offer it here even
      // if it isn't one of the attribute's native types.
      const actorForWeapon = this.item.actor;
      const weapon = (actorForWeapon && sys.weaponId) ? actorForWeapon.items.get(sys.weaponId) : null;
      const wType = OpenLegendItemSheet.#weaponDamageType(weapon);
      if ( wType ) {
        const wLabel = all[wType] ?? wType;
        opts[wType] = `${wLabel} (${weapon.name})`;
        context.weaponDamageTypeHint = `${weapon.name} can inflict ${wLabel} damage in lieu of the normal type.`;
      }
      context.damageTypeOptions = opts;
      context.damageTypeSelectTitle = unfiltered
        ? "All damage types are offered (per the Show All Damage Types world setting)."
        : "Damage types are grouped by the action's attribute; a selected Damage (type) weapon adds its type.";
      // Flavor description of the currently-selected damage type, shown as a hint.
      context.damageTypeDescription = (cfg.allDamageTypeDescriptions ? cfg.allDamageTypeDescriptions(sys.attribute) : (cfg.damageTypeDescriptions ?? {}))[sys.damageType] ?? "";
    }

    // Derived range readout.
    const actor = this.item.actor;
    let range = "";
    if ( sys.rangeMode === "melee" ) {
      range = "Melee";
    } else if ( sys.rangeMode === "ranged" ) {
      const band = cfg.rangeBands?.[sys.rangeBand];
      range = band ? `${band.feet} ft (${band.label.replace(/\s*\(.*\)/, "")} increment)` : "";
    } else if ( sys.rangeMode === "non-physical" ) {
      if ( actor ) {
        const score = Number(actor.system?.attributes?.[sys.attribute]?.value ?? 0);
        const feet = cfg.nonPhysicalRange ? cfg.nonPhysicalRange(score) : 0;
        const label = cfg.attributeLabels?.[sys.attribute] ?? sys.attribute;
        range = feet ? `${feet} ft (${label} ${score})` : `— (${label} ${score})`;
      } else {
        range = "By attribute score (25/50/75 ft)";
      }
    }
    context.derivedRange = range;

    // Dice modifiers: derived disadvantage from multi-targeting / area attacks
    // (separate from the manual disadvantage field). Build a list of contributing
    // modifiers for the "Dice Modifiers" section, plus the total.
    const modifiers = [];
    // An Area-property weapon (built-in OR Extraordinary) "always makes
    // multi-target area attacks … [which] do not incur any of the disadvantage
    // penalties associated with multi-target attacks." So a selected area weapon
    // LOCKS the action to its area (targets + shape/size shown but disabled) and
    // zeroes the multi-targeting disadvantage.
    const areaDef = sys.weaponId
      ? OpenLegendItemSheet.#weaponArea(this.item.actor?.items.get(sys.weaponId)) : null;
    const areaWeapon = !!areaDef;
    const mtRaw = areaWeapon ? 0 : (cfg.multiTargetDisadvantage ? cfg.multiTargetDisadvantage(sys) : 0);
    if ( mtRaw > 0 ) {
      let label = "Multiple targets";
      if ( sys.targets === "area" ) {
        const shapeLabel = cfg.areaShapes?.[sys.area?.shape] ?? sys.area?.shape ?? "Area";
        label = `Area (${shapeLabel})`;
      } else if ( sys.targets === "summon" ) {
        label = `Summoning ${context.summonCount} creatures`;
      }
      modifiers.push({ label, disadvantage: mtRaw });
      // Multi-Target Specialist reduction (advantage row), so the net here mirrors
      // the roll dialog: Attack Specialist for attacks (matching mode), Boon
      // Specialist for boons.
      const actor = this.item.actor;
      const isBoonAction = sys.actionCategory === "boon";
      const rawReduce = !actor ? 0
        : (isBoonAction ? (cfg.multiTargetBoonReduction?.(actor) ?? 0)
                        : (cfg.multiTargetAttackReduction?.(actor, sys) ?? 0));
      const mtReduce = Math.min(mtRaw, rawReduce);
      if ( mtReduce > 0 ) {
        const specLabel = isBoonAction ? "Multi-Target Boon Specialist" : "Multi-Target Attack Specialist";
        modifiers.push({ label: specLabel, advantage: mtReduce, disadvantage: -mtReduce });
      }
      // Multi-Target Boon Expert: when the boon's multi-target disadvantage is fully
      // negated and the actor has Boon Focus for it, the invocation auto-succeeds.
      if ( isBoonAction && (mtReduce >= mtRaw) && (cfg.hasMultiTargetBoonExpert?.(actor) ?? false)
        && (cfg.boonFocus?.(actor, { boonName: sys.boonName, targets: sys.targets })) ) {
        context.multiTargetBoonExpertNote = "Multi-Target Boon Expert: this multi-target invocation auto-succeeds (no roll) — multi-targeting disadvantage fully negated and you have Boon Focus for this boon.";
      }
    }
    // Lock flags + readout for the template: the area controls are preselected
    // (to the weapon's area) and disabled, and targeting is fixed to Area.
    context.areaWeaponLocked = areaWeapon;
    if ( areaWeapon ) {
      // Force the stored targeting/area to the weapon's area. The locked controls
      // are disabled (so they don't submit) — sync the stored value once when it
      // drifts, mirroring the interrupt actionType pattern above. The roll reads
      // sys.targets / sys.area, so they must match the weapon's area.
      if ( (sys.targets !== "area")
        || (sys.area?.shape !== areaDef.shape)
        || (Number(sys.area?.length) !== Number(areaDef.length))
        || (Number(sys.area?.lines) !== Number(areaDef.lines)) ) {
        await this.item.update({
          "system.targets": "area",
          "system.area.shape": areaDef.shape,
          "system.area.length": areaDef.length,
          "system.area.lines": areaDef.lines
        });
      }
      const shapeLabel = cfg.areaShapes?.[areaDef.shape] ?? areaDef.shape;
      const size = areaDef.shape === "line"
        ? `${Math.max(1, areaDef.lines)} line${areaDef.lines === 1 ? "" : "s"}`
        : `${areaDef.length}'`;
      context.areaWeaponNote = `Area weapon: this attack is locked to its ${shapeLabel} (${size}) area and waives multi-targeting disadvantage.`;
    }
    // Dice Modifiers preview: when the action is owned by an actor, show the SAME
    // itemized advantage/disadvantage breakdown the roll dialog will (one source of
    // truth — prepareActionRoll). On an unowned action (item directory, no actor),
    // fall back to the local multi-target-only list computed above.
    let rows = modifiers;
    const ownerActor = this.item.actor;
    if ( ownerActor ) {
      try {
        const ctx = await prepareActionRoll(this.item, ownerActor, { quiet: true });
        rows = ctx.sources ?? [];
        // The Lethal Strike toggle adds advantage only when the player checks it in
        // the dialog, so surface it as an optional note, not a counted row.
        if ( ctx.lethalStrike ) {
          context.lethalStrikeNote = `Lethal Strike (Tier ${ctx.lethalStrike.tier}): +${ctx.lethalStrike.advantage} advantage if you check it when rolling.`;
        }
      } catch ( err ) {
        console.error("OpenLegend | could not build the action's modifier preview:", err);
      }
    }
    // Normalize each row to {label, advantage, disadvantage, note} and compute the
    // net (positive = advantage). Mirrors the dialog's source math. `note` carries
    // informational rows that aren't adv/dis (e.g. Guided Weapons' extra d20).
    const norm = rows.map(m => ({
      label: m.label,
      advantage: Math.max(0, Number(m.advantage ?? 0)),
      disadvantage: Math.max(0, Number(m.disadvantage ?? 0)),
      note: m.note ?? ""
    }));
    const net = norm.reduce((s, m) => s + m.advantage - m.disadvantage, 0);
    context.diceModifiers = norm;
    context.diceModifierNet = net;
    context.diceModifierNetAbs = Math.abs(net);

    // Ranged multi-targeting is capped at 5 foes; warn (don't clamp) when exceeded.
    context.rangedTargetWarning =
      (sys.targets === "multiple") && (sys.rangeMode === "ranged") &&
      (Number(sys.targetCount ?? 0) > 5);

    // Line area: 5' wide × 10' long per line; additional lines extend the length
    // end-to-end, so the footprint reads "5' × (N×10)' × 10'" (1 line = 5'×10'×10').
    // The 10' height is irrelevant on the 2D canvas.
    if ( sys.targets === "area" && sys.area?.shape === "line" ) {
      const n = Math.max(1, Math.floor(Number(sys.area?.lines ?? 1)));
      context.areaLineDimensions = `5' × ${n * 10}' × 10'`;
    }

    // Weapon wielding (damaging / bane actions on an actor): a picker listing
    // the actor's weapons plus the grip modes the chosen weapon offers. Picking
    // a weapon cascades attribute / damage type / default grip in the item's
    // _preUpdate (Precise → Agility/precision, Forceful → Might/force); the grip
    // feeds advantage 1 into the attack roll for two-handed or dual wielding
    // (see rollAction). A 2H-only weapon's sole grip is locked.
    const isAttack = (sys.actionCategory === "damaging") || (sys.actionCategory === "bane");
    context.showWeapon = isAttack && !!actor && actor.items.some(i => i.type === "weapon");
    if ( context.showWeapon ) this._prepareWeaponWielding(context, sys, actor);

    // Defend interrupts instead pick from the actor's DEFENSIVE weapons only: a
    // defensive weapon grants advantage equal to its Defensive value on the
    // defend roll (seeded in rollDefend / rollAction). No grip — wielding a
    // defensive item forfeits the 1H/2H attack advantage anyway.
    const isDefend = (sys.actionCategory === "interrupt") && (sys.interruptType === "defend");
    if ( isDefend && actor ) this._prepareDefendWeapon(context, sys, actor);

    // Bane actions: a picker listing the banes the chosen attribute can invoke,
    // filtered by the actor's score in that attribute (power level ≤ score), and
    // a power-level selector (bane minimum → score).
    context.showBane = (sys.actionCategory === "bane");
    if ( context.showBane ) await this._prepareBaneOptions(context, sys, actor);
    // Multi-Bane Specialist (feat): on a bane action, offer a toggle to invoke the
    // feat's chosen PAIR with a single attack. Shown only if the actor owns the feat.
    // When on, the single-bane select is disabled (the pair overrides it).
    context.showMultiBane = context.showBane && (cfg.hasMultiBaneSpecialist?.(actor) ?? false);
    context.multiBaneOn = context.showMultiBane && !!sys.multiBane;
    if ( context.showMultiBane ) {
      // All owned pairs (one option per copy of the feat); the action stores the
      // chosen pair's "A & B" value in system.multiBanePair. Multiple instances →
      // show a pair selector; a single instance → just the descriptive label.
      const pairOpts = cfg.multiBanePairOptions?.(actor) ?? [];
      context.multiBanePairOptions = pairOpts;
      context.showMultiBanePicker = pairOpts.length > 1;
      context.multiBanePairValue = sys.multiBanePair || pairOpts[0]?.value || "";
      const resolved = await cfg.resolveMultiBanePair?.(actor, { pairValue: context.multiBanePairValue });
      context.multiBanePairLabel = resolved
        ? `${resolved.banes.map(b => b.name).join(" & ")} (requires ${cfg.attributeLabels?.[sys.attribute] ?? sys.attribute} ${resolved.requiredScore})`
        : "";
    }

    // Boon actions: the parallel picker listing boons the chosen attribute can
    // invoke (boons store their invoking attribute(s) directly, not an attack).
    context.showBoon = (sys.actionCategory === "boon");
    if ( context.showBoon ) await this._prepareBoonOptions(context, sys, actor);

    // Powerful (Extraordinary): a bane/boon invocation made WITH an item that has
    // the Powerful property gains advantage equal to its value. Offer a picker of
    // the actor's active extraordinary items carrying Powerful, on bane/boon
    // actions only (invocations).
    if ( (context.showBane || context.showBoon) && actor ) this._preparePowerfulItem(context, sys, actor);
  }

  /**
   * Build the Powerful-item picker for a bane/boon action: the actor's ACTIVE
   * extraordinary items (equipped weapon/armor, or any gear) that carry the
   * Powerful property, each labelled with its value. Selecting one adds advantage
   * equal to that value to the invocation roll (see rollAction). Mutates context.
   * @param {object} context
   * @param {object} sys
   * @param {Actor} actor
   * @private
   */
  _preparePowerfulItem(context, sys, actor) {
    const items = actor.items.filter(i => OpenLegendItemSheet.#itemPowerful(i) > 0);
    context.showPowerful = items.length > 0;
    if ( !context.showPowerful ) return;
    context.powerfulOptions = items
      .map(i => ({ id: i.id, name: `${i.name} (Powerful ${OpenLegendItemSheet.#itemPowerful(i)})`, selected: i.id === sys.powerfulItemId }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const chosen = items.find(i => i.id === sys.powerfulItemId) ?? null;
    const val = chosen ? OpenLegendItemSheet.#itemPowerful(chosen) : 0;
    context.powerfulHint = val
      ? `${chosen.name} is Powerful ${val}: this invocation gains advantage ${val}.`
      : "";
  }

  /** An item's Powerful Extraordinary value (0 unless it is an ACTIVE — equipped
   *  for weapon/armor, always for gear — extraordinary item with the property),
   *  capped at 3. Mirrors powerfulAdvantage() in action-roll.mjs. */
  static #itemPowerful(item) {
    if ( !item?.system?.extraordinary ) return 0;
    if ( ((item.type === "weapon") || (item.type === "armor")) && !item.system.equipped ) return 0;
    const prop = (item.system.extraordinaryProperties ?? []).find(p => p.name === "powerful");
    if ( !prop ) return 0;
    return Math.max(0, Math.min(3, Math.floor(Number(prop.value) || 0)));
  }

  /**
   * Build the weapon picker + grip options for a damaging / bane action owned
   * by an actor (Weapons & Implements wielding rules). The grip modes follow
   * the weapon's hand requirement:
   *   1-handed:  One-handed (default) / Dual wield
   *   2-handed:  Two-handed only — locked (the radio is disabled)
   *   versatile: all three modes
   * The hint line spells out the active grip's roll benefit: two-handed melee
   * grants advantage 1; dual wielding one-handed weapons grants advantage 1
   * unless the weapon has the Defensive property. Mutates `context`.
   * @param {object} context
   * @param {object} sys   The action's system data.
   * @param {Actor} actor  The owning actor.
   * @private
   */
  _prepareWeaponWielding(context, sys, actor) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    context.weaponPickerTitle = "Picking a Precise weapon presets Agility (precision damage); a Forceful one presets Might (force damage).";
    const weapons = actor.items.filter(i => i.type === "weapon");
    const deadlyOf = OpenLegendItemSheet.#weaponDeadly;
    context.weaponOptions = weapons
      .map(w => {
        const deadly = deadlyOf(w);
        return {
          id: w.id,
          // Surface the Deadly value in the option so the player sees the
          // attack will gain that advantage when this weapon is selected.
          name: deadly ? `${w.name} (Deadly ${deadly})` : w.name,
          equipped: !!w.system.equipped,
          selected: w.id === sys.weaponId
        };
      })
      .sort((a, b) => (Number(b.equipped) - Number(a.equipped)) || a.name.localeCompare(b.name));

    const weapon = weapons.find(w => w.id === sys.weaponId) ?? null;
    context.gripOptions = [];
    context.gripHint = "";
    // When the selected weapon is Deadly, spell out the advantage it grants.
    const deadly = weapon ? deadlyOf(weapon) : 0;
    context.deadlyHint = deadly
      ? `${weapon.name} is Deadly ${deadly}: this attack gains advantage ${deadly}.`
      : "";
    if ( !weapon ) return;

    const hands = cfg.weaponHandsFor ? cfg.weaponHandsFor(weapon.system.categories ?? []) : 1;
    const twoWeaponBrute = !!(cfg.hasTwoWeaponBrute && cfg.hasTwoWeaponBrute(actor));
    // Two Weapon Brute lets a two-handed weapon be wielded one-handed, so it can also
    // be dual-wielded (→ advantage 2). Without the feat a 2H weapon is two-handed only.
    const choices = hands === 2 ? (twoWeaponBrute ? ["two-handed", "dual-wield"] : ["two-handed"])
      : hands === "versatile" ? ["one-handed", "dual-wield", "two-handed"]
      : ["one-handed", "dual-wield"];
    // Normalize a stale grip (e.g. the weapon's categories changed) to the
    // first offered mode for display; _preUpdate keeps the stored value sane.
    const grip = choices.includes(sys.grip) ? sys.grip : choices[0];
    const labels = { "one-handed": "One-handed", "dual-wield": "Dual wield", "two-handed": "Two-handed" };
    context.gripOptions = choices.map(key => ({
      key,
      label: labels[key],
      checked: key === grip,
      // A 2H-only weapon's sole mode can't be deselected.
      disabled: choices.length === 1
    }));

    // A Defensive item forfeits the 1H/2H wielding advantage entirely ("While
    // wielding an item with the defensive property, you don't gain the
    // advantage 1 to attacks normally associated with Melee One-handed or
    // Two-handed weapons").
    const defensive = (weapon.system.properties ?? []).some(p => p.key === "defensive");
    if ( grip === "two-handed" ) {
      context.gripHint = defensive
        ? "No two-handed advantage — Defensive items forfeit the usual wielding advantage to attacks."
        : "Two-handed: advantage 1 to all attacks with this weapon.";
    } else if ( grip === "dual-wield" ) {
      // Dual-wielding a two-handed weapon is only possible with Two Weapon Brute, and
      // grants advantage 2 (two-handed power + one weapon in each hand).
      const bruteDual = (hands === 2) && twoWeaponBrute;
      context.gripHint = defensive
        ? "No dual-wield advantage — this weapon has the Defensive property (neither weapon may have it)."
        : bruteDual
          ? "Two Weapon Brute: dual-wielding two-handed weapons grants advantage 2 (two-handed power + one in each hand; neither may have the Defensive property)."
          : "Dual wielding one-handed weapons: advantage 1 to attacks (neither weapon may have the Defensive property).";
    } else {
      context.gripHint = "One-handed: the other hand stays free for a shield, a second weapon, or other actions.";
    }
  }

  /**
   * Build the weapon picker for a defend interrupt: only the actor's weapons
   * with the Defensive property are listed (Defensive N grants advantage N,
   * capped at 3, when its wielder takes the defend action — seeded into the
   * defend roll). Reuses the action sheet's Weapon section with no grip row.
   * Mutates `context`.
   * @param {object} context
   * @param {object} sys   The action's system data.
   * @param {Actor} actor  The owning actor.
   * @private
   */
  _prepareDefendWeapon(context, sys, actor) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    // The EFFECTIVE defensive value reflects Defensive Mastery (+1 when owned).
    const defensiveValue = w => cfg.effectiveDefensiveValue
      ? cfg.effectiveDefensiveValue(w, actor)
      : (cfg.weaponDefensiveValue ? cfg.weaponDefensiveValue(w) : 0);
    const hasDefensive = w => cfg.weaponDefensiveValue ? cfg.weaponDefensiveValue(w) > 0 : false;
    const mastery = !!(cfg.hasDefensiveMastery && cfg.hasDefensiveMastery(actor));
    const weapons = actor.items.filter(i => (i.type === "weapon") && hasDefensive(i));
    if ( !weapons.length ) return;

    context.showWeapon = true;
    context.weaponPickerTitle = "A defensive weapon grants advantage equal to its Defensive value when its wielder takes the defend action.";
    context.weaponPickerHint = "Only weapons with the Defensive property can aid a defend action.";
    context.weaponOptions = weapons
      .map(w => ({
        id: w.id,
        name: `${w.name} (Defensive ${defensiveValue(w)})`,
        equipped: !!w.system.equipped,
        selected: w.id === sys.weaponId
      }))
      .sort((a, b) => (Number(b.equipped) - Number(a.equipped)) || a.name.localeCompare(b.name));
    context.gripOptions = [];

    const weapon = weapons.find(w => w.id === sys.weaponId) ?? null;
    context.gripHint = weapon
      ? `Defend rolls with ${weapon.name} gain advantage ${defensiveValue(weapon)}${mastery ? " (Defensive Mastery)" : ""}; wielding it also grants a +${mastery ? 2 : 1} armor bonus to Guard while equipped.`
      : "";
  }

  /**
   * Build the bane picker + invocation power-level options for a bane action.
   * A bane is listed when it has an attack entry using the action's attribute
   * AND its power level ≤ the actor's score in that attribute (off-actor: all
   * banes for the attribute, ignoring score). Mutates `context`.
   * @param {object} context
   * @param {object} sys     The action's system data.
   * @param {Actor|null} actor  The owning actor, if any.
   * @private
   */
  async _prepareBaneOptions(context, sys, actor) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    const attrKey = sys.attribute;
    const attrLabel = cfg.attributeLabels?.[attrKey] ?? attrKey;
    // Compare the chosen attribute (lowercase key) against the bane's attack
    // entries, whose attackingAttribute is the capitalized label.
    const score = actor ? Number(actor.system?.attributes?.[attrKey]?.value ?? 0) : null;

    // Weapon-bane synergy (Weapons & Implements): banes listed on the wielded
    // weapon are treated as one power level lower for invocation prerequisites
    // (so prereq passes at PL ≤ score + 1), are invokable via the attacking
    // attribute even when their attack entries don't include it ("special
    // weapons list banes not normally invoked via Agility or Might"), and
    // grant advantage 1 on the bane attack (applied in rollAction). Matched by
    // name so embedded weapons with stale compendium uuids still pair up.
    const weapon = (actor && sys.weaponId) ? actor.items.get(sys.weaponId) : null;
    const weaponBaneNames = new Set(
      ((weapon?.type === "weapon" ? weapon.system.banes : null) ?? [])
        .map(b => String(b.name ?? "").toLowerCase())
        .filter(Boolean)
    );

    const pack = game.packs?.get("tomucatos-open-legend-rpg-system.banes");
    const options = [];
    if ( pack ) {
      // Need power level + attacks to filter, so load the documents.
      const docs = await pack.getDocuments();
      for ( const bane of docs ) {
        const attacks = bane.system?.attacks ?? [];
        const match = attacks.find(a => (a.attackingAttribute ?? "").toLowerCase() === String(attrLabel).toLowerCase());
        const fromWeapon = weaponBaneNames.has(bane.name.toLowerCase());
        if ( !match && !fromWeapon ) continue;   // attribute can't invoke it, and the weapon doesn't list it
        const pl = Number(bane.system?.powerLevel ?? 0);
        // Weapon banes pass prerequisites at one power level lower (≤ score + 1).
        const maxPl = (score === null) ? null : score + (fromWeapon ? 1 : 0);
        if ( (maxPl !== null) && (pl > maxPl) ) continue;
        // The discrete power levels this bane actually defines (e.g. 2,4,6,9),
        // sorted ascending — these are the only invocable levels.
        const levels = [...new Set(
          (bane.system?.powerEffects ?? [])
            .map(pe => Number(pe.powerLevel))
            .filter(n => Number.isFinite(n) && (n > 0))
        )].sort((a, b) => a - b);
        options.push({
          uuid: bane.uuid, name: bane.name, powerLevel: pl,
          // A weapon-only bane has no attack entry for this attribute; it still
          // targets the defense its other attack entries use.
          defense: ((match ?? attacks[0])?.defense ?? "guard").toLowerCase(),
          levels: levels.length ? levels : [pl],  // fall back to the minimum
          weapon: fromWeapon,
          // Potent Bane feat: invoking this bane is always Potent — preselect it.
          potent: cfg.isPotentBane?.(actor, bane.name) ?? false
        });
      }
      // Weapon banes first (they're the reason the weapon was picked), then by
      // power level and name.
      options.sort((a, b) => (Number(b.weapon) - Number(a.weapon))
        || (a.powerLevel - b.powerLevel) || a.name.localeCompare(b.name));
    }
    // Extraordinary-item banes the actor possesses: appended regardless of the
    // action's attribute (the item grants access). Each carries its source item
    // + listed value; invoking uses that value for the power level AND dice.
    options.push(...await OpenLegendItemSheet.#itemInvocationOptions(actor, "bane", "extraordinaryBanes", sys.invokeFromItemId));
    OpenLegendItemSheet.#tagInvocationValues(options);
    context.baneOptions = options;
    context.baneSelectedValue = OpenLegendItemSheet.#invocationValue(sys.baneUuid, sys.invokeFromItemId, sys.invokeItemScore);
    context.baneAttributeLabel = attrLabel;
    context.baneActorScore = score;
    context.baneWeaponHint = (weapon && weaponBaneNames.size)
      ? `⚔ marks ${weapon.name}'s listed banes: invocation prerequisites are met at one power level lower, and inflicting one grants advantage 1 on the attack.`
      : "";

    // Invocation power-level options: only the DISCRETE levels the chosen bane
    // defines (e.g. Persistent Damage → 2, 4, 6, 9), filtered to those the actor
    // can reach (≤ score, or ≤ score + 1 for a weapon-listed bane; off-actor
    // shows all the bane's levels). Object map so {{selectOptions}} uses the
    // number as the value.
    // The chosen option: an item invocation is matched by uuid AND its source
    // item id (the same bane can be listed by both an attribute and an item);
    // an attribute invocation matches uuid among the non-item options.
    const chosen = OpenLegendItemSheet.#findChosenInvocation(options, sys.baneUuid, sys.invokeFromItemId);
    // Item invocation: the cap is the item's listed value; the wielder may invoke
    // at or below it (dice are NOT reduced — handled at roll time). Attribute
    // invocation: cap by the actor's score (+1 for a weapon-listed bane).
    const chosenMax = chosen?.fromItem
      ? Number(chosen.itemScore)
      : ((score === null) ? null : score + (chosen?.weapon ? 1 : 0));
    const usable = chosen
      ? chosen.levels.filter(pl => (chosenMax === null) || (pl <= chosenMax))
      : [];
    context.powerLevelOptions = Object.fromEntries(usable.map(pl => [pl, String(pl)]));
    context.baneChosen = !!chosen;
    // Potent Bane feat: the chosen bane is ALWAYS potent — force the checkbox on and
    // lock it (the player can't unset it). Keyed off the resolved bane's name. Sync
    // the stored flag once if it drifted (e.g. the feat was added after the action),
    // since a disabled checkbox doesn't submit its value.
    context.baneForcedPotent = !!chosen && (cfg.isPotentBane?.(actor, sys.baneName) ?? false);
    if ( context.baneForcedPotent && !sys.potent ) await this.item.update({ "system.potent": true });
    // When the selected bane comes from an extraordinary item, the attribute is
    // irrelevant (the item's value supplies the dice): disable the attribute
    // select and show the item's name in its place.
    context.invocationFromItem = !!chosen?.fromItem;
    context.invocationItemName = chosen?.fromItem ? (chosen.itemName ?? "Item") : "";
  }

  /**
   * Build the boon picker + invocation power-level options for a boon action.
   * Parallels {@link _prepareBaneOptions}, but boons aren't attacks: a boon is
   * listed when its invoking attribute(s) include the action's attribute AND its
   * minimum power level ≤ the actor's score in that attribute (off-actor: all
   * boons for the attribute, ignoring score). Mutates `context`.
   * @param {object} context
   * @param {object} sys     The action's system data.
   * @param {Actor|null} actor  The owning actor, if any.
   * @private
   */
  async _prepareBoonOptions(context, sys, actor) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    const attrKey = sys.attribute;
    const attrLabel = cfg.attributeLabels?.[attrKey] ?? attrKey;
    const score = actor ? Number(actor.system?.attributes?.[attrKey]?.value ?? 0) : null;

    const pack = game.packs?.get("tomucatos-open-legend-rpg-system.boons");
    const options = [];
    if ( pack ) {
      const docs = await pack.getDocuments();
      for ( const boon of docs ) {
        // Boons store invoking attributes by capitalized label; match the action's
        // chosen attribute label case-insensitively.
        const attrs = (boon.system?.attributes ?? []).map(a => String(a).toLowerCase());
        if ( !attrs.includes(String(attrLabel).toLowerCase()) ) continue;
        const pl = Number(boon.system?.powerLevel ?? 0);
        if ( (score !== null) && (pl > score) ) continue;        // minimum power exceeds the actor's score
        const levels = [...new Set(
          (boon.system?.powerEffects ?? [])
            .map(pe => Number(pe.powerLevel))
            .filter(n => Number.isFinite(n) && (n > 0))
        )].sort((a, b) => a - b);
        options.push({
          uuid: boon.uuid, name: boon.name, powerLevel: pl,
          levels: levels.length ? levels : [pl]   // fall back to the minimum
        });
      }
      options.sort((a, b) => (a.powerLevel - b.powerLevel) || a.name.localeCompare(b.name));
    }
    // Extraordinary-item boons the actor possesses (see _prepareBaneOptions).
    options.push(...await OpenLegendItemSheet.#itemInvocationOptions(actor, "boon", "extraordinaryBoons", sys.invokeFromItemId));
    // Boon Access feat boons (the actor invokes them at PL-as-score, bypassing the
    // attribute requirement) — routed through the feat as an item invocation.
    options.push(...await OpenLegendItemSheet.#boonAccessOptions(actor));
    OpenLegendItemSheet.#tagInvocationValues(options);
    context.boonOptions = options;
    context.boonSelectedValue = OpenLegendItemSheet.#invocationValue(sys.boonUuid, sys.invokeFromItemId, sys.invokeItemScore);
    context.boonAttributeLabel = attrLabel;
    context.boonActorScore = score;

    // No invocation power level is chosen by the player: the roll lands the boon
    // at the highest defined level it clears (see resolveBoonTargets). The
    // EFFECTIVE ceiling — the highest defined level the score (item invocation:
    // the item's listed value) can reach — still drives the Aura/Barrier
    // edit-time sub-pickers below.
    const chosen = OpenLegendItemSheet.#findChosenInvocation(options, sys.boonUuid, sys.invokeFromItemId);
    const cap = chosen?.fromItem ? Number(chosen.itemScore) : score;
    const reachable = (chosen?.levels ?? []).filter(pl => (cap === null) || (pl <= cap));
    const effectivePl = !chosen ? 0
      : chosen.fromItem ? (Number(chosen.itemScore) || 0)
      : reachable.length ? Math.max(...reachable)
      : (Number(chosen.powerLevel) || 0);
    context.boonChosen = !!chosen;
    // When the selected boon comes from an extraordinary item (or the Boon Access
    // feat), the attribute is irrelevant: disable the attribute select and show
    // the source's name in its place.
    context.invocationFromItem = !!chosen?.fromItem;
    context.invocationItemName = chosen?.fromItem ? (chosen.itemName ?? "Item") : "";

    // Extraordinary Healing (feat): only offered when the chosen boon is Heal AND
    // the acting actor owns the Extraordinary Healing feat. Toggling it changes the
    // invocation time to 1 hour and makes the healing roll restore lethal damage as
    // well as HP (handled at invoke/apply time).
    const isHeal = String(sys.boonName ?? "").trim().toLowerCase() === "heal";
    context.showExtraordinaryHealing = isHeal && (cfg.hasExtraordinaryHealing?.(actor) ?? false);

    // Aura (boon): when the chosen boon is Aura, surface a picker to choose the
    // bane OR boon the aura radiates — same attribute, capped at half the aura's PL.
    await this._prepareAuraOptions(context, sys, { attrKey, attrLabel, auraPl: effectivePl });
    await this._prepareBarrierOptions(context, sys, { attrLabel, barrierPl: effectivePl });
  }

  /**
   * Build the Barrier property picker (SRD: Barrier). When the chosen boon is
   * Barrier, the player selects N properties (N by power level) from the PL's
   * available pool. "Damaging" carries a PL-scaled die; "Baneful" needs a chosen
   * bane (PL ≤ barrier PL, invokable by the action's attribute). Mutates `context`
   * with showBarrier + the property choices + counts + the Baneful sub-picker.
   * @param {object} context
   * @param {object} sys
   * @param {{attrLabel: string, barrierPl: number}} args
   * @private
   */
  async _prepareBarrierOptions(context, sys, { attrLabel, barrierPl }) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    context.showBarrier = String(sys.boonName ?? "").trim().toLowerCase()
      === String(cfg.BARRIER_BOON_NAME ?? "Barrier").toLowerCase();
    if ( !context.showBarrier ) return;

    const pl = Math.max(0, Math.floor(Number(barrierPl) || 0));
    const maxCount = cfg.barrierPropertyCount ? cfg.barrierPropertyCount(pl) : 0;
    const pool = cfg.barrierPropertyPool ? cfg.barrierPropertyPool(pl) : [];
    const damageDie = cfg.barrierDamageDie ? cfg.barrierDamageDie(pl) : "";
    const chosen = new Set(String(sys.barrierProperties ?? "").split(",").map(s => s.trim()).filter(Boolean));

    const defs = Object.fromEntries((cfg.BARRIER_PROPERTIES ?? []).map(p => [p.key, p]));
    context.barrierPl = pl;
    context.barrierMaxCount = maxCount;
    context.barrierChosenCount = [...chosen].filter(k => pool.includes(k)).length;
    context.barrierDamageDie = damageDie;
    context.barrierProperties = pool.map(key => {
      const def = defs[key] ?? { key, label: key, description: "" };
      // The Damaging label carries the PL die, e.g. "Damaging (1d8)".
      const label = (key === "damaging") && damageDie ? `${def.label} (${damageDie})` : def.label;
      return { key, label, description: def.description, checked: chosen.has(key) };
    });

    // Baneful sub-picker: only when Baneful is among the chosen properties. Lists
    // banes the action's attribute can invoke at PL ≤ the barrier's PL.
    context.showBarrierBane = chosen.has("baneful");
    if ( context.showBarrierBane ) {
      const attrLower = String(attrLabel).toLowerCase();
      const options = [];
      const banePack = game.packs?.get("tomucatos-open-legend-rpg-system.banes");
      if ( banePack ) {
        for ( const bane of await banePack.getDocuments() ) {
          const attrs = (bane.system?.attacks ?? []).map(a => String(a.attackingAttribute ?? "").toLowerCase());
          if ( !attrs.includes(attrLower) ) continue;
          const bpl = Number(bane.system?.powerLevel ?? 0);
          if ( bpl > pl ) continue;
          const levels = [...new Set((bane.system?.powerEffects ?? [])
            .map(pe => Number(pe.powerLevel)).filter(n => Number.isFinite(n) && (n > 0)))].sort((a, b) => a - b);
          options.push({ uuid: bane.uuid, name: bane.name, powerLevel: bpl, levels: levels.length ? levels : [bpl] });
        }
      }
      options.sort((a, b) => (a.powerLevel - b.powerLevel) || a.name.localeCompare(b.name));
      context.barrierBaneOptions = options;
      context.barrierBaneAttributeLabel = attrLabel;
      context.barrierBaneSelectedValue = sys.barrierBaneUuid ?? "";
      const chosenBane = options.find(o => o.uuid === sys.barrierBaneUuid) ?? null;
      const usable = chosenBane ? chosenBane.levels.filter(l => l <= pl) : [];
      context.barrierBanePowerLevelOptions = Object.fromEntries(usable.map(l => [l, String(l)]));
      context.barrierBaneChosen = !!chosenBane;
    }
  }

  /**
   * Build the Aura radiated-invocation picker. The Aura boon "radiates" a single
   * bane OR boon that uses the SAME attribute the aura was invoked with, at a
   * maximum power level of one-half the aura's power level (SRD: Aura). Lists both
   * banes and boons for that attribute whose minimum PL ≤ that cap; mutates
   * `context` with showAura + the options + the selected value + PL options.
   * Only active when the chosen boon's name is "Aura".
   * @param {object} context
   * @param {object} sys
   * @param {{attrKey: string, attrLabel: string, auraPl: number}} args
   * @private
   */
  async _prepareAuraOptions(context, sys, { attrKey, attrLabel, auraPl }) {
    context.showAura = String(sys.boonName ?? "").trim().toLowerCase() === "aura";
    if ( !context.showAura ) return;

    // Half the aura's power level (rounded down), the cap on the radiated invocation.
    const maxPl = Math.floor(Math.max(0, Number(auraPl) || 0) / 2);
    context.auraMaxPl = maxPl;
    context.auraAttributeLabel = attrLabel;

    const options = await OpenLegendItemSheet.#auraRadiateOptions(
      new Set([String(attrLabel).toLowerCase()]), maxPl);
    context.auraOptions = options;
    context.auraSelectedValue = (sys.auraRadiateKind && sys.auraRadiateUuid)
      ? `${sys.auraRadiateKind}|${sys.auraRadiateUuid}` : "";

    // Radiated invocation power-level options: the chosen invocation's discrete
    // levels, filtered to those ≤ the aura's half-PL cap.
    const chosen = options.find(o => o.value === context.auraSelectedValue) ?? null;
    const usable = chosen ? chosen.levels.filter(pl => pl <= maxPl) : [];
    context.auraPowerLevelOptions = Object.fromEntries(usable.map(pl => [pl, String(pl)]));
    context.auraChosen = !!chosen;
    context.auraRadiateName = sys.auraRadiateName ?? "";

    // Resistance boon needs a damage type chosen at AURA-SETUP time (so it can be
    // forwarded to every entering ally without a per-ally dialog). Surface a type
    // picker when the radiated boon is Resistance.
    const cfg = CONFIG.OPENLEGEND ?? {};
    context.auraRadiateIsResistance = (sys.auraRadiateKind === "boon")
      && (String(sys.auraRadiateName).trim().toLowerCase()
          === String(cfg.RESISTANCE_BOON_NAME ?? "resistance").toLowerCase());
    const dmgLabels = cfg.allDamageTypes ? cfg.allDamageTypes() : (cfg.damageTypes ?? {});
    context.auraResistanceTypeOptions = Object.fromEntries(
      Object.entries(dmgLabels).sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    );
  }

  /**
   * The bane/boon invocations an Aura may radiate: system-pack banes (matched by
   * an attack entry's attacking attribute) and boons (matched by their invoking-
   * attribute list) invocable by ANY of the given lowercased attribute labels —
   * pass null to skip the attribute filter — whose minimum power level ≤ maxPl.
   * Each option carries kind/uuid/name/powerLevel (the minimum) /levels (the
   * discrete PLs) and a "kind|uuid" value; sorted banes-first, then by PL + name.
   * @param {Set<string>|null} attrLowers
   * @param {number} maxPl
   * @returns {Promise<Array<object>>}
   */
  static async #auraRadiateOptions(attrLowers, maxPl) {
    const options = [];
    const discreteLevels = doc => {
      const levels = [...new Set((doc.system?.powerEffects ?? [])
        .map(pe => Number(pe.powerLevel)).filter(n => Number.isFinite(n) && (n > 0)))].sort((a, b) => a - b);
      return levels;
    };
    const banePack = game.packs?.get("tomucatos-open-legend-rpg-system.banes");
    if ( banePack ) {
      for ( const bane of await banePack.getDocuments() ) {
        const attrs = (bane.system?.attacks ?? []).map(a => String(a.attackingAttribute ?? "").toLowerCase());
        if ( attrLowers && !attrs.some(a => attrLowers.has(a)) ) continue;
        const pl = Number(bane.system?.powerLevel ?? 0);
        if ( pl > maxPl ) continue;
        const levels = discreteLevels(bane);
        options.push({ kind: "bane", uuid: bane.uuid, name: bane.name, powerLevel: pl, levels: levels.length ? levels : [pl] });
      }
    }
    const boonPack = game.packs?.get("tomucatos-open-legend-rpg-system.boons");
    if ( boonPack ) {
      for ( const boon of await boonPack.getDocuments() ) {
        const attrs = (boon.system?.attributes ?? []).map(a => String(a).toLowerCase());
        if ( attrLowers && !attrs.some(a => attrLowers.has(a)) ) continue;
        // The aura itself is a boon; don't let it radiate itself.
        if ( String(boon.name).trim().toLowerCase() === "aura" ) continue;
        const pl = Number(boon.system?.powerLevel ?? 0);
        if ( pl > maxPl ) continue;
        const levels = discreteLevels(boon);
        options.push({ kind: "boon", uuid: boon.uuid, name: boon.name, powerLevel: pl, levels: levels.length ? levels : [pl] });
      }
    }
    options.sort((a, b) => (a.kind.localeCompare(b.kind)) || (a.powerLevel - b.powerLevel) || a.name.localeCompare(b.name));
    // The option value encodes "kind|uuid" so the pick handler knows both.
    for ( const o of options ) o.value = `${o.kind}|${o.uuid}`;
    return options;
  }

  /**
   * The Aura radiated-invocation picker context for an EXTRAORDINARY ITEM's Aura
   * boon row. Mirrors {@link OpenLegendItemSheet._prepareAuraOptions} on the
   * action sheet, but for a per-row grant: the radiated bane/boon must be
   * invocable by one of the Aura boon's OWN invoking attributes (any of them —
   * an item invocation has no fixed attribute), at a maximum power level of
   * HALF the row's aura power level (SRD: Aura). Returns the row-context fields
   * (isAura, auraMaxPl, auraNeedsPl, auraOptions, auraSelectedValue, auraChosen,
   * auraStale, auraPlOptions, auraRadiate* echoes).
   * @param {object} b     The stored extraordinaryBoons row.
   * @param {number} pl    The row's (sanitized) aura power level.
   * @returns {Promise<object>}
   */
  static async #xtraAuraRadiateContext(b, pl) {
    const out = { isAura: true };
    const maxPl = Math.floor(pl / 2);
    out.auraMaxPl = maxPl;
    // No aura PL picked yet (or PL 1 → cap 0): nothing can be radiated.
    out.auraNeedsPl = maxPl <= 0;
    if ( out.auraNeedsPl ) return out;

    // The radiated invocation must use one of the Aura boon's invoking attributes.
    const auraDoc = await OpenLegendItemSheet.#resolveInvocation("boon", b?.name);
    const attrs = new Set((auraDoc?.system?.attributes ?? []).map(a => String(a).toLowerCase()));
    out.auraOptions = await OpenLegendItemSheet.#auraRadiateOptions(attrs.size ? attrs : null, maxPl);

    out.auraSelectedValue = (b?.auraRadiateKind && b?.auraRadiateUuid)
      ? `${b.auraRadiateKind}|${b.auraRadiateUuid}` : "";
    const chosen = out.auraOptions.find(o => o.value === out.auraSelectedValue) ?? null;
    out.auraChosen = !!chosen;
    // A pick made before the aura's PL was lowered may now exceed the half-PL cap.
    out.auraStale = !!out.auraSelectedValue && !chosen;

    // Radiated power-level options: the chosen invocation's discrete levels ≤ cap.
    const usable = chosen ? chosen.levels.filter(l => l <= maxPl) : [];
    out.auraPlOptions = Object.fromEntries(usable.map(l => [l, String(l)]));
    const stored = Math.max(0, Math.floor(Number(b?.auraRadiatePowerLevel) || 0));
    out.auraRadiatePowerLevel = usable.includes(stored) ? stored : (usable[0] ?? 0);

    // Resistance boon: the damage type is chosen at aura-setup time (forwarded to
    // every entering ally without a per-ally dialog).
    const cfg = CONFIG.OPENLEGEND ?? {};
    out.auraRadiateIsResistance = out.auraChosen && (b?.auraRadiateKind === "boon")
      && (String(b?.auraRadiateName ?? "").trim().toLowerCase()
          === String(cfg.RESISTANCE_BOON_NAME ?? "resistance").toLowerCase());
    if ( out.auraRadiateIsResistance ) {
      const dmgLabels = cfg.allDamageTypes ? cfg.allDamageTypes() : (cfg.damageTypes ?? {});
      out.auraResistanceTypeOptions = Object.fromEntries(
        Object.entries(dmgLabels).sort((x, y) => String(x[1]).localeCompare(String(y[1]))));
      out.auraRadiateResistanceType = b?.auraRadiateResistanceType ?? "";
    }
    return out;
  }

  /**
   * Resolve the selected invocation option. An item invocation (invokeFromItemId
   * set) is matched by BOTH uuid and source item id, since the same bane/boon may
   * be listed by an attribute AND by an item. Otherwise the non-item option with
   * that uuid is taken.
   * @param {Array} options
   * @param {string} uuid
   * @param {string} fromItemId
   * @returns {object|undefined}
   */
  static #findChosenInvocation(options, uuid, fromItemId) {
    if ( !uuid ) return undefined;
    if ( fromItemId ) return options.find(o => (o.uuid === uuid) && (o.itemId === fromItemId));
    return options.find(o => (o.uuid === uuid) && !o.fromItem);
  }

  /**
   * Build invocation option entries for the banes/boons the actor's ACTIVE
   * extraordinary items grant. Each entry mirrors the attribute-built options
   * (uuid, name, powerLevel, levels, defense) plus item provenance: `fromItem`,
   * `itemId`, `itemName`, `itemScore` (the listed value = power-level + dice cap).
   * @param {Actor|null} actor
   * @param {"bane"|"boon"} type
   * @param {"extraordinaryBanes"|"extraordinaryBoons"} field
   * @param {string} [alwaysItemId]  An item id to include even when not "active"
   *        (e.g. an unequipped weapon/armor) — the action already references it via
   *        invokeFromItemId, so its option must exist for the picker to show it
   *        selected. Without this, a generated/saved item-invocation action on an
   *        unequipped source would render with no matching option (blank picker).
   * @returns {Promise<Array>}
   */
  static async #itemInvocationOptions(actor, type, field, alwaysItemId = "") {
    if ( !actor ) return [];
    const out = [];
    for ( const item of actor.items ) {
      // Active = extraordinary and (for weapon/armor) equipped; gear always. The
      // action's own referenced item is always included regardless of equip state.
      if ( !item.system?.extraordinary ) continue;
      const force = alwaysItemId && (item.id === alwaysItemId);
      if ( !force && ((item.type === "weapon") || (item.type === "armor")) && !item.system.equipped ) continue;
      for ( const row of (item.system[field] ?? []) ) {
        const name = row?.name;
        const itemScore = Math.max(0, Math.floor(Number(row?.powerLevel) || 0));
        if ( !name || (itemScore <= 0) ) continue;
        // Resolve through the SAME helper the action builders use
        // (resolveBaneByName/resolveBoonByName, which prefer the system pack) so a
        // generated action's stored baneUuid/boonUuid matches this option's uuid —
        // otherwise the composite select values diverge and the picker shows blank.
        const cfg = CONFIG.OPENLEGEND ?? {};
        const resolver = (type === "bane") ? cfg.resolveBaneByName : cfg.resolveBoonByName;
        const doc = resolver
          ? await resolver(name)
          : await OpenLegendItemSheet.#resolveInvocation(type, name);
        if ( !doc ) continue;
        const levels = [...new Set(
          (doc.system?.powerEffects ?? []).map(pe => Number(pe.powerLevel)).filter(n => Number.isFinite(n) && (n > 0))
        )].sort((a, b) => a - b);
        // Offerable levels: those the item's value reaches (≤ itemScore).
        const reachable = (levels.length ? levels : [Number(doc.system?.powerLevel) || itemScore])
          .filter(pl => pl <= itemScore);
        const entry = {
          uuid: doc.uuid, name: doc.name,
          powerLevel: reachable.length ? reachable[reachable.length - 1] : itemScore,
          levels: reachable.length ? reachable : [itemScore],
          fromItem: true, itemId: item.id, itemName: item.name, itemScore
        };
        if ( type === "bane" ) {
          const attacks = doc.system?.attacks ?? [];
          entry.defense = (attacks[0]?.defense ?? "guard").toLowerCase();
          // A bane invoked WITH an item that has the Extraordinary Potent property
          // is potent (target rolls resist at disadvantage 1) — preselect it.
          entry.potent = (item.system.extraordinaryProperties ?? []).some(p => p.name === "potent");
        }
        out.push(entry);
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || (a.itemScore - b.itemScore));
  }

  /**
   * Build boon invocation options from the actor's Boon Access feats. Each grants
   * one boon at PL-as-score: it's routed through the feat (fromItem/itemId =
   * featId, itemScore = the boon's power level) so the existing item-invocation
   * roll path supplies the dice + caps the level. Tagged `★Access` so it's
   * distinguishable from an attribute-based option for the same boon.
   * @param {Actor|null} actor
   * @returns {Promise<Array>}
   */
  static async #boonAccessOptions(actor) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    if ( !actor || !cfg.boonAccessGrants ) return [];
    const out = [];
    for ( const grant of cfg.boonAccessGrants(actor) ) {
      const boon = await fromUuid(grant.boonUuid);
      if ( !boon ) continue;
      const score = grant.powerLevel;
      const levels = [...new Set(
        (boon.system?.powerEffects ?? []).map(pe => Number(pe.powerLevel)).filter(n => Number.isFinite(n) && (n > 0))
      )].sort((a, b) => a - b);
      const reachable = (levels.length ? levels : [Number(boon.system?.powerLevel) || score]).filter(pl => pl <= score);
      out.push({
        uuid: boon.uuid, name: boon.name,
        powerLevel: reachable.length ? reachable[reachable.length - 1] : score,
        levels: reachable.length ? reachable : [score],
        fromItem: true, itemId: grant.featId, itemName: "Boon Access", itemScore: score,
        boonAccess: true, attribute: grant.attribute
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || (a.itemScore - b.itemScore));
  }

  /* -------------------------------------------- */

  /**
   * After render, wire change-listeners for editing weapon property values
   * (Defensive N) and details (Area "10' cone"). These edit a specific element
   * of the system.properties array, which the auto-submitting form can't map
   * cleanly, so they're handled explicitly.
   * @override
   */
  async _onRender(context, options) {
    await super._onRender(context, options);
    // Tag the sheet root with the item type (e.g. "bane"/"boon") so CSS can
    // target a specific item type without a per-type sheet subclass.
    if ( this.item?.type ) this.element?.classList.add(this.item.type);
    // A non-editable sheet (locked compendium, observer permission) reads as a
    // clean document: ol-locked restyles the auto-disabled fields as plain text
    // and hides mutation-only controls (see "Locked sheets" in openlegend.css).
    this.element?.classList.toggle("ol-locked", !this.isEditable);
    if ( !this.isEditable ) return;

    // Changing an extraordinary boon/bane's NAME resets that row's power level to
    // the new invocation's lowest valid level (its old level may be invalid for it).
    for ( const sel of this.element.querySelectorAll(
      "select[name^='system.extraordinaryBoons.'][name$='.name'], select[name^='system.extraordinaryBanes.'][name$='.name']" ) ) {
      sel.addEventListener("change", this.#onXtraInvocationNameChange.bind(this));
    }

    // Aura extraordinary-boon rows: the radiated bane/boon picker stores
    // kind+uuid+name and resets the radiated power level — side effects that
    // need a change listener, not the plain named-field submit.
    for ( const sel of this.element.querySelectorAll(".ol-xtra-aura-pick") ) {
      sel.addEventListener("change", this.#onXtraAuraPick.bind(this));
    }

    // Action: the bane/boon pickers store the chosen reference + reset the power
    // level (bane also auto-sets the target defense). These need a change listener
    // — not a plain submit — for the side effects.
    if ( this.item.type === "action" ) {
      const banePick = this.element.querySelector(".action-bane-pick");
      if ( banePick ) banePick.addEventListener("change", this.#onBanePick.bind(this));
      const boonPick = this.element.querySelector(".action-boon-pick");
      if ( boonPick ) boonPick.addEventListener("change", this.#onBoonPick.bind(this));
      // Aura: the radiated bane/boon picker stores kind+uuid+name and resets the
      // radiated power level (a side effect → needs a change listener, not submit).
      const auraPick = this.element.querySelector(".action-aura-pick");
      if ( auraPick ) auraPick.addEventListener("change", this.#onAuraPick.bind(this));
      // Barrier: property checkboxes (enforce the per-PL count) + the Baneful bane picker.
      for ( const cb of this.element.querySelectorAll(".action-barrier-prop") ) {
        cb.addEventListener("change", this.#onBarrierPropToggle.bind(this));
      }
      const barrierBane = this.element.querySelector(".action-barrier-bane");
      if ( barrierBane ) barrierBane.addEventListener("change", this.#onBarrierBanePick.bind(this));
      // Picking a weapon with the Area Extraordinary property forces the action
      // into that area (an area item "always makes multi-target area attacks").
      const weaponPick = this.element.querySelector("select[name='system.weaponId']");
      if ( weaponPick ) weaponPick.addEventListener("change", this.#onActionWeaponPick.bind(this));
      // On-roll macro: allow dragging a Macro from the directory onto the field
      // (or anywhere in the drop zone) to set system.macroUuid.
      const macroDrop = this.element.querySelector(".action-macro-drop");
      if ( macroDrop ) {
        macroDrop.addEventListener("dragover", ev => { ev.preventDefault(); macroDrop.classList.add("drag-over"); });
        macroDrop.addEventListener("dragleave", () => macroDrop.classList.remove("drag-over"));
        macroDrop.addEventListener("drop", this.#onMacroDrop.bind(this));
      }
      return;
    }

    if ( this.item.type !== "weapon" ) return;
    for ( const input of this.element.querySelectorAll("[data-prop-edit]") ) {
      input.addEventListener("change", this.#onWeaponPropertyEdit.bind(this));
    }
    // Add-property picker fires on change (a click action can't read the chosen value).
    const adder = this.element.querySelector(".weapon-add-property");
    if ( adder ) adder.addEventListener("change", this.#onWeaponAddProperty.bind(this));
  }

  /**
   * Store the chosen bane on a bane action: its uuid + name, reset the invocation
   * power level to the bane's minimum, and auto-set the action's target defense
   * to the defense that bane uses for the action's attribute. The chosen option's
   * data attributes carry the power level and defense.
   * @param {Event} event
   * @private
   */
  async #onBanePick(event) {
    const sel = event.currentTarget;
    const opt = sel.selectedOptions?.[0];
    // Item-granted options encode "uuid|itemId|itemScore" in their value so the
    // same bane listed by both an attribute and an item stays distinct.
    const { uuid, itemId, itemScore } = OpenLegendItemSheet.#parseInvocationValue(sel.value);
    const update = {
      "system.baneUuid": uuid,
      "system.baneName": opt?.dataset.name ?? opt?.textContent?.trim() ?? "",
      "system.invokeFromItemId": itemId,
      "system.invokeItemScore": itemScore
    };
    if ( uuid ) {
      // Item invocation invokes at the listed value (may be lowered after); an
      // attribute invocation starts at the bane's minimum power level.
      update["system.invokePowerLevel"] = itemId ? itemScore : Number(opt?.dataset.powerLevel ?? 0);
      const def = opt?.dataset.defense;
      if ( def ) update["system.targetDefense"] = def;
      // Preselect Potent when invoking with an item that has the Extraordinary
      // Potent property (the option carries data-potent), OR when the actor has the
      // Potent Bane feat for this bane (always potent); else default off.
      const baneName = opt?.dataset.name ?? "";
      const featPotent = CONFIG.OPENLEGEND?.isPotentBane?.(this.item.actor, baneName) ?? false;
      update["system.potent"] = (opt?.dataset.potent === "1") || featPotent;
      // Bane derived from an extraordinary item: sync the weapon link to it. When
      // that item is a WEAPON, pre-link it so the weapon selectbox follows the pick
      // (and, if it's an Area weapon, force the action into that area — an area
      // weapon always makes multi-target area attacks, mirroring #onActionWeaponPick).
      // When it's a non-weapon item (gear/armor), clear any stale weapon link. An
      // attribute-invoked bane (no itemId) leaves the weapon alone so manual
      // weapon-bane synergy is preserved.
      const sourceItem = itemId ? this.item.actor?.items.get(itemId) : null;
      if ( sourceItem?.type === "weapon" ) {
        update["system.weaponId"] = itemId;
        const area = OpenLegendItemSheet.#weaponArea(sourceItem);
        if ( area ) {
          update["system.targets"] = "area";
          update["system.area.shape"] = area.shape;
          update["system.area.length"] = area.length;
          update["system.area.lines"] = area.lines;
        }
      } else if ( itemId ) {
        update["system.weaponId"] = "";
      }
    } else {
      update["system.invokePowerLevel"] = 0;
      update["system.potent"] = false;
    }
    await this.item.update(update);
  }

  /**
   * Accept a Macro dropped onto the action sheet's macro field: read the drag
   * payload, resolve it to a Macro, and store its uuid in system.macroUuid.
   * @param {DragEvent} event
   * @private
   */
  async #onMacroDrop(event) {
    event.preventDefault();
    this.element.querySelector(".action-macro-drop")?.classList.remove("drag-over");
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); }
    catch { return; }
    if ( data?.type !== "Macro" ) {
      ui.notifications?.warn("Drop a macro here (from the Macros directory).");
      return;
    }
    // Drags carry either a uuid (modern) or a pack/id pair (legacy).
    const uuid = data.uuid ?? (data.id ? `Macro.${data.id}` : "");
    const macro = uuid ? await fromUuid(uuid).catch(() => null) : null;
    if ( !macro ) {
      ui.notifications?.warn("Could not resolve that macro.");
      return;
    }
    await this.item.update({ "system.macroUuid": macro.uuid });
  }

  /**
   * Clear the action's on-roll macro (the field's ✕ button).
   * @this {OpenLegendItemSheet}
   * @private
   */
  static async #onClearMacro() {
    await this.item.update({ "system.macroUuid": "" });
  }

  /** Parse an invocation select value: a bare uuid (attribute option) or the
   *  composite "uuid|itemId|itemScore" (item option). */
  static #parseInvocationValue(value) {
    const v = String(value ?? "");
    if ( !v ) return { uuid: "", itemId: "", itemScore: 0 };
    const [uuid, itemId = "", score = "0"] = v.split("|");
    return { uuid, itemId, itemScore: Math.max(0, Math.floor(Number(score) || 0)) };
  }

  /** The select value for an invocation: a bare uuid for an attribute option, or
   *  the composite "uuid|itemId|itemScore" for an item-granted one. */
  static #invocationValue(uuid, itemId, itemScore) {
    if ( !uuid ) return "";
    return itemId ? `${uuid}|${itemId}|${Math.max(0, Math.floor(Number(itemScore) || 0))}` : uuid;
  }

  /** Stamp each option's select `value` (item options get the composite form). */
  static #tagInvocationValues(options) {
    for ( const o of options ) {
      o.value = o.fromItem ? OpenLegendItemSheet.#invocationValue(o.uuid, o.itemId, o.itemScore) : o.uuid;
    }
  }

  /**
   * Store the chosen boon on a boon action: its uuid + name. Boons have no target
   * defense (they're invoked against a Challenge Rating, not an opposed roll), so
   * unlike {@link #onBanePick} this sets no defense. No power level is asked of
   * the player either — the roll invokes the boon at the highest defined level it
   * clears (see resolveBoonTargets). invokePowerLevel is still recorded as the
   * EFFECTIVE ceiling (highest defined level the score reaches; item invocation:
   * the listed value) so the Aura/Barrier edit-time sub-pickers and the sheet's
   * PL/CR summary have a level to show. The option carries the boon's minimum
   * level (data-power-level) and its defined levels (data-levels, CSV).
   * @param {Event} event
   * @private
   */
  async #onBoonPick(event) {
    const sel = event.currentTarget;
    const opt = sel.selectedOptions?.[0];
    const { uuid, itemId, itemScore } = OpenLegendItemSheet.#parseInvocationValue(sel.value);
    const update = {
      "system.boonUuid": uuid,
      "system.boonName": opt?.dataset.name ?? opt?.textContent?.trim() ?? "",
      "system.invokeFromItemId": itemId,
      "system.invokeItemScore": itemScore
    };
    let invokePl = 0;
    if ( uuid ) {
      if ( itemId ) invokePl = itemScore;
      else {
        const levels = String(opt?.dataset.levels ?? "").split(",")
          .map(n => Math.floor(Number(n)))
          .filter(n => Number.isFinite(n) && (n > 0));
        const actor = this.item.actor;
        const score = actor ? Number(actor.system?.attributes?.[this.item.system?.attribute]?.value ?? 0) : null;
        const reachable = (score === null) ? levels : levels.filter(l => l <= score);
        invokePl = reachable.length ? Math.max(...reachable) : Number(opt?.dataset.powerLevel ?? 0);
      }
    }
    update["system.invokePowerLevel"] = invokePl;
    // A Boon Access option carries the attribute chosen for the feat — set the
    // action's invoking attribute to it (the roll still uses PL-as-score dice via
    // the item-invocation path, but the attribute type drives attr-scoped effects).
    const attribute = opt?.dataset.attribute;
    if ( attribute ) update["system.attribute"] = attribute;
    // Switching the boon clears any previously-chosen Aura radiated invocation
    // (it only applies while the boon is Aura).
    if ( String(update["system.boonName"]).trim().toLowerCase() !== "aura" ) {
      update["system.auraRadiateUuid"] = "";
      update["system.auraRadiateName"] = "";
      update["system.auraRadiateKind"] = "";
      update["system.auraRadiatePowerLevel"] = 0;
    }
    // Switching away from Barrier clears its chosen properties + Baneful bane.
    if ( String(update["system.boonName"]).trim().toLowerCase() !== String(CONFIG.OPENLEGEND?.BARRIER_BOON_NAME ?? "barrier").toLowerCase() ) {
      update["system.barrierProperties"] = "";
      update["system.barrierBaneUuid"] = "";
      update["system.barrierBaneName"] = "";
      update["system.barrierBanePowerLevel"] = 0;
    }
    await this.item.update(update);
  }

  /**
   * Store the Aura's radiated bane/boon: the option value encodes "kind|uuid"
   * (the picker lists both banes and boons for the aura's attribute), and the
   * option carries the name + minimum power level. Resets the radiated power
   * level to that minimum (clamped to half the aura's PL by the option list).
   * @param {Event} event
   * @private
   */
  async #onAuraPick(event) {
    const sel = event.currentTarget;
    const opt = sel.selectedOptions?.[0];
    const [kind = "", uuid = ""] = String(sel.value || "").split("|");
    const name = uuid ? (opt?.dataset.name ?? opt?.textContent?.trim() ?? "") : "";
    const update = {
      "system.auraRadiateKind": uuid ? kind : "",
      "system.auraRadiateUuid": uuid,
      "system.auraRadiateName": name,
      "system.auraRadiatePowerLevel": uuid ? Number(opt?.dataset.powerLevel ?? 0) : 0
    };
    // The Resistance damage type only applies while the radiated boon IS Resistance;
    // clear it whenever the selection changes to anything else.
    const isResistance = (kind === "boon") && (String(name).trim().toLowerCase()
      === String(CONFIG.OPENLEGEND?.RESISTANCE_BOON_NAME ?? "resistance").toLowerCase());
    if ( !isResistance ) update["system.auraRadiateResistanceType"] = "";
    await this.item.update(update);
  }

  /**
   * The highest defined power level this action's boon invocation can reach —
   * its effective ceiling, now that no level is chosen up front. Item invocation
   * caps by the item's listed value; attribute invocation caps by the owning
   * actor's LIVE score in the action's attribute (so a score raised or lowered
   * after the boon was picked is honoured). Falls back to the stored
   * invokePowerLevel when the boon document can't be resolved.
   * @returns {Promise<number>}
   * @private
   */
  async #effectiveInvokePl() {
    const sys = this.item.system ?? {};
    if ( sys.invokeFromItemId ) return Math.max(0, Math.floor(Number(sys.invokeItemScore) || 0));
    const fallback = Math.max(0, Math.floor(Number(sys.invokePowerLevel) || 0));
    const doc = sys.boonUuid ? await fromUuid(sys.boonUuid).catch(() => null) : null;
    if ( !doc ) return fallback;
    const actor = this.item.actor;
    const score = actor ? Number(actor.system?.attributes?.[sys.attribute]?.value ?? 0) : null;
    const levels = [...new Set((doc.system?.powerEffects ?? [])
      .map(pe => Math.floor(Number(pe.powerLevel)))
      .filter(n => Number.isFinite(n) && (n > 0)))];
    const reachable = (score === null) ? levels : levels.filter(l => l <= score);
    return reachable.length ? Math.max(...reachable) : fallback;
  }

  /**
   * Toggle a Barrier property checkbox. Reads all checked `.action-barrier-prop`,
   * caps the selection to the power level's allowed count (ignoring the just-checked
   * box if it would exceed), and writes `system.barrierProperties` as a CSV. Clears
   * the Baneful sub-pick when Baneful is unchecked.
   * @param {Event} event
   * @private
   */
  async #onBarrierPropToggle(event) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    const just = event.currentTarget;
    const boxes = [...this.element.querySelectorAll(".action-barrier-prop")];
    const pl = await this.#effectiveInvokePl();
    const maxCount = cfg.barrierPropertyCount ? cfg.barrierPropertyCount(pl) : 0;
    let chosen = boxes.filter(b => b.checked).map(b => b.dataset.key);
    // Over the limit → drop the box just checked (and uncheck it visually).
    if ( chosen.length > maxCount ) {
      chosen = chosen.filter(k => k !== just.dataset.key);
      just.checked = false;
    }
    const update = { "system.barrierProperties": chosen.join(",") };
    if ( !chosen.includes("baneful") ) {
      update["system.barrierBaneUuid"] = "";
      update["system.barrierBaneName"] = "";
      update["system.barrierBanePowerLevel"] = 0;
    }
    await this.item.update(update);
  }

  /**
   * Store the Baneful property's chosen bane (uuid + name) and reset its power level
   * to the bane's minimum. The option value is the bane uuid.
   * @param {Event} event
   * @private
   */
  async #onBarrierBanePick(event) {
    const sel = event.currentTarget;
    const opt = sel.selectedOptions?.[0];
    const uuid = sel.value || "";
    await this.item.update({
      "system.barrierBaneUuid": uuid,
      "system.barrierBaneName": uuid ? (opt?.dataset.name ?? opt?.textContent?.trim() ?? "") : "",
      "system.barrierBanePowerLevel": uuid ? Number(opt?.dataset.powerLevel ?? 0) : 0
    });
  }

  /**
   * Update one property's value/detail in system.properties.
   * @param {Event} event
   * @private
   */
  async #onWeaponPropertyEdit(event) {
    const el = event.currentTarget;
    const key = el.dataset.propEdit;          // property key
    const field = el.dataset.propField;       // "value" | "detail"
    const props = foundry.utils.deepClone(this.item.system.properties ?? []);
    const prop = props.find(p => p.key === key);
    if ( !prop ) return;
    prop[field] = field === "value" ? Number(el.value) : el.value;
    await this.item.update({ "system.properties": props });
  }

  /**
   * Toggle a weapon category on/off and re-derive the range increment.
   * @this {OpenLegendItemSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  Carries data-category.
   */
  static async #onWeaponToggleCategory(event, target) {
    event.preventDefault();
    const key = target.dataset.category;
    const cur = new Set(this.item.system.categories ?? []);
    if ( cur.has(key) ) cur.delete(key); else cur.add(key);
    const categories = [...cur];
    await this.item.update({
      "system.categories": categories,
      "system.rangeIncrement": CONFIG.OPENLEGEND.rangeIncrementFor(categories)
    });
  }

  /**
   * Add a property (from the picker <select>) to the weapon. Valued/parameterized
   * properties start with a sensible default the user can then edit.
   * @param {Event} event  change event from the add-property select.
   * @private
   */
  async #onWeaponAddProperty(event) {
    event.preventDefault();
    const key = event.currentTarget.value;
    if ( !key ) return;
    const def = (CONFIG.OPENLEGEND.weaponProperties ?? {})[key];
    if ( !def ) return;
    const props = foundry.utils.deepClone(this.item.system.properties ?? []);
    if ( props.some(p => p.key === key) ) return; // no duplicates
    const entry = { key };
    if ( def.valued ) entry.value = 1;
    if ( def.parameterized ) entry.detail = "";
    props.push(entry);
    await this.item.update({ "system.properties": props });
  }

  /**
   * Remove a property from the weapon.
   * @this {OpenLegendItemSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  Carries data-property.
   */
  static async #onWeaponRemoveProperty(event, target) {
    event.preventDefault();
    const key = target.dataset.property;
    const props = (this.item.system.properties ?? []).filter(p => p.key !== key);
    await this.item.update({ "system.properties": props });
  }

  /* -------------------------------------------- */

  /**
   * Step a numeric system field up or down by a fixed amount. Used by the +/−
   * stepper buttons (e.g. Area Length, which has no visible native spinner).
   * The button carries data-field (the system path, e.g. "system.area.length"),
   * data-step (signed amount), and optional data-min / data-max bounds.
   * @this {OpenLegendItemSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onStepField(event, target) {
    event.preventDefault();
    const field = target.dataset.field;
    if ( !field ) return;
    const step = Number(target.dataset.step ?? 0);
    const current = Number(foundry.utils.getProperty(this.item, field) ?? 0);
    let next = current + step;
    if ( target.dataset.min !== undefined ) next = Math.max(Number(target.dataset.min), next);
    if ( target.dataset.max !== undefined ) next = Math.min(Number(target.dataset.max), next);
    if ( next === current ) return;
    await this.item.update({ [field]: next });
  }

  /* -------------------------------------------- */

  /**
   * Resolve the embedded Active Effect a clicked control belongs to.
   * @param {HTMLElement} target  An element inside a [data-effect-id] row.
   * @returns {ActiveEffect|undefined}
   * @private
   */
  #effectFor(target) {
    return this.item.effects.get(target.closest("[data-effect-id]")?.dataset.effectId);
  }

  /**
   * Add a new Active Effect to the item (Effects tab) and open its config.
   *
   * - bane/boon: transfer:false — these effects are CLONED onto a token at drop
   *   time (see leveledEffectData), never auto-transferred from the item copy.
   * - physical (weapon/armor/gear): transfer:true — they apply to the OWNING
   *   actor. For weapon/armor the application is gated on the equipped state in
   *   the actor's allApplicableEffects() override; gear applies whenever owned.
   * - feat/perk/flaw: transfer:true — passive traits; their effects apply to
   *   the owning actor for as long as the item is owned.
   * - effect: transfer:false — a standalone effect carrier; its effects are
   *   CLONED onto the token/actor it is dropped on (applyEffectItemToActor).
   * @this {OpenLegendItemSheet}
   * @param {PointerEvent} event
   */
  static async #onEffectCreate(event) {
    event.preventDefault();
    const transfer = OpenLegendItemSheet.#isPhysical(this.item.type)
      || ["feat", "perk", "flaw"].includes(this.item.type);
    const [created] = await this.item.createEmbeddedDocuments("ActiveEffect", [{
      name: this.item.name,
      type: "base",
      img: this.item.img,
      disabled: false,
      transfer,
      flags: { openlegend: { changeLevels: [] } }
    }]);
    created?.sheet?.render(true);
  }

  /**
   * Open an embedded effect's config sheet (read-only on locked compendia).
   * @this {OpenLegendItemSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onEffectEdit(event, target) {
    event.preventDefault();
    this.#effectFor(target)?.sheet?.render(true);
  }

  /**
   * Enable/disable an embedded effect. Disabled effects are skipped when the
   * bane/boon is dropped on a token.
   * @this {OpenLegendItemSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onEffectToggle(event, target) {
    event.preventDefault();
    const effect = this.#effectFor(target);
    if ( effect ) await effect.update({ disabled: !effect.disabled });
  }

  /**
   * Delete an embedded effect.
   * @this {OpenLegendItemSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onEffectDelete(event, target) {
    event.preventDefault();
    await this.#effectFor(target)?.delete();
  }

  /* -------------------------------------------- */

  /**
   * Append a blank attack row to a bane (Details tab). The named selects in the
   * row save themselves via submitOnChange once the row exists.
   * @this {OpenLegendItemSheet}
   * @param {PointerEvent} event
   */
  static async #onAttackAdd(event) {
    event.preventDefault();
    const attacks = OpenLegendItemSheet.#toArray(this.item.system.attacks);
    attacks.push({ attackingAttribute: "", defense: "" });
    await this.#replaceArray("system.attacks", attacks);
  }

  /**
   * Remove an attack row by its index (data-index on the row).
   * @this {OpenLegendItemSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onAttackDelete(event, target) {
    event.preventDefault();
    const i = Number(target.closest("[data-index]")?.dataset.index);
    const attacks = OpenLegendItemSheet.#toArray(this.item.system.attacks).filter((_, idx) => idx !== i);
    await this.#replaceArray("system.attacks", attacks);
  }

  /**
   * Append a blank invoking-attribute row to a boon (Details tab).
   * @this {OpenLegendItemSheet}
   * @param {PointerEvent} event
   */
  static async #onAttributeAdd(event) {
    event.preventDefault();
    const attrs = OpenLegendItemSheet.#toArray(this.item.system.attributes);
    attrs.push("");
    await this.#replaceArray("system.attributes", attrs);
  }

  /**
   * Remove an invoking-attribute row by its index.
   * @this {OpenLegendItemSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onAttributeDelete(event, target) {
    event.preventDefault();
    const i = Number(target.closest("[data-index]")?.dataset.index);
    const attrs = OpenLegendItemSheet.#toArray(this.item.system.attributes).filter((_, idx) => idx !== i);
    await this.#replaceArray("system.attributes", attrs);
  }

  /**
   * Append a blank power-level effect row (Power Effects tab), defaulting its
   * level to the item's minimum power level.
   * @this {OpenLegendItemSheet}
   * @param {PointerEvent} event
   */
  static async #onPowerEffectAdd(event) {
    event.preventDefault();
    const rows = OpenLegendItemSheet.#toArray(this.item.system.powerEffects);
    rows.push({ powerLevel: Number(this.item.system.powerLevel) || 0, effect: "" });
    await this.#replaceArray("system.powerEffects", rows);
  }

  /**
   * Remove a power-level effect row by its index.
   * @this {OpenLegendItemSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onPowerEffectDelete(event, target) {
    event.preventDefault();
    const i = Number(target.closest("[data-index]")?.dataset.index);
    const rows = OpenLegendItemSheet.#toArray(this.item.system.powerEffects).filter((_, idx) => idx !== i);
    await this.#replaceArray("system.powerEffects", rows);
  }

  /* ---- Extraordinary Item rows ---------------------------------------- */

  /**
   * The ± stepper beside an extraordinary Area size: bump the (named) size input by
   * the button's signed step (5 ft for cone/cube, 1 line for a line), then dispatch
   * a change so the normal submitOnChange path persists it — _prepareSubmitData
   * combines shape+size and snaps the value. Mirrors the action dialog's stepper.
   * @this {OpenLegendItemSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  Carries data-step; sits in an [data-index] row.
   */
  static async #onXtraAreaStep(event, target) {
    event.preventDefault();
    const row = target.closest("[data-index]");
    const input = row?.querySelector(".ol-xtra-area-size");
    if ( !input ) return;
    const step = Number(target.dataset.step ?? 0);
    const min = Number(input.getAttribute("min")) || step || 1;
    const next = Math.max(min, (Number(input.value) || 0) + step);
    input.value = String(next);
    // Drive the normal named-field submit (no separate write → no race).
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /**
   * Toggle this item's Persistent turn-start auto-apply (flags.openlegend.persistentAuto,
   * default ON). When off, the turn-start automation skips this item.
   * @this {OpenLegendItemSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onXtraPersistentToggle(event, target) {
    event.preventDefault();
    const on = this.item.flags?.openlegend?.persistentAuto !== false;
    await this.item.update({ "flags.openlegend.persistentAuto": !on });
  }

  /**
   * When an extraordinary boon/bane row's NAME changes, RESET its power level to
   * unset (0 → "—"): the previous level may not be one the new boon/bane defines,
   * and the user must explicitly pick a valid level before it can be invoked.
   * The select's name encodes the array + index.
   * @this {OpenLegendItemSheet}
   * @param {Event} event
   */
  async #onXtraInvocationNameChange(event) {
    const sel = event.currentTarget;
    const m = /^system\.(extraordinaryBoons|extraordinaryBanes)\.(\d+)\.name$/.exec(sel.name ?? "");
    if ( !m ) return;
    const field = m[1];
    const i = Number(m[2]);
    const rows = OpenLegendItemSheet.#toArray(this.item.system[field]);
    if ( !rows[i] ) return;
    // Drop any Aura radiated-invocation pick with the old name: it only applies
    // while the row IS Aura, and even a re-pick of Aura starts over (the PL reset
    // changes the radiate cap).
    const { auraRadiateKind, auraRadiateUuid, auraRadiateName, auraRadiatePowerLevel,
      auraRadiateResistanceType, ...rest } = rows[i];
    rows[i] = { ...rest, name: sel.value, powerLevel: 0 };
    await this.#replaceArray(`system.${field}`, rows);
  }

  /**
   * Store an extraordinary Aura boon row's radiated bane/boon: the option value
   * encodes "kind|uuid" (the picker lists both banes and boons the Aura's
   * attributes can invoke), and the option carries the name + minimum power
   * level. Resets the radiated power level to that minimum (already clamped to
   * half the aura's PL by the option list). Mirrors the action sheet's
   * {@link OpenLegendItemSheet.#onAuraPick} for a per-row grant.
   * @this {OpenLegendItemSheet}
   * @param {Event} event
   */
  async #onXtraAuraPick(event) {
    const sel = event.currentTarget;
    const i = Number(sel.closest("[data-index]")?.dataset.index);
    const rows = OpenLegendItemSheet.#toArray(this.item.system.extraordinaryBoons);
    if ( !rows[i] ) return;
    const opt = sel.selectedOptions?.[0];
    const [kind = "", uuid = ""] = String(sel.value || "").split("|");
    const name = uuid ? (opt?.dataset.name ?? opt?.textContent?.trim() ?? "") : "";
    const row = { ...rows[i],
      auraRadiateKind: uuid ? kind : "",
      auraRadiateUuid: uuid,
      auraRadiateName: name,
      auraRadiatePowerLevel: uuid ? Number(opt?.dataset.powerLevel ?? 0) : 0
    };
    // The Resistance damage type only applies while the radiated boon IS Resistance.
    const isResistance = (kind === "boon") && (String(name).trim().toLowerCase()
      === String(CONFIG.OPENLEGEND?.RESISTANCE_BOON_NAME ?? "resistance").toLowerCase());
    if ( !isResistance ) row.auraRadiateResistanceType = "";
    rows[i] = row;
    await this.#replaceArray("system.extraordinaryBoons", rows);
  }

  /**
   * When an action's weapon is set to one with an Area property (built-in OR
   * Extraordinary), force the action into that area (shape + size) — an area
   * weapon always makes multi-target area attacks. Other weapons leave the
   * action's targeting alone.
   * @this {OpenLegendItemSheet}
   * @param {Event} event
   */
  async #onActionWeaponPick(event) {
    const id = event.currentTarget.value;
    const weapon = id ? this.item.actor?.items.get(id) : null;
    const area = OpenLegendItemSheet.#weaponArea(weapon);
    if ( !area ) return;
    await this.item.update({
      "system.weaponId": id,
      "system.targets": "area",
      "system.area.shape": area.shape,
      "system.area.length": area.length,
      "system.area.lines": area.lines
    });
  }

  /** The area definition a weapon grants from EITHER its built-in Area weapon
   *  property OR its Area Extraordinary property, or null. Mirrors weaponHasArea()
   *  in action-roll.mjs (both delegate to OPENLEGEND.weaponAreaDefinition). */
  static #weaponArea(weapon) {
    return CONFIG.OPENLEGEND?.weaponAreaDefinition?.(weapon) ?? null;
  }

  /** Append a blank granted-attribute row (key + score) to an extraordinary item. */
  static async #onXtraAttributeAdd(event) {
    event.preventDefault();
    const rows = OpenLegendItemSheet.#toArray(this.item.system.extraordinaryAttributes);
    rows.push({ key: "", score: 0 });
    await this.#replaceArray("system.extraordinaryAttributes", rows);
  }

  /** Remove a granted-attribute row by index. */
  static async #onXtraAttributeDelete(event, target) {
    event.preventDefault();
    const i = Number(target.closest("[data-index]")?.dataset.index);
    const rows = OpenLegendItemSheet.#toArray(this.item.system.extraordinaryAttributes).filter((_, idx) => idx !== i);
    await this.#replaceArray("system.extraordinaryAttributes", rows);
  }

  /** Append a blank boon row (name + power level). */
  static async #onXtraBoonAdd(event) {
    event.preventDefault();
    const rows = OpenLegendItemSheet.#toArray(this.item.system.extraordinaryBoons);
    rows.push({ name: "", powerLevel: 0 });
    await this.#replaceArray("system.extraordinaryBoons", rows);
  }

  /** Remove a boon row by index. */
  static async #onXtraBoonDelete(event, target) {
    event.preventDefault();
    const i = Number(target.closest("[data-index]")?.dataset.index);
    const rows = OpenLegendItemSheet.#toArray(this.item.system.extraordinaryBoons).filter((_, idx) => idx !== i);
    await this.#replaceArray("system.extraordinaryBoons", rows);
  }

  /** Append a blank bane row (name + power level). */
  static async #onXtraBaneAdd(event) {
    event.preventDefault();
    const rows = OpenLegendItemSheet.#toArray(this.item.system.extraordinaryBanes);
    rows.push({ name: "", powerLevel: 0 });
    await this.#replaceArray("system.extraordinaryBanes", rows);
  }

  /** Remove a bane row by index. */
  static async #onXtraBaneDelete(event, target) {
    event.preventDefault();
    const i = Number(target.closest("[data-index]")?.dataset.index);
    const rows = OpenLegendItemSheet.#toArray(this.item.system.extraordinaryBanes).filter((_, idx) => idx !== i);
    await this.#replaceArray("system.extraordinaryBanes", rows);
  }

  /** Append a blank property row (name + value). */
  static async #onXtraPropertyAdd(event) {
    event.preventDefault();
    const rows = OpenLegendItemSheet.#toArray(this.item.system.extraordinaryProperties);
    rows.push({ name: "", value: "" });
    await this.#replaceArray("system.extraordinaryProperties", rows);
  }

  /** Remove a property row by index. */
  static async #onXtraPropertyDelete(event, target) {
    event.preventDefault();
    const i = Number(target.closest("[data-index]")?.dataset.index);
    const rows = OpenLegendItemSheet.#toArray(this.item.system.extraordinaryProperties).filter((_, idx) => idx !== i);
    await this.#replaceArray("system.extraordinaryProperties", rows);
  }

  /** Append a blank legendary-property row (name + value). */
  static async #onXtraLegendaryAdd(event) {
    event.preventDefault();
    const rows = OpenLegendItemSheet.#toArray(this.item.system.legendaryProperties);
    rows.push({ name: "", value: "" });
    await this.#replaceArray("system.legendaryProperties", rows);
  }

  /** Remove a legendary-property row by index. */
  static async #onXtraLegendaryDelete(event, target) {
    event.preventDefault();
    const i = Number(target.closest("[data-index]")?.dataset.index);
    const rows = OpenLegendItemSheet.#toArray(this.item.system.legendaryProperties).filter((_, idx) => idx !== i);
    await this.#replaceArray("system.legendaryProperties", rows);
  }

  /**
   * Resolve a boon/bane document by name from the system compendium packs (or
   * the world items, as a fallback). Returns the first match, or null.
   * @param {"boon"|"bane"} type
   * @param {string} name
   * @returns {Promise<Item|null>}
   */
  static async #resolveInvocation(type, name) {
    if ( !name ) return null;
    // World items first (a GM may have a customized copy), then compendiums.
    const local = game.items?.find(i => (i.type === type) && (i.name === name));
    if ( local ) return local;
    for ( const pack of game.packs ?? [] ) {
      if ( pack.documentName !== "Item" ) continue;
      const index = await pack.getIndex();
      const entry = index.find(e => (e.name === name) && (e.type === type));
      if ( entry ) return pack.getDocument(entry._id);
    }
    return null;
  }

  /**
   * The {level: "level"} option map of power levels a named boon/bane actually
   * defines — its distinct power-effect thresholds (e.g. Fear → {5}; Persistent
   * Damage → {2,4,6,8,9}; Invisible → {5,6}), falling back to its minimum power
   * level, then to the full 1-9 range when the doc can't be resolved. The current
   * value is always kept so a stored level is never silently dropped.
   * @param {"boon"|"bane"} type
   * @param {string} name
   * @param {number} current  The row's stored power level.
   * @returns {Promise<Record<number,string>>}
   */
  static async #invocationLevelOptions(type, name, current) {
    // Offer ONLY the power levels the chosen boon/bane actually defines — its
    // distinct power-effect thresholds (e.g. Fear → {5}; Persistent Damage →
    // {2,4,6,8,9}; Invisible → {5,6}). The row defaults to "—" (value 0, unset)
    // until the user picks one. When no boon/bane is chosen yet — or the doc can't
    // be resolved — there is nothing to offer but the "—".
    const doc = name ? await OpenLegendItemSheet.#resolveInvocation(type, name) : null;
    let levels = [...new Set(
      (doc?.system?.powerEffects ?? [])
        .map(pe => Number(pe?.powerLevel))
        .filter(n => Number.isFinite(n) && (n > 0))
    )].sort((a, b) => a - b);
    // Fall back to the doc's minimum power level when it defines no discrete
    // power-effect thresholds (some boons/banes are single-level).
    if ( !levels.length ) {
      const min = Math.max(0, Math.floor(Number(doc?.system?.powerLevel) || 0));
      if ( min > 0 ) levels = [min];
    }
    // Never silently drop a stored value that's outside the offered set.
    const cur = Math.max(0, Math.floor(Number(current) || 0));
    if ( (cur > 0) && !levels.includes(cur) ) levels = [...levels, cur].sort((a, b) => a - b);
    // Leading "—" (value 0) so a row starts with no value chosen.
    return { 0: "—", ...Object.fromEntries(levels.map(l => [l, String(l)])) };
  }

  /**
   * Generate a Boon ACTION on the owning actor from one of the item's granted
   * boons at its chosen power level. The action is an item invocation (the item's
   * value supplies the dice + caps the invoke level); when the source item is a
   * WEAPON it is pre-linked so the action's weapon picker shows it selected. Opens
   * the created action's sheet. Requires the item to be owned by an actor.
   * @this {OpenLegendItemSheet}
   */
  static async #onXtraGenerateBoon(event, target) {
    event.preventDefault();
    const i = Number(target.closest("[data-index]")?.dataset.index);
    const row = OpenLegendItemSheet.#toArray(this.item.system.extraordinaryBoons)[i];
    await OpenLegendItemSheet.#generateXtraAction.call(this, "boon", row);
  }

  /**
   * Generate a Bane ACTION on the owning actor from one of the item's granted
   * banes. Mirrors {@link OpenLegendItemSheet.#onXtraGenerateBoon}.
   * @this {OpenLegendItemSheet}
   */
  static async #onXtraGenerateBane(event, target) {
    event.preventDefault();
    const i = Number(target.closest("[data-index]")?.dataset.index);
    const row = OpenLegendItemSheet.#toArray(this.item.system.extraordinaryBanes)[i];
    await OpenLegendItemSheet.#generateXtraAction.call(this, "bane", row);
  }

  /**
   * Shared worker for the boon/bane "Generate Action" buttons: validate the row,
   * build the item-invocation action via the CONFIG builder (weapon source gets
   * pre-linked), create it on the owning actor, and open its sheet.
   * @this {OpenLegendItemSheet}
   * @param {"boon"|"bane"} kind
   * @param {{name?: string, powerLevel?: number}} row
   * @returns {Promise<void>}
   */
  static async #generateXtraAction(kind, row) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    const actor = this.item.actor;
    if ( !actor ) { ui.notifications?.warn("Add this item to an actor to generate an action from it."); return; }
    if ( !row?.name ) { ui.notifications?.warn(`Select a ${kind} first.`); return; }
    if ( !(Number(row.powerLevel) > 0) ) { ui.notifications?.warn(`Select a power level for ${row.name} first.`); return; }

    // Resolve the item's Area first (prompts when it lists several) and pass it to
    // the builder so a multi-area item asks once, here, rather than inside the build.
    const area = await cfg.pickItemArea?.(this.item);
    const build = kind === "boon" ? cfg.buildExtraordinaryBoonAction : cfg.buildExtraordinaryBaneAction;
    const data = await build?.(this.item, actor, { ...row, area });
    if ( !data ) { ui.notifications?.warn(`Could not build an action for ${row.name}.`); return; }

    const [created] = await actor.createEmbeddedDocuments("Item", [data]);
    ui.notifications?.info(`Created action “${data.name}”.`);
    await created?.sheet?.render({ force: true });
  }

  /**
   * Replace an array-valued system field cleanly. If a prior submitOnChange
   * turned the array into a {"0":…} object, a plain update would MERGE the new
   * (shorter) array onto the stale object and leave orphan numeric keys, so we
   * delete the field first (-=) then set it in the same update.
   * @param {string} path  e.g. "system.attacks"
   * @param {Array} value
   * @returns {Promise<void>}
   * @private
   */
  async #replaceArray(path, value) {
    const lastDot = path.lastIndexOf(".");
    const parent = path.slice(0, lastDot);
    const key = path.slice(lastDot + 1);
    await this.item.update({ [`${parent}.-=${key}`]: null, [path]: value });
  }
}
