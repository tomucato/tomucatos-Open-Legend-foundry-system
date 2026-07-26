/**
 * Area auto-targeting (SRD area attacks) — Foundry v14 Regions.
 *
 * When the GM/owner places an area (a Region shape; MeasuredTemplate was
 * deprecated in v14) and the feature setting is on, a dialog asks who to
 * target — Friends, Foes, or All — and every token the area covers in that
 * allegiance is set as the placing user's targets (so the next action roll
 * resolves against them).
 *
 * Allegiance is RELATIVE to the placing user: their controlled/assigned token's
 * disposition is the "friendly" reference (a GM with no such token treats
 * FRIENDLY as friends). Containment tests each token's CENTER against the
 * Region's rendered geometry via its polygon tree.
 *
 * Native to this system — no third-party code. Mirrors the disposition logic in
 * module/canvas/aura.mjs.
 */

const SETTING = "templateAutoTarget";

/** The world setting key for the feature toggle. */
export const TEMPLATE_AUTOTARGET_SETTING = SETTING;

/** Whether the auto-target feature is enabled (safe before settings register). */
function enabled() {
  try { return !!game.settings?.get("tomucatos-open-legend-rpg-system", SETTING); }
  catch { return false; }
}

/**
 * The disposition that counts as "friendly" for the placing user: their
 * controlled token's, else their assigned character's active token's, else
 * FRIENDLY (the GM default). Used to split touched tokens into friends/foes.
 * @param {User} user
 * @returns {number} A CONST.TOKEN_DISPOSITIONS value.
 */
function userFriendlyDisposition(user) {
  const F = CONST.TOKEN_DISPOSITIONS.FRIENDLY;
  const controlled = canvas?.tokens?.controlled ?? [];
  if ( controlled.length ) return controlled[0].document?.disposition ?? F;
  const charToken = user?.character?.getActiveTokens?.(true, false)?.[0];
  if ( charToken ) return charToken.document?.disposition ?? F;
  return F;
}

/**
 * The point used to test whether a token is covered: its CENTER only. A token
 * counts as in the area only when the area covers its center (the stricter
 * rule — edge clipping does not register), regardless of token size.
 * @param {Token} token
 * @returns {{x: number, y: number}}
 */
function tokenCenterPoint(token) {
  return token.center ?? { x: token.x + (token.w ?? 0) / 2, y: token.y + (token.h ?? 0) / 2 };
}

/**
 * Whether a Region's geometry covers a token's CENTER. Uses the RegionDocument's
 * polygon tree, which is derived from the shape data (no canvas object required,
 * so this works for ephemeral/unsaved documents too). `testPoint(point, 0)` is a
 * plain point-in-region test in absolute scene coordinates.
 * @param {RegionDocument} doc  The placed Region document.
 * @param {Token} token
 * @returns {boolean}
 */
function regionCoversToken(doc, token) {
  const tree = doc?.polygonTree;
  if ( !tree ) return false;
  const c = tokenCenterPoint(token);
  return tree.testPoint(c, 0);
}

/**
 * Every token on the active scene the area covers, split by allegiance to the
 * placing user.
 * @param {RegionDocument} doc
 * @param {User} user
 * @returns {{all: Token[], friends: Token[], foes: Token[]}}
 */
function classifyTouched(doc, user) {
  const F = CONST.TOKEN_DISPOSITIONS.FRIENDLY;
  const H = CONST.TOKEN_DISPOSITIONS.HOSTILE;
  const friendlyDisp = userFriendlyDisposition(user);
  const all = [], friends = [], foes = [];
  for ( const token of (canvas?.tokens?.placeables ?? []) ) {
    if ( !token.actor ) continue;                 // skip tokens with no actor
    if ( token.document?.hidden && !user?.isGM ) continue;  // players don't target hidden tokens
    if ( !regionCoversToken(doc, token) ) continue;
    all.push(token);
    const d = token.document?.disposition ?? 0;
    // Friends = same disposition SIGN as the user's reference; foes = opposite.
    // (Friendly vs Hostile is the meaningful split; neutral counts as neither,
    // so it appears only under "All".)
    if ( d === friendlyDisp ) friends.push(token);
    else if ( (friendlyDisp === F && d === H) || (friendlyDisp === H && d === F) ) foes.push(token);
    else if ( (d === F) || (d === H) ) {
      // Reference is neutral: fall back to absolute friendly/hostile buckets.
      (d === F ? friends : foes).push(token);
    }
  }
  return { all, friends, foes };
}

/**
 * Prompt the placing user to choose an allegiance to target (Friends / Foes /
 * All), showing the count in each bucket, then set those tokens as the user's
 * targets. Buckets with zero tokens are disabled. Dismissing targets nothing.
 * @param {RegionDocument} doc
 * @param {User} user
 * @returns {Promise<void>}
 */
async function promptAndTarget(doc, user) {
  const { friends, foes, all } = classifyTouched(doc, user);
  if ( !all.length ) return;   // nothing under the area — no prompt

  const { DialogV2 } = foundry.applications.api;
  const btn = (action, label, icon, list) => ({
    action, label: `${label} (${list.length})`, icon,
    disabled: list.length === 0,
    callback: () => action
  });
  const choice = await DialogV2.wait({
    window: { title: "Target Tokens in Area", icon: "fas fa-bullseye" },
    content: `<p>Target which tokens covered by this area?</p>`,
    buttons: [
      btn("friends", "Friends", "fas fa-user-shield", friends),
      btn("foes", "Foes", "fas fa-skull", foes),
      btn("all", "All", "fas fa-users", all),
      { action: "cancel", label: "Cancel", icon: "fas fa-times" }
    ],
    rejectClose: false
  });
  if ( !choice || (choice === "cancel") ) return;

  const chosen = (choice === "friends") ? friends : (choice === "foes") ? foes : all;
  const ids = chosen.map(t => t.id);
  // v14: assign the placer's targets via the token layer. mode "replace" clears
  // the prior selection first (the old User#updateTokenTargets was removed).
  canvas.tokens.setTargets(ids, { mode: "replace" });
  ui.notifications?.info(`Targeted ${ids.length} token${ids.length === 1 ? "" : "s"} (${choice}).`);
}

/**
 * Auto-target the tokens a freshly-placed Region covers, if the feature is on.
 * Called DIRECTLY from the placement flow (see template-preview.mjs) — the single
 * entry point, so there is no create hook (and thus no double-prompt or
 * hook-timing dependency). Works on the RegionDocument's polygon tree, which is
 * derived from shape data and available immediately even for an ephemeral
 * (unsaved) document — so a Region object drawn on the canvas is not required.
 * @param {RegionDocument} region  The placed Region document (may be ephemeral).
 * @param {User} [user=game.user]
 */
export function autoTargetForRegion(region, user = game.user) {
  if ( !enabled() ) return;
  const doc = region?.document ?? region;   // accept a Region object too, defensively
  if ( !doc?.polygonTree ) return;
  promptAndTarget(doc, user);
}
