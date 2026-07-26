/**
 * Token subclass that shows a stacking condition's LEVEL as a small number badge
 * on the bottom-right of its status-effect icon (e.g. Fatigued at level 3 shows
 * "3"). Non-stacking effects are drawn exactly as core does.
 *
 * Core draws one PIXI.Sprite per applied effect icon in `this.effects` (after a
 * background Graphics child), in the same order it iterates `appliedEffects`
 * (filtered to the ones whose icon shows). We re-derive that ordered list, find
 * each stacking effect's sprite, and parent a PIXI.Text badge to it. The badge
 * is re-positioned in `_refreshEffects`, after core sizes each icon.
 *
 * Built lazily so the core Token class is resolved at init time (when
 * foundry.canvas.placeables is populated), not at module load.
 * @returns {typeof foundry.canvas.placeables.Token}
 */
export function defineOpenLegendToken() {
  const Token = foundry.canvas.placeables.Token;

  return class OpenLegendToken extends Token {

  /** Effects whose icon is shown, in the same order core draws them. */
  #shownEffects() {
    const SHOW = CONST.ACTIVE_EFFECT_SHOW_ICON;
    return this.actor?.appliedEffects.filter(e =>
      (e.showIcon === SHOW.ALWAYS) || ((e.showIcon === SHOW.CONDITIONAL) && e.isTemporary)) ?? [];
  }

  /** Current stack level of a stacking condition (≥1), or 0 if not stacking. */
  #stackLevelOf(effect) {
    const fl = effect?.flags?.openlegend;
    if ( !fl?.stacking ) return 0;
    return Math.max(1, Math.floor(Number(fl.stackLevel) || 1));
  }

  /** @override Draw effects as core does, then badge stacking-condition icons. */
  async _drawEffects() {
    await super._drawEffects();

    const effects = this.#shownEffects();
    const overlay = effects.findLast(e => e.flags.core?.overlay);
    // Core's icon sprites are the effects.children minus the bg Graphics and the
    // overlay sprite; their draw order matches the (non-overlay) effect order.
    const iconSprites = this.effects.children.filter(c =>
      (c !== this.effects.bg) && (c !== this.effects.overlay));
    const iconEffects = effects.filter(e => e !== overlay);

    iconSprites.forEach((sprite, i) => {
      const level = this.#stackLevelOf(iconEffects[i]);
      if ( level > 0 ) this.#addStackBadge(sprite, level);
    });
  }

  /** Attach a number badge as a child of the icon sprite (kept on `olStackBadge`
   *  for cheap, version-safe lookup in _refreshEffects). */
  #addStackBadge(sprite, level) {
    const style = new PIXI.TextStyle({
      fontFamily: "Signika, sans-serif",
      fontSize: 24,
      fontWeight: "bold",
      fill: "#ffffff",
      stroke: "#000000",
      strokeThickness: 4,
      align: "right"
    });
    const badge = new PIXI.Text(String(level), style);
    badge.anchor.set(1, 1);          // anchor at the text's bottom-right corner
    badge.resolution = 2;            // crisp at small icon sizes
    sprite.addChild(badge);
    sprite.olStackBadge = badge;
  }

  /** @override Position each stack badge at the bottom-right of its icon. */
  _refreshEffects() {
    super._refreshEffects();
    for ( const sprite of this.effects.children ) {
      const badge = sprite.olStackBadge;
      if ( !badge ) continue;
      // Icons are squares of `sprite.width`; place the badge just inside the
      // bottom-right corner and scale it relative to the icon size.
      const w = sprite.width || 20;
      badge.scale.set((w / 20) * 0.55);
      badge.position.set(w - (w * 0.04), w - (w * 0.04));
    }
  }

  /**
   * The aura flag carried by this token's actor (flags.openlegend.aura), or null.
   * @returns {object|null}
   */
  #auraFlag() {
    for ( const e of (this.actor?.appliedEffects ?? this.actor?.effects ?? []) ) {
      const a = e.flags?.openlegend?.aura;
      if ( a && a.radiateUuid && (Number(a.radius) > 0) ) return a;
    }
    return null;
  }

  /**
   * Draw (or clear) the aura ring for this token. A boon aura is green, a bane aura
   * red. The ring is a Graphics child of the token, centered, radius scaled from
   * feet → pixels via the scene grid. Called from refresh + the aura engine's
   * refreshAuraDrawings(). Safe to call on every client.
   */
  drawAuraRing() {
    const aura = this.#auraFlag();
    // No aura → tear down any existing ring.
    if ( !aura ) {
      if ( this.olAuraRing ) { this.olAuraRing.destroy(); this.olAuraRing = null; }
      return;
    }
    if ( !this.olAuraRing ) {
      this.olAuraRing = this.addChildAt(new PIXI.Graphics(), 0);  // beneath the token sprite
      this.olAuraRing.eventMode = "none";                          // ignore pointer events
    }
    const grid = canvas?.grid;
    const distance = grid?.distance || 5;
    const size = grid?.size || 100;
    // The token's footprint in pixels (its local space spans 0..w / 0..h).
    const w = this.w ?? (this.document?.width ?? 1) * size;
    const h = this.h ?? (this.document?.height ?? 1) * size;
    const cx = w / 2;
    const cy = h / 2;
    // Foundry measures an emanation in CELLS from the source's cell, so an N-foot
    // aura reaches N feet BEYOND the token's edge. Draw the ring from the token
    // center out to (half the token + N feet) so the circle visually encloses
    // exactly the cells the engine counts as "inside" (e.g. a 15' aura on a 1×1
    // token = half a square + 3 squares = the full 3 squares out).
    const feetPx = (Number(aura.radius) || 0) / distance * size;
    const radiusPx = Math.max(w, h) / 2 + feetPx;
    const color = aura.radiateKind === "bane" ? 0xb5482b : 0x2f6b3a;

    const g = this.olAuraRing;
    g.clear();
    g.beginFill(color, 0.08);
    g.lineStyle(3, color, 0.7);
    g.drawCircle(cx, cy, radiusPx);
    g.endFill();
  }

  /**
   * Detection-aura phenomena this token's actor RADIATES: the GM-placed marker
   * effects' flags.openlegend.detectionAura keys (see CONFIG.detectionTypes).
   * @returns {string[]}
   */
  #detectionAuraTypes() {
    const out = new Set();
    for ( const e of (this.actor?.appliedEffects ?? this.actor?.effects ?? []) ) {
      const t = e.flags?.openlegend?.detectionAura;
      if ( t ) out.add(String(t));
    }
    return [...out];
  }

  /**
   * Draw (or clear) the detection glow: one soft colored ring per radiated
   * phenomenon the CURRENT USER perceives (GM: all; player: the types matching
   * a Detection condition on an actor they own with a token in the scene).
   * Client-local — each client draws only what its user may see.
   */
  drawDetectionGlow() {
    const visible = this.#detectionAuraTypes().filter(userPerceivesDetectionType);
    if ( !visible.length ) {
      if ( this.olDetectionGlow ) { this.olDetectionGlow.destroy(); this.olDetectionGlow = null; }
      return;
    }
    if ( !this.olDetectionGlow ) {
      this.olDetectionGlow = this.addChildAt(new PIXI.Graphics(), 0);  // beneath the token sprite
      this.olDetectionGlow.eventMode = "none";
    }
    const size = canvas?.grid?.size || 100;
    const w = this.w ?? (this.document?.width ?? 1) * size;
    const h = this.h ?? (this.document?.height ?? 1) * size;
    const g = this.olDetectionGlow;
    g.clear();
    visible.forEach((type, i) => {
      const color = CONFIG.OPENLEGEND?.detectionTypes?.[type]?.color ?? 0xFFFFFF;
      // A tight halo hugging the token; multiple phenomena nest outward slightly.
      const r = Math.max(w, h) / 2 + size * (0.10 + i * 0.09);
      g.lineStyle(3, color, 0.85);
      g.beginFill(color, 0.14);
      g.drawCircle(w / 2, h / 2, r);
      g.endFill();
    });
  }

  /**
   * The per-player visibility allow-list carried by an Invisible / Concealment
   * condition (flags.openlegend.visibilityAllow: user ids who may still see
   * this token), or null when no such condition is active. Multiple conditions:
   * the INTERSECTION (a viewer must be allowed by every one).
   * @returns {string[]|null}
   */
  #visibilityAllowList() {
    let allow = null;
    for ( const e of (this.actor?.appliedEffects ?? []) ) {
      const v = e.flags?.openlegend?.visibilityAllow;
      if ( !Array.isArray(v) ) continue;
      allow = (allow === null) ? [...v] : allow.filter(id => v.includes(id));
    }
    return allow;
  }

  /**
   * @override
   * Invisible / Concealment: the token renders only for the GM and the users on
   * the condition's allow-list. Purely client-side — each client evaluates its
   * own user against the flag.
   */
  get isVisible() {
    const allow = this.#visibilityAllowList();
    if ( allow && !game.user?.isGM && !allow.includes(game.user?.id) ) return false;
    return super.isVisible;
  }

  /** @override Keep the aura ring + detection glow sized as the token refreshes. */
  _refreshSize() {
    super._refreshSize?.();
    this.drawAuraRing();
    this.drawDetectionGlow();
  }

  /** @override Tear down the aura ring + detection glow with the token. */
  _destroy(options) {
    if ( this.olAuraRing ) { this.olAuraRing.destroy(); this.olAuraRing = null; }
    if ( this.olDetectionGlow ) { this.olDetectionGlow.destroy(); this.olDetectionGlow = null; }
    return super._destroy(options);
  }
  };
}

/**
 * Whether the CURRENT user perceives a given detection phenomenon: the GM
 * always does; a player does when an actor they own with a token in the scene
 * bears an active Detection condition of that type (flags.openlegend.detection,
 * stamped by applyBoonToActor's Detection prompt).
 * @param {string} type  A CONFIG.detectionTypes key.
 * @returns {boolean}
 */
export function userPerceivesDetectionType(type) {
  if ( game.user?.isGM ) return true;
  for ( const t of (canvas?.tokens?.placeables ?? []) ) {
    const a = t.actor;
    if ( !a?.isOwner ) continue;
    for ( const e of (a.appliedEffects ?? []) ) {
      if ( String(e.flags?.openlegend?.detection ?? "") === String(type) ) return true;
    }
  }
  return false;
}
