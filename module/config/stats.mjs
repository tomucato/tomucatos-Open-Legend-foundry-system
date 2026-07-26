

const STATS = {};
export default STATS;

/**
 * The four attribute categories and the attributes belonging to each, in book order.
 * @type {Record<string, {label: string, attributes: string[]}>}
 */
STATS.categories = {
  physical: {
    label: "Physical",
    attributes: ["agility", "fortitude", "might"]
  },
  mental: {
    label: "Mental",
    attributes: ["learning", "logic", "perception", "will"]
  },
  social: {
    label: "Social",
    attributes: ["deception", "persuasion", "presence"]
  },
  extraordinary: {
    label: "Extraordinary",
    attributes: ["alteration", "creation", "energy", "entropy", "influence", "movement", "prescience", "protection"]
  }
};

/**
 * Human-readable label for every attribute key.
 * @type {Record<string, string>}
 */
STATS.attributeLabels = {
  agility: "Agility",
  fortitude: "Fortitude",
  might: "Might",
  learning: "Learning",
  logic: "Logic",
  perception: "Perception",
  will: "Will",
  deception: "Deception",
  persuasion: "Persuasion",
  presence: "Presence",
  alteration: "Alteration",
  creation: "Creation",
  energy: "Energy",
  entropy: "Entropy",
  influence: "Influence",
  movement: "Movement",
  prescience: "Prescience",
  protection: "Protection"
};

/**
 * Highest attribute score the system supports.
 * @type {number}
 */
STATS.maxScore = 10;

/**
 * Maps an attribute score (0-10) to the dice pool it grants.
 * A score of 0 grants no bonus dice (the roll is a flat d20).
 * @type {Record<number, string>}
 */
STATS.attributeDice = {
  0: "",
  1: "1d4",
  2: "1d6",
  3: "1d8",
  4: "1d10",
  5: "2d6",
  6: "2d8",
  7: "2d10",
  8: "3d8",
  9: "3d10",
  10: "4d8"
};

/**
 * Cumulative attribute-point cost to *reach* a given score, i.e. the triangular
 * number N·(N+1)/2 (1+2+3+…+N). Raising a score from A to B costs
 * cost(B) − cost(A).
 *   1→1, 2→3, 3→6, 4→10, 5→15, 6→21, 7→28, 8→36, 9→45
 * @type {Record<number, number>}
 */
STATS.attributeCost = {
  0: 0,
  1: 1,
  2: 3,
  3: 6,
  4: 10,
  5: 15,
  6: 21,
  7: 28,
  8: 36,
  9: 45,
  10: 55
};


/**
 * Character-creation budgets at level 1 (Open Legend SRD, Chapter 1).
 */
STATS.creation = {
  attributePoints: 40,
  maxAttributeScore: 5,
  featPoints: 6
};

/**
 * Per-level progression. For each level, the cumulative totals a character has
 * available. Derived from the Open Legend advancement table:
 *   attributePoints = 40 + 9·(level − 1)   (3 attribute points per XP, 3 XP per level)
 *   featPoints      = 6  + 3·(level − 1)    (1 feat point per XP)
 *   maxScore        = per the table below (caps attribute scores at that level)
 * @type {Record<number, {attributePoints: number, maxScore: number, featPoints: number}>}
 */
STATS.levels = {
  1:  { attributePoints: 40,  maxScore: 5, featPoints: 6 },
  2:  { attributePoints: 49,  maxScore: 5, featPoints: 9 },
  3:  { attributePoints: 58,  maxScore: 6, featPoints: 12 },
  4:  { attributePoints: 67,  maxScore: 6, featPoints: 15 },
  5:  { attributePoints: 76,  maxScore: 7, featPoints: 18 },
  6:  { attributePoints: 85,  maxScore: 7, featPoints: 21 },
  7:  { attributePoints: 94,  maxScore: 8, featPoints: 24 },
  8:  { attributePoints: 103, maxScore: 8, featPoints: 27 },
  9:  { attributePoints: 112, maxScore: 9, featPoints: 30 },
  10: { attributePoints: 121, maxScore: 9, featPoints: 33 }
};

