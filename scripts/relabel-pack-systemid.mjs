#!/usr/bin/env node
/**
 * Relabel the `_stats.systemId` inside every compendium-pack document to the
 * current system id from system.json. Run this after renaming the system id so
 * the packed documents stop warning about a systemId mismatch.
 *
 * This only rewrites the in-pack metadata; it does NOT re-fetch content from the
 * API. The LevelDB packs must NOT be open in Foundry while this runs (LevelDB
 * holds an exclusive lock) — close Foundry first.
 *
 * Usage:  node scripts/relabel-pack-systemid.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClassicLevel } from "/Users/thomas/repos/FoundryVTT-Node-14.363/node_modules/classic-level/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SYSTEM_ID = JSON.parse(fs.readFileSync(path.join(ROOT, "system.json"), "utf8")).id;

const PACKS = ["perks", "flaws", "armor", "banes", "boons", "feats", "weapons"];

async function main() {
  console.log(`Relabeling pack systemId -> "${SYSTEM_ID}"\n`);
  let totalDocs = 0, totalChanged = 0;

  for ( const p of PACKS ) {
    const dir = path.join(ROOT, "packs", p);
    if ( !fs.existsSync(path.join(dir, "CURRENT")) ) { console.log(`  SKIP ${p} (no LevelDB pack)`); continue; }

    // LevelDB pack.
    const db = new ClassicLevel(dir, { valueEncoding: "json" });
    await db.open();
    let n = 0, c = 0;
    const batch = db.batch();
    for await ( const [key, val] of db.iterator() ) {
      n++;
      if ( val?._stats && (val._stats.systemId !== SYSTEM_ID) ) {
        val._stats.systemId = SYSTEM_ID;
        batch.put(key, val);
        c++;
      }
    }
    await batch.write();
    await db.close();

    // Mirror into the human-readable _source copies.
    const srcDir = path.join(ROOT, "packs", "_source", p);
    if ( fs.existsSync(srcDir) ) {
      for ( const f of fs.readdirSync(srcDir).filter(f => f.endsWith(".json")) ) {
        const fp = path.join(srcDir, f);
        const doc = JSON.parse(fs.readFileSync(fp, "utf8"));
        if ( doc?._stats && (doc._stats.systemId !== SYSTEM_ID) ) {
          doc._stats.systemId = SYSTEM_ID;
          fs.writeFileSync(fp, JSON.stringify(doc, null, 2));
        }
      }
    }

    totalDocs += n; totalChanged += c;
    console.log(`  ${p}: ${c}/${n} docs relabeled`);
  }

  console.log(`\nDone. Relabeled ${totalChanged}/${totalDocs} documents to systemId "${SYSTEM_ID}".`);
}

main().catch(err => {
  if ( err?.cause?.code === "LEVEL_LOCKED" || err?.code === "LEVEL_DATABASE_NOT_OPEN" ) {
    console.error("\nA pack is locked — close Foundry (it holds the LevelDB lock) and re-run.");
  } else {
    console.error("Relabel failed:", err);
  }
  process.exit(1);
});
