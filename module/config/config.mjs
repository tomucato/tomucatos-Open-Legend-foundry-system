/**
 * Open Legend RPG system configuration.
 * Single source of truth for attribute categories, the score-to-dice mapping,
 * and character-creation budgets, per the Open Legend SRD:
 * https://openlegendrpg.com/core-rules/character-creation
 */
import STATS from "./stats.mjs";
import DAMAGE from "./damage.mjs";
import WEAPON from "./weapon.mjs";
import BANE from "./bane.mjs";
import BOON from "./boon.mjs";
import FEATS from "./feat.mjs";

// This file's helpers/tables read shared data straight from the modules that own
// it: STATS.* (attribute data), DAMAGE.* (damage-type catalog), WEAPON.* (weapon
// categories/hands), BANE.* / BOON.* (bane & boon resolution), FEATS.* (feat
// automation, e.g. hasDefensiveMastery). All are safe direct imports because
// nothing imports THIS file except index.mjs — the config module graph is a plain
// DAG with no cycles, so no runtime-global (OL) indirection is needed anywhere.
const CONFIG = {};
export default CONFIG;



/**
 * Cumulative point cost to reach the given attribute score.
 * @param {number} score
 * @returns {number}
 */
CONFIG.costForScore = function(score) {
  const s = Math.max(0, Math.min(STATS.maxScore, Math.floor(Number(score ?? 0))));
  return STATS.attributeCost[s] ?? ((s * (s + 1)) / 2);
};

/**
 * Returns the bonus dice formula for a given attribute score, clamped to 0-10.
 * @param {number} score
 * @returns {string} e.g. "2d6", or "" for score 0.
 */
CONFIG.diceForScore = function(score) {
  const s = Math.max(0, Math.min(STATS.maxScore, Math.floor(Number(score ?? 0))));
  return STATS.attributeDice[s] ?? "";
};

/**
 * The radius (in feet) of an Aura boon by its invoked power level (SRD: Aura):
 * PL 4 → 5', PL 6 → 10', PL 8 → 15'. For an in-between/odd PL, round down to the
 * nearest defined breakpoint. Returns 0 for PL < 4.
 * @param {number} powerLevel
 * @returns {number}  Radius in feet.
 */
CONFIG.auraRadiusForPowerLevel = function(powerLevel) {
  const pl = Math.max(0, Math.floor(Number(powerLevel) || 0));
  if ( pl >= 8 ) return 15;
  if ( pl >= 6 ) return 10;
  if ( pl >= 4 ) return 5;
  return 0;
};


/* -------------------------------------------- */
/*  Minion (Summon Creature boon)               */
/* -------------------------------------------- */

/**
 * The six attributes a minion may have (SRD: the boon that creates a minion lets you
 * assign its points among these). Minion attributes do NOT affect HP or defenses.
 * @type {string[]}
 */
CONFIG.MINION_ATTRIBUTES = ["agility", "fortitude", "might", "perception", "energy", "entropy"];

/**
 * Minion build by the boon's power level (4–9): fixed Hit Points, a single Defense
 * value used for ALL THREE defenses (Guard/Toughness/Resolve), and the attribute-point
 * SPREAD to distribute among the six minion attributes. HP & defenses are fixed by PL —
 * never derived from attributes, never free-form. (SRD: Minion table.)
 * @type {Record<number, {powerLevel:number, hp:number, defense:number, spread:number[]}>}
 */
CONFIG.minionBuild = {
  4: { powerLevel: 4, hp: 4, defense: 11, spread: [2, 1, 1] },
  5: { powerLevel: 5, hp: 5, defense: 12, spread: [3, 2, 2] },
  6: { powerLevel: 6, hp: 6, defense: 13, spread: [4, 3, 3] },
  7: { powerLevel: 7, hp: 7, defense: 14, spread: [5, 4, 4] },
  8: { powerLevel: 8, hp: 8, defense: 15, spread: [6, 5, 5] },
  9: { powerLevel: 9, hp: 9, defense: 16, spread: [7, 6, 6] }
};

/**
 * The minion build for a power level, clamped to 4–9.
 * @param {number} powerLevel
 * @returns {{powerLevel:number, hp:number, defense:number, spread:number[]}}
 */
CONFIG.minionBuildForPowerLevel = function(powerLevel) {
  const pl = Math.max(4, Math.min(9, Math.floor(Number(powerLevel ?? 4))));
  const b = CONFIG.minionBuild[pl];
  return { ...b, spread: [...b.spread] };
};

/* -------------------------------------------- */
/*  Mounts & Vehicles                           */
/* -------------------------------------------- */

/**
 * Movement medium a mount/vehicle's speed applies to (SRD examples list "50'
 * flying", "70' swimming", …). Display-only; the value rides on system.speedMode.
 * @type {Record<string, string>}
 */
CONFIG.mountSpeedModes = {
  ground: "Ground",
  flying: "Flying",
  swimming: "Swimming"
};

/**
 * A mount/vehicle's damage-track state (SRD Damage Threshold): the current damage
 * level (disadvantage on ALL of the mount's action rolls), the threshold, and
 * whether the mount is disabled (level ≥ threshold — unable to act until repaired).
 * Returns null for any non-mount actor.
 * @param {Actor|null} actor
 * @returns {{level:number, threshold:number, disabled:boolean}|null}
 */
CONFIG.mountDamageState = function(actor) {
  if ( actor?.type !== "mount" ) return null;
  const level = Math.max(0, Math.floor(Number(actor.system?.damage?.level ?? 0)));
  const threshold = Math.max(1, Math.floor(Number(actor.system?.damage?.threshold ?? 1)));
  return { level, threshold, disabled: level >= threshold };
};

/**
 * Whether the actor is a mount/vehicle disabled by damage (damage level at or
 * past its damage threshold). A disabled mount cannot act until repaired.
 * @param {Actor|null} actor
 * @returns {boolean}
 */
CONFIG.mountDisabled = function(actor) {
  return !!CONFIG.mountDamageState(actor)?.disabled;
};

/* -------------------------------------------- */
/*  Text / dice rendering                       */
/* -------------------------------------------- */

/**
 * Replace plain dice notation ("1d6", "2d8") in a text/HTML snippet with
 * Foundry inline-roll enrichers, so the dice render as clickable roll links
 * after TextEditor.enrichHTML. All Open Legend rolls explode, so the formula
 * gets an `x` while the visible label stays the plain notation.
 * @param {string} text
 * @returns {string}
 */
CONFIG.diceToInlineRolls = function(text) {
  return String(text ?? "").replace(/\b(\d+)\s*[dD]\s*(\d+)\b/g, (m, n, f) => `[[/r ${n}d${f}x]]{${n}d${f}}`);
};

/* -------------------------------------------- */
/*  Actions                                     */
/* -------------------------------------------- */

/** The four action categories. @type {Record<string, string>} */
CONFIG.actionCategories = {
  damaging: "Damaging Action",
  boon: "Boon Action",
  bane: "Bane Action",
  interrupt: "Interrupt Action"
};

