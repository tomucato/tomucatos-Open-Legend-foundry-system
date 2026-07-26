#!/usr/bin/env node
/**
 * Build the "armor" compendium pack from the Open Legend armor table.
 *
 * Unlike import-content.mjs (which pulls perks/flaws from an API), armor is
 * static structured data, so the table is encoded inline below. Each row's
 * "Examples" cell lists several mechanically-equivalent armors — every name
 * becomes its own armor Item document with the row's stats.
 *
 * Writes a ClassicLevel (LevelDB) pack at packs/armor — the exact format Foundry
 * reads — plus a human-readable copy of each document in packs/_source/armor.
 *
 * classic-level isn't a dependency of this repo, so we import the copy bundled
 * with the local Foundry install.
 *
 * Usage:  node scripts/build-armor.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { ClassicLevel } = await import(process.env.CLASSIC_LEVEL_PATH ?? "classic-level");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_ROOT = path.resolve(__dirname, "..");

/**
 * The Open Legend armor table. Each row's `examples` are individual armors that
 * share the row's mechanical stats. speedPenalty is stored as a plain number of
 * feet (the table's 5' = 5).
 */
const ARMOR_TABLE = [
  {
    examples: ["Leather Armor", "Steelsilk", "Padded Armor"],
    armorType: "light",  wealthLevel: 1, requiredFortitude: 0, defenseBonus: 1, speedPenalty: 0
  },
  {
    examples: ["Armored Trench Coat", "Electropolymer Armor"],
    armorType: "medium", wealthLevel: 3, requiredFortitude: 2, defenseBonus: 2, speedPenalty: 0
  },
  {
    examples: ["Chainmail", "Kevlar Vest", "Breastplate"],
    armorType: "medium", wealthLevel: 2, requiredFortitude: 3, defenseBonus: 2, speedPenalty: 0
  },
  {
    examples: ["Yoroi Armor", "Plate Mail", "Riot Suit"],
    armorType: "heavy",  wealthLevel: 2, requiredFortitude: 3, defenseBonus: 3, speedPenalty: 5
  },
  {
    examples: ["Power Armor", "Elven Plate Mail"],
    armorType: "heavy",  wealthLevel: 4, requiredFortitude: 1, defenseBonus: 3, speedPenalty: 0
  }
];

const PACK = "armor";
const IMG = "icons/svg/shield.svg";

/**
 * Deterministic 16-char alphanumeric id derived from a string, so re-running the
 * build updates the same documents instead of creating duplicates.
 * (Identical to import-content.mjs#stableId.)
 * @param {string} str
 * @returns {string}
 */
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

/** Build one armor Item document from a name + the row's stats. */
function makeArmor(name, row) {
  const _id = stableId(`armor:${name}`);
  const typeLabel = row.armorType[0].toUpperCase() + row.armorType.slice(1);
  const desc = `<p>${typeLabel} armor. Defense Bonus +${row.defenseBonus}`
    + (row.speedPenalty ? `, Speed Penalty &minus;${row.speedPenalty}` : "")
    + (row.requiredFortitude ? `, Required Fortitude ${row.requiredFortitude}` : "")
    + `.</p>`;
  return {
    _id,
    name,
    type: "armor",
    img: IMG,
    system: {
      description: desc,
      notes: "",
      wealthLevel: row.wealthLevel,
      bulky: false,
      heavy: false,
      quantity: 1,
      armorType: row.armorType,
      requiredFortitude: row.requiredFortitude,
      defenseBonus: row.defenseBonus,
      speedPenalty: row.speedPenalty,
      equipped: false
    },
    effects: [],
    flags: {},
    _stats: { systemId: "tomucatos-open-legend-rpg-system" }
  };
}

async function main() {
  // Expand each row's examples into individual armor docs.
  const docs = [];
  for ( const row of ARMOR_TABLE ) {
    for ( const name of row.examples ) docs.push(makeArmor(name, row));
  }
  docs.sort((a, b) => a.name.localeCompare(b.name));
  console.log(`[${PACK}] Building ${docs.length} armor items.`);

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
    console.log(`  + ${doc.name} (${doc.system.armorType}, +${doc.system.defenseBonus} def)`);
  }
  await batch.write();
  await db.close();

  console.log(`\n[${PACK}] Wrote ${docs.length} armor items to packs/${PACK}.`);
  console.log("Add the pack to system.json and restart Foundry to see it.");
}

main().catch(err => {
  console.error("Armor build failed:", err);
  process.exit(1);
});
