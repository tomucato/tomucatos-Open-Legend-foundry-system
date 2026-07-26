/**
 * Alternate Forms (SRD: Alternate Form feat) — implemented as IN-PLACE form swaps on
 * a SINGLE actor / token. A "form" is a stored snapshot of the choices that differ
 * between personae: attribute values, and the feat + action items. Switching forms
 * writes the target form's attributes onto the actor and replaces its feat/action
 * items; the actor, its token, and everything else (inventory, perks/flaws, name,
 * picture) stay the same.
 *
 * Storage (all in flags — no schema/template.json change):
 *   flags.openlegend.forms      Array<{ id, name, attributes, items }>
 *   flags.openlegend.activeForm The id of the currently-loaded form.
 *
 * forms[0] is always the permanent "Main Character" (id "main"). Additional entries
 * are alternate forms. Damage TAKEN is carried across a switch (current HP is
 * re-expressed against the new form's max), since max HP is derived from the
 * (swapped) attributes. Per the feat, a switch never drops HP below 1 — the
 * shortfall is banked in flags.openlegend.formHpExcess so the true damage total
 * survives switching back (no HP refund from the floor).
 */

/** The id of the permanent base form. */
export const MAIN_FORM_ID = "main";

/** The compendium base name of the feat that unlocks alternate forms. */
export const ALTERNATE_FORM_FEAT = "Alternate Form (I - II)";

/** Item types that belong to a form (swapped on switch). Everything else is shared. */
export const SWAP_ITEM_TYPES = ["feat", "action"];

/** Whether a serialized/live item is the Alternate Form feat (matched by baseName). */
function isAlternateFormFeat(item) {
  const sys = item?.system ?? {};
  return (item?.type === "feat") && ((sys.baseName || item.name) === ALTERNATE_FORM_FEAT);
}

/**
 * Whether the actor currently has the Alternate Form feat in its LOADED items (i.e.
 * the active form holds it). Used to decide whether the feat is selectable on this
 * form (you take it on Main, not on a secondary form).
 * @param {Actor} actor
 * @returns {boolean}
 */
export function activeFormHasFeat(actor) {
  return (actor?.items ?? []).some(isAlternateFormFeat);
}

/**
 * Whether ANY of the actor's forms grants alternate-form capability — the live items
 * OR any stored form's serialized items. This is what gates the form bar, so switching
 * to a secondary form that lacks the feat doesn't strand you (you can still switch back
 * to a form that has it).
 * @param {Actor} actor
 * @returns {boolean}
 */
export function hasAlternateFormFeat(actor) {
  if ( activeFormHasFeat(actor) ) return true;
  const stored = actor?.flags?.openlegend?.forms;
  if ( !Array.isArray(stored) ) return false;
  return stored.some(f => (f.items ?? []).some(isAlternateFormFeat));
}

/**
 * A blank attribute map (every attribute at 0), used to seed a new empty form so the
 * actor's attribute keys all exist after a switch.
 * @param {Actor} actor
 * @returns {object}
 */
function blankAttributes(actor) {
  const out = {};
  for ( const key of Object.keys(actor.system?.attributes ?? {}) ) out[key] = { value: 0 };
  return out;
}

/**
 * Per-form profile fields that are NOT shared between forms: archetype and BASE
 * speed. (Initiative is fully derived from Agility, so it follows the swapped
 * attributes automatically — nothing to store.) Speed is read from SOURCE (the
 * editable base), never the derived/penalized value. `name` is still captured for
 * reference/labels but is NEVER written back to the actor — the actor's name and
 * portrait are shared identity across all forms.
 * @param {Actor} actor
 * @returns {{name:string, archetype:string, speed:number}}
 */
function currentProfile(actor) {
  return {
    name: actor.name,
    archetype: actor._source?.system?.archetype ?? actor.system?.archetype ?? "",
    speed: Number(actor._source?.system?.speed?.value ?? actor.system?.speed?.value ?? 0)
  };
}

/** Plain {key: {value}} snapshot of the actor's current attribute values. */
function currentAttributes(actor) {
  const out = {};
  for ( const [key, a] of Object.entries(actor.system?.attributes ?? {}) ) {
    out[key] = { value: Number(a?.value ?? 0) };
  }
  return out;
}