/**
 * Default icon for a newly-created action, by category. Used to give a fresh
 * action a category-appropriate image (a generic action otherwise gets a plain
 * default). @type {Record<string, string>}
 */
CONFIG.actionCategoryIcons = {
  damaging: "icons/svg/sword.svg",
  boon: "icons/svg/holy-shield.svg",
  bane: "icons/svg/poison.svg",
  interrupt: "icons/svg/combat.svg"
};

/** The default action icon when the category is unknown. @type {string} */
CONFIG.defaultActionIcon = "icons/svg/sword.svg";

/**
 * Interrupt-action kinds. An interrupt is either a Defend (react to an incoming
 * attack) or an Improvise (an off-turn improvised action). @type {Record<string, string>}
 */
CONFIG.interruptTypes = {
  defend: "Defend",
  improvise: "Improvise"
};

/** Action types (the action economy). @type {Record<string, string>} */
CONFIG.actionTypes = {
  major: "Major Action",
  move: "Move Action",
  minor: "Minor Action",
  focus: "Focus Action",
  interrupt: "Interrupt Action",
  free: "Free Action"
};

/** Range modes for an action. @type {Record<string, string>} */
CONFIG.rangeModes = {
  melee: "Melee",
  ranged: "Ranged",
  "non-physical": "Non-physical (by attribute)"
};

/**
 * Ranged increment bands (feet). @type {Record<string, {label: string, feet: number}>}
 */
CONFIG.rangeBands = {
  close:   { label: "Close (25')",   feet: 25 },
  short:   { label: "Short (50')",   feet: 50 },
  medium:  { label: "Medium (75')",  feet: 75 },
  long:    { label: "Long (125')",   feet: 125 },
  extreme: { label: "Extreme (300')", feet: 300 }
};

/** Target modes. @type {Record<string, string>} */
CONFIG.targetModes = {
  single: "Single Target",
  multiple: "Multiple Targets",
  area: "Area"
};

/**
 * Detection boon phenomena (SRD: alignments, life, death, magic…). The key is
 * stamped on both sides of the automation:
 *   - a granted Detection condition carries flags.openlegend.detection = key
 *     (the bearer's PLAYER perceives that phenomenon), and
 *   - a GM-placed "Detection Aura" marker carries
 *     flags.openlegend.detectionAura = key (the token RADIATES it).
 * A token radiating a phenomenon shows a colored glow (color below) to the GM
 * and to any player owning a token whose actor bears a matching Detection —
 * see drawDetectionGlow in module/canvas/token.mjs.
 * @type {Record<string, {label: string, color: number, img: string}>}
 */
CONFIG.detectionTypes = {
  holy:   { label: "Holy",   color: 0xFFD700, img: "icons/svg/angel.svg" },
  unholy: { label: "Unholy", color: 0x8020A0, img: "icons/svg/eye.svg" },
  life:   { label: "Life",   color: 0x2FBF4F, img: "icons/svg/heal.svg" },
  death:  { label: "Death",  color: 0x50506A, img: "icons/svg/skull.svg" },
  magic:  { label: "Magic",  color: 0x3399FF, img: "icons/svg/explosion.svg" }
};

/** Area shapes. @type {Record<string, string>} */
CONFIG.areaShapes = {
  cone: "Cone",
  line: "Line",
  cube: "Cube"
};

/**
 * Parse an extraordinary Area property value ("shape:size", e.g. "cone:15" or
 * "line:2") into an action-style area definition { targets:"area",
 * area:{shape,length,lines} }. The size is a length in feet for cone/cube, or a
 * line count for line. Returns null when the value is empty/invalid.
 * @param {string} value
 * @returns {{shape: string, length: number, lines: number}|null}
 */
CONFIG.parseItemArea = function(value) {
  const [shape, sizeRaw] = String(value ?? "").split(":");
  if ( !shape || !(shape in CONFIG.areaShapes) ) return null;
  const size = Math.max(0, Math.floor(Number(sizeRaw) || 0));
  if ( shape === "line" ) return { shape, length: 0, lines: Math.max(1, size) };
  if ( !size ) return null;
  return { shape, length: size, lines: 1 };
};

/**
 * Resolve an item's EXTRAORDINARY Area property (structured "shape:size") into an
 * action-style area { shape, length, lines }, for ANY item type (weapon, armor,
 * gear). Unlike {@link CONFIG.weaponAreaDefinition} this doesn't read a weapon's
 * built-in Area property — only the extraordinary grant — so a gear/armor item
 * with an Area property produces an area action too. Returns null when the item
 * carries no extraordinary Area property.
 * @param {Item} item
 * @returns {{shape: string, length: number, lines: number}|null}
 */
CONFIG.extraordinaryAreaDefinition = function(item) {
  const prop = (item?.system?.extraordinaryProperties ?? []).find(p => p.name === "area");
  return prop?.value ? CONFIG.parseItemArea(prop.value) : null;
};

/**
 * Whether an item-invoked boon auto-succeeds via the extraordinary Reliable
 * property (SRD: *"The wielder does not have to roll to invoke this item's listed
 * boons if they are targeting a single creature. The invocation automatically
 * succeeds. If the item also has the area property, it may still benefit from the
 * automatic success…"*). True when the source item has Reliable AND the invocation
 * targets a single creature — OR targets an area and the item also has the Area
 * property. Multi-target (non-area) invocations do NOT auto-succeed.
 * @param {Item} item          The source extraordinary item (invokeFromItemId).
 * @param {string} targets     The action's targets mode ("single"/"area"/…).
 * @returns {boolean}
 */
CONFIG.reliableAutoSuccess = function(item, targets) {
  const props = item?.system?.extraordinaryProperties ?? [];
  if ( !props.some(p => p.name === "reliable") ) return false;
  if ( targets === "single" ) return true;
  if ( targets === "area" ) return props.some(p => p.name === "area");
  return false;
};

/**
 * Expend one use of a consumable/expendable item: a stack (quantity > 1)
 * decrements by one; a single item is deleted. Gated by a world setting — when
 * off, the item/stack is kept intact (returns a "kept" outcome without
 * mutating). Shared by the inventory Consume button and the Augmenting-item
 * roll path (both gated by "Delete Consumed Items", the default) and the
 * Expendable Use button (gated by "Expend Used Expendable Items").
 * @param {Item} item
 * @param {object} [options]
 * @param {string} [options.setting]  The gating world-setting key.
 * @returns {Promise<"deleted"|"decremented"|"kept">}
 */
CONFIG.expendItem = async function(item, { setting = "deleteConsumedItems" } = {}) {
  if ( !item ) return "kept";
  if ( !game.settings.get("tomucatos-open-legend-rpg-system", setting) ) return "kept";
  const qty = Math.max(1, Math.floor(Number(item.system?.quantity) || 1));
  if ( qty > 1 ) {
    await item.update({ "system.quantity": qty - 1 });
    return "decremented";
  }
  await item.delete();
  return "deleted";
};

/**
 * The actor's augmenting items available to augment a damaging attack: extraordinary
 * items carrying the Augmenting property that list at least one invocable bane
 * (a name + power level > 0). Each option carries the item id/name and its banes.
 * @param {Actor} actor
 * @returns {Array<{itemId: string, itemName: string, banes: Array<{name: string, powerLevel: number}>}>}
 */
