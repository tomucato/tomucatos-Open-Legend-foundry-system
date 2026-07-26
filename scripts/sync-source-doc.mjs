#!/usr/bin/env node
/**
 * Write a single hand-edited _source JSON document into its LevelDB pack,
 * mirroring the storage layout the build scripts use:
 *   - the item body at  !items!<itemId>            (with effects stripped to [])
 *   - each embedded AE at !items.effects!<itemId>.<effectId>
 *
 * This does NOT re-fetch from any API — it just packs the local _source file, so
 * manual edits to a bane/boon/feat's tiers survive. Foundry must be CLOSED
 * (LevelDB holds an exclusive lock).
 *
 *   node scripts/sync-source-doc.mjs <pack> <sourceJsonPath>
 *   e.g. node scripts/sync-source-doc.mjs banes packs/_source/banes/Fatigued_cBolruzeRoFKKnHl.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { ClassicLevel } = await import(process.env.CLASSIC_LEVEL_PATH ?? "classic-level");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const [, , pack, srcArg] = process.argv;
if ( !pack || !srcArg ) {
  console.error("Usage: node scripts/sync-source-doc.mjs <pack> <sourceJsonPath>");
  process.exit(1);
}

const srcPath = path.isAbsolute(srcArg) ? srcArg : path.join(ROOT, srcArg);
const doc = JSON.parse(fs.readFileSync(srcPath, "utf8"));
const packDir = path.join(ROOT, "packs", pack);
if ( !fs.existsSync(path.join(packDir, "CURRENT")) ) {
  console.error(`No LevelDB pack at packs/${pack}`);
  process.exit(1);
}

const db = new ClassicLevel(packDir, { valueEncoding: "json" });
await db.open();
const batch = db.batch();
const effects = doc.effects ?? [];
const stored = { ...doc, effects: [] };
batch.put(`!items!${doc._id}`, stored);
for ( const ae of effects ) batch.put(`!items.effects!${doc._id}.${ae._id}`, ae);
await batch.write();
await db.close();

console.log(`Synced "${doc.name}" (${doc._id}) into packs/${pack} — ${effects.length} embedded effect(s).`);