/**
 * Resolve the budgets available at a given character level. Levels beyond the
 * table extrapolate with the per-level formulas (max score stays capped at 9).
 * @param {number} level
 * @returns {{level: number, attributePoints: number, maxScore: number, featPoints: number}}
 */
STATS.budgetForLevel = function(level) {
  const lvl = Math.max(1, Math.floor(Number(level ?? 1)));
  const entry = STATS.levels[lvl];
  if ( entry ) return { level: lvl, ...entry };
  // Extrapolate past the table (level 11+).
  return {
    level: lvl,
    attributePoints: 40 + (9 * (lvl - 1)),
    featPoints: 6 + (3 * (lvl - 1)),
    maxScore: Math.min(9, 5 + Math.max(0, lvl - 5))
  };
};

/**
 * Resolve budgets from XP directly, awarding points for EVERY XP (not just at
 * level breakpoints). Level 1 grants the base 40 attribute / 6 feat points; each
 * XP beyond that adds 3 attribute points and 1 feat point:
 *   attributePoints = 40 + 3·XP
 *   featPoints      = 6  + 1·XP
 * A level is 3 XP, so at whole-level XP values (0, 3, 6, …) these equal
 * budgetForLevel; between levels they grant the partial XP too (e.g. XP 5 → 55
 * attr / 11 feat). Max attribute score follows the derived level's cap.
 * @param {number} xp
 * @returns {{level: number, xp: number, attributePoints: number, maxScore: number, featPoints: number}}
 */
STATS.budgetForXp = function(xp) {
  const x = Math.max(0, Math.floor(Number(xp ?? 0)));
  const level = Math.floor(x / 3) + 1;         // level 1 = 0 XP; +1 level per 3 XP
  return {
    level,
    xp: x,
    attributePoints: 40 + (3 * x),
    featPoints: 6 + (1 * x),
    maxScore: STATS.budgetForLevel(level).maxScore
  };
};

/* -------------------------------------------- */
/*  NPC Simple Build                            */
/* -------------------------------------------- */

/**
 * NPC Simple Build guideline table (Open Legend, Chapter 8). For each NPC level,
 * the suggested ranges for Hit Points and Defenses, plus recommended Primary and
 * Secondary attribute scores. Unlike player characters, an NPC's HP and defenses
 * are NOT derived from attributes — the GM sets them freely, using this table as
 * guidance (shown as per-field tooltips on the NPC sheet).
 * @type {Record<number, {hp: [number, number], defense: [number, number], primary: number, secondary: number}>}
 */
STATS.npcBuild = {
  1:  { hp: [10, 22], defense: [10, 16], primary: 4,  secondary: 3 },
  2:  { hp: [12, 24], defense: [11, 17], primary: 5,  secondary: 3 },
  3:  { hp: [14, 26], defense: [12, 18], primary: 5,  secondary: 4 },
  4:  { hp: [16, 28], defense: [13, 19], primary: 6,  secondary: 4 },
  5:  { hp: [18, 30], defense: [14, 20], primary: 6,  secondary: 5 },
  6:  { hp: [20, 32], defense: [15, 21], primary: 7,  secondary: 5 },
  7:  { hp: [22, 34], defense: [16, 22], primary: 7,  secondary: 6 },
  8:  { hp: [24, 36], defense: [17, 23], primary: 8,  secondary: 6 },
  9:  { hp: [26, 38], defense: [18, 24], primary: 8,  secondary: 7 },
  10: { hp: [28, 40], defense: [19, 25], primary: 9,  secondary: 7 },
  11: { hp: [30, 42], defense: [19, 25], primary: 9,  secondary: 8 },
  12: { hp: [32, 44], defense: [20, 26], primary: 10, secondary: 8 },
  13: { hp: [34, 46], defense: [20, 26], primary: 10, secondary: 9 },
  14: { hp: [36, 48], defense: [21, 27], primary: 10, secondary: 9 },
  15: { hp: [38, 50], defense: [21, 27], primary: 10, secondary: 9 },
  16: { hp: [40, 52], defense: [22, 28], primary: 10, secondary: 9 },
  17: { hp: [42, 54], defense: [22, 28], primary: 10, secondary: 9 },
  18: { hp: [44, 56], defense: [23, 29], primary: 10, secondary: 9 },
  19: { hp: [46, 58], defense: [23, 29], primary: 10, secondary: 9 },
  20: { hp: [48, 60], defense: [24, 30], primary: 10, secondary: 9 }
};