CONFIG.augmentOptionsFor = function(actor) {
  const out = [];
  for ( const item of (actor?.items ?? []) ) {
    if ( !(item.system?.extraordinaryProperties ?? []).some(p => p.name === "augmenting") ) continue;
    const banes = (item.system?.extraordinaryBanes ?? [])
      .filter(b => b?.name && (Number(b.powerLevel) > 0))
      .map(b => ({ name: b.name, powerLevel: Math.max(0, Math.floor(Number(b.powerLevel) || 0)) }));
    if ( banes.length ) out.push({ itemId: item.id, itemName: item.name, banes });
  }
  return out;
};

/**
 * ALL of an item's extraordinary Area definitions (an item may list several Area
 * properties — "If an item has multiple area sizes, the attacker chooses from them
 * with each attack"). Returns a deduped array of { shape, length, lines }, empty
 * when the item has no valid Area property.
 * @param {Item} item
 * @returns {Array<{shape: string, length: number, lines: number}>}
 */
CONFIG.extraordinaryAreaDefinitions = function(item) {
  const seen = new Set();
  const out = [];
  for ( const prop of (item?.system?.extraordinaryProperties ?? []) ) {
    if ( prop?.name !== "area" || !prop.value ) continue;
    const a = CONFIG.parseItemArea(prop.value);
    if ( !a ) continue;
    const key = `${a.shape}:${a.length}:${a.lines}`;
    if ( seen.has(key) ) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
};

/** A human label for an action-style area definition, e.g. "Cone 15'", "Cube 10'",
 *  "Line ×2". */
CONFIG.areaDefinitionLabel = function(area) {
  if ( !area ) return "";
  const shape = CONFIG.areaShapes?.[area.shape] ?? area.shape;
  if ( area.shape === "line" ) return `${shape} ×${Math.max(1, Number(area.lines) || 1)}`;
  return `${shape} ${Math.max(0, Number(area.length) || 0)}'`;
};

/**
 * Resolve the Area an item's generated action should use. When the item lists a
 * SINGLE area, returns it; when it lists SEVERAL, prompts the user to choose one
 * (SRD: the attacker chooses from the item's area sizes). Returns null when the
 * item has no area (leave the action single-target) or the prompt is cancelled.
 * Weapons also honor their built-in Area weapon property via
 * {@link CONFIG.weaponAreaDefinition}; only the extraordinary Area grants can be
 * multiple, so the picker is offered for those.
 * @param {Item} item
 * @returns {Promise<{shape: string, length: number, lines: number}|null>}
 */
CONFIG.pickItemArea = async function(item) {
  const xtra = CONFIG.extraordinaryAreaDefinitions(item);
  // No extraordinary areas: fall back to the single weapon/extraordinary resolver
  // (a weapon may still have a built-in Area property).
  if ( xtra.length === 0 ) {
    return (item?.type === "weapon")
      ? (CONFIG.weaponAreaDefinition?.(item) ?? null)
      : null;
  }
  if ( xtra.length === 1 ) return xtra[0];

  // Multiple extraordinary areas → let the user pick one.
  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
  const { DialogV2 } = foundry.applications.api;
  const rows = xtra.map((a, i) =>
    `<label class="ol-gen-row"><input type="radio" name="areaPick" value="${i}" ${i === 0 ? "checked" : ""}/> <i class="fas fa-draw-polygon"></i> ${esc(CONFIG.areaDefinitionLabel(a))}</label>`
  ).join("");
  const idx = await DialogV2.wait({
    window: { title: "Choose Area" },
    classes: ["openlegend"],
    content: `<div class="ol-generate-action"><p>${esc(item?.name ?? "This item")} lists multiple areas — choose one for this action:</p>${rows}</div>`,
    rejectClose: false,
    buttons: [
      { action: "ok", label: "Use Area", icon: "fas fa-check", default: true,
        callback: (ev, button, dialog) => dialog.element.querySelector('input[name="areaPick"]:checked')?.value ?? "" },
      { action: "cancel", label: "Cancel", icon: "fas fa-times" }
    ]
  });
  if ( (idx === "cancel") || (idx === null) || (idx === undefined) || (idx === "") ) return null;
  return xtra[Number(idx)] ?? null;
};

/**
 * The range band key (close/short/medium/long/extreme) whose feet best matches a
 * range increment, defaulting to "close". Used to map a weapon's derived range
 * increment to an action's range band.
 * @param {number} increment  Range increment in feet.
 * @returns {string}  A key of CONFIG.rangeBands.
 */
CONFIG.rangeBandForIncrement = function(increment) {
  const inc = Math.max(0, Number(increment) || 0);
  let best = "close";
  let bestDiff = Infinity;
  for ( const [key, band] of Object.entries(CONFIG.rangeBands) ) {
    const diff = Math.abs((band.feet ?? 0) - inc);
    if ( diff < bestDiff ) { bestDiff = diff; best = key; }
  }
  return best;
};

/**
 * Resolve a weapon's area (for generating an area action) from EITHER source: its
 * built-in Area weapon property (free-text detail like "10' cone" / "2 line") or
 * an Extraordinary Area property ("cone:15"). Returns an action-style area
 * { shape, length, lines } or null when the weapon has no area.
 * @param {Item} weapon
 * @returns {{shape: string, length: number, lines: number}|null}
 */
CONFIG.weaponAreaDefinition = function(weapon) {
  if ( weapon?.type !== "weapon" ) return null;
  // Extraordinary Area property (structured "shape:size") takes priority.
  const xtra = (weapon.system?.extraordinaryProperties ?? []).find(p => p.name === "area");
  if ( xtra?.value ) {
    const a = CONFIG.parseItemArea(xtra.value);
    if ( a ) return a;
  }
  // Built-in Area weapon property (free-text detail, e.g. "10' cone", "2 line").
  const prop = (weapon.system?.properties ?? []).find(p => p.key === "area");
  if ( !prop ) return null;
  const text = String(prop.detail ?? "").toLowerCase();
  const shape = ["cone", "line", "cube"].find(s => text.includes(s));
  if ( !shape ) return null;
  const size = Math.max(0, Math.floor(Number((text.match(/\d+/) ?? [])[0]) || 0));
  if ( shape === "line" ) return { shape, length: 0, lines: Math.max(1, size) };
  return { shape, length: size || 5, lines: 1 };
};

/**
 * Build the data for a Damaging action generated from a weapon (Weapons &
 * Implements): attribute from its Forceful/Precise/Versatile properties
 * (versatile / both → the wielder's higher of Agility/Might, ties to Agility),
 * grip + range from its hands and categories, area from its Area property (no
 * multi-target disadvantage thanks to the weapon link), damage type
 * force/precision to match the attribute, single target unless area.
 * @param {Item} weapon
 * @param {Actor} actor
 * @param {{area?: {shape: string, length: number, lines: number}|null}} [opts]
 *   `area` overrides the weapon's resolved area (used when the caller already
 *   prompted the user among several extraordinary Area sizes). Pass `null` to
 *   force single-target; omit to auto-resolve the weapon's (first) area.
 * @returns {object}  Item creation data ({name, type, img, system}).
 */
CONFIG.buildWeaponDamagingAction = function(weapon, actor, opts = {}) {
  const cats = weapon.system.categories ?? [];
  const props = weapon.system.properties ?? [];
  const has = k => props.some(p => p.key === k);
  const score = k => Number(actor.system.attributes?.[k]?.value ?? 0);
  const bigger = () => (score("might") > score("agility") ? "might" : "agility"); // tie → agility

  // Attribute: Precise → Agility, Forceful → Might, both/versatile → bigger.
  let attribute = "agility";
  const versatile = WEAPON.weaponHandsFor(cats) === "versatile" || cats.includes("versatile-melee");
  if ( has("precise") && has("forceful") ) attribute = bigger();
  else if ( has("forceful") ) attribute = "might";
  else if ( has("precise") ) attribute = "agility";
  else if ( versatile ) attribute = bigger();

  const sys = {
    actionCategory: "damaging",
    attribute,
    weaponId: weapon.id,
    damageType: attribute === "might" ? "force" : "precision",   // force(Might)/precision(Agility)
    targetDefense: "guard"
  };

  // Range: melee weapons → melee; ranged → the band matching the increment.
  const increment = WEAPON.rangeIncrementFor(cats);
  if ( increment > 0 ) {
    sys.rangeMode = "ranged";
    sys.rangeBand = CONFIG.rangeBandForIncrement(increment);
  } else {
    sys.rangeMode = "melee";
  }

  // Grip: two-handed when the weapon needs two hands (or is an equipped versatile
  // held in two), else one-handed.
  const hands = WEAPON.weaponHandsFor(cats);
  if ( hands === 2 ) sys.grip = "two-handed";
  else if ( (hands === "versatile") && weapon.system.equipped && (Number(weapon.system.equipHands) === 2) ) sys.grip = "two-handed";
  else sys.grip = "one-handed";

  // Area: if the weapon lists one, make this an area attack (single otherwise). A
  // caller that already resolved the area (e.g. after prompting among several
  // extraordinary Area sizes) passes it in `opts.area`; `undefined` auto-resolves.
  const area = ("area" in opts) ? opts.area : CONFIG.weaponAreaDefinition(weapon);
  if ( area ) {
    sys.targets = "area";
    sys.area = { shape: area.shape, length: area.length, lines: area.lines };
  } else {
    sys.targets = "single";
  }

  return { name: `${weapon.name} Strike`, type: "action", img: weapon.img, system: sys };
};

/**
 * Build the data for a Bane action generated from a weapon, for a chosen listed
 * bane: reuses the damaging build's attribute/grip/range/area, then sets the bane
 * (target defense + minimum power level read from the resolved bane doc; falls
 * back to Guard / PL 1). The weapon is pre-linked (weapon-bane synergy applies).
 * @param {Item} weapon
 * @param {Actor} actor
 * @param {{name: string, uuid?: string}} bane
 * @param {{area?: {shape: string, length: number, lines: number}|null}} [opts]
 *   `area` overrides the weapon's resolved area (see buildWeaponDamagingAction).
 * @returns {Promise<object|null>}  Item creation data, or null if no bane.
 */
CONFIG.buildWeaponBaneAction = async function(weapon, actor, bane, opts = {}) {
  if ( !bane?.name ) return null;
  // Resolve to the SAME document the bane picker lists (the system banes pack) so
  // the action's baneUuid matches an option and is pre-selected. The weapon's own
  // bane uuid may be stale/embedded and won't match the picker, so prefer name.
  const doc = await BANE.resolveBaneByName(bane.name);

  const base = CONFIG.buildWeaponDamagingAction(weapon, actor, opts).system;
  const attacks = doc?.system?.attacks ?? [];
  const defense = (attacks[0]?.defense ?? "guard").toLowerCase();

  // Power level: the HIGHEST discrete level this bane defines that the wielder can
  // reach — capped by their score in the wielding attribute, +1 because a weapon's
  // listed bane meets prerequisites one power level lower. Falls back to the bane's
  // minimum (or 1) when nothing is reachable / no levels are defined.
  const levels = [...new Set(
    (doc?.system?.powerEffects ?? []).map(pe => Number(pe.powerLevel)).filter(n => Number.isFinite(n) && (n > 0))
  )].sort((a, b) => a - b);
  const minPl = Math.max(1, Math.floor(Number(doc?.system?.powerLevel) || (levels[0] ?? 1)));
  const score = Number(actor.system?.attributes?.[base.attribute]?.value ?? 0);
  const cap = score + 1;   // weapon-listed bane: prerequisite met one PL lower
  const reachable = levels.filter(pl => pl <= cap);
  const powerLevel = reachable.length ? reachable[reachable.length - 1]
    : (levels.length ? levels[0] : minPl);

  // A bane delivered by a weapon with the Extraordinary Potent property is potent
  // (target resists at disadvantage 1) — preselect the checkbox.
  const potent = (weapon.system?.extraordinaryProperties ?? []).some(p => p.name === "potent");

  const sys = {
    actionCategory: "bane",
    attribute: base.attribute,
    weaponId: weapon.id,
    grip: base.grip,
    rangeMode: base.rangeMode,
    rangeBand: base.rangeBand ?? "close",
    targets: base.targets,
    area: base.area ?? { shape: "cone", length: 10, lines: 1 },
    targetDefense: defense,
    baneUuid: doc?.uuid ?? bane.uuid ?? "",
    baneName: doc?.name ?? bane.name,
    invokePowerLevel: powerLevel,
    potent
  };
  return { name: `${weapon.name} ${bane.name}`, type: "action", img: weapon.img, system: sys };
};

/** A weapon's Defensive value (1-3) from its built-in Defensive property, or 0. */
CONFIG.weaponDefensiveValue = function(weapon) {
  const prop = (weapon?.system?.properties ?? []).find(p => p.key === "defensive");
  return prop ? Math.max(1, Math.min(3, Math.floor(Number(prop.value ?? 1)))) : 0;
};

/**
 * The EFFECTIVE Defensive value of a weapon when WIELDED by `actor` — its listed
 * value, plus 1 if the actor owns Defensive Mastery (1→2, 2→3), still capped at the
 * book max of 3. This is the advantage the weapon grants on a defend roll. Returns
 * 0 if the weapon has no Defensive property.
 * @param {Item} weapon
 * @param {Actor|null} [actor]
 * @returns {number}
 */
CONFIG.effectiveDefensiveValue = function(weapon, actor = null) {
  const base = CONFIG.weaponDefensiveValue(weapon);
  if ( !base ) return 0;
  const bonus = (actor && FEATS.hasDefensiveMastery(actor)) ? 1 : 0;
  return Math.max(1, Math.min(3, base + bonus));
};

/**
 * Build the data for a Defend INTERRUPT action generated from a Defensive weapon:
 * the weapon is pre-linked (its Defensive value grants advantage on the defend
 * roll), and the defend rolls with the wielder's higher of Agility/Might (ties to
 * Agility). Only meaningful for a weapon with the Defensive property.
 * @param {Item} weapon
 * @param {Actor} actor
 * @returns {object|null}  Item creation data, or null if the weapon isn't Defensive.
 */
CONFIG.buildWeaponDefendAction = function(weapon, actor) {
  if ( !CONFIG.weaponDefensiveValue(weapon) ) return null;
  const score = k => Number(actor.system?.attributes?.[k]?.value ?? 0);
  const attribute = score("might") > score("agility") ? "might" : "agility"; // tie → agility
  const sys = {
    actionCategory: "interrupt",
    interruptType: "defend",
    actionType: "interrupt",
    attribute,
    weaponId: weapon.id
  };
  return { name: `${weapon.name} Defend`, type: "action", img: weapon.img, system: sys };
};

/**
 * Build the data for a Bane action generated from an EXTRAORDINARY ITEM's listed
 * bane (weapon/armor/gear). The item's granted VALUE supplies the dice + caps the
 * invoke power level (the item-invocation roll path), so the action is preset to
 * an item invocation — exactly as if the bane were picked from the action sheet's
 * "✨ … — <Item>" option. The action's attribute is set to the bane's first
 * attacking attribute (informational; the roll uses the item value, not it).
 * When the source item is a WEAPON, the weapon is pre-linked (weaponId) and the
 * grip/range derived from it, so the weapon picker also shows it selected.
 * @param {Item} item                            The source extraordinary item.
 * @param {Actor} actor                          The owning actor.
 * @param {{name: string, powerLevel: number}} grant  The extraordinaryBanes row.
 * @returns {Promise<object|null>}  Item creation data, or null if invalid.
 */
CONFIG.buildExtraordinaryBaneAction = async function(item, actor, grant) {
  const name = grant?.name;
  const value = Math.max(0, Math.floor(Number(grant?.powerLevel) || 0));
  if ( !name || (value <= 0) ) return null;
  const doc = await BANE.resolveBaneByName(name);

  const attacks = doc?.system?.attacks ?? [];
  const defense = (attacks[0]?.defense ?? "guard").toLowerCase();
  // Attribute: the bane's first attacking attribute, mapped from its label to a
  // key (banes store labels like "Entropy"); default to the first attack's, else
  // a sensible fallback. It's only informational for an item invocation.
  const attrLabelToKey = {};
  for ( const [k, lbl] of Object.entries(STATS.attributeLabels ?? {}) ) attrLabelToKey[String(lbl).toLowerCase()] = k;
  const firstAttrLabel = String(attacks[0]?.attackingAttribute ?? "").toLowerCase();
  const attribute = attrLabelToKey[firstAttrLabel] ?? "will";

  // A bane delivered by an item with the Extraordinary Potent property is potent.
  const potent = (item.system?.extraordinaryProperties ?? []).some(p => p.name === "potent");

  const sys = {
    actionCategory: "bane",
    attribute,
    targets: "single",
    targetDefense: defense,
    baneUuid: doc?.uuid ?? "",
    baneName: doc?.name ?? name,
    invokeFromItemId: item.id,
    invokeItemScore: value,
    invokePowerLevel: value,            // item invocation rolls at the listed value
    potent
  };

  // Weapon source: pre-link the weapon (so the weapon picker selects it) and
  // derive grip + range from it, like a generated weapon attack. Non-weapon
  // sources leave the weapon unset and default to melee/single.
  if ( item.type === "weapon" ) {
    sys.weaponId = item.id;
    const cats = item.system?.categories ?? [];
    const hands = WEAPON.weaponHandsFor(cats);
    if ( hands === 2 ) sys.grip = "two-handed";
    else if ( (hands === "versatile") && item.system?.equipped && (Number(item.system?.equipHands) === 2) ) sys.grip = "two-handed";
    else sys.grip = "one-handed";
    const increment = WEAPON.rangeIncrementFor(cats);
    if ( increment > 0 ) {
      sys.rangeMode = "ranged";
      sys.rangeBand = CONFIG.rangeBandForIncrement(increment);
    } else {
      sys.rangeMode = "melee";
    }
  }

  // Area: an item with an Area property makes this an area bane attack, for ANY
  // item type. A caller that already resolved the area (prompting when the item
  // lists several) passes it in `grant.area` (may be null → single-target); when
  // absent, auto-resolve here (pickItemArea prompts on multiple areas).
  const area = (grant && ("area" in grant)) ? grant.area : await CONFIG.pickItemArea(item);
  if ( area ) {
    sys.targets = "area";
    sys.area = { shape: area.shape, length: area.length, lines: area.lines };
  }

  return { name: `${item.name}: ${sys.baneName}`, type: "action", img: item.img, system: sys };
};

/**
 * Resolve + PL-clamp an extraordinary Aura grant's radiated bane/boon. The SRD
 * caps the radiated invocation at HALF the aura's power level: keep only the
 * radiated document's defined levels within that cap and clamp the stored level
 * into them (the highest ≤ stored, else the lowest). Returns null when no pick
 * is stored, the document can't be resolved, or no level fits the cap.
 * @param {{auraRadiateKind?: string, auraRadiateUuid?: string, auraRadiateName?: string,
 *   auraRadiatePowerLevel?: number, auraRadiateResistanceType?: string}} grant
 *   The extraordinaryBoons Aura row.
 * @param {number} auraPl  The aura's power level (the row's grant value).
 * @returns {Promise<{kind: string, uuid: string, name: string, powerLevel: number,
 *   resistanceType: string, doc: Item}|null>}
 */
CONFIG.resolveAuraRadiateGrant = async function(grant, auraPl) {
  if ( !grant?.auraRadiateUuid ) return null;
  const radiated = await fromUuid(grant.auraRadiateUuid).catch(() => null);
  if ( !radiated ) return null;
  const cap = Math.floor(Math.max(0, Math.floor(Number(auraPl) || 0)) / 2);
  let levels = [...new Set((radiated.system?.powerEffects ?? [])
    .map(pe => Number(pe?.powerLevel)).filter(n => Number.isFinite(n) && (n > 0)))].sort((a, b) => a - b);
  if ( !levels.length ) {
    const min = Math.max(0, Math.floor(Number(radiated.system?.powerLevel) || 0));
    if ( min > 0 ) levels = [min];
  }
  const usable = levels.filter(l => l <= cap);
  if ( !usable.length ) return null;
  const want = Math.max(0, Math.floor(Number(grant.auraRadiatePowerLevel) || 0));
  return {
    kind: (grant.auraRadiateKind === "bane") ? "bane" : "boon",
    uuid: grant.auraRadiateUuid,
    name: grant.auraRadiateName || radiated.name,
    powerLevel: usable.filter(l => l <= want).pop() ?? usable[0],
    resistanceType: grant.auraRadiateResistanceType ?? "",
    doc: radiated
  };
};

/**
 * Build the data for a Boon action generated from an EXTRAORDINARY ITEM's listed
 * boon. Mirrors {@link CONFIG.buildExtraordinaryBaneAction}: the item's value
 * supplies the dice + caps the invoke level, so the action is preset to an item
 * invocation. Boons have no target defense (they beat a Challenge Rating). The
 * attribute is set to the boon's first invoking attribute (informational).
 * @param {Item} item
 * @param {Actor} actor
 * @param {{name: string, powerLevel: number}} grant  The extraordinaryBoons row.
 * @returns {Promise<object|null>}  Item creation data, or null if invalid.
 */
CONFIG.buildExtraordinaryBoonAction = async function(item, actor, grant) {
  const name = grant?.name;
  const value = Math.max(0, Math.floor(Number(grant?.powerLevel) || 0));
  if ( !name || (value <= 0) ) return null;
  const doc = await BOON.resolveBoonByName(name);

  // Attribute: the boon's first invoking attribute (boons store capitalized
  // labels in system.attributes); map to a key. Default to "will".
  const attrLabelToKey = {};
  for ( const [k, lbl] of Object.entries(STATS.attributeLabels ?? {}) ) attrLabelToKey[String(lbl).toLowerCase()] = k;
  const firstAttrLabel = String((doc?.system?.attributes ?? [])[0] ?? "").toLowerCase();
  const attribute = attrLabelToKey[firstAttrLabel] ?? "will";

  const sys = {
    actionCategory: "boon",
    attribute,
    targets: "single",
    boonUuid: doc?.uuid ?? "",
    boonName: doc?.name ?? name,
    invokeFromItemId: item.id,
    invokeItemScore: value,
    invokePowerLevel: value             // item invocation rolls at the listed value
  };

  // Aura: the row's radiated bane/boon (picked on the item sheet) rides into the
  // action so a successful grant carries it to the live-aura engine
  // (flags.openlegend.aura). resolveAuraRadiateGrant enforces the SRD half-PL cap.
  if ( (String(sys.boonName).trim().toLowerCase() === "aura") && grant?.auraRadiateUuid ) {
    const rad = await CONFIG.resolveAuraRadiateGrant(grant, value);
    if ( rad ) {
      sys.auraRadiateKind = rad.kind;
      sys.auraRadiateUuid = rad.uuid;
      sys.auraRadiateName = rad.name;
      sys.auraRadiatePowerLevel = rad.powerLevel;
      sys.auraRadiateResistanceType = rad.resistanceType;
      // Prefer an invoking attribute BOTH the Aura and the radiated invocation
      // share, so the generated action's own Aura picker (filtered by the
      // action's single attribute) lists the chosen pick.
      const radAttrs = (rad.kind === "bane")
        ? (rad.doc.system?.attacks ?? []).map(a => String(a?.attackingAttribute ?? "").toLowerCase())
        : (rad.doc.system?.attributes ?? []).map(a => String(a).toLowerCase());
      const auraAttrs = (doc?.system?.attributes ?? []).map(a => String(a).toLowerCase());
      const shared = auraAttrs.find(a => radAttrs.includes(a));
      if ( shared && attrLabelToKey[shared] ) sys.attribute = attrLabelToKey[shared];
    }
  }

  // Area: an item with an Area property makes this an area boon invocation, for
  // ANY item type. A caller may pass the resolved area in `grant.area` (may be
  // null → single-target); when absent, auto-resolve here (pickItemArea prompts
  // on multiple areas).
  const area = (grant && ("area" in grant)) ? grant.area : await CONFIG.pickItemArea(item);
  if ( area ) {
    sys.targets = "area";
    sys.area = { shape: area.shape, length: area.length, lines: area.lines };
  }

  return { name: `${item.name}: ${sys.boonName}`, type: "action", img: item.img, system: sys };
};

/**
 * Disadvantage incurred by multi-targeting / area attacks, per the Open Legend
 * multi-targeting rules. This is a derived dice modifier, separate from an
 * action's manually-entered disadvantage.
 *
 *   - single:   0
 *   - multiple: disadvantage = number of foes targeted (melee & ranged alike)
 *   - area cube/cone: 1 per 5' of length; a single 5' cube/cone incurs none
 *                     (10' = 2, 15' = 3, …)
 *   - area line:      1 per line
 *
 * @param {object} sys  An action's system data (targets, targetCount, area{shape,length,lines}).
 * @returns {number}    The disadvantage (>= 0).
 */
/**
 * Convert an action's area definition into a v14 Region SHAPE descriptor (sans
 * position/rotation, which are supplied at placement time). Returns null when
 * the action is not an area attack or the shape is unknown.
 *
 * Distances are in GAME UNITS (feet); the placer multiplies by the grid's
 * distance-pixels and sets `gridBased: true` so the shape follows the scene's
 * grid metric. MeasuredTemplate was deprecated in Foundry v14 (merged into the
 * Region document), so area attacks now place native Region shapes:
 *
 *   - cone → {type:"steppedCone", radius = length} (OL grid-square stepped cone)
 *   - cube → {type:"rectangle", width = height = side} (a side·side square)
 *   - line → {type:"line", length = 10', width = 5', lines = N} — placed as a
 *     CHAIN of N separate 5'×10' segments, each touching a corner of a placed
 *     one (see previewChainedLines in template-preview.mjs)
 *
 * @param {object} sys  An action's system data.
 * @returns {{type: string, distance?: number, radius?: number, length?: number,
 *   width?: number, height?: number, angle?: number, curvature?: string}|null}
 *   A shape descriptor in game units (feet).
 */
CONFIG.areaTemplateData = function(sys = {}) {
  if ( sys.targets !== "area" ) return null;
  const shape = sys.area?.shape;
  if ( shape === "cone" ) {
    const distance = Math.max(0, Number(sys.area?.length ?? 0));
    if ( !distance ) return null;
    // Open Legend's stepped, grid-square cone: row 1 is a single square (the tip,
    // nearest the caster); each 5' further out adds a row that is one square wider,
    // the new square alternating sides (right, left, right, …). Built as a polygon
    // Region shape (see steppedConePolygon in template-preview.mjs), not Foundry's
    // native wedge cone.
    return { type: "steppedCone", radius: distance };
  }
  if ( shape === "cube" ) {
    const side = Math.max(0, Number(sys.area?.length ?? 0));
    if ( !side ) return null;
    // A cube is a side·side square; Region rectangles take width/height directly
    // (no √2 diagonal fudge — that was a MeasuredTemplate quirk).
    return { type: "rectangle", width: side, height: side };
  }
  if ( shape === "line" ) {
    // Each line is a SEPARATE 5' wide × 10' long segment (the 10' height is
    // irrelevant in 2D). Per the SRD, several lines chain corner-to-corner:
    // the placement flow places them one at a time and enforces that every
    // additional line touches a corner of an already-placed one.
    const lines = Math.max(1, Math.floor(Number(sys.area?.lines ?? 1)));
    return { type: "line", length: 10, width: 5, lines };
  }
  return null;
};

/**
 * The compendium base name of the Multi-Target Attack Specialist feat (multi-take,
 * maxTier 5, one mode — Area / Ranged / Melee — per copy). Each tier reduces the
 * multi-targeting disadvantage for the chosen mode by 1. Per the Special rule, the
 * tier is tracked separately per mode (separate feat copies), so a given attack's
 * reduction is the tier of the copy whose mode matches that attack.
 * @type {string}
 */
CONFIG.MULTI_TARGET_ATTACK_SPEC_BASE = "Multi-Target Attack Specialist (I - V)";

/**
 * The attack mode of an action for Multi-Target Attack Specialist matching:
 * "area" when it targets an area; otherwise "melee" or "ranged" from its range mode
 * (non-physical attacks count as ranged). Returns "" for non-multi single attacks.
 * @param {object} sys  The action's system data.
 * @returns {"area"|"melee"|"ranged"|""}
 */
CONFIG.attackTargetMode = function(sys = {}) {
  if ( sys.targets === "area" ) return "area";
  if ( sys.rangeMode === "melee" ) return "melee";
  if ( (sys.rangeMode === "ranged") || (sys.rangeMode === "non-physical") ) return "ranged";
  return "";
};

/**
 * The Multi-Target Attack Specialist reduction to an attack's multi-targeting
 * disadvantage: the summed purchased tier of every owned copy whose chosen mode
 * (Area / Ranged / Melee) matches THIS attack's mode. 0 when the feat isn't owned
 * or no copy matches.
 * @param {Actor} actor
 * @param {object} sys  The action's system data.
 * @returns {number}
 */
CONFIG.multiTargetAttackReduction = function(actor, sys = {}) {
  const base = CONFIG.MULTI_TARGET_ATTACK_SPEC_BASE;
  const mode = CONFIG.attackTargetMode(sys);
  if ( !mode ) return 0;
  let tiers = 0;
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    if ( String(feat.system?.choice?.value ?? "").trim().toLowerCase() !== mode ) continue;
    tiers += Math.max(1, Math.floor(Number(feat.system?.purchasedTier) || 1));
  }
  return tiers;
};

