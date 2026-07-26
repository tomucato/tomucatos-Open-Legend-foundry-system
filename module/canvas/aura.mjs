/**
 * Live Aura engine (SRD: Aura boon).
 *
 * A token whose actor carries an Aura ActiveEffect (flags.openlegend.aura) projects
 * a radius. As tokens move:
 *   - A boon aura GRANTS its radiated boon to allies inside (auto, no roll); the
 *     boon is removed when they leave. Granted copies are marked
 *     flags.openlegend.fromAura = <auraTokenId> so we only ever remove what we added.
 *   - A bane aura makes a BANE ATTACK against an enemy when it first enters the area
 *     (and at most once per round per creature); on a hit the bane is applied.
 *
 * All world-mutating work (granting/removing effects, posting cards) runs on a
 * SINGLE client — the active GM — so it happens exactly once. Ring drawing runs on
 * every client (see module/canvas/token.mjs drawAuraRing).
 */

import { applyBoonByTokenUuid, auraBaneAttack } from "../dice/action-roll.mjs";

/** Re-entrancy guard: granting/removing effects fires hooks that call us again. */
let processing = false;

/**
 * Per-aura, per-enemy "already attacked this round" set, keyed `${auraId}|${enemyId}`.
 * Cleared on combat turn/round change so an enemy lingering in the aura is attacked
 * at most once per round.
 * @type {Set<string>}
 */
const attackedThisRound = new Set();

/**
 * Last-known membership per aura: auraId → Set of inside token ids. Used to detect
 * outside→inside TRANSITIONS so a bane attack fires only when a creature ENTERS the
 * aura (SRD), not when the aura's own carrier moves over a stationary creature.
 * @type {Map<string, Set<string>>}
 */
const auraMembership = new Map();

/** Clear the once-per-round bane-attack tracking (called on combat advance). */
export function clearAuraRoundTracking() {
  attackedThisRound.clear();
}

/** Whether THIS client is the one that performs aura world-mutations. */
function isAuraRunner() {
  return game.users?.activeGM === game.user;
}

/** The aura flag on an actor (the first effect carrying flags.openlegend.aura), or null. */
function auraFlagOf(actor) {
  for ( const e of (actor?.appliedEffects ?? actor?.effects ?? []) ) {
    const a = e.flags?.openlegend?.aura;
    if ( a && a.radiateUuid ) return a;
  }
  return null;
}

/**
 * A token's footprint rectangle in canvas pixels {x, y, w, h}, measured from the
 * document's SOURCE data (the committed destination of a move). Neither doc.x nor
 * the placeable's token.x can be trusted when updateToken fires: in Foundry v13+
 * the movement animation merges its interpolated position back into the DOCUMENT
 * every frame (Token##animateFrame), so by hook time doc.x has been reverted to
 * the move's STARTING point and only _source holds where the token will land.
 */
function tokenBounds(token) {
  const doc = token.document ?? token;
  const src = doc._source ?? doc;
  const size = canvas.grid?.size ?? 100;
  const w = Number(src.width ?? doc.width ?? 1) * size;
  const h = Number(src.height ?? doc.height ?? 1) * size;
  const x = Number.isFinite(src.x) ? src.x : (token.x ?? (token.center?.x ?? 0) - w / 2);
  const y = Number.isFinite(src.y) ? src.y : (token.y ?? (token.center?.y ?? 0) - h / 2);
  return { x, y, w, h };
}

/**
 * Whether a token's footprint lies within an aura's DRAWN disc. drawAuraRing
 * (module/canvas/token.mjs) draws a circle from the carrier's CENTER of radius
 * (half its footprint + R feet), so detection measures the Euclidean distance
 * from that center to the NEAREST point of the other token's bounding box and
 * counts it inside when STRICTLY within the circle — the engine's area is
 * exactly what players see. (A previous per-axis Chebyshev edge-gap check with
 * `<=` detected a SQUARE one cell larger than the ring on every side.)
 * @param {Token} auraToken   The aura's carrier.
 * @param {Token} other       The token to test.
 * @param {number} radiusFeet The aura's radius in feet (beyond the carrier's edge).
 * @returns {boolean}
 */
