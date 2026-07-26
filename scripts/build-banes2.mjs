#!/usr/bin/env node
/**
 * Compile the "banes2" compendium pack from the hand-authored source JSON in
 * packs/_source/banes/*.json (NOT from the API).
 *
 * Each source file is a full bane document whose `effects` field is an array of
 * full embedded ActiveEffect objects. A ClassicLevel compendium stores a bane
 * and its effects as SEPARATE keys, so for each bane we write:
 *
 *   !items!<baneId>                      → the bane body, with `effects` set to
 *                                          the array of effect IDs (the POINTERS),
 *                                          NOT [] and NOT the full objects.
 *   !items.effects!<baneId>.<effectId>   → one key per embedded effect object.
 *
 * The crucial difference from the old build-banes.mjs: that script wrote the body
 * with `effects: []`, dropping the ID pointers, so Foundry showed an empty
 * Changes list for every bane. Keeping `effects: [<id>...]` links each bane to
 * its effect record, exactly like a bane authored in a world.
 *
 * Usage:  node scripts/build-banes2.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClassicLevel } from "/Users/thomas/repos/FoundryVTT-Node-14.363/node_modules/classic-level/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_ROOT = path.resolve(__dirname, "..");
const SOURCE_DIR = path.join(SYSTEM_ROOT, "packs", "_source", "banes");
const PACK_DIR = path.join(SYSTEM_ROOT, "packs", "banes2");

function main() {
  const files = fs.readdirSync(SOURCE_DIR).filter(f => f.endsWith(".json"));
  if ( !files.length ) throw new Error(`No source banes in ${SOURCE_DIR}`);
  console.log(`[banes2] Building ${files.length} banes from _source/banes ...`);

  fs.rmSync(PACK_DIR, { recursive: true, force: true });
  fs.mkdirSync(PACK_DIR, { recursive: true });

  return (async () => {
    const db = new ClassicLevel(PACK_DIR, { valueEncoding: "json" });
    await db.open();
    const batch = db.batch();
    let totalEffects = 0;

    for ( const file of files.sort() ) {
      const doc = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, file), "utf8"));
      // Pull the full embedded effect objects out of the source `effects` array.
      const effects = Array.isArray(doc.effects) ? doc.effects : [];

      // Body: keep every field, but replace the `effects` array of OBJECTS with
      // the array of effect IDs (pointers). This is what links the bane to its
      // effect records — the bug in the old builder was forcing this to [].
      const body = { ...doc, effects: effects.map(e => e._id) };
      batch.put(`!items!${doc._id}`, body);

      // Each effect object → its own key.
      for ( const ae of effects ) {
        if ( !ae?._id ) { console.warn(`  ! ${doc.name}: an effect has no _id, skipped`); continue; }
        batch.put(`!items.effects!${doc._id}.${ae._id}`, ae);
        totalEffects++;
      }

      const aeNote = effects.length ? `  [effects: ${effects.map(e => e._id).join(", ")}]` : "";
      console.log(`  + ${doc.name}${aeNote}`);
    }

    await batch.write();
    await db.close();
    console.log(`\n[banes2] Wrote ${files.length} banes (${totalEffects} effect(s)) to packs/banes2.`);
    console.log("Add the pack to system.json and restart Foundry to see it.");
  })();
}

main().catch(err => { console.error("banes2 build failed:", err); process.exit(1); });
