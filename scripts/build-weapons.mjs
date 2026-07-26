#!/usr/bin/env node
/**
 * Build the "weapons" compendium pack from the Open Legend Weapons & Implements
 * table. The table is encoded inline; each row's "examples" are mechanically
 * equivalent weapons — every name becomes its own weapon Item document.
 *
 * Categories and properties are mapped to the structured keys defined in
 * module/config.mjs (weaponCategories / weaponProperties). Banes are stored as
 * {name, uuid} references into the openlegend.banes compendium (UUID computed
 * from the same deterministic id the banes builder uses).
 *
 * Writes a ClassicLevel (LevelDB) pack at packs/weapons + _source/weapons JSON.
 * classic-level is imported from the local Foundry install.
 *
 * Usage:  node scripts/build-weapons.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClassicLevel } from "/Users/thomas/repos/FoundryVTT-Node-14.363/node_modules/classic-level/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_ROOT = path.resolve(__dirname, "..");
const PACK = "weapons";
const IMG = "icons/svg/sword.svg";

/** Deterministic 16-char id (shared convention with the other builders). */
function stableId(str) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  // FNV-1a over the whole string → a 32-bit seed influenced by every character,
  // then each of the 16 output chars is a position-salted avalanche of it. The
  // old version derived char i only from str[i], str[i+16], … so names sharing a
  // prefix produced ids sharing a long leading run, which cross-linked embedded
  // effects (keyed !items.effects!<itemId>.<effectId>, loaded by prefix scan).
  let seed = 0x811c9dc5;
  for ( let i = 0; i < str.length; i++ ) {
    seed ^= str.charCodeAt(i);
    seed = Math.imul(seed, 0x01000193) >>> 0;
  }
  const out = [];
  let h = seed;
  for ( let i = 0; i < 16; i++ ) {
    h = (h ^ (i + 1)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0; h = Math.imul(h, 0x2c1b3c6d) >>> 0;
    h = (h ^ (h >>> 12)) >>> 0; h = Math.imul(h, 0x297a2d39) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
    out.push(chars[h % chars.length]);
  }
  return out.join("");
}

/** Map a category label from the table to its config key. */
const CATEGORY_KEY = {
  "Melee": "melee",
  "One-handed Melee": "one-handed-melee",
  "Two-handed Melee": "two-handed-melee",
  "Versatile Melee": "versatile-melee",
  "Close Ranged": "close-ranged",
  "Short Ranged": "short-ranged",
  "Medium Ranged": "medium-ranged",
  "Long Ranged": "long-ranged",
  "Extreme Ranged": "extreme-ranged"
};
const RANGE_INCREMENT = {
  "close-ranged": 25, "short-ranged": 50, "medium-ranged": 75,
  "long-ranged": 125, "extreme-ranged": 300
};

/** Parse one property token ("Defensive 2", "Area (10' cone)", "Reach") -> {key, value?, detail?}. */
function parseProperty(token) {
  const t = token.trim();
  // Area (…)  -> parameterized
  let m = /^Area\s*\((.+)\)$/i.exec(t);
  if ( m ) return { key: "area", detail: m[1].trim() };
  // Defensive N -> valued
  m = /^Defensive\s+(\d+)$/i.exec(t);
  if ( m ) return { key: "defensive", value: Number(m[1]) };
  // Simple flags
  const FLAG = {
    "Forceful": "forceful", "Precise": "precise", "Swift": "swift", "Slow": "slow",
    "Heavy": "heavy", "Reach": "reach", "Expendable": "expendable",
    "Delayed Ready": "delayed-ready", "Stationary": "stationary"
  };
  if ( FLAG[t] ) return { key: FLAG[t] };
  console.warn(`  ! unrecognized property "${t}"`);
  return null;
}

/**
 * Split a comma-separated property string, but keep parenthesized commas
 * together (e.g. "Area (5' / 10' cone)" must not split on the inner comma).
 */
function splitProperties(s) {
  const out = [];
  let depth = 0, buf = "";
  for ( const ch of s ) {
    if ( ch === "(" ) depth++;
    if ( ch === ")" ) depth--;
    if ( (ch === ",") && depth === 0 ) { out.push(buf); buf = ""; }
    else buf += ch;
  }
  if ( buf.trim() ) out.push(buf);
  return out.map(x => x.trim()).filter(Boolean);
}