/**
 * Serialized data for the actor's current form-owned items (feats + actions),
 * KEEPING each item's _id so re-entering a form restores its items with the same
 * ids (recreated via {keepId: true}). Stable ids mean external references — hotbar
 * macros, weapon→action links — survive form switches.
 */
function currentFormItems(actor) {
  return actor.items
    .filter(i => SWAP_ITEM_TYPES.includes(i.type))
    .map(i => i.toObject());     // includes _id
}

/**
 * Damage currently taken: (effective max − current) + lethal, PLUS any damage hidden
 * by the switch-time 1-HP floor (flags.openlegend.formHpExcess). The feat sets HP to 1
 * when a switch would drop it below 1; the shortfall is stored as excess so the true
 * damage total survives the round trip (otherwise switching away and back would refund
 * the clamped-off damage). Healing while floored reduces true damage through `value`
 * as normal, so the invariant holds without ever touching the flag in-form.
 */
function damageStateOf(actor) {
  const h = actor.system?.health ?? {};
  const maxBase = Number(h.maxBase ?? h.max ?? 0);
  const lethal = Math.max(0, Number(h.lethal ?? 0));
  const max = Math.max(0, maxBase - lethal);
  const value = Number(h.value ?? 0);
  const excess = Math.max(0, Number(actor.flags?.openlegend?.formHpExcess ?? 0));
  return { damage: Math.max(0, max - value) + excess, lethal };
}

/**
 * The actor's stored forms, guaranteeing a Main Character entry at index 0 that
 * reflects the actor's CURRENT state when no forms have been created yet. Read-only:
 * does not write to the actor (callers persist via {@link writeForms}).
 * @param {Actor} actor
 * @returns {Array<{id:string,name:string,attributes:object,items:object[]}>}
 */
export function getForms(actor) {
  const stored = actor.flags?.openlegend?.forms;
  if ( Array.isArray(stored) && stored.length ) return foundry.utils.deepClone(stored);
  // No forms yet — the current actor IS the Main Character.
  return [{
    id: MAIN_FORM_ID,
    name: "Main Character",                 // tab label (distinct from profile.name)
    img: actor.img,
    tokenImg: actor.prototypeToken?.texture?.src ?? actor.img,
    profile: currentProfile(actor),         // per-form name/archetype/speed
    attributes: currentAttributes(actor),
    items: currentFormItems(actor)
  }];
}

/** The id of the active form (defaults to Main). */
export function activeFormId(actor) {
  return actor.flags?.openlegend?.activeForm ?? MAIN_FORM_ID;
}

/** Persist the forms array + active id. */
async function writeForms(actor, forms, activeId) {
  await actor.update({
    "flags.openlegend.forms": forms,
    "flags.openlegend.activeForm": activeId
  });
}

/**
 * Snapshot the actor's CURRENT attributes + form-items into the active form entry,
 * returning the updated forms array (not yet persisted).
 * @param {Actor} actor
 * @param {Array} forms
 * @param {string} activeId
 * @returns {Array}
 */
function captureInto(forms, actor, activeId) {
  const idx = forms.findIndex(f => f.id === activeId);
  if ( idx < 0 ) return forms;
  forms[idx] = {
    ...forms[idx],
    // Main's portrait IS the actor's img (the shared sidebar identity), so keep it in
    // sync. Alternate forms own their portrait (`img`, edited via the sheet portrait
    // while that form is active → setFormImage), so preserve what the form holds.
    // tokenImg likewise is edited directly into the form (its own picker).
    img: (forms[idx].id === MAIN_FORM_ID) ? actor.img : (forms[idx].img ?? actor.img),
    tokenImg: forms[idx].tokenImg ?? actor.img,
    profile: currentProfile(actor),         // name / archetype / base speed
    attributes: currentAttributes(actor),
    items: currentFormItems(actor)
  };
  return forms;
}

/**
 * Switch the actor to the form `targetId`: capture the current form, then load the
 * target's attributes + items onto the actor, carrying damage-taken across.
 * @param {Actor} actor
 * @param {string} targetId
 * @returns {Promise<boolean>}
 */
