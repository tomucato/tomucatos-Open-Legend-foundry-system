#!/usr/bin/env node
/**
 * Build the "feats" compendium pack from the Open Legend feats API.
 *
 *   https://openlegend.heromuster.com/api/feats  ->  { success: { feats: { "<idx>": {...} } } }
 *   (the API keys feats by numeric index; the real name is in each entry's `name`)
 *
 * Feats are NOT Active Effects — they are tracked, costed, and tiered on the
 * character sheet, with their full effect text shown. A feat may have multiple
 * tiers (indicated in the name, e.g. "Alternate Form (I - II)"); each tier has a
 * cost and its own prerequisites.
 *
 * For each feat we scrape the API into a structured Open Legend feat Item:
 *   - description / effect / special: as-is HTML/text.
 *   - tags:        the API `tags` array (Passive / Combat / attribute names, etc.).
 *   - cost:        the API `cost` array. Length 1 => same cost every tier; length
 *                  N => per-tier costs. Normalized to a per-tier array of length
 *                  maxTier so the sheet can sum costs cleanly.
 *   - maxTier:     number of tiers (from the prerequisites' tierN keys, else 1).
 *   - tiers[]:     one {tier, cost, prerequisites} per tier, where prerequisites
 *                  is a readable structure: { attribute: [{any:[{key,label,min}]}],
 *                  feats: [name], other: [text] }.
 *   - purchasedTier: 0 on the compendium item; set when added to an actor.
 *
 * Writes a ClassicLevel (LevelDB) pack at packs/feats + _source/feats JSON.
 * classic-level is imported from the local Foundry install (not a repo dep).
 *
 * Usage:  node scripts/build-feats.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClassicLevel } from "/Users/thomas/repos/FoundryVTT-Node-14.363/node_modules/classic-level/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_ROOT = path.resolve(__dirname, "..");
const API = "https://openlegend.heromuster.com/api/feats";
const PACK = "feats";
const IMG = "icons/svg/upgrade.svg";

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

/** Lowercase attribute key from a capitalized label, e.g. "Agility" -> "agility". */
function attrKey(label) {
  return String(label).trim().toLowerCase();
}

/**
 * Parse one tier's prerequisites object into a readable structure. The API shape
 * per tier is a map of category -> value, optionally nested under an "any" key:
 *   { any: { Attribute: [{Agility:3}, {Might:3}] } }
 *   { Feat: ["Lethal Strike I"] }
 *   { Other: ["None"] }
 * Returns { attribute: [{key,label,min}] (alternatives — ANY satisfies),
 *           feats: [name], other: [text], hasNone: bool }.
 */
function parsePrereqTier(tierObj = {}) {
  const out = { attribute: [], feats: [], other: [], hasNone: false };

  const ingest = (category, value) => {
    if ( category === "Attribute" && Array.isArray(value) ) {
      for ( const alt of value ) {
        // alt is { "Agility": 3 } or { "Any Extraordinary": 3 }
        for ( const [label, min] of Object.entries(alt) ) {
          out.attribute.push({ key: attrKey(label), label, min: Number(min) });
        }
      }
    } else if ( category === "Feat" && Array.isArray(value) ) {
      out.feats.push(...value.map(s => String(s).trim()).filter(Boolean));
    } else if ( category === "Other" && Array.isArray(value) ) {
      for ( const t of value ) {
        const text = String(t).trim();
        if ( /^none$/i.test(text) ) out.hasNone = true;
        else if ( text ) out.other.push(text);
      }
    }
  };

  for ( const [k, v] of Object.entries(tierObj) ) {
    if ( (k === "any") || (k === "all") ) {
      // Wrapper: descend into the inner category map.
      for ( const [ck, cv] of Object.entries(v || {}) ) ingest(ck, cv);
    } else {
      ingest(k, v);
    }
  }
  return out;
}

/** Strip tags / entities / whitespace from a snippet of HTML. */
function cleanText(s = "") {
  return s.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
}

/**
 * Purchase-time choices, hand-annotated per feat (the API only carries them as
 * prose in `effect`/`special`). Keyed by base name — the feat name minus its
 * "(I - IX)" tier suffix. Each entry:
 *   - type:  what the player picks; drives the option list on the sheet:
 *            "bane"/"boon"/"weapon" -> compendium index, "attribute" -> config
 *            labels, "energy"/"mode" -> OPENLEGEND.featChoices, "text" -> free.
 *   - label: prompt shown in the pick dialog / on the item sheet.
 *   - count: number of picks (Multi-Bane Specialist chooses two banes).
 *   - multi: the feat may be taken multiple times, once per distinct choice
 *            ("You may take this feat multiple times..." in `special`).
 * Heightened Invocation also says "choose", but that choice is made per
 * invocation, not at purchase — deliberately not listed.
 */
