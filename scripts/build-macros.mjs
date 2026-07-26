#!/usr/bin/env node
/**
 * Pack the macro _source JSON files into the `macros` LevelDB pack.
 *
 * Macro documents are stored at the key `!macros!<id>` (unlike Item packs, which
 * use `!items!`). Each _source file is one Macro document. This does NOT fetch
 * anything remote — it just packs the local files. Foundry must be CLOSED (LevelDB
 * holds an exclusive lock).
 *
 *   node scripts/build-macros.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClassicLevel } from "/Users/thomas/repos/FoundryVTT-Node-14.363/node_modules/classic-level/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "packs", "_source", "macros");
const PACK_DIR = path.join(ROOT, "packs", "macros");

if ( !fs.existsSync(SRC_DIR) ) {
  console.error(`No macro source directory at ${SRC_DIR}`);
  process.exit(1);
}
const files = fs.readdirSync(SRC_DIR).filter(f => f.endsWith(".json"));
if ( !files.length ) {
  console.error("No macro _source files to build.");
  process.exit(1);
}

fs.mkdirSync(PACK_DIR, { recursive: true });
const db = new ClassicLevel(PACK_DIR, { valueEncoding: "json" });
await db.open();
const batch = db.batch();
let n = 0;
for ( const file of files ) {
  const doc = JSON.parse(fs.readFileSync(path.join(SRC_DIR, file), "utf8"));
  if ( !doc._id ) { console.warn(`Skipping ${file} — no _id`); continue; }
  batch.put(`!macros!${doc._id}`, doc);
  console.log(`  + ${doc.name} (${doc._id})`);
  n++;
}
await batch.write();
await db.close();
console.log(`Built packs/macros — ${n} macro(s).`);