/**
 * The compendium base name of the Multi-Target Boon Specialist feat (single take,
 * maxTier 9). Each tier reduces the multi-targeting disadvantage for invoking boons
 * by 1.
 * @type {string}
 */
CONFIG.MULTI_TARGET_BOON_SPEC_BASE = "Multi-Target Boon Specialist (I - IX)";

/**
 * The Multi-Target Boon Specialist reduction to a boon invocation's multi-targeting
 * disadvantage: the owned feat's purchased tier (1 per tier), or 0 if not owned.
 * @param {Actor} actor
 * @returns {number}
 */
CONFIG.multiTargetBoonReduction = function(actor) {
  const base = CONFIG.MULTI_TARGET_BOON_SPEC_BASE;
  let tiers = 0;
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    tiers += Math.max(1, Math.floor(Number(feat.system?.purchasedTier) || 1));
  }
  return tiers;
};

/**
 * The compendium base name of the Multi-Target Boon Expert feat (single take). When
 * multi-targeting a boon the actor has Boon Focus for, AND the multi-targeting
 * disadvantage is COMPLETELY negated by Multi-Target Boon Specialist, the invocation
 * auto-succeeds (no action roll). Requires {@link CONFIG.boonFocus} for the boon.
 * @type {string}
 */
CONFIG.MULTI_TARGET_BOON_EXPERT_BASE = "Multi-Target Boon Expert";