/** {name, uuid} reference into the banes compendium for a bane name. */
function baneRef(name) {
  return { name, uuid: `Compendium.tomucatos-open-legend-rpg-system.banes.Item.${stableId(`bane:${name}`)}` };
}

/**
 * The Weapons & Implements table. categories/properties/banes are the raw table
 * strings; they're parsed into structured data below.
 */
const WEAPON_TABLE = [
  { examples: ["Unarmed Strike"], category: "One-handed Melee", wl: 0, properties: "Forceful, Precise, Swift", banes: ["Stunned", "Knockdown"] },
  { examples: ["Bowie Knife", "Shiv", "Multi-tool"], category: "One-handed Melee", wl: 2, properties: "Precise, Swift", banes: ["Persistent Damage", "Disarmed"] },
  { examples: ["Scimitar", "Shortsword", "Machete", "Sawblade"], category: "One-handed Melee", wl: 2, properties: "Forceful, Precise", banes: ["Persistent Damage", "Disarmed"] },
  { examples: ["Blow Gun", "Dart"], category: "Close Ranged", wl: 1, properties: "Precise", banes: ["Immobile"] },
  { examples: ["Hatchet", "Dagger"], category: "Close Ranged, One-handed Melee", wl: 2, properties: "Forceful, Precise, Swift", banes: ["Persistent Damage", "Disarmed"] },
  { examples: ["Longsword", "Katana", "Falchion"], category: "Versatile Melee", wl: 2, properties: "Forceful, Precise", banes: ["Persistent Damage", "Disarmed"] },
  { examples: ["Baseball Bat", "Club", "Improvised Weapon"], category: "One-handed Melee", wl: 1, properties: "Forceful", banes: ["Knockdown", "Stunned"] },
  { examples: ["Mace", "Warhammer"], category: "One-handed Melee", wl: 2, properties: "Forceful", banes: ["Knockdown", "Stunned", "Forced Move"] },
  { examples: ["Greatsword", "No-dachi", "Claymore", "Bastard Sword"], category: "Two-handed Melee", wl: 2, properties: "Forceful, Precise, Heavy", banes: ["Forced Move", "Knockdown"] },
  { examples: ["Chainsaw"], category: "Two-handed Melee", wl: 2, properties: "Forceful, Heavy", banes: ["Persistent Damage", "Demoralized", "Provoked", "Fear"] },
  { examples: ["Shortspear"], category: "Versatile Melee, Short Ranged", wl: 1, properties: "Forceful, Precise", banes: ["Persistent Damage", "Disarmed", "Immobile"] },
  { examples: ["Sledge Hammer", "Maul", "Great Axe"], category: "Two-handed Melee", wl: 2, properties: "Forceful, Heavy", banes: ["Knockdown", "Forced Move", "Stunned"] },
  { examples: ["Longspear"], category: "Two-handed Melee, Close Ranged", wl: 2, properties: "Forceful, Precise, Reach", banes: ["Persistent Damage", "Disarmed", "Immobile"] },
  { examples: ["Pitchfork", "Staff"], category: "Two-handed Melee", wl: 1, properties: "Forceful", banes: ["Knockdown", "Immobile", "Forced Move"] },
  { examples: ["Glaive", "Halberd", "Naginata"], category: "Two-handed Melee", wl: 2, properties: "Forceful, Reach", banes: ["Knockdown", "Immobile", "Forced Move"] },
  { examples: ["Flamethrower"], category: "Two-handed Melee", wl: 3, properties: "Precise, Slow, Area (5' / 10' cone)", banes: ["Fear", "Persistent Damage"] },
  { examples: ["Laser Pistol", "Revolver", "Handgun"], category: "Short Ranged", wl: 2, properties: "Precise", banes: ["Persistent Damage", "Slowed"] },
  { examples: ["Grenade", "Firebomb Elixir"], category: "Close Ranged", wl: 2, properties: "Precise, Expendable, Area (10' cube)", banes: ["Persistent Damage", "Knockdown", "Forced Move"] },
  { examples: ["Light Crossbow"], category: "Medium Ranged", wl: 2, properties: "Precise", banes: ["Persistent Damage", "Immobile"] },
  { examples: ["Sawed-off Shotgun"], category: "Short Ranged", wl: 2, properties: "Precise, Slow, Area (10' cone)", banes: ["Persistent Damage", "Stunned", "Forced Move"] },
  { examples: ["Shortbow", "Pump Shotgun"], category: "Medium Ranged", wl: 2, properties: "Precise", banes: ["Slowed", "Persistent Damage", "Knockdown"] },
  { examples: ["Submachine Gun", "M16"], category: "Medium Ranged", wl: 3, properties: "Precise, Area (10' cube)", banes: ["Persistent Damage", "Provoked", "Demoralized"] },
  { examples: ["Heavy Crossbow", "Longbow", "Rifle"], category: "Long Ranged", wl: 2, properties: "Precise", banes: ["Persistent Damage", "Slowed"] },
  { examples: ["Sniper Rifle", "Laser Rifle"], category: "Extreme Ranged", wl: 2, properties: "Precise", banes: ["Persistent Damage", "Slowed"] },
  { examples: ["Cannon"], category: "Extreme Ranged", wl: 2, properties: "Precise, Slow, Area (15' square), Delayed Ready, Heavy, Stationary", banes: ["Persistent Damage", "Forced Move", "Stunned"] },
  { examples: ["Small Shield"], category: "One-handed Melee", wl: 2, properties: "Forceful, Defensive 1", banes: ["Forced Move", "Stunned", "Knockdown"] },
  { examples: ["Riot Shield", "Tower Shield"], category: "One-handed Melee", wl: 3, properties: "Forceful, Defensive 2", banes: ["Forced Move", "Stunned", "Knockdown"] }
];