export async function switchToForm(actor, targetId) {
  if ( !game.user?.isGM && !actor.isOwner ) {
    ui.notifications?.warn("You don't have permission to change this actor's form.");
    return false;
  }
  const activeId = activeFormId(actor);
  if ( targetId === activeId ) return false;

  let forms = getForms(actor);
  const target = forms.find(f => f.id === targetId);
  if ( !target ) {
    ui.notifications?.warn("That form no longer exists.");
    return false;
  }

  // 1) Capture the current state into the active form.
  forms = captureInto(forms, actor, activeId);

  // 2) Damage carried to the target, computed before mutation.
  const { damage, lethal } = damageStateOf(actor);

  // 3) Replace the form-owned items: delete current feat/action items, recreate target's.
  const removeIds = actor.items.filter(i => SWAP_ITEM_TYPES.includes(i.type)).map(i => i.id);
  if ( removeIds.length ) await actor.deleteEmbeddedDocuments("Item", removeIds);
  const addItems = foundry.utils.deepClone(target.items ?? []);
  // keepId: restore each item with its stored _id so external references (macros,
  // weapon→action links) survive the switch. Ids are unique per form and the form's
  // items were just deleted, so there's no collision.
  if ( addItems.length ) await actor.createEmbeddedDocuments("Item", addItems, { keepId: true });

  // 4) Write the target's attributes + per-form profile (archetype / base speed;
  //    initiative is derived from Agility, so it follows the attributes). The actor's
  //    NAME and PORTRAIT are shared identity — never swapped, so the Actors directory
  //    entry stays the same character. Per-form imagery is applied to TOKENS only,
  //    via the explicit apply-token-image button.
  const attrUpdate = {};
  for ( const [key, a] of Object.entries(target.attributes ?? {}) ) {
    attrUpdate[`system.attributes.${key}.value`] = Number(a?.value ?? 0);
  }
  const profile = target.profile ?? {};
  const profileUpdate = {};
  if ( profile.archetype !== undefined ) profileUpdate["system.archetype"] = profile.archetype;
  if ( profile.speed !== undefined ) profileUpdate["system.speed.value"] = Number(profile.speed) || 0;
  await actor.update({
    ...attrUpdate,
    ...profileUpdate,
    "flags.openlegend.forms": forms,
    "flags.openlegend.activeForm": targetId
  });

  // 5) Carry damage onto the new (now-derived) max. Health max is derived in
  //    prepareDerivedData from the attributes we just wrote, so read it back here.
  //    Per the feat, a switch that would drop HP below 1 sets it to 1 instead — but
  //    the damage hidden by that floor is remembered (formHpExcess), so switching
  //    back doesn't refund it: true damage = (max − value) + excess, and the excess
  //    shrinks naturally as the character heals (healing raises `value` first).
  const maxBase = Number(actor.system?.health?.maxBase ?? actor.system?.health?.max ?? 0);
  const carriedLethal = Math.min(lethal, maxBase);
  const newMax = Math.max(0, maxBase - carriedLethal);
  const rawValue = newMax - damage;
  const newValue = Math.max(1, rawValue);
  const excess = Math.max(0, newValue - rawValue);
  await actor.update({
    "system.health.value": newValue,
    "system.health.lethal": carriedLethal,
    "flags.openlegend.formHpExcess": excess
  });

  actor.sheet?.render(false);
  return true;
}

/**
 * Add a new, EMPTY alternate form (blank attributes, no feats/actions) and switch to
 * it. The current form is captured first so nothing is lost. When `formName` is given
 * (e.g. from the Alternate Form feat's "Form name" choice), it becomes both the tab
 * label AND the form's character name; otherwise an auto label is used.
 * @param {Actor} actor
 * @param {object} [opts]
 * @param {string} [opts.formName]   Name for the new form (tab label + character name).
 * @param {boolean} [opts.switch]    Switch into the new form (default true).
 * @param {string} [opts.featId]     The Alternate Form feat id this form is linked to.
 * @returns {Promise<string|null>}  The new form's id.
 */
