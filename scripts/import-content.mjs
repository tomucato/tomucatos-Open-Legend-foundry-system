#!/usr/bin/env node
/**
 * Build compendium packs from the HeroMuster Open Legend API.
 *
 * Each API endpoint returns:  { meta: {...}, success: { "<Name>": "<description>", ... } }
 * For every entry we create an Open Legend Item document and write it into a
 * ClassicLevel (LevelDB) pack at openlegend-system/packs/<pack> — the exact format
 * Foundry VTT v13 reads compendium packs from. A human-readable copy of each
 * document is also written to packs/_source/<pack>/*.json for rebuild/inspection.
 *
 * Add a new content type by appending to PACKS below.
 *
 * Usage:  node scripts/import-content.mjs            (import all packs)
 *         node scripts/import-content.mjs perks      (import only named packs)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClassicLevel } from "classic-level";

/** The content packs to build. */
const PACKS = [
  {
    pack: "perks",
    type: "perk",
    api: "https://openlegend.heromuster.com/api/perks",
    img: "icons/svg/angel.svg"
  },
  {
    pack: "flaws",
    type: "flaw",
    api: "https://openlegend.heromuster.com/api/flaws",
    img: "icons/svg/unconscious.svg"
  }
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_ROOT = path.resolve(__dirname, "..");

/**
 * Deterministic 16-char alphanumeric id derived from a string, so re-running the
 * import updates the same documents instead of creating duplicates.
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

/** Turn one [name, description] pair into a Foundry Item document object. */
function makeDocument(type, img, name, description) {
  const _id = stableId(`${type}:${name}`);
  return {
    _id,
    name,
    type,
    img,
    system: {
      description: `<p>${String(description).trim()}</p>`
    },
    effects: [],
    flags: {},
    _stats: { systemId: "tomucatos-open-legend-rpg-system" }
  };
}

async function buildPack({ pack, type, api, img }) {
  console.log(`\n[${pack}] Fetching from ${api} ...`);
  const res = await fetch(api);
  if ( !res.ok ) throw new Error(`[${pack}] API request failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  const data = json?.success;
  if ( !data || typeof data !== "object" ) {
    throw new Error(`[${pack}] Unexpected API shape — expected { success: { name: description } }`);
  }

  const entries = Object.entries(data).sort(([a], [b]) => a.localeCompare(b));
  console.log(`[${pack}] Received ${entries.length} entries.`);

  const packDir = path.join(SYSTEM_ROOT, "packs", pack);
  const sourceDir = path.join(SYSTEM_ROOT, "packs", "_source", pack);

  // Reset output directories.
  fs.rmSync(packDir, { recursive: true, force: true });
  fs.mkdirSync(packDir, { recursive: true });
  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.mkdirSync(sourceDir, { recursive: true });

  // Open the LevelDB pack and write each doc as !items!<id> -> document JSON.
  // classic-level v2 / abstract-level v2 require an explicit open() before use.
  const db = new ClassicLevel(packDir, { valueEncoding: "json" });
  await db.open();
  const batch = db.batch();
  for ( const [name, description] of entries ) {
    const doc = makeDocument(type, img, name, description);
    batch.put(`!items!${doc._id}`, doc);

    const safe = name.replace(/[^a-z0-9]+/gi, "_");
    fs.writeFileSync(path.join(sourceDir, `${safe}_${doc._id}.json`), JSON.stringify(doc, null, 2));
  }
  await batch.write();
  await db.close();

  console.log(`[${pack}] Wrote ${entries.length} ${type} items to packs/${pack}.`);
}

async function main() {
  const requested = process.argv.slice(2);
  const targets = requested.length ? PACKS.filter(p => requested.includes(p.pack)) : PACKS;
  if ( !targets.length ) {
    console.error(`No matching packs. Available: ${PACKS.map(p => p.pack).join(", ")}`);
    process.exit(1);
  }
  for ( const target of targets ) await buildPack(target);
  console.log("\nDone. Restart Foundry (or reload the world) to see the updated compendiums.");
}

main().catch(err => {
  console.error("Import failed:", err);
  process.exit(1);
});
