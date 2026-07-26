#!/usr/bin/env node
/**
 * Compile the "effects" compendium pack from the hand-edited source JSON in
 * packs/_source/effects/*.json.
 *
 * Each source file is a full "effect" Item document whose `effects` field is an
 * array of full embedded ActiveEffect objects. A ClassicLevel compendium stores
 * an item and its effects as SEPARATE keys, so for each item we write:
 *
 *   !items!<itemId>                       → the item body, with `effects` set to
 *                                           the array of effect IDs (pointers).
 *   !items.effects!<itemId>.<effectId>    → one key per embedded effect object.
 *
 * Foundry must be CLOSED (LevelDB holds an exclusive lock).
 *
 * Usage:  node scripts/build-effects.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClassicLevel } from "/Users/thomas/repos/FoundryVTT-Node-14.363/node_modules/classic-level/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_ROOT = path.resolve(__dirname, "..");
const SOURCE_DIR = path.join(SYSTEM_ROOT, "packs", "_source", "effects");
const PACK_DIR = path.join(SYSTEM_ROOT, "packs", "effects");

async function main() {
  const files = fs.readdirSync(SOURCE_DIR).filter(f => f.endsWith(".json"));
  if ( !files.length ) throw new Error(`No source effects in ${SOURCE_DIR}`);
  console.log(`[effects] Building ${files.length} effect item(s) from _source/effects ...`);

  fs.rmSync(PACK_DIR, { recursive: true, force: true });
  fs.mkdirSync(PACK_DIR, { recursive: true });

  const db = new ClassicLevel(PACK_DIR, { valueEncoding: "json" });
  await db.open();
  const batch = db.batch();
  let totalEffects = 0;

  for ( const file of files.sort() ) {
    const doc = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, file), "utf8"));
    const effects = Array.isArray(doc.effects) ? doc.effects : [];

    const body = { ...doc, effects: effects.map(e => e._id) };
    batch.put(`!items!${doc._id}`, body);

    for ( const ae of effects ) {
      if ( !ae?._id ) { console.warn(`  ! ${doc.name}: an effect has no _id, skipped`); continue; }
      batch.put(`!items.effects!${doc._id}.${ae._id}`, ae);
      totalEffects++;
    }
    console.log(`  + ${doc.name.padEnd(28)} ${doc.img}${effects.length ? `  [effects: ${effects.map(e => e._id).join(", ")}]` : ""}`);
  }

  await batch.write();
  await db.close();
  console.log(`\n[effects] Wrote ${files.length} item(s) (${totalEffects} effect(s)) to packs/effects from source.`);
}

main().catch(err => { console.error("effects pack build failed:", err); process.exit(1); });
