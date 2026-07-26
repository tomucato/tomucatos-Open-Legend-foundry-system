#!/usr/bin/env node
/**
 * Build the "boons" compendium pack from the Open Legend boons API.
 *
 *   https://openlegend.heromuster.com/api/boons  ->  { success: { boons: { "<Name>": {...} } } }
 *
 * Mirrors build-banes.mjs. Boons differ from banes mechanically: they are not
 * attacks against a defense. A boon is invoked by an action roll that must beat a
 * fixed Challenge Rating (CR = 10 + 2·PL); the roll determines the highest power
 * level achieved (capped by the invoking attribute). So a boon carries no
 * attack/defense pair — instead it records the attribute(s) that can invoke it.
 *
 * For each boon we scrape the API into a structured Open Legend boon Item:
 *   - attributes:   the invoking attribute(s) (the API `validAttributes`/`attribute`).
 *   - tags:         the API `tags` array (Physical / Mental / Extraordinary, etc.).
 *   - powerEffects: one {powerLevel, effect} per entry in the API `power` array,
 *                   scraping the matching "<li><strong>Power Level N</strong> - ...</li>"
 *                   line from the effect HTML (single-power boons get one entry
 *                   built from the headline effect text).
 *   - powerLevel:   the minimum valid power (headline requirement).
 *   - invocationTime / duration / description / effect: as-is.
 *   - gameEffects:  machine-readable mechanical effects per power level, where the
 *                   effect text is parseable (e.g. an "Advantage N" pattern). The
 *                   drop-on-token wiring reads this.
 *   - effects[]:    the boon's leveled Active Effect (full per-level change table
 *                   + flags.openlegend.changeLevels), seeded from gameEffects.
 *                   This is what gets cloned onto a token when the boon is
 *                   dropped on it, and what the sheet's Effects tab edits.
 *
 * Writes a ClassicLevel (LevelDB) pack at packs/boons + _source/boons JSON.
 * classic-level is imported from the local Foundry install (not a repo dep).
 *
 * Usage:  node scripts/build-boons.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClassicLevel } from "/Users/thomas/repos/FoundryVTT-Node-14.363/node_modules/classic-level/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_ROOT = path.resolve(__dirname, "..");
const API = "https://openlegend.heromuster.com/api/boons";
const PACK = "boons";
const IMG = "icons/svg/aura.svg";

/**
 * Deterministic 16-char id (shared convention with the other builders).
 *
 * Every character of `str` is folded into a single FNV-1a seed FIRST, then each
 * of the 16 output chars is a position-salted avalanche of that whole-string
 * seed. The earlier version derived output char i only from str[i], str[i+16],
 * … so names sharing a prefix (e.g. all "boon:") produced ids sharing a long
 * leading run (26 boons all started "fMZ5"). Compendium embedded effects are
 * keyed `!items.effects!<itemId>.<effectId>` and loaded by a prefix range scan,
 * so shared id prefixes cross-linked effects onto the wrong items — banes/boons
 * showed empty change tables and never applied. This mixes the full string into
 * every position, eliminating those prefix collisions.
 */
function stableId(str) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  // FNV-1a over the whole string → a 32-bit seed influenced by every character.
  let seed = 0x811c9dc5;
  for ( let i = 0; i < str.length; i++ ) {
    seed ^= str.charCodeAt(i);
    seed = Math.imul(seed, 0x01000193) >>> 0;
  }
  // Each output char advances a position-salted xorshift finalizer of the seed.
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

/** Strip tags / entities / whitespace from a snippet of effect HTML. */
function cleanText(s = "") {
  return s.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
}

/**
 * One {powerLevel, effect} per power value. If the effect HTML has per-level
 * "<li><strong>Power Level N</strong> - text</li>" lines, scrape each; otherwise
 * the boon has a single effect, applied to its single power level.
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
 * Boons commonly grant an "Advantage N" on some category of rolls, or a flat
 * bonus to a defense. Where a clean pattern is recognized, the entry is
 * mechanically actionable; everything else is stored descriptively so the data
 * is complete and future patterns can be added without re-scraping. Each entry:
 *   { powerLevel, kind, value, scope, label }
 * kind "advantage" is mechanically actionable; "descriptive" is text-only.
 */
