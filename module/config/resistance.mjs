/**
 * Open Legend RESISTANCE configuration: the damage-resistance layer that combines
 * the Energy Resistance FEAT and the Resistance BOON. Pulling this into its own
 * module breaks what was a feat <-> damage import cycle: the feat side
 * (energyResistance) and the boon side (resistanceBoon) both live here, and this
 * file imports the damage catalog one-way (resistance -> damage -> stats). Nothing
 * imports back into resistance, so no OL() indirection is needed. Merged into the
 * public {@link OPENLEGEND} object in ./index.mjs (see stats.mjs for the pattern).
 */
import DAMAGE from "./damage.mjs";

const RESIST = {};
export default RESIST;

/* -------------------------------------------- */
/*  Energy Resistance (feat)                    */
/* -------------------------------------------- */

/**
 * The compendium base name of the Energy Resistance feat (multi-take, maxTier 4).
 * Each copy picks an energy type (stored in `system.choice.value`); its TIER raises
 * the actor's defenses against that energy by 3/6/9 (Tier 1–3) or grants IMMUNITY
 * (Tier 4) to that damage type.
 * @type {string}
 */
RESIST.ENERGY_RESISTANCE_BASE = "Energy Resistance (I - IV)";

/**
 * Normalize an energy-type choice / damage-type key for matching: lowercased, and
 * the common alias "lightning" → "electricity" (the feat's energy list says
 * "Lightning"; the damage type is "Electricity").
 * @param {string} v
 * @returns {string}
 */
RESIST.normalizeEnergyType = function(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if ( s === "lightning" ) return "electricity";
  return s;
};

/**
 * The energy types a player may pick for Energy Resistance: every damage type
 * (built-in AND user-defined) EXCEPT the physical ones (Force / Precision — the
 * Might / Agility types). Returns display LABELS, alphabetically sorted, for the
 * feat-choice picker's option list / datalist. Reads the damage catalog from
 * damage.mjs.
 * @returns {string[]}
 */
RESIST.energyResistanceChoices = function() {
  const labels = DAMAGE.allDamageTypes();
  return Object.keys(labels)
    .filter(key => !DAMAGE.isPhysicalDamageType(key))
    .map(key => labels[key] || key)
    .sort((a, b) => a.localeCompare(b));
};

/**
 * The Energy Resistance an actor has against a given NON-PHYSICAL damage type. Scans
 * owned Energy Resistance feats whose chosen energy matches `damageTypeKey` (case-
 * insensitive, with the lightning↔electricity alias), taking the HIGHEST tier. Tier
 * 1–3 → a +3/+6/+9 defense bonus vs that type; Tier 4 → immunity (no damage / harmful
 * effects). Returns null when no match (or the type is physical).
 * @param {Actor} actor
 * @param {string} damageTypeKey  The attack's damage type KEY (sys.damageType).
 * @returns {{tier: number, defenseBonus: number, immune: boolean, label: string}|null}
 */
RESIST.energyResistance = function(actor, damageTypeKey) {
  const base = RESIST.ENERGY_RESISTANCE_BASE;
  const target = RESIST.normalizeEnergyType(damageTypeKey);
  if ( !target || DAMAGE.isPhysicalDamageType(damageTypeKey) ) return null;

  let best = 0;
  let label = "";
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    const chosen = RESIST.normalizeEnergyType(feat.system?.choice?.value);
    if ( !chosen || (chosen !== target) ) continue;
    const tier = Math.max(1, Math.min(4, Math.floor(Number(feat.system?.purchasedTier) || 1)));
    if ( tier > best ) { best = tier; label = String(feat.system?.choice?.value ?? "").trim(); }
  }
  if ( best <= 0 ) return null;
  return {
    tier: best,
    defenseBonus: (best >= 4) ? 0 : (best * 3),   // T1→3, T2→6, T3→9
    immune: best >= 4,
    label
  };
};

/* -------------------------------------------- */
/*  Resistance (boon)                           */
/* -------------------------------------------- */

/**
 * The SRD boon name whose effect is "resistance to one type of attack". When
 * granted, the invoker CHOOSES a damage type (stored in the applied effect's
 * flags.openlegend.resistance.damageType); thereafter an attack of that type
 * against the bearer is resisted by power level: PL3→+3, PL5→+6, PL7→+9 defense,
 * PL9→immune (mirrors Energy Resistance but works on PHYSICAL types too).
 * @type {string}
 */