export async function addForm(actor, { formName = "", switch: doSwitch = true, featId = "" } = {}) {
  if ( !game.user?.isGM && !actor.isOwner ) return null;
  let forms = getForms(actor);
  forms = captureInto(forms, actor, activeFormId(actor));

  const n = forms.filter(f => f.id !== MAIN_FORM_ID).length + 1;
  const id = foundry.utils.randomID?.() ?? `form-${n}`;
  const label = String(formName || "").trim() || `Alternate Form ${n}`;
  forms.push({
    id, name: label, tier: 1, featId,
    img: actor.img,
    tokenImg: actor.prototypeToken?.texture?.src ?? actor.img,
    // Empty form: its name = the given form name (or "<actor> (label)"), no archetype,
    // default speed.
    profile: { name: label || `${actor.name} (Alternate Form ${n})`, archetype: "", speed: 30 },
    attributes: blankAttributes(actor), items: []
  });

  await writeForms(actor, forms, activeFormId(actor));
  if ( doSwitch ) await switchToForm(actor, id);
  return id;
}

/**
 * The id of the alternate form LINKED to a given Alternate Form feat — by the feat's
 * stored `flags.openlegend.formId`, falling back to a form whose `featId` matches the
 * feat's id. Null if none.
 * @param {Actor} actor
 * @param {Item} feat
 * @returns {string|null}
 */
export function formIdForFeat(actor, feat) {
  const direct = feat?.flags?.openlegend?.formId;
  if ( direct ) return direct;
  const byFeat = (actor?.flags?.openlegend?.forms ?? []).find(f => f.featId && (f.featId === feat?.id));
  return byFeat?.id ?? null;
}

/**
 * Remove an item (by id) from EVERY stored form's serialized items, so a feat/action
 * deleted from the live actor doesn't get resurrected by a later form switch (keepId
 * recreation). No-op when no forms are stored.
 * @param {Actor} actor
 * @param {string} itemId
 * @returns {Promise<void>}
 */
export async function removeItemFromStoredForms(actor, itemId) {
  const stored = actor?.flags?.openlegend?.forms;
  if ( !itemId || !Array.isArray(stored) || !stored.length ) return;
  let changed = false;
  const next = stored.map(f => {
    const items = (f.items ?? []).filter(i => i._id !== itemId);
    if ( items.length !== (f.items ?? []).length ) changed = true;
    return { ...f, items };
  });
  if ( changed ) await actor.update({ "flags.openlegend.forms": next });
}

/**
 * Delete a single alternate form (by id). Main cannot be deleted. If the deleted form
 * is the active one, revert to Main first so the live actor isn't left as that form.
 * When the LAST alternate form is removed, also clear the now-empty forms flags so the
 * bar disappears cleanly. Other forms and ALL feats are left untouched.
 * @param {Actor} actor
 * @param {string} formId
 * @returns {Promise<boolean>}
 */
export async function deleteForm(actor, formId) {
  if ( formId === MAIN_FORM_ID ) {
    ui.notifications?.warn("The Main Character form can't be deleted.");
    return false;
  }
  if ( !game.user?.isGM && !actor.isOwner ) return false;

  if ( activeFormId(actor) === formId ) await switchToForm(actor, MAIN_FORM_ID);

  const remaining = getForms(actor).filter(f => f.id !== formId);
  const stillHasAlternate = remaining.some(f => f.id !== MAIN_FORM_ID);
  if ( stillHasAlternate ) {
    await writeForms(actor, remaining, activeFormId(actor));
  } else {
    // No alternate forms left — drop the flags entirely (clean slate, bar hides).
    await actor.update({ "flags.openlegend.-=forms": null, "flags.openlegend.-=activeForm": null });
  }
  actor.sheet?.render(false);
  return true;
}

/**
 * Rename a form.
 * @param {Actor} actor
 * @param {string} formId
 * @param {string} name
 */
export async function renameForm(actor, formId, name) {
  const forms = getForms(actor);
  const f = forms.find(x => x.id === formId);
  if ( !f ) return;
  f.name = String(name || "").trim() || f.name;
  await writeForms(actor, forms, activeFormId(actor));
}

