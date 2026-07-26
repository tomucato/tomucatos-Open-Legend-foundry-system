#!/usr/bin/env node
/**
 * Compile the "boons" compendium pack from the hand-edited source JSON in
 * packs/_source/boons/*.json — NOT from the API.
 *
 * Use this (instead of build-boons.mjs) once the source files carry manual edits
 * the API build would clobber — e.g. custom per-boon `img` icons. build-boons.mjs
 * hardcodes one icon for every boon and rebuilds from the API, so running it
 * would wipe those edits.
 *
 * Each source file is a full boon document whose `effects` field is an array of
 * full embedded ActiveEffect objects. A ClassicLevel compendium stores a boon
 * and its effects as SEPARATE keys, so for each boon we write:
 *
 *   !items!<boonId>                       → the boon body, with `effects` set to
 *                                           the array of effect IDs (pointers),
 *                                           NOT [] and NOT the full objects.
 *   !items.effects!<boonId>.<effectId>    → one key per embedded effect object.
 *
 * Usage:  node scripts/build-boons-from-source.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { ClassicLevel } = await import(process.env.CLASSIC_LEVEL_PATH ?? "classic-level");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_ROOT = path.resolve(__dirname, "..");
const SOURCE_DIR = path.join(SYSTEM_ROOT, "packs", "_source", "boons");
const PACK_DIR = path.join(SYSTEM_ROOT, "packs", "boons");

async function main() {
  const files = fs.readdirSync(SOURCE_DIR).filter(f => f.endsWith(".json"));
  if ( !files.length ) throw new Error(`No source boons in ${SOURCE_DIR}`);
  console.log(`[boons] Building ${files.length} boons from _source/boons ...`);

  fs.rmSync(PACK_DIR, { recursive: true, force: true });
  fs.mkdirSync(PACK_DIR, { recursive: true });

  const db = new ClassicLevel(PACK_DIR, { valueEncoding: "json" });
  await db.open();
  const batch = db.batch();
  let totalEffects = 0;

  for ( const file of files.sort() ) {
    const doc = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, file), "utf8"));
    const effects = Array.isArray(doc.effects) ? doc.effects : [];

    // Body: every field verbatim (incl. the custom `img`), but the `effects`
    // array of OBJECTS is replaced with the array of effect IDs (pointers).
    const body = { ...doc, effects: effects.map(e => e._id) };
    batch.put(`!items!${doc._id}`, body);

    for ( const ae of effects ) {
      if ( !ae?._id ) { console.warn(`  ! ${doc.name}: an effect has no _id, skipped`); continue; }
      batch.put(`!items.effects!${doc._id}.${ae._id}`, ae);
      totalEffects++;
    }
    console.log(`  + ${doc.name.padEnd(18)} ${doc.img}${effects.length ? `  [effects: ${effects.map(e => e._id).join(", ")}]` : ""}`);
  }

  await batch.write();
  await db.close();
  console.log(`\n[boons] Wrote ${files.length} boons (${totalEffects} effect(s)) to packs/boons from source.`);
}

main().catch(err => { console.error("boon source build failed:", err); process.exit(1); });
