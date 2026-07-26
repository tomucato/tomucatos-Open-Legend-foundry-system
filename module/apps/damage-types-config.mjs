/**
 * Damage Types configuration menu (world setting).
 *
 * Shows every attribute category with its BUILT-IN damage types (read-only) and
 * any USER-DEFINED types (removable), plus a form to add a new type under a chosen
 * attribute. Custom types are stored in the world setting
 * `OPENLEGEND.CUSTOM_DAMAGE_TYPES_SETTING` and merged into the catalog everywhere
 * via OPENLEGEND.allDamageTypes / allDamageTypesByAttribute / allDamageTypeDescriptions.
 */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class OpenLegendDamageTypesConfig extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    id: "openlegend-damage-types-config",
    classes: ["openlegend", "ol-damage-types-config"],
    tag: "form",
    window: { title: "Damage Types", icon: "fas fa-burst", resizable: true, contentClasses: ["standard-form"] },
    position: { width: 620, height: 640 },
    form: { handler: OpenLegendDamageTypesConfig.#onSubmit, closeOnSubmit: false },
    actions: {
      addType: OpenLegendDamageTypesConfig.#onAddType,
      removeType: OpenLegendDamageTypesConfig.#onRemoveType
    }
  };

  /** @override */
  static PARTS = {
    body: { template: "systems/tomucatos-open-legend-rpg-system/templates/apps/damage-types-config.html" }
  };

  /* -------------------------------------------- */

  /** @override */
  async _prepareContext() {
    const cfg = CONFIG.OPENLEGEND ?? {};
    const labels = cfg.allDamageTypes ? cfg.allDamageTypes() : (cfg.damageTypes ?? {});
    const builtinByAttr = cfg.damageTypesByAttribute ?? {};
    const custom = cfg.customDamageTypes ? cfg.customDamageTypes() : [];

    // Build a row per attribute that has ANY damage type (built-in or custom),
    // preserving the attribute label order from attributeLabels.
    const customByAttr = {};
    for ( const t of custom ) {
      if ( !t?.attribute ) continue;
      (customByAttr[t.attribute] ??= []).push(t);
    }
    const attrKeys = new Set([...Object.keys(builtinByAttr), ...Object.keys(customByAttr)]);
    const categories = [];
    for ( const [key, label] of Object.entries(cfg.attributeLabels ?? {}) ) {
      if ( !attrKeys.has(key) ) continue;
      // Descriptions resolved WITH this attribute's context, so per-attribute
      // variants (e.g. Poison under Entropy vs Creation) show the right text.
      const descs = cfg.allDamageTypeDescriptions ? cfg.allDamageTypeDescriptions(key) : (cfg.damageTypeDescriptions ?? {});
      const builtins = (builtinByAttr[key] ?? []).map(k => ({ key: k, label: labels[k] ?? k, description: descs[k] ?? "" }));
      const customs = (customByAttr[key] ?? []).map(t => ({ key: t.key, label: t.label || t.key, description: t.description || "" }));
      categories.push({ key, label, builtins, customs });
    }

    // The attribute <select> for the add-form: every attribute (so a GM can add a
    // damage type to an attribute that currently has none).
    const attributeOptions = cfg.attributeLabels ?? {};

    return { categories, attributeOptions };
  }

  /* -------------------------------------------- */

  /** Read the current custom list from the setting. */
  static #current() {
    const cfg = CONFIG.OPENLEGEND ?? {};
    return (cfg.customDamageTypes ? cfg.customDamageTypes() : []).map(t => ({ ...t }));
  }

  /** Persist a custom-types array to the world setting and re-render open sheets. */
  static async #save(list) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    await game.settings.set(cfg.SYSTEM_ID, cfg.CUSTOM_DAMAGE_TYPES_SETTING, list);
  }

  /* -------------------------------------------- */

  /**
   * Add a new custom damage type from the add-form fields. Validates the label and
   * attribute, derives a unique key, and refuses duplicates of any existing type.
   * @this {OpenLegendDamageTypesConfig}
   */
  static async #onAddType(event, target) {
    const root = this.element;
    const label = root.querySelector('[name="newLabel"]')?.value?.trim() ?? "";
    const attribute = root.querySelector('[name="newAttribute"]')?.value ?? "";
    const description = root.querySelector('[name="newDescription"]')?.value?.trim() ?? "";
    const cfg = CONFIG.OPENLEGEND ?? {};

    if ( !label ) { ui.notifications?.warn("Enter a name for the damage type."); return; }
    if ( !attribute || !(cfg.attributeLabels ?? {})[attribute] ) {
      ui.notifications?.warn("Choose an attribute for the damage type."); return;
    }
    const key = cfg.slugifyDamageType ? cfg.slugifyDamageType(label) : label.toLowerCase();
    if ( !key ) { ui.notifications?.warn("That name has no usable letters or digits."); return; }

    // A key must be unique across the whole catalog (built-in + custom).
    const allKeys = Object.keys(cfg.allDamageTypes ? cfg.allDamageTypes() : (cfg.damageTypes ?? {}));
    const list = OpenLegendDamageTypesConfig.#current();
    if ( allKeys.includes(key) && !list.some(t => t.key === key) ) {
      ui.notifications?.warn(`A built-in damage type "${label}" (${key}) already exists.`); return;
    }
    if ( list.some(t => (t.key === key) && (t.attribute === attribute)) ) {
      ui.notifications?.warn(`"${label}" is already defined under that attribute.`); return;
    }

    list.push({ key, label, description, attribute });
    await OpenLegendDamageTypesConfig.#save(list);
    this.render();
  }

  /**
   * Remove a custom damage type (by key + attribute, from the row's data attrs).
   * Built-in types have no remove control, so only customs reach here.
   * @this {OpenLegendDamageTypesConfig}
   */
  static async #onRemoveType(event, target) {
    const key = target.dataset.key;
    const attribute = target.dataset.attribute;
    if ( !key ) return;
    const list = OpenLegendDamageTypesConfig.#current()
      .filter(t => !((t.key === key) && (t.attribute === attribute)));
    await OpenLegendDamageTypesConfig.#save(list);
    this.render();
  }

  /* -------------------------------------------- */

  /**
   * Form submit (Save): persist edits to existing CUSTOM types' labels/descriptions
   * (built-ins are read-only). Inputs are named `label.<attr>.<key>` /
   * `desc.<attr>.<key>`.
   * @this {OpenLegendDamageTypesConfig}
   */
  static async #onSubmit(event, form, formData) {
    const data = formData.object;
    const list = OpenLegendDamageTypesConfig.#current().map(t => {
      const label = data[`label.${t.attribute}.${t.key}`];
      const description = data[`desc.${t.attribute}.${t.key}`];
      return {
        ...t,
        label: (label !== undefined) ? String(label).trim() || t.key : t.label,
        description: (description !== undefined) ? String(description).trim() : t.description
      };
    });
    await OpenLegendDamageTypesConfig.#save(list);
    this.render();
  }
}