/**
 * Whether the actor owns Multi-Target Boon Expert.
 * @param {Actor} actor
 * @returns {boolean}
 */
CONFIG.hasMultiTargetBoonExpert = function(actor) {
  const base = CONFIG.MULTI_TARGET_BOON_EXPERT_BASE;
  return (actor?.items ?? []).some(f =>
    (f.type === "feat") && ((f.system?.baseName || f.name) === base));
};

CONFIG.multiTargetDisadvantage = function(sys = {}) {
  const targets = sys.targets ?? "single";
  if ( targets === "multiple" ) {
    const n = Math.max(0, Math.floor(Number(sys.targetCount ?? 0)));
    // Disadvantage equals the number of foes targeted; a single target is none.
    return n > 1 ? n : 0;
  }
  if ( targets === "summon" ) {
    // Summon Creature's special multi-targeting: one invocation may summon
    // several creatures — disadvantage 2 PER CREATURE BEYOND THE FIRST (one
    // creature: none). Counts as multi-targeting, so Multi-Target Boon
    // Specialist offsets it as normal.
    const n = Math.max(1, Math.floor(Number(sys.summonCount ?? 1)));
    return (n - 1) * 2;
  }
  if ( targets === "area" ) {
    const shape = sys.area?.shape;
    if ( shape === "line" ) {
      return Math.max(0, Math.floor(Number(sys.area?.lines ?? 0)));
    }
    if ( (shape === "cube") || (shape === "cone") ) {
      const length = Math.max(0, Math.floor(Number(sys.area?.length ?? 0)));
      // 1 per 5'; a single 5' length incurs no disadvantage.
      return length > 5 ? Math.floor(length / 5) : 0;
    }
  }
  return 0;
};