function withinAura(auraToken, other, radiusFeet) {
  const ra = tokenBounds(auraToken), rb = tokenBounds(other);
  const size = canvas.grid?.size || 100;
  const distancePerSquare = canvas.grid?.distance || 5;
  // The drawn ring: carrier center + (half footprint + R feet) in pixels.
  const cx = ra.x + ra.w / 2;
  const cy = ra.y + ra.h / 2;
  const ringPx = Math.max(ra.w, ra.h) / 2
    + (Math.max(0, Number(radiusFeet) || 0) / distancePerSquare) * size;
  // Nearest point of the other token's rectangle to the ring's center.
  const nx = Math.min(Math.max(cx, rb.x), rb.x + rb.w);
  const ny = Math.min(Math.max(cy, rb.y), rb.y + rb.h);
  // Strict: a token exactly tangent to the circle (its edge on the ring line,
  // i.e. wholly in the next grid square) is OUTSIDE.
  return Math.hypot(nx - cx, ny - cy) < ringPx;
}

/**
 * Disposition relationship. Allies = same disposition sign (both friendly, or both
 * hostile, etc.); enemies = opposite (friendly vs hostile). Neutral/secret are
 * treated as neither ally nor enemy (no auto effect).
 * @returns {"ally"|"enemy"|"neither"}
 */
function relation(auraToken, otherToken) {
  const a = auraToken.document?.disposition ?? 0;
  const b = otherToken.document?.disposition ?? 0;
  const F = CONST.TOKEN_DISPOSITIONS.FRIENDLY;
  const H = CONST.TOKEN_DISPOSITIONS.HOSTILE;
  if ( a === b ) return "ally";
  if ( (a === F && b === H) || (a === H && b === F) ) return "enemy";
  return "neither";
}

/**
 * Find an aura-granted boon effect on an actor (added by the aura with this id).
 * @returns {ActiveEffect|null}
 */
function auraGrantedEffect(actor, auraId, boonName) {
  return actor?.effects?.find(e =>
    (e.flags?.openlegend?.fromAura === auraId) &&
    (!boonName || e.flags?.openlegend?.fromBoon === boonName)) ?? null;
}

/**
 * The main sweep: for every aura on the scene, radiate to in-range tokens. Mutating
 * work is gated to the active GM and guarded against re-entrancy.
 * @returns {Promise<void>}
 */