function deriveGameEffects(powerEffects, headlineEffect = "") {
  return powerEffects.map(pe => {
    const text = `${pe.effect} ${headlineEffect}`;
    const adv = /advantage\s+(\d+)/i.exec(text);

    // A blanket "all action rolls" advantage maps to the all-rolls flag the roll
    // dialog reads; "all attacks" is attack-scoped. Conditional / narrow
    // advantages stay descriptive — they can't be a flat global modifier.
    if ( adv && /advantage[^.]*\ball action rolls\b/i.test(text) ) {
      return {
        powerLevel: pe.powerLevel, kind: "advantage", value: Number(adv[1]),
        scope: "all-rolls", label: `Advantage ${adv[1]} on all action rolls`
      };
    }
    if ( adv && /advantage[^.]*\ball attacks\b/i.test(text) ) {
      return {
        powerLevel: pe.powerLevel, kind: "advantage", value: Number(adv[1]),
        scope: "attack-rolls", label: `Advantage ${adv[1]} on all attacks`
      };
    }
    return { powerLevel: pe.powerLevel, kind: "descriptive", value: null, scope: "", label: pe.effect || "" };
  });
}

/**
 * Manual mechanical effects for boons the effect-text parser can't derive into
 * the Subject/Action/Modifier model (see CONFIG.OPENLEGEND.effectSubjects). Each
 * entry is keyed by boon name and lists change rows authored the same way the
 * effect-config sheet authors them:
 *   { key: <subject id>, action: bonus|penalty|override|half|double,
 *     value?: number (omit for half/double), modifier?: flat|advdis (default flat),
 *     level: power level the row unlocks at }
 * These MERGE with the auto-derived "advantage N" rows. For a LEVELED stat
 * (Haste's growing speed/Guard), give one row per tier on the SAME subject —
 * the apply-time engine keeps only the strongest unlocked row per subject, so
 * at PL6 the +20' speed and +2 Guard rows win over the lower-tier ones.
 * @type {Record<string, Array<object>>}
 */
/**
 * Placeholder subject key for a change whose attribute is chosen at drop time.
 * applyBoonToActor (see action-roll.mjs) replaces it with attr.<chosen>. Kept in
 * sync with the same constant there.
 */
const PROMPT_ATTR_KEY = "attr.__prompt__";

/**
 * Boons whose applied effect prompts the user for a SUBJECT at drop time. Value
 * is the prompt kind read by applyBoonToActor. Currently only "attribute".
 * @type {Record<string, string>}
 */
const PROMPT_SUBJECT = {
  Bolster: "attribute"
};

const MANUAL_EFFECTS = {
  // Haste: speed climbs and (from PL4) Guard climbs, per the SRD table.
  Haste: [
    { key: "speed", action: "bonus", value: 10, level: 2 },
    { key: "speed", action: "bonus", value: 15, level: 4 },
    { key: "guard", action: "bonus", value: 1, level: 4 },
    { key: "speed", action: "bonus", value: 20, level: 6 },
    { key: "guard", action: "bonus", value: 2, level: 6 },
    { key: "speed", action: "bonus", value: 30, level: 8 },
    { key: "guard", action: "bonus", value: 3, level: 8 }
  ],
  // Bolster: the user CHOOSES an attribute at drop time (see PROMPT_SUBJECT). The
  // subject is the placeholder PROMPT_ATTR_KEY here; applyBoonToActor rewrites it
  // to attr.<chosen>. Advantage on that attribute's rolls scales with PL.
  Bolster: [
    { key: PROMPT_ATTR_KEY, action: "bonus", value: 1, modifier: "advdis", level: 3 },
    { key: PROMPT_ATTR_KEY, action: "bonus", value: 2, modifier: "advdis", level: 6 },
    { key: PROMPT_ATTR_KEY, action: "bonus", value: 3, modifier: "advdis", level: 8 }
  ]
};

/** Native multiply factor per factor-action (mirrors OPENLEGEND.effectFactorActions). */
const FACTOR = { half: 0.5, double: 2 };

/**
 * Convert one authored manual row to a native change + its mode. bonus → add
 * +|v|; penalty → add −|v|; override → override v; half/double → multiply by the
 * factor (no value/modifier). adv/dis modifier rows keep the sign as authored.
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
 * Seed the boon's Active Effect — the LEVELED condition that is applied to a
 * token when the boon is dropped on it (the sheet's Effects tab shows and
 * edits exactly this). The whole actionable per-level table is written as
 * change rows tagged with their level via flags.openlegend.changeLevels, the
 * same generic leveling every effect supports in the config UI; at apply time
 * only the strongest row per subject the granted power level unlocks is active.
 *
 * Rows come from two sources, merged: the auto-derived "advantage N" game
 * effects (parsed from the effect text) and any hand-authored rows in
 * MANUAL_EFFECTS for mechanics the parser can't reach (flat speed/Guard bonuses).
 *
 * transfer is FALSE: the effect is a template. Dropping the boon on a token
 * clones it onto the actor at the granted power level (see leveledEffectData);
 * the boon item itself is also embedded for reference and must not re-apply.
 * Boons with no parseable mechanics AND no manual rows get a descriptive marker.
 */
