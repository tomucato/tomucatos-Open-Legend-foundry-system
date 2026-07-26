export class OpenLegendItem extends Item {
  prepareData() {
    super.prepareData();
    this.#deriveExtraordinary();
  }

  /**
   * An item is "extraordinary" whenever it grants anything — an attribute, boon,
   * bane, or property. There is no manual toggle: the flag is derived purely from
   * the presence of grants, so adding the first row makes the item extraordinary
   * and clearing them all makes it mundane again. Every downstream consumer still
   * reads `system.extraordinary` as its gate; only the source of truth changed.
   */
  #deriveExtraordinary() {
    const sys = this.system ?? {};
    if ( !("extraordinary" in sys) ) return;   // types without the field (e.g. action)
    const has = (arr) => Array.isArray(arr) && arr.length > 0;
    // A legendary property also makes the item extraordinary (SRD: legendary items
    // may possess any extraordinary property — legendary is a superset).
    sys.legendary = has(sys.legendaryProperties);
    sys.extraordinary = has(sys.extraordinaryAttributes)
      || has(sys.extraordinaryBoons)
      || has(sys.extraordinaryBanes)
      || has(sys.extraordinaryProperties)
      || sys.legendary;
  }

  /**
   * Give a newly-created ACTION a category-appropriate default icon (Damaging →
   * sword, Boon → holy-shield, Bane → poison, Interrupt → combat). Only applied
   * when the item carries no meaningful image yet — i.e. it's empty or one of the
   * generic defaults (Foundry's item-bag, the actor sheet's angel placeholder) —
   * so an explicitly-chosen icon (e.g. a compendium action dragged in) is kept.
   * @override
   */
  async _preCreate(data, options, user) {
    const allowed = await super._preCreate(data, options, user);
    if ( allowed === false ) return false;

    if ( this.type === "action" ) {
      const cfg = CONFIG.OPENLEGEND ?? {};
      const generic = new Set([
        OpenLegendItem.DEFAULT_ICON,        // Foundry's "icons/svg/item-bag.svg"
        "icons/svg/angel.svg",              // the actor sheet's create placeholder
        ""
      ]);
      const current = data.img ?? this.img ?? "";
      if ( generic.has(current) ) {
        const category = this.system?.actionCategory ?? data.system?.actionCategory ?? "damaging";
        const icon = cfg.actionCategoryIcons?.[category] ?? cfg.defaultActionIcon ?? OpenLegendItem.DEFAULT_ICON;
        this.updateSource({ img: icon });
      }
    }

    // Standalone effect items read as conditions, not gear.
    if ( (this.type === "effect") && [OpenLegendItem.DEFAULT_ICON, ""].includes(data.img ?? this.img ?? "") ) {
      this.updateSource({ img: "icons/svg/aura.svg" });
    }

    return allowed;
  }

  /**
   * Hide the "action" subtype from the sidebar's Create Item dialog. Actions are
   * authored on the actor sheet (the Actions tab's add button → createEmbeddedDocuments),
   * never as free-standing world items, so offering "action" there only invites
   * orphaned damaging-action items. The type stays fully registered — only the
   * create-dialog's offered list is filtered; existing/compendium/dragged actions
   * are unaffected. If a caller explicitly requests `action` (e.g. a macro passing
   * a type), we leave their list alone.
   * @override
   */
  static createDialog(data = {}, createOptions = {}, dialogOptions = {}) {
    const HIDDEN = new Set(["action"]);
    // The subtypes Foundry would otherwise offer (all registered, minus the base
    // "base" template type), then drop the hidden ones.
    const registered = (game.documentTypes?.Item ?? this.TYPES ?? [])
      .filter(t => t !== CONST.BASE_DOCUMENT_TYPE);
    const offered = (dialogOptions.types ?? registered).filter(t => !HIDDEN.has(t));
    return super.createDialog(data, createOptions, { ...dialogOptions, types: offered });
  }

  /**
   * Keep an owned choice-feat's decorated name ("Bane Focus — Slowed") in sync
   * when its choice is edited on the item sheet. Only applies while the name
   * still follows the decoration pattern — a hand-renamed feat is left alone.
   *
   * For actions, picking a wielded weapon cascades the Weapons & Implements
   * rules: a Precise weapon presets Agility (precision damage for damaging
   * actions), a Forceful one presets Might (force damage), one with both uses
   * the higher-scored attribute. The grip resets to the weapon's default
   * (two-handed when that's its only mode, the equipped grip for an equipped
   * versatile weapon, else one-handed).
   * @override
   */
  async _preUpdate(changed, options, user) {
    const newChoice = foundry.utils.getProperty(changed, "system.choice.value");
    if ( (this.type === "feat") && (newChoice !== undefined) && !("name" in changed) ) {
      const base = this.system.baseName || this.name;
      const current = this.system.choice?.value ?? "";
      const expected = current ? `${base} — ${current}` : base;
      if ( this.name === expected ) {
        changed.name = newChoice ? `${base} — ${newChoice}` : base;
      }
    }

    const newWeaponId = foundry.utils.getProperty(changed, "system.weaponId");
    if ( (this.type === "action") && (newWeaponId !== undefined) ) {
      this.#cascadeWeaponChange(changed, newWeaponId);
    }

    return super._preUpdate(changed, options, user);
  }

  /**
   * When a Companion feat's purchased tier changes (by any path — the actor sheet's
   * +/- buttons, a drag, or a programmatic update), keep its linked companion actor's
   * tier in sync. Document-level so it can't be bypassed. GM/owner-gated inside the
   * helper. Runs after the update is committed.
   * @override
   */
  async _onUpdate(changed, options, userId) {
    super._onUpdate(changed, options, userId);
    if ( userId !== game.user?.id ) return;          // single client performs the sync

    // Companion feat tier → linked companion actor tier.
    const tierChanged = foundry.utils.getProperty(changed, "system.purchasedTier") !== undefined;
    if ( tierChanged && this.parent ) {
      const Companion = game.openlegend?.Companion;
      if ( Companion?.isCompanionFeat?.(this) ) {
        const comp = Companion.companionForFeat(this.parent, this);
        if ( comp ) Companion.setCompanionTier(comp, Number(this.system?.purchasedTier) || 1);
      }
    }

    // Extraordinary item → the actions already generated from its banes/boons.
    // Editing the item's Potent/Area property or a bane/boon's power level should
    // flow through to every action that invokes from THIS item, so a generated
    // action never drifts out of sync with its source item.
    await this.#cascadeExtraordinaryChange(changed);
  }

  /**
   * Propagate relevant extraordinary-item edits to the actions generated from this
   * item (matched by `system.invokeFromItemId === this.id`, and the bane/boon by
   * name). Only the fields owned by the item's grant are rewritten — the Potent
   * flag, the Area targeting, and the invocation power level — so user edits to
   * the action's other fields (attribute, weapon, range, advantage…) are kept.
   * Owner/GM-gated by the single-client guard in _onUpdate.
   * @param {object} changed  The committed update delta.
   * @returns {Promise<void>}
   */
  async #cascadeExtraordinaryChange(changed) {
    const actor = this.actor;
    if ( !actor ) return;                                     // world items grant nothing
    const sys = this.system ?? {};
    if ( !("extraordinary" in sys) ) return;                  // not a physical grantor

    // Which concerns did this update touch?
    const propsChanged = foundry.utils.getProperty(changed, "system.extraordinaryProperties") !== undefined;
    const banesChanged = foundry.utils.getProperty(changed, "system.extraordinaryBanes") !== undefined;
    const boonsChanged = foundry.utils.getProperty(changed, "system.extraordinaryBoons") !== undefined;
    if ( !propsChanged && !banesChanged && !boonsChanged ) return;

    const cfg = CONFIG.OPENLEGEND ?? {};
    // The Potent flag and Area targeting are item-wide (any property row change may
    // affect them). The power level is per bane/boon row, matched by name.
    const potent = (sys.extraordinaryProperties ?? []).some(p => p.name === "potent");
    // Area sync: only when the item resolves to a SINGLE area do we push it onto the
    // generated actions. When it lists SEVERAL areas, each action may legitimately
    // use a different one (the user picked at generation time), so we don't rewrite
    // them — `areaMultiple` suppresses the area sync while keeping Potent/PL sync.
    const xtraAreas = cfg.extraordinaryAreaDefinitions?.(this) ?? [];
    const areaMultiple = xtraAreas.length > 1;
    const area = (this.type === "weapon")
      ? (cfg.weaponAreaDefinition?.(this) ?? null)
      : (xtraAreas[0] ?? null);
    const plFor = (rows, name) => {
      const row = (rows ?? []).find(r => r?.name && (r.name === name));
      return row ? Math.max(0, Math.floor(Number(row.powerLevel) || 0)) : null;
    };

    const updates = [];
    for ( const action of actor.items ) {
      if ( (action.type !== "action") || (action.system?.invokeFromItemId !== this.id) ) continue;
      const asys = action.system ?? {};
      const isBane = asys.actionCategory === "bane";
      const isBoon = asys.actionCategory === "boon";
      if ( !isBane && !isBoon ) continue;

      const upd = { _id: action.id };

      // Property edits (Potent/Area): re-sync the Potent flag (banes only) and the
      // Area targeting to the item's current state. Skip the area sync entirely when
      // the item lists several areas (each action may use a different chosen one).
      if ( propsChanged ) {
        if ( isBane ) upd["system.potent"] = potent;
        if ( !areaMultiple ) {
          if ( area ) {
            upd["system.targets"] = "area";
            upd["system.area.shape"] = area.shape;
            upd["system.area.length"] = area.length;
            upd["system.area.lines"] = area.lines;
          } else if ( asys.targets === "area" ) {
            // The Area property was removed → drop the forced area targeting.
            upd["system.targets"] = "single";
          }
        }
      }

      // Power-level edits: the grant's value drives both the invocation dice
      // (invokeItemScore) and the invoked power level.
      if ( (isBane && banesChanged) || (isBoon && boonsChanged) ) {
        const rows = isBane ? sys.extraordinaryBanes : sys.extraordinaryBoons;
        const pl = plFor(rows, isBane ? asys.baneName : asys.boonName);
        if ( pl !== null ) {
          upd["system.invokeItemScore"] = pl;
          upd["system.invokePowerLevel"] = pl;
        }
      }

      // Only queue the action if something beyond its _id actually changed.
      if ( Object.keys(upd).length > 1 ) updates.push(upd);
    }

    if ( updates.length ) await actor.updateEmbeddedDocuments("Item", updates);
  }

  /**
   * Apply the weapon-pick cascade to a pending action update (see _preUpdate).
   * Mutates `changed` in place; does nothing when the action is unowned or the
   * id doesn't resolve to a weapon.
   * @param {object} changed      The pending update delta.
   * @param {string} newWeaponId  The newly selected weapon id ("" = none).
   */
  #cascadeWeaponChange(changed, newWeaponId) {
    // Only attack actions wield for offense; a defend interrupt's defensive
    // weapon changes nothing else on the action (its advantage is applied at
    // roll time).
    const category = this.system.actionCategory;
    if ( (category !== "damaging") && (category !== "bane") ) return;

    const setIfAbsent = (path, value) => {
      if ( foundry.utils.getProperty(changed, path) === undefined ) {
        foundry.utils.setProperty(changed, path, value);
      }
    };
    if ( !newWeaponId ) {
      setIfAbsent("system.grip", "one-handed");
      return;
    }
    const weapon = this.actor?.items.get(newWeaponId);
    if ( weapon?.type !== "weapon" ) return;
    const cfg = CONFIG.OPENLEGEND ?? {};
    const props = weapon.system.properties ?? [];
    const has = k => props.some(p => p.key === k);

    // Wielding attribute: Precise → Agility, Forceful → Might, both → the
    // higher-scored of the two. A weapon with neither leaves it untouched.
    let attrKey = null;
    if ( has("precise") && has("forceful") ) {
      const score = k => Number(this.actor.system.attributes?.[k]?.value ?? 0);
      attrKey = score("agility") >= score("might") ? "agility" : "might";
    }
    else if ( has("precise") ) attrKey = "agility";
    else if ( has("forceful") ) attrKey = "might";
    if ( attrKey ) {
      setIfAbsent("system.attribute", attrKey);
      // Damaging actions deal the attribute's weapon damage type.
      if ( this.system.actionCategory === "damaging" ) {
        setIfAbsent("system.damageType", attrKey === "agility" ? "precision" : "force");
      }
    }

    // Grip: reset to the new weapon's default mode.
    const hands = cfg.weaponHandsFor ? cfg.weaponHandsFor(weapon.system.categories ?? []) : 1;
    let grip = "one-handed";
    if ( hands === 2 ) grip = "two-handed";
    else if ( (hands === "versatile") && weapon.system.equipped && (Number(weapon.system.equipHands) === 2) ) {
      grip = "two-handed";
    }
    setIfAbsent("system.grip", grip);
  }
}
