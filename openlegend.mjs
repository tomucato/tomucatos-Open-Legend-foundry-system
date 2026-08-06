import { OpenLegendActor } from "./module/documents/actor.mjs";
import { OpenLegendItem } from "./module/documents/item.mjs";
import { OpenLegendCombatant } from "./module/documents/combatant.mjs";
import { OpenLegendActiveEffect } from "./module/documents/active-effect.mjs";
import { defineOpenLegendToken } from "./module/canvas/token.mjs";
import { OpenLegendActorSheet } from "./module/sheets/actor-sheet.mjs";
import { OpenLegendItemSheet } from "./module/sheets/item-sheet.mjs";
import { OpenLegendActiveEffectConfig } from "./module/sheets/active-effect-config.mjs";
import { OpenLegendEffectsPanel } from "./module/apps/effects-panel.mjs";
import { OpenLegendDamageTypesConfig } from "./module/apps/damage-types-config.mjs";
import { OPENLEGEND } from "./module/config/index.mjs";
import { rollAction, createActionMacro, rollActionByUuid, rollActorAttribute, rollAttributeByActorUuid, createAttributeMacro, applyDamageToToken, undoDamageToToken, applyLethalDamageToToken, undoLethalDamageToToken, applyHealingToToken, undoHealingToToken, applyRolledToAim, rollInvokeButton, placeAreaTemplate, applyBaneToActor, applyBaneByTokenUuid, applyBaneToTokenAt, undoBaneApply, applyBoonToActor, applyBoonByTokenUuid, applyBoonToTokenAt, applyEffectItemToActor, applyEffectItemToTokenAt, createInvocationMacro, applyInvocationByUuid, retargetActionMessage, attackBaneDialog, postPunisherBaneCard, missDealDamage, missMoveNote, missEffectBaneDialog, resistBanesDialog, resistBanesByActorUuid, createResistMacro, groupResistBanes, hospitalerResist, hospitalerByActorUuid, createHospitalerMacro, lethalRestDialog, groupLethalRest, toggleBattleTrance, toggleBattleTranceByActorUuid, createBattleTranceMacro, onBattleTranceEffectDeleted, recklessAttack, recklessAttackByActorUuid, createRecklessAttackMacro, deathBlowFollowUp, deathBlowReduceToZero, undoDeathBlowZero, deathBlowSilence, slayingKill, crushingKnockdown, autoRollTurnStartEffects, applyPersistentItemBoons } from "./module/dice/action-roll.mjs";
import { openDefendDialog } from "./module/dice/defend.mjs";
import { processAuras, refreshAuraDrawings, clearAuraRoundTracking, removeAuraGrants } from "./module/canvas/aura.mjs";
import { TEMPLATE_AUTOTARGET_SETTING } from "./module/canvas/template-target.mjs";
import { previewAreaTemplate, registerAreaRegionQuery, registerOLConeControl, registerConeKeybinding } from "./module/canvas/template-preview.mjs";
import * as Companion from "./module/companion.mjs";

