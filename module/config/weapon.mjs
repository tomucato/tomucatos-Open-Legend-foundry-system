/**
 * Open Legend weapon configuration: weapon categories, weapon properties, and the
 * category-derived helpers (range increment, hands required, total hands). Merged
 * into the public {@link OPENLEGEND} object in ./index.mjs (see stats.mjs for the
 * same pattern). Weapon *action* builders and the Defensive-value helpers stay in
 * config.mjs; feat-dependent weapon mechanics (effective hands, grip advantage)
 * live in feat.mjs.
 */

const WEAPON = {};
export default WEAPON;

/**
 * Weapon categories (Weapons & Implements rules). A weapon may have several;
 * ranged categories carry a range increment in feet. `ranged: true` marks the
 * category as a ranged mode for deriving a weapon's range increment.
 * @type {Record<string, {label: string, ranged?: boolean, rangeIncrement?: number}>}
 */
WEAPON.weaponCategories = {
  melee:             { label: "Melee" },
  "one-handed-melee":{ label: "One-handed Melee" },
  "two-handed-melee":{ label: "Two-handed Melee" },
  "versatile-melee": { label: "Versatile Melee" },
  "close-ranged":    { label: "Close Ranged",   ranged: true, rangeIncrement: 25 },
  "short-ranged":    { label: "Short Ranged",   ranged: true, rangeIncrement: 50 },
  "medium-ranged":   { label: "Medium Ranged",  ranged: true, rangeIncrement: 75 },
  "long-ranged":     { label: "Long Ranged",    ranged: true, rangeIncrement: 125 },
  "extreme-ranged":  { label: "Extreme Ranged", ranged: true, rangeIncrement: 300 }
};

/**
 * Weapon properties (Weapons & Implements rules). `valued` properties carry a
 * numeric value (Defensive N); `parameterized` properties carry a free-text
 * detail (Area "10' cone"); the rest are simple flags.
 * @type {Record<string, {label: string, valued?: boolean, parameterized?: boolean}>}
 */
WEAPON.weaponProperties = {
  forceful:        { label: "Forceful" },
  precise:         { label: "Precise" },
  swift:           { label: "Swift" },
  slow:            { label: "Slow" },
  heavy:           { label: "Heavy" },
  reach:           { label: "Reach" },
  expendable:      { label: "Expendable" },
  "delayed-ready": { label: "Delayed Ready" },
  stationary:      { label: "Stationary" },
  defensive:       { label: "Defensive", valued: true },
  area:            { label: "Area", parameterized: true }
};

/**
 * The range increment (feet) for a set of categories: the max increment among
 * any ranged categories, else 0.
 * @param {string[]} categories
 * @returns {number}
 */
WEAPON.rangeIncrementFor = function(categories = []) {
  let inc = 0;
  for ( const key of categories ) {
    const cat = WEAPON.weaponCategories[key];
    if ( cat?.ranged ) inc = Math.max(inc, cat.rangeIncrement ?? 0);
  }
  return inc;
};

/**
 * How many hands a weapon needs, from its categories. Two-handed melee always
 * needs two hands; a versatile-melee weapon can be wielded in one OR two hands
 * (the player chooses on equip); everything else (one-handed melee, ranged,
 * the generic melee category) needs one hand.
 * @param {string[]} categories
 * @returns {1|2|"versatile"}
 */
WEAPON.weaponHandsFor = function(categories = []) {
  if ( categories.includes("two-handed-melee") ) return 2;
  if ( categories.includes("versatile-melee") ) return "versatile";
  return 1;
};

/** Total hands available to a wielder. Open Legend assumes two. */
WEAPON.maxHands = 2;