/**
 * Non-physical range (feet) derived from an attribute score, per the table:
 *   score 1-3 -> 25', 4-6 -> 50', 7-9 -> 75'. Score 0 (or below 1) -> 0.
 * @param {number} score
 * @returns {number}
 */
CONFIG.nonPhysicalRange = function(score) {
  const s = Math.max(0, Math.floor(Number(score ?? 0)));
  if ( s <= 0 ) return 0;
  if ( s <= 3 ) return 25;
  if ( s <= 6 ) return 50;
  return 75;
};

/* -------------------------------------------- */
/*  Extraordinary Items (Special Equipment)     */
/* -------------------------------------------- */

/**
 * Extraordinary-item PROPERTIES (Open Legend SRD special-equipment properties).
 * A property's value control is, in priority order: `ranks` → a numeric select
 * of those values; `choices` → a select of those {value: label} pairs; `area` →
 * a shape+size area editor (value stored as "shape:size", e.g. "cone:15"); `text`
 * → a free-text area (e.g. Special); otherwise none (a flag property). `hint` is
 * shown on the sheet.
 * @type {Record<string, {label: string, ranks?: number[], choices?: Record<string,string>, area?: boolean, text?: boolean, hint: string}>}
 */
CONFIG.itemProperties = {
  area:        { label: "Area",        area: true,             hint: "An item with the area property always makes multi-target area attacks or invocations of the listed size and shape and cannot be used to make non-area attacks. If an item has multiple area sizes, the attacker chooses from them with each attack. Attack and action rolls do not incur any of the disadvantage penalties usually associated with multi-targeting." },
  damageType:  { label: "Damage (type)", get choices() { return DAMAGE.allDamageTypes(); },
                 hint: "A damaging attack with this item may inflict the listed type instead of its normal one. Apply once." },
  deadly:      { label: "Deadly",      ranks: [1, 2, 3],       hint: "Adds the deadly rank to damage rolls' lethality." },
  powerful:    { label: "Powerful",    ranks: [1, 2, 3],       hint: "Adds +rank to damage dealt." },
  augmenting:  { label: "Augmenting",                          hint: "Banes associated with this item can be delivered via an alternate method, such as a weapon or other damaging attack. Applying the item's augmentation to an attack is a move action which consumes the item. Upon application, you choose a bane the item can invoke. The next attack made with the augmented item triggers that bane if your roll is equal to or above the target's defense score. Examples of the augmenting property include poison, special ammo cartridges, and magical jewels that can be attuned to a weapon to enhance its power. All augmenting items must have the expendable property." },
  autonomous:  { label: "Autonomous",                          hint: "When created, the item's crafter sets a specific condition that causes the item to trigger one particular action. This autonomy could be magical guidance, algorithmic targeting via a guidance system, or even mundane autonomy, such as pressure plates surrounded by murder holes (arrow slits with self-reloading crossbows)." },
  consumable:  { label: "Consumable",                          hint: "A consumable item can be used once to invoke a boon at the listed power level. This boon invocation succeeds automatically without a roll and cannot be invoked with multi-targeting. Afterwards, the item is consumed and cannot be used again." },
  expendable:  { label: "Expendable",                          hint: "An expendable item can be used once to make an attack or invoke a bane. Afterwards, the item is expended and cannot be used again." },
  potent:      { label: "Potent",                              hint: "Targets suffer disadvantage 1 on resist rolls to shake off banes inflicted by this item." },
  cursed:      { label: "Cursed (bane)", bane: true,           hint: "The wielder of this item is automatically afflicted with the indicated bane at the listed power level. The bane cannot be shaken off using the resist bane action. Furthermore, the cursed item cannot be unequipped unless the wielder is subject to the restoration boon at a power level high enough to dispel the bane." },
  baneful:     { label: "Baneful (bane)", bane: true,          hint: "When making a damaging attack with this item, you may automatically inflict a listed bane if your attack roll exceeds the target's defense by 5 or more. The bane can be triggered this way in lieu of other banes, even if the item or wielder cannot access the bane. The invoking attribute for this bane is equal to the attacking attribute." },
  persistent:  { label: "Persistent (boon)", boon: true,       hint: "An item with this property automatically invokes and sustains a single instance of the indicated boon without requiring the wielder to make an invocation roll or use the sustain a boon action. It auto-applies to the wielder at the start of their turn, at the boon's listed power level (respecting boon uniqueness — a higher-level same boon is not overwritten). The wielder does not have to invoke this effect." },
  reliable:    { label: "Reliable",                            hint: "The wielder does not have to roll to invoke this item's listed boons if they are targeting a single creature. The invocation automatically succeeds. If the item also has the area property, it may still benefit from the automatic success granted by the reliable property." },
  sentient:    { label: "Sentient",                            hint: "The item becomes either self-aware or capable of basic human reasoning. It has no inherent bond with its creator, and is treated like any other NPC. It gets its own turn and array of actions. The item gains no mental or social attributes, only the ability to think. At the GM's discretion, it may also gain a particular mode of movement, such as walking, climbing, flying, or swimming." },
  special:     { label: "Special",       text: true,           hint: "The item possesses a unique property that is explained in full detail in its description." },
  limiting:    { label: "Limiting",                            hint: "Imposes a restriction on the wielder." }
};