Hooks.once('init', async function() {
  console.log("OpenLegend | Initializing Open Legend RPG System");

  // Expose system configuration (attribute categories, dice mapping, etc.)
  CONFIG.OPENLEGEND = OPENLEGEND;

  // System API, reachable as `game.openlegend.*`. Generated hotbar macros call
  // rollActionByUuid; the others are exposed for convenience / future use.
  game.openlegend = { rollAction, rollActionByUuid, createActionMacro, rollActorAttribute, rollAttributeByActorUuid, applyDamageToToken, undoDamageToToken, applyLethalDamageToToken, undoLethalDamageToToken, placeAreaTemplate, applyBaneToActor, applyBaneByTokenUuid, applyBaneToTokenAt, undoBaneApply, applyBoonToActor, applyBoonByTokenUuid, applyBoonToTokenAt, applyEffectItemToActor, applyEffectItemToTokenAt, applyInvocationByUuid, attackBaneDialog, missDealDamage, missMoveNote, missEffectBaneDialog, resistBanesDialog, resistBanesByActorUuid, groupResistBanes, hospitalerResist, hospitalerByActorUuid, lethalRestDialog, groupLethalRest, toggleBattleTrance, toggleBattleTranceByActorUuid, recklessAttack, recklessAttackByActorUuid, openDefendDialog, processAuras, refreshAuraDrawings, Companion };

  // Assign document classes
  CONFIG.Actor.documentClass = OpenLegendActor;
  CONFIG.Item.documentClass = OpenLegendItem;
  CONFIG.Combatant.documentClass = OpenLegendCombatant;
  CONFIG.ActiveEffect.documentClass = OpenLegendActiveEffect;
  // Token subclass: draws a stacking condition's level as a number badge on its
  // status-effect icon. Resolved here (init) so the core Token class is ready.
  CONFIG.Token.objectClass = defineOpenLegendToken();

  // Initiative: default formula is a flat d20; the custom Combatant overrides this
  // per-actor with 1d20 + Agility dice (see OpenLegendCombatant).
  CONFIG.Combat.initiative = { formula: "1d20", decimals: 0 };

  // Per-client toggle for the floating effects panel (top-right condition icons).
  // Changing it re-renders the panel so it appears/disappears immediately.
  game.settings.register("tomucatos-open-legend-rpg-system", OpenLegendEffectsPanel.SETTING, {
    name: "Show Effects Panel",
    hint: "Display a column of active condition/effect icons in the top-right of the canvas for the selected token (or your assigned character).",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => game.openlegend?.effectsPanel?.render()
  });

  // Per-client dark theme: restyles the parchment surfaces of the system's
  // sheets, dialogs, and chat cards. Driven purely by a class on <body> so a
  // toggle re-themes every open window without re-rendering anything.
  game.settings.register(OPENLEGEND.SYSTEM_ID, "darkTheme", {
    name: "Dark Theme",
    hint: "Use a dark color scheme for the Open Legend sheets, dialogs, and chat cards. Pairs best with Foundry's own dark interface theme. Per-user setting.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: value => document.body.classList.toggle("ol-dark-theme", value)
  });
  document.body.classList.toggle("ol-dark-theme",
    game.settings.get(OPENLEGEND.SYSTEM_ID, "darkTheme"));

  // User-defined damage types (world setting): an array of {key, label, description,
  // attribute}, merged into the built-in catalog by OPENLEGEND.allDamageTypes* and
  // loaded everywhere damage types appear. Hidden from the basic list (config:false);
  // edited through the menu below. Re-render open item sheets on change so new types
  // appear in their pickers immediately.
  game.settings.register(OPENLEGEND.SYSTEM_ID, OPENLEGEND.CUSTOM_DAMAGE_TYPES_SETTING, {
    scope: "world",
    config: false,
    type: Array,
    default: [],
    onChange: () => {
      // Re-render any open item sheets so new damage types appear in their pickers.
      // ApplicationV2 instances live in foundry.applications.instances (a Map); the
      // legacy ui.windows registry is a fallback.
      const apps = [
        ...(foundry.applications?.instances?.values?.() ?? []),
        ...Object.values(ui.windows ?? {})
      ];
      for ( const app of apps ) {
        if ( (app instanceof OpenLegendItemSheet) && app.rendered ) app.render();
      }
    }
  });

  // Unfiltered damage types: when on, a damaging action's Damage Type picker
  // offers the FULL damage-type catalog instead of only the types grouped under
  // the action's attribute. Re-render open item sheets on change so pickers
  // reflect the new scope immediately.
  game.settings.register(OPENLEGEND.SYSTEM_ID, "unfilteredDamageTypes", {
    name: "Show All Damage Types",
    hint: "Offer every damage type on a damaging action's Damage Type picker, instead of only the types grouped under the action's attribute.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => {
      const apps = [
        ...(foundry.applications?.instances?.values?.() ?? []),
        ...Object.values(ui.windows ?? {})
      ];
      for ( const app of apps ) {
        if ( (app instanceof OpenLegendItemSheet) && app.rendered ) app.render();
      }
    }
  });

  // Area auto-targeting: when on, placing an area (a Region shape) prompts the
  // placer to target the tokens it covers (Friends / Foes / All). World-scoped
  // so the GM enables it for the table; the prompt only ever shows to the user
  // who placed the area (see autoTargetForRegion).
  game.settings.register(OPENLEGEND.SYSTEM_ID, TEMPLATE_AUTOTARGET_SETTING, {
    name: "Auto-Target Area",
    hint: "When you place an area attack template, prompt to target the tokens it covers — choose Friends, Foes, or All.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  // At the START of a combatant's turn, automatically roll its per-turn
  // condition dice — Regeneration's healing and Persistent Damage's damage —
  // posting the same apply cards the conditions' manual roll buttons do.
  game.settings.register(OPENLEGEND.SYSTEM_ID, "autoRollTurnEffects", {
    name: "Auto-Roll Turn Effects",
    hint: "At the start of a combatant's turn, automatically roll its Regeneration healing and Persistent Damage dice (with the usual apply buttons). Turn it off to keep the manual roll buttons only.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // Persistent item boons: at the start of a wielder's turn, auto-apply the boon
  // chosen on an active (equipped) item's Persistent property, at the boon's listed
  // power level, respecting boon uniqueness (a higher-PL same boon is not replaced).
  game.settings.register(OPENLEGEND.SYSTEM_ID, "persistentBoonAutomation", {
    name: "Persistent Item Boon Automation",
    hint: "At the start of a wielder's turn, auto-apply the boon chosen on an equipped item's Persistent property (at the item's listed power level, respecting boon uniqueness and higher-power-level boons). Each item also has its own on/off toggle.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // Consumable items: whether using a Consumable item's Consume button (which
  // invokes one of its listed boons) deletes the item afterward (SRD default).
  // Off → the item is kept after use.
  game.settings.register(OPENLEGEND.SYSTEM_ID, "deleteConsumedItems", {
    name: "Delete Consumed Items",
    hint: "When a Consumable item is used (its boon invoked via the Consume button), delete it. Turn off to keep consumable items after use.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // Expendable items: whether using an Expendable item's inventory Use button
  // (which rolls one of its banes/boons via a temporary action) reduces the
  // stack by one — the last one is deleted (SRD default). Off → the item is
  // kept after use.
  game.settings.register(OPENLEGEND.SYSTEM_ID, "expendExpendableItems", {
    name: "Expend Used Expendable Items",
    hint: "When an Expendable item is used via its inventory Use button, reduce its quantity by one (the last one is deleted). Turn off to keep expendable items after use.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // Provoked bane automation: applying Provoked prompts for the PROVOKING token
  // and stores it on the condition; the afflicted creature's attack rolls that
  // do not target that token are then seeded with the bane's disadvantage
  // (PL − 3). Off → Provoked applies as a plain descriptive condition.
  game.settings.register(OPENLEGEND.SYSTEM_ID, "provokedAutomation", {
    name: "Provoked Bane Automation",
    hint: "When the Provoked bane is applied, ask who provoked the target and store it; the target's attack rolls that do not include the provoker as a target are seeded with the bane's disadvantage (power level − 3).",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // Roll-dialog targeting controls: when on, the action roll dialog offers the
  // targeting mode (single / multiple / area — or the summon count) so the
  // multi-targeting disadvantage can be changed on the fly. The penalty is
  // recomputed live, including the Multi-Target Attack/Boon Specialist feat
  // reductions. Off → the dialog only shows the action's configured targeting
  // as a fixed modifier row (the previous behavior).
  game.settings.register(OPENLEGEND.SYSTEM_ID, "dialogTargeting", {
    name: "Adjust Targeting in the Roll Dialog",
    hint: "Show targeting controls in the action roll dialog (single / multiple / area and their sizes), recomputing the multi-targeting disadvantage — after Multi-Target Specialist feat reductions — as it changes. The rolled card uses the adjusted targeting.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // Item privacy: world items (feats, boons, banes, perks, flaws, weapons, armor,
  // gear) carry a "Private" checkbox that hides them from the system's selection
  // lists (feat/perk/flaw pickers, action boon/bane pickers, extraordinary item
  // boon/bane selects, the inventory Add browser). This setting flips the DEFAULT
  // for newly created world items: on → new items start private.
  game.settings.register(OPENLEGEND.SYSTEM_ID, "createItemsPrivate", {
    name: "Create New Items as Private",
    hint: "New world items (feats, boons, banes, perks, flaws, weapons, armor, gear) start with their Private checkbox on, hiding them from the system's selection lists. Each item's Private checkbox can still be toggled on its sheet.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  // GM-side handler that creates an area Region on request from a non-GM placer
  // (see previewAreaTemplate). Registered here so CONFIG.queries is ready before
  // the first placement.
  registerAreaRegionQuery();

  // User-rebindable keybinding: flip a ghosting frontal cone's alternation side.
  // Must be registered during init (Foundry forbids registering later).
  registerConeKeybinding(OPENLEGEND.SYSTEM_ID);

  // The Damage Types configuration menu (GM-only world setting).
  game.settings.registerMenu(OPENLEGEND.SYSTEM_ID, "damageTypesMenu", {
    name: "Damage Types",
    label: "Configure Damage Types",
    hint: "View the built-in damage types per attribute and add your own. Custom types are available everywhere damage types appear.",
    icon: "fas fa-burst",
    type: OpenLegendDamageTypesConfig,
    restricted: true
  });

  // Register the ApplicationV2 sheet classes via the modern DocumentSheetConfig
  // API (the V1 Actors/Items collection globals are deprecated since v13). In
  // v14 core registers no default sheet for Actor/Item, so there is nothing to
  // unregister — declaring ours with makeDefault is sufficient.
  const { DocumentSheetConfig } = foundry.applications.apps;
  DocumentSheetConfig.registerSheet(Actor, "tomucatos-open-legend-rpg-system", OpenLegendActorSheet, {
    makeDefault: true,
    label: "Open Legend Actor Sheet"
  });
  DocumentSheetConfig.registerSheet(Item, "tomucatos-open-legend-rpg-system", OpenLegendItemSheet, {
    makeDefault: true,
    label: "Open Legend Item Sheet"
  });
  // Active Effect config with a dropdown of valid change keys (instead of the
  // core raw-path text input) and automatic phase assignment per key.
  DocumentSheetConfig.registerSheet(ActiveEffect, "tomucatos-open-legend-rpg-system", OpenLegendActiveEffectConfig, {
    makeDefault: true,
    label: "Open Legend Effect Config"
  });

  // Dropping an action item onto the hotbar should create a macro that ROLLS it,
  // rather than the default "open sheet" macro. The hotbarDrop hook is synchronous
  // and suppresses Foundry's default handling when it returns false. The drop data
  // for an owned item is { type: "Item", uuid: "Actor.<id>.Item.<id>" }, which
  // fromUuidSync resolves immediately (it only blocks on *compendium* embedded
  // docs). So we decide synchronously, then fire the async macro creation.
  Hooks.on("hotbarDrop", (bar, data, slot) => {
    // A bane/boon invocation chip (from a chat card) → an "apply" macro.
    if ( (data?.type === "openlegend.bane") || (data?.type === "openlegend.boon") ) {
      createInvocationMacro(data, slot);    // async; we return false regardless
      return false;                          // suppress the default handling
    }
    // The sheet's Resist control → a "resist banes" macro for that actor.
    if ( data?.type === "openlegend.resist" ) {
      createResistMacro(data, slot);        // async; we return false regardless
      return false;
    }
    // The Battle Trance feat toggle → a toggle macro for that actor.
    if ( data?.type === "openlegend.battleTrance" ) {
      createBattleTranceMacro(data, slot);  // async; we return false regardless
      return false;
    }
    // The Reckless Attack control → a self-damage-then-extra-attack macro.
    if ( data?.type === "openlegend.recklessAttack" ) {
      createRecklessAttackMacro(data, slot); // async; we return false regardless
      return false;
    }
    // An Attributes-tab roll button → a macro that rolls that attribute.
    if ( data?.type === "openlegend.attribute" ) {
      createAttributeMacro(data, slot);      // async; we return false regardless
      return false;
    }
    // The sheet's Hospitaler control → an ally-resist macro for that actor.
    if ( data?.type === "openlegend.hospitaler" ) {
      createHospitalerMacro(data, slot);    // async; we return false regardless
      return false;
    }
    if ( data?.type !== "Item" || !data.uuid ) return;
    const item = foundry.utils.fromUuidSync(data.uuid, { strict: false });
    if ( item?.type !== "action" ) return; // non-action: let core handle it
    createActionMacro(item, slot);          // async; we return false regardless
    return false;                           // suppress the default sheet-toggle macro
  });

  // Removing the Battle Trance tracker effect (from the effects panel or token
  // HUD) deactivates the trance — flip the feat flag off to keep them in sync.
  Hooks.on("deleteActiveEffect", effect => { onBattleTranceEffectDeleted(effect); });

  // Preload Handlebars templates. HandlebarsApplicationMixin also lazy-loads a
  // sheet's parts on first render, but preloading keeps initial opens snappy.
  return foundry.applications.handlebars.loadTemplates([
    "systems/tomucatos-open-legend-rpg-system/templates/actor/character-sheet.html",
    "systems/tomucatos-open-legend-rpg-system/templates/actor/npc-sheet.html",
    "systems/tomucatos-open-legend-rpg-system/templates/actor/boss-sheet.html",
    "systems/tomucatos-open-legend-rpg-system/templates/actor/minion-sheet.html",
    "systems/tomucatos-open-legend-rpg-system/templates/actor/mount-sheet.html",
    "systems/tomucatos-open-legend-rpg-system/templates/item/boon-sheet.html",
    "systems/tomucatos-open-legend-rpg-system/templates/item/bane-sheet.html",
    "systems/tomucatos-open-legend-rpg-system/templates/item/perk-sheet.html",
    "systems/tomucatos-open-legend-rpg-system/templates/item/flaw-sheet.html",
    "systems/tomucatos-open-legend-rpg-system/templates/item/feat-sheet.html",
    "systems/tomucatos-open-legend-rpg-system/templates/apps/effects-panel.html"
  ]);
});

/* -------------------------------------------- */
/*  Effects Panel lifecycle                     */
/* -------------------------------------------- */

/**
 * Create the floating effects panel once the game is ready, expose it on the
 * system API, and render it. It shows the active actor's condition/effect icons
 * top-right of the canvas (see OpenLegendEffectsPanel).
 */
Hooks.once("ready", () => {
  game.openlegend ??= {};
  game.openlegend.effectsPanel = new OpenLegendEffectsPanel();
  game.openlegend.effectsPanel.render(true);

  // Single delegated handler for invocation-roll buttons (Regeneration's
  // healing, Persistent Damage's per-round damage). Bound once on the document
  // so it fires wherever the button appears — chat cards AND inside an applied
  // effect's description (effects panel hover card / actor sheet). The button
  // rolls its dice and posts an Apply Healing / Apply Damage card (see
  // rollInvokeButton) rather than a plain roll.
  document.body.addEventListener("click", ev => {
    const btn = ev.target.closest?.(".ol-roll-invoke");
    if ( !btn ) return;
    ev.preventDefault();
    rollInvokeButton(btn);
  });
});

/**
 * Re-render the effects panel whenever its source could have changed: a token is
 * selected/deselected, the active scene changes, or any Active Effect / Item /
 * Actor on the shown actor is created, updated, or deleted. A light debounce
 * coalesces bursts (e.g. applying several effects at once).
 */
const refreshEffectsPanel = foundry.utils.debounce(() => {
  game.openlegend?.effectsPanel?.render();
}, 50);

Hooks.on("controlToken", refreshEffectsPanel);
Hooks.on("canvasReady", refreshEffectsPanel);
// Sidebar collapse/expand moves the edge the panel anchors to. The hook fires at
// the START of the sidebar's 250ms CSS slide with the TARGET collapsed state —
// set the panel's destination edge immediately so its matching CSS transition
// glides it in parallel with the sidebar (instead of snapping at the end). A
// final measure after the transition corrects any sub-pixel drift.
Hooks.on("collapseSidebar", (_sidebar, collapsed) => {
  const panel = game.openlegend?.effectsPanel;
  if ( !panel?.element ) return;
  panel.reposition(collapsed);
  setTimeout(() => panel.reposition(), 300);
});
window.addEventListener("resize", refreshEffectsPanel);
for ( const doc of ["ActiveEffect", "Item"] ) {
  Hooks.on(`create${doc}`, refreshEffectsPanel);
  Hooks.on(`update${doc}`, refreshEffectsPanel);
  Hooks.on(`delete${doc}`, refreshEffectsPanel);
}
// Token updates can swap the active actor or its effects (e.g. linked status).
Hooks.on("updateActor", refreshEffectsPanel);

/* -------------------------------------------- */
/*  Live Auras (SRD Aura boon)                  */
/* -------------------------------------------- */
// Token movement: re-evaluate aura membership (grant/remove boons, attack entering
// enemies) and keep ring drawings in sync. processAuras() is gated to the active GM
// and guarded against re-entrancy internally; refreshAuraDrawings() is client-local.
Hooks.on("updateToken", (_doc, change) => {
  if ( ("x" in change) || ("y" in change) ) {
    // Movement updates membership, drops boons from anyone who LEFT an aura, and
    // fires a BANE aura's attack against anyone who just ENTERED it. Boons are only
    // granted on turn-end (updateCombat), so no turn-ender id is passed here.
    processAuras();
    refreshAuraDrawings();
  }
});
Hooks.on("createToken", () => { refreshAuraDrawings(); processAuras(); });
Hooks.on("deleteToken", () => { processAuras(); });

/* -------------------------------------------- */
/*  Area auto-targeting                          */
/* -------------------------------------------- */
// When the feature setting is on, placing an area (a v14 Region shape) prompts
// the placer to target the tokens it covers (Friends / Foes / All). This is
// driven DIRECTLY from the placement flow (previewAreaTemplate → autoTargetForRegion
// in module/canvas/template-preview.mjs), so no create hook is needed.

// Add an "OL Cone" button to the Regions scene-control toolbar: one click prompts
// for a length and places the Open Legend grid-square stepped cone.
Hooks.on("getSceneControlButtons", registerOLConeControl);

// An aura effect created/removed (sustain dropped) changes who radiates; redraw the
// ring and re-sweep so granted boons are added/cleaned up.
Hooks.on("createActiveEffect", effect => {
  if ( effect.flags?.openlegend?.aura ) { refreshAuraDrawings(); processAuras(); }
});

// Detection: a Detection condition (a viewer gained/lost the sense) or a
// Detection Aura marker (a token started/stopped radiating) changes what each
// client's user may see — redraw the glows everywhere. Also on enable/disable.
const detectionRelated = effect => {
  const fl = effect.flags?.openlegend ?? {};
  return !!(fl.detection || fl.detectionAura);
};
Hooks.on("createActiveEffect", effect => { if ( detectionRelated(effect) ) refreshAuraDrawings(); });
Hooks.on("deleteActiveEffect", effect => { if ( detectionRelated(effect) ) refreshAuraDrawings(); });
Hooks.on("updateActiveEffect", effect => { if ( detectionRelated(effect) ) refreshAuraDrawings(); });

// Invisible / Concealment: a condition carrying a per-player visibility
// allow-list (flags.openlegend.visibilityAllow) appeared, changed, or ended —
// re-evaluate the bearer's token visibility on THIS client (each client hides
// or shows the token for its own user; see OpenLegendToken#isVisible).
const visibilityRelated = effect => Array.isArray(effect.flags?.openlegend?.visibilityAllow);
const refreshTokenVisibility = effect => {
  if ( !canvas?.ready ) return;
  for ( const token of (effect.parent?.getActiveTokens?.() ?? []) ) {
    token.renderFlags.set({ refreshVisibility: true });
  }
};
Hooks.on("createActiveEffect", effect => { if ( visibilityRelated(effect) ) refreshTokenVisibility(effect); });
Hooks.on("deleteActiveEffect", effect => { if ( visibilityRelated(effect) ) refreshTokenVisibility(effect); });
Hooks.on("updateActiveEffect", effect => { if ( visibilityRelated(effect) ) refreshTokenVisibility(effect); });
/* -------------------------------------------- */
/*  Light boon (token light source)             */
/* -------------------------------------------- */
// A granted Light condition carries flags.openlegend.lightRadius (invoking
// attribute score × 5', stamped in applyBoonToActor). While it exists, the
// bearer's token(s) emit light of that radius; the token's ORIGINAL light
// config is stashed in flags.openlegend.priorLight and restored when the
// condition ends (deleted, nullified, sustain dropped). Token updates are
// world mutations, so both run only on the active GM's client.

/** Make an actor's active tokens shine for a Light condition. */
async function applyLightBoonToTokens(effect) {
  if ( game.users?.activeGM !== game.user ) return;
  const radius = Math.max(0, Number(effect.flags?.openlegend?.lightRadius) || 0);
  const actor = effect.parent;
  if ( !radius || !(actor instanceof Actor) ) return;
  for ( const token of (actor.getActiveTokens?.(false, true) ?? []) ) {
    const prior = token.light?.toObject?.() ?? {};
    await token.update({
      "flags.openlegend.priorLight": prior,
      // Bright out to the boon's radius, dim tapering to twice that.
      light: { ...prior, bright: radius, dim: radius * 2 }
    });
  }
}

/** Restore the original token light when a Light condition ends. */
async function removeLightBoonFromTokens(effect) {
  if ( game.users?.activeGM !== game.user ) return;
  if ( !(Number(effect.flags?.openlegend?.lightRadius) > 0) ) return;
  const actor = effect.parent;
  if ( !(actor instanceof Actor) ) return;
  for ( const token of (actor.getActiveTokens?.(false, true) ?? []) ) {
    const prior = token.flags?.openlegend?.priorLight;
    if ( !prior ) continue;
    await token.update({ light: prior, "flags.openlegend.-=priorLight": null });
  }
}

Hooks.on("createActiveEffect", effect => {
  if ( effect.flags?.openlegend?.lightRadius ) applyLightBoonToTokens(effect);
});
Hooks.on("deleteActiveEffect", effect => {
  if ( effect.flags?.openlegend?.lightRadius ) removeLightBoonFromTokens(effect);
});

Hooks.on("deleteActiveEffect", effect => {
  if ( !effect.flags?.openlegend?.aura ) return;
  refreshAuraDrawings();
  // Clean up the boons this aura granted to allies (its carrier token id is the
  // fromAura marker). The carrier is the effect's parent actor's active token(s).
  const actor = effect.parent;
  const tokenIds = (actor?.getActiveTokens?.() ?? []).map(t => t.id).filter(Boolean);
  for ( const id of tokenIds ) removeAuraGrants(id);
  processAuras();
});
// Combat advance: a turn just ended. Reset the once-per-round tracking, then sweep
// with the ENDER's token id so an aura applies its boon/bane to the creature that
// ended its turn inside (SRD: aura effects trigger on ending a turn in the area).
Hooks.on("updateCombat", (combat, change) => {
  if ( !(("turn" in change) || ("round" in change)) ) return;
  clearAuraRoundTracking();
  processAuras({ endsTurnTokenId: combat.previous?.tokenId ?? "" });
  // Start of the NEW combatant's turn: auto-roll its per-turn condition dice
  // (Regeneration healing / Persistent Damage). World-toggleable; active-GM
  // gated so the rolls post exactly once.
  if ( (game.users?.activeGM === game.user)
    && game.settings.get(OPENLEGEND.SYSTEM_ID, "autoRollTurnEffects")
    && combat.combatant ) {
    autoRollTurnStartEffects(combat.combatant);
  }
  // Persistent item boons: auto-apply an equipped item's chosen Persistent boon to
  // the wielder at the start of their turn. World-toggleable; active-GM gated.
  if ( (game.users?.activeGM === game.user)
    && game.settings.get(OPENLEGEND.SYSTEM_ID, "persistentBoonAutomation")
    && combat.combatant ) {
    applyPersistentItemBoons(combat.combatant);
  }
});
// First canvas paint: draw existing rings and run an initial sweep.
Hooks.on("canvasReady", () => { refreshAuraDrawings(); processAuras(); });

/**
 * Re-label an Apply Damage button to its pristine "Apply N Type" state and
 * re-enable it. Used both at render time and when an Undo reverts it.
 * @param {HTMLButtonElement} btn
 */
function olResetApplyButton(btn) {
  const { damage, damageType, lethal } = btn.dataset;
  btn.classList.remove("is-applied");
  btn.disabled = false;
  const icon = lethal ? "fa-skull" : "fa-heart-crack";
  const tag = lethal ? " (Lethal)" : "";
  btn.innerHTML = `<i class="fas ${icon}"></i> Apply ${damage}${damageType ? ` ${damageType}` : ""}${tag}`;
}

/**
 * Wire the damage buttons on action chat cards:
 *  - Apply Damage (on the roll card): GM subtracts HP and posts a "damage dealt"
 *    message bearing an Undo button. Non-GMs cannot apply (button removed).
 *  - Undo (on the "damage dealt" message): GM adds the HP back, posts a
 *    "reverted" message, and re-enables the original Apply button (located in the
 *    chat log by its shared apply-id).
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
  // Draggable handles (area template + bane) are usable by anyone; wire their
  // dragstart regardless of GM status, before the GM-gated apply controls.
  for ( const handle of html.querySelectorAll(".ol-template-handle") ) {
    handle.addEventListener("dragstart", ev => {
      const payload = handle.dataset.template;
      if ( payload ) ev.dataTransfer.setData("text/plain", payload);
      ev.dataTransfer.effectAllowed = "copy";
    });
  }
  for ( const handle of html.querySelectorAll(".ol-bane-handle") ) {
    handle.addEventListener("dragstart", ev => {
      const payload = handle.dataset.bane;
      if ( payload ) ev.dataTransfer.setData("text/plain", payload);
      ev.dataTransfer.effectAllowed = "copy";
    });
  }
  for ( const handle of html.querySelectorAll(".ol-boon-handle") ) {
    handle.addEventListener("dragstart", ev => {
      const payload = handle.dataset.boon;
      if ( payload ) ev.dataTransfer.setData("text/plain", payload);
      ev.dataTransfer.effectAllowed = "copy";
    });
  }

  // "Interrupt?" button (on damaging/bane attack cards): any user may open the
  // Defend dialog to ward off the attack against a target they own (or, as GM,
  // any target). Not GM-gated, so wire it before the GM-only apply controls.
  for ( const btn of html.querySelectorAll(".ol-interrupt") ) {
    btn.addEventListener("click", ev => {
      ev.preventDefault();
      openDefendDialog(message);
    });
  }

  // Invocation-dice buttons (Heal's healing, Persistent Damage's per-round
  // damage, ...): any user may click to roll the dice to chat. The formula
  // explodes per Open Legend rules (built in renderInvokeRollButton). Healing
  // rolls carry their targets: the rolled card bears per-target Apply Healing
  // buttons (GM-gated, with undo) mirroring the damage flow.
  // NOTE: .ol-roll-invoke buttons are handled by a single delegated document
  // listener (see below), so they work both here on chat cards AND inside an
  // applied effect's description (effects panel / sheet). Not bound per-message.

  const applyButtons = html.querySelectorAll(".ol-apply-damage");
  const undoButtons = html.querySelectorAll(".ol-undo-damage");
  const baneButtons = html.querySelectorAll(".ol-apply-bane");
  const undoBaneButtons = html.querySelectorAll(".ol-undo-bane");
  const boonButtons = html.querySelectorAll(".ol-apply-boon");
  const healButtons = html.querySelectorAll(".ol-apply-healing");
  const undoHealButtons = html.querySelectorAll(".ol-undo-healing");
  const retargetButtons = html.querySelectorAll(".ol-retarget");
  // Margin-10 rider: "+ Bane" on a damaging hit that beat the defense by 10+.
  const attackBaneButtons = html.querySelectorAll(".ol-attack-bane");
  // Battlefield Punisher: "Punish" on a defend card with ≥10 retribution damage.
  const punishButtons = html.querySelectorAll(".ol-defend-punish");
  // "Re-aim" buttons beside a damage/heal apply row: apply to current target /
  // current selection (resolved + permission-checked at click time).
  const aimTargetButtons = html.querySelectorAll(".ol-aim-target");
  const aimSelectedButtons = html.querySelectorAll(".ol-aim-selected");
  // Attack-miss options (SRD "on a miss"): deal-3 / inflict-bane (GM resolution),
  // and move-10 (informational, available to all — like the aim buttons).
  const missDamageButtons = html.querySelectorAll(".ol-miss-damage");
  const missBaneButtons = html.querySelectorAll(".ol-miss-bane");
  const missMoveButtons = html.querySelectorAll(".ol-miss-move");
  // Death Blow (Lethal Strike follow-up): reduce-to-0 / undo / silence (GM resolution).
  const deathBlowZeroButtons = html.querySelectorAll(".ol-deathblow-zero");
  const deathBlowUndoButtons = html.querySelectorAll(".ol-undo-deathblow");
  const deathBlowSilenceButtons = html.querySelectorAll(".ol-deathblow-silence");
  // Crushing Blow: knock-down button on a Forceful-weapon damaging hit (GM resolution).
  const crushingKnockdownButtons = html.querySelectorAll(".ol-crushing-knockdown");
  // Slaying (legendary weapon): "Slay" on a margin-5+ damaging hit (GM resolution).
  const slayingKillButtons = html.querySelectorAll(".ol-slaying-kill");
  if ( !applyButtons.length && !undoButtons.length && !baneButtons.length && !undoBaneButtons.length && !boonButtons.length
    && !healButtons.length && !undoHealButtons.length && !retargetButtons.length
    && !attackBaneButtons.length && !punishButtons.length && !aimTargetButtons.length && !aimSelectedButtons.length
    && !missDamageButtons.length && !missBaneButtons.length && !missMoveButtons.length
    && !deathBlowZeroButtons.length && !deathBlowUndoButtons.length && !deathBlowSilenceButtons.length
    && !crushingKnockdownButtons.length && !slayingKillButtons.length ) return;

  // The "re-aim" apply buttons are available to EVERYONE — they apply healing/damage
  // to whatever the clicker targets/selects, and the apply itself is permission-gated
  // per token (GM, or the token's owner). So a player can roll an item invocation and
  // heal/damage their own character. Wire them before any GM-only stripping.
  for ( const [buttons, aim] of [[aimTargetButtons, "target"], [aimSelectedButtons, "selected"]] ) {
    for ( const btn of buttons ) {
      btn.addEventListener("click", async ev => {
        ev.preventDefault();
        const { kind, damage, healing, damageType, baneUuid, boonUuid, powerLevel, extraordinary, potent } = btn.dataset;
        const amount = kind === "healing" ? Number(healing) : Number(damage);
        const n = await applyRolledToAim({
          kind, aim, amount, damageType: damageType ?? "",
          baneUuid: baneUuid ?? "", boonUuid: boonUuid ?? "", powerLevel: Number(powerLevel) || 0,
          extraordinary: extraordinary === "1", potent: potent === "1"
        });
        if ( n > 0 ) {
          btn.classList.add("is-applied");
          const verb = kind === "healing" ? "Healed"
            : (kind === "bane" ? "Applied bane to" : (kind === "boon" ? "Granted boon to" : "Applied"));
          btn.setAttribute("data-tooltip", `${verb} ${n} ${aim === "selected" ? "selected" : "targeted"} token${n === 1 ? "" : "s"}`);
        }
      });
    }
  }

  // Attack-miss "Move 10'": informational only — post a note that the actor may
  // move without provoking opportunity attacks. Available to everyone (no token
  // automation), so wire it before the GM-only stripping.
  for ( const btn of missMoveButtons ) {
    btn.addEventListener("click", async ev => {
      ev.preventDefault();
      await missMoveNote(btn.dataset.name ?? "");
      btn.classList.add("is-applied");
    });
  }

  // The bound per-target apply/undo + bane/boon + retarget controls are part of the
  // GM's attack-resolution flow: strip them for non-GMs (the aim buttons above cover
  // self-service healing/damage). The aim buttons themselves are left in place.
  if ( !game.user?.isGM ) {
    for ( const b of [...applyButtons, ...undoButtons, ...baneButtons, ...undoBaneButtons, ...boonButtons,
      ...healButtons, ...undoHealButtons, ...retargetButtons, ...attackBaneButtons, ...punishButtons,
      ...missDamageButtons, ...missBaneButtons,
      ...deathBlowZeroButtons, ...deathBlowUndoButtons, ...deathBlowSilenceButtons,
      ...crushingKnockdownButtons, ...slayingKillButtons] ) b.remove();
    return;
  }

  // Slaying (legendary weapon): the GM confirms the target is of the listed
  // creature type — it dies immediately (0 HP, with undo).
  for ( const btn of slayingKillButtons ) {
    btn.addEventListener("click", async ev => {
      ev.preventDefault();
      btn.disabled = true;
      await slayingKill(btn.dataset.tokenUuid, btn.dataset.creatureType ?? "");
      btn.classList.add("is-applied");
      btn.innerHTML = `<i class="fas fa-skull-crossbones"></i> Slain`;
    });
  }

  // Crushing Blow: apply the Knockdown bane to a damaged (and pushed) target.
  for ( const btn of crushingKnockdownButtons ) {
    btn.addEventListener("click", async ev => {
      ev.preventDefault();
      btn.disabled = true;
      await crushingKnockdown(btn.dataset.tokenUuid);
      btn.classList.add("is-applied");
      btn.innerHTML = `<i class="fas fa-person-falling"></i> Knocked down`;
    });
  }

  // Death Blow follow-up controls (GM resolution): reduce-to-0, undo, silence.
  for ( const btn of deathBlowZeroButtons ) {
    btn.addEventListener("click", async ev => {
      ev.preventDefault();
      btn.disabled = true;
      await deathBlowReduceToZero(btn.dataset.tokenUuid, btn.dataset.attackerUuid ?? "");
      btn.classList.add("is-applied");
      btn.innerHTML = `<i class="fas fa-check"></i> Reduced to 0 HP`;
    });
  }
  for ( const btn of deathBlowUndoButtons ) {
    btn.addEventListener("click", async ev => {
      ev.preventDefault();
      await undoDeathBlowZero(btn.dataset.tokenUuid, Number(btn.dataset.hp) || 0);
      btn.disabled = true;
      btn.innerHTML = `<i class="fas fa-rotate-left"></i> Restored`;
    });
  }
  for ( const btn of deathBlowSilenceButtons ) {
    btn.addEventListener("click", async ev => {
      ev.preventDefault();
      btn.disabled = true;
      await deathBlowSilence(btn.dataset.tokenUuid);
      btn.classList.add("is-applied");
      btn.innerHTML = `<i class="fas fa-comment-slash"></i> Silenced`;
    });
  }

  // Attack-miss "Deal 3 damage": apply the flat miss damage to the actor's token.
  for ( const btn of missDamageButtons ) {
    btn.addEventListener("click", async ev => {
      ev.preventDefault();
      await missDealDamage(btn.dataset.tokenUuid);
      btn.classList.add("is-applied");
    });
  }

  // Attack-miss "Inflict bane (PL ≤ 3)": pick a low-power bane, post its card.
  for ( const btn of missBaneButtons ) {
    btn.addEventListener("click", async ev => {
      ev.preventDefault();
      await missEffectBaneDialog({
        tokenUuid: btn.dataset.tokenUuid,
        name: btn.dataset.name ?? "the target",
        actorUuid: btn.dataset.actorUuid ?? ""
      });
      btn.classList.add("is-applied");
    });
  }

  // "+ Bane" (margin-10 rider): open the bane picker for this target, then post a
  // bane card (chip + apply + aim buttons). GM-only.
  for ( const btn of attackBaneButtons ) {
    btn.addEventListener("click", async ev => {
      ev.preventDefault();
      const { actorUuid, tokenUuid, attrScore, total, margin, baneful } = btn.dataset;
      await attackBaneDialog({
        actorUuid, tokenUuid,
        attrScore: Number(attrScore) || 0, total: Number(total) || 0,
        margin: Number(margin) || 0, baneful: baneful ?? ""
      });
    });
  }

  // "Punish" (Battlefield Punisher): post the defender's chosen bane card bound to
  // the attacker (≥10 retribution damage already verified when the button rendered).
  for ( const btn of punishButtons ) {
    btn.addEventListener("click", async ev => {
      ev.preventDefault();
      btn.disabled = true;
      const { actorUuid, tokenUuid, baneName, attrScore, attackerName } = btn.dataset;
      const doc = actorUuid ? await fromUuid(actorUuid) : null;
      const actor = doc?.actor ?? doc;
      await postPunisherBaneCard({
        baneName, attackerTokenUuid: tokenUuid, attackerName,
        attrScore: Number(attrScore) || 0, actor
      });
      btn.classList.add("is-applied");
    });
  }

  // "Change targets": re-resolve THIS roll against the GM's current targets and
  // rewrite the card's per-target section (results, Defend bar, area/bane/boon
  // handles). The roll total is kept; only the targets change.
  for ( const btn of retargetButtons ) {
    btn.addEventListener("click", async ev => {
      ev.preventDefault();
      btn.disabled = true;
      await retargetActionMessage(message);
      // The message re-renders from the update, replacing this button.
    });
  }

  for ( const btn of applyButtons ) {
    btn.addEventListener("click", async ev => {
      ev.preventDefault();
      btn.disabled = true;
      const { applyId, tokenUuid, damage, damageType, lethal, lethalSplit, attackerUuid } = btn.dataset;
      const total = Number(damage);
      const split = Math.max(0, Math.min(total, Math.floor(Number(lethalSplit) || 0)));
      if ( lethal ) {
        // Fully lethal (traps/hazards) — reduces MAX HP only.
        await applyLethalDamageToToken(tokenUuid, total, damageType, applyId);
      } else if ( split > 0 ) {
        // Lethal Strike split: `split` is lethal (max HP), the remainder normal HP.
        await applyLethalDamageToToken(tokenUuid, split, damageType, applyId);
        if ( total - split > 0 ) await applyDamageToToken(tokenUuid, total - split, damageType, applyId);
        // Death Blow (attacker feat): runs AFTER a Lethal Strike — auto-Stun (T2),
        // instant defeat (HP ≤ threshold), and silence offers.
        if ( attackerUuid ) await deathBlowFollowUp(attackerUuid, tokenUuid);
      } else {
        await applyDamageToToken(tokenUuid, total, damageType, applyId);
      }
      btn.classList.add("is-applied");
      const tag = lethal ? " (Lethal)" : (split > 0 ? ` (${split} lethal)` : "");
      btn.innerHTML = `<i class="fas fa-check"></i> Applied ${damage}${damageType ? ` ${damageType}` : ""}${tag}`;
    });
  }

  for ( const btn of baneButtons ) {
    btn.addEventListener("click", async ev => {
      ev.preventDefault();
      btn.disabled = true;
      const { tokenUuid, baneUuid, powerLevel, potent } = btn.dataset;
      await applyBaneByTokenUuid(tokenUuid, baneUuid, Number(powerLevel), potent === "1");
      btn.classList.add("is-applied");
      // Keep the pristine label so the afflicted card's Undo can restore it.
      btn.dataset.origHtml = btn.innerHTML;
      btn.innerHTML = `<i class="fas fa-check"></i> Applied`;
    });
  }

  // Undo (on the "is afflicted by" / "escalates to level N" message): remove the
  // applied condition (or revert the stack level) and re-enable the source Apply
  // button wherever it is in the chat log.
  for ( const btn of undoBaneButtons ) {
    btn.addEventListener("click", async ev => {
      ev.preventDefault();
      btn.disabled = true;
      const { actorUuid, effectIds, itemId, baneName, stackEffectId, prevLevel, tokenUuid, baneUuid } = btn.dataset;
      await undoBaneApply(actorUuid, {
        effectIds: (effectIds ?? "").split(",").filter(Boolean),
        itemId: itemId ?? "",
        baneName: baneName ?? "",
        stackEffectId: stackEffectId ?? "",
        prevLevel: Number(prevLevel) || 0
      });
      btn.innerHTML = `<i class="fas fa-check"></i> Undone`;
      if ( tokenUuid && baneUuid ) {
        const sources = document.querySelectorAll(
          `.ol-apply-bane[data-token-uuid="${CSS.escape(tokenUuid)}"][data-bane-uuid="${CSS.escape(baneUuid)}"]`);
        for ( const source of sources ) {
          source.classList.remove("is-applied");
          source.disabled = false;
          if ( source.dataset.origHtml ) source.innerHTML = source.dataset.origHtml;
        }
      }
    });
  }

  for ( const btn of boonButtons ) {
    btn.addEventListener("click", async ev => {
      ev.preventDefault();
      btn.disabled = true;
      const { tokenUuid, boonUuid } = btn.dataset;
      // Power level: the player may have picked a lower level than the roll's max
      // from the sibling PL dropdown (see renderResultsBlock's ol-boon-pl). Prefer
      // it; fall back to the button's default (highest reached) when there's none.
      const plPick = btn.parentElement?.querySelector(".ol-boon-pl");
      const powerLevel = (plPick && plPick.value !== "") ? plPick.value : btn.dataset.powerLevel;
      // Aura boon: carry the radiate metadata so the granted Aura effect gets
      // flags.openlegend.aura (read by the live-aura engine in module/canvas/aura.mjs).
      const d = btn.dataset;
      const aura = d.auraUuid ? {
        radiateKind: d.auraKind ?? "",
        radiateUuid: d.auraUuid ?? "",
        radiateName: d.auraName ?? "",
        radiatePowerLevel: Number(d.auraPl) || 0,
        radiateResistanceType: d.auraResist ?? "",
        radius: Number(d.auraRadius) || 0,
        attackAttr: d.auraAttr ?? "",
        // Item invocation: the item's value supplies the radiated bane-attack dice.
        itemScore: Number(d.auraItemScore) || 0,
        attackerActorUuid: d.auraAttacker ?? ""
      } : null;
      // Barrier boon: carry the chosen properties + Baneful bane + damage die so the
      // granted effect records them (and offers a damage roll). data-barrier-properties
      // is present (possibly empty) only on a Barrier grant button.
      const barrier = (d.barrierProperties !== undefined) ? {
        properties: d.barrierProperties ?? "",
        damageDie: d.barrierDie ?? "",
        baneUuid: d.barrierBaneUuid ?? "",
        baneName: d.barrierBaneName ?? "",
        banePowerLevel: Number(d.barrierBanePl) || 0,
        powerLevel: Number(powerLevel) || 0
      } : null;
      // Invocation roll context (Restoration's beyond-PL dispel): the achieved
      // total, or an empty total for a Boon Focus auto-success (→ re-roll with
      // the invoker's dice + the feat's advantage).
      const rollCtx = {
        total: ((d.rollTotal ?? "") === "") ? null : Number(d.rollTotal),
        invokerUuid: d.invokerUuid ?? "",
        attrKey: d.attrKey ?? ""
      };
      await applyBoonByTokenUuid(tokenUuid, boonUuid, Number(powerLevel), { aura, barrier, rollCtx });
      btn.classList.add("is-applied");
      btn.innerHTML = `<i class="fas fa-check"></i> Granted PL ${Number(powerLevel) || 0}`;
      if ( plPick ) plPick.disabled = true;   // lock the chosen level after granting
    });
  }

  for ( const btn of undoButtons ) {
    btn.addEventListener("click", async ev => {
      ev.preventDefault();
      btn.disabled = true;
      const { applyId, tokenUuid, damage, damageType, lethal, mountHp, mountLevel } = btn.dataset;
      if ( lethal ) await undoLethalDamageToToken(tokenUuid, Number(damage), damageType);
      // Mount/vehicle: restore the recorded prior HP + damage level exactly (the
      // apply may have rolled over one or more damage levels).
      else if ( mountHp !== undefined ) await undoDamageToToken(tokenUuid, Number(damage), damageType, { mountHp: Number(mountHp), mountLevel: Number(mountLevel) });
      else await undoDamageToToken(tokenUuid, Number(damage), damageType);
      btn.innerHTML = `<i class="fas fa-check"></i> Undone`;
      // Re-enable the source Apply button wherever it is in the chat log.
      if ( applyId ) {
        const source = document.querySelector(`.ol-apply-damage[data-apply-id="${CSS.escape(applyId)}"]`);
        if ( source ) olResetApplyButton(source);
      }
    });
  }

  for ( const btn of healButtons ) {
    btn.addEventListener("click", async ev => {
      ev.preventDefault();
      btn.disabled = true;
      const { applyId, tokenUuid, healing, extraordinary } = btn.dataset;
      await applyHealingToToken(tokenUuid, Number(healing), applyId, { extraordinary: extraordinary === "1" });
      btn.classList.add("is-applied");
      btn.innerHTML = `<i class="fas fa-check"></i> Healed ${healing}`;
    });
  }

  for ( const btn of undoHealButtons ) {
    btn.addEventListener("click", async ev => {
      ev.preventDefault();
      btn.disabled = true;
      const { applyId, tokenUuid, healing, lethalHealed } = btn.dataset;
      await undoHealingToToken(tokenUuid, Number(healing), { lethalHealed: Number(lethalHealed) || 0 });
      btn.innerHTML = `<i class="fas fa-check"></i> Undone`;
      // Re-enable the source Apply Healing button wherever it is in the log.
      if ( applyId ) {
        const source = document.querySelector(`.ol-apply-healing[data-apply-id="${CSS.escape(applyId)}"]`);
        if ( source ) {
          source.classList.remove("is-applied");
          source.disabled = false;
          source.innerHTML = `<i class="fas fa-heart"></i> ${source.dataset.healing}`;
        }
      }
    });
  }
});

/**
 * Handle dropping an area handle (from an action chat card) onto the canvas.
 * The drop payload carries a Region shape descriptor; enter the interactive
 * Region placement at the drop point. Returning false suppresses core's default
 * drop handling for our custom data type.
 */
Hooks.on("dropCanvasData", (canvas, data) => {
  // Our area handle (from a chat card): enter an interactive Region placement
  // starting at the drop point — a live ghost that snaps to the grid, rotates
  // with the wheel, and commits on click — instead of placing blindly.
  if ( data?.type === "openlegend.areaTemplate" && data.template ) {
    previewAreaTemplate(data.template, { x: data.x, y: data.y });
    return false;
  }

  // Our bane handle (from a bane-attack chat card): apply the bane at the chosen
  // power level to the token at the drop point.
  if ( data?.type === "openlegend.bane" && data.baneUuid ) {
    applyBaneToTokenAt(data.baneUuid, data.x, data.y, Number(data.powerLevel) || 0, !!data.potent);
    return false;
  }

  // Our boon handle (from a boon-action chat card): grant the boon at the
  // achieved power level to the token at the drop point.
  if ( data?.type === "openlegend.boon" && data.boonUuid ) {
    applyBoonToTokenAt(data.boonUuid, data.x, data.y, Number(data.powerLevel) || 0);
    return false;
  }

  // Dropping a bane/boon Item (from a compendium/sidebar) onto a token applies it
  // to that character. Core does not handle Item drops on the canvas, so we add
  // it. Peek the type synchronously; do the apply async.
  if ( data?.type === "Item" && data.uuid ) {
    const peek = foundry.utils.fromUuidSync(data.uuid, { strict: false });
    if ( peek?.type === "bane" ) {
      applyBaneToTokenAt(data.uuid, data.x, data.y);
      return false;
    }
    if ( peek?.type === "boon" ) {
      applyBoonToTokenAt(data.uuid, data.x, data.y);
      return false;
    }
    // A standalone "effect" item: clone its Active Effects onto the token.
    if ( peek?.type === "effect" ) {
      applyEffectItemToTokenAt(data.uuid, data.x, data.y);
      return false;
    }
    // none of ours: leave to default (no-op)
  }
});


/**
 * Default new scenes to 5 ft per grid square (Open Legend uses feet). Only fills
 * in the default when the creator didn't explicitly set a grid distance, so a
 * deliberately-configured scene is left untouched. This keeps area templates
 * (which are sized in feet) reading correctly out of the box.
 */
Hooks.on("preCreateScene", (scene, data) => {
  const update = {};
  if ( data?.grid?.distance === undefined ) update["grid.distance"] = 5;
  if ( data?.grid?.units === undefined ) update["grid.units"] = "ft";
  if ( Object.keys(update).length ) scene.updateSource(update);
});

/**
 * Default the world's template rendering to match the Open Legend look:
 *   - cones use the flat-ended style (a straight far edge) rather than Foundry's
 *     curved "round" cones; and
 *   - templates draw their true geometric shape rather than snapping the fill to
 *     whole grid squares (the "Grid-based Template Shapes" setting OFF).
 * Both are world-scope settings only a GM can write. The cone style is flipped
 * once from its "round" default (leaving a deliberate choice alone); grid-shaped
 * templates are forced off so dropped areas render as smooth shapes.
 */
Hooks.once("ready", async () => {
  if ( !game.user?.isGM ) return;
  try {
    if ( game.settings.get("core", "coneTemplateType") === "round" ) {
      await game.settings.set("core", "coneTemplateType", "flat");
    }
    if ( game.settings.get("core", "gridTemplates") === true ) {
      await game.settings.set("core", "gridTemplates", false);
    }
  } catch ( err ) {
    console.warn("OpenLegend | Could not apply default template settings:", err);
  }
});