function buildActiveEffects(name, gameEffects, img, minPower) {
  const actionable = gameEffects.filter(g => g.kind === "advantage");
  // Auto-derived adv/dis rows: a boon grants ADVANTAGE, so the value is POSITIVE
  // (the sign selects adv vs dis; see resolveTarget / actorRollModifiers).
  const changes = [];
  const changeLevels = [];
  const changeModes = [];
  for ( const g of actionable ) {
    changes.push({
      key: g.scope === "attack-rolls" ? "allAttacks" : "allRolls",
      type: "add",
      value: String(Math.abs(Number(g.value) || 0)),
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
  const flags = { openlegend: { fromBoon: name, powerLevel: 0, changeLevels, changeModes } };
  // Boons that pick their subject at drop time carry the prompt kind; the apply
  // path replaces the PROMPT_ATTR_KEY placeholder with the chosen attr.<key>.
  if ( PROMPT_SUBJECT[name] ) flags.openlegend.promptSubject = PROMPT_SUBJECT[name];

  return [{
    _id: stableId(`boon-ae:${name}`),
    name,
    type: "base",
    img,
    disabled: false,
    transfer: false,
    showIcon: 2 /* CONST.ACTIVE_EFFECT_SHOW_ICON.ALWAYS */,
    system: { changes },
    flags
  }];
}

function makeBoon(name, b) {
  const _id = stableId(`boon:${name}`);
  // Invoking attribute(s): prefer validAttributes, fall back to attribute.
  const attrSrc = Array.isArray(b.validAttributes) && b.validAttributes.length
    ? b.validAttributes
    : (Array.isArray(b.attribute) ? b.attribute : []);
  const attributes = attrSrc.map(s => String(s).trim()).filter(Boolean);
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
    type: "boon",
    img: IMG,
    system: {
      description: `<p>${cleanText(b.description)}</p>`,
      effect: (b.effect || "").trim(),
      tags,
      attributes,
      powerLevel: power.length ? Math.min(...power) : 0,
      powerEffects,
      invocationTime: (b.invocationTime || "").trim(),
      duration: (b.duration || "").trim(),
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
  const boons = (await res.json())?.success?.boons;
  if ( !boons || typeof boons !== "object" ) throw new Error("Unexpected API shape — expected success.boons");

  const docs = Object.entries(boons)
    .map(([name, b]) => makeBoon(name, b))
    .sort((a, b) => a.name.localeCompare(b.name));
  console.log(`[${PACK}] Building ${docs.length} boons.`);

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
    // Embedded Active Effects are stored as SEPARATE LevelDB keys
    //   !items.effects!<itemId>.<effectId>
    // AND the parent body's `effects` field keeps the array of effect IDs (the
    // pointers). The earlier version forced `effects: []`, dropping the pointers
    // — Foundry then showed an empty Changes list for every boon. Keeping the
    // IDs links each boon to its effect record, exactly like a world-authored
    // boon. The _source mirror keeps the full nested objects for readability.
    const effects = doc.effects ?? [];
    const stored = { ...doc, effects: effects.map(e => e._id) };
    batch.put(`!items!${doc._id}`, stored);
    for ( const ae of effects ) batch.put(`!items.effects!${doc._id}.${ae._id}`, ae);

    const safe = doc.name.replace(/[^a-z0-9]+/gi, "_");
    fs.writeFileSync(path.join(sourceDir, `${safe}_${doc._id}.json`), JSON.stringify(doc, null, 2));
    const aeText = effects.length ? ` [AE: ${effects[0].name}]` : "";
    console.log(`  + ${doc.name}  pl${doc.system.powerLevel}  [${doc.system.attributes.join("/")}]${aeText}`);
  }
  await batch.write();
  await db.close();

  console.log(`\n[${PACK}] Wrote ${docs.length} boons to packs/${PACK}.`);
  console.log("Add the pack to system.json and restart Foundry to see it.");
}

main().catch(err => {
  console.error("Boon build failed:", err);
  process.exit(1);
});
