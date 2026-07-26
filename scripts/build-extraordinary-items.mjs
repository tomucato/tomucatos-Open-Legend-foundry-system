#!/usr/bin/env node
/**
 * Pack the extraordinary-item _source JSON files into the `extraordinary-items`
 * LevelDB pack. Item bodies are stored at `!items!<id>` (effects stripped to []),
 * and any embedded ActiveEffects at `!items.effects!<itemId>.<effectId>` — matching
 * the layout every other Item pack uses. Foundry must be CLOSED (exclusive lock).
 *
 *   node scripts/build-extraordinary-items.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { ClassicLevel } = await import(process.env.CLASSIC_LEVEL_PATH ?? "classic-level");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "packs", "_source", "extraordinary-items");
const PACK_DIR = path.join(ROOT, "packs", "extraordinary-items");

if ( !fs.existsSync(SRC_DIR) ) {
  console.error(`No source directory at ${SRC_DIR}`);
  process.exit(1);
}
const files = fs.readdirSync(SRC_DIR).filter(f => f.endsWith(".json"));
if ( !files.length ) {
  console.error("No _source files to build.");
  process.exit(1);
}

fs.mkdirSync(PACK_DIR, { recursive: true });
const db = new ClassicLevel(PACK_DIR, { valueEncoding: "json" });
await db.open();
const batch = db.batch();
let n = 0;
const ids = new Set();
for ( const file of files ) {
  const doc = JSON.parse(fs.readFileSync(path.join(SRC_DIR, file), "utf8"));
  if ( !doc._id ) { console.warn(`Skipping ${file} — no _id`); continue; }
  if ( ids.has(doc._id) ) { console.error(`Duplicate _id ${doc._id} in ${file}`); process.exit(1); }
  ids.add(doc._id);
  const effects = doc.effects ?? [];
  batch.put(`!items!${doc._id}`, { ...doc, effects: [] });
  for ( const ae of effects ) batch.put(`!items.effects!${doc._id}.${ae._id}`, ae);
  console.log(`  + ${doc.name} (${doc._id})`);
  n++;
}
await batch.write();
await db.close();
console.log(`Built packs/extraordinary-items — ${n} item(s).`);
