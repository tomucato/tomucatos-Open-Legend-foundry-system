import { openRollDialog, actorRollModifiers } from "../dice/roll-dialog.mjs";
import { rollAction, prepareActionRoll } from "../dice/action-roll.mjs";
import * as Forms from "../forms.mjs";
import * as Companion from "../companion.mjs";
import { selectableDocuments } from "../helpers/utils.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;

/**
 * Open Legend actor sheet, built on ApplicationV2 + HandlebarsApplicationMixin.
 * One sheet class serves both the `character` and `npc` actor types; the body
 * template is chosen per-type in {@link _configureRenderParts}.
 */
export class OpenLegendActorSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  /** Recommended number of each per character (soft rule — exceeding only warns). */
  static MAX_PERKS = 2;
  static MAX_FLAWS = 2;

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["openlegend", "sheet", "actor"],
    position: { width: 640, height: 680 },
    // ApplicationV2 defaults windows to resizable: false; V1 sheets were
    // resizable, so opt back in.
    window: { resizable: true },
    form: {
      // Replicates the V1 sheet's auto-save-on-edit: named inputs update the
      // document on any change. ApplicationV2 collects the form and calls
      // document.update() for us — no _updateObject needed.
      submitOnChange: true,
      closeOnSubmit: false
    },
    actions: {
      attributeRoll: OpenLegendActorSheet.#onAttributeRoll,
      itemAttributeRoll: OpenLegendActorSheet.#onItemAttributeRoll,
      actionRoll: OpenLegendActorSheet.#onActionRoll,
      openInvocation: OpenLegendActorSheet.#onOpenInvocation,
      initiativeRoll: OpenLegendActorSheet.#onInitiativeRoll,
      imagePopout: OpenLegendActorSheet.#onImagePopout,
      statReport: OpenLegendActorSheet.#onStatReport,
      itemCreate: OpenLegendActorSheet.#onItemCreate,
      itemBrowse: OpenLegendActorSheet.#onItemBrowse,
      featureCreate: OpenLegendActorSheet.#onFeatureCreate,
      itemEdit: OpenLegendActorSheet.#onItemEdit,
      itemDelete: OpenLegendActorSheet.#onItemDelete,
      actionGenerate: OpenLegendActorSheet.#onActionGenerate,
      itemConsume: OpenLegendActorSheet.#onItemConsume,
      itemExpend: OpenLegendActorSheet.#onItemExpend,
      armorToggleEquip: OpenLegendActorSheet.#onArmorToggleEquip,
      weaponToggleEquip: OpenLegendActorSheet.#onWeaponToggleEquip,
      effectCreate: OpenLegendActorSheet.#onEffectCreate,
      effectEdit: OpenLegendActorSheet.#onEffectEdit,
      effectToggle: OpenLegendActorSheet.#onEffectToggle,
      effectDelete: OpenLegendActorSheet.#onEffectDelete,
      effectLevelStep: OpenLegendActorSheet.#onEffectLevelStep,
      conditionExpand: OpenLegendActorSheet.#onConditionExpand,
      conditionDelete: OpenLegendActorSheet.#onConditionDelete,
      conditionTogglePotent: OpenLegendActorSheet.#onConditionTogglePotent,
      resistBanes: OpenLegendActorSheet.#onResistBanes,
      hospitaler: OpenLegendActorSheet.#onHospitaler,
      lethalRest: OpenLegendActorSheet.#onLethalRest,
      battleTranceToggle: OpenLegendActorSheet.#onBattleTranceToggle,
      recklessAttack: OpenLegendActorSheet.#onRecklessAttack,
      featRaise: OpenLegendActorSheet.#onFeatRaise,
      featLower: OpenLegendActorSheet.#onFeatLower,
      formView: OpenLegendActorSheet.#onFormView,
      formTransform: OpenLegendActorSheet.#onFormTransform,
      formDelete: OpenLegendActorSheet.#onFormDelete,
      formRename: OpenLegendActorSheet.#onFormRename,
      formEditTokenImage: OpenLegendActorSheet.#onFormEditTokenImage,
      formEditPortrait: OpenLegendActorSheet.#onFormEditPortrait,
      formApplyToken: OpenLegendActorSheet.#onFormApplyToken,
      viewCompanion: OpenLegendActorSheet.#onViewCompanion,
      pilotOpen: OpenLegendActorSheet.#onPilotOpen,
      pilotClear: OpenLegendActorSheet.#onPilotClear
    }
  };

  /**
   * Conditions whose collapsible detail panel is open, by Active Effect id.
   * Sheet-instance UI state; survives re-renders, resets when the sheet closes.
   * @type {Set<string>}
   */
  #expandedConditions = new Set();

  /**
   * Open/closed state of the collapsible header panels (Stats, Defenses,
   * Actions). Sheet-instance UI state; survives re-renders, resets when the
   * sheet closes. Actions starts collapsed, the others expanded.
   * @type {{stats: boolean, defenses: boolean, actions: boolean}}
   */
  #vitalsOpen = { stats: true, defenses: true, actions: false };

  /**
   * FORM PREVIEW (view & edit a non-active form). Clicking a form tab no longer
   * switches the live actor (which changed its combat stats — defenses included —
   * just by "looking" at the form); it renders the sheet from an ephemeral clone
   * carrying that form's data instead, so incoming attacks and HP damage always
   * use the ACTIVE form. The real switch is the explicit Transform action.
   *
   * The preview is fully EDITABLE — nothing is blocked except the Battle Trance
   * toggle (a combat state of the active form):
   *   - form-OWNED fields (attributes, archetype, speed) route into the stored
   *     snapshot via _processSubmitData; other (shared) fields forward to the
   *     live actor, with HP applied as a DELTA (HP scale is form-relative);
   *   - feat & action CRUD routes to the Forms add/update/removeItemFromForm
   *     helpers (their item sheets open as patched in-memory documents);
   *   - SHARED items (inventory, perks/flaws) and actor effects keep the same
   *     ids on the live actor, so their handlers mutate this.document directly;
   *   - attribute/action rolls run off the clone (the dice the sheet displays);
   *     resist/rest/initiative/reckless act on the live actor.
   * While previewing, the `actor` getter serves the clone so every context-prep
   * path shows the form's stats; mutating handlers use `this.document`.
   * @type {string|null}
   */
  #previewFormId = null;

  /** The prepared ephemeral actor for the previewed form (null = live view). */
  #previewClone = null;

  /** @override — sheet reads go through the preview clone while one is active. */
  get actor() {
    return this.#previewClone ?? super.actor;
  }

  /** Whether the sheet is showing a (write-through) form preview. */
  get isFormPreview() {
    return !!this.#previewClone;
  }

  /** The previewed form's stored snapshot entry (null when not previewing). */
  #previewedForm() {
    if ( !this.#previewFormId ) return null;
    return Forms.getForms(this.document).find(f => f.id === this.#previewFormId) ?? null;
  }

  /**
   * (Re)build the preview clone for the previewed form, or clear it. Runs at the
   * top of every render so the preview tracks live changes to the real actor and
   * evaporates when the form vanishes or becomes the active one.
   */
  #syncFormPreview() {
    this.#previewClone = null;
    const id = this.#previewFormId;
    if ( !id ) return;
    const actor = this.document;
    const valid = ["character", "npc"].includes(actor.type)
      && Forms.hasAlternateFormFeat(actor)
      && (id !== Forms.activeFormId(actor));
    const form = valid ? Forms.getForms(actor).find(f => f.id === id) : null;
    if ( !form ) { this.#previewFormId = null; return; }
    this.#previewClone = Forms.previewActorForForm(actor, form);
  }

  /**
   * @override — while previewing, split the submit:
   *   - form-OWNED fields (attributes, archetype, base speed) go into the
   *     previewed form's stored snapshot;
   *   - every other field that actually CHANGED (vs the clone's source — the
   *     values the inputs were rendered from) forwards to the LIVE actor, since
   *     those are shared (name, XP, level, biography, ...). HP and lethal are
   *     forwarded as DELTAS: the preview shows form-relative HP (re-expressed
   *     against the previewed form's max), so healing 5 there heals 5 live —
   *     matching the damage-carry rule — instead of overwriting the live value
   *     with a number from the wrong scale.
   */
  async _processSubmitData(event, form, submitData, options) {
    if ( !this.isFormPreview ) return super._processSubmitData(event, form, submitData, options);
    const flat = foundry.utils.flattenObject(submitData ?? {});
    const patch = {};
    const live = {};
    const HP_DELTA_FIELDS = ["system.health.value", "system.health.lethal"];
    for ( const [k, v] of Object.entries(flat) ) {
      const attr = k.match(/^system\.attributes\.([^.]+)\.value$/);
      if ( attr ) { patch[`attributes.${attr[1]}.value`] = Number(v) || 0; continue; }
      if ( k === "system.archetype" ) { patch["profile.archetype"] = String(v ?? ""); continue; }
      if ( k === "system.speed.value" ) { patch["profile.speed"] = Number(v) || 0; continue; }
      // Shared field: forward only when genuinely edited this submit (different
      // from what the input was rendered with — the clone's source value).
      const rendered = foundry.utils.getProperty(this.actor._source, k);
      if ( (v === rendered) || (String(v) === String(rendered ?? "")) ) continue;
      if ( HP_DELTA_FIELDS.includes(k) ) {
        const delta = (Number(v) || 0) - (Number(rendered) || 0);
        if ( delta ) {
          const cur = Number(foundry.utils.getProperty(this.document._source, k)) || 0;
          live[k] = Math.max(0, cur + delta);
        }
        continue;
      }
      live[k] = v;
    }
    if ( !foundry.utils.isEmpty(patch) ) {
      await Forms.updateStoredForm(this.document, this.#previewFormId, patch);
    }
    if ( !foundry.utils.isEmpty(live) ) {
      await this.document.update(live);
      this.render(false);
    }
  }

  /**
   * Step a feat's purchased tier inside the PREVIEWED form's stored snapshot
   * (the preview counterpart of #onFeatRaise/#onFeatLower). Dropping below tier
   * 1 removes the feat via #deleteStoredFormItem (which runs the full linked-
   * resource cleanup for Alternate Form / Companion feats). The Alternate Form
   * feat's tier is owned by Forms.setFormTier (which mirrors it onto every
   * serialized copy + the live item); a Companion feat also syncs its linked
   * companion actor's tier.
   * @param {string} itemId
   * @param {number} delta  +1 | -1
   */
  async #stepStoredFeatTier(itemId, delta) {
    const formId = this.#previewFormId;
    const item = (this.#previewedForm()?.items ?? []).find(i => i._id === itemId);
    if ( !item || (item.type !== "feat") ) return;
    const sys = item.system ?? {};
    const base = sys.baseName || item.name;
    const max = Math.max(1, Number(sys.maxTier ?? 1));
    const cur = Math.max(1, Number(sys.purchasedTier ?? 1));
    const next = Math.min(max, cur + delta);
    if ( next < 1 ) return this.#deleteStoredFormItem(itemId);
    if ( next === cur ) return;
    if ( base === Forms.ALTERNATE_FORM_FEAT ) {
      const linked = item.flags?.openlegend?.formId;
      if ( linked ) return Forms.setFormTier(this.document, linked, next);
    }
    await Forms.updateItemInForm(this.document, formId, itemId, { "system.purchasedTier": next });
    if ( base === Companion.COMPANION_FEAT ) {
      const uuid = item.flags?.openlegend?.companionUuid;
      const comp = uuid ? fromUuidSync(uuid) : null;
      if ( comp ) await Companion.setCompanionTier(comp, next);
    }
  }

  /**
   * Delete an item from the PREVIEWED form's stored snapshot. The Alternate Form
   * and Companion feats run their full linked-resource cleanup (same warn +
   * delete-linked-form/companion flow as the live handlers, against serialized
   * data): the linked form / companion is removed and the feat is scrubbed from
   * every snapshot so a later switch can't resurrect it.
   * @param {string} itemId
   */
  async #deleteStoredFormItem(itemId) {
    const actor = this.document;
    const item = (this.#previewedForm()?.items ?? []).find(i => i._id === itemId);
    if ( !item ) return;
    const base = item.system?.baseName || item.name;
    const { DialogV2 } = foundry.applications.api;

    if ( (item.type === "feat") && (base === Forms.ALTERNATE_FORM_FEAT) ) {
      const linkedId = item.flags?.openlegend?.formId
        || (actor.flags?.openlegend?.forms ?? []).find(f => f.featId === itemId)?.id;
      const formName = (linkedId ? Forms.getForms(actor).find(f => f.id === linkedId)?.name : null) ?? "its linked form";
      const ok = await DialogV2.confirm({
        window: { title: "Remove Alternate Form" },
        content: `<p>Removing this <strong>Alternate Form</strong> feat will delete <strong>${formName}</strong> — its attributes, feats, actions, and images.</p>
          <p>Your other forms and feats are unaffected. This cannot be undone.</p>
          <p>Remove the feat and delete <strong>${formName}</strong>?</p>`,
        rejectClose: false, modal: true
      }).catch(() => false);
      if ( !ok ) return;
      if ( linkedId ) await Forms.deleteForm(actor, linkedId);
      await Forms.removeItemFromStoredForms(actor, itemId);
      return;
    }

    if ( (item.type === "feat") && (base === Companion.COMPANION_FEAT) ) {
      const uuid = item.flags?.openlegend?.companionUuid;
      const comp = uuid ? fromUuidSync(uuid) : null;
      const name = comp?.name ?? "its linked companion";
      const ok = await DialogV2.confirm({
        window: { title: "Remove Companion" },
        content: `<p>Removing this <strong>Companion</strong> feat will delete the companion <strong>${name}</strong> — its sheet, attributes, feats, and token.</p>
          <p>Your other companions and feats are unaffected. This cannot be undone.</p>
          <p>Remove the feat and delete <strong>${name}</strong>?</p>`,
        rejectClose: false, modal: true
      }).catch(() => false);
      if ( !ok ) return;
      if ( comp && game.user?.isGM ) await comp.delete();
      else if ( comp ) ui.notifications?.warn(`Ask the GM to delete the companion "${name}".`);
      await Forms.removeItemFromStoredForms(actor, itemId);
      return;
    }

    await Forms.removeItemFromForm(actor, this.#previewFormId, itemId);
  }

  /**
   * Open an editable item sheet for a serialized item inside the PREVIEWED
   * form's snapshot. The document is a parentless in-memory Item whose update()
   * is patched to write into the stored snapshot (there is no database record
   * to update — the item only materializes on the live actor when its form is
   * transformed into). The viewer gets ownership so the sheet renders editable.
   * @param {string} itemId
   */
  async #openStoredFormItemSheet(itemId) {
    const formId = this.#previewFormId;
    const data = (this.#previewedForm()?.items ?? []).find(i => i._id === itemId);
    if ( !data ) return;
    const actor = this.document;
    const doc = new Item.implementation(foundry.utils.deepClone(data));
    doc.updateSource({ ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER } });
    doc.prepareData();
    const sheet = doc.sheet;
    doc.update = async changes => {
      const flat = foundry.utils.flattenObject(changes ?? {});
      delete flat._id;
      await Forms.updateItemInForm(actor, formId, itemId, flat);
      doc.updateSource(flat);
      doc.prepareData();
      sheet?.render(false);
      return doc;
    };
    await OpenLegendActorSheet.#openDocumentSheet(doc);
  }

  /** @override — a reopened sheet always starts on the live (active) form. */
  _onClose(options) {
    this.#previewFormId = null;
    this.#previewClone = null;
    return super._onClose(options);
  }

  /**
   * The body part is type-dependent; both share the standard sheet frame.
   * The `root` part renders the full <form> contents (header, tabs, body).
   * @override
   */
  static PARTS = {
    body: {
      template: "systems/tomucatos-open-legend-rpg-system/templates/actor/character-sheet.html",
      root: true,
      // Required partials the body references; the mixin loads (and thereby
      // registers) these before first render.
      templates: [
        "templates/generic/tab-navigation.hbs",
        "systems/tomucatos-open-legend-rpg-system/templates/actor/parts/form-tabs.html",
        "systems/tomucatos-open-legend-rpg-system/templates/actor/parts/inventory.html",
        "systems/tomucatos-open-legend-rpg-system/templates/actor/parts/inv-item-details.hbs",
        "systems/tomucatos-open-legend-rpg-system/templates/actor/parts/actions.html",
        "systems/tomucatos-open-legend-rpg-system/templates/actor/parts/feats.html",
        "systems/tomucatos-open-legend-rpg-system/templates/actor/parts/effects.html",
        "systems/tomucatos-open-legend-rpg-system/templates/actor/parts/item-attributes.hbs"
      ],
      // The whole sheet scrolls as one document (.window-content). Listing the
      // root as scrollable makes the mixin save & restore its scroll position
      // across the submitOnChange re-render, so editing a field no longer jumps
      // the sheet back to the top.
      scrollable: [""]
    }
  };

  /**
   * Tab definition for the single "primary" group. ApplicationV2 wires the
   * built-in `tab` click action and exposes prepared tab state as context.tabs.
   * @override
   */
  static TABS = {
    primary: {
      tabs: [
        { id: "attributes", label: "Attributes" },
        { id: "biography", label: "Biography" },
        { id: "actions", label: "Actions" },
        { id: "feats", label: "Feats" },
        { id: "inventory", label: "Inventory" },
        { id: "effects", label: "Effects" }
      ],
      initial: "attributes"
    }
  };

  /* -------------------------------------------- */

  /**
   * Swap the body template to the NPC layout for npc actors (and the boss layout
   * for bosses), which have a reduced tab set (Description instead of Biography,
   * no creation budget).
   * @override
   */
  _configureRenderParts(options) {
    const parts = super._configureRenderParts(options);
    if ( this.actor.type === "npc" ) {
      parts.body = { ...parts.body, template: "systems/tomucatos-open-legend-rpg-system/templates/actor/npc-sheet.html" };
    } else if ( this.actor.type === "boss" ) {
      parts.body = { ...parts.body, template: "systems/tomucatos-open-legend-rpg-system/templates/actor/boss-sheet.html" };
    } else if ( this.actor.type === "minion" ) {
      parts.body = { ...parts.body, template: "systems/tomucatos-open-legend-rpg-system/templates/actor/minion-sheet.html" };
    } else if ( this.actor.type === "mount" ) {
      parts.body = { ...parts.body, template: "systems/tomucatos-open-legend-rpg-system/templates/actor/mount-sheet.html" };
    }
    return parts;
  }

  /** @override */
  _getTabsConfig(group) {
    const config = super._getTabsConfig(group);
    // Minions are stripped down: no Feats or Inventory (the SRD minion has none).
    if ( config && (this.actor.type === "minion") ) {
      return {
        ...config,
        tabs: [
          { id: "attributes", label: "Attributes" },
          { id: "description", label: "Description" },
          { id: "actions", label: "Actions" },
          { id: "effects", label: "Effects" }
        ],
        initial: "attributes"
      };
    }
    // Mounts/vehicles: no Inventory (the mount IS the equipment); Feats stay —
    // the SRD example mounts carry feats that apply to the mount's own actions.
    if ( config && (this.actor.type === "mount") ) {
      return {
        ...config,
        tabs: [
          { id: "attributes", label: "Attributes" },
          { id: "description", label: "Description" },
          { id: "actions", label: "Actions" },
          { id: "feats", label: "Feats" },
          { id: "effects", label: "Effects" }
        ],
        initial: "attributes"
      };
    }
    // NPCs and bosses use the same reduced tab set, labelling the second tab
    // "Description" rather than "Biography".
    if ( config && ((this.actor.type === "npc") || (this.actor.type === "boss")) ) {
      return {
        ...config,
        tabs: [
          { id: "attributes", label: "Attributes" },
          { id: "description", label: "Description" },
          { id: "actions", label: "Actions" },
          { id: "feats", label: "Feats" },
          { id: "inventory", label: "Inventory" },
          { id: "effects", label: "Effects" }
        ],
        initial: "attributes"
      };
    }
    return config;
  }

  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    // Rebuild (or clear) the read-only form-preview clone BEFORE anything reads
    // this.actor — the whole context below then reflects the previewed form.
    this.#syncFormPreview();
    const context = await super._prepareContext(options);
    // SOURCE data (toObject() defaults to source=true) — the editable form fields
    // must bind to BASE values, never derived. Using toObject(false) here bound
    // inputs like Speed/Guard to their DERIVED (penalized) values, so each form
    // submit wrote the penalized total back as the new base, compounding every
    // render (e.g. armor −5 dropped base speed 30→25→20…). Derived values for
    // read-only display are exposed separately via context.derived below.
    const actorData = this.actor.toObject();

    context.actor = this.actor;
    context.system = actorData.system;
    context.config = CONFIG.OPENLEGEND;
    // Collapsible header panels — the templates render the <details> `open`
    // attribute from this so the state survives re-renders.
    context.vitalsOpen = this.#vitalsOpen;
    // `editable`/`document`/`source`/`fields`/`tabs` are provided by super.

    // `context.system` is SOURCE data (toObject) — base values, before derived
    // armor modifiers. Expose the live DERIVED values for read-only displays so
    // Guard shows the armor bonus and Speed shows the penalized total, while the
    // editable speed input stays bound to the base via context.system.speed.value.
    //
    // For characters the derived Guard already includes the equipped-armor bonus
    // (added during prepareDerivedData). For NPCs and bosses the stored Guard is
    // free-form (the GM's value) and the armor bonus is applied here, for display
    // only, so it never compounds into the stored base.
    const isNpc = this.actor.type === "npc";
    const isBoss = this.actor.type === "boss";
    const isMinion = this.actor.type === "minion";
    const freeFormStats = isNpc || isBoss;
    const armorBonus = Number(this.actor.system.armorDefenseBonus ?? 0);
    // Battle Trance's +3 to Toughness/Resolve and Extraordinary Defense's +tier to
    // all defenses are already baked into the derived values for characters; for
    // NPC/boss (GM-set base) they're applied display-only here.
    const btDef = freeFormStats ? Number(this.actor.system.battleTranceDefense ?? 0) : 0;
    const xtraDef = freeFormStats ? Number(this.actor.system.extraordinaryDefense ?? 0) : 0;
    const indomDef = freeFormStats ? Number(this.actor.system.indomitableResolve ?? 0) : 0;
    const natDef = freeFormStats ? Number(this.actor.system.naturalDefense ?? 0) : 0;
    context.derived = {
      guard: Number(this.actor.system.defenses?.guard?.value ?? 0) + (freeFormStats ? armorBonus + xtraDef + natDef : 0),
      toughness: Number(this.actor.system.defenses?.toughness?.value ?? 0) + btDef + xtraDef + natDef,
      resolve: Number(this.actor.system.defenses?.resolve?.value ?? 0) + btDef + xtraDef + indomDef,
      speed: this.actor.system.speed?.value,
      climbSpeed: Number(this.actor.system.speed?.climb ?? 0),
      flySpeed: Number(this.actor.system.speed?.fly ?? 0),
      swimSpeed: Number(this.actor.system.speed?.swim ?? 0),
      // Hospitaler feat: surfaces an "Aid Ally" control in the Actions section.
      hasHospitaler: CONFIG.OPENLEGEND?.hasHospitaler?.(this.actor) ?? false,
      // Battle Trance feat: surfaces a toggle control in the Actions section.
      hasBattleTrance: !!(CONFIG.OPENLEGEND?.battleTranceFeat?.(this.actor)),
      battleTranceOn: !!(CONFIG.OPENLEGEND?.battleTranceActive?.(this.actor)),
      // Reckless Attack feat: surfaces a control in the Actions section. Usable only
      // while in a Battle Trance — `recklessReady` drives the active styling/title.
      hasRecklessAttack: CONFIG.OPENLEGEND?.hasRecklessAttack?.(this.actor) ?? false,
      recklessReady: !!(CONFIG.OPENLEGEND?.hasRecklessAttack?.(this.actor)
        && CONFIG.OPENLEGEND?.battleTranceActive?.(this.actor)),
      // Sustain Slots: how many boons one "sustain a boon" minor action covers — base
      // 1, +1 per Superior Concentration tier. Shown as a counter in the Actions section.
      sustainSlots: CONFIG.OPENLEGEND?.sustainBoonSlots?.(this.actor) ?? 1,
      superiorConcentrationTier: CONFIG.OPENLEGEND?.superiorConcentrationTier?.(this.actor) ?? 0,
      initiative: this.actor.system.initiative?.value,
      healthMax: this.actor.system.health?.max,
      // Lethal damage: the accrued amount, the unreduced base max, and the
      // unconscious flag (lethal ≥ full max). The effective max above already
      // reflects the reduction.
      lethal: Number(this.actor.system.health?.lethal ?? 0),
      healthMaxBase: Number(this.actor.system.health?.maxBase ?? this.actor.system.health?.max ?? 0),
      lethalUnconscious: !!this.actor.system.health?.lethalUnconscious
    };
    // Derived carrying-capacity counters/limits (computed in prepareDerivedData).
    context.carry = this.actor.system.carry;

    // Re-derive the dice formulas onto the plain object copy (toObject drops
    // the non-schema fields we attach in prepareDerivedData).
    const dice = CONFIG.OPENLEGEND?.attributeDice ?? {};
    for ( const attr of Object.values(context.system.attributes ?? {}) ) {
      const s = Math.max(0, Math.min(9, Number(attr.value ?? 0)));
      attr.dice = dice[s] ?? "";
    }

    // Build category-grouped attributes for the template from the LIVE actor —
    // not context.system (toObject source), which lacks the derived per-attribute
    // fields (ownValue, dice, subDice, substitutionPrimary/Tier) that the rows and
    // the Attribute Substitution locked row need.
    // Characters/companions also get the level-derived attribute-score cap so
    // rows above it render the over-max warning (NPC-family sheets are free-form).
    let maxScore = null;
    if ( (this.actor.type === "character") || (this.actor.type === "companion") ) {
      const cfg = CONFIG.OPENLEGEND ?? {};
      if ( (this.actor.type === "character") && cfg.budgetForXp ) {
        maxScore = cfg.budgetForXp(context.system.xp).maxScore ?? null;
      } else if ( cfg.budgetForLevel ) {
        // Companions cap by the PARENT's level (their budgets derive from it);
        // fall back to their own level when unlinked.
        const parent = (this.actor.type === "companion") ? Companion.companionParent(this.actor) : null;
        const lvl = Number(parent?.system?.level ?? context.system.level ?? 1);
        maxScore = cfg.budgetForLevel(lvl).maxScore ?? null;
      }
    }
    context.attributeGroups = this._buildAttributeGroups(this.actor.system.attributes, maxScore);

    // Minions have only six attributes (Agility, Fortitude, Might, Perception, Energy,
    // Entropy) — filter the groups to those, dropping any now-empty category.
    if ( this.actor.type === "minion" ) {
      const allowed = new Set(CONFIG.OPENLEGEND?.MINION_ATTRIBUTES ?? []);
      context.attributeGroups = context.attributeGroups
        .map(g => ({ ...g, attributes: g.attributes.filter(a => allowed.has(a.key)) }))
        .filter(g => g.attributes.length);
    }

    // Extraordinary-item attributes (derived in prepareDerivedData). ALL of them
    // are listed in their own section — including the "own+adv" case, where the
    // item gives up its lower score and grants Advantage on the actor's own
    // attribute (that advantage is applied/shown in the roll dialog, not as a
    // badge on the normal attribute).
    // Read from the LIVE actor: itemAttributes is a derived (non-schema) field
    // attached in prepareDerivedData, so toObject() (source) does not carry it.
    context.itemAttributes = this.actor.system.itemAttributes ?? [];

    // Wealth Level select options (1-10). Object map so {{selectOptions}} uses
    // the number as the value, not the array index (which would be off-by-one).
    context.wealthLevels = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [i + 1, String(i + 1)])
    );

    // Character-creation budget tracking (spent vs. available for the actor's level).
    // Companions get one too (overridden to their tier-derived allowance below).
    if ( (this.actor.type === "character") || (this.actor.type === "companion") ) {
      context.creation = this._computeCreationBudget(context.system.attributes, context.system.level,
        { xp: (this.actor.type === "character") ? context.system.xp : null });
    }

    // NPC / Boss Simple Build guidance for the selected level: a per-field
    // stat-line shown as a tooltip icon on HP, each defense, and the attribute
    // groups. The GM sets the actual values freely; this is reference only. Both
    // sheets read the same `context.npcBuild`; the boss table adds a single HP
    // value (not a range) plus a Boss Edge.
    if ( freeFormStats ) {
      const cfg = CONFIG.OPENLEGEND ?? {};
      if ( isBoss ) {
        const b = cfg.bossBuildForLevel ? cfg.bossBuildForLevel(this.actor.system.level) : null;
        if ( b ) {
          context.npcBuild = {
            level: b.level,
            hp: `${b.hp}`,
            defense: `${b.defense[0]}–${b.defense[1]}`,
            primary: b.primary,
            secondary: b.secondary,
            edge: b.edge
          };
        }
      } else {
        const b = cfg.npcBuildForLevel ? cfg.npcBuildForLevel(this.actor.system.level) : null;
        if ( b ) {
          context.npcBuild = {
            level: b.level,
            hp: `${b.hp[0]}–${b.hp[1]}`,
            defense: `${b.defense[0]}–${b.defense[1]}`,
            primary: b.primary,
            secondary: b.secondary
          };
        }
      }
      // Level select options (1–20). Object map → {{selectOptions}} uses the
      // number as the value. Shared by the NPC and Boss sheets.
      context.npcLevels = Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [i + 1, String(i + 1)])
      );
    }

    // Minion: power-level (4–9) options + the fixed build (HP, defense, attribute
    // spread) for the selected PL. HP & defenses are read-only (fixed from the table);
    // the spread is the set of attribute points to assign among the six minion attributes.
    if ( isMinion ) {
      const cfg = CONFIG.OPENLEGEND ?? {};
      const b = cfg.minionBuildForPowerLevel ? cfg.minionBuildForPowerLevel(this.actor.system.powerLevel) : null;
      context.minionPowerLevels = Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [i + 4, String(i + 4)])
      );
      const spread = b?.spread ?? [];
      const total = spread.reduce((a, n) => a + n, 0);
      // Spent = sum of the six minion attributes' current values.
      const minionKeys = cfg.MINION_ATTRIBUTES ?? [];
      const spent = minionKeys.reduce((a, k) => a + Number(this.actor.system.attributes?.[k]?.value ?? 0), 0);
      context.minionBuild = b ? {
        powerLevel: b.powerLevel, hp: b.hp, defense: b.defense,
        spread, spreadText: spread.join(", "),
        total, spent, remaining: total - spent, over: spent > total
      } : null;
    }

    // Mount/vehicle: speed-mode options and the damage track (level / threshold /
    // disabled), plus the repair rate (1 day per wealth level per damage level).
    if ( this.actor.type === "mount" ) {
      const cfg = CONFIG.OPENLEGEND ?? {};
      context.mountSpeedModes = cfg.mountSpeedModes ?? {};
      const state = cfg.mountDamageState ? cfg.mountDamageState(this.actor) : null;
      context.mountDamage = state ? {
        ...state,
        repairDays: Math.max(1, Math.floor(Number(this.actor.system.wealthLevel ?? 1)))
      } : null;
      // Pilot seats: one slot per Multi-Pilot (capped at 12), each holding a
      // dropped actor's uuid. Resolve name + image for the filled tiles; a uuid
      // that no longer resolves renders as empty (and is replaced on next drop).
      const seatCount = Math.max(1, Math.min(12, Math.floor(Number(this.actor.system.properties?.multiPilot ?? 1))));
      const pilotUuids = this.actor.system.pilots ?? [];
      context.mountPilots = Array.from({ length: seatCount }, (_, i) => {
        const uuid = String(pilotUuids[i] ?? "");
        const doc = uuid ? fromUuidSync(uuid) : null;
        return doc
          ? { index: i, seat: i + 1, uuid, name: doc.name, img: doc.img }
          : { index: i, seat: i + 1, uuid: "" };
      });
    }

    // Items segregation.
    const items = this.actor.items;
    context.perks = items.filter(i => i.type === 'perk');
    context.flaws = items.filter(i => i.type === 'flaw');

    // Feats: owned-feat display rows + the feat-point budget + the picker.
    await this._prepareFeats(context);

    // Alternate Forms: the Main + alternate-form tab bar (characters only).
    this._prepareForms(context);

    // Companion: tier-derived budgets (on a companion) + the parent's linked companions
    // (for the "View Companion" button).
    this._prepareCompanion(context);

    // Actions grouped by category, for the Actions tab. Each group keeps its
    // config label. Range is derived per-action (melee / ranged band / by the
    // actor's attribute score for non-physical).
    const actions = items.filter(i => i.type === 'action');
    const cats = CONFIG.OPENLEGEND?.actionCategories ?? {};
    for ( const a of actions ) {
      a.derived = this._deriveActionDisplay(a);
      // Itemized advantage/disadvantage preview for the expanded row — the SAME
      // breakdown the roll dialog will pre-fill (weapon grip, feats, conditions,
      // multi-targeting, active effects). Built from prepareActionRoll's sources.
      a.derived.modifiers = await this._deriveActionModifiers(a);
    }
    context.actionGroups = Object.entries(cats).map(([key, label]) => ({
      key, label,
      actions: actions.filter(a => a.system.actionCategory === key)
    }));

    // Inventory, by section. Each section houses its own physical item type.
    context.weapons = items.filter(i => i.type === 'weapon');
    context.armor = items.filter(i => i.type === 'armor');
    context.gear = items.filter(i => i.type === 'gear');

    // Enrich each inventory item's description for the collapsible detail view
    // (resolves @UUID links, inline rolls, etc.). enrichHTML is async, so do it
    // up front. Stored on the doc object purely for this render pass.
    const TextEditor = foundry.applications.ux.TextEditor.implementation;
    for ( const it of [...context.weapons, ...context.armor, ...context.gear, ...actions] ) {
      it.enrichedDescription = await TextEditor.enrichHTML(it.system.description ?? "", {
        relativeTo: it, secrets: this.actor.isOwner
      });
    }

    // Decorate each physical item with a readable Extraordinary-abilities summary
    // (granted attributes, boons, banes, properties) for the expanded detail view.
    // `hasExtraInvocations` flags an item that grants invocable banes/boons (with a
    // value > 0): such an item — even an armor/gear, not just a weapon — can
    // generate bane/boon actions via the wand button.
    for ( const it of [...context.weapons, ...context.armor, ...context.gear] ) {
      it.extra = this._extraordinarySummary(it);
      const props = it.system?.extraordinaryProperties ?? [];
      // Augmenting items deliver their bane via the attack roll's augmentation
      // picker, not a generated action — so they don't get the generate wand.
      // Expendable items are likewise one-shot (used via the Use button), so a
      // persistent generated action makes no sense for them either.
      it.isAugmenting = props.some(p => p.name === "augmenting");
      const expendableProp = props.some(p => p.name === "expendable");
      it.hideGenerate = it.isAugmenting || expendableProp;
      it.hasExtraInvocations = !it.hideGenerate && !!(it.extra && (it.extra.boons.length || it.extra.banes.length));
      // Consumable (extraordinary property): show a Consume button — invoke one of
      // the item's listed boons, then use up the item.
      it.isConsumable = props.some(p => p.name === "consumable");
      // Expendable WITHOUT Augmenting: show a Use button — one-shot invocation of
      // a listed bane/boon (or one unlocked by a granted attribute) via a
      // temporary action; a completed roll expends the item.
      it.isExpendable = !it.isAugmenting && expendableProp
        && !!(it.extra && (it.extra.banes.length || it.extra.boons.length || it.extra.attributes.length));
    }

    // Enriched HTML for the sheet's own rich-text fields. The templates render
    // these inside <prose-mirror toggled> elements — the AppV2 replacement for
    // the V1 {{editor}} helper, whose edit button relied on V1 Application
    // listeners and is inert under ApplicationV2.
    context.enrichedDescription = await TextEditor.enrichHTML(context.system.description ?? "", {
      relativeTo: this.actor, secrets: this.actor.isOwner
    });
    context.enrichedNotes = await TextEditor.enrichHTML(context.system.notes ?? "", {
      relativeTo: this.actor, secrets: this.actor.isOwner
    });

    // Per-armor flag: is this equipped armor's Required Fortitude unmet? The
    // bonus still applies, but the sheet warns the player. Computed against the
    // actor's derived (clamped) Fortitude score. Armor Mastery reduces the
    // Fortitude prerequisite for wearing armor by its tier.
    const fortitude = Number(this.actor.system.attributes?.fortitude?.value ?? 0);
    const armorMasteryTier = (CONFIG.OPENLEGEND?.armorMasteryTier?.(this.actor)) ?? 0;
    for ( const a of context.armor ) {
      const raw = Number(a.system.requiredFortitude ?? 0);
      const required = Math.max(0, raw - armorMasteryTier);
      a.effectiveRequiredFortitude = required;
      a.fortitudeReduced = required !== raw;
      a.fortitudeUnmet = a.system.equipped && (required > fortitude);
    }
    // Armor totals from equipped pieces, for an at-a-glance summary on the sheet.
    context.armorSummary = context.armor.reduce((s, a) => {
      if ( a.system.equipped ) {
        s.defenseBonus += Number(a.system.defenseBonus ?? 0);
        s.speedPenalty += Number(a.system.speedPenalty ?? 0);
      }
      return s;
    }, { defenseBonus: 0, speedPenalty: 0 });

    // Per-weapon hand requirement + equip state, plus the equipped-hands tally.
    // A versatile weapon can be held in 1 or 2 hands; when equipped, the chosen
    // grip lives in system.equipHands (the equip toggle prompts for it). Hand
    // slots are soft: exceeding two is warned, not blocked (matching carry).
    const cfg = CONFIG.OPENLEGEND ?? {};
    const maxHands = Number(cfg.maxHands ?? 2);
    let handsUsed = 0;
    // Two Weapon Brute lets a two-handed weapon be wielded one-handed, so its hand-slot
    // cost (and the over-hands tally) is 1, not 2 — while its label still reads "2H".
    const brute = !!(cfg.hasTwoWeaponBrute && cfg.hasTwoWeaponBrute(this.actor));
    for ( const w of context.weapons ) {
      const need = cfg.weaponHandsFor ? cfg.weaponHandsFor(w.system.categories ?? []) : 1;
      const versatile = need === "versatile";
      const equipped = !!w.system.equipped;
      // Versatile weapons report the grip they're equipped at (1 or 2);
      // fixed weapons report their inherent requirement.
      const reqHands = versatile
        ? (equipped ? Math.max(1, Math.min(2, Number(w.system.equipHands ?? 1))) : 1)
        : Number(need);
      // Effective hand-slot cost honors Two Weapon Brute (two-handed → 1).
      const slotHands = cfg.effectiveWeaponHands
        ? cfg.effectiveWeaponHands(this.actor, w, versatile ? { equipHands: reqHands } : {})
        : reqHands;
      w.versatile = versatile;
      w.hands = reqHands;
      w.equipped = equipped;
      // Display: "1H", "2H", or "1H/2H" for an unequipped versatile weapon. A 2H weapon
      // a Brute wields one-handed shows "2H (1 hand)" so the slot cost is clear.
      w.handsLabel = versatile && !equipped ? "1H / 2H"
        : (brute && (need === 2)) ? "2H (1 hand)"
        : `${reqHands}H`;
      if ( equipped ) handsUsed += slotHands;
    }
    context.weaponSummary = {
      handsUsed,
      maxHands,
      overHands: handsUsed > maxHands
    };

    // Perk / Flaw pickers: options from the compendium and non-private world
    // items (excluding owned), plus whether the recommended per-character count
    // has been exceeded (soft rule: the picker stays available, the sheet just
    // flags the overage).
    context.perkPicker = {
      options: await this._getCompendiumOptions("tomucatos-open-legend-rpg-system.perks", context.perks, "perk"),
      overMax: context.perks.length > OpenLegendActorSheet.MAX_PERKS,
      max: OpenLegendActorSheet.MAX_PERKS
    };
    context.flawPicker = {
      options: await this._getCompendiumOptions("tomucatos-open-legend-rpg-system.flaws", context.flaws, "flaw"),
      overMax: context.flaws.length > OpenLegendActorSheet.MAX_FLAWS,
      max: OpenLegendActorSheet.MAX_FLAWS
    };

    // Conditions tab: bane/boon conditions afflicting the actor (collapsible,
    // with the per-level effects the document offers) plus all remaining
    // Active Effects as a plain list.
    await this._buildEffectLists(context);

    return context;
  }

  /**
   * Build {uuid, name} options for a picker from world items of a type plus the
   * system compendium's index, skipping items the actor already has (matched by
   * name), sorted by name. World items come first so a GM's customised copy wins
   * over a same-named compendium entry; world items marked Private are hidden.
   * @param {string} packId   e.g. "tomucatos-open-legend-rpg-system.perks"
   * @param {Array} owned     Items of that type already on the actor.
   * @param {string|null} type  Item type whose world items join the list
   *                            (e.g. "perk"); null → compendium only.
   * @returns {Promise<Array<{uuid: string, name: string}>>}
   * @private
   */
  async _getCompendiumOptions(packId, owned = [], type = null) {
    const have = new Set(owned.map(i => i.name));
    const options = [];
    const push = (uuid, name) => {
      if ( !uuid || !name || have.has(name) ) return;
      have.add(name);
      options.push({ uuid, name });
    };
    if ( type ) {
      for ( const item of game.items ?? [] ) {
        if ( item.type !== type ) continue;
        if ( !item.visible || item.system?.private ) continue;
        push(item.uuid, item.name);
      }
    }
    const pack = game.packs?.get(packId);
    if ( pack ) {
      const index = await pack.getIndex();
      for ( const e of index.contents ) push(e.uuid, e.name);
    }
    return options.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Build the Conditions tab's two lists. Mutates `context`:
   *
   * - context.conditions — one collapsible row per bane/boon condition
   *   afflicting the actor. A condition is the PAIR of the dropped bane/boon
   *   document (embedded item) and the leveled Active Effect the drop applied
   *   (flagged fromBane/fromBoon); they are presented as ONE row, not two.
   *   Expanding the row shows what the document offers: the mechanical change
   *   rows per power level (the currently-unlocked one highlighted), the
   *   effect's notes (e.g. Persistent Damage's roll link), and the document's
   *   per-PL effect text.
   * - context.effects — every remaining Active Effect (directly applied, or
   *   transferred from a non-bane/boon item such as a weapon), as a plain list.
   *   Effects living ON embedded bane/boon items are skipped entirely: they are
   *   the templates the drop clones, already shown inside the condition row.
   * @param {object} context
   * @private
   */
  async _buildEffectLists(context) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    const TextEditor = foundry.applications.ux.TextEditor.implementation;
    const linkify = cfg.diceToInlineRolls ?? (t => t);

    const levelData = effect => {
      const fl = effect.flags?.openlegend ?? {};
      const levels = fl.changeLevels ?? [];
      const defined = [...new Set(levels.map(Number).filter(l => Number.isFinite(l) && (l > 0)))]
        .sort((x, y) => x - y);
      // Stacking conditions count STACKS (1..max), a separate axis from power
      // level; raise/lower just step that within bounds.
      if ( fl.stacking ) {
        const max = defined.length ? Math.max(...defined) : 1;
        const stack = Math.max(1, Math.floor(Number(fl.stackLevel) || 1));
        return { pl: stack, defined, stacking: true, canRaise: stack < max, canLower: stack > 1 };
      }
      const pl = Number(fl.powerLevel ?? 0);
      return { pl, defined, stacking: false, canRaise: defined.some(l => l > pl), canLower: defined.some(l => l < pl) };
    };

    const conditions = [];
    const rows = [];
    for ( const effect of this.actor.effects ) {
      const sourceName = effect.flags?.openlegend?.fromBane ?? effect.flags?.openlegend?.fromBoon;
      const { pl, defined, stacking, canRaise, canLower } = levelData(effect);

      if ( !sourceName ) {
        rows.push({
          id: effect.id,
          name: effect.name,
          img: effect.img,
          disabled: effect.disabled,
          itemId: null,
          sourceName: "—",
          editable: true,
          hasLevels: defined.length > 0,
          stacking,
          powerLevel: pl,
          canRaise,
          canLower
        });
        continue;
      }

      // A condition: pair the effect with the dropped document (matched by the
      // source name the apply stamped into the flag).
      const kind = effect.flags?.openlegend?.fromBane ? "bane" : "boon";
      const item = this.actor.items.find(i => (i.type === kind) && (i.name === sourceName));
      const expanded = this.#expandedConditions.has(effect.id);

      // The mechanical changes the document offers, one per power level, with
      // the row the current level unlocks marked active. The changes are the
      // live (prepareDerivedData-decorated) rows, so each carries its level and
      // modifierType; describeChange renders subject + adv/dis/flat phrasing.
      const describe = cfg.describeChange ?? (c => ({ subject: c.key, detail: c.value }));
      const changeLevels = effect.flags?.openlegend?.changeLevels ?? [];
      const changes = (effect.system?.changes ?? []).map((c, i) => {
        const d = describe(c);
        return {
          label: d.subject,
          value: d.detail,
          level: Math.max(0, Math.floor(Number(c.level ?? changeLevels[i]) || 0)),
          active: !effect.disabled && (effect.isChangeActive?.(c) ?? true)
        };
      });

      // Enrich the collapsible body lazily — only for expanded rows.
      let description = "";
      let powerEffects = [];
      if ( expanded ) {
        const opts = { relativeTo: this.actor, secrets: this.actor.isOwner };
        if ( effect.description ) description = await TextEditor.enrichHTML(effect.description, opts);
        powerEffects = await Promise.all((item?.system?.powerEffects ?? []).map(async pe => ({
          powerLevel: pe.powerLevel,
          enriched: await TextEditor.enrichHTML(linkify(pe.effect ?? ""), opts)
        })));
      }

      conditions.push({
        id: effect.id,
        itemId: item?.id ?? null,
        name: sourceName,
        kind,
        img: effect.img,
        disabled: effect.disabled,
        expanded,
        // Potent is a bane-only marker (target resists at disadvantage 1).
        isBane: kind === "bane",
        potent: !!effect.flags?.openlegend?.potent,
        hasLevels: defined.length > 0,
        stacking,
        // For a stacking condition this is the stack count; otherwise the PL.
        powerLevel: pl,
        levelLabel: stacking ? "Level" : "PL",
        canRaise,
        canLower,
        changes,
        description,
        powerEffects
      });
    }

    // Effects transferred from owned items (weapons etc.) stay in the plain
    // list, read-only (managed on their item). Bane/boon items are skipped —
    // their effects are drop templates, surfaced inside the condition row.
    for ( const item of this.actor.items ) {
      if ( (item.type === "bane") || (item.type === "boon") ) continue;
      for ( const effect of item.effects ) {
        const { pl, defined } = levelData(effect);
        rows.push({
          id: effect.id,
          name: effect.name,
          img: effect.img,
          disabled: effect.disabled,
          itemId: item.id,
          sourceName: item.name,
          editable: false,
          hasLevels: false,
          powerLevel: pl,
          canRaise: false,
          canLower: false
        });
      }
    }

    context.conditions = conditions.sort((a, b) => a.name.localeCompare(b.name));
    context.effects = rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Build a readable Extraordinary-abilities summary for a physical item's
   * expanded detail view: its granted attributes, boons, banes, and properties,
   * each resolved to display strings. Returns null when the item isn't an
   * extraordinary item (so the detail view can omit the whole block).
   * @param {Item} item
   * @returns {{attributes: object[], boons: object[], banes: object[], properties: object[], any: boolean}|null}
   * @private
   */
  _extraordinarySummary(item) {
    const sys = item.system ?? {};
    if ( !sys.extraordinary ) return null;
    const cfg = CONFIG.OPENLEGEND ?? {};
    const attrLabel = k => cfg.attributeLabels?.[k] ?? k;

    const attributes = (sys.extraordinaryAttributes ?? [])
      .filter(a => a?.key && (Number(a.score) > 0))
      .map(a => ({ label: attrLabel(a.key), score: Math.floor(Number(a.score)) }));

    const boons = (sys.extraordinaryBoons ?? [])
      .filter(b => b?.name && (Number(b.powerLevel) > 0))
      .map(b => ({ name: b.name, powerLevel: Math.floor(Number(b.powerLevel)) }));

    const banes = (sys.extraordinaryBanes ?? [])
      .filter(b => b?.name && (Number(b.powerLevel) > 0))
      .map(b => ({ name: b.name, powerLevel: Math.floor(Number(b.powerLevel)) }));

    const properties = (sys.extraordinaryProperties ?? [])
      .filter(p => p?.name)
      .map(p => {
        const meta = (cfg.itemProperties ?? {})[p.name];
        const label = meta?.label ?? p.name;
        let value = "";
        if ( meta?.ranks ) value = String(p.value ?? "");
        else if ( meta?.choices ) value = meta.choices?.[p.value] ?? String(p.value ?? "");
        else if ( meta?.area ) {
          const a = cfg.parseItemArea?.(p.value);
          if ( a ) value = (a.shape === "line") ? `${cfg.areaShapes?.line ?? "Line"} ×${a.lines}` : `${cfg.areaShapes?.[a.shape] ?? a.shape} ${a.length}'`;
        }
        else if ( meta?.text ) value = ""; // detail lives in the description
        return { label, value, hint: meta?.hint ?? "" };
      });

    // Legendary properties ride the same display list, resolved likewise.
    for ( const p of (sys.legendaryProperties ?? []) ) {
      if ( !p?.name ) continue;
      const meta = (cfg.legendaryProperties ?? {})[p.name];
      let value = "";
      if ( meta?.attrMod ) {
        const mod = cfg.parseLegendaryAttrMod?.(p.value);
        if ( mod ) value = `${attrLabel(mod.key)} ${mod.amount > 0 ? "+" : "−"}${Math.abs(mod.amount)}`;
      }
      else if ( meta?.creature ) value = String(p.value ?? "");
      else if ( meta?.text ) value = String(p.value ?? "");
      properties.push({ label: meta?.label ?? p.name, value, hint: meta?.hint ?? "" });
    }

    const any = !!(attributes.length || boons.length || banes.length || properties.length);
    return { attributes, boons, banes, properties, any };
  }

  /**
   * Group attribute entries by category for display, preserving book order.
   * @param {object} attributes  The system.attributes object.
   * @returns {Array<{key: string, label: string, attributes: Array}>}
   * @private
   */
  _buildAttributeGroups(attributes = {}, maxScore = null) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    const categories = cfg.categories ?? {};
    const costForScore = cfg.costForScore ?? (s => (Number(s) * (Number(s) + 1)) / 2);
    const labels = cfg.attributeLabels ?? {};
    const groups = [];
    for ( const [catKey, cat] of Object.entries(categories) ) {
      const attrs = [];
      for ( const attrKey of cat.attributes ) {
        const attr = attributes[attrKey];
        if ( !attr ) continue;
        // The editable row always shows the player's OWN score (it costs points
        // and rolls the own dice). Substitution doesn't change what you can spend
        // or roll here — it adds a separate locked row (below).
        const ownValue = Number(attr.ownValue ?? attr.value ?? 0);
        attrs.push({
          key: attrKey,
          label: attr.label,
          value: ownValue,
          dice: attr.dice,                 // own-score dice (derived from ownValue)
          cost: costForScore(ownValue),
          substituted: false,
          // Over the level cap: only the OWN (bought) score counts — a
          // substituted value is granted by a feat, not purchased.
          maxScore,
          overMax: (maxScore !== null) && (ownValue > maxScore)
        });
        // Attribute Substitution: a second, LOCKED row for this dependent
        // attribute showing the substituted (primary) value + dice. No points,
        // not editable; this is the value the sheet/derived stats use. The
        // original row above remains rollable at the player's own score.
        const subbed = Number(attr.value ?? ownValue);
        if ( attr.subDice !== undefined && subbed > ownValue ) {
          const primaryLabel = labels[attr.substitutionPrimary] ?? attr.substitutionPrimary ?? "";
          attrs.push({
            key: attrKey,
            label: attr.label,
            value: subbed,
            dice: attr.subDice,
            cost: null,                    // no points — granted by the feat
            substituted: true,
            substitutionPrimary: attr.substitutionPrimary,
            substitutionPrimaryLabel: primaryLabel,
            substitutionTier: Number(attr.substitutionTier ?? 0)
          });
        }
      }
      groups.push({ key: catKey, label: cat.label, attributes: attrs });
    }
    return groups;
  }

  /**
   * Readable display data for an action row: attribute label, action type label,
   * range string (melee / band feet / non-physical derived from the actor's
   * attribute score), and a target summary.
   * @param {Item} action
   * @returns {{attribute: string, actionType: string, range: string, target: string}}
   * @private
   */
  _deriveActionDisplay(action) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    const sys = action.system;
    // A bane/boon invoked from an EXTRAORDINARY ITEM (or the Boon Access feat) is
    // not rolled off an attribute — the item's listed value supplies the dice. In
    // that case the action list shows the SOURCE ITEM's name in the attribute
    // column instead of an attribute label (the attribute select is irrelevant /
    // disabled on the action sheet for an item invocation).
    const isItemInvocation = ((sys.actionCategory === "bane") || (sys.actionCategory === "boon"))
      && (Number(sys.invokeItemScore ?? 0) > 0) && !!sys.invokeFromItemId;
    const sourceItem = isItemInvocation ? this.actor.items.get(sys.invokeFromItemId) : null;
    const attrLabel = isItemInvocation
      ? (sourceItem?.name ?? "Item")
      : (cfg.attributeLabels?.[sys.attribute] ?? sys.attribute);

    // Longshot (feat): doubles the range of a ranged/non-physical attack with the
    // chosen weapon (by base type) or attack type (matching the action's damage
    // type). Melee has no range to double.
    const longshotWeapon = sys.weaponId ? this.actor.items.get(sys.weaponId) : null;
    const longshot = cfg.longshotRangeMultiplier
      ? cfg.longshotRangeMultiplier(this.actor, { weapon: longshotWeapon, damageType: sys.damageType })
      : { multiplier: 1, label: "" };
    const lsMult = longshot.multiplier;

    let range = "Melee";
    if ( sys.rangeMode === "ranged" ) {
      const band = cfg.rangeBands?.[sys.rangeBand];
      const feet = band ? band.feet * lsMult : 0;
      range = band ? `${feet} ft${lsMult > 1 ? " (Longshot ×2)" : ""}` : "Ranged";
    } else if ( sys.rangeMode === "non-physical" ) {
      const score = Number(this.actor.system?.attributes?.[sys.attribute]?.value ?? 0);
      const feet = (cfg.nonPhysicalRange ? cfg.nonPhysicalRange(score) : 0) * lsMult;
      range = feet ? `${feet} ft${lsMult > 1 ? " (Longshot ×2)" : ""}` : "—";
    }

    let target = cfg.targetModes?.[sys.targets] ?? sys.targets;
    if ( sys.targets === "area" ) {
      const shapeKey = sys.area?.shape;
      const shape = cfg.areaShapes?.[shapeKey] ?? shapeKey ?? "";
      // Size readout: line → "(N×5)'×10'×10'", cube/cone → "N'".
      let size = "";
      if ( shapeKey === "line" ) {
        const n = Math.max(1, Math.floor(Number(sys.area?.lines ?? 1)));
        size = `5'×${n * 10}'×10'`;
      } else {
        const len = Math.max(0, Math.floor(Number(sys.area?.length ?? 0)));
        if ( len > 0 ) size = `${len}'`;
      }
      target = `Area (${[shape, size].filter(Boolean).join(" ")})`;
    } else if ( sys.targets === "multiple" ) {
      const n = Math.max(1, Number(sys.targetCount ?? 0));
      target = `Multiple (${n})`;
    }

    // Damaging and bane actions resolve against a chosen defense (Guard / Toughness / Resolve).
    const usesDefense = (sys.actionCategory === "damaging") || (sys.actionCategory === "bane");
    const targetDefense = usesDefense ? (cfg.targetDefenses?.[sys.targetDefense] ?? "") : "";

    // Damaging actions also carry a damage type (built-in or user-defined).
    const damageType = (sys.actionCategory === "damaging")
      ? ((cfg.allDamageTypes ? cfg.allDamageTypes() : (cfg.damageTypes ?? {}))[sys.damageType] ?? "")
      : "";

    // Bane actions carry a chosen bane invoked at a power level.
    const bane = (sys.actionCategory === "bane") && sys.baneName
      ? `${sys.baneName}${sys.invokePowerLevel ? ` (PL ${sys.invokePowerLevel})` : ""}`
      : "";

    // Boon actions carry a chosen boon invoked at a power level.
    const boon = (sys.actionCategory === "boon") && sys.boonName
      ? `${sys.boonName}${sys.invokePowerLevel ? ` (PL ${sys.invokePowerLevel})` : ""}`
      : "";

    // Aura (boon) radiates a chosen bane/boon — shown in the detail panel.
    const isAura = (sys.actionCategory === "boon") && (String(sys.boonName ?? "").trim().toLowerCase() === "aura");
    const aura = (isAura && sys.auraRadiateName)
      ? `${sys.auraRadiateName}${sys.auraRadiatePowerLevel ? ` (PL ${sys.auraRadiatePowerLevel})` : ""}`
      : "";
    const auraKind = aura ? (sys.auraRadiateKind || "") : "";
    const auraUuid = aura ? (sys.auraRadiateUuid || "") : "";
    const auraPl = Math.max(0, Math.floor(Number(sys.auraRadiatePowerLevel ?? 0)));
    // Drag payload for dropping the radiated bane/boon onto a token — the SAME
    // shape the canvas drop handler (dropCanvasData) consumes for chat-card chips.
    let auraDrag = "";
    if ( auraUuid && (auraKind === "bane" || auraKind === "boon") ) {
      const escape = foundry.utils.escapeHTML ?? (s => s);
      const payload = (auraKind === "bane")
        ? { type: "openlegend.bane", baneUuid: auraUuid, baneName: sys.auraRadiateName ?? "", powerLevel: auraPl, potent: false }
        : { type: "openlegend.boon", boonUuid: auraUuid, boonName: sys.auraRadiateName ?? "", powerLevel: auraPl };
      auraDrag = escape(JSON.stringify(payload));
    }

    // Interrupt actions are either a Defend or an Improvise.
    const interruptType = (sys.actionCategory === "interrupt")
      ? (cfg.interruptTypes?.[sys.interruptType] ?? "")
      : "";

    // Category key + an icon for the detail-panel header badge / colour accent.
    const categoryKey = sys.actionCategory;
    const categoryIcon = ({
      damaging: "fa-burst", bane: "fa-skull", boon: "fa-hands-holding", interrupt: "fa-shield-halved"
    })[categoryKey] ?? "fa-circle";

    // Boons beat a fixed Challenge Rating (CR = 10 + 2·PL). No level is chosen up
    // front — invokePowerLevel is auto-maintained as the highest defined level the
    // score reaches, so this shows the best attemptable level's CR.
    const boonCr = (sys.actionCategory === "boon")
      ? (cfg.boonChallengeRating ? cfg.boonChallengeRating(sys.invokePowerLevel) : (10 + 2 * Number(sys.invokePowerLevel ?? 0)))
      : null;

    // The collapsed row's "resolves" qualifier, shown after the attribute:
    //  - damaging / bane → "vs. <Defense>"
    //  - boon            → "vs. CR <N>"
    //  - interrupt       → the interrupt type (Defend / Improvise)
    let resolve = "";
    if ( (categoryKey === "damaging") || (categoryKey === "bane") ) resolve = targetDefense ? `vs. ${targetDefense}` : "";
    else if ( categoryKey === "boon" ) resolve = (boonCr !== null) ? `vs. CR ${boonCr}` : "";
    else if ( categoryKey === "interrupt" ) resolve = interruptType;

    // The invoked bane/boon's name + uuid: the collapsed row shows the chosen
    // bane/boon (with an "open" icon) in place of the range column. The uuid lets
    // the icon open the bane/boon document for the player to read.
    const invokeName = (categoryKey === "bane") ? (sys.baneName ?? "")
      : (categoryKey === "boon") ? (sys.boonName ?? "") : "";
    const invokeUuid = (categoryKey === "bane") ? (sys.baneUuid ?? "")
      : (categoryKey === "boon") ? (sys.boonUuid ?? "") : "";
    const invokeLabel = invokeName
      ? `${invokeName}${sys.invokePowerLevel ? ` (PL ${sys.invokePowerLevel})` : ""}`
      : "";

    return {
      attribute: attrLabel,
      actionType: cfg.actionTypes?.[sys.actionType] ?? sys.actionType,
      range,
      target,
      targetDefense,
      boonCr,
      resolve,
      damageType,
      bane,
      boon,
      aura,
      auraKind,
      auraUuid,
      auraDrag,
      interruptType,
      invokeName,
      invokeUuid,
      invokeLabel,
      categoryKey,
      categoryIcon
    };
  }

  /**
   * Build the itemized advantage/disadvantage preview for an action's expanded
   * row — the SAME breakdown the roll dialog pre-fills (prepareActionRoll's
   * sources): the action's own adv/dis, weapon grip, feats, conditions /
   * active-effect modifiers, multi-targeting, etc. Each row is normalized to
   * {label, advantage, disadvantage} (one of adv/dis is 0); also returns the net
   * (positive = advantage). Never throws — a failure yields an empty preview.
   * @param {Item} action
   * @returns {Promise<{rows: Array, net: number, netAbs: number}>}
   * @private
   */
  async _deriveActionModifiers(action) {
    let rows = [];
    try {
      const ctx = await prepareActionRoll(action, this.actor, { quiet: true });
      rows = (ctx?.sources ?? []).map(m => ({
        label: m.label,
        advantage: Math.max(0, Number(m.advantage ?? 0)),
        disadvantage: Math.max(0, Number(m.disadvantage ?? 0))
      })).filter(m => m.advantage || m.disadvantage);
    } catch ( err ) {
      console.error(`OpenLegend | could not build modifier preview for "${action.name}":`, err);
    }
    const net = rows.reduce((s, m) => s + m.advantage - m.disadvantage, 0);
    return { rows, net, netAbs: Math.abs(net) };
  }

  /**
   * Compute how many attribute points have been spent versus the budget available
   * at the character's current level. Each attribute's cost is the triangular
   * cost-to-reach-score (1+2+…+N), not the raw score. See
   * CONFIG.OPENLEGEND.costForScore and CONFIG.OPENLEGEND.budgetForLevel.
   * @param {object} attributes
   * @param {number} level  The character's current level.
   * @returns {{attributeMax: number, attributeSpent: number, attributeRemaining: number, over: boolean, level: number}}
   * @private
   */
  /**
   * Build the Feats-tab context: each owned feat as a display row (current tier,
   * cumulative cost, next-tier cost, whether it can rise, and prerequisite status
   * for the current/next tier), the feat-point budget (available from level vs.
   * total spent), and the compendium picker for adding feats. Soft enforcement:
   * over-budget and unmet prerequisites are surfaced, never blocked.
   * @param {object} context
   * @private
   */
  async _prepareFeats(context) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    const feats = this.actor.items.filter(i => i.type === "feat");

    // The Alternate Form feat is taken on the Main form only. On a secondary form,
    // hide it from the owned-feat list and the picker (you can't take/manage it
    // there). Keyed on the DISPLAYED form: while previewing Main the feat is
    // shown/selectable; while previewing an alternate form it isn't.
    const displayedFormId = this.#previewFormId ?? Forms.activeFormId(this.document);
    const onSecondaryForm = ["character", "npc"].includes(this.actor.type)
      && (displayedFormId !== Forms.MAIN_FORM_ID);
    const isAltFeat = f => (f.system?.baseName || f.name) === Forms.ALTERNATE_FORM_FEAT;

    let spent = 0;
    const TextEditor = foundry.applications.ux.TextEditor.implementation;
    const rows = [];
    for ( const feat of feats ) {
      // Hide the Alternate Form feat from a secondary form's feat list.
      if ( onSecondaryForm && isAltFeat(feat) ) continue;
      const sys = feat.system ?? {};
      const tier = Math.max(1, Number(sys.purchasedTier ?? 1));
      const maxTier = Math.max(1, Number(sys.maxTier ?? 1));
      const cost = cfg.featCostForTier ? cfg.featCostForTier(sys.cost ?? [], tier) : 0;
      spent += cost;

      const tiers = sys.tiers ?? [];
      const curPre = tiers[tier - 1]?.prerequisites ?? {};
      const nextPre = tiers[tier]?.prerequisites ?? {};
      const curCheck = cfg.checkPrerequisite ? cfg.checkPrerequisite(this.actor, curPre) : { met: true, unmet: [], unverifiable: [] };
      const canRaise = tier < maxTier;
      const nextCost = canRaise
        ? Number((sys.cost ?? [])[tier] ?? (sys.cost ?? [])[(sys.cost ?? []).length - 1] ?? 0)
        : 0;

      // Battle Trance is a TOGGLED feat: surface its on/off state so the row can
      // show a drag-to-macro toggle button.
      const isBattleTrance = (sys.baseName || feat.name) === (cfg.BATTLE_TRANCE_BASE ?? "Battle Trance");

      // Per-tier effect text for the tiers actually purchased (tiers are
      // cumulative — owning Tier 2 grants Tier 1's effect as well).
      const tierEffects = (await Promise.all(tiers.slice(0, tier).map(async t => ({
        tier: t?.tier,
        effect: String(t?.effect ?? "").trim()
          ? await TextEditor.enrichHTML(t.effect, { relativeTo: feat, secrets: this.actor.isOwner })
          : ""
      })))).filter(t => t.effect);
      rows.push({
        id: feat.id,
        name: feat.name,
        img: feat.img,
        choice: sys.choice?.value ?? "",
        choiceLabel: sys.choice?.label || "Choice",
        tier,
        maxTier,
        multiTier: maxTier > 1,
        isToggle: isBattleTrance,
        toggleOn: isBattleTrance && !!feat.flags?.openlegend?.battleTranceActive,
        cost,
        canRaise,
        canLower: tier > 1,
        nextCost,
        prerequisite: cfg.formatPrerequisite ? cfg.formatPrerequisite(curPre) : "",
        prereqMet: curCheck.met,
        prereqUnmet: curCheck.unmet,
        nextPrerequisite: canRaise && cfg.formatPrerequisite ? cfg.formatPrerequisite(nextPre) : "",
        tags: sys.tags ?? [],
        effect: await TextEditor.enrichHTML(sys.effect ?? "", { relativeTo: feat, secrets: this.actor.isOwner }),
        tierEffects
      });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    context.feats = rows;

    // Feat-point budget from the character's level (characters & companions; NPCs just
    // see the list without a budget). Companions override `available` to their tier
    // allowance in _prepareCompanion. A character that has granted feat points to its
    // companions (Companion feat Tier 3) has its available reduced by that amount.
    if ( (this.actor.type === "character") || (this.actor.type === "companion") ) {
      // Characters budget feat points by XP (1 per XP + 6 base — see budgetForXp);
      // companions still use the level table (overridden to their tier below).
      const baseFeat = (this.actor.type === "character")
        ? (cfg.budgetForXp ? cfg.budgetForXp(this.actor.system.xp).featPoints : 0)
        : (cfg.budgetForLevel ? cfg.budgetForLevel(this.actor.system.level).featPoints : 0);
      const granted = (this.actor.type === "character")
        ? Companion.grantedFeatPointsByParent(this.actor) : 0;
      const available = Math.max(0, baseFeat - granted);
      context.featBudget = {
        available,
        spent,
        remaining: available - spent,
        over: spent > available,
        granted: granted || 0
      };
    }

    // Picker: compendium feats the actor doesn't already own. Owned copies are
    // matched by their compendium (base) name, since choice feats decorate the
    // owned copy's name ("Bane Focus — Slowed"). Multi-take feats stay in the
    // picker — each additional take just needs a different choice.
    const exclude = feats
      .filter(f => !f.system?.multi)
      .map(f => ({ name: f.system?.baseName || f.name }));
    // On a secondary form, the Alternate Form feat is not selectable (it's a multi-take
    // feat, so it wouldn't otherwise be excluded by ownership).
    if ( onSecondaryForm ) exclude.push({ name: Forms.ALTERNATE_FORM_FEAT });
    context.featPicker = {
      options: await this._getCompendiumOptions("tomucatos-open-legend-rpg-system.feats", exclude, "feat")
    };
  }

  /**
   * Build the Alternate Forms tab bar + Transform button context (characters &
   * NPCs). Tabs only VIEW a form (read-only preview via the actor-getter clone);
   * `context.forms.transform` feeds the Actions-section Transform button — the
   * one control that actually changes the active form (and applies its token
   * image). All display fields derive from the DISPLAYED form: the previewed one
   * when previewing, else the active one. Data lives in flags (module/forms.mjs).
   * @param {object} context
   * @private
   */
  _prepareForms(context) {
    if ( !["character", "npc"].includes(this.actor.type) ) { context.forms = { show: false }; return; }
    // The form bar is gated on owning the Alternate Form feat. Without it, hide the
    // controls entirely (any stored data is cleared when the feat is removed).
    if ( !Forms.hasAlternateFormFeat(this.actor) ) { context.forms = { show: false }; return; }
    const forms = Forms.getForms(this.actor);
    const activeId = Forms.activeFormId(this.actor);
    const activeForm = forms.find(f => f.id === activeId) ?? forms[0];
    // The DISPLAYED form: the read-only previewed one when a non-active tab was
    // clicked, else the live (active) form. All display context derives from it.
    const shown = (this.#previewFormId && forms.find(f => f.id === this.#previewFormId)) || activeForm;
    const isPreview = shown.id !== activeForm.id;
    const shownTier = Forms.formTier(shown);          // 0 for Main, else 1/2
    // Transform target: the previewed form when viewing one, else the next form
    // in order (a simple toggle when there are just Main + one alternate).
    let transformTarget = isPreview ? shown : null;
    if ( !transformTarget && (forms.length > 1) ) {
      const idx = forms.findIndex(f => f.id === activeForm.id);
      transformTarget = forms[(idx + 1) % forms.length];
    }
    context.forms = {
      show: true,
      active: activeId,
      activeName: activeForm.name,
      shownId: shown.id,
      preview: isPreview ? { id: shown.id, name: shown.name } : null,
      activeTier: shownTier,
      isAlternate: shownTier > 0,
      activeImg: (shown.id === Forms.MAIN_FORM_ID) ? this.document.img : (shown.img || this.document.img),
      activeTokenImg: shown.tokenImg || shown.img || this.document.img,
      transform: transformTarget ? { targetId: transformTarget.id, targetName: transformTarget.name } : null,
      tabs: forms.map(f => ({
        id: f.id,
        name: f.name,
        active: f.id === activeId,
        viewed: f.id === shown.id,
        isMain: f.id === Forms.MAIN_FORM_ID,
        tier: Forms.formTier(f)
      }))
    };

    // Alternate forms cap attribute & feat points by tier, derived from the Main
    // form's level budget (SRD). Override the displayed allowances (spent values are
    // already computed from the form's own attributes/feats).
    if ( shownTier > 0 ) {
      const budget = Forms.formBudget(this.actor, shown);
      if ( budget && context.creation ) {
        context.creation.attributeMax = budget.attributePoints;
        context.creation.attributeRemaining = budget.attributePoints - context.creation.attributeSpent;
        context.creation.over = context.creation.attributeSpent > budget.attributePoints;
        context.creation.altFormTier = budget.tier;
      }
      if ( budget && context.featBudget ) {
        context.featBudget.available = budget.featPoints;
        context.featBudget.remaining = budget.featPoints - context.featBudget.spent;
        context.featBudget.over = context.featBudget.spent > budget.featPoints;
        context.featBudget.altFormTier = budget.tier;
      }
    }
  }

  /**
   * Companion context. On a COMPANION actor: expose its tier (+ a tier selector) and
   * override the attribute/feat budgets with the tier-derived allowance (20+4/lvl or
   * 30+6/lvl attributes by tier; 0/3/3 feat points by tier, plus any parent-granted
   * points at Tier 3). On a PARENT character: expose its linked companions for the
   * "View Companion" button.
   * @param {object} context
   * @private
   */
  _prepareCompanion(context) {
    if ( this.actor.type === "companion" ) {
      const sys = this.actor.system?.companion ?? {};
      const tier = Math.max(1, Math.min(3, Math.floor(Number(sys.tier) || 1)));
      const parent = Companion.companionParent(this.actor);
      const parentLevel = Number(parent?.system?.level ?? this.actor.system?.level ?? 1);
      const budget = Companion.companionBudget(tier, parentLevel);
      const granted = Math.max(0, Math.floor(Number(sys.grantedFeatPoints) || 0));
      const featAvailable = budget.featPoints + ((tier >= 3) ? granted : 0);

      context.companion = {
        isCompanion: true,
        tier,
        parentLinked: !!parent,
        parentName: parent?.name ?? "(unlinked)",
        canGrantFeats: tier >= 3,
        grantedFeatPoints: granted
      };

      // Override the advisory budgets with the tier-derived allowances.
      if ( context.creation ) {
        context.creation.attributeMax = budget.attributePoints;
        context.creation.attributeRemaining = budget.attributePoints - context.creation.attributeSpent;
        context.creation.over = context.creation.attributeSpent > budget.attributePoints;
        context.creation.companionTier = tier;
      }
      if ( context.featBudget ) {
        context.featBudget.available = featAvailable;
        context.featBudget.remaining = featAvailable - context.featBudget.spent;
        context.featBudget.over = context.featBudget.spent > featAvailable;
        context.featBudget.companionTier = tier;
        context.featBudget.granted = granted;
      }
      return;
    }

    // Parent character: list linked companions (one per Companion feat) for the button.
    if ( this.actor.type === "character" ) {
      const list = [];
      for ( const feat of Companion.companionFeats(this.actor) ) {
        const comp = Companion.companionForFeat(this.actor, feat);
        if ( comp ) list.push({ uuid: comp.uuid, name: comp.name });
      }
      context.companions = { show: list.length > 0, list };
    }
  }

  _computeCreationBudget(attributes = {}, level = 1, { xp = null } = {}) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    // Characters budget by XP (points for every XP, not only at level breakpoints —
    // see budgetForXp). Companions/others still budget by level. Fall back to the
    // level table, then a bare default, if the config helpers are unavailable.
    const budget = ((xp !== null) && cfg.budgetForXp)
      ? cfg.budgetForXp(xp)
      : (cfg.budgetForLevel
          ? cfg.budgetForLevel(level)
          : { level: 1, attributePoints: cfg.creation?.attributePoints ?? 40 });
    const costForScore = cfg.costForScore ?? (s => (Number(s) * (Number(s) + 1)) / 2);
    const spent = Object.values(attributes).reduce((sum, a) => sum + costForScore(a.value), 0);
    return {
      level: budget.level,
      attributeMax: budget.attributePoints,
      attributeSpent: spent,
      attributeRemaining: budget.attributePoints - spent,
      over: spent > budget.attributePoints
    };
  }

  /* -------------------------------------------- */
  /*  Render lifecycle                            */
  /* -------------------------------------------- */

  /**
   * Attach the perk/flaw picker change-listener after render. The picker is a
   * <select> whose `change` adds the chosen compendium feature; modelling it as
   * a click `action` would not fire, so it is bound here. ApplicationV2 re-runs
   * _onRender on every render, so guard against double-binding is unnecessary —
   * the elements are freshly created each time.
   * @override
   */
  async _onRender(context, options) {
    await super._onRender(context, options);
    // Battle Trance: ring the whole sheet "on fire" while entranced (works for
    // viewers too, so applied before the editable guard).
    const entranced = !!(CONFIG.OPENLEGEND?.battleTranceActive?.(this.actor));
    this.element?.classList.toggle("ol-battle-trance", entranced);
    // Form preview: everything stays editable — _processSubmitData routes each
    // field to the stored snapshot (form-owned) or the live actor (shared), and
    // the item handlers route by item ownership. The class just drives the amber
    // ring + banner styling.
    this.element?.classList.toggle("ol-form-preview", this.isFormPreview);
    // Remember the Stats/Defenses/Actions panels' open state across re-renders
    // (works for read-only viewers too, so bound before the editable guard).
    for ( const panel of this.element.querySelectorAll("details.vitals[data-vitals]") ) {
      panel.addEventListener("toggle", () => {
        this.#vitalsOpen[panel.dataset.vitals] = panel.open;
      });
    }
    if ( !this.isEditable ) return;
    for ( const select of this.element.querySelectorAll(".feature-add") ) {
      select.addEventListener("change", this.#onFeatureAdd.bind(this));
    }
    // The feat picker (its own <select>) adds the chosen compendium feat.
    for ( const select of this.element.querySelectorAll(".feat-add") ) {
      select.addEventListener("change", this.#onFeatAdd.bind(this));
    }
    // Alternate-form tier selector (drives the form's attribute/feat allowances).
    for ( const select of this.element.querySelectorAll(".ol-form-tier") ) {
      select.addEventListener("change", ev => {
        const id = ev.currentTarget.dataset.formId;
        Forms.setFormTier(this.document, id, ev.currentTarget.value);
      });
    }
    // Companion tier selector (above the header) — keeps the parent's feat tier in sync.
    for ( const select of this.element.querySelectorAll(".ol-companion-tier") ) {
      select.addEventListener("change", ev => {
        Companion.setTierFromCompanion(this.actor, ev.currentTarget.value);
      });
    }
    // Companion (Tier 3): feat points granted by the parent to this companion.
    for ( const input of this.element.querySelectorAll(".ol-companion-granted") ) {
      input.addEventListener("change", ev => {
        const n = Math.max(0, Math.floor(Number(ev.currentTarget.value) || 0));
        this.actor.update({ "system.companion.grantedFeatPoints": n });
      });
    }
    // Clicking a row's controls (edit/delete/equip) or the rollable action name
    // should NOT also toggle the collapsible <details>. Prevent the summary's
    // default toggle when the click originated on one; the action handler still runs.
    for ( const summary of this.element.querySelectorAll(".inv-item > summary") ) {
      summary.addEventListener("click", ev => {
        if ( ev.target.closest(".item-controls, .equip-toggle, .action-roll") ) ev.preventDefault();
      });
    }

    // The Resist control is draggable to the hotbar → a "resist banes" macro for
    // this actor. The payload is read by the hotbarDrop hook in openlegend.mjs.
    for ( const el of this.element.querySelectorAll(".resist-banes") ) {
      el.addEventListener("dragstart", ev => {
        ev.dataTransfer.setData("text/plain", JSON.stringify({
          type: "openlegend.resist", actorUuid: this.actor.uuid, name: this.actor.name
        }));
        ev.dataTransfer.effectAllowed = "copy";
      });
    }

    // The Hospitaler control is draggable to the hotbar → a "hospitaler resist"
    // macro for this actor (read by the hotbarDrop hook in openlegend.mjs).
    for ( const el of this.element.querySelectorAll(".hospitaler-action") ) {
      el.addEventListener("dragstart", ev => {
        ev.stopPropagation();
        ev.dataTransfer.setData("text/plain", JSON.stringify({
          type: "openlegend.hospitaler", actorUuid: this.actor.uuid, name: this.actor.name
        }));
        ev.dataTransfer.effectAllowed = "copy";
      });
    }

    // The Battle Trance toggle is draggable to the hotbar → a toggle macro for
    // this actor (read by the hotbarDrop hook in openlegend.mjs).
    for ( const el of this.element.querySelectorAll(".feat-toggle") ) {
      el.addEventListener("dragstart", ev => {
        ev.stopPropagation();
        ev.dataTransfer.setData("text/plain", JSON.stringify({
          type: "openlegend.battleTrance", actorUuid: this.actor.uuid, name: this.actor.name
        }));
        ev.dataTransfer.effectAllowed = "copy";
      });
    }

    // The Reckless Attack control is draggable to the hotbar → a macro that deals
    // the 5 HP self-damage and announces the extra attack (read by the hotbarDrop
    // hook in openlegend.mjs).
    for ( const el of this.element.querySelectorAll(".reckless-action") ) {
      el.addEventListener("dragstart", ev => {
        ev.stopPropagation();
        ev.dataTransfer.setData("text/plain", JSON.stringify({
          type: "openlegend.recklessAttack", actorUuid: this.actor.uuid, name: this.actor.name
        }));
        ev.dataTransfer.effectAllowed = "copy";
      });
    }

    // An Aura action's radiated bane/boon chip is draggable onto a token to apply
    // it — the data-aura-drag payload is the same {type:"openlegend.bane|boon", …}
    // the canvas drop handler (dropCanvasData in openlegend.mjs) consumes.
    for ( const el of this.element.querySelectorAll(".action-aura-chip[draggable='true']") ) {
      el.addEventListener("dragstart", ev => {
        ev.stopPropagation();
        const payload = el.dataset.auraDrag;
        if ( payload ) ev.dataTransfer.setData("text/plain", payload);
        ev.dataTransfer.effectAllowed = "copy";
      });
    }

    // Each Attributes-tab roll button is draggable to the hotbar → a macro that
    // rolls that attribute (read by the hotbarDrop hook in openlegend.mjs). The
    // substituted row carries data-substituted so its macro rolls the substituted dice.
    for ( const el of this.element.querySelectorAll(".attribute-roll") ) {
      el.addEventListener("dragstart", ev => {
        ev.stopPropagation();
        const key = el.dataset.attribute;
        const substituted = el.dataset.substituted === "true";
        const label = CONFIG.OPENLEGEND?.attributeLabels?.[key]
          ?? this.actor.system.attributes?.[key]?.label ?? key;
        ev.dataTransfer.setData("text/plain", JSON.stringify({
          type: "openlegend.attribute", actorUuid: this.actor.uuid, key, label, substituted
        }));
        ev.dataTransfer.effectAllowed = "copy";
      });
    }
  }

  /* -------------------------------------------- */
  /*  Action handlers                             */
  /* -------------------------------------------- */

  /**
   * Add the selected compendium perk/flaw to the actor as an embedded Item.
   * Soft rules: the recommended cap only warns — the add always goes through.
   * @param {Event} event
   * @private
   */
  async #onFeatureAdd(event) {
    event.preventDefault();
    const select = event.currentTarget;
    const uuid = select.value;
    const type = select.dataset.type; // "perk" | "flaw"
    if ( !uuid ) return;

    const max = type === "flaw" ? OpenLegendActorSheet.MAX_FLAWS : OpenLegendActorSheet.MAX_PERKS;
    const current = this.actor.items.filter(i => i.type === type).length;
    if ( current >= max ) {
      ui.notifications?.warn(`Characters normally have at most ${max} ${type}s — adding anyway (check with your GM).`);
    }

    const doc = await fromUuid(uuid);
    if ( !doc ) {
      ui.notifications?.warn("Selected entry could not be found.");
      return;
    }
    // Perks/flaws are SHARED across forms — always created on the live actor
    // (this.document; this.actor is the clone while previewing a form).
    await this.document.createEmbeddedDocuments("Item", [doc.toObject()]);
  }

  /**
   * Create a blank CUSTOM perk/flaw on the actor and open its item sheet, the
   * same editing experience as creating one from the Items sidebar. Soft rules:
   * exceeding the recommended count only warns, same as the picker.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  The control carrying data-type ("perk" | "flaw").
   */
  static async #onFeatureCreate(event, target) {
    event.preventDefault();
    const type = target.dataset.type === "flaw" ? "flaw" : "perk";

    const max = type === "flaw" ? OpenLegendActorSheet.MAX_FLAWS : OpenLegendActorSheet.MAX_PERKS;
    const current = this.actor.items.filter(i => i.type === type).length;
    if ( current >= max ) {
      ui.notifications?.warn(`Characters normally have at most ${max} ${type}s — adding anyway (check with your GM).`);
    }

    // Perks/flaws are SHARED across forms — always created on the live actor.
    const [created] = await this.document.createEmbeddedDocuments("Item", [{
      name: `New ${type.capitalize()}`,
      type,
      img: type === "flaw" ? "icons/svg/unconscious.svg" : "icons/svg/angel.svg"
    }]);
    await OpenLegendActorSheet.#openDocumentSheet(created);
  }

  /**
   * Add the selected compendium feat to the actor at purchased tier 1. Soft rules:
   * no point/prerequisite blocking here — the sheet surfaces over-budget / unmet
   * prerequisites for the GM and player to judge.
   * @param {Event} event
   * @private
   */
  async #onFeatAdd(event) {
    event.preventDefault();
    const uuid = event.currentTarget.value;
    if ( !uuid ) return;
    const doc = await fromUuid(uuid);
    if ( doc?.type !== "feat" ) {
      ui.notifications?.warn("Selected entry is not a feat.");
      return;
    }
    await this.#addFeat(doc);
  }

  /**
   * Embed a feat document on the actor at purchased tier 1. Shared by the feat
   * picker and the drag-drop handler so both behave identically. Soft rules: no
   * point/prerequisite blocking.
   *
   * Choice feats (system.choice.type — Bane Focus, Boon Focus, Attack
   * Specialization, ...) prompt for the choice before embedding; the pick is
   * stored in system.choice.value and appended to the owned copy's name
   * ("Bane Focus — Slowed"). Multi-take feats (system.multi) may be owned any
   * number of times, once per distinct choice; everything else is blocked when
   * a copy of the same compendium feat is already owned (raise its tier
   * instead).
   * @param {Item} doc  A feat Item (from the compendium or elsewhere).
   * @returns {Promise<Item|null>}  The created feat, or null if skipped.
   * @private
   */
  async #addFeat(doc) {
    if ( doc?.type !== "feat" ) return null;
    const sys = doc.system ?? {};
    const base = sys.baseName || doc.name;

    // The Alternate Form feat may only be taken on the Main form (you take it once, on
    // your primary persona). Block adding it to a secondary form — keyed on the
    // DISPLAYED form, so it CAN be taken while previewing Main from an alternate form.
    const displayedFormId = this.#previewFormId ?? Forms.activeFormId(this.document);
    if ( (base === Forms.ALTERNATE_FORM_FEAT)
      && ["character", "npc"].includes(this.actor.type)
      && (displayedFormId !== Forms.MAIN_FORM_ID) ) {
      ui.notifications?.warn("The Alternate Form feat is taken on your Main form, not on an alternate form.");
      return null;
    }

    const owned = this.actor.items.filter(i =>
      (i.type === "feat") && ((i.system?.baseName || i.name) === base)
    );

    // Non-multi feats: one copy only — raise its tier instead.
    if ( owned.length && !sys.multi ) {
      ui.notifications?.warn(`${base} is already owned — raise its tier instead.`);
      this.render();
      return null;
    }

    const data = doc.toObject();
    data.system.purchasedTier = 1;     // owned at tier 1 on add
    data.system.baseName = base;

    // Purchase-time choice: prompt unless the dropped item already carries one
    // (e.g. a customized feat dragged over from another actor).
    const choice = data.system.choice ?? {};
    if ( choice.type && !choice.value ) {
      // Attack Specialization has bespoke automation: a weapon (matched by base
      // type) OR a damage type, mutually exclusive. Store the structured pick in a
      // flag (read at roll time by attackSpecializationAdvantage) and the readable
      // label in choice.value (for the name suffix + multi-take dedup).
      if ( base === CONFIG.OPENLEGEND?.ATTACK_SPEC_BASE ) {
        const spec = await this.#promptAttackSpecialization(doc);
        if ( spec === null ) return null;         // cancelled
        data.system.choice.value = spec.label;
        foundry.utils.setProperty(data, "flags.openlegend.attackSpec", spec);
      } else if ( base === CONFIG.OPENLEGEND?.LONGSHOT_BASE ) {
        // Longshot: like Attack Specialization, a weapon (matched by base type) OR
        // an attack type (matched by an action's damage type / attribute). With
        // the chosen weapon/type, the attack's range is doubled (read in
        // _deriveActionDisplay via longshotRangeMultiplier).
        const ls = await this.#promptLongshot(doc);
        if ( ls === null ) return null;           // cancelled
        data.system.choice.value = ls.label;
        foundry.utils.setProperty(data, "flags.openlegend.longshot", ls);
      } else if ( base === CONFIG.OPENLEGEND?.MARTIAL_FOCUS_BASE ) {
        // Martial Focus: a weapon (by base type) OR unarmed combat, plus the focus
        // attribute (Agility or Might). Matching attacks get +1 attribute dice; all
        // other attacks suffer disadvantage 1 (read at roll time via martialFocus).
        const mf = await this.#promptMartialFocus(doc);
        if ( mf === null ) return null;           // cancelled
        data.system.choice.value = mf.label;
        foundry.utils.setProperty(data, "flags.openlegend.martialFocus", mf);
      } else if ( base === CONFIG.OPENLEGEND?.BOON_ACCESS_BASE ) {
        // Boon Access: pick a boon, the invoking attribute, and the ATTRIBUTE
        // LEVEL you buy (≥ the boon's minimum PL). That level is the cost AND the
        // effective invocation score (ba.powerLevel). Stored in a flag, read at
        // action-build + roll time (PL-as-bought-score dice via item-invocation).
        const ba = await this.#promptBoonAccess(doc);
        if ( ba === null ) return null;           // cancelled
        data.system.choice.value = ba.label;
        foundry.utils.setProperty(data, "flags.openlegend.boonAccess", {
          boonUuid: ba.boonUuid, boonName: ba.boonName, attribute: ba.attribute, powerLevel: ba.powerLevel
        });
        // Cost = the bought attribute level (per the feat); store it so the
        // feat-row cost + budget reflect it.
        data.system.cost = [ba.powerLevel];
      } else if ( base === CONFIG.OPENLEGEND?.EXTRAORDINARY_FOCUS_BASE ) {
        // Extraordinary Focus: a free-text focus item (bookkeeping) + the
        // empowered extraordinary attribute. The attribute is read at roll time
        // (extraordinaryFocusBonus → +1 dice step); the focus is descriptive.
        const ef = await this.#promptExtraordinaryFocus(doc, owned);
        if ( ef === null ) return null;           // cancelled
        data.system.choice.value = ef.label;
        foundry.utils.setProperty(data, "flags.openlegend.extraordinaryFocus", {
          attribute: ef.attribute, focus: ef.focus
        });
      } else {
        const value = await this.#promptFeatChoice(doc, owned);
        if ( value === null ) return null;        // dialog cancelled
        data.system.choice.value = value;
      }
    }

    // Attribute Substitution: a primary + dependent attribute pick (the choice
    // type is empty in the pack, so this is keyed off the base name). Stored in a
    // flag (read in prepareDerivedData by attributeSubstitutions) with the label
    // appended to the name. Prompted even though choice.type is empty.
    if ( (base === CONFIG.OPENLEGEND?.ATTR_SUBSTITUTION_BASE) && !data.system.choice?.value ) {
      const sub = await this.#promptAttributeSubstitution(doc);
      if ( sub === null ) return null;            // cancelled
      data.system.choice = { ...(data.system.choice ?? {}), value: sub.label };
      foundry.utils.setProperty(data, "flags.openlegend.substitution", { primary: sub.primary, dependent: sub.dependent });
    }

    // Multi-take feats: each copy must be a different choice.
    if ( owned.length && sys.multi ) {
      const norm = s => String(s ?? "").trim().toLowerCase();
      if ( owned.some(i => norm(i.system?.choice?.value) === norm(data.system.choice?.value)) ) {
        ui.notifications?.warn(
          `${base} is already owned with that choice — pick a different ${choice.label || "option"}.`
        );
        this.render();
        return null;
      }
    }

    // Decorate the owned copy's name with the pick so multiple takes are
    // distinguishable everywhere (sheet rows, chat, the items directory).
    if ( data.system.choice?.value ) data.name = `${base} — ${data.system.choice.value}`;

    // While previewing a form, the feat belongs to THAT form: it goes into the
    // stored snapshot (the live actor keeps the active form's items) and only
    // materializes as a real embedded Item when the form is transformed into.
    // The Alternate Form / Companion linked-resource creation still runs, with
    // the flag writes routed into the snapshot copy.
    if ( this.isFormPreview ) {
      const previewId = this.#previewFormId;
      const newId = await Forms.addItemToForm(this.document, previewId, data);
      if ( !newId ) return null;
      if ( base === Forms.ALTERNATE_FORM_FEAT ) {
        const formName = String(data.system.choice?.value ?? "").trim();
        const formId = await Forms.addForm(this.document, { formName, switch: false, featId: newId });
        if ( formId ) await Forms.updateItemInForm(this.document, previewId, newId, { "flags.openlegend.formId": formId });
      }
      if ( (base === Companion.COMPANION_FEAT) && (this.document.type === "character") ) {
        const cname = String(data.system.choice?.value ?? "").trim();
        const comp = await Companion.createCompanion(this.document, { name: cname, tier: 1, featId: newId });
        if ( comp ) await Forms.updateItemInForm(this.document, previewId, newId, { "flags.openlegend.companionUuid": comp.uuid });
      }
      this.render(false);
      return null;                        // no live Item document exists yet
    }

    const [created] = await this.actor.createEmbeddedDocuments("Item", [data]);

    // Alternate Form feat: the "Form name" choice creates a new (empty) alternate form
    // carrying that name, LINKED to this feat (1:1). We stay on Main (don't switch) so
    // the player keeps building their primary persona; the new tab is ready to enter.
    // Removing this feat later removes only its linked form (see #removeAlternateFormFeat).
    if ( (base === Forms.ALTERNATE_FORM_FEAT) && created ) {
      const formName = String(created.system?.choice?.value ?? "").trim();
      const formId = await Forms.addForm(this.actor, { formName, switch: false, featId: created.id });
      // NB: use update() not setFlag() — Foundry's setFlag validates the scope against
      // registered modules/system-id and rejects the bare "openlegend" namespace the
      // system uses for its flags (the valid scope id is "tomucatos-open-legend-rpg-system").
      if ( formId ) await created.update({ "flags.openlegend.formId": formId });
    }

    // Companion feat: the "Companion name" choice creates a linked companion Actor at
    // level = this character's level and tier = the feat's tier (1 on add), tied 1:1.
    // Raising/lowering the feat tier syncs the companion; removing it removes the
    // companion (see #onFeatRaise/#onFeatLower/#removeCompanionFeat). Companions can
    // only be created on a regular character (not on another companion).
    if ( (base === Companion.COMPANION_FEAT) && created && (this.actor.type === "character") ) {
      const name = String(created.system?.choice?.value ?? "").trim();
      const comp = await Companion.createCompanion(this.actor, {
        name, tier: Companion.featTier(created), featId: created.id
      });
      // update() not setFlag() — see the formId note above (scope-validation throws on
      // the bare "openlegend" namespace, which previously aborted the re-render below).
      if ( comp ) await created.update({ "flags.openlegend.companionUuid": comp.uuid });
      // The parent sheet may have rendered before the companion existed/was linked —
      // re-render now that it's committed so the "View Companion" button appears at once.
      this.render(false);
    }

    return created ?? null;
  }

  /**
   * Resolve the option list for a feat-choice type. Compendium-backed types
   * (bane / boon / weapon) list the matching pack's index plus non-private
   * world items of that type; "attribute" lists
   * the config labels; "energy" / "mode" come from OPENLEGEND.featChoices.
   * "text" (and any unknown type) returns [] — free-form input.
   * @param {string} type
   * @returns {Promise<string[]>}
   * @private
   */
  async #featChoiceOptions(type) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    switch ( type ) {
      case "bane":
      case "boon":
      case "weapon": {
        const pack = game.packs?.get(`tomucatos-open-legend-rpg-system.${type}s`);
        const index = pack ? await pack.getIndex() : [];
        const names = new Set([...index].map(e => e.name));
        // World-created banes/boons/weapons are choosable too, unless Private.
        for ( const item of game.items ?? [] ) {
          if ( item.type !== type ) continue;
          if ( !item.visible || item.system?.private ) continue;
          names.add(item.name);
        }
        return [...names].sort((a, b) => a.localeCompare(b));
      }
      case "attribute":
        return Object.values(cfg.attributeLabels ?? {});
      case "energy":
        // All damage types except Force/Precision (physical), including any the
        // GM added in settings — see OPENLEGEND.energyResistanceChoices.
        return cfg.energyResistanceChoices ? cfg.energyResistanceChoices() : (cfg.featChoices?.energy ?? []).slice();
      case "mode":
      case "craft":
      case "knowledge":
        return (cfg.featChoices?.[type] ?? []).slice();
      default:
        return [];
    }
  }

  /**
   * Prompt the player for a feat's purchase-time choice (Bane Focus's bane,
   * Attack Specialization's weapon, ...). Strict types render a <select>; open
   * types (weapon / energy / text — where the book allows values beyond any
   * list) render a text input with the options as datalist suggestions.
   * Multi-pick feats (choice.count > 1, e.g. Multi-Bane Specialist's two banes)
   * render one field per pick; the picks are joined with " & ".
   * @param {Item} doc            The compendium feat being taken.
   * @param {Item[]} owned        Already-owned copies of the same feat (their
   *                              choices are shown so the player avoids repeats).
   * @returns {Promise<string|null>}  The pick(s), or null if cancelled.
   * @private
   */
  async #promptFeatChoice(doc, owned = []) {
    const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
    const sys = doc.system ?? {};
    const base = sys.baseName || doc.name;
    let { type, label, count } = { count: 1, ...sys.choice };
    // Craft Mundane Item ships with a free-"text" choice; upgrade it to the "craft"
    // type so the dialog offers the suggested-craft datalist (still free-text).
    if ( base === (CONFIG.OPENLEGEND?.CRAFT_MUNDANE_BASE) ) type = "craft";
    // Knowledge ships as free-"text"; upgrade it to "knowledge" so the dialog
    // offers the suggested-sphere datalist (still free-text).
    if ( base === (CONFIG.OPENLEGEND?.KNOWLEDGE_BASE) ) type = "knowledge";
    const picks = Math.max(1, Number(count) || 1);
    const options = await this.#featChoiceOptions(type);
    const open = (CONFIG.OPENLEGEND?.featChoices?.open ?? []).includes(type) || !options.length;

    // Open types (free text + suggestions): a normal <select> of the suggestions
    // PLUS a free-text input — both inline and themed like the rest of the dialog
    // (the native <datalist> popup is unstyleable and floats to the corner). The
    // select fills the input on change; the input value is what's read back, so
    // the player can pick a suggestion OR type their own. Strict types render a
    // plain <select> only.
    const field = i => {
      if ( open ) {
        const sel = options.length
          ? `<select class="ol-choice-suggest" data-target="choice${i}">
               <option value="">— Suggestions —</option>
               ${options.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join("")}
             </select>`
          : "";
        return `
          <div class="ol-choice-open">
            ${sel}
            <input type="text" name="choice${i}" placeholder="${esc(label)}" autocomplete="off" ${i === 0 ? "autofocus" : ""}/>
          </div>`;
      }
      const opts = options.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
      return `<select name="choice${i}">${opts}</select>`;
    };
    const taken = owned
      .map(i => i.system?.choice?.value).filter(Boolean)
      .map(esc).join(", ");

    const content = `
      <div class="ol-feat-choice">
        <p>${esc(doc.name)}: choose ${picks > 1 ? `${picks} different` : "a"} ${esc(label || "option")}.</p>
        ${taken ? `<p class="hint">Already taken: ${taken}</p>` : ""}
        ${Array.from({ length: picks }, (_, i) => `<div class="form-group">${field(i)}</div>`).join("")}
      </div>`;

    const { DialogV2 } = foundry.applications.api;
    const result = await DialogV2.wait({
      window: { title: `${doc.name} — ${label || "Choice"}` },
      classes: ["openlegend"],
      content,
      rejectClose: false,
      render: (event, dialog) => OpenLegendActorSheet.#wireComboboxes(dialog.element),
      buttons: [
        {
          action: "ok",
          label: "Take Feat",
          icon: "fas fa-check",
          default: true,
          callback: (event, button, dialog) => Array.from({ length: picks }, (_, i) =>
            dialog.element.querySelector(`[name="choice${i}"]`)?.value?.trim() ?? ""
          )
        },
        { action: "cancel", label: "Cancel", icon: "fas fa-times" }
      ]
    });
    if ( !Array.isArray(result) ) return null;
    const values = result.filter(Boolean);
    if ( !values.length ) return null;
    // Multi-pick: require distinct values (e.g. two different banes).
    if ( new Set(values.map(v => v.toLowerCase())).size < picks ) {
      ui.notifications?.warn(`Choose ${picks} different ${label || "options"}.`);
      return null;
    }
    return values.join(" & ");
  }

  /**
   * Wire the suggestion selects in a feat-choice dialog: picking a suggestion in a
   * `.ol-choice-suggest` select fills its paired free-text input. Free text is
   * always allowed (the input value is what's read back).
   * @param {HTMLElement} root  The dialog element.
   * @private
   */
  static #wireComboboxes(root) {
    for ( const sel of root.querySelectorAll(".ol-choice-suggest") ) {
      const input = root.querySelector(`[name="${sel.dataset.target}"]`);
      if ( !input ) continue;
      sel.addEventListener("change", () => {
        if ( sel.value ) { input.value = sel.value; sel.value = ""; }
      });
    }
  }

  /**
   * Bespoke purchase-time choice for Attack Specialization: a Weapon select and a
   * Damage Type select that are MUTUALLY EXCLUSIVE — choosing one clears the other
   * (wired in the dialog's render). Returns the structured pick
   * { kind:"weapon"|"damageType", key, label }: for a weapon, `key` is its base
   * type (so any weapon sharing that base type benefits); for a damage type, `key`
   * is the damage-type key. Returns null on cancel / empty.
   * @param {Item} doc  The Attack Specialization feat being taken.
   * @returns {Promise<{kind: string, key: string, label: string}|null>}
   * @private
   */
  async #promptAttackSpecialization(doc) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    const esc = s => foundry.utils.escapeHTML?.(s) ?? s;

    // Weapons from the compendium (so you can specialize without owning one yet).
    // One option per packaged weapon: the LABEL is the weapon's name, the VALUE
    // is its base type (now equal to the name in the pack, but keyed off baseType
    // so a custom-typed weapon still maps to its archetype). Deduped by base type
    // and sorted by the displayed name.
    const pack = game.packs?.get("tomucatos-open-legend-rpg-system.weapons");
    const index = pack ? await pack.getIndex({ fields: ["system.baseType"] }) : [];
    const seen = new Set();
    const weapons = [...index]
      .map(e => ({ name: String(e.name).trim(), base: String(e.system?.baseType || e.name).trim() }))
      .filter(w => w.base && !seen.has(w.base) && seen.add(w.base))
      .sort((a, b) => a.name.localeCompare(b.name));
    const weaponOpts = weapons.map(w => `<option value="${esc(w.base)}">${esc(w.name)}</option>`).join("");

    // Damage types from config (value = key, label = readable name); includes
    // user-defined types.
    const dmgOpts = Object.entries(cfg.allDamageTypes ? cfg.allDamageTypes() : (cfg.damageTypes ?? {}))
      .map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("");

    const content = `
      <div class="ol-attack-spec ol-feat-choice">
        <p>${esc(doc.name)}: specialize in <strong>one</strong> weapon <em>or</em> one damage type (not both).</p>
        <div class="form-group">
          <label>Weapon</label>
          <select name="weapon"><option value="">—</option>${weaponOpts}</select>
        </div>
        <div class="form-group">
          <label>Damage Type</label>
          <select name="damageType"><option value="">—</option>${dmgOpts}</select>
        </div>
        <p class="hint">Advantage equal to this feat's tier applies to a damaging attack with that damage type, or with a weapon of that base type.</p>
      </div>`;

    const { DialogV2 } = foundry.applications.api;
    const result = await DialogV2.wait({
      window: { title: `${doc.name} — Specialization` },
      classes: ["openlegend"],
      content,
      rejectClose: false,
      render: (event, dialog) => {
        const root = dialog.element;
        const wsel = root.querySelector('select[name="weapon"]');
        const dsel = root.querySelector('select[name="damageType"]');
        // Mutually exclusive: picking one clears the other.
        wsel?.addEventListener("change", () => { if ( wsel.value ) dsel.value = ""; });
        dsel?.addEventListener("change", () => { if ( dsel.value ) wsel.value = ""; });
      },
      buttons: [
        { action: "ok", label: "Take Feat", icon: "fas fa-check", default: true,
          callback: (event, button, dialog) => {
            const root = dialog.element;
            return {
              weapon: root.querySelector('select[name="weapon"]')?.value ?? "",
              damageType: root.querySelector('select[name="damageType"]')?.value ?? ""
            };
          } },
        { action: "cancel", label: "Cancel", icon: "fas fa-times" }
      ]
    });
    if ( !result || (typeof result !== "object") ) return null;

    if ( result.weapon ) {
      const label = weapons.find(w => w.base === result.weapon)?.name ?? result.weapon;
      return { kind: "weapon", key: result.weapon, label };
    }
    if ( result.damageType ) {
      const label = (cfg.allDamageTypes ? cfg.allDamageTypes() : (cfg.damageTypes ?? {}))[result.damageType] ?? result.damageType;
      return { kind: "damageType", key: result.damageType, label };
    }
    ui.notifications?.warn("Choose a weapon or a damage type.");
    return null;
  }

  /**
   * Bespoke purchase-time choice for Longshot: a Weapon select and an Attack Type
   * (damage type) select that are MUTUALLY EXCLUSIVE. Returns the structured pick
   * { kind:"weapon"|"attackType", key, label }: for a weapon, `key` is its base
   * type; for an attack type, `key` is the damage-type key (matched against an
   * action's damage type at range-derive time). Returns null on cancel / empty.
   * @param {Item} doc  The Longshot feat being taken.
   * @returns {Promise<{kind: string, key: string, label: string}|null>}
   * @private
   */
  async #promptLongshot(doc) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    const esc = s => foundry.utils.escapeHTML?.(s) ?? s;

    // Weapons: one option per base type (label = name, value = base type). Same
    // derivation as Attack Specialization.
    const pack = game.packs?.get("tomucatos-open-legend-rpg-system.weapons");
    const index = pack ? await pack.getIndex({ fields: ["system.baseType"] }) : [];
    const seen = new Set();
    const weapons = [...index]
      .map(e => ({ name: String(e.name).trim(), base: String(e.system?.baseType || e.name).trim() }))
      .filter(w => w.base && !seen.has(w.base) && seen.add(w.base))
      .sort((a, b) => a.name.localeCompare(b.name));
    const weaponOpts = weapons.map(w => `<option value="${esc(w.base)}">${esc(w.name)}</option>`).join("");

    // Attack types: damage types (value = key, label = readable name); includes
    // user-defined types. Sorted by label.
    const dmgTypes = cfg.allDamageTypes ? cfg.allDamageTypes() : (cfg.damageTypes ?? {});
    const typeOpts = Object.entries(dmgTypes)
      .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
      .map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("");
    const typeLabels = { ...dmgTypes };

    const content = `
      <div class="ol-attack-spec ol-feat-choice">
        <p>${esc(doc.name)}: select <strong>one</strong> weapon <em>or</em> one attack type (not both). Your range with it is doubled.</p>
        <div class="form-group">
          <label>Weapon</label>
          <select name="weapon"><option value="">—</option>${weaponOpts}</select>
        </div>
        <div class="form-group">
          <label>Attack Type</label>
          <select name="attackType"><option value="">—</option>${typeOpts}</select>
        </div>
        <p class="hint">Range is doubled for a ranged attack with that weapon (any of its base type), or whose damage type matches the chosen attack type.</p>
      </div>`;

    const { DialogV2 } = foundry.applications.api;
    const result = await DialogV2.wait({
      window: { title: `${doc.name} — Selection` },
      classes: ["openlegend"],
      content,
      rejectClose: false,
      render: (event, dialog) => {
        const root = dialog.element;
        const wsel = root.querySelector('select[name="weapon"]');
        const tsel = root.querySelector('select[name="attackType"]');
        // Mutually exclusive: picking one clears the other.
        wsel?.addEventListener("change", () => { if ( wsel.value ) tsel.value = ""; });
        tsel?.addEventListener("change", () => { if ( tsel.value ) wsel.value = ""; });
      },
      buttons: [
        { action: "ok", label: "Take Feat", icon: "fas fa-check", default: true,
          callback: (event, button, dialog) => {
            const root = dialog.element;
            return {
              weapon: root.querySelector('select[name="weapon"]')?.value ?? "",
              attackType: root.querySelector('select[name="attackType"]')?.value ?? ""
            };
          } },
        { action: "cancel", label: "Cancel", icon: "fas fa-times" }
      ]
    });
    if ( !result || (typeof result !== "object") ) return null;

    if ( result.weapon ) {
      const label = weapons.find(w => w.base === result.weapon)?.name ?? result.weapon;
      return { kind: "weapon", key: result.weapon, label };
    }
    if ( result.attackType ) {
      const label = typeLabels[result.attackType] ?? result.attackType;
      return { kind: "attackType", key: result.attackType, label };
    }
    ui.notifications?.warn("Choose a weapon or an attack type.");
    return null;
  }

  /**
   * Bespoke purchase-time choice for Martial Focus: a Weapon select (with an
   * "Unarmed combat" option) and an Attribute select limited to Agility / Might.
   * Returns { weapon, attribute, label }: `weapon` is the chosen weapon's base type
   * (or "" for unarmed); `attribute` is the focus attribute key. Read at roll time
   * (martialFocus / martialFocusMatches) for the +1 dice step on matching attacks
   * and disadvantage 1 on all others. Returns null on cancel / empty.
   * @param {Item} doc  The Martial Focus feat being taken.
   * @returns {Promise<{weapon: string, attribute: string, label: string}|null>}
   * @private
   */
  async #promptMartialFocus(doc) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    const esc = s => foundry.utils.escapeHTML?.(s) ?? s;

    // Weapons: one option per base type (label = name, value = base type), same as
    // Attack Specialization. Plus an explicit "Unarmed combat" option (value "").
    const pack = game.packs?.get("tomucatos-open-legend-rpg-system.weapons");
    const index = pack ? await pack.getIndex({ fields: ["system.baseType"] }) : [];
    const seen = new Set();
    const weapons = [...index]
      .map(e => ({ name: String(e.name).trim(), base: String(e.system?.baseType || e.name).trim() }))
      .filter(w => w.base && !seen.has(w.base) && seen.add(w.base))
      .sort((a, b) => a.name.localeCompare(b.name));
    const weaponOpts = weapons.map(w => `<option value="${esc(w.base)}">${esc(w.name)}</option>`).join("");

    // Martial Focus relies on a PHYSICAL attribute: Agility or Might only.
    const attrLabels = cfg.attributeLabels ?? {};
    const physAttrs = ["agility", "might"];
    const attrOpts = physAttrs
      .map(k => `<option value="${esc(k)}">${esc(attrLabels[k] ?? k)}</option>`).join("");

    const content = `
      <div class="ol-attack-spec ol-feat-choice">
        <p>${esc(doc.name)}: choose a single weapon (e.g. Unarmed Strike) and the attribute your focus relies upon.</p>
        <div class="form-group">
          <label>Weapon</label>
          <select name="weapon"><option value="">—</option>${weaponOpts}</select>
        </div>
        <div class="form-group">
          <label>Attribute</label>
          <select name="attribute">${attrOpts}</select>
        </div>
        <p class="hint">Attacks with this weapon &amp; attribute treat the attribute as one greater for attribute dice. All other attacks (any weapon, bane, or damaging) suffer disadvantage 1.</p>
      </div>`;

    const { DialogV2 } = foundry.applications.api;
    const result = await DialogV2.wait({
      window: { title: `${doc.name} — Focus` },
      classes: ["openlegend"],
      content,
      rejectClose: false,
      buttons: [
        { action: "ok", label: "Take Feat", icon: "fas fa-check", default: true,
          callback: (event, button, dialog) => {
            const root = dialog.element;
            return {
              weapon: root.querySelector('select[name="weapon"]')?.value ?? "",
              attribute: root.querySelector('select[name="attribute"]')?.value ?? ""
            };
          } },
        { action: "cancel", label: "Cancel", icon: "fas fa-times" }
      ]
    });
    if ( !result || (typeof result !== "object") || !result.attribute || !result.weapon ) {
      if ( result && (typeof result === "object") ) ui.notifications?.warn("Choose a weapon and an attribute.");
      return null;
    }

    const weaponBase = result.weapon;
    const weaponName = weapons.find(w => w.base === weaponBase)?.name ?? weaponBase;
    const attrName = attrLabels[result.attribute] ?? result.attribute;
    return {
      weapon: weaponBase,
      attribute: result.attribute,
      label: `${weaponName} / ${attrName}`
    };
  }

  /**
   * Prompt for the Extraordinary Focus feat: a focus item (free text, with the
   * weapon/armor/gear names as datalist suggestions — bookkeeping only) and the
   * empowered EXTRAORDINARY attribute (read at roll time for the +1 dice step).
   * Returns { attribute, focus, label } or null on cancel. The attribute is
   * required; the focus text is optional (defaults to "focus").
   * @param {Item} doc      The Extraordinary Focus feat being taken.
   * @param {Item[]} owned  Already-owned copies (their attributes are off-limits).
   * @returns {Promise<{attribute: string, focus: string, label: string}|null>}
   * @private
   */
  async #promptExtraordinaryFocus(doc, owned = []) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    const esc = s => foundry.utils.escapeHTML?.(s) ?? s;

    // Focus suggestions: weapon + armor compendium names plus the actor's own
    // weapon/armor/gear items. Free text is allowed (the <input> + datalist).
    const names = new Set();
    for ( const packId of ["weapons", "armor"] ) {
      const pack = game.packs?.get(`tomucatos-open-legend-rpg-system.${packId}`);
      if ( pack ) for ( const e of await pack.getIndex() ) names.add(String(e.name).trim());
    }
    for ( const it of this.actor.items ) {
      if ( ["weapon", "armor", "gear"].includes(it.type) ) names.add(String(it.name).trim());
    }
    const focusOpts = [...names].filter(Boolean).sort((a, b) => a.localeCompare(b))
      .map(n => `<option value="${esc(n)}"></option>`).join("");

    // Extraordinary attributes only (the feat empowers an extraordinary attribute);
    // hide ones already focused by another copy of this feat.
    const taken = new Set(owned.map(i => i.flags?.openlegend?.extraordinaryFocus?.attribute).filter(Boolean));
    const xtraKeys = (cfg.categories?.extraordinary?.attributes ?? []).filter(k => !taken.has(k));
    if ( !xtraKeys.length ) { ui.notifications?.warn("All extraordinary attributes are already focused."); return null; }
    const attrOpts = xtraKeys
      .map(k => `<option value="${esc(k)}">${esc(cfg.attributeLabels?.[k] ?? k)}</option>`).join("");

    const content = `
      <div class="ol-feat-choice">
        <p>${esc(doc.name)}: choose your <strong>focus</strong> (a wand, holy symbol, weapon, your voice…) and the <strong>extraordinary attribute</strong> it empowers.</p>
        <div class="form-group">
          <label>Focus</label>
          <input type="text" name="focus" list="ol-ef-focus-list" placeholder="e.g. wand, holy symbol" autofocus/>
          <datalist id="ol-ef-focus-list">${focusOpts}</datalist>
        </div>
        <div class="form-group">
          <label>Attribute</label>
          <select name="attribute">${attrOpts}</select>
        </div>
        <p class="hint">The chosen attribute is treated as one greater for attribute dice on action rolls only (the score is unchanged for everything else).</p>
      </div>`;

    const { DialogV2 } = foundry.applications.api;
    const result = await DialogV2.wait({
      window: { title: `${doc.name} — Focus` },
      classes: ["openlegend"],
      content,
      rejectClose: false,
      buttons: [
        { action: "ok", label: "Take Feat", icon: "fas fa-check", default: true,
          callback: (event, button, dialog) => {
            const root = dialog.element;
            return {
              focus: root.querySelector('[name="focus"]')?.value?.trim() ?? "",
              attribute: root.querySelector('select[name="attribute"]')?.value ?? ""
            };
          } },
        { action: "cancel", label: "Cancel", icon: "fas fa-times" }
      ]
    });
    if ( !result || (typeof result !== "object") || !result.attribute ) return null;
    const attrLabel = cfg.attributeLabels?.[result.attribute] ?? result.attribute;
    const focus = result.focus || "focus";
    return { attribute: result.attribute, focus, label: `${focus} (${attrLabel})` };
  }

  /**
   * Prompt for the Attribute Substitution feat's link: a PRIMARY (stronger) and a
   * DEPENDENT (weaker) attribute — the primary's score is used in place of the
   * dependent's for the purposes the feat tier allows. The two must differ; the
   * primary should normally lead the dependent (substitution only ever raises the
   * effective score). Returns `{ primary, dependent, label }` or null if cancelled.
   * @param {Item} doc  The Attribute Substitution feat.
   * @returns {Promise<{primary: string, dependent: string, label: string}|null>}
   * @private
   */
  async #promptAttributeSubstitution(doc) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
    const labels = cfg.attributeLabels ?? {};
    const cur = this.actor.system.attributes ?? {};
    const opts = Object.entries(labels).map(([k, v]) => {
      const sc = Number(cur[k]?.ownValue ?? cur[k]?.value ?? 0);
      return `<option value="${esc(k)}">${esc(v)} (${sc})</option>`;
    }).join("");

    const content = `
      <div class="ol-attr-substitution ol-feat-choice">
        <p>${esc(doc.name)}: use your <strong>primary</strong> attribute in place of a weaker <strong>dependent</strong> one (GM-approved, logical link).</p>
        <div class="form-group">
          <label>Primary (stronger)</label>
          <select name="primary"><option value="">—</option>${opts}</select>
        </div>
        <div class="form-group">
          <label>Dependent (weaker — its rolls/stats may use the primary)</label>
          <select name="dependent"><option value="">—</option>${opts}</select>
        </div>
        <p class="hint">Tier 1: secondary stats + non-attack/defend/invocation rolls. Tier 2 adds attack/defend rolls and bane/boon invocations. The dependent attribute can still be rolled at its own score from the sheet.</p>
      </div>`;

    const { DialogV2 } = foundry.applications.api;
    const result = await DialogV2.wait({
      window: { title: `${doc.name} — Substitution` },
      classes: ["openlegend"],
      content,
      rejectClose: false,
      render: (event, dialog) => {
        const root = dialog.element;
        const psel = root.querySelector('select[name="primary"]');
        const dsel = root.querySelector('select[name="dependent"]');
        // Keep them distinct: picking one clears it from the other if they collide.
        psel?.addEventListener("change", () => { if ( psel.value && (psel.value === dsel.value) ) dsel.value = ""; });
        dsel?.addEventListener("change", () => { if ( dsel.value && (dsel.value === psel.value) ) psel.value = ""; });
      },
      buttons: [
        { action: "ok", label: "Take Feat", icon: "fas fa-check", default: true,
          callback: (event, button, dialog) => {
            const root = dialog.element;
            return {
              primary: root.querySelector('select[name="primary"]')?.value ?? "",
              dependent: root.querySelector('select[name="dependent"]')?.value ?? ""
            };
          } },
        { action: "cancel", label: "Cancel", icon: "fas fa-times" }
      ]
    });
    if ( !result || (typeof result !== "object") ) return null;
    const { primary, dependent } = result;
    if ( !primary || !dependent ) { ui.notifications?.warn("Choose both a primary and a dependent attribute."); return null; }
    if ( primary === dependent ) { ui.notifications?.warn("Primary and dependent must be different attributes."); return null; }
    const label = `${labels[primary] ?? primary} → ${labels[dependent] ?? dependent}`;
    return { primary, dependent, label };
  }

  /**
   * Prompt for the Boon Access feat: a boon (from the compendium) and — when the
   * boon lists several invoking attributes — which one to invoke it with. The
   * boon's power level is the feat cost and the effective invocation/prerequisite
   * score. Returns `{ boonUuid, boonName, attribute, powerLevel, label }` or null.
   * @param {Item} doc  The Boon Access feat.
   * @returns {Promise<{boonUuid:string, boonName:string, attribute:string, powerLevel:number, label:string}|null>}
   * @private
   */
  async #promptBoonAccess(doc) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
    const labels = cfg.attributeLabels ?? {};
    // Reverse label→key map (boons store capitalized attribute LABELS).
    const keyForLabel = {};
    for ( const [k, v] of Object.entries(labels) ) keyForLabel[String(v).toLowerCase()] = k;

    // Non-private world boons plus the system compendium's (world wins on a
    // name tie).
    const docs = await selectableDocuments("boon", "tomucatos-open-legend-rpg-system.boons");
    const boons = docs.map(b => ({
      uuid: b.uuid, name: b.name,
      pl: Math.max(1, Math.floor(Number(b.system?.powerLevel) || 1)),
      attrs: (b.system?.attributes ?? []).map(a => String(a))
    })).sort((a, b) => a.name.localeCompare(b.name));
    if ( !boons.length ) { ui.notifications?.warn("No boons found."); return null; }

    const maxScore = cfg.maxScore ?? 9;
    const boonOpts = boons.map((b, i) => `<option value="${i}">${esc(b.name)} (PL ${b.pl})</option>`).join("");

    const content = `
      <div class="ol-boon-access ol-feat-choice">
        <p>${esc(doc.name)}: choose a boon you lack the attribute for, the attribute to invoke it with, and the attribute LEVEL you buy. The feat costs that attribute level; invocation rolls treat your attribute score as that level (it must meet the boon's power level).</p>
        <div class="form-group">
          <label>Boon</label>
          <select name="boon"><option value="">—</option>${boonOpts}</select>
        </div>
        <div class="form-group">
          <label>Invoking Attribute</label>
          <select name="attribute" disabled><option value="">— pick a boon first —</option></select>
        </div>
        <div class="form-group">
          <label>Attribute Level (cost)</label>
          <select name="level" disabled><option value="">— pick a boon first —</option></select>
        </div>
        <p class="hint" data-ba-hint></p>
      </div>`;

    const { DialogV2 } = foundry.applications.api;
    const updateHint = root => {
      const bi = Number(root.querySelector('select[name="boon"]')?.value);
      const b = boons[bi];
      const lvl = Number(root.querySelector('select[name="level"]')?.value) || (b?.pl ?? 0);
      const hint = root.querySelector("[data-ba-hint]");
      if ( hint && b ) {
        const dice = cfg.diceForScore ? (cfg.diceForScore(lvl) || "—") : "";
        hint.textContent = `Cost: ${lvl} feat point${lvl === 1 ? "" : "s"}. Invoke at attribute score ${lvl} (roll 1d20 + ${dice}); boon minimum power level is ${b.pl}.`;
      }
    };
    // When the boon changes, refill the attribute options and the level options
    // (the boon's minimum PL up to the max score), defaulting the level to the
    // boon's minimum PL.
    const fillForBoon = root => {
      const bi = Number(root.querySelector('select[name="boon"]')?.value);
      const b = boons[bi];
      const asel = root.querySelector('select[name="attribute"]');
      const lsel = root.querySelector('select[name="level"]');
      if ( !b ) {
        asel.innerHTML = `<option value="">— pick a boon first —</option>`; asel.disabled = true;
        lsel.innerHTML = `<option value="">— pick a boon first —</option>`; lsel.disabled = true;
        updateHint(root); return;
      }
      asel.innerHTML = b.attrs.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
      asel.disabled = b.attrs.length <= 0;
      // Levels from the boon's minimum PL up to the max attribute score.
      const levels = [];
      for ( let l = b.pl; l <= maxScore; l++ ) levels.push(l);
      lsel.innerHTML = levels.map(l => `<option value="${l}"${l === b.pl ? " selected" : ""}>${l}${l === b.pl ? " (min)" : ""}</option>`).join("");
      lsel.disabled = false;
      updateHint(root);
    };

    const result = await DialogV2.wait({
      window: { title: `${doc.name} — Boon Access` },
      classes: ["openlegend"],
      content,
      rejectClose: false,
      render: (event, dialog) => {
        const root = dialog.element;
        root.querySelector('select[name="boon"]')?.addEventListener("change", () => fillForBoon(root));
        root.querySelector('select[name="level"]')?.addEventListener("change", () => updateHint(root));
      },
      buttons: [
        { action: "ok", label: "Take Feat", icon: "fas fa-check", default: true,
          callback: (event, button, dialog) => {
            const root = dialog.element;
            return {
              boonIdx: Number(root.querySelector('select[name="boon"]')?.value),
              attribute: root.querySelector('select[name="attribute"]')?.value ?? "",
              level: Number(root.querySelector('select[name="level"]')?.value) || 0
            };
          } },
        { action: "cancel", label: "Cancel", icon: "fas fa-times" }
      ]
    });
    if ( !result || (typeof result !== "object") ) return null;
    const boon = boons[result.boonIdx];
    if ( !boon ) { ui.notifications?.warn("Choose a boon."); return null; }
    const attrLabel = result.attribute || boon.attrs[0];
    const attrKey = keyForLabel[String(attrLabel).toLowerCase()] ?? "";
    if ( !attrKey ) { ui.notifications?.warn("Choose an invoking attribute."); return null; }
    // The attribute level you buy = the cost + effective invocation score. It must
    // be at least the boon's minimum power level (else you couldn't invoke it).
    const level = Math.max(boon.pl, Math.min(maxScore, Math.floor(Number(result.level) || boon.pl)));
    const label = `${boon.name} (${attrLabel} ${level})`;
    return { boonUuid: boon.uuid, boonName: boon.name, attribute: attrKey, powerLevel: level, label };
  }

  /**
   * Handle an Item dropped onto the actor sheet.
   *
   * - Feats from elsewhere go through {@link #addFeat} (land at tier 1, skip
   *   duplicates) — matching the feat picker.
   * - Banes / boons dropped ONTO THE ACTIONS TAB create a bane/boon ACTION
   *   (attribute requirement enforced — see #createInvocationActionFromDrop).
   * - Banes / boons from elsewhere are APPLIED as conditions (embed the item +
   *   add the leveled Active Effect), the same as dropping them on a token, so
   *   the character gains the condition rather than just stashing a copy. The
   *   apply prompts for the power level to invoke at.
   * - Everything else (and re-sorts within this actor) defers to the default
   *   ActorSheetV2 behavior.
   *
   * The whole sheet is the drop target, so the drop works anywhere on a
   * character / npc / boss sheet.
   * @param {DragEvent} event
   * @param {Item} item  The resolved dropped Item document.
   * @returns {Promise<Item|null|void>}
   * @override
   */
  async _onDropItem(event, item) {
    if ( !this.document.isOwner ) return null;
    const fromElsewhere = item?.parent?.uuid !== this.document.uuid;
    // A feat being re-sorted within this same actor is left to the default
    // sort logic; only feats coming from elsewhere go through #addFeat (which
    // routes into the previewed form's snapshot while previewing).
    if ( (item?.type === "feat") && fromElsewhere ) {
      return this.#addFeat(item);
    }
    // Dropping a bane/boon ONTO THE ACTIONS TAB creates a bane/boon ACTION for
    // it instead of applying it as a condition — provided the actor meets the
    // invocation's attribute requirement (else an explanatory dialog blocks it).
    // Drops anywhere else on the sheet (or on tokens) keep the condition flow.
    if ( ((item?.type === "bane") || (item?.type === "boon"))
      && event.target?.closest?.('.tab[data-tab="actions"]') ) {
      return this.#createInvocationActionFromDrop(item);
    }
    // Dropping a bane/boon from a compendium/sidebar applies it as a condition,
    // prompting for the power level (null → prompt). Conditions are live-actor
    // combat state — always the real document, even while previewing a form.
    if ( (item?.type === "bane") && fromElsewhere ) {
      return game.openlegend?.applyBaneToActor(this.document, item.uuid, null);
    }
    if ( (item?.type === "boon") && fromElsewhere ) {
      return game.openlegend?.applyBoonToActor(this.document, item.uuid, null);
    }
    // A standalone "effect" item applies its Active Effects to the character
    // instead of becoming an owned item.
    if ( item?.type === "effect" ) {
      return game.openlegend?.applyEffectItemToActor(this.document, item.uuid);
    }
    // While previewing: a dropped ACTION belongs to the previewed form's stored
    // snapshot; other item types are shared and land on the live actor. Re-sorts
    // within the same actor are skipped (super would sort the clone's items).
    if ( this.isFormPreview ) {
      if ( !fromElsewhere ) return null;
      if ( item?.type === "action" ) {
        return Forms.addItemToForm(this.document, this.#previewFormId, item.toObject());
      }
      return this.document.createEmbeddedDocuments("Item", [item.toObject()]);
    }
    return super._onDropItem(event, item);
  }

  /**
   * Create a bane/boon ACTION from a bane/boon item dropped onto the Actions tab.
   *
   * The invocation's attribute requirement is enforced first: the actor must have
   * a score ≥ the bane/boon's minimum power level in at least ONE of its listed
   * invoking attributes (a bane's attack attributes / a boon's attribute list).
   * If not, an error dialog explains which attribute to raise and nothing is
   * created. Otherwise the action is preset to the actor's HIGHEST qualifying
   * attribute and the highest defined power level that score can invoke (both
   * editable on the action sheet afterward). For a bane, the target defense
   * comes from the matched attack entry.
   * @param {Item} item  The dropped bane or boon document.
   * @returns {Promise<Item|null>}
   */
  async #createInvocationActionFromDrop(item) {
    const kind = item.type;                       // "bane" | "boon"
    const cfg = CONFIG.OPENLEGEND ?? {};
    const { DialogV2 } = foundry.applications.api;
    const esc = s => foundry.utils.escapeHTML?.(s) ?? s;

    // Bane/boon documents list invoking attributes as capitalized LABELS; map
    // label → attribute key.
    const keyForLabel = {};
    for ( const [k, lbl] of Object.entries(cfg.attributeLabels ?? {}) ) {
      keyForLabel[String(lbl).toLowerCase()] = k;
    }
    const attacks = (kind === "bane") ? (item.system?.attacks ?? []) : [];
    const attrLabels = (kind === "bane")
      ? attacks.map(a => String(a.attackingAttribute ?? "")).filter(Boolean)
      : (item.system?.attributes ?? []).map(a => String(a)).filter(Boolean);

    // Discrete power levels + the minimum PL (the attribute prerequisite).
    const levels = [...new Set((item.system?.powerEffects ?? [])
      .map(pe => Number(pe.powerLevel)).filter(n => Number.isFinite(n) && (n > 0)))].sort((a, b) => a - b);
    const minPl = Math.max(1, Math.floor(Number(item.system?.powerLevel) || (levels[0] ?? 1)));

    // The actor's score in each listed attribute; best one wins (ties → first
    // listed). Reads the sheet's actor (the preview clone while previewing).
    const candidates = attrLabels
      .map(lbl => {
        const key = keyForLabel[lbl.toLowerCase()];
        return key ? { key, label: lbl, score: Number(this.actor.system?.attributes?.[key]?.value ?? 0) } : null;
      })
      .filter(Boolean);
    const best = candidates.reduce((a, c) => (!a || (c.score > a.score)) ? c : a, null);

    if ( !best || (best.score < minPl) ) {
      const scoreRows = candidates.length
        ? candidates.map(c => `<li><strong>${esc(c.label)}</strong>: ${c.score}</li>`).join("")
        : `<li><em>None of this ${kind}'s attributes are known to this actor.</em></li>`;
      await DialogV2.prompt({
        window: { title: "Attribute Requirement Not Met" },
        classes: ["openlegend"],
        content: `
          <div class="ol-generate-action">
            <p><i class="fas fa-triangle-exclamation"></i> <strong>${esc(this.actor.name)}</strong> cannot invoke the
              <strong>${esc(item.name)}</strong> ${kind}.</p>
            <p>Invoking it requires a score of <strong>${minPl}</strong> or higher in one of:
              <strong>${attrLabels.map(esc).join(", ") || "—"}</strong>.</p>
            <p>Current score${candidates.length === 1 ? "" : "s"}:</p>
            <ul>${scoreRows}</ul>
            <p>Increase one of these attributes to at least <strong>${minPl}</strong> to create this action.</p>
          </div>`,
        rejectClose: false,
        ok: { label: "Close", icon: "fas fa-times" }
      });
      return null;
    }

    // Invoke at the highest defined power level the attribute score reaches.
    const reachable = levels.filter(l => l <= best.score);
    const invokePl = reachable.length ? reachable[reachable.length - 1] : minPl;

    const sys = {
      actionCategory: kind,
      attribute: best.key,
      targets: "single",
      invokePowerLevel: invokePl
    };
    if ( kind === "bane" ) {
      const match = attacks.find(a => String(a.attackingAttribute ?? "").toLowerCase() === best.label.toLowerCase());
      sys.targetDefense = String(match?.defense ?? "guard").toLowerCase();
      sys.baneUuid = item.uuid;
      sys.baneName = item.name;
    } else {
      sys.boonUuid = item.uuid;
      sys.boonName = item.name;
    }
    const data = { name: item.name, type: "action", img: item.img, system: sys };

    // Previewing a form: the new action belongs to that form's stored snapshot.
    if ( this.isFormPreview ) {
      const newId = await Forms.addItemToForm(this.document, this.#previewFormId, data);
      ui.notifications?.info(`Created ${kind} action “${data.name}” on the previewed form.`);
      if ( newId ) await this.#openStoredFormItemSheet(newId);
      return null;
    }
    const [created] = await this.document.createEmbeddedDocuments("Item", [data]);
    ui.notifications?.info(`Created ${kind} action “${data.name}”.`);
    OpenLegendActorSheet.#openDocumentSheet(created);
    return created;
  }

  /**
   * Actor dropped on the sheet. On a MOUNT, dropping an actor onto a pilot seat
   * (.mount-pilot-slot) links that actor as the seat's pilot — shown as an
   * image + name tile, and offered by the action sheet's Pilot select (Targeted
   * Weapons reads the chosen pilot's live Agility at roll time). An actor already
   * seated elsewhere moves to the new seat. Anything else defers to the default.
   * @param {DragEvent} event
   * @param {Actor} actor  The resolved dropped Actor document.
   * @override
   */
  async _onDropActor(event, actor) {
    if ( this.isFormPreview ) return null;   // pilot seats are mount-only; never during a form preview
    const slotEl = (this.actor.type === "mount")
      ? event.target?.closest?.(".mount-pilot-slot")
      : null;
    if ( !slotEl || !actor ) return super._onDropActor?.(event, actor);
    if ( !this.actor.isOwner ) return null;
    if ( actor.uuid === this.actor.uuid ) {
      ui.notifications?.warn("A mount cannot pilot itself.");
      return null;
    }
    if ( actor.type === "mount" ) {
      ui.notifications?.warn("A mount/vehicle cannot be another mount's pilot.");
      return null;
    }
    const seatCount = Math.max(1, Math.min(12, Math.floor(Number(this.actor.system.properties?.multiPilot ?? 1))));
    const slot = Math.max(0, Math.min(seatCount - 1, Math.floor(Number(slotEl.dataset.slot) || 0)));
    const pilots = Array.from({ length: seatCount }, (_, i) => String(this.actor.system.pilots?.[i] ?? ""));
    // The same actor can only occupy one seat — dropping onto a new seat moves them.
    const existing = pilots.indexOf(actor.uuid);
    if ( existing >= 0 ) pilots[existing] = "";
    pilots[slot] = actor.uuid;
    await this.actor.update({ "system.pilots": pilots });
  }

  /**
   * Open a seated pilot's actor sheet (click on a filled pilot tile).
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  The .mount-pilot-slot carrying data-slot.
   */
  static async #onPilotOpen(event, target) {
    event.preventDefault();
    const slot = Math.floor(Number(target.dataset.slot) || 0);
    const uuid = String(this.actor.system.pilots?.[slot] ?? "");
    const doc = uuid ? await fromUuid(uuid).catch(() => null) : null;
    if ( !doc ) {
      ui.notifications?.warn("That pilot no longer exists.");
      return;
    }
    doc.sheet?.render(true);
  }

  /**
   * Unseat a pilot (the X on a filled pilot tile). Clears just that seat.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  Carries data-slot.
   */
  static async #onPilotClear(event, target) {
    event.preventDefault();
    // The clear button sits inside the tile whose click opens the pilot sheet —
    // don't let the open action fire too.
    event.stopPropagation();
    const seatCount = Math.max(1, Math.min(12, Math.floor(Number(this.actor.system.properties?.multiPilot ?? 1))));
    const slot = Math.floor(Number(target.dataset.slot) || 0);
    const pilots = Array.from({ length: seatCount }, (_, i) => String(this.actor.system.pilots?.[i] ?? ""));
    if ( pilots[slot] === undefined ) return;
    pilots[slot] = "";
    await this.actor.update({ "system.pilots": pilots });
  }

  /**
   * Raise a feat's purchased tier by one (capped at its maxTier). Soft rules: no
   * budget/prerequisite block.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  Carries the nearest data-item-id.
   */
  static async #onFeatRaise(event, target) {
    event.preventDefault();
    const id = target.closest("[data-item-id]")?.dataset.itemId;
    // Previewing a form: its feats live in the stored snapshot, not on the actor.
    if ( this.isFormPreview ) return this.#stepStoredFeatTier(id, +1);
    const feat = id ? this.actor.items.get(id) : null;
    if ( feat?.type !== "feat" ) return;
    const max = Math.max(1, Number(feat.system?.maxTier ?? 1));
    const next = Math.min(max, Number(feat.system?.purchasedTier ?? 1) + 1);
    if ( next !== feat.system?.purchasedTier ) {
      await feat.update({ "system.purchasedTier": next });
      // Companion feat: keep the linked companion's tier in sync.
      if ( Companion.isCompanionFeat(feat) ) {
        const comp = Companion.companionForFeat(this.actor, feat);
        if ( comp ) await Companion.setCompanionTier(comp, next);
      }
      await this.#syncAlternateFormTier(feat, next);
    }
  }

  /**
   * Alternate Form feat ↔ form tier sync: when the FEAT's purchased tier changes,
   * mirror it onto the linked form's tier (shown in the form header's tier selector
   * and driving its budgets). No-op for other feats or an unlinked feat.
   * @param {Item} feat
   * @param {number} tier
   * @private
   */
  async #syncAlternateFormTier(feat, tier) {
    const isAltForm = (feat?.type === "feat")
      && ((feat.system?.baseName || feat.name) === Forms.ALTERNATE_FORM_FEAT);
    if ( !isAltForm ) return;
    const formId = Forms.formIdForFeat(this.actor, feat);
    if ( formId ) await Forms.setFormTier(this.actor, formId, tier);
  }

  /**
   * Lower a feat's purchased tier by one. Dropping below tier 1 removes the feat.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  Carries the nearest data-item-id.
   */
  static async #onFeatLower(event, target) {
    event.preventDefault();
    const id = target.closest("[data-item-id]")?.dataset.itemId;
    // Previewing a form: its feats live in the stored snapshot, not on the actor.
    if ( this.isFormPreview ) return this.#stepStoredFeatTier(id, -1);
    const feat = id ? this.actor.items.get(id) : null;
    if ( feat?.type !== "feat" ) return;
    const next = Number(feat.system?.purchasedTier ?? 1) - 1;
    if ( next < 1 ) {
      // Lowering below tier 1 removes the feat. The Alternate Form / Companion feats are
      // fully handled (warn + delete their linked form/companion + delete the feat).
      if ( await this.#removeAlternateFormFeat(feat) ) return;
      if ( await this.#removeCompanionFeat(feat) ) return;
      await this.actor.deleteEmbeddedDocuments("Item", [id]);
    } else {
      await feat.update({ "system.purchasedTier": next });
      // Companion feat: keep the linked companion's tier in sync.
      if ( Companion.isCompanionFeat(feat) ) {
        const comp = Companion.companionForFeat(this.actor, feat);
        if ( comp ) await Companion.setCompanionTier(comp, next);
      }
      await this.#syncAlternateFormTier(feat, next);
    }
  }

  /**
   * Fully handle removal of an Alternate Form feat: warn that ONLY its linked form is
   * deleted (other forms and feats untouched); on confirm, delete that form, delete the
   * feat, and scrub the feat from every stored form's snapshot (so a later switch can't
   * resurrect it). Returns true when this method HANDLED the removal (caller must NOT
   * delete the feat itself — whether the user confirmed or cancelled). Returns false for
   * a non-Alternate-Form feat, so the caller deletes it normally.
   * @param {Item} feat
   * @returns {Promise<boolean>}  true = handled (do not delete); false = not ours.
   * @private
   */
  async #removeAlternateFormFeat(feat) {
    const isAltForm = (feat?.type === "feat")
      && ((feat.system?.baseName || feat.name) === Forms.ALTERNATE_FORM_FEAT);
    if ( !isAltForm ) return false;

    const formId = Forms.formIdForFeat(this.actor, feat);
    const form = formId ? Forms.getForms(this.actor).find(f => f.id === formId) : null;
    const formName = form?.name ?? "its linked form";

    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Remove Alternate Form" },
      content: `<p>Removing this <strong>Alternate Form</strong> feat will delete <strong>${formName}</strong> — its attributes, feats, actions, and images.</p>
        <p>Your other forms and feats are unaffected. This cannot be undone.</p>
        <p>Remove the feat and delete <strong>${formName}</strong>?</p>`,
      rejectClose: false, modal: true
    }).catch(() => false);

    if ( !ok ) return true;                          // cancelled — handled (do not delete)
    const featId = feat.id;
    if ( formId ) await Forms.deleteForm(this.actor, formId);   // delete only this form
    if ( this.actor.items.get(featId) ) await this.actor.deleteEmbeddedDocuments("Item", [featId]);
    await Forms.removeItemFromStoredForms(this.actor, featId);  // scrub from Main's snapshot
    return true;                                     // handled
  }

  /**
   * Fully handle removal of a Companion feat: warn that its linked companion will be
   * deleted, and on confirm delete the companion actor + the feat. Returns true when
   * HANDLED (caller must not delete the feat), false for a non-Companion feat.
   * @param {Item} feat
   * @returns {Promise<boolean>}
   * @private
   */
  async #removeCompanionFeat(feat) {
    if ( !Companion.isCompanionFeat(feat) ) return false;
    const comp = Companion.companionForFeat(this.actor, feat);
    const name = comp?.name ?? "its linked companion";

    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Remove Companion" },
      content: `<p>Removing this <strong>Companion</strong> feat will delete the companion <strong>${name}</strong> — its sheet, attributes, feats, and token.</p>
        <p>Your other companions and feats are unaffected. This cannot be undone.</p>
        <p>Remove the feat and delete <strong>${name}</strong>?</p>`,
      rejectClose: false, modal: true
    }).catch(() => false);

    if ( !ok ) return true;                          // cancelled — handled (do not delete)
    const featId = feat.id;
    if ( comp && game.user?.isGM ) await comp.delete();
    else if ( comp ) ui.notifications?.warn(`Ask the GM to delete the companion "${name}".`);
    if ( this.actor.items.get(featId) ) await this.actor.deleteEmbeddedDocuments("Item", [featId]);
    return true;                                     // handled
  }

  /**
   * Open a linked companion's sheet (the "View Companion" button). With one companion,
   * opens it directly; with several, opens the one whose data-companion-uuid was clicked,
   * else the first.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onViewCompanion(event, target) {
    event.preventDefault();
    let uuid = target.dataset.companionUuid;
    if ( !uuid ) {
      const comps = Companion.companionFeats(this.actor)
        .map(f => Companion.companionForFeat(this.actor, f)).filter(Boolean);
      if ( !comps.length ) { ui.notifications?.warn("No companion linked."); return; }
      uuid = comps[0].uuid;
    }
    const comp = uuid ? (fromUuidSync(uuid) ?? null) : null;
    if ( !comp ) { ui.notifications?.warn("Companion not found."); return; }
    comp.sheet?.render(true);
  }

  /* -------------------------------------------- */
  /*  Alternate Forms                             */
  /* -------------------------------------------- */

  /**
   * VIEW the clicked form tab (data-form-id) READ-ONLY. No actor writes happen —
   * the sheet renders from an ephemeral clone, so the live actor (and therefore
   * its defenses against incoming attacks) keeps the truly active form. Clicking
   * the active form's tab returns to the normal live view. Actually changing
   * form is the explicit Transform action ({@link #onFormTransform}).
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  Carries data-form-id.
   */
  static async #onFormView(event, target) {
    event.preventDefault();
    const id = target.dataset.formId;
    if ( !id ) return;
    this.#previewFormId = (id === Forms.activeFormId(this.document)) ? null : id;
    this.render(false);
  }

  /**
   * TRANSFORM — the one action that changes the ACTIVE form on the live actor:
   * runs the real switch (attributes/feats/actions swap, damage carries) and then
   * applies the new form's token image to the placed token(s) + prototype, like
   * the "Apply to token" button. Transforms into the previewed form when one is
   * being viewed, else the button's data-form-id (the next form in order).
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  Carries data-form-id (the fallback target).
   */
  static async #onFormTransform(event, target) {
    event.preventDefault();
    const actor = this.document;
    const targetId = this.#previewFormId ?? target.dataset.formId;
    if ( !targetId || (targetId === Forms.activeFormId(actor)) ) return;
    this.#previewFormId = null;
    const ok = await Forms.switchToForm(actor, targetId);
    if ( ok ) await Forms.applyTokenImage(actor);
  }

  /**
   * Delete the alternate form (data-form-id) after confirmation, AND remove its linked
   * Alternate Form feat (forms exist only via the feat — they're 1:1). Main is protected.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  Carries data-form-id.
   */
  static async #onFormDelete(event, target) {
    event.preventDefault();
    event.stopPropagation();
    // this.document, not this.actor: during a read-only preview the actor getter
    // serves an ephemeral clone that cannot be written (same in the handlers below).
    const actor = this.document;
    const id = target.closest("[data-form-id]")?.dataset.formId;
    if ( !id || (id === Forms.MAIN_FORM_ID) ) return;
    const name = Forms.getForms(actor).find(f => f.id === id)?.name ?? "this form";
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Delete Form" },
      content: `<p>Delete the alternate form <strong>${name}</strong> and its <strong>Alternate Form</strong> feat? Its stored attributes, feats, and actions will be lost. Other forms are unaffected.</p>`,
      rejectClose: false, modal: true
    }).catch(() => false);
    if ( !ok ) return;
    // Remove the linked feat (it lives on Main / wherever it currently is) so a form is
    // never left without its feat. Find it by the form's stored featId or the feat's
    // formId flag. Delete the form first (reverts to Main if active), then the feat, then
    // scrub the feat from stored snapshots so a later switch can't resurrect it.
    const featId = Forms.getForms(actor).find(f => f.id === id)?.featId
      || actor.items.find(i => i.flags?.openlegend?.formId === id)?.id;
    await Forms.deleteForm(actor, id);
    if ( featId && actor.items.get(featId) ) {
      await actor.deleteEmbeddedDocuments("Item", [featId]);
    }
    if ( featId ) await Forms.removeItemFromStoredForms(actor, featId);
  }

  /**
   * Rename the form (data-form-id) via a prompt.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  Carries data-form-id.
   */
  static async #onFormRename(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const id = target.closest("[data-form-id]")?.dataset.formId;
    if ( !id ) return;
    const current = Forms.getForms(this.document).find(f => f.id === id)?.name ?? "";
    const name = await foundry.applications.api.DialogV2.prompt({
      window: { title: "Rename Form" },
      content: `<input type="text" name="formName" value="${current}" style="width:100%;" autofocus/>`,
      ok: { label: "Rename", callback: (ev, button) => button.form.elements.formName.value },
      rejectClose: false, modal: true
    }).catch(() => null);
    if ( name != null ) await Forms.renameForm(this.document, id, name);
    this.render(false);
  }

  /**
   * Open a FilePicker to set the ACTIVE form's TOKEN image (stored per-form). The
   * portrait uses the built-in editImage on actor.img; this is the separate token art.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onFormEditTokenImage(event, target) {
    event.preventDefault();
    const actor = this.document;
    // Edit the DISPLAYED form's token image: the previewed form while previewing,
    // else the active one.
    const formId = this.#previewFormId ?? Forms.activeFormId(actor);
    const form = Forms.getForms(actor).find(f => f.id === formId);
    const current = form?.tokenImg || form?.img || actor.img;
    const FP = foundry.applications.apps.FilePicker?.implementation ?? FilePicker;
    const fp = new FP({
      type: "image",
      current,
      callback: path => Forms.setFormTokenImage(actor, formId, path)
    });
    return fp.browse();
  }

  /**
   * Open a FilePicker to set the ACTIVE alternate form's PORTRAIT (stored per-form
   * as form.img; actor.img — the shared sidebar identity — is never touched). The
   * template wires the portrait to this action only while an alternate form is
   * active; on Main it keeps the core editImage on actor.img.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onFormEditPortrait(event, target) {
    event.preventDefault();
    const actor = this.document;
    // Edit the DISPLAYED alternate form's portrait (previewed or active).
    const formId = this.#previewFormId ?? Forms.activeFormId(actor);
    if ( formId === Forms.MAIN_FORM_ID ) return;
    const form = Forms.getForms(actor).find(f => f.id === formId);
    const current = form?.img || actor.img;
    const FP = foundry.applications.apps.FilePicker?.implementation ?? FilePicker;
    const fp = new FP({
      type: "image",
      current,
      callback: path => Forms.setFormImage(actor, formId, path)
    });
    return fp.browse();
  }

  /**
   * "Apply to token" toggle: push the active form's token image onto the placed
   * token(s) + prototype token.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onFormApplyToken(event, target) {
    event.preventDefault();
    // Apply the DISPLAYED form's token image (the previewed one while previewing).
    await Forms.applyTokenImage(this.document, { formId: this.#previewFormId });
  }

  /**
   * Roll an attribute action: 1d20 + the attribute's bonus dice, sent to chat.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  The clicked element carrying data-attribute.
   */
  static async #onAttributeRoll(event, target) {
    event.preventDefault();
    const key = target.dataset.attribute;
    // Two rows can exist for a substituted attribute: the editable own-score row
    // and a locked substituted row (data-substituted). The locked row rolls the
    // SUBSTITUTED dice; the normal row rolls the player's OWN dice. The roll itself
    // (dialog, Skill Specialization, AE modifiers, flavor) lives in action-roll.mjs
    // so the hotbar macro this button can be dragged to behaves identically.
    const substituted = target.dataset.substituted === "true";
    const { rollActorAttribute } = await import("../dice/action-roll.mjs");
    return rollActorAttribute(this.actor, key, { substituted });
  }

  /**
   * Roll an Extraordinary-item attribute. It rolls as the same attribute TYPE
   * (so per-attribute Active Effect adv/dis applies via actorRollModifiers),
   * using the entry's effective bonus dice:
   *   - mode "item"    → the item's score/dice.
   *   - mode "own+adv" → the actor's OWN score/dice, and the item's Advantage is
   *     seeded by actorRollModifiers (which reads itemAttributes), so the roll
   *     dialog shows it as "Extraordinary item (<source>)". No manual add here.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  Carries data-attribute (the attribute key).
   */
  static async #onItemAttributeRoll(event, target) {
    event.preventDefault();
    const key = target.dataset.attribute;
    const ia = (this.actor.system.itemAttributes ?? []).find(a => a.key === key);
    if ( !ia ) return;

    const label = ia.label ?? key;
    const sources = actorRollModifiers(this.actor, { attribute: key });
    // Skill Specialization (feat): a plain attribute check still benefits when it's
    // the chosen attribute (advantage 1 per tier). Excludes attack/invoke/defend.
    const skillSpec = CONFIG.OPENLEGEND?.skillSpecializationAdvantage?.(this.actor, key) ?? 0;
    if ( skillSpec > 0 ) sources.push({ label: `Skill Specialization (${label})`, advantage: skillSpec });
    // Sworn Enemy (feat): opt-in advantage per chosen group on a MENTAL attribute roll.
    const swornGroups = (CONFIG.OPENLEGEND?.isMentalAttribute?.(key))
      ? (CONFIG.OPENLEGEND?.swornEnemyGroups?.(this.actor) ?? []) : [];
    const extraToggles = swornGroups.map((g, i) => ({
      name: `sworn-${i}`,
      label: `Sworn Enemy: ${g.label} (advantage ${g.tier})`,
      title: `Sworn Enemy — advantage ${g.tier} when this ${label} roll pertains to ${g.label}.`,
      advantage: g.tier,
      checked: false
    }));
    // Well-Rounded (feat): advantage 1 on an out-of-combat attribute check (not a
    // bane/boon invocation) using a score ≤ 2. The score rolled here is the item's
    // own score (own+adv mode) or item score. Auto out of combat; toggle in combat.
    const wrScore = (ia.mode === "own+adv") ? Number(ia.ownScore ?? 0) : Number(ia.itemScore ?? 0);
    const wellRounded = CONFIG.OPENLEGEND?.wellRoundedApplies?.(this.actor, wrScore) ?? false;
    const inCombat = CONFIG.OPENLEGEND?.actorInActiveCombat?.(this.actor) ?? false;
    if ( wellRounded && !inCombat ) {
      sources.push({ label: `Well-Rounded (${label} ${wrScore}, out of combat)`, advantage: 1 });
    } else if ( wellRounded && inCombat ) {
      extraToggles.push({
        name: "wellRounded", label: `Well-Rounded (advantage 1)`,
        title: `Well-Rounded — advantage 1 when this ${label} (${wrScore}) roll is made outside of combat.`,
        advantage: 1, checked: false
      });
    }
    const choice = await openRollDialog({
      title: `${label} Action (Extraordinary)`,
      bonusDice: ia.dice || "",
      sources,
      extraToggles,
      legend: CONFIG.OPENLEGEND?.legendSpendContext?.(this.actor)
    });
    if ( !choice ) return;

    const roll = await (new Roll(choice.formula, this.actor.getRollData())).evaluate();
    await CONFIG.OPENLEGEND?.spendLegendPoints?.(this.actor, choice.legendPoints);

    let advText = "";
    if ( choice.net > 0 ) advText = ` — ${choice.net} Advantage`;
    else if ( choice.net < 0 ) advText = ` — ${Math.abs(choice.net)} Disadvantage`;
    const swornEngaged = swornGroups.filter((g, i) => choice[`sworn-${i}`]).map(g => g.label);
    const swornText = swornEngaged.length ? ` (Sworn Enemy: ${swornEngaged.join(", ")})` : "";
    const wrText = (wellRounded && (choice.wellRounded || !inCombat)) ? " (Well-Rounded)" : "";
    const lpText = choice.legendPoints > 0 ? ` (Legend Points: ${choice.legendPoints})` : "";
    const modeText = (ia.mode === "own+adv")
      ? ` (your ${label} ${ia.ownScore}, ${ia.source} grants Adv ${ia.advantage})`
      : ` (${ia.source} ${label} ${ia.itemScore})`;
    const flavor = `${label} Action${modeText}${advText}${swornText}${wrText}${lpText}`;

    return roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      flavor
    });
  }

  /**
   * Roll an action. Uses the action's chosen attribute to determine the bonus
   * dice, and seeds the roll dialog with the action's own advantage /
   * disadvantage so the player can confirm or adjust before rolling. The chat
   * card notes the action name and, for damaging/bane actions, the target
   * defense and damage type.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  Element within an action row (carries data-item-id).
   */
  static async #onActionRoll(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const id = target.closest("[data-item-id]")?.dataset.itemId;
    const action = id ? this.actor.items.get(id) : null;
    if ( !action ) return;
    return rollAction(action, { actor: this.actor });
  }

  /**
   * Open the bane/boon invoked by a bane/boon action so the player can read its
   * rules — the little book icon next to the invocation name in an action row.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  Carries data-uuid (the bane/boon's uuid).
   */
  static async #onOpenInvocation(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const uuid = target.dataset.uuid;
    const doc = uuid ? await fromUuid(uuid).catch(() => null) : null;
    if ( !doc ) {
      ui.notifications?.warn("Could not find that bane/boon to open.");
      return;
    }
    OpenLegendActorSheet.#openDocumentSheet(doc);
  }

  /**
   * Roll initiative for this actor into the Foundry combat tracker. Ensures the
   * actor's token(s) are in an encounter (creating one if needed), then rolls
   * initiative there using the system formula (1d20 + Agility dice).
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   */
  static async #onInitiativeRoll(event) {
    event.preventDefault();

    // If the actor already has a combatant in the active encounter, roll for it.
    // Always the LIVE actor — combat state (this.actor is a clone in a preview).
    const combat = game.combat;
    const existing = combat?.getCombatantsByActor?.(this.document) ?? [];
    if ( existing.length ) {
      return combat.rollInitiative(existing.map(c => c.id));
    }

    // Otherwise add the actor to combat and roll. rollInitiative on the Actor
    // creates combatants (and an encounter if there is none) for its tokens.
    try {
      await this.document.rollInitiative({ createCombatants: true });
    } catch ( err ) {
      ui.notifications?.warn("Could not roll initiative — place a token for this actor on the scene first.");
      console.error("OpenLegend | Initiative roll failed:", err);
    }
  }

  /**
   * Open the actor's portrait in a full-size ImagePopout. The popout carries a
   * built-in "Show to Players" header button (the core `shareImage` action),
   * which broadcasts the image to all connected clients. The image is shown at
   * its natural proportions, not cropped to the 96px portrait frame.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   */
  static #onImagePopout(event) {
    event.preventDefault();
    event.stopPropagation();
    const { name, uuid } = this.document;
    // Show what the sheet portrait shows: the DISPLAYED form's own image — the
    // previewed form while previewing, else the active one (actor.img on Main).
    const shown = this.#previewedForm();
    const src = shown
      ? ((shown.id === Forms.MAIN_FORM_ID) ? this.document.img : (shown.img || this.document.img))
      : Forms.activeFormImage(this.document);
    new foundry.applications.apps.ImagePopout({
      src,
      uuid,
      window: { title: name }
    }).render({ force: true });
  }

  /**
   * Resolve a stat's breakdown report data: the labeled component rows captured
   * in {@link OpenLegendActor#prepareDerivedData} and the live final value the
   * sheet displays. Returns null for an unknown stat. Handles all stat kinds via
   * a `data-stat` discriminator on the clicked icon:
   *   - defense:    defenseBreakdown[key]; final value = derived guard for NPC/boss.
   *   - speed:      speedBreakdown (sequential pipeline steps).
   *   - initiative: initiativeBreakdown.
   *   - attribute:  attributeBreakdown[key] (base/AE/clamp already itemized).
   * @param {string} stat  "defense" | "speed" | "initiative" | "attribute".
   * @param {string} key   Sub-key for defense/attribute (e.g. "guard", "might").
   * @returns {{label: string, rows: Array<{label,value}>, total: number}|null}
   * @private
   */
  #statReportData(stat, key) {
    const sys = this.actor.system;
    const cfg = CONFIG.OPENLEGEND ?? {};
    const freeForm = (this.actor.type === "npc") || (this.actor.type === "boss");

    if ( stat === "defense" ) {
      const labels = { guard: "Guard", toughness: "Toughness", resolve: "Resolve" };
      if ( !labels[key] ) return null;
      const stored = Number(sys.defenses?.[key]?.value ?? 0);
      // NPC/boss: Guard adds the display-only armor bonus; Toughness/Resolve add
      // the display-only Battle Trance bonus; ALL defenses add the display-only
      // Extraordinary Defense bonus (characters already bake these in).
      let total = stored;
      if ( freeForm && (key === "guard") ) total += Number(sys.armorDefenseBonus ?? 0);
      if ( freeForm && ((key === "toughness") || (key === "resolve")) ) total += Number(sys.battleTranceDefense ?? 0);
      if ( freeForm ) total += Number(sys.extraordinaryDefense ?? 0);
      if ( freeForm && (key === "resolve") ) total += Number(sys.indomitableResolve ?? 0);
      if ( freeForm && ((key === "guard") || (key === "toughness")) ) total += Number(sys.naturalDefense ?? 0);
      return { label: labels[key], rows: sys.defenseBreakdown?.[key] ?? [], total };
    }
    if ( stat === "speed" ) {
      return { label: "Speed", rows: sys.speedBreakdown ?? [], total: Number(sys.speed?.value ?? 0) };
    }
    if ( stat === "initiative" ) {
      return { label: "Initiative", rows: sys.initiativeBreakdown ?? [], total: Number(sys.initiative?.value ?? 0) };
    }
    if ( stat === "attribute" ) {
      const label = cfg.attributeLabels?.[key];
      if ( !label ) return null;
      const attr = sys.attributes?.[key];
      const rows = [...(sys.attributeBreakdown?.[key] ?? [])];
      // Attribute Substitution raises the effective value above the own score —
      // show that as its own labeled row so it isn't lumped into "Active effects".
      const own = Number(attr?.ownValue ?? attr?.value ?? 0);
      const eff = Number(attr?.value ?? own);
      if ( eff > own ) {
        const priLabel = cfg.attributeLabels?.[attr?.substitutionPrimary] ?? attr?.substitutionPrimary ?? "primary";
        rows.push({ label: `Substitution (${priLabel})`, value: eff - own });
      }
      return { label, rows, total: eff };
    }
    return null;
  }

  /**
   * Open a dialog detailing how a stat was calculated: each contribution row
   * from {@link #statReportData}, then any flat Active Effect modifiers not
   * already itemized — reconstructed as (final value − sum of the captured
   * rows) so a final-phase effect on a defense/speed shows up — and the total.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  Carries data-stat and (for defense/attribute) data-key.
   */
  static #onStatReport(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const data = this.#statReportData(target.dataset.stat, target.dataset.key);
    if ( !data ) return;

    const rows = data.rows.map(r => ({ ...r, value: Number(r.value) || 0 }));
    const subtotal = rows.reduce((s, r) => s + r.value, 0);
    // Whatever the captured rows don't account for is the net of flat Active
    // Effect modifiers applied after the breakdown was built (defenses/speed
    // apply in the final phase; attributes already itemize their AE row, so the
    // delta is 0 there). Shown as one "Active effects" line.
    const aeDelta = data.total - subtotal;
    if ( aeDelta !== 0 ) rows.push({ label: "Active effects", value: aeDelta });

    const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
    const sign = v => `${v >= 0 ? "+" : "−"}${Math.abs(v)}`;
    const body = rows.map(r =>
      `<li class="ol-defense-row"><span class="ol-defense-label">${esc(r.label)}</span><span class="ol-defense-val">${sign(r.value)}</span></li>`
    ).join("");

    const { DialogV2 } = foundry.applications.api;
    DialogV2.wait({
      window: { title: `${data.label} — Breakdown` },
      classes: ["openlegend", "ol-defense-report"],
      content: `
        <div class="ol-defense-breakdown">
          <ul class="ol-defense-list">${body}</ul>
          <div class="ol-defense-total">
            <span class="ol-defense-label">${esc(data.label)}</span>
            <span class="ol-defense-val">${data.total}</span>
          </div>
        </div>`,
      buttons: [{ action: "close", label: "Close", icon: "fas fa-check", default: true }],
      rejectClose: false
    });
  }

  /**
   * Create a new embedded Item from the clicked "Add" control. An optional
   * data-action-category preselects an action's category (Actions tab). For
   * actions the new item's sheet is opened immediately so the user can fill in
   * the form.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  The control carrying data-type (+ optional data-action-category).
   */
  static async #onItemCreate(event, target) {
    event.preventDefault();
    const type = target.dataset.type;
    const category = target.dataset.actionCategory;
    const cfg = CONFIG.OPENLEGEND ?? {};
    const name = (type === "action" && category)
      ? `New ${cfg.actionCategories?.[category] ?? "Action"}`
      : `New ${type.capitalize()}`;
    const itemData = { name, type, img: "icons/svg/angel.svg" };
    if ( type === "action" ) {
      itemData.system = {};
      if ( category ) itemData.system.actionCategory = category;
      // Interrupt actions always use the "interrupt" action-economy type.
      if ( category === "interrupt" ) itemData.system.actionType = "interrupt";
      // Category-appropriate default icon (sword / holy-shield / poison / combat).
      // The item's _preCreate also handles this for other creation paths.
      const cat = category ?? "damaging";
      itemData.img = cfg.actionCategoryIcons?.[cat] ?? cfg.defaultActionIcon ?? itemData.img;
    }
    // Previewing a form: a new feat/action belongs to the previewed form's stored
    // snapshot; shared item types (inventory) are created on the live actor.
    if ( this.isFormPreview && Forms.SWAP_ITEM_TYPES.includes(type) ) {
      const newId = await Forms.addItemToForm(this.document, this.#previewFormId, itemData);
      if ( (type === "action") && newId ) await this.#openStoredFormItemSheet(newId);
      return null;
    }
    const created = await Item.create(itemData, { parent: this.document });
    // Open the freshly-created action so the user can fill in its form right away.
    if ( type === "action" ) OpenLegendActorSheet.#openDocumentSheet(created);
    return created;
  }

  /**
   * Every existing Item of one inventory type the player can add: the world's
   * Items directory first, then every Item compendium the user can see. The
   * physical item types are spread across packs (a weapon lives in `weapons`
   * OR in `extraordinary-items`), so the whole index is scanned and filtered by
   * type rather than reading one pack per section.
   *
   * Entries are deduped per source (the same name twice in one pack collapses to
   * one row) but NOT across sources — a world "Longsword" and the compendium's
   * are genuinely different documents, so both are listed and the source column
   * tells them apart. Sorted by name.
   * @param {string} type  "weapon" | "armor" | "gear"
   * @returns {Promise<Array<{uuid: string, name: string, img: string, source: string}>>}
   * @private
   */
  static async #browsableItems(type) {
    const entries = [];
    const seen = new Set();
    const push = (uuid, name, img, source) => {
      const key = `${name} ${source}`;
      if ( !uuid || !name || seen.has(key) ) return;
      seen.add(key);
      entries.push({ uuid, name, img: img || "icons/svg/item-bag.svg", source });
    };

    // World items (a GM's customised copies) come first. Items marked Private
    // are left out of the browser.
    for ( const item of game.items ?? [] ) {
      if ( item.type !== type ) continue;
      if ( !item.visible || item.system?.private ) continue;
      push(item.uuid, item.name, item.img, "World");
    }

    for ( const pack of game.packs ?? [] ) {
      if ( pack.documentName !== "Item" ) continue;
      if ( pack.private && !game.user?.isGM ) continue;
      let index;
      try {
        // Index the Private flag too, so items a GM exported to a custom
        // compendium keep respecting it.
        index = await pack.getIndex({ fields: ["system.private"] });
      } catch ( err ) {
        console.warn(`Open Legend | Could not index compendium ${pack.collection}`, err);
        continue;
      }
      const label = pack.metadata?.label ?? pack.collection;
      for ( const e of index ) {
        if ( e.type !== type ) continue;
        if ( e.system?.private ) continue;
        push(e.uuid, e.name, e.img, label);
      }
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * "Add" control on an inventory section: pick an EXISTING item of that section's
   * type (from the world Items directory or any Item compendium) through a
   * searchable dialog, then embed a copy of it on the actor. The blank-item path
   * stays on the sibling "Create" control (#onItemCreate).
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  The control carrying data-type.
   */
  static async #onItemBrowse(event, target) {
    event.preventDefault();
    const type = target.dataset.type;
    if ( !type ) return null;

    const entries = await OpenLegendActorSheet.#browsableItems(type);
    if ( !entries.length ) {
      ui.notifications?.warn(`No ${type} items were found in the compendiums — use Create to make one.`);
      return null;
    }

    const uuid = await OpenLegendActorSheet.#promptItemPicker(type, entries);
    if ( !uuid ) return null;

    const doc = await fromUuid(uuid);
    if ( !doc ) {
      ui.notifications?.warn("Selected item could not be found.");
      return null;
    }
    // Inventory types are shared across forms, so the copy always lands on the
    // live actor (this.document; this.actor is the clone while previewing a form).
    const [created] = await this.document.createEmbeddedDocuments("Item", [doc.toObject()]);
    return created ?? null;
  }

  /**
   * The item-picker dialog: a search field that live-filters a list of rows
   * (name + source pack). Clicking a row selects it; double-clicking, or
   * pressing Enter in the search field when exactly one row matches, confirms
   * immediately. Resolves to the chosen item's uuid, or null on cancel.
   * @param {string} type  "weapon" | "armor" | "gear"
   * @param {Array<{uuid: string, name: string, img: string, source: string}>} entries
   * @returns {Promise<string|null>}
   * @private
   */
  static async #promptItemPicker(type, entries) {
    const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
    const labels = { weapon: "Weapon", armor: "Armor", gear: "Adventuring Gear" };
    const label = labels[type] ?? type.capitalize();

    const rows = entries.map(e => `
      <li class="ol-picker-row" data-uuid="${esc(e.uuid)}" data-search="${esc(`${e.name} ${e.source}`.toLowerCase())}">
        <img src="${esc(e.img)}" alt="" width="24" height="24"/>
        <span class="ol-picker-name">${esc(e.name)}</span>
        <span class="ol-picker-source">${esc(e.source)}</span>
      </li>`).join("");

    const content = `
      <div class="ol-item-picker">
        <div class="ol-picker-search">
          <i class="fas fa-magnifying-glass"></i>
          <input type="text" name="filter" placeholder="Search ${esc(label)}…" autocomplete="off" autofocus/>
        </div>
        <ol class="ol-picker-list">${rows}</ol>
        <p class="ol-picker-empty hint" hidden>No match.</p>
      </div>`;

    const { DialogV2 } = foundry.applications.api;
    const result = await DialogV2.wait({
      window: { title: `Add ${label}` },
      classes: ["openlegend", "ol-item-picker-app"],
      position: { width: 460 },
      content,
      rejectClose: false,
      render: (event, dialog) => {
        const root = dialog.element;
        const input = root.querySelector('input[name="filter"]');
        const list = root.querySelector(".ol-picker-list");
        const empty = root.querySelector(".ol-picker-empty");
        const confirm = () => root.querySelector('button[data-action="ok"]')?.click();
        const visibleRows = () => Array.from(list.querySelectorAll(".ol-picker-row:not([hidden])"));

        const select = row => {
          for ( const r of list.querySelectorAll(".ol-picker-row.selected") ) r.classList.remove("selected");
          if ( row ) row.classList.add("selected");
        };

        list.addEventListener("click", ev => {
          const row = ev.target.closest(".ol-picker-row");
          if ( row ) select(row);
        });
        list.addEventListener("dblclick", ev => {
          const row = ev.target.closest(".ol-picker-row");
          if ( !row ) return;
          select(row);
          confirm();
        });

        input?.addEventListener("input", () => {
          const q = input.value.trim().toLowerCase();
          let shown = 0;
          for ( const row of list.querySelectorAll(".ol-picker-row") ) {
            const match = !q || row.dataset.search.includes(q);
            row.hidden = !match;
            if ( match ) shown++;
          }
          if ( empty ) empty.hidden = shown > 0;
          // Keep the selection meaningful: drop it when the filter hides it.
          const selected = list.querySelector(".ol-picker-row.selected");
          if ( selected?.hidden ) select(null);
        });

        input?.addEventListener("keydown", ev => {
          if ( ev.key !== "Enter" ) return;
          ev.preventDefault();
          // Enter confirms when the filter has narrowed things down to one row
          // (or when a row is already selected).
          const rows = visibleRows();
          if ( !list.querySelector(".ol-picker-row.selected") && (rows.length === 1) ) select(rows[0]);
          confirm();
        });
      },
      buttons: [
        {
          action: "ok",
          label: "Add",
          icon: "fas fa-plus",
          default: true,
          callback: (event, button, dialog) =>
            dialog.element.querySelector(".ol-picker-row.selected")?.dataset.uuid ?? ""
        },
        { action: "cancel", label: "Cancel", icon: "fas fa-times" }
      ]
    });

    if ( typeof result !== "string" ) return null;
    if ( !result ) {
      ui.notifications?.warn(`Choose ${type === "armor" ? "an" : "a"} ${type} from the list.`);
      return null;
    }
    return result;
  }

  /**
   * Open the sheet of the embedded Item identified by the nearest data-item-id.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onItemEdit(event, target) {
    event.preventDefault();
    const id = target.closest("[data-item-id]")?.dataset.itemId;
    if ( !id ) return;
    // Previewing a form: shared items (same ids) open their LIVE sheet; the
    // form's own feats/actions open a patched sheet editing the stored snapshot.
    if ( this.isFormPreview ) {
      const live = this.document.items.get(id);
      if ( live ) return OpenLegendActorSheet.#openDocumentSheet(live);
      return this.#openStoredFormItemSheet(id);
    }
    OpenLegendActorSheet.#openDocumentSheet(this.actor.items.get(id));
  }

  /**
   * Generate an Action from an inventory item. For a WEAPON, offers a Damaging
   * action (preconfigured from the weapon's properties), a Bane action per listed
   * weapon bane, and (Defensive) a Defend interrupt. For ANY item that grants
   * EXTRAORDINARY banes/boons, also offers one option per granted bane/boon —
   * generated as an item invocation (the item's value supplies the dice + caps the
   * level), exactly as if picked from the action sheet's "✨ … — <Item>" option.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  Element within an item row (carries data-item-id).
   */
  static async #onActionGenerate(event, target) {
    event.preventDefault();
    const id = target.closest("[data-item-id]")?.dataset.itemId;
    const item = id ? this.actor.items.get(id) : null;
    if ( !item ) return;
    const isWeapon = (item.type === "weapon");

    const cfg = CONFIG.OPENLEGEND ?? {};
    const { DialogV2 } = foundry.applications.api;
    const esc = s => foundry.utils.escapeHTML?.(s) ?? s;

    // Weapon-only options: a Damaging attack, listed weapon banes, Defend interrupt.
    const banes = isWeapon ? (item.system.banes ?? []).filter(b => b?.name) : [];
    const defensive = isWeapon ? (cfg.weaponDefensiveValue?.(item) ?? 0) : 0;

    // Extraordinary item invocations (any item type): granted banes/boons with a
    // value > 0. Each becomes an item-invocation action.
    const xBanes = (item.system.extraordinary ? (item.system.extraordinaryBanes ?? []) : [])
      .filter(b => b?.name && (Number(b.powerLevel) > 0));
    const xBoons = (item.system.extraordinary ? (item.system.extraordinaryBoons ?? []) : [])
      .filter(b => b?.name && (Number(b.powerLevel) > 0));

    const damagingRow = isWeapon
      ? `<label class="ol-gen-row"><input type="radio" name="genChoice" value="damaging" checked/> <i class="fas fa-burst"></i> Damaging attack</label>`
      : "";
    const baneRows = banes.map((b, i) =>
      `<label class="ol-gen-row"><input type="radio" name="genChoice" value="bane:${i}"/> <i class="fas fa-skull"></i> ${esc(b.name)} bane</label>`
    ).join("");
    const defendRow = defensive
      ? `<label class="ol-gen-row"><input type="radio" name="genChoice" value="defend"/> <i class="fas fa-shield-halved"></i> Defend interrupt (Defensive ${defensive})</label>`
      : "";
    const xBaneRows = xBanes.map((b, i) =>
      `<label class="ol-gen-row"><input type="radio" name="genChoice" value="xbane:${i}"/> <i class="fas fa-skull"></i> ${esc(b.name)} bane <span class="ol-gen-tag">✨ ${b.powerLevel}</span></label>`
    ).join("");
    const xBoonRows = xBoons.map((b, i) =>
      `<label class="ol-gen-row"><input type="radio" name="genChoice" value="xboon:${i}"/> <i class="fas fa-hands-holding"></i> ${esc(b.name)} boon <span class="ol-gen-tag">✨ ${b.powerLevel}</span></label>`
    ).join("");

    // If there are no weapon options, the first extraordinary option starts checked.
    let rows = [damagingRow, baneRows, defendRow, xBaneRows, xBoonRows].filter(Boolean).join("");
    const anyOption = !!rows;
    // Ensure exactly one radio is checked: the damaging row carries `checked`; if
    // it's absent (a non-weapon item), check the first radio in the list.
    if ( anyOption && !damagingRow ) rows = rows.replace('type="radio"', 'type="radio" checked');
    const content = `
      <div class="ol-generate-action">
        <p>Create an action from <strong>${esc(item.name)}</strong>:</p>
        ${rows || `<p class="bane-hint">This item has no generatable actions.</p>`}
      </div>`;

    if ( !anyOption ) {
      ui.notifications?.warn(`${item.name} has no actions to generate.`);
      return;
    }

    const choice = await DialogV2.wait({
      window: { title: "Generate Action" },
      classes: ["openlegend"],
      content,
      rejectClose: false,
      buttons: [
        { action: "create", label: "Create", icon: "fas fa-plus", default: true,
          callback: (ev, button, dialog) =>
            dialog.element.querySelector('input[name="genChoice"]:checked')?.value ?? "" },
        { action: "cancel", label: "Cancel", icon: "fas fa-times" }
      ]
    });
    if ( !choice || (choice === "cancel") ) return;
    // No weapon damaging row means nothing is checked by default — guard the empty value.
    if ( !choice.trim() ) {
      ui.notifications?.warn("Choose an action to generate.");
      return;
    }

    // Resolve the item's Area ONCE (prompting when it lists several) so every
    // area-bearing choice below uses the same picked area. A Defend interrupt has
    // no area. `undefined` (not "area" in opts) lets a builder auto-resolve when we
    // skip the prompt; here we always resolve so multi-area items prompt exactly once.
    const wantsArea = (choice !== "defend");
    const pickedArea = wantsArea ? await cfg.pickItemArea(item) : null;
    const areaOpts = wantsArea ? { area: pickedArea } : {};

    let data;
    if ( choice.startsWith("xbane:") ) data = await cfg.buildExtraordinaryBaneAction(item, this.actor, { ...xBanes[Number(choice.slice(6))], area: pickedArea });
    else if ( choice.startsWith("xboon:") ) data = await cfg.buildExtraordinaryBoonAction(item, this.actor, { ...xBoons[Number(choice.slice(6))], area: pickedArea });
    else if ( choice.startsWith("bane:") ) data = await cfg.buildWeaponBaneAction(item, this.actor, banes[Number(choice.slice(5))], areaOpts);
    else if ( choice === "defend" ) data = cfg.buildWeaponDefendAction(item, this.actor);
    else if ( choice === "damaging" ) data = cfg.buildWeaponDamagingAction(item, this.actor, areaOpts);
    if ( !data ) return;

    // Previewing a form: the generated action belongs to that form's snapshot.
    if ( this.isFormPreview ) {
      const newId = await Forms.addItemToForm(this.document, this.#previewFormId, data);
      ui.notifications?.info(`Created action “${data.name}” on the previewed form.`);
      if ( newId ) await this.#openStoredFormItemSheet(newId);
      return;
    }
    const [created] = await this.actor.createEmbeddedDocuments("Item", [data]);
    ui.notifications?.info(`Created action “${data.name}”.`);
    OpenLegendActorSheet.#openDocumentSheet(created);
  }

  /**
   * Consume a Consumable extraordinary item: invoke one of its listed boons (auto-
   * success, no roll — SRD Consumable), then use up the item. If the item lists no
   * boons, warn and keep it. When several are listed, prompt which to invoke. The
   * boon card carries a draggable chip + Grant + re-aim buttons; an instantaneous
   * boon runs its effect when granted. Deletion is gated by the "Delete Consumed
   * Items" world setting (off → the item is kept).
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  Carries data-item-id.
   */
  static async #onItemConsume(event, target) {
    event.preventDefault();
    const id = target.closest("[data-item-id]")?.dataset.itemId;
    // Consumables are SHARED gear — use the live actor's copy (same id) so the
    // expend/delete really lands.
    const item = id ? this.document.items.get(id) : null;
    if ( !item ) return;

    const cfg = CONFIG.OPENLEGEND ?? {};
    const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
    const { DialogV2 } = foundry.applications.api;

    // The item's listed boons (a name + a value > 0). No boons → nothing to invoke;
    // warn and DO NOT consume the item.
    const boons = (item.system.extraordinaryBoons ?? []).filter(b => b?.name && (Number(b.powerLevel) > 0));
    if ( !boons.length ) {
      ui.notifications?.warn(`${item.name} lists no boons to invoke — nothing to consume.`);
      return;
    }

    // One boon → use it; several → prompt which. Cancel keeps the item.
    let chosen = boons[0];
    if ( boons.length > 1 ) {
      const rows = boons.map((b, i) =>
        `<label class="ol-gen-row"><input type="radio" name="boonPick" value="${i}" ${i === 0 ? "checked" : ""}/> <i class="fas fa-hands-holding"></i> ${esc(b.name)} <span class="ol-gen-tag">✨ ${b.powerLevel}</span></label>`
      ).join("");
      const idx = await DialogV2.wait({
        window: { title: "Consume — Choose a Boon" },
        classes: ["openlegend"],
        content: `<div class="ol-generate-action"><p>Invoke which boon from <strong>${esc(item.name)}</strong>? The item is consumed afterward.</p>${rows}</div>`,
        rejectClose: false,
        buttons: [
          { action: "ok", label: "Invoke", icon: "fas fa-hands-holding", default: true,
            callback: (ev, button, dialog) => dialog.element.querySelector('input[name="boonPick"]:checked')?.value ?? "" },
          { action: "cancel", label: "Cancel", icon: "fas fa-times" }
        ]
      });
      if ( (idx === "cancel") || (idx == null) || (idx === "") ) return;   // keep the item
      chosen = boons[Number(idx)] ?? boons[0];
    }

    const boon = await cfg.resolveBoonByName?.(chosen.name);
    if ( !boon ) { ui.notifications?.warn(`Boon "${chosen.name}" not found in any compendium.`); return; }

    // A single current target (if any) binds the card's Grant button.
    const targetToken = [...(game.user?.targets ?? [])][0] ?? null;

    const { postBoonCard } = await import("../dice/action-roll.mjs");
    await postBoonCard({
      boon,
      cap: Number(chosen.powerLevel) || 0,
      tokenUuid: targetToken?.document?.uuid ?? "",
      targetName: targetToken?.name ?? "the target",
      actor: this.actor,
      intro: `<strong>${esc(boon.name)}</strong> invoked from <strong>${esc(item.name)}</strong> (Consumable — auto-success).`
    });

    // Consume: use up one (shared expend logic — stack decrements, single deletes,
    // gated by the "Delete Consumed Items" setting).
    const qtyBefore = Math.max(1, Math.floor(Number(item.system?.quantity) || 1));
    const name = item.name;
    const outcome = await (cfg.expendItem?.(item) ?? "kept");
    if ( outcome === "decremented" ) ui.notifications?.info(`Consumed one ${name} (${qtyBefore - 1} left).`);
    else if ( outcome === "deleted" ) ui.notifications?.info(`Consumed ${name}.`);
    else ui.notifications?.info(`Invoked ${boon.name} from ${name} (item kept — deletion disabled).`);
  }

  /**
   * Use an EXPENDABLE (non-Augmenting) extraordinary item: open the Use dialog —
   * pick a rolling stat from the item's listed banes/attributes, targets,
   * range and advantage — then roll it as a temporary action through the normal
   * roll pipeline. A completed roll expends one use (gated by the "Expend Used
   * Expendable Items" world setting); canceling keeps the item.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  Carries data-item-id.
   */
  static async #onItemExpend(event, target) {
    event.preventDefault();
    const id = target.closest("[data-item-id]")?.dataset.itemId;
    // Expendables are SHARED gear — use the live actor's copy (same id).
    const item = id ? this.document.items.get(id) : null;
    if ( !item ) return;
    const { useExpendableItem } = await import("../dialogs/expendable-use.mjs");
    await useExpendableItem(item, this.document);
  }

  /**
   * Open a document's configuration sheet, robustly. Some documents can have a
   * stale or unresolved `sheet` reference (e.g. a `core.sheetClass` override flag
   * left pointing at a sheet id from before the system was renamed), which makes
   * `doc.sheet` come back null and `doc.sheet?.render()` silently do nothing. We
   * clear any such stale override, force a fresh sheet, and surface a warning if a
   * sheet still cannot be resolved — instead of failing quietly.
   * @param {Document|null} doc
   * @returns {Promise<void>}
   * @private
   */
  static async #openDocumentSheet(doc) {
    if ( !doc ) return;
    // Drop a stale per-document sheet-class override that no longer resolves to a
    // registered sheet (a leftover from the system-id rename). Harmless if absent.
    try {
      const override = doc.getFlag?.("core", "sheetClass");
      if ( override ) {
        const cfg = CONFIG[doc.documentName];
        const registered = cfg?.sheetClasses?.[doc.type ?? "base"] ?? {};
        if ( !(override in registered) ) await doc.unsetFlag("core", "sheetClass");
      }
    } catch ( _err ) { /* non-fatal */ }

    const sheet = doc.sheet;
    if ( !sheet ) {
      ui.notifications?.error(`Could not open the sheet for "${doc.name}". No sheet is registered for ${doc.documentName} type "${doc.type}".`);
      return;
    }
    await sheet.render({ force: true });
  }

  /**
   * Delete the embedded Item identified by the nearest data-item-id. Works for
   * boon/bane (.item) and perk/flaw (.feature-item) rows alike.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onItemDelete(event, target) {
    event.preventDefault();
    const id = target.closest("[data-item-id]")?.dataset.itemId;
    if ( !id ) return;
    // Previewing a form: shared items delete from the live actor; the form's own
    // feats/actions delete from the stored snapshot (AF/Companion feats refused).
    if ( this.isFormPreview ) {
      if ( this.document.items.get(id) ) return this.document.deleteEmbeddedDocuments("Item", [id]);
      return this.#deleteStoredFormItem(id);
    }
    // Removing an Alternate Form / Companion feat warns + deletes its linked form /
    // companion and the feat itself (handled); for everything else, delete normally.
    const item = this.actor.items.get(id);
    if ( await this.#removeAlternateFormFeat(item) ) return;
    if ( await this.#removeCompanionFeat(item) ) return;
    await this.actor.deleteEmbeddedDocuments("Item", [id]);
  }

  /**
   * Toggle an armor item's equipped state from the inventory row. Equipping
   * re-derives Guard / Speed via the actor's prepareDerivedData.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onArmorToggleEquip(event, target) {
    event.preventDefault();
    const id = target.closest("[data-item-id]")?.dataset.itemId;
    // Armor is SHARED across forms — mutate the live actor's copy (same id).
    const item = id ? this.document.items.get(id) : null;
    if ( !item || (item.type !== "armor") ) return;
    await item.update({ "system.equipped": !item.system.equipped });
  }

  /**
   * Toggle a weapon's equipped state from the inventory row. Equipping a
   * one-/two-handed weapon takes its inherent hand count; equipping a versatile
   * weapon prompts for a one- or two-handed grip (stored in system.equipHands).
   * Hand slots are soft: if equipping pushes the wielder past two hands, a
   * notification warns but the equip still goes through (the sheet shows a
   * persistent over-hands banner too). Unequipping just clears the flag.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onWeaponToggleEquip(event, target) {
    event.preventDefault();
    const id = target.closest("[data-item-id]")?.dataset.itemId;
    // Weapons are SHARED across forms — mutate the live actor's copy (same id).
    const item = id ? this.document.items.get(id) : null;
    if ( !item || (item.type !== "weapon") ) return;

    const cfg = CONFIG.OPENLEGEND ?? {};

    // Unequip: clear and we're done.
    if ( item.system.equipped ) {
      await item.update({ "system.equipped": false });
      return;
    }

    // Equip: figure out how many hands this weapon will take. Two Weapon Brute lets a
    // two-handed weapon be wielded one-handed (see effectiveWeaponHands).
    const need = cfg.weaponHandsFor ? cfg.weaponHandsFor(item.system.categories ?? []) : 1;
    let equipHands = Number(need) || 1;       // the grip stored on the weapon
    if ( need === "versatile" ) {
      const chosen = await this.#promptWeaponGrip(item);
      if ( chosen === null ) return;        // dialog cancelled
      equipHands = chosen;
    }
    const hands = cfg.effectiveWeaponHands
      ? cfg.effectiveWeaponHands(this.actor, item, { equipHands })
      : equipHands;

    // Soft hand-slot check: warn (but allow) if this equip exceeds two hands.
    const maxHands = Number(cfg.maxHands ?? 2);
    const inUse = this.actor.items.reduce((sum, w) => {
      if ( (w.type !== "weapon") || !w.system.equipped || (w.id === item.id) ) return sum;
      return sum + (cfg.effectiveWeaponHands ? cfg.effectiveWeaponHands(this.actor, w) : 1);
    }, 0);
    if ( inUse + hands > maxHands ) {
      ui.notifications?.warn(
        `Equipping ${item.name} uses ${inUse + hands} of ${maxHands} hands — more than you have.`
      );
    }

    await item.update({ "system.equipped": true, "system.equipHands": equipHands });
  }

  /**
   * Prompt for a versatile weapon's grip: one or two hands. Returns the chosen
   * hand count, or null if cancelled.
   * @param {Item} item
   * @returns {Promise<1|2|null>}
   * @private
   */
  async #promptWeaponGrip(item) {
    const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
    const { DialogV2 } = foundry.applications.api;
    const result = await DialogV2.wait({
      window: { title: `Equip ${item.name}` },
      classes: ["openlegend"],
      content: `<div class="ol-weapon-grip"><p>${esc(item.name)} is versatile — how do you want to wield it?</p></div>`,
      rejectClose: false,
      buttons: [
        { action: "one", label: "One-handed", icon: "fas fa-hand", default: true },
        { action: "two", label: "Two-handed", icon: "fas fa-hands" },
        { action: "cancel", label: "Cancel", icon: "fas fa-times" }
      ]
    });
    if ( (result === "one") ) return 1;
    if ( (result === "two") ) return 2;
    return null;
  }

  /* -------------------------------------------- */
  /*  Active Effects                              */
  /* -------------------------------------------- */

  /**
   * Resolve the ActiveEffect for an effect-row control. A directly-applied
   * effect lives on the actor; a transferred one lives on its source item
   * (data-item-id on the row). Returns null if it can't be found.
   * @param {HTMLElement} target
   * @returns {ActiveEffect|null}
   */
  #effectFromTarget(target) {
    const row = target.closest("[data-effect-id]");
    if ( !row ) return null;
    const effectId = row.dataset.effectId;
    const itemId = row.dataset.itemId;
    // Effects are live-actor state (conditions, item-transferred effects) — always
    // resolve against this.document; during a form preview this.actor is a clone
    // whose effects cannot be written.
    const owner = itemId ? this.document.items.get(itemId) : this.document;
    return owner?.effects.get(effectId) ?? null;
  }

  /**
   * Create a new, blank Active Effect on the actor and open its config sheet.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   */
  static async #onEffectCreate(event) {
    event.preventDefault();
    const [effect] = await this.document.createEmbeddedDocuments("ActiveEffect", [{
      name: "New Effect",
      img: "icons/svg/aura.svg",
      disabled: false,
      transfer: false,
      showIcon: 2 /* CONST.ACTIVE_EFFECT_SHOW_ICON.ALWAYS — always show on token */
    }]);
    OpenLegendActorSheet.#openDocumentSheet(effect);
  }

  /**
   * Open an effect's config sheet. Works for directly-applied effects and for
   * effects transferred from an owned item (opens the effect on that item).
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onEffectEdit(event, target) {
    event.preventDefault();
    OpenLegendActorSheet.#openDocumentSheet(this.#effectFromTarget(target));
  }

  /**
   * Enable/disable an effect. A transferred effect is toggled on its source item,
   * which propagates to the actor.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onEffectToggle(event, target) {
    event.preventDefault();
    const effect = this.#effectFromTarget(target);
    if ( effect ) await effect.update({ disabled: !effect.disabled });
  }

  /**
   * Delete an effect. Only directly-applied effects are deletable here; an effect
   * transferred from an item must be managed (or its item removed) elsewhere.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onEffectDelete(event, target) {
    event.preventDefault();
    const effect = this.#effectFromTarget(target);
    if ( !effect ) return;
    if ( effect.parent !== this.document ) {
      ui.notifications?.info("This effect comes from an item; remove or disable it on that item.");
      return;
    }
    await effect.delete();
  }

  /**
   * Step a leveled effect to the next/previous power level its change rows
   * define (e.g. Demoralized 3 → 6 → 8). Updating the flag re-applies the rows
   * the new level unlocks (OpenLegendActiveEffect.applyChange).
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  Carries data-direction "up" | "down".
   */
  static async #onEffectLevelStep(event, target) {
    event.preventDefault();
    const effect = this.#effectFromTarget(target);
    const levels = effect?.flags?.openlegend?.changeLevels ?? [];
    const defined = [...new Set(levels.map(Number).filter(l => Number.isFinite(l) && (l > 0)))]
      .sort((x, y) => x - y);
    if ( !defined.length ) return;
    const up = target.dataset.direction === "up";

    // Stacking condition (e.g. Fatigued): the stepper moves the STACK level by
    // one, clamped to 1..highest-tier (rest removes a level; re-applying adds).
    if ( effect.flags?.openlegend?.stacking ) {
      const max = Math.max(...defined);
      const cur = Math.max(1, Math.floor(Number(effect.flags.openlegend.stackLevel) || 1));
      const next = Math.min(max, Math.max(1, cur + (up ? 1 : -1)));
      if ( next === cur ) return;
      await effect.update({ "flags.openlegend.stackLevel": next });
      return;
    }

    // Normal leveled effect: jump to the next/previous defined power-level threshold.
    const pl = Number(effect.flags.openlegend.powerLevel ?? 0);
    const next = up ? defined.find(l => l > pl) : [...defined].reverse().find(l => l < pl);
    if ( next === undefined ) return;
    await effect.update({ "flags.openlegend.powerLevel": next });
  }

  /**
   * Expand/collapse a condition row's detail panel (the per-level effects the
   * bane/boon document offers).
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onConditionExpand(event, target) {
    event.preventDefault();
    const id = target.closest("[data-effect-id]")?.dataset.effectId;
    if ( !id ) return;
    if ( this.#expandedConditions.has(id) ) this.#expandedConditions.delete(id);
    else this.#expandedConditions.add(id);
    this.render(false);
  }

  /**
   * Remove a condition entirely: delete the applied Active Effect AND the
   * embedded bane/boon document it came with (the pair the drop created). The
   * document is kept if another condition effect still references it (e.g. the
   * same bane applied twice).
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  Inside a row carrying data-effect-id (+ data-doc-id).
   */
  static async #onConditionDelete(event, target) {
    event.preventDefault();
    const row = target.closest("[data-effect-id]");
    // Conditions are live-actor state — always this.document (this.actor is a
    // read-through clone while previewing a form).
    const effect = this.document.effects.get(row?.dataset.effectId);
    if ( !effect ) return;
    const docId = row.dataset.docId;
    await effect.delete();
    if ( docId ) {
      const sourceName = this.document.items.get(docId)?.name;
      const stillReferenced = sourceName && this.document.effects.some(e =>
        (e.flags?.openlegend?.fromBane === sourceName) || (e.flags?.openlegend?.fromBoon === sourceName));
      if ( !stillReferenced ) await this.document.items.get(docId)?.delete();
    }
  }

  /**
   * Toggle a bane condition's Potent flag (target resists at disadvantage 1).
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  Inside a row carrying data-effect-id.
   */
  static async #onConditionTogglePotent(event, target) {
    event.preventDefault();
    const effect = this.document.effects.get(target.closest("[data-effect-id]")?.dataset.effectId);
    if ( !effect ) return;
    await effect.update({ "flags.openlegend.potent": !effect.flags?.openlegend?.potent });
  }

  /**
   * Open the Resist Banes dialog for this actor (the sheet's Resist control). The
   * dialog + roll logic lives in action-roll.mjs so the hotbar macro can reuse it.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   */
  static async #onResistBanes(event) {
    event.preventDefault();
    // Live actor: banes/conditions are live combat state (this.actor is a clone
    // while previewing a form).
    const { resistBanesDialog } = await import("../dice/action-roll.mjs");
    await resistBanesDialog(this.document);
  }

  /**
   * Hospitaler (feat): grant each targeted ally an immediate resist roll with
   * advantage 1. The roll logic lives in action-roll.mjs so the hotbar macro can
   * reuse it.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   */
  static async #onHospitaler(event) {
    event.preventDefault();
    const { hospitalerResist } = await import("../dice/action-roll.mjs");
    await hospitalerResist(this.document);
  }

  /**
   * Open the Rest / Heal Lethal Damage dialog for this actor (the Actions section
   * Rest control). Heals lethal damage per the Lethal Damage rules: 1/day per
   * Fortitude point (min 1), plus an optional full-time attendant's best Creation,
   * Presence, or Learning score.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   */
  static async #onLethalRest(event) {
    event.preventDefault();
    // Live actor: HP/lethal healing is live state.
    const { lethalRestDialog } = await import("../dice/action-roll.mjs");
    await lethalRestDialog(this.document);
  }

  /**
   * Toggle Battle Trance on/off (the feat-row toggle control). Flips the feat
   * flag, re-derives the actor's stats, and posts a chat note.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   */
  static async #onBattleTranceToggle(event) {
    event.preventDefault();
    event.stopPropagation();
    // The ONE thing blocked while previewing a form: Battle Trance is a combat
    // state of the ACTIVE form (its feat lives in the live items).
    if ( this.isFormPreview ) {
      ui.notifications?.warn("Battle Trance belongs to your ACTIVE form — Transform into this form to toggle it.");
      return;
    }
    const { toggleBattleTrance } = await import("../dice/action-roll.mjs");
    await toggleBattleTrance(this.actor);
  }

  /**
   * Reckless Attack (feat; requires being in a Battle Trance): inflict 5 HP of
   * unmitigable self-damage to gain an extra attack as a minor action. The logic
   * lives in action-roll.mjs so the hotbar macro can reuse it.
   * @this {OpenLegendActorSheet}
   * @param {PointerEvent} event
   */
  static async #onRecklessAttack(event) {
    event.preventDefault();
    event.stopPropagation();
    // Live actor: self-damage + trance check are live state.
    const { recklessAttack } = await import("../dice/action-roll.mjs");
    await recklessAttack(this.document);
  }
}
