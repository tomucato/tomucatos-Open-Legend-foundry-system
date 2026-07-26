/**
 * Open Legend boon configuration: the standard boon-name catalog, generic
 * boon-document resolution, and the boon invocation math (Challenge Rating and the
 * achieved-power-level lookup). Merged into the public {@link OPENLEGEND} object in
 * ./index.mjs (see stats.mjs for the pattern). This is the boon-side mirror of
 * bane.mjs and, like it, a leaf module (imports nothing).
 *
 * Feat logic that involves boons (Boon Access, Boon Focus, the Multi-Target Boon
 * feats, …) lives in feat.mjs / config.mjs, not here — this file is just the
 * catalog and the CR math, mirroring what bane.mjs holds for banes.
 */

const BOON = {};
export default BOON;

/**
 * The standard boon names (Open Legend SRD), for the extraordinary-item boon
 * picker. @type {string[]}
 */
BOON.boonNames = [
  "Absorb Object", "Animation", "Aura", "Barrier", "Blindsight", "Bolster",
  "Concealment", "Darkness", "Detection", "Flight", "Genesis", "Haste", "Heal",
  "Insubstantial", "Invisible", "Life Drain", "Light", "Precognition", "Reading",
  "Regeneration", "Resistance", "Restoration", "Seeing", "Shapeshift",
  "Summon Creature", "Sustenance", "Telekinesis", "Telepathy", "Teleport",
  "Tongues", "Transmutation", "Truesight"
];

/**
 * Resolve a boon document by name, preferring the boon picker's source — the
 * system boons compendium ("tomucatos-open-legend-rpg-system.boons") — so a generated boon
 * action's boonUuid matches a picker option. Falls back to a world boon item,
 * then any other Item compendium. Mirrors {@link OPENLEGEND.resolveBaneByName}.
 * @param {string} name
 * @returns {Promise<Item|null>}
 */
BOON.resolveBoonByName = async function(name) {
  if ( !name ) return null;
  const lower = String(name).toLowerCase();
  const boonsPack = game.packs?.get("tomucatos-open-legend-rpg-system.boons");
  if ( boonsPack ) {
    const entry = (await boonsPack.getIndex()).find(e => String(e.name).toLowerCase() === lower);
    if ( entry ) return boonsPack.getDocument(entry._id);
  }
  const local = game.items?.find(i => (i.type === "boon") && (String(i.name).toLowerCase() === lower));
  if ( local ) return local;
  for ( const pack of game.packs ?? [] ) {
    if ( (pack.documentName !== "Item") || (pack.collection === "tomucatos-open-legend-rpg-system.boons") ) continue;
    const entry = (await pack.getIndex()).find(e => (String(e.name).toLowerCase() === lower) && (e.type === "boon"));
    if ( entry ) return pack.getDocument(entry._id);
  }
  return null;
};

/**
 * Boon Challenge Rating for a power level. Unlike banes (which roll against a
 * target's defense), a boon is invoked by beating a fixed CR: CR = 10 + 2·PL.
 *   PL: 0  1  2  3  4  5  6  7  8  9
 *   CR: 10 12 14 16 18 20 22 24 26 28
 * @param {number} powerLevel
 * @returns {number} The challenge rating the action roll must meet or beat.
 */
BOON.boonChallengeRating = function(powerLevel) {
  return 10 + (2 * Math.max(0, Math.floor(Number(powerLevel ?? 0))));
};

/**
 * Highest power level a roll achieves for a boon, given the boon's discrete
 * power levels and an optional cap (the invoking attribute's score — you can
 * never invoke above your attribute). Returns the greatest level whose CR the
 * roll meets, that is also ≤ the cap; or null if the roll fails to reach even
 * the lowest level (the invocation fails).
 * @param {number} total          The evaluated action-roll total.
 * @param {number[]} levels        The boon's discrete power levels (ascending).
 * @param {number} [cap=Infinity]  Max invocable level (the attribute score).
 * @returns {number|null}
 */