/* -------------------------------------------- */
/*  Legendary Items                             */
/* -------------------------------------------- */

/**
 * LEGENDARY-item properties (Open Legend SRD). A legendary item may possess any
 * of the extraordinary properties above, plus these. Value kinds mirror
 * {@link CONFIG.itemProperties}: `attrMod` → an attribute + signed amount editor
 * (value stored as "key:amount", e.g. "might:2" / "agility:-1"); `text` → a
 * free-text area; a plain string value (Slaying's creature type) otherwise; no
 * value at all for a flag property (Unfailing).
 * @type {Record<string, {label: string, attrMod?: boolean, text?: boolean, creature?: boolean, hint: string}>}
 */
CONFIG.legendaryProperties = {
  attributeBonus: { label: "Attribute bonus/penalty", attrMod: true, hint: "While wielding the item, the owner's attribute is increased or decreased by the amount indicated. Applied automatically while the item is active (equipped weapon/armor, or owned gear)." },
  intelligent:    { label: "Intelligent",             text: true,    hint: "The item is sentient and possesses its own psyche and personality, including mental and social attributes. It can communicate audibly or telepathically. Describe its attribute scores and communication limits (such as only communicating with the wielder)." },
  unfailing:      { label: "Unfailing",                              hint: "Any dice rolled when using this item's abilities treat a result of 1 as the maximum instead — and the 1 also triggers a dice explosion, just as if the die had rolled its maximum. A 1 on a d8 becomes an 8; a 1 on a d20 becomes a 20." },
  slaying:        { label: "Slaying (creature type)", creature: true, hint: "When the item is used to make a damaging attack against the indicated creature type and exceeds the target's defense by 5 or more, the target immediately dies." }
};