const CHOICES = {
  "Alternate Form":          { type: "text", label: "Form name", multi: true },
  // Attribute Substitution uses a bespoke primary→dependent prompt (empty generic
  // `type`), but IS multi-take: a character may link several attribute pairs (even
  // sharing the same primary), one feat per pair. multi:true lets the sheet add
  // more than one copy; the dedup guard still blocks an identical primary→dependent.
  "Attribute Substitution":  { type: "", label: "Substitution", multi: true },
  "Attack Specialization":   { type: "weapon", label: "Weapon or attack type", multi: true },
  "Bane Focus":              { type: "bane", label: "Bane", multi: true },
  "Battlefield Punisher":    { type: "bane", label: "Bane", multi: false },
  "Boon Access":             { type: "boon", label: "Boon", multi: true },
  "Boon Focus":              { type: "boon", label: "Boon", multi: true },
  "Companion":               { type: "text", label: "Companion name", multi: true },
  "Craft Mundane Item":      { type: "text", label: "Craft or profession", multi: true },
  "Energy Resistance":       { type: "energy", label: "Energy type", multi: true },
  "Extraordinary Focus":     { type: "text", label: "Focus (e.g. wand, holy symbol)", multi: true },
  "Knowledge":               { type: "text", label: "Sphere of knowledge", multi: true },
  "Longshot":                { type: "weapon", label: "Weapon or attack type", multi: true },
  "Martial Focus":           { type: "weapon", label: "Weapon (or unarmed combat)", multi: false },
  "Multi-Bane Specialist":   { type: "bane", label: "Banes", count: 2, multi: true },
  "Multi-Target Attack Specialist": { type: "mode", label: "Multi-target mode", multi: true },
  "Potent Bane":             { type: "bane", label: "Bane", multi: true },
  "Skill Specialization":    { type: "attribute", label: "Attribute", multi: true },
  "Sworn Enemy":             { type: "text", label: "Species, race, or faction", multi: true }
};

/** Base name: the feat name with any "(I - IX)" / "(I)" tier suffix removed. */
function baseName(name) {
  return name.replace(/\s*\((?:[IVX]+(?:\s*-\s*[IVX]+)?)\)\s*$/i, "").trim();
}

function makeFeat(raw) {
  const name = String(raw.name ?? "").trim();
  const _id = stableId(`feat:${name}`);
  const tags = Array.isArray(raw.tags) ? raw.tags.slice() : [];
  const choice = CHOICES[baseName(name)] ?? null;

  // Tier count: from the prerequisites' tierN keys, else 1.
  const prereqs = raw.prerequisites ?? {};
  const tierNums = Object.keys(prereqs)
    .map(k => Number((/tier(\d+)/i.exec(k) || [])[1]))
    .filter(n => Number.isFinite(n) && (n > 0));
  const maxTier = tierNums.length ? Math.max(...tierNums) : 1;

  // Cost per tier. API `cost` is [c] (same each tier) or [c1..cN] (per tier).
  const costArr = Array.isArray(raw.cost) ? raw.cost.map(Number) : [Number(raw.cost) || 0];
  const costPerTier = Array.from({ length: maxTier }, (_, i) =>
    costArr.length === 1 ? costArr[0] : (costArr[i] ?? costArr[costArr.length - 1] ?? 0)
  );

  // Build the per-tier records with parsed prerequisites.
  const tiers = Array.from({ length: maxTier }, (_, i) => {
    const tier = i + 1;
    const tierObj = prereqs[`tier${tier}`] ?? prereqs[`tier1`] ?? {};
    return { tier, cost: costPerTier[i], prerequisites: parsePrereqTier(tierObj) };
  });

  return {
    _id,
    name,
    type: "feat",
    img: IMG,
    system: {
      description: (raw.description || "").trim()
        ? `<p>${cleanText(raw.description)}</p>`
        : "",
      effect: (raw.effect || "").trim(),
      special: (raw.special || "").trim(),
      tags,
      cost: costPerTier,
      maxTier,
      tiers,
      // 0 on the compendium template; the actor sheet sets it to >=1 when bought.
      purchasedTier: 0,
      // Purchase-time choice (see CHOICES above). `value` stays empty on the
      // compendium item; the actor sheet fills it when the feat is taken.
      choice: {
        type: choice?.type ?? "",
        label: choice?.label ?? "",
        count: choice?.count ?? 1,
        value: ""
      },
      multi: choice?.multi ?? false,
      // The undecorated compendium name; set here so owned copies (whose names
      // gain a "— <choice>" suffix) can still be matched back to this feat.
      baseName: name
    },
    effects: [],
    flags: {},
    _stats: { systemId: "tomucatos-open-legend-rpg-system" }
  };
}

async function main() {
  console.log(`[${PACK}] Fetching ${API} ...`);
  const res = await fetch(API);
  if ( !res.ok ) throw new Error(`API request failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  // The endpoint nests feats under success.feats, keyed by numeric index.
  const root = json?.success?.feats ?? json?.success;
  const feats = root && typeof root === "object" ? Object.values(root) : null;
  if ( !feats ) throw new Error("Unexpected API shape — expected success.feats");

  const docs = feats
    .filter(f => f && f.name)
    .map(makeFeat)
    .sort((a, b) => a.name.localeCompare(b.name));
  console.log(`[${PACK}] Building ${docs.length} feats.`);

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
    const costStr = doc.system.cost.join("/");
    console.log(`  + ${doc.name}  tiers:${doc.system.maxTier}  cost:${costStr}`);
  }
  await batch.write();
  await db.close();

  console.log(`\n[${PACK}] Wrote ${docs.length} feats to packs/${PACK}.`);
  console.log("Add the pack to system.json and restart Foundry to see it.");
}

main().catch(err => {
  console.error("Feat build failed:", err);
  process.exit(1);
});