RESIST.RESISTANCE_BOON_NAME = "Resistance";

/**
 * Map a Resistance-boon power level to its defense bonus / immunity, per the SRD
 * (non-cumulative): PL ≥9 → immune; ≥7 → +9; ≥5 → +6; ≥3 → +3; below 3 → none.
 * @param {number} powerLevel
 * @returns {{defenseBonus: number, immune: boolean}}
 */
RESIST.resistanceBoonBonus = function(powerLevel) {
  const pl = Math.max(0, Math.floor(Number(powerLevel) || 0));
  if ( pl >= 9 ) return { defenseBonus: 0, immune: true };
  if ( pl >= 7 ) return { defenseBonus: 9, immune: false };
  if ( pl >= 5 ) return { defenseBonus: 6, immune: false };
  if ( pl >= 3 ) return { defenseBonus: 3, immune: false };
  return { defenseBonus: 0, immune: false };
};

/**
 * The Resistance BOON an actor currently has against a given damage type. Scans
 * the actor's active effects for the Resistance boon's marker
 * (flags.openlegend.resistance) whose chosen damage type matches `damageTypeKey`
 * (case-insensitive, lightning↔electricity alias), taking the HIGHEST power level.
 * Works on physical AND non-physical types. Returns null when no match.
 * @param {Actor} actor
 * @param {string} damageTypeKey  The attack's damage type KEY (sys.damageType).
 * @returns {{powerLevel: number, defenseBonus: number, immune: boolean, label: string}|null}
 */
RESIST.resistanceBoon = function(actor, damageTypeKey) {
  const target = RESIST.normalizeEnergyType(damageTypeKey);
  if ( !target ) return null;
  let best = 0;
  let label = "";
  for ( const effect of (actor?.effects ?? []) ) {
    const ol = effect?.flags?.openlegend;
    const res = ol?.resistance;
    if ( !res || effect.disabled ) continue;
    const chosen = RESIST.normalizeEnergyType(res.damageType);
    if ( !chosen || (chosen !== target) ) continue;
    // Read the LIVE power level off the effect (steppable in the effects panel);
    // fall back to the value stamped at grant time.
    const pl = Math.max(0, Math.floor(Number(ol?.powerLevel ?? res.powerLevel) || 0));
    if ( pl > best ) { best = pl; label = String(res.damageTypeLabel || res.damageType || "").trim(); }
  }
  if ( best <= 0 ) return null;
  const { defenseBonus, immune } = RESIST.resistanceBoonBonus(best);
  if ( (defenseBonus <= 0) && !immune ) return null;
  return { powerLevel: best, defenseBonus, immune, label };
};

/* -------------------------------------------- */

/**
 * The BEST resistance an actor has against a damage type, combining the Energy
 * Resistance feat ({@link RESIST.energyResistance}) and the Resistance boon
 * ({@link RESIST.resistanceBoon}). Returns the stronger of the two: immunity wins;
 * otherwise the larger defense bonus. The `source` field names which one applied
 * ("feat" | "boon"). Returns null when neither applies.
 * @param {Actor} actor
 * @param {string} damageTypeKey
 * @returns {{defenseBonus: number, immune: boolean, label: string, source: string}|null}
 */
RESIST.damageResistance = function(actor, damageTypeKey) {
  const feat = RESIST.energyResistance(actor, damageTypeKey);
  const boon = RESIST.resistanceBoon(actor, damageTypeKey);
  if ( !feat && !boon ) return null;
  const featImmune = !!feat?.immune;
  const boonImmune = !!boon?.immune;
  if ( featImmune || boonImmune ) {
    const src = featImmune ? feat : boon;
    return { defenseBonus: 0, immune: true, label: src.label, source: featImmune ? "feat" : "boon" };
  }
  const featBonus = feat?.defenseBonus ?? 0;
  const boonBonus = boon?.defenseBonus ?? 0;
  if ( boonBonus >= featBonus ) {
    return { defenseBonus: boonBonus, immune: false, label: boon.label, source: "boon" };
  }
  return { defenseBonus: featBonus, immune: false, label: feat.label, source: "feat" };
};