/** The tier (1 or 2) of a form; Main has no tier (returns 0). */
export function formTier(form) {
  if ( !form || (form.id === MAIN_FORM_ID) ) return 0;
  return Math.max(1, Math.min(2, Math.floor(Number(form.tier) || 1)));
}

/**
 * Set an alternate form's tier (1 or 2). Main has no tier. Captures the current form
 * first so a tier change while editing the form doesn't lose unsaved edits. The tier
 * is 1:1 with the linked Alternate Form feat's purchased tier, so it's synced back
 * onto the feat — the LIVE item when present, and the feat's serialized copy in any
 * stored form snapshot (the feat lives on Main's items, so while an alternate form
 * is loaded it only exists serialized).
 * @param {Actor} actor
 * @param {string} formId
 * @param {number} tier
 */
export async function setFormTier(actor, formId, tier) {
  if ( formId === MAIN_FORM_ID ) return;
  if ( !game.user?.isGM && !actor.isOwner ) return;
  let forms = getForms(actor);
  forms = captureInto(forms, actor, activeFormId(actor));
  const f = forms.find(x => x.id === formId);
  if ( !f ) return;
  f.tier = Math.max(1, Math.min(2, Math.floor(Number(tier) || 1)));

  // Mirror the tier onto the linked feat's serialized copies BEFORE persisting.
  if ( f.featId ) {
    for ( const fm of forms ) {
      const it = (fm.items ?? []).find(i => i._id === f.featId);
      if ( it ) foundry.utils.setProperty(it, "system.purchasedTier", f.tier);
    }
  }
  await writeForms(actor, forms, activeFormId(actor));

  // Mirror onto the live feat item (present while Main is loaded). Guarded so the
  // feat-raise/lower path — which already wrote the feat and then calls here — no-ops.
  const live = f.featId ? actor.items.get(f.featId) : null;
  if ( live && (Number(live.system?.purchasedTier) !== f.tier) ) {
    await live.update({ "system.purchasedTier": f.tier });
  }
  actor.sheet?.render(false);
}

/**
 * The PORTRAIT the sheet should display for the active form: the form's own stored
 * `img` for an alternate form, the actor's img for Main (and as fallback). Never
 * written to `actor.img` — the actor's portrait/sidebar identity stays the Main one.
 * @param {Actor} actor
 * @returns {string}
 */
export function activeFormImage(actor) {
  const forms = getForms(actor);
  const f = forms.find(x => x.id === activeFormId(actor)) ?? forms[0];
  if ( !f || (f.id === MAIN_FORM_ID) ) return actor.img;
  return f.img || actor.img;
}

/**
 * Set the PORTRAIT image for a specific form (edited via the sheet portrait while
 * that form is active). Captures the current form first so concurrent attribute/feat
 * edits aren't lost. Main's portrait is actor.img (edited via core editImage), not here.
 * @param {Actor} actor
 * @param {string} formId
 * @param {string} src
 */
export async function setFormImage(actor, formId, src) {
  if ( formId === MAIN_FORM_ID ) return;
  if ( !game.user?.isGM && !actor.isOwner ) return;
  let forms = getForms(actor);
  forms = captureInto(forms, actor, activeFormId(actor));
  const f = forms.find(x => x.id === formId);
  if ( !f || !src ) return;
  f.img = src;
  await writeForms(actor, forms, activeFormId(actor));
  actor.sheet?.render(false);
}

/**
 * The active form's stored token image (defaults to the actor's portrait).
 * @param {Actor} actor
 * @returns {string}
 */
export function activeTokenImage(actor) {
  const forms = getForms(actor);
  const f = forms.find(x => x.id === activeFormId(actor)) ?? forms[0];
  return f?.tokenImg || f?.img || actor.img;
}

/**
 * Set the token image for a specific form (its own picker on the sheet). Captures the
 * current form first so concurrent attribute/feat edits aren't lost.
 * @param {Actor} actor
 * @param {string} formId
 * @param {string} src
 */
export async function setFormTokenImage(actor, formId, src) {
  if ( !game.user?.isGM && !actor.isOwner ) return;
  let forms = getForms(actor);
  forms = captureInto(forms, actor, activeFormId(actor));
  const f = forms.find(x => x.id === formId);
  if ( !f ) return;
  f.tokenImg = src || f.tokenImg;
  await writeForms(actor, forms, activeFormId(actor));
  actor.sheet?.render(false);
}