/**
 * The NPC Simple Build guidance for a level, clamped to the table's 1–20 range.
 * @param {number} level
 * @returns {{level: number, hp: [number, number], defense: [number, number], primary: number, secondary: number}}
 */
STATS.npcBuildForLevel = function(level) {
  const lvl = Math.max(1, Math.min(20, Math.floor(Number(level ?? 1))));
  return { level: lvl, ...STATS.npcBuild[lvl] };
};

/**
 * Boss NPC Build guideline table (Open Legend, Chapter 8 — Boss variant). Like
 * the Simple Build but tougher: a single recommended Hit Point total (not a
 * range), a defense range, recommended Primary/Secondary attribute scores, and a
 * Boss Edge — advantage applied to ALL of the boss's attack rolls. As with NPCs,
 * a boss's HP and defenses are set freely by the GM, guided by this table.
 * @type {Record<number, {hp: number, defense: [number, number], primary: number, secondary: number, edge: number}>}
 */
STATS.bossBuild = {
  1:  { hp: 40,  defense: [12, 17], primary: 6,  secondary: 4, edge: 1 },
  2:  { hp: 50,  defense: [13, 18], primary: 6,  secondary: 4, edge: 1 },
  3:  { hp: 60,  defense: [14, 19], primary: 7,  secondary: 5, edge: 2 },
  4:  { hp: 70,  defense: [15, 20], primary: 7,  secondary: 5, edge: 2 },
  5:  { hp: 75,  defense: [16, 21], primary: 8,  secondary: 6, edge: 2 },
  6:  { hp: 80,  defense: [17, 22], primary: 8,  secondary: 6, edge: 3 },
  7:  { hp: 85,  defense: [18, 23], primary: 9,  secondary: 7, edge: 3 },
  8:  { hp: 90,  defense: [19, 24], primary: 9,  secondary: 7, edge: 3 },
  9:  { hp: 95,  defense: [20, 25], primary: 10, secondary: 8, edge: 4 },
  10: { hp: 100, defense: [21, 26], primary: 10, secondary: 8, edge: 4 },
  11: { hp: 100, defense: [21, 26], primary: 10, secondary: 9, edge: 4 },
  12: { hp: 105, defense: [22, 27], primary: 10, secondary: 9, edge: 5 },
  13: { hp: 105, defense: [22, 27], primary: 10, secondary: 9, edge: 5 },
  14: { hp: 110, defense: [23, 28], primary: 10, secondary: 9, edge: 5 },
  15: { hp: 110, defense: [23, 28], primary: 10, secondary: 9, edge: 6 },
  16: { hp: 115, defense: [24, 29], primary: 10, secondary: 9, edge: 6 },
  17: { hp: 115, defense: [24, 29], primary: 10, secondary: 9, edge: 6 },
  18: { hp: 120, defense: [25, 30], primary: 10, secondary: 9, edge: 7 },
  19: { hp: 120, defense: [25, 30], primary: 10, secondary: 9, edge: 7 },
  20: { hp: 125, defense: [26, 31], primary: 10, secondary: 9, edge: 7 }
};

/**
 * The Boss NPC Build guidance for a level, clamped to the table's 1–20 range.
 * @param {number} level
 * @returns {{level: number, hp: number, defense: [number, number], primary: number, secondary: number, edge: number}}
 */
STATS.bossBuildForLevel = function(level) {
  const lvl = Math.max(1, Math.min(20, Math.floor(Number(level ?? 1))));
  return { level: lvl, ...STATS.bossBuild[lvl] };
};

/**
 * Target defenses a damaging action can be resolved against. @type {Record<string, string>}
 */
STATS.targetDefenses = {
  guard: "Guard",
  toughness: "Toughness",
  resolve: "Resolve"
};