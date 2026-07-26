/**
 * Companion feat (SRD: Companion I–III) — a separate, linked Actor of type "companion".
 *
 * Taking the Companion feat creates a real `companion` Actor (its own sheet, attributes,
 * feats, token), linked to the parent character by UUID. The companion's attribute- and
 * feat-point budgets derive from the feat's TIER and the PARENT's level:
 *   Attributes:  Tier 1 & 2 → 20 + 4 × parentLevel;   Tier 3 → 30 + 6 × parentLevel.
 *   Feat points: Tier 1 → 0;  Tier 2 → 3;  Tier 3 → 3, and the parent may additionally
 *                spend its OWN feat points to grant feats to the companion (tracked on
 *                the companion as `grantedFeatPoints`, subtracted from the parent's
 *                own feat budget — advisory).
 *
 * The feat↔companion link is 1:1: the feat stores the companion's uuid
 * (flags.openlegend.companionUuid); the companion stores the parent's uuid + the feat's
 * id (system.companion.parentUuid / system.companion.featId). Raising/lowering the feat
 * syncs the companion's tier; removing the feat removes its linked companion.
 */

/** The compendium base name of the Companion feat. */
export const COMPANION_FEAT = "Companion (I - III)";

/** Whether an item is the Companion feat (matched by baseName). */
export function isCompanionFeat(item) {
  const sys = item?.system ?? {};
  return (item?.type === "feat") && ((sys.baseName || item.name) === COMPANION_FEAT);
}

/** The owned Companion feat items on an actor. */
export function companionFeats(actor) {
  return (actor?.items ?? []).filter(isCompanionFeat);
}

/** The feat's tier (1–3), clamped. */
export function featTier(feat) {
  return Math.max(1, Math.min(3, Math.floor(Number(feat?.system?.purchasedTier) || 1)));
}

/**
 * Resolve the parent (owning character) of a companion actor from its stored uuid.
 * @param {Actor} companionActor
 * @returns {Actor|null}
 */
export function companionParent(companionActor) {
  const uuid = companionActor?.system?.companion?.parentUuid;
  if ( !uuid ) return null;
  try { return fromUuidSync(uuid) ?? null; } catch { return null; }
}

/**
 * The companion's attribute- and feat-point allowances, by tier + parent level (SRD).
 * @param {number} tier         The companion's tier (1–3).
 * @param {number} parentLevel  The parent character's level.
 * @returns {{tier:number, attributePoints:number, featPoints:number}}
 */
export function companionBudget(tier, parentLevel) {
  const t = Math.max(1, Math.min(3, Math.floor(Number(tier) || 1)));
  const lvl = Math.max(1, Math.floor(Number(parentLevel) || 1));
  const attributePoints = (t >= 3) ? (30 + (6 * lvl)) : (20 + (4 * lvl));
  const featPoints = (t >= 2) ? 3 : 0;            // base feat points; granted points added by callers
  return { tier: t, attributePoints, featPoints };
}

/**
 * Feat points the parent has granted to its companions (Tier 3 "spend your own feat
 * points" — stored per companion as system.companion.grantedFeatPoints). Summed across
 * all of the parent's linked companions. Reduces the parent's own feat budget.
 * @param {Actor} parentActor
 * @returns {number}
 */
export function grantedFeatPointsByParent(parentActor) {
  let total = 0;
  for ( const feat of companionFeats(parentActor) ) {
    const comp = companionForFeat(parentActor, feat);
    total += Math.max(0, Math.floor(Number(comp?.system?.companion?.grantedFeatPoints) || 0));
  }
  return total;
}

/**
 * The companion Actor linked to a given Companion feat. Resolves by the feat's stored
 * `flags.openlegend.companionUuid`; falls back to scanning world actors for a companion
 * whose `system.companion.featId` points back at this feat (so the link survives a
 * missing/stale forward flag).
 * @param {Actor} actor  The feat's owner (parent).
 * @param {Item} feat
 * @returns {Actor|null}
 */