BOON.boonAchievedPowerLevel = function(total, levels = [], cap = Infinity) {
  const t = Number(total ?? 0);
  const c = Number.isFinite(cap) ? cap : Infinity;
  let best = null;
  for ( const lvl of levels ) {
    const pl = Number(lvl);
    if ( !Number.isFinite(pl) || (pl > c) ) continue;
    if ( t >= BOON.boonChallengeRating(pl) ) best = (best === null) ? pl : Math.max(best, pl);
  }
  return best;
};


/* -------------------------------------------- */
/*  Barrier boon (SRD)                          */
/* -------------------------------------------- */

/** A boon is "Barrier" when its name matches this (case-insensitive). @type {string} */
BOON.BARRIER_BOON_NAME = "Barrier";

/**
 * Barrier's selectable properties (SRD), in display order. Each carries the rule
 * text shown on the granted effect / picker. "Damaging" and "Baneful" need extra
 * data (a die / a chosen bane) resolved separately.
 * @type {Array<{key: string, label: string, description: string}>}
 */
BOON.BARRIER_PROPERTIES = [
  { key: "damaging",   label: "Damaging",   description: "A creature that ends its turn within the barrier or willingly enters it automatically suffers the indicated damage (once per round)." },
  { key: "obscuring",  label: "Obscuring",  description: "Creatures cannot see through any part of the barrier or anything within it." },
  { key: "hindering",  label: "Hindering",  description: "Creatures move at half speed while travelling within the barrier." },
  { key: "baneful",    label: "Baneful",    description: "When a creature ends its turn within the barrier or willingly enters it, you may make a bane attack to inflict the chosen bane (once per round per creature)." },
  { key: "mobile",     label: "Mobile",     description: "You may spend a major action to move the barrier up to 30 feet." },
  { key: "impassable", label: "Impassable", description: "Creatures and objects cannot move through the barrier. A creature whose space it is placed in is moved to the nearest space outside it (no opportunity attacks)." }
];

/**
 * How many properties a Barrier of the given power level may choose (SRD):
 * PL 3 → 1, 5 → 2, 7 → 3, 9 → 4. Scales 1 per two PLs above 3, clamped 1–4.
 * @param {number} powerLevel
 * @returns {number}
 */
BOON.barrierPropertyCount = function(powerLevel) {
  const pl = Math.max(0, Math.floor(Number(powerLevel) || 0));
  if ( pl >= 9 ) return 4;
  if ( pl >= 7 ) return 3;
  if ( pl >= 5 ) return 2;
  if ( pl >= 3 ) return 1;
  return 0;
};

/**
 * The property KEYS available to a Barrier at a given power level (SRD):
 * PL 3 → Damaging/Obscuring/Hindering; PL 5 adds Baneful, Mobile; PL 7+ adds
 * Impassable. Returned in BARRIER_PROPERTIES order.
 * @param {number} powerLevel
 * @returns {string[]}
 */
BOON.barrierPropertyPool = function(powerLevel) {
  const pl = Math.max(0, Math.floor(Number(powerLevel) || 0));
  const base = ["damaging", "obscuring", "hindering"];
  if ( pl >= 7 ) base.push("baneful", "mobile", "impassable");
  else if ( pl >= 5 ) base.push("baneful", "mobile");
  // Preserve canonical display order.
  const order = BOON.BARRIER_PROPERTIES.map(p => p.key);
  return order.filter(k => base.includes(k));
};

/**
 * The Damaging-property damage die for a Barrier by power level (SRD):
 * PL 3 → 1d4, 5 → 1d8, 7 → 1d10, 9 → 2d6.
 * @param {number} powerLevel
 * @returns {string}  A dice formula (no explode marker), or "" below PL 3.
 */
BOON.barrierDamageDie = function(powerLevel) {
  const pl = Math.max(0, Math.floor(Number(powerLevel) || 0));
  if ( pl >= 9 ) return "2d6";
  if ( pl >= 7 ) return "1d10";
  if ( pl >= 5 ) return "1d8";
  if ( pl >= 3 ) return "1d4";
  return "";
};
