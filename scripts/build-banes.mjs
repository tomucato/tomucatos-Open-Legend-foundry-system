#!/usr/bin/env node
/**
 * Build the "banes" compendium pack from the Open Legend banes API.
 *
 *   https://openlegend.heromuster.com/api/banes  ->  { success: { banes: { "<Name>": {...} } } }
 *
 * For each bane we scrape the API into a structured Open Legend bane Item:
 *   - attacks:      "Agility vs. Toughness"  ->  [{attackingAttribute, defense}]
 *   - tags:         the API `tags` array (Physical / Mental / Extraordinary, etc.)
 *   - powerEffects: one {powerLevel, effect} per entry in the API `power` array,
 *                   scraping the matching "<li><strong>Power Level N</strong> - ...</li>"
 *                   line from the effect HTML (single-power banes get one entry
 *                   built from the headline effect text).
 *   - powerLevel:   the minimum valid power (headline requirement).
 *   - invocationTime / duration / description / effect / special: as-is.
 *   - failDuration: the text after "=" inside "(Fail x N = <X>)" in duration.
 *   - gameEffects:  machine-readable mechanical effects per power level, where the
 *                   effect text is parseable (e.g. Demoralized -> disadvantage N to
 *                   all rolls). Future drop-on-token wiring reads this.
 *   - effects[]:    the bane's leveled Active Effect (full per-level change table
 *                   + flags.openlegend.changeLevels), seeded from gameEffects.
 *                   This is what gets cloned onto a token when the bane is
 *                   dropped on it, and what the sheet's Effects tab edits.
 *
 * Writes a ClassicLevel (LevelDB) pack at packs/banes + _source/banes JSON.
 * classic-level is imported from the local Foundry install (not a repo dep).
 *
 * Usage:  node scripts/build-banes.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { ClassicLevel } = await import(process.env.CLASSIC_LEVEL_PATH ?? "classic-level");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_ROOT = path.resolve(__dirname, "..");
const API = "https://openlegend.heromuster.com/api/banes";
const PACK = "banes";
const IMG = "icons/svg/terror.svg";

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

/** "Agility vs. Toughness" -> {attackingAttribute:"Agility", defense:"Toughness"}. */
function parseAttacks(arr = []) {
  return arr.map(s => {
    const m = /^\s*(.+?)\s+vs\.?\s+(.+?)\s*$/i.exec(s);
    return m
      ? { attackingAttribute: m[1].trim(), defense: m[2].trim() }
      : { attackingAttribute: String(s).trim(), defense: "" };
  });
}

/** Text after "=" inside "(Fail x N = <X>)", else "". */
function parseFailDuration(duration = "") {
  const m = /Fail\s*x\s*\d+\s*=\s*([^)]+)\)/i.exec(duration);
  return m ? m[1].trim() : "";
}

/** Strip tags / entities / whitespace from a snippet of effect HTML. */
function cleanText(s = "") {
  return s.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
}

/**
 * One {powerLevel, effect} per power value. If the effect HTML has per-level
 * "<li><strong>Power Level N</strong> - text</li>" lines, scrape each; otherwise
 * the bane has a single effect, applied to its single power level.
 */
function parsePowerEffects(power = [], effect = "") {
  return power.map(lvl => {
    const re = new RegExp(`Power Level[^<]*?\\b${lvl}\\b[^-–]*[-–]\\s*([^<]+?)\\.?\\s*</li>`, "i");
    const m = effect.match(re);
    return { powerLevel: lvl, effect: m ? cleanText(m[1]) : cleanText(effect.split("<ul>")[0]) };
  });
}

/**
 * Derive machine-readable game effects per power level from the effect text.
 * Currently recognizes the common "Disadvantage N" pattern (e.g. Demoralized);
 * everything else is stored descriptively so the data is complete and future
 * patterns can be added without re-scraping. Each entry:
 *   { powerLevel, kind, value, scope, label }
 * kind "disadvantage" is mechanically actionable; "descriptive" is text-only.
 */