function makeWeapon(name, row) {
  const _id = stableId(`weapon:${name}`);
  const categories = row.category.split(",").map(c => {
    const key = CATEGORY_KEY[c.trim()];
    if ( !key ) console.warn(`  ! unrecognized category "${c.trim()}"`);
    return key;
  }).filter(Boolean);
  const rangeIncrement = categories.reduce((m, k) => Math.max(m, RANGE_INCREMENT[k] ?? 0), 0);
  const properties = splitProperties(row.properties).map(parseProperty).filter(Boolean);
  const banes = row.banes.map(baneRef);
  const heavy = properties.some(p => p.key === "heavy");
  // Each packaged weapon's base type is its OWN name (a Longbow's base type is
  // "Longbow", not the row's first example). Custom-named weapons added by the
  // user still set baseType to whichever packaged archetype they're built from.
  const baseType = name;

  return {
    _id,
    name,
    type: "weapon",
    img: IMG,
    system: {
      description: `<p>${row.category}. ${row.properties}.</p>`,
      notes: "",
      wealthLevel: row.wl,
      bulky: false,
      heavy,
      quantity: 1,
      baseType,
      categories,
      rangeIncrement,
      properties,
      banes
    },
    effects: [],
    flags: {},
    _stats: { systemId: "tomucatos-open-legend-rpg-system" }
  };
}

async function main() {
  const docs = [];
  for ( const row of WEAPON_TABLE ) {
    for ( const name of row.examples ) docs.push(makeWeapon(name, row));
  }
  docs.sort((a, b) => a.name.localeCompare(b.name));
  console.log(`[${PACK}] Building ${docs.length} weapons.`);

  const packDir = path.join(SYSTEM_ROOT, "packs", PACK);
  const sourceDir = path.join(SYSTEM_ROOT, "packs", "_source", PACK);
  fs.rmSync(packDir, { recursive: true, force: true });
  fs.mkdirSync(packDir, { recursive: true });
  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.mkdirSync(sourceDir, { recursive: true });

  const db = new ClassicLevel(packDir, { valueEncoding: "json" });
  await db.open();
  const batch = db.batch();
  for ( const doc of docs ) {
    batch.put(`!items!${doc._id}`, doc);
    const safe = doc.name.replace(/[^a-z0-9]+/gi, "_");
    fs.writeFileSync(path.join(sourceDir, `${safe}_${doc._id}.json`), JSON.stringify(doc, null, 2));
    const cats = doc.system.categories.join("+");
    const props = doc.system.properties.map(p => p.key + (p.value ? `:${p.value}` : "") + (p.detail ? `(${p.detail})` : "")).join(",");
    console.log(`  + ${doc.name}  [${cats}]  range=${doc.system.rangeIncrement}  {${props}}  banes=${doc.system.banes.length}`);
  }
  await batch.write();
  await db.close();

  console.log(`\n[${PACK}] Wrote ${docs.length} weapons to packs/${PACK}.`);
  console.log("Add the pack to system.json and restart Foundry to see it.");
}

main().catch(err => {
  console.error("Weapon build failed:", err);
  process.exit(1);
});