/**
 * Push a form's token image onto the actor's placed token(s) on the current
 * scene AND the prototype token (so future tokens use it too). The "toggle"
 * button. Defaults to the ACTIVE form; pass formId to apply another form's
 * image (the sheet passes the previewed form while one is displayed).
 * @param {Actor} actor
 * @param {object} [opts]
 * @param {string|null} [opts.formId]
 * @returns {Promise<boolean>}
 */
export async function applyTokenImage(actor, { formId = null } = {}) {
  if ( !game.user?.isGM && !actor.isOwner ) {
    ui.notifications?.warn("You don't have permission to change this actor's token.");
    return false;
  }
  const form = formId ? getForms(actor).find(f => f.id === formId) : null;
  const src = form ? (form.tokenImg || form.img || actor.img) : activeTokenImage(actor);
  if ( !src ) return false;

  // Prototype token (future placements).
  await actor.update({ "prototypeToken.texture.src": src });

  // Placed token documents on the active scene.
  const tokens = (actor.getActiveTokens?.(true, true) ?? [])
    .filter(t => t.parent === canvas?.scene);
  for ( const t of tokens ) await t.update({ "texture.src": src });

  ui.notifications?.info(tokens.length
    ? `Updated ${tokens.length} token${tokens.length === 1 ? "" : "s"} to the current form's image.`
    : "Prototype token image updated (no token on this scene).");
  return true;
}

/**
 * Write a PATCH into a stored form entry (dotted keys ok, e.g.
 * "attributes.agility.value" or "profile.speed") WITHOUT touching the live
 * actor's own data. The active form is captured first so live edits aren't
 * lost. This is how the sheet's editable form preview persists field edits.
 * @param {Actor} actor
 * @param {string} formId
 * @param {object} patch
 */
export async function updateStoredForm(actor, formId, patch) {
  if ( !game.user?.isGM && !actor.isOwner ) return;
  let forms = getForms(actor);
  forms = captureInto(forms, actor, activeFormId(actor));
  const f = forms.find(x => x.id === formId);
  if ( !f || foundry.utils.isEmpty(patch ?? {}) ) return;
  foundry.utils.mergeObject(f, patch, { performDeletions: true });
  await writeForms(actor, forms, activeFormId(actor));
  actor.sheet?.render(false);
}

/**
 * Add a serialized item (feat/action) to a stored form's snapshot, assigning a
 * fresh _id (snapshot ids must be unique — they're recreated with keepId on a
 * real switch). Returns the new id, or null.
 * @param {Actor} actor
 * @param {string} formId
 * @param {object} itemData
 * @returns {Promise<string|null>}
 */
export async function addItemToForm(actor, formId, itemData) {
  if ( !game.user?.isGM && !actor.isOwner ) return null;
  let forms = getForms(actor);
  forms = captureInto(forms, actor, activeFormId(actor));
  const f = forms.find(x => x.id === formId);
  if ( !f || !itemData ) return null;
  const data = foundry.utils.deepClone(itemData);
  data._id = foundry.utils.randomID();
  f.items = [...(f.items ?? []), data];
  await writeForms(actor, forms, activeFormId(actor));
  actor.sheet?.render(false);
  return data._id;
}

/**
 * Merge CHANGES (dotted keys ok) into one serialized item inside a stored form's
 * snapshot. Used by the preview's feat tier steppers and the patched item sheets.
 * @param {Actor} actor
 * @param {string} formId
 * @param {string} itemId
 * @param {object} changes
 */
export async function updateItemInForm(actor, formId, itemId, changes) {
  if ( !game.user?.isGM && !actor.isOwner ) return;
  let forms = getForms(actor);
  forms = captureInto(forms, actor, activeFormId(actor));
  const f = forms.find(x => x.id === formId);
  const item = (f?.items ?? []).find(i => i._id === itemId);
  if ( !item || foundry.utils.isEmpty(changes ?? {}) ) return;
  const clean = { ...changes };
  delete clean._id;
  foundry.utils.mergeObject(item, clean, { performDeletions: true });
  await writeForms(actor, forms, activeFormId(actor));
  actor.sheet?.render(false);
}

