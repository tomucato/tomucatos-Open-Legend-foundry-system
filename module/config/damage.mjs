/**
 * Open Legend damage-type configuration: the built-in damage-type catalog, their
 * descriptions (flat + per-attribute variants), attribute groupings, the
 * user-defined ("custom") damage-type world-setting accessors, and the physical-
 * type test. This is a leaf module (imports only STATS, for JSDoc). The damage
 * RESISTANCE layer (Energy Resistance feat + Resistance boon) lives in
 * resistance.mjs, which imports THIS file one-way. Merged into the public
 * {@link OPENLEGEND} object in ./index.mjs (see stats.mjs for the pattern).
 */
import STATS from "./stats.mjs";   // eslint-disable-line no-unused-vars -- referenced in @link JSDoc

const DAMAGE = {};
export default DAMAGE;

/**
 * Damage types catalog (deduplicated; a type may belong to more than one
 * attribute). @type {Record<string, string>}
 */
DAMAGE.damageTypes = {
  cold: "Cold",
  electricity: "Electricity",
  fire: "Fire",
  sonic: "Sonic",
  force: "Force",
  precision: "Precision",
  entropic: "Entropic",
  necrotic: "Necrotic",
  poison: "Poison",
  mental: "Mental",
  acid: "Acid",
  spirit: "Spirit",
  life: "Life"
};

/**
 * Default flavor description per damage-type key, surfaced as a hint under the
 * action sheet's Damage Type picker. Some types read differently depending on the
 * dealing attribute — those per-attribute variants live in
 * {@link DAMAGE.damageTypeDescriptionsByAttribute} and take priority.
 * @type {Record<string, string>}
 */
DAMAGE.damageTypeDescriptions = {
  fire: "Harm from heat and open flame.",
  cold: "Harm from freezing temperatures and loss of heat.",
  electricity: "Harm from electrical currents, lightning, or charged spells.",
  sonic: "Harm caused by intense vibrations in the air.",
  force: "Harm from pure magical energy acting as a physical force.",
  precision: "Harm from precise strikes from precise weapons (typically piercing, sometimes slashing).",
  entropic: "Harm from the elemental forces of decay, corruption, destruction, and entropy.",
  necrotic: "Harm from the power of unlife. No damage to inanimate objects and heals undead.",
  poison: "Harm from created toxins that poison living creatures on contact.",
  mental: "Harm inflicted by tormenting, degrading, or overwhelming the mind. Cannot be lethal.",
  acid: "Harm from created corrosive substances that degrade matter on contact.",
  spirit: "Harm that targets the soul by channeling higher powers. Divine in nature; typically linked to divine character concepts. Soulless creatures and objects can't be harmed. Mortals take less damage. Extraplanar creatures take full damage.",
  life: "Harm from the power of creation, effective exclusively against undead."
};

/**
 * Per-attribute description OVERRIDES for damage types that read differently
 * depending on which attribute deals them (the same key can mean different things
 * under different attributes). Looked up as [attribute][key]; falls back to the
 * flat {@link DAMAGE.damageTypeDescriptions} default. @type {Record<string, Record<string, string>>}
 */
DAMAGE.damageTypeDescriptionsByAttribute = {
  movement: {
    sonic: "Harm caused by vibration and resonance in the air.",
    force: "Harm from pure magical energy acting as a physical force."
  },
  entropy: {
    poison: "Harm from toxins that poison living creatures (variant under entropic decay)."
  },
  might: {
    force: "Harm from brute weapon force from forceful weapons (typically bludgeoning, sometimes slashing)."
  }
};

/**
 * Damage types grouped by the attribute that deals them. A type may appear under
 * several attributes. Keys are attribute keys (see {@link STATS.attributeLabels}).
 * @type {Record<string, string[]>}
 */
DAMAGE.damageTypesByAttribute = {
  energy:    ["cold", "electricity", "fire", "sonic"],
  movement:  ["sonic", "force"],
  creation:  ["acid", "spirit", "life", "poison"],
  entropy:   ["entropic", "necrotic", "poison"],
  might:     ["force"],
  agility:   ["precision"],
  influence: ["mental"]
};

/* -------------------------------------------- */
/*  User-defined damage types (world setting)   */
/* -------------------------------------------- */