function deriveGameEffects(powerEffects, headlineEffect = "") {
  return powerEffects.map(pe => {
    // Per-level lines like "Disadvantage 1" inherit their scope from the bane's
    // headline sentence (e.g. Demoralized: "...disadvantage on all action rolls").
    const text = `${headlineEffect} ${pe.effect || ""}`;
    const dis = /disadvantage\s+(\d+)/i.exec(`${pe.effect} ${headlineEffect}`);

    // Only a BLANKET "all action rolls" disadvantage is treated as a mechanical
    // all-rolls effect. "all attacks" is attack-scoped. Perception/sight/hearing
    // and conditional ("attacks that do not include you") stay descriptive —
    // they can't be a flat global modifier.
    if ( dis && /disadvantage[^.]*\ball action rolls\b/i.test(text) ) {
      return {
        powerLevel: pe.powerLevel, kind: "disadvantage", value: Number(dis[1]),
        scope: "all-rolls", label: `Disadvantage ${dis[1]} on all action rolls`
      };
    }
    if ( dis && /disadvantage[^.]*\ball attacks\b/i.test(text) ) {
      return {
        powerLevel: pe.powerLevel, kind: "disadvantage", value: Number(dis[1]),
        scope: "attack-rolls", label: `Disadvantage ${dis[1]} on all attacks`
      };
    }
    return { powerLevel: pe.powerLevel, kind: "descriptive", value: null, scope: "", label: pe.effect || "" };
  });
}

/**
 * Manual mechanical effects for banes the effect-text parser can't derive into
 * the Subject/Action/Modifier model (see CONFIG.OPENLEGEND.effectSubjects). Each
 * entry is keyed by bane name and lists change rows authored the same way the
 * effect-config sheet authors them:
 *   { key: <subject id>, action: bonus|penalty|override|half|double,
 *     value?: number (omit for half/double), modifier?: flat|advdis (default flat),
 *     level?: power level the row unlocks at (default = bane's min power) }
 * These MERGE with the auto-derived "disadvantage N" rows (e.g. Sickened keeps
 * its parsed all-rolls disadvantage and gains the per-defense penalties here).
 * @type {Record<string, Array<object>>}
 */
const MANUAL_EFFECTS = {
  // Blinded: -3 to Guard (can't see attacks coming).
  Blinded: [{ key: "guard", action: "penalty", value: 3, level: 5 }],
  // Sickened: in addition to the parsed disadvantage 1 on all rolls, -1 to each defense.
  Sickened: [
    { key: "guard", action: "penalty", value: 1, level: 5 },
    { key: "toughness", action: "penalty", value: 1, level: 5 },
    { key: "resolve", action: "penalty", value: 1, level: 5 }
  ],
  // Slowed: speed reduced to half.
  Slowed: [{ key: "speed", action: "half", level: 1 }]
};

/** Native multiply factor per factor-action (mirrors OPENLEGEND.effectFactorActions). */
const FACTOR = { half: 0.5, double: 2 };

/**
 * Convert one authored manual row to a native change + its mode. bonus → add
 * +|v|; penalty → add −|v|; override → override v; half/double → multiply by the
 * factor (no value/modifier — the factor is the operation). adv/dis modifier
 * rows keep the sign as authored (penalty → negative = disadvantage).
 * @param {object} row
 * @returns {{change: object, mode: string, level: number}}
 */
function manualRow(row, defaultLevel) {
  const advdis = (row.modifier === "advdis");
  // phase: "final" so the change applies AFTER the actor's prepareDerivedData
  // recomputes speed / defenses / HP from _source — otherwise the default
  // (pre-derived) phase runs first and the recompute silently overwrites it.
  let change;
  if ( row.action in FACTOR ) {
    change = { key: row.key, type: "multiply", value: String(FACTOR[row.action]), phase: "final", priority: 20 };
  } else if ( row.action === "override" ) {
    change = { key: row.key, type: "override", value: String(row.value ?? 0), phase: "final", priority: 20 };
  } else {
    const mag = Math.abs(Number(row.value) || 0);
    change = { key: row.key, type: "add", value: String(row.action === "penalty" ? -mag : mag), phase: "final", priority: 20 };
  }
  return { change, mode: advdis ? "advdis" : "flat", level: Math.max(0, Math.floor(Number(row.level ?? defaultLevel) || 0)) };
}

/**
 * Seed the bane's Active Effect — the LEVELED condition that is applied to a
 * token when the bane is dropped on it (the sheet's Effects tab shows and
 * edits exactly this). The whole actionable per-level table is written as
 * change rows tagged with their level via flags.openlegend.changeLevels, the
 * same generic leveling every effect supports in the config UI; at apply time
 * only the strongest row the invoked power level unlocks is active.
 *
 * Rows come from two sources, merged: the auto-derived "disadvantage N" game
 * effects (parsed from the effect text) and any hand-authored rows in
 * MANUAL_EFFECTS for mechanics the parser can't reach (flat defense penalties,
 * Half speed, etc.).
 *
 * transfer is FALSE: the effect is a template. Dropping the bane on a token
 * clones it onto the actor at the invoked power level (see leveledEffectData);
 * the bane item itself is also embedded for reference and must not re-apply.
 * Banes with no parseable mechanics AND no manual rows get a descriptive marker.
 */