export function companionForFeat(actor, feat) {
  const uuid = feat?.flags?.openlegend?.companionUuid;
  if ( uuid ) {
    let comp = null;
    try { comp = fromUuidSync(uuid) ?? null; } catch { comp = null; }
    if ( comp ) return comp;
  }
  // Fallback: find a companion that links back to this feat.
  const featId = feat?.id;
  if ( featId ) {
    const back = (game.actors?.contents ?? []).find(a =>
      (a.type === "companion") && (a.system?.companion?.featId === featId)
      && (a.system?.companion?.parentUuid === actor?.uuid));
    if ( back ) return back;
  }
  return null;
}

/**
 * Create a companion Actor linked to `parent`, seeded from the feat's chosen name and
 * tier, with level = the parent's level. Returns the created actor (or null).
 * GM-only (creating world actors).
 * @param {Actor} parent
 * @param {object} opts
 * @param {string} [opts.name]    Companion name (from the feat's "Companion name" choice).
 * @param {number} [opts.tier]    Companion tier (the feat's purchased tier).
 * @param {string} [opts.featId]  The Companion feat's id (back-link).
 * @returns {Promise<Actor|null>}
 */
export async function createCompanion(parent, { name = "", tier = 1, featId = "" } = {}) {
  if ( !game.user?.isGM && !parent?.isOwner ) {
    ui.notifications?.warn("Ask the GM to create the linked companion.");
    return null;
  }
  const label = String(name || "").trim() || `${parent.name}'s Companion`;
  const pt = parent.prototypeToken?.toObject?.() ?? {};
  delete pt.actorId;
  const [companion] = await Actor.implementation.createDocuments([{
    name: label,
    type: "companion",
    img: parent.img,
    folder: parent.folder?.id ?? null,
    ownership: foundry.utils.deepClone(parent.ownership ?? {}),
    prototypeToken: pt,
    system: {
      level: Number(parent.system?.level ?? 1),
      companion: {
        tier: Math.max(1, Math.min(3, Math.floor(Number(tier) || 1))),
        parentUuid: parent.uuid,
        featId,
        grantedFeatPoints: 0
      }
    }
  }]);
  return companion ?? null;
}

/**
 * Set a companion's tier (1–3) — called when the parent's Companion feat tier changes.
 * @param {Actor} companionActor
 * @param {number} tier
 */
export async function setCompanionTier(companionActor, tier) {
  if ( !companionActor ) return;
  const t = Math.max(1, Math.min(3, Math.floor(Number(tier) || 1)));
  if ( companionActor.system?.companion?.tier !== t ) {
    await companionActor.update({ "system.companion.tier": t });
  }
}

/**
 * Change tier FROM the companion sheet's selector: set the companion's tier AND keep
 * the parent's linked Companion feat's purchasedTier in sync (so the two never diverge).
 * Resolves the feat by the companion's stored featId (falling back to the parent's
 * feat whose companionUuid points back here).
 * @param {Actor} companionActor
 * @param {number} tier
 */
export async function setTierFromCompanion(companionActor, tier) {
  if ( !companionActor ) return;
  if ( !game.user?.isGM && !companionActor.isOwner ) return;
  const t = Math.max(1, Math.min(3, Math.floor(Number(tier) || 1)));
  await setCompanionTier(companionActor, t);

  const parent = companionParent(companionActor);
  if ( !parent ) return;
  const featId = companionActor.system?.companion?.featId;
  let feat = featId ? parent.items.get(featId) : null;
  if ( !feat ) feat = companionFeats(parent).find(f => f.flags?.openlegend?.companionUuid === companionActor.uuid) ?? null;
  if ( feat && (Number(feat.system?.purchasedTier) !== t) ) {
    await feat.update({ "system.purchasedTier": t });
  }
}