/** The system id + the world setting key holding user-added damage types. */
DAMAGE.SYSTEM_ID = "tomucatos-open-legend-rpg-system";
DAMAGE.CUSTOM_DAMAGE_TYPES_SETTING = "customDamageTypes";

/**
 * The GM-defined custom damage types from world settings: an array of
 * `{ key, label, description, attribute }`. `key` is a slug (unique), `attribute`
 * is the attribute category it's added under. Returns [] before settings are
 * registered or when empty.
 * @returns {Array<{key: string, label: string, description: string, attribute: string}>}
 */
DAMAGE.customDamageTypes = function() {
  try {
    const raw = game.settings?.get(DAMAGE.SYSTEM_ID, DAMAGE.CUSTOM_DAMAGE_TYPES_SETTING);
    return Array.isArray(raw) ? raw : [];
  } catch ( _err ) {
    return [];   // setting not registered yet (e.g. very early init)
  }
};

/**
 * All damage-type LABELS (built-in + custom), keyed by type key. Custom entries
 * override/extend the built-in catalog. This is what every consumer should read
 * (so user-defined types resolve everywhere a label is looked up).
 * @returns {Record<string, string>}
 */
DAMAGE.allDamageTypes = function() {
  const out = { ...DAMAGE.damageTypes };
  for ( const t of DAMAGE.customDamageTypes() ) {
    if ( t?.key ) out[t.key] = t.label || t.key;
  }
  return out;
};

/**
 * All damage-type DESCRIPTIONS (built-in + custom), keyed by type key. When an
 * `attribute` is given, per-attribute variant descriptions take priority over the
 * flat defaults (e.g. Poison reads differently under Creation vs Entropy). Custom
 * types' descriptions apply regardless of attribute.
 * @param {string} [attribute]  The dealing attribute key (for variant lookup).
 * @returns {Record<string, string>}
 */
DAMAGE.allDamageTypeDescriptions = function(attribute = "") {
  const out = { ...DAMAGE.damageTypeDescriptions };
  // Per-attribute variant overrides (only when an attribute context is supplied).
  const variants = attribute ? (DAMAGE.damageTypeDescriptionsByAttribute?.[attribute] ?? null) : null;
  if ( variants ) for ( const [k, d] of Object.entries(variants) ) out[k] = d;
  for ( const t of DAMAGE.customDamageTypes() ) {
    if ( t?.key && t.description && (!attribute || !t.attribute || (t.attribute === attribute)) ) out[t.key] = t.description;
  }
  return out;
};

/**
 * All damage types grouped by attribute (built-in + custom). Each custom type is
 * appended to its `attribute`'s list (deduplicated, built-ins first).
 * @returns {Record<string, string[]>}
 */
DAMAGE.allDamageTypesByAttribute = function() {
  const out = {};
  for ( const [attr, keys] of Object.entries(DAMAGE.damageTypesByAttribute) ) out[attr] = [...keys];
  for ( const t of DAMAGE.customDamageTypes() ) {
    if ( !t?.key || !t?.attribute ) continue;
    (out[t.attribute] ??= []);
    if ( !out[t.attribute].includes(t.key) ) out[t.attribute].push(t.key);
  }
  return out;
};

/**
 * Slugify a label into a damage-type key (lowercase, alphanumerics + dashes).
 * @param {string} label
 * @returns {string}
 */
DAMAGE.slugifyDamageType = function(label) {
  return String(label ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
};

/**
 * Whether a damage type key is PHYSICAL (Force/Precision — the Might/Agility types).
 * Energy Resistance applies only to NON-physical (energy) damage types.
 * @param {string} damageTypeKey
 * @returns {boolean}
 */
DAMAGE.isPhysicalDamageType = function(damageTypeKey) {
  const physical = new Set([
    ...(DAMAGE.allDamageTypesByAttribute?.()?.might ?? DAMAGE.damageTypesByAttribute?.might ?? []),
    ...(DAMAGE.allDamageTypesByAttribute?.()?.agility ?? DAMAGE.damageTypesByAttribute?.agility ?? [])
  ].map(k => String(k).toLowerCase()));
  return physical.has(String(damageTypeKey ?? "").toLowerCase());
};