/**
 * Remove one serialized item from a stored form's snapshot.
 * @param {Actor} actor
 * @param {string} formId
 * @param {string} itemId
 */
export async function removeItemFromForm(actor, formId, itemId) {
  if ( !game.user?.isGM && !actor.isOwner ) return;
  let forms = getForms(actor);
  forms = captureInto(forms, actor, activeFormId(actor));
  const f = forms.find(x => x.id === formId);
  if ( !f ) return;
  f.items = (f.items ?? []).filter(i => i._id !== itemId);
  await writeForms(actor, forms, activeFormId(actor));
  actor.sheet?.render(false);
}

/**
 * Build an EPHEMERAL, fully-prepared Actor showing what the actor WOULD look like
 * in the given form, WITHOUT touching the real actor. The form's attributes,
 * profile (archetype / base speed) and feat/action items are laid over a clone;
 * shared data (inventory, perks/flaws, name, portrait) comes through unchanged.
 * The clone belongs to no collection — it cannot be updated and is never the
 * document combat resolution reads, so viewing a form this way has ZERO effect
 * on defenses, rolls, or anything else. The sheet renders from it while a form
 * tab is being viewed/edited; edits persist via the updateStoredForm/
 * addItemToForm/updateItemInForm/removeItemFromForm write-through helpers.
 * @param {Actor} actor
 * @param {object} form   A form entry from {@link getForms}.
 * @returns {Actor|null}
 */
export function previewActorForForm(actor, form) {
  if ( !form ) return null;
  const items = actor.items
    .filter(i => !SWAP_ITEM_TYPES.includes(i.type))
    .map(i => i.toObject())
    .concat(foundry.utils.deepClone(form.items ?? []));
  const updates = { items };
  for ( const [key, a] of Object.entries(form.attributes ?? {}) ) {
    updates[`system.attributes.${key}.value`] = Number(a?.value ?? 0);
  }
  const profile = form.profile ?? {};
  if ( profile.archetype !== undefined ) updates["system.archetype"] = profile.archetype;
  if ( profile.speed !== undefined ) updates["system.speed.value"] = Number(profile.speed) || 0;
  const clone = actor.clone(updates, { keepId: true });

  // Show the HP this form would have after a real transform: the same
  // damage-carry math as switchToForm, against the clone's derived max.
  const { damage, lethal } = damageStateOf(actor);
  const maxBase = Number(clone.system?.health?.maxBase ?? clone.system?.health?.max ?? 0);
  const carriedLethal = Math.min(lethal, maxBase);
  const newMax = Math.max(0, maxBase - carriedLethal);
  clone.updateSource({
    "system.health.value": Math.max(1, newMax - damage),
    "system.health.lethal": carriedLethal
  });
  clone.prepareData();
  return clone;
}

/**
 * The attribute- and feat-point ALLOWANCES for an alternate form, derived from the
 * MAIN form's level budget and the form's tier (SRD: Alternate Form):
 *   Tier 1 — ⌈main attribute points ÷ 2⌉, and 3 feat points.
 *   Tier 2 — same attribute points as main, and (main feat points − 3).
 * Main's allowances come from budgetForLevel(actor level). Returns null for the Main
 * form (it uses its own level budget, not a derived one).
 * @param {Actor} actor
 * @param {object} form   A form entry from {@link getForms}.
 * @returns {{attributePoints:number, featPoints:number, tier:number}|null}
 */
export function formBudget(actor, form) {
  const tier = formTier(form);
  if ( !tier ) return null;                       // Main — no derived budget
  const cfg = CONFIG.OPENLEGEND ?? {};
  const mainLevel = Number(actor.system?.level ?? 1);
  const main = cfg.budgetForLevel ? cfg.budgetForLevel(mainLevel) : { attributePoints: 0, featPoints: 0 };
  if ( tier >= 2 ) {
    return { tier, attributePoints: main.attributePoints, featPoints: Math.max(0, main.featPoints - 3) };
  }
  return { tier, attributePoints: Math.ceil(main.attributePoints / 2), featPoints: 3 };
}