function buildActiveEffects(name, gameEffects, img, minPower) {
  const actionable = gameEffects.filter(g => g.kind === "disadvantage");
  // Auto-derived adv/dis rows: a bane grants DISADVANTAGE, so the value is
  // NEGATIVE (the sign selects adv vs dis; see resolveTarget / actorRollModifiers).
  const changes = [];
  const changeLevels = [];
  const changeModes = [];
  for ( const g of actionable ) {
    changes.push({
      key: g.scope === "attack-rolls" ? "allAttacks" : "allRolls",
      type: "add",
      value: String(-Math.abs(Number(g.value) || 0)),
      phase: "final",
      priority: 20
    });
    changeLevels.push(g.powerLevel);
    changeModes.push("advdis");
  }
  // Hand-authored rows merged on top.
  for ( const row of MANUAL_EFFECTS[name] ?? [] ) {
    const { change, mode, level } = manualRow(row, minPower);
    changes.push(change);
    changeLevels.push(level);
    changeModes.push(mode);
  }
  return [{
    _id: stableId(`bane-ae:${name}`),
    name,
    type: "base",
    img,
    disabled: false,
    transfer: false,
    showIcon: 2 /* CONST.ACTIVE_EFFECT_SHOW_ICON.ALWAYS */,
    system: { changes },
    flags: { openlegend: { fromBane: name, powerLevel: 0, changeLevels, changeModes } }
  }];
}

function makeBane(name, b) {
  const _id = stableId(`bane:${name}`);
  const attacks = parseAttacks(b.attack);
  const tags = Array.isArray(b.tags) ? b.tags.slice() : [];
  const power = Array.isArray(b.power) ? b.power.slice() : [];
  const powerEffects = parsePowerEffects(power, b.effect || "");
  const headline = cleanText((b.effect || "").split("<ul>")[0]);
  const gameEffects = deriveGameEffects(powerEffects, headline);
  const minPower = power.length ? Math.min(...power) : 0;
  const effects = buildActiveEffects(name, gameEffects, IMG, minPower);

  return {
    _id,
    name,
    type: "bane",
    img: IMG,
    system: {
      description: `<p>${cleanText(b.description)}</p>`,
      effect: (b.effect || "").trim(),
      special: (b.special || "").trim(),
      tags,
      attacks,
      powerLevel: power.length ? Math.min(...power) : 0,
      powerEffects,
      invocationTime: (b.invocationTime || "").trim(),
      duration: (b.duration || "").trim(),
      failDuration: parseFailDuration(b.duration),
      gameEffects
    },
    effects,
    flags: {},
    _stats: { systemId: "tomucatos-open-legend-rpg-system" }
  };
}

async function main() {
  console.log(`[${PACK}] Fetching ${API} ...`);
  const res = await fetch(API);
  if ( !res.ok ) throw new Error(`API request failed: ${res.status} ${res.statusText}`);
  const banes = (await res.json())?.success?.banes;
  if ( !banes || typeof banes !== "object" ) throw new Error("Unexpected API shape — expected success.banes");

  const docs = Object.entries(banes)
    .map(([name, b]) => makeBane(name, b))
    .sort((a, b) => a.name.localeCompare(b.name));
  console.log(`[${PACK}] Building ${docs.length} banes.`);

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
    // Embedded Active Effects must be stored as SEPARATE LevelDB keys
    //   !items.effects!<itemId>.<effectId>
    // and removed from the parent item's body — Foundry loads the embedded
    // collection from those keys, NOT from a nested `effects` array (a nested
    // array is silently ignored, which is why the Effects tab read empty).
    // The _source mirror keeps the nested array for readability.
    const effects = doc.effects ?? [];
    const stored = { ...doc, effects: [] };
    batch.put(`!items!${doc._id}`, stored);
    for ( const ae of effects ) batch.put(`!items.effects!${doc._id}.${ae._id}`, ae);

    const safe = doc.name.replace(/[^a-z0-9]+/gi, "_");
    fs.writeFileSync(path.join(sourceDir, `${safe}_${doc._id}.json`), JSON.stringify(doc, null, 2));
    const aeText = effects.length ? ` [AE: ${effects[0].name}]` : "";
    console.log(`  + ${doc.name}  pl${doc.system.powerLevel}  ${doc.system.attacks.length} attack(s)${aeText}`);
  }
  await batch.write();
  await db.close();

  console.log(`\n[${PACK}] Wrote ${docs.length} banes to packs/${PACK}.`);
  console.log("Add the pack to system.json and restart Foundry to see it.");
}

main().catch(err => {
  console.error("Bane build failed:", err);
  process.exit(1);
});