export async function processAuras({ endsTurnTokenId = "" } = {}) {
  if ( processing ) return;
  if ( !canvas?.ready || !isAuraRunner() ) return;
  const tokens = canvas.tokens?.placeables ?? [];
  if ( !tokens.length ) return;

  processing = true;
  try {
    const liveAuraIds = new Set();
    for ( const auraToken of tokens ) {
      const actor = auraToken.actor;
      if ( !actor ) continue;
      const aura = auraFlagOf(actor);
      if ( !aura ) continue;

      const auraId = auraToken.id;
      liveAuraIds.add(auraId);
      const radius = Math.max(0, Number(aura.radius) || 0);
      const kind = aura.radiateKind === "bane" ? "bane" : "boon";

      // Membership from the PREVIOUS sweep (to detect outside→inside transitions),
      // then the set currently inside. NOTE: we do NOT write the new membership
      // here — it is committed at the END of this aura's processing (after any
      // attack/grant), so a sweep that is skipped or throws before acting can't
      // "swallow" an entry transition by pre-recording the token as inside.
      const wasInside = auraMembership.get(auraId) ?? new Set();
      const inside = new Set();
      for ( const other of tokens ) {
        if ( other === auraToken ) continue;
        if ( !other.actor ) continue;
        if ( withinAura(auraToken, other, radius) ) inside.add(other);
      }

      // The token whose turn just ended (combat advance), if any — the ONLY SRD
      // trigger for an aura's effect ("ends their turn within the area"). The aura's
      // own target (carrier) can be the ender for a boon (it's a willing target), but
      // is always exempt from its own bane (handled in the bane branch).
      const ender = endsTurnTokenId
        ? tokens.find(t => t.id === endsTurnTokenId)
        : null;

      if ( kind === "boon" ) {
        // SRD: the target + allies who END THEIR TURN inside automatically gain the
        // boon; it is removed on leaving the area. So a boon is granted ONLY to the
        // creature whose turn just ended (when it's an ally inside) — never merely for
        // being inside or for entering — and REMOVED from any ally no longer inside on
        // every sweep (so it drops the instant they leave).
        for ( const other of tokens ) {
          const isCarrier = (other === auraToken);
          const rel = isCarrier ? "ally" : relation(auraToken, other);
          if ( rel !== "ally" ) continue;
          const within = isCarrier || inside.has(other);
          const has = auraGrantedEffect(other.actor, auraId, aura.radiateName);
          const hasAny = (other.actor?.effects ?? []).some(e => e.flags?.openlegend?.fromBoon === aura.radiateName);
          // Grant trigger: ONLY the creature that just ended its turn inside (the
          // carrier counts when its OWN turn ends). No grant on entry / mere presence.
          const triggers = ender && (other === ender);
          if ( within && triggers && !hasAny ) {
            await applyBoonByTokenUuid(other.document.uuid, aura.radiateUuid, aura.radiatePowerLevel,
              { fromAura: auraId, resistanceType: aura.radiateResistanceType ?? "" });
          } else if ( !within && has ) {
            await has.delete();   // left the aura → remove immediately
          }
        }
      } else {
        // Bane aura: a creature (friend OR foe) suffers a bane attack when it ENTERS
        // the area OR when it ENDS ITS TURN within it (the aura's own carrier is
        // exempt). At most once per round per creature; cleared when they leave so it
        // re-triggers on re-entry or on a later turn ended inside.
        for ( const other of tokens ) {
          if ( other === auraToken ) continue;   // the aura's target is immune
          if ( !other.actor ) continue;
          const key = `${auraId}|${other.id}`;
          if ( !inside.has(other) ) { attackedThisRound.delete(key); continue; }
          // Trigger on an outside→inside TRANSITION (entering), or when this creature's
          // turn just ended while inside.
          const entered = !wasInside.has(other.id);
          const endedTurnInside = ender && (other === ender);
          if ( !entered && !endedTurnInside ) continue;
          if ( attackedThisRound.has(key) ) continue;
          attackedThisRound.add(key);
          await auraBaneAttack({
            attackerActorUuid: aura.attackerActorUuid,
            attackAttr: aura.attackAttr,
            targetTokenUuid: other.document.uuid,
            baneUuid: aura.radiateUuid,
            baneName: aura.radiateName,
            powerLevel: aura.radiatePowerLevel,
            auraName: "Aura",
            // An item-invoked aura (Persistent property / item invocation) rolls
            // the item's value instead of the wielder's attribute.
            itemScore: Math.max(0, Math.floor(Number(aura.itemScore) || 0))
          });
        }
      }
      // Commit membership only AFTER acting, so a transition survives a sweep that
      // was skipped/guarded before it could attack (see wasInside note above).
      auraMembership.set(auraId, new Set([...inside].map(t => t.id)));
    }
    // Drop membership for auras that no longer exist (ended/deleted) so ids don't leak.
    for ( const id of [...auraMembership.keys()] ) {
      if ( !liveAuraIds.has(id) ) auraMembership.delete(id);
    }
  } finally {
    processing = false;
  }
}

/**
 * Remove every boon a given aura granted (effects flagged fromAura === auraId).
 * Called when the Aura effect itself is deleted (sustain dropped) so its radiated
 * boons don't linger on allies. GM-gated. Also sweeps the once-per-round tracking.
 * @param {string} auraId  The aura carrier's token id (the fromAura marker value).
 * @returns {Promise<void>}
 */
export async function removeAuraGrants(auraId) {
  if ( !auraId || !isAuraRunner() || !canvas?.ready ) return;
  for ( const token of (canvas.tokens?.placeables ?? []) ) {
    const stale = (token.actor?.effects ?? []).filter(e => e.flags?.openlegend?.fromAura === auraId);
    for ( const e of stale ) await e.delete();
    // Drop this aura's per-round attack tracking for every enemy.
    for ( const key of [...attackedThisRound] ) {
      if ( key.startsWith(`${auraId}|`) ) attackedThisRound.delete(key);
    }
  }
}

/** Redraw all aura rings + detection glows (cheap; runs on every client). */
export function refreshAuraDrawings() {
  if ( !canvas?.ready ) return;
  for ( const token of (canvas.tokens?.placeables ?? []) ) {
    token.drawAuraRing?.();
    token.drawDetectionGlow?.();
  }
}
