/**
 * World data migrations.
 *
 * Feats copied out of the system compendium (onto an actor, into the Items
 * sidebar, into an alternate form's stored snapshot) keep their OWN copy of
 * `system.tiers[].prerequisites`, so fixing the compendium never reaches them.
 * The steps here bring those copies up to date, once per world, when a GM logs
 * in. Progress is tracked in the world setting `dataVersion`.
 *
 * This module deliberately imports nothing, so the pure helpers can be run
 * outside Foundry.
 */

/** Bump when a new migration step is added below. */
export const DATA_VERSION = 2;

const SETTING = "dataVersion";

/**
 * Compendium feats whose attribute prerequisites shipped (up to v1.1.4) as
 * alternatives although the rules require every one of them. Keyed by base
 * name → the attribute requirements exactly as they shipped. A copy is only
 * corrected while it still matches, so a feat the GM re-worked is left alone.
 */
const AND_ATTRIBUTE_FEATS = {
  "Mimic": [["alteration", 4], ["deception", 3]],
  "Two Weapon Brute": [["agility", 4], ["might", 5]]
};

/** "Mimic — Something" / "Lethal Strike (I - IX)" → the bare feat name. */
function featBaseName(name, system) {
  return String(system?.baseName || name || "")
    .replace(/\s+—\s.*$/, "")
    .replace(/\s*\(.*?\)\s*$/, "")
    .trim();
}

/**
 * Bring one prerequisite tier up to date. Returns the corrected copy, or null
 * when nothing needs to change.
 * @param {object} pre       A tier's `prerequisites`.
 * @param {Array}  [shipped] The feat's entry in AND_ATTRIBUTE_FEATS, if any.
 */
export function migratePrerequisites(pre, shipped) {
  if ( !pre || (typeof pre !== "object") ) return null;
  const attrs = Array.isArray(pre.attribute) ? pre.attribute : [];
  let changed = false;
  let allRequired = false;

  // The short-lived `attributeMode` flag ("all" = every attribute required)
  // became a per-attribute `join`.
  if ( "attributeMode" in pre ) {
    changed = true;
    allRequired = pre.attributeMode === "all";
  }

  // An untouched copy of a feat that should always have required them all.
  if ( !allRequired && shipped
    && (attrs.length === shipped.length)
    && attrs.every((a, i) => (a?.key === shipped[i][0]) && (Number(a?.min) === shipped[i][1]) && (a?.join !== "and")) ) {
    allRequired = true;
  }

  if ( allRequired && attrs.slice(1).some(a => a?.join !== "and") ) changed = true;
  if ( !changed ) return null;

  const { attributeMode, ...rest } = pre;
  return {
    ...rest,
    attribute: attrs.map((a, i) => (allRequired && (i > 0)) ? { ...a, join: "and" } : a)
  };
}

/**
 * Bring a feat's tiers up to date. Returns the new `system.tiers` array, or
 * null when nothing needs to change.
 * @param {string} name    The item's name.
 * @param {object} system  The item's system data (live or serialized).
 */
export function migrateFeatTiers(name, system) {
  const tiers = system?.tiers;
  if ( !Array.isArray(tiers) || !tiers.length ) return null;
  const shipped = AND_ATTRIBUTE_FEATS[featBaseName(name, system)];
  let changed = false;
  const out = tiers.map(t => {
    const pre = migratePrerequisites(t?.prerequisites, shipped);
    if ( !pre ) return t;
    changed = true;
    return { ...t, prerequisites: pre };
  });
  return changed ? out : null;
}

/** Item updates ([{_id, "system.tiers"}]) for the feats among `items`. */
function featUpdates(items) {
  const updates = [];
  for ( const item of (items ?? []) ) {
    if ( item.type !== "feat" ) continue;
    const tiers = migrateFeatTiers(item.name, item.toObject().system);
    if ( tiers ) updates.push({ _id: item.id, "system.tiers": tiers });
  }
  return updates;
}

/** Migrate an actor's owned feats and its stored alternate-form snapshots. */
async function migrateActor(actor) {
  let count = 0;
  const updates = featUpdates(actor.items);
  if ( updates.length ) {
    await actor.updateEmbeddedDocuments("Item", updates);
    count += updates.length;
  }

  // Alternate forms keep serialized feat items in flags.openlegend.forms.
  const forms = actor.flags?.openlegend?.forms;
  if ( Array.isArray(forms) ) {
    let stored = 0;
    const next = forms.map(f => ({
      ...f,
      items: (f.items ?? []).map(i => {
        if ( i?.type !== "feat" ) return i;
        const tiers = migrateFeatTiers(i.name, i.system);
        if ( !tiers ) return i;
        stored++;
        return { ...i, system: { ...i.system, tiers } };
      })
    }));
    if ( stored ) {
      await actor.update({ "flags.openlegend.forms": next });
      count += stored;
    }
  }
  return count;
}

/**
 * Run every migration step over the world: sidebar items, actors (owned feats
 * and alternate forms) and unlinked tokens on every scene. Safe to run again:
 * data that is already current is not touched.
 * @returns {Promise<number>} How many feats were updated.
 */