/**
 * Parse a legendary Attribute-bonus/penalty value ("key:amount", e.g. "might:2"
 * or "agility:-1") into { key, amount }. Returns null when the value carries no
 * attribute key or a zero/invalid amount.
 * @param {string} value
 * @returns {{key: string, amount: number}|null}
 */
CONFIG.parseLegendaryAttrMod = function(value) {
  const [key, raw] = String(value ?? "").split(":");
  const amount = Math.trunc(Number(raw));
  if ( !key || !Number.isFinite(amount) || (amount === 0) ) return null;
  return { key, amount };
};

/**
 * Whether an item carries the given legendary property. Presence-only — callers
 * gate on active/equipped themselves where it matters.
 * @param {Item} item
 * @param {string} name  The property key (e.g. "unfailing", "slaying").
 * @returns {object|null}  The property row, or null.
 */
CONFIG.legendaryProperty = function(item, name) {
  return (item?.system?.legendaryProperties ?? []).find(p => p?.name === name) ?? null;
};

/* -------------------------------------------- */
/*  Legend Points                               */
/* -------------------------------------------- */

/**
 * The Legend Point spend context for an actor on a SINGLE action roll, or null when
 * the actor can't spend (NPC/boss — no legend-point pool, or an empty pool). SRD: a
 * PC may spend at most their level + 1 legend points on one roll; each point grants
 * advantage 1 AND a flat +1 to the result.
 * @param {Actor} actor
 * @returns {{available: number, max: number}|null}
 */
CONFIG.legendSpendContext = function(actor) {
  if ( !actor || (actor.type !== "character") ) return null;
  const available = Math.max(0, Math.floor(Number(actor.system?.legendPoint) || 0));
  if ( available <= 0 ) return null;
  const level = Math.max(0, Math.floor(Number(actor.system?.level) || 0));
  return { available, max: level + 1 };
};

/**
 * Deduct `n` spent Legend Points from an actor's pool (floored at 0). No-op for n ≤ 0.
 * @param {Actor} actor
 * @param {number} n
 * @returns {Promise<void>}
 */
CONFIG.spendLegendPoints = async function(actor, n) {
  const spend = Math.max(0, Math.floor(Number(n) || 0));
  if ( !actor || (spend <= 0) ) return;
  const cur = Math.max(0, Math.floor(Number(actor.system?.legendPoint) || 0));
  await actor.update({ "system.legendPoint": Math.max(0, cur - spend) });
};
