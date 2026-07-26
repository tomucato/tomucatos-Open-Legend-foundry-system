/**
 * Open Legend Effects Panel — a PF2e-style floating column of condition / effect
 * icons in the top-right of the canvas, for the active actor (the first
 * controlled token, else the user's assigned character).
 *
 * Each icon shows its level/stack as a small badge, has a rich hover tooltip
 * (name, level label, mechanical changes, description), and is interactive:
 *   - left-click          → step the level/stack UP   (re-applies the rows it unlocks)
 *   - right-click         → step the level/stack DOWN (or remove at the bottom)
 *   - shift / middle click → open the effect's config sheet to edit it
 *   - the ✕ button         → remove the condition entirely (effect + its bane/boon)
 *
 * It is a non-popout ApplicationV2 anchored under the scene controls, kept in
 * sync by re-rendering on token control changes and effect/actor updates (wired
 * in openlegend.mjs).
 */
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class OpenLegendEffectsPanel extends HandlebarsApplicationMixin(ApplicationV2) {

  /** The setting key gating the panel's visibility (registered in openlegend.mjs). */
  static SETTING = "showEffectsPanel";

  /** @override */
  static DEFAULT_OPTIONS = {
    id: "openlegend-effects-panel",
    classes: ["openlegend", "effects-panel"],
    window: { frame: false, positioned: false },
    actions: {
      // Footer buttons in the hover card use the standard left-click action map.
      stepUp: OpenLegendEffectsPanel.#onStepUp,
      stepDown: OpenLegendEffectsPanel.#onStepDown,
      edit: OpenLegendEffectsPanel.#onEdit,
      remove: OpenLegendEffectsPanel.#onRemove,
      toggleSuspend: OpenLegendEffectsPanel.#onToggleSuspend,
      togglePotent: OpenLegendEffectsPanel.#onTogglePotent
    }
  };

  /** @override */
  static PARTS = {
    panel: { template: "systems/tomucatos-open-legend-rpg-system/templates/apps/effects-panel.html" }
  };

  /* -------------------------------------------- */

  /**
   * The actor whose effects the panel shows: the first controlled token's actor,
   * else the current user's assigned character. Null when neither exists.
   * @returns {Actor|null}
   */
  get actor() {
    const token = canvas?.tokens?.controlled?.[0];
    return token?.actor ?? game.user?.character ?? null;
  }

  /* -------------------------------------------- */

  /**
   * Distinct, sorted, positive change-level thresholds an effect defines (its
   * power-level / stack tiers). Empty when the effect has no leveled rows.
   * @param {ActiveEffect} effect
   * @returns {number[]}
   */
  static #definedLevels(effect) {
    const levels = effect.flags?.openlegend?.changeLevels ?? [];
    return [...new Set(levels.map(Number).filter(l => Number.isFinite(l) && (l > 0)))]
      .sort((a, b) => a - b);
  }

  /**
   * Level view-data for one effect: stack count or power level, the label to use,
   * the badge to draw, and whether it can step up/down.
   * @param {ActiveEffect} effect
   */
  static #levelData(effect) {
    const fl = effect.flags?.openlegend ?? {};
    const defined = OpenLegendEffectsPanel.#definedLevels(effect);
    if ( fl.stacking ) {
      const max = defined.length ? Math.max(...defined) : 1;
      const stack = Math.max(1, Math.floor(Number(fl.stackLevel) || 1));
      return {
        label: "Level", value: stack, badge: String(stack),
        hasLevels: true, canRaise: stack < max, canLower: stack >= 1
      };
    }
    const pl = Math.max(0, Math.floor(Number(fl.powerLevel) || 0));
    return {
      label: "PL", value: pl, badge: pl ? String(pl) : "",
      hasLevels: defined.length > 0,
      canRaise: defined.some(l => l > pl),
      canLower: defined.some(l => l < pl) || (pl > 0)
    };
  }

  /* -------------------------------------------- */

  /** @override */
  async _prepareContext() {
    const actor = this.actor;
    const show = game.settings.get("tomucatos-open-legend-rpg-system", OpenLegendEffectsPanel.SETTING);
    if ( !show || !actor ) return { effects: [], actor: null };

    const cfg = CONFIG.OPENLEGEND ?? {};
    const describe = cfg.describeChange ?? (c => ({ subject: c.key, detail: c.value }));
    const TextEditor = foundry.applications.ux.TextEditor.implementation;

    // Show every effect whose icon would display (matches the token badge rule):
    // ALWAYS, or CONDITIONAL while temporary — INCLUDING suspended (disabled) ones,
    // which the template grays out. We iterate allApplicableEffects() (own +
    // transferred, regardless of disabled) rather than appliedEffects (active only).
    const SHOW = CONST.ACTIVE_EFFECT_SHOW_ICON;
    const applied = [...actor.allApplicableEffects()].filter(e =>
      (e.showIcon === SHOW.ALWAYS) || ((e.showIcon === SHOW.CONDITIONAL) && e.isTemporary));

    const effects = [];
    for ( const effect of applied ) {
      const fl = effect.flags?.openlegend ?? {};
      const source = fl.fromBane ?? fl.fromBoon ?? null;
      const kind = fl.fromBane ? "bane" : (fl.fromBoon ? "boon" : null);
      const ld = OpenLegendEffectsPanel.#levelData(effect);

      // Mechanical change lines, only the rows the current level unlocks.
      const changes = (effect.system?.changes ?? [])
        .filter(c => effect.isChangeActive?.(c) ?? true)
        .map(c => { const d = describe(c); return { label: d.subject, value: d.detail }; });

      const description = effect.description
        ? await TextEditor.enrichHTML(effect.description, { relativeTo: actor, secrets: actor.isOwner })
        : "";

      effects.push({
        id: effect.id,
        // Effects on embedded items carry the item id so removal can clean it up.
        docId: (effect.parent !== actor) ? null : (kind ? actor.items.find(i => (i.type === kind) && (i.name === source))?.id ?? null : null),
        onActor: effect.parent === actor,
        name: source ?? effect.name,
        img: effect.img,
        kind,
        disabled: effect.disabled,
        // Potent is a bane-only toggle (target resists at disadvantage 1).
        isBane: kind === "bane",
        potent: !!fl.potent,
        // Failed resist rolls against THIS application of the bane (0 = none yet).
        // Reset when the bane is removed & re-applied (a fresh effect).
        resistFails: Math.max(0, Math.floor(Number(fl.resistFails) || 0)),
        levelLabel: ld.label,
        badge: ld.badge,
        hasLevels: ld.hasLevels,
        canRaise: ld.canRaise,
        canLower: ld.canLower,
        changes,
        description
      });
    }

    effects.sort((a, b) => a.name.localeCompare(b.name));
    return { effects, actor };
  }

  /* -------------------------------------------- */

  /**
   * Wire each icon's pointer interactions (PF2e-style, manual binding so we get
   * left / right / shift / middle separately):
   *   - left-click          → step level/stack up
   *   - right-click         → step level/stack down (removes at the bottom)
   *   - shift- or middle-click → open the effect config to edit
   * Footer buttons inside the hover card keep their own data-action handlers.
   * @override
   */
  _onRender(context, options) {
    super._onRender?.(context, options);
    this.#position();
    for ( const icon of this.element.querySelectorAll(".ol-ep-icon") ) {
      icon.addEventListener("click", ev => {
        ev.preventDefault();
        const target = ev.currentTarget;
        if ( ev.shiftKey ) return OpenLegendEffectsPanel.#onEdit.call(this, ev, target);
        return this.#step(target, true);
      });
      icon.addEventListener("contextmenu", ev => {
        ev.preventDefault();
        return this.#step(ev.currentTarget, false);
      });
      // Middle-click → edit.
      icon.addEventListener("auxclick", ev => {
        if ( ev.button !== 1 ) return;
        ev.preventDefault();
        return OpenLegendEffectsPanel.#onEdit.call(this, ev, ev.currentTarget);
      });
    }
  }

  /**
   * Re-anchor the panel against the sidebar WITHOUT a full re-render — just
   * restyles `right`/`top`. Called when the sidebar collapses or expands.
   *
   * The sidebar slides via a 250ms CSS transition on `#sidebar-content`'s margin,
   * and the panel's own `right` has a matching CSS transition, so setting the
   * panel's FINAL `right` immediately makes it glide in parallel with the sidebar
   * (instead of snapping at the end). Pass the target collapsed state from the
   * `collapseSidebar` hook so we compute the destination edge rather than reading
   * the still-animating live one.
   * @param {boolean} [collapsed]  Target state; omit to measure the live edge.
   */
  reposition(collapsed) {
    this.#position(collapsed);
  }

  /**
   * Anchor the panel just left of the right-hand sidebar, tracking its width and
   * collapsed state. With a `collapsed` hint, the panel's destination edge is
   * computed (collapsed → the always-visible tabs column; expanded → that minus
   * the sliding content's width) so the move can animate in parallel. Without a
   * hint, the live sidebar edge is measured. Falls back to a fixed margin if the
   * sidebar isn't found.
   * @param {boolean} [collapsed]  Target collapsed state, if known.
   */
  #position(collapsed) {
    const el = this.element;
    if ( !el ) return;
    const sidebar = document.getElementById("sidebar") ?? ui.sidebar?.element;
    const gap = 10;
    if ( sidebar ) {
      let leftEdge;
      const tabs = document.getElementById("sidebar-tabs");
      const content = document.getElementById("sidebar-content");
      if ( (collapsed !== undefined) && tabs ) {
        // Destination edge: collapsed shows only the tabs column; expanded adds the
        // sliding content's full width to its left.
        const tabsLeft = tabs.getBoundingClientRect().left;
        const contentW = content ? content.getBoundingClientRect().width : 0;
        leftEdge = collapsed ? tabsLeft : (tabsLeft - contentW);
      } else {
        leftEdge = sidebar.getBoundingClientRect().left;
      }
      // Distance from the viewport's right edge to the sidebar's left edge.
      el.style.right = `${Math.max(0, window.innerWidth - leftEdge) + gap}px`;
    } else {
      el.style.right = "320px";
    }
    el.style.top = "12px";
  }

  /* -------------------------------------------- */
  /*  Helpers                                      */
  /* -------------------------------------------- */

  /** Resolve the ActiveEffect a clicked icon refers to (only those on the actor
   *  are mutable here; item-transferred ones are managed on their item). */
  #effectFromTarget(target) {
    const id = target.closest("[data-effect-id]")?.dataset.effectId;
    if ( !id ) return null;
    return this.actor?.effects?.get(id) ?? null;
  }

  /** Resolve the effect including item-transferred ones (for suspend/edit, which
   *  the owner may toggle on the source item too). */
  #anyEffectFromTarget(target) {
    const id = target.closest("[data-effect-id]")?.dataset.effectId;
    if ( !id ) return null;
    const direct = this.actor?.effects?.get(id);
    if ( direct ) return direct;
    for ( const effect of (this.actor?.allApplicableEffects?.() ?? []) ) {
      if ( effect.id === id ) return effect;
    }
    return null;
  }

  /* -------------------------------------------- */
  /*  Actions                                      */
  /* -------------------------------------------- */

  /** Step one tier up. Stacking → +1 stack (capped); leveled → next threshold. */
  static async #onStepUp(event, target) {
    event.preventDefault();
    return this.#step(target, true);
  }

  /** Step one tier down. At the minimum power level (or a stacking level 1),
   *  stepping down removes the condition entirely. */
  static async #onStepDown(event, target) {
    event.preventDefault();
    return this.#step(target, false);
  }

  /** Shared level stepper (mirrors the actor sheet's #onEffectLevelStep). */
  async #step(target, up) {
    const effect = this.#effectFromTarget(target);
    if ( !effect || (effect.parent !== this.actor) ) return;
    const fl = effect.flags?.openlegend ?? {};
    const defined = OpenLegendEffectsPanel.#definedLevels(effect);

    if ( fl.stacking ) {
      const max = defined.length ? Math.max(...defined) : 1;
      const cur = Math.max(1, Math.floor(Number(fl.stackLevel) || 1));
      const next = cur + (up ? 1 : -1);
      if ( next < 1 ) return this.#removeEffect(effect); // stepping below 1 removes it
      const clamped = Math.min(max, next);
      if ( clamped === cur ) return;
      return effect.update({ "flags.openlegend.stackLevel": clamped });
    }

    const pl = Math.max(0, Math.floor(Number(fl.powerLevel) || 0));
    if ( up ) {
      const next = defined.find(l => l > pl);
      if ( next === undefined ) return; // already at the top
      return effect.update({ "flags.openlegend.powerLevel": next });
    }

    // Stepping DOWN: drop to the next lower defined level; if there is none
    // (already at the minimum), remove the effect entirely.
    const next = [...defined].reverse().find(l => l < pl);
    if ( next === undefined ) return this.#removeEffect(effect);
    return effect.update({ "flags.openlegend.powerLevel": next });
  }

  /** Open the effect's config sheet to edit it directly. */
  static #onEdit(event, target) {
    event.preventDefault();
    const effect = this.#effectFromTarget(target);
    if ( effect ) effect.sheet.render(true);
  }

  /** Suspend / resume the effect (flip `disabled`). A suspended effect stays in
   *  the panel, grayed out, applying nothing until resumed. Works on actor-side
   *  effects and item-transferred ones (the owner may toggle either). */
  static async #onToggleSuspend(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const effect = this.#anyEffectFromTarget(target);
    if ( !effect ) return;
    await effect.update({ disabled: !effect.disabled });
  }

  /** Toggle a bane effect's Potent flag (target resists at disadvantage 1). */
  static async #onTogglePotent(event, target) {
    event.preventDefault();
    const effect = this.#effectFromTarget(target);
    if ( !effect || (effect.parent !== this.actor) ) return;
    await effect.update({ "flags.openlegend.potent": !effect.flags?.openlegend?.potent });
  }

  /** Remove the condition: delete the effect and its source bane/boon item
   *  (unless another effect still references that item). */
  static async #onRemove(event, target) {
    event.preventDefault();
    const effect = this.#effectFromTarget(target);
    if ( !effect ) return;
    return this.#removeEffect(effect);
  }

  /** Shared removal (mirrors the actor sheet's #onConditionDelete). */
  async #removeEffect(effect) {
    if ( effect.parent !== this.actor ) {
      ui.notifications?.info("This effect comes from an item; remove or disable it on that item.");
      return;
    }
    const fl = effect.flags?.openlegend ?? {};
    const source = fl.fromBane ?? fl.fromBoon;
    const kind = fl.fromBane ? "bane" : (fl.fromBoon ? "boon" : null);
    await effect.delete();
    if ( source && kind ) {
      const item = this.actor.items.find(i => (i.type === kind) && (i.name === source));
      const stillReferenced = this.actor.effects.some(e =>
        (e.flags?.openlegend?.fromBane === source) || (e.flags?.openlegend?.fromBoon === source));
      if ( item && !stillReferenced ) await item.delete();
    }
  }
}