export async function migrateWorld() {
  let count = 0;
  const attempt = async (label, fn) => {
    try { count += await fn(); }
    catch ( err ) { console.error(`OpenLegend | Migration failed for ${label}:`, err); }
  };

  await attempt("world items", async () => {
    const updates = featUpdates(game.items);
    if ( updates.length ) await Item.updateDocuments(updates);
    return updates.length;
  });
  for ( const actor of game.actors ) {
    await attempt(`actor ${actor.name}`, () => migrateActor(actor));
  }
  for ( const scene of game.scenes ) {
    for ( const token of scene.tokens ) {
      if ( token.actorLink || !token.actor ) continue;
      await attempt(`token ${token.name} (${scene.name})`, () => migrateActor(token.actor));
    }
  }
  return count;
}

/* -------------------------------------------- */
/*  Prerequisites whose reading changed          */
/* -------------------------------------------- */

/*
 * Prerequisite rows are now read top to bottom, each row's "and" / "or"
 * combining it with everything above it, whatever its type; rows that belong
 * together are bracketed into an explicit group. Before that, attributes
 * directly under each other grouped by "and" on their own. A feat saved under
 * the old reading may therefore mean something else now, and nobody but its
 * author knows which meaning was intended: nothing is converted. The helpers
 * below only FIND those feats, so the GM can look at each one.
 *
 * An expression is a requirement's text, or { op: "and"|"or", a, b }.
 */

/** Combine parts ({join, expr}) top to bottom into one expression. */
function foldExpression(parts) {
  return parts.reduce((acc, p) => (acc === null) ? p.expr : { op: p.join, a: acc, b: p.expr }, null);
}

/** The rows read by the current rule, without groups. */
function currentExpression(rows) {
  return foldExpression(rows.map(r => ({ join: r.join, expr: r.text })));
}

/** The rows read the way they were before explicit groups existed. */
function legacyExpression(rows) {
  const terms = [];
  let run = null;
  for ( const r of rows ) {
    if ( r.type !== "attribute" ) { run = null; terms.push({ join: r.join, expr: r.text }); continue; }
    if ( !run ) { run = { join: r.join, groups: [] }; terms.push(run); }
    if ( (r.join === "and") && run.groups.length ) run.groups[run.groups.length - 1].push(r.text);
    else run.groups.push([r.text]);
  }
  for ( const t of terms ) {
    if ( !t.groups ) continue;
    t.expr = foldExpression(t.groups.map(g => ({
      join: "or",
      expr: foldExpression(g.map(text => ({ join: "and", expr: text })))
    })));
  }
  return foldExpression(terms);
}

function evaluateExpression(e, truth) {
  if ( typeof e === "string" ) return truth.get(e);
  const a = evaluateExpression(e.a, truth);
  return (e.op === "or") ? (a || evaluateExpression(e.b, truth)) : (a && evaluateExpression(e.b, truth));
}

function formatExpression(e, parent = null) {
  if ( typeof e === "string" ) return e;
  const text = `${formatExpression(e.a, e.op)} ${e.op} ${formatExpression(e.b, e.op)}`;
  return (parent && (parent !== e.op)) ? `(${text})` : text;
}

/**
 * Whether a prerequisite tier saved before explicit groups existed reads
 * differently now. Returns null when it does not (or when the tier was already
 * saved under the current rule, which always writes `groups`), otherwise how it
 * read before and how it reads now.
 * @param {object} pre   A tier's `prerequisites`.
 * @param {Array}  rows  Its rows, from FEATS.prerequisiteRows(pre).
 * @returns {{before: string, after: string}|null}
 */
export function prerequisiteReadingChange(pre, rows) {
  if ( !pre || (typeof pre !== "object") || Array.isArray(pre.groups) ) return null;
  const complete = (rows ?? [])
    .map(r => (r.type === "attribute")
      ? { ...r, text: (r.attribute?.key || r.attribute?.label) ? `${r.attribute.label || r.attribute.key} ${r.attribute.min}` : "" }
      : r)
    .filter(r => r.text);
  if ( complete.length < 3 ) return null;
  const before = legacyExpression(complete);
  const after = currentExpression(complete);
  const names = [...new Set(complete.map(r => r.text))];
  // Same result for every combination of met / unmet requirements?
  let differs = names.length > 16;
  for ( let bits = 0; !differs && (bits < (1 << names.length)); bits++ ) {
    const truth = new Map(names.map((n, i) => [n, !!(bits & (1 << i))]));
    differs = evaluateExpression(before, truth) !== evaluateExpression(after, truth);
  }
  return differs ? { before: formatExpression(before), after: formatExpression(after) } : null;
}

/** The tiers of a feat whose prerequisites read differently now. */
function changedTiers(system) {
  const rowsOf = CONFIG.OPENLEGEND?.prerequisiteRows;
  const tiers = Array.isArray(system?.tiers) ? system.tiers : [];
  if ( !rowsOf ) return [];
  return tiers.map((t, i) => {
    const change = prerequisiteReadingChange(t?.prerequisites, rowsOf(t?.prerequisites));
    return change ? { tier: i + 1, ...change } : null;
  }).filter(Boolean);
}

/** The tiers with every prerequisite marked as read by the current rule
 *  (rows in their present order, none grouped): the GM accepted the reading. */
function acceptedTiers(system) {
  const rowsOf = CONFIG.OPENLEGEND?.prerequisiteRows;
  return system.tiers.map(t => {
    const pre = t?.prerequisites;
    if ( !pre || (typeof pre !== "object") || Array.isArray(pre.groups) ) return t;
    const rows = rowsOf(pre);
    return { ...t, prerequisites: { ...pre, order: rows.map(r => r.type), groups: rows.map(() => false) } };
  });
}

/**
 * Find every feat in the world whose prerequisites were saved under the old
 * reading and mean something else now: sidebar items, actors' feats and
 * alternate forms, unlinked tokens and the world's own Item compendiums.
 * Nothing is changed. Each entry can be opened (when it has a sheet) or
 * accepted as it reads now.
 * @returns {Promise<Array<{name: string, where: string, tiers: Array, item: Item|null, accept: Function}>>}
 */
export async function findFeatsToReview() {
  const found = [];
  const addItem = (item, where) => {
    if ( item?.type !== "feat" ) return;
    const system = item.toObject().system;
    const tiers = changedTiers(system);
    if ( !tiers.length ) return;
    found.push({
      name: item.name, where, tiers, item,
      accept: () => item.update({ "system.tiers": acceptedTiers(system) })
    });
  };
  const addActor = (actor, where) => {
    for ( const item of actor.items ) addItem(item, where);
    // Alternate forms keep serialized feat items in flags.openlegend.forms.
    const forms = actor.flags?.openlegend?.forms;
    if ( !Array.isArray(forms) ) return;
    forms.forEach((form, fi) => (form?.items ?? []).forEach((stored, ii) => {
      if ( stored?.type !== "feat" ) return;
      const tiers = changedTiers(stored.system);
      if ( !tiers.length ) return;
      found.push({
        name: stored.name, tiers, item: null,
        where: `${where}, alternate form${form?.name ? ` "${form.name}"` : ""} (switch to that form to edit it)`,
        accept: () => {
          const next = foundry.utils.deepClone(actor.flags.openlegend.forms);
          const target = next?.[fi]?.items?.[ii];
          if ( !target || (target.name !== stored.name) ) return;
          target.system.tiers = acceptedTiers(target.system);
          return actor.update({ "flags.openlegend.forms": next });
        }
      });
    }));
  };

  for ( const item of game.items ) addItem(item, "Items sidebar");
  for ( const actor of game.actors ) addActor(actor, `Actor "${actor.name}"`);
  for ( const scene of game.scenes ) {
    for ( const token of scene.tokens ) {
      if ( token.actorLink || !token.actor ) continue;
      addActor(token.actor, `Token "${token.name}" on scene "${scene.name}"`);
    }
  }
  for ( const pack of game.packs ) {
    if ( (pack.metadata.packageType !== "world") || (pack.documentName !== "Item") ) continue;
    try {
      for ( const item of await pack.getDocuments({ type: "feat" }) ) addItem(item, `Compendium "${pack.metadata.label}"`);
    } catch ( err ) {
      console.error(`OpenLegend | Could not read compendium ${pack.collection}:`, err);
    }
  }
  return found;
}

/** Register the world setting that records how far this world has migrated. */
export function registerMigrationSetting(systemId) {
  game.settings.register(systemId, SETTING, {
    name: "Data Version",
    scope: "world",
    config: false,
    type: Number,
    default: 0
  });
}

/**
 * Migrate the world if it is behind DATA_VERSION. Only the active GM runs it,
 * so two connected GMs never migrate at once.
 * @param {string}   systemId
 * @param {object}   [options]
 * @param {Function} [options.onReview]  Called with the feats whose
 *   prerequisites read differently now (see findFeatsToReview), if any.
 */
export async function migrateWorldIfNeeded(systemId, { onReview } = {}) {
  if ( !game.users?.activeGM?.isSelf ) return;
  const current = Number(game.settings.get(systemId, SETTING)) || 0;
  if ( current >= DATA_VERSION ) return;
  const count = await migrateWorld();
  await game.settings.set(systemId, SETTING, DATA_VERSION);
  if ( count ) {
    ui.notifications?.info(`Open Legend: updated the prerequisites of ${count} feat${count === 1 ? "" : "s"} to the current rules.`);
  }
  console.log(`OpenLegend | World migrated to data version ${DATA_VERSION} (${count} feats updated).`);

  // Version 2: prerequisites are read top to bottom with explicit groups. What
  // a feat saved before that was meant to say cannot be known, so nothing is
  // converted: the feats it affects are shown to the GM instead.
  if ( current < 2 ) {
    const review = await findFeatsToReview();
    if ( review.length ) onReview?.(review);
  }
}
