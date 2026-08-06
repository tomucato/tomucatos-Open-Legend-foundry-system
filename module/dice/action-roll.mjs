import { openRollDialog, actorRollModifiers, buildFormula } from "./roll-dialog.mjs";
import { promptNullifyRemoval, promptRestorationDispel } from "../dialogs/bane-dialogs.mjs";
import { selectableDocuments } from "../helpers/utils.mjs";

/**
 * The advantage an attack gains from a weapon's Deadly Extraordinary property:
 * equal to its Deadly value (capped at 3 — "A weapon cannot have a deadly value
 * greater than 3"), but only while the weapon is an EQUIPPED extraordinary item.
 * 0 when the weapon is non-extraordinary, unequipped, or lacks the property.
 * @param {Item} weapon
 * @returns {number}
 */
function deadlyAdvantage(weapon) {
  if ( (weapon?.type !== "weapon") || !weapon.system?.extraordinary || !weapon.system?.equipped ) return 0;
  const prop = (weapon.system.extraordinaryProperties ?? []).find(p => p.name === "deadly");
  if ( !prop ) return 0;
  return Math.max(0, Math.min(3, Math.floor(Number(prop.value) || 0)));
}

/**
 * The advantage a bane/boon invocation gains from an item's Powerful Extraordinary
 * property: equal to its Powerful value (capped at 3), but only while the item is
 * ACTIVE (equipped for weapon/armor; gear always). 0 otherwise.
 * @param {Item} item
 * @returns {number}
 */
function powerfulAdvantage(item) {
  if ( !item?.system?.extraordinary ) return 0;
  if ( ((item.type === "weapon") || (item.type === "armor")) && !item.system.equipped ) return 0;
  const prop = (item.system.extraordinaryProperties ?? []).find(p => p.name === "powerful");
  if ( !prop ) return 0;
  return Math.max(0, Math.min(3, Math.floor(Number(prop.value) || 0)));
}

/**
 * Whether an item's rolls are Unfailing (legendary property): any die rolled
 * when using the item's abilities treats a 1 as its maximum AND explodes.
 * A weapon/armor must be equipped (like the other wielded-property gates);
 * gear qualifies whenever owned.
 * @param {Item} item
 * @returns {boolean}
 */
function itemUnfailing(item) {
  if ( !item?.system?.extraordinary ) return false;
  if ( ((item.type === "weapon") || (item.type === "armor")) && !item.system.equipped ) return false;
  return (item.system.legendaryProperties ?? []).some(p => p?.name === "unfailing");
}

/**
 * The creature type a weapon's Slaying legendary property names, or "" (only
 * for an EQUIPPED extraordinary weapon carrying the property). A damaging
 * attack against that creature type exceeding its defense by 5+ kills outright.
 * @param {Item} weapon
 * @returns {string}
 */
function weaponSlayingType(weapon) {
  if ( (weapon?.type !== "weapon") || !weapon.system?.extraordinary || !weapon.system?.equipped ) return "";
  const prop = (weapon.system.legendaryProperties ?? []).find(p => p?.name === "slaying");
  return prop?.value ? String(prop.value).trim() : "";
}

/**
 * Whether a weapon makes area attacks — it carries an Area property from EITHER
 * source: the built-in Area weapon property (Weapons & Implements) or the Area
 * Extraordinary property. Such a weapon "always makes multi-target area attacks …
 * [which] do not incur any of the disadvantage penalties associated with
 * multi-target attacks."
 * @param {Item} weapon
 * @returns {boolean}
 */
function weaponHasArea(weapon) {
  return !!CONFIG.OPENLEGEND?.weaponAreaDefinition?.(weapon);
}

/**
 * Roll an Open Legend action item to chat.
 *
 * Resolves the action's chosen attribute to its bonus dice from the owning
 * actor's score, opens the roll dialog seeded with the action's own advantage /
 * disadvantage (the player may adjust), and posts a chat card whose flavor notes
 * the attribute and — for damaging / bane actions — the target defense and (for
 * damaging) the damage type.
 *
 * Shared by the actor sheet's action-roll control and the hotbar macro created
 * when an action is dropped on the macro bar, so both behave identically.
 *
 * @param {Item} action            The action item to roll.
 * @param {object} [options]
 * @param {Actor} [options.actor]  The acting actor; defaults to the action's parent.
 * @returns {Promise<ChatMessage|void>}  The created chat message, or void if cancelled / invalid.
 */
export async function rollAction(action, { actor } = {}) {
  if ( !action || (action.type !== "action") ) {
    ui.notifications?.warn("That item is not a rollable action.");
    return;
  }
  actor ??= action.actor ?? action.parent;
  if ( !actor ) {
    ui.notifications?.warn("This action is not owned by an actor, so it cannot be rolled.");
    return;
  }

  // A mount/vehicle at its damage threshold is DISABLED — unable to act until
  // healed or repaired (lower its damage level on the sheet to override).
  if ( CONFIG.OPENLEGEND?.mountDisabled?.(actor) ) {
    ui.notifications?.warn(`${actor.name} is disabled (damage level at its damage threshold) and cannot act until repaired.`);
    return;
  }

  // Compute all derived roll context (bonus dice, the itemized adv/dis sources,
  // toggles, multi-bane, explode mode, lethal-strike, …). Shared with the action
  // sheet's "Dice Modifiers" preview so the breakdown is identical (one source of
  // truth — see {@link prepareActionRoll}).
  const ctx = await prepareActionRoll(action, actor);
  const { cfg, bonusDice, sources, explodeBelowMax, extraD20, extraToggles, autoSuccess, augmentOptions } = ctx;

  // Boon Focus / Multi-Target Boon Expert auto-success: no dialog, no roll — post
  // the success card directly (the helper flagged it).
  if ( autoSuccess ) return postBoonFocusAutoSuccess(autoSuccess);

  // On-the-fly targeting (world setting "dialogTargeting"): offer targeting
  // controls in the dialog for the categories that resolve against targets, so
  // the mode / target count / area can be changed at roll time. The multi-target
  // disadvantage source row is replaced by the dialog's live row (same math:
  // raw penalty minus the matching Multi-Target Specialist feat reduction). An
  // Area weapon locks the action to its area and never incurs the penalty, so
  // it keeps the static behavior.
  const sys = action.system;
  const dialogTargeting = game.settings.get("tomucatos-open-legend-rpg-system", "dialogTargeting")
    && ["damaging", "bane", "boon"].includes(sys.actionCategory ?? "")
    && !ctx.areaWeapon;
  const targeting = dialogTargeting ? {
    targets: sys.targets ?? "single",
    targetCount: Math.max(1, Math.floor(Number(sys.targetCount ?? 2) || 2)),
    summonCount: Math.max(1, Math.floor(Number(sys.summonCount ?? 1) || 1)),
    area: {
      shape: sys.area?.shape ?? "cone",
      length: Math.max(5, Math.floor(Number(sys.area?.length ?? 15) || 15)),
      lines: Math.max(1, Math.floor(Number(sys.area?.lines ?? 1) || 1))
    },
    summon: sys.targets === "summon",
    areaShapes: { ...(cfg.areaShapes ?? { cone: "Cone", line: "Line", cube: "Cube" }) },
    // Live penalty for a candidate targeting — the same derivation the seeded
    // source used (see prepareActionRoll): raw multi-target disadvantage minus
    // the matching Multi-Target Specialist reduction, floored at zero.
    compute: (t) => {
      const tSys = {
        actionCategory: sys.actionCategory, rangeMode: sys.rangeMode,
        targets: t.targets, targetCount: t.targetCount, summonCount: t.summonCount, area: t.area
      };
      const raw = cfg.multiTargetDisadvantage ? cfg.multiTargetDisadvantage(tSys) : 0;
      const reduction = (raw > 0)
        ? ((sys.actionCategory === "boon")
            ? (cfg.multiTargetBoonReduction?.(actor) ?? 0)
            : (cfg.multiTargetAttackReduction?.(actor, tSys) ?? 0))
        : 0;
      return {
        disadvantage: Math.max(0, raw - reduction),
        raw,
        reduction: Math.min(raw, reduction),
        reductionLabel: (sys.actionCategory === "boon") ? "Multi-Target Boon Spec" : "Multi-Target Attack Spec"
      };
    }
  } : null;

  // Open the dialog; it seeds advantage / disadvantage from the sources above.
  // With live targeting controls, the static multi-target row is dropped — the
  // dialog derives and displays that penalty itself.
  const choice = await openRollDialog({
    title: action.name,
    bonusDice,
    sources: targeting ? sources.filter(s => s.kind !== "multiTarget") : sources,
    explodeBelowMax,
    extraD20,
    extraToggles,
    legend: cfg.legendSpendContext?.(actor),
    augmentOptions,
    targeting
  });
  if ( !choice ) return;

  // Targeting adjusted in the dialog: the card (flavor, per-target snapshot,
  // area-template handle) must reflect the CHOSEN targeting, not the action's
  // configured one. Overlay it on a detached copy of the system data — the
  // action item itself is never mutated.
  if ( choice.targeting ) {
    const t = choice.targeting;
    ctx.sys = Object.assign(sys.toObject?.() ?? foundry.utils.deepClone(sys), {
      targets: t.targets,
      targetCount: t.targetCount,
      summonCount: t.summonCount,
      area: t.area
    });
  }

  const roll = await (new Roll(choice.formula, actor.getRollData())).evaluate();
  await cfg.spendLegendPoints?.(actor, choice.legendPoints);

  // Augmenting item picked: expend it (move-action cost, SRD) — quantity decrements
  // or the item is deleted, per the shared expend helper / Delete-Consumed setting.
  if ( choice.augment?.itemId ) {
    const augItem = actor.items.get(choice.augment.itemId);
    if ( augItem ) {
      const outcome = await (cfg.expendItem?.(augItem) ?? "kept");
      const kept = outcome === "kept";
      ui.notifications?.info(`Augmented with ${choice.augment.baneName} — ${kept ? `${augItem.name} kept` : `expended ${augItem.name}`}.`);
    }
  }

  return await finishActionRoll({ action, actor, ctx, choice, roll });
}

/**
 * Build every derived input an action roll needs: the attribute dice, the fully
 * itemized advantage/disadvantage `sources` (weapon grip, feats, active-effect
 * modifiers, multi-targeting, …), the dialog toggles, and the downstream flags
 * the roll/render uses. Pure with respect to the world (reads actor/items/feats);
 * shared by {@link rollAction} (to drive the dialog + card) and the action item
 * sheet (to PREVIEW the same modifiers before the user clicks Roll).
 *
 * Returns `autoSuccess` set to the postBoonFocusAutoSuccess args when the boon
 * invocation should skip the dialog entirely (caller posts the card and returns).
 * @param {Item} action  The action item.
 * @param {Actor} actor  The owning/rolling actor.
 * @returns {Promise<object>}
 */
export async function prepareActionRoll(action, actor, { quiet = false } = {}) {
  const sys = action.system;
  const cfg = CONFIG.OPENLEGEND ?? {};

  // Bonus dice for the action's attribute (same table the sheet uses).
  const attrKey = sys.attribute;
  const attrLabel = cfg.attributeLabels?.[attrKey] ?? attrKey;

  // Item-granted bane/boon invocation: the item's listed VALUE supplies BOTH the
  // power level and the attribute dice — the actor's attribute is not used. The
  // wielder may invoke at a lower power level (system.invokePowerLevel), but the
  // dice are NOT reduced (always rolled at the item's value). When not an item
  // invocation, use the actor's attribute score as usual.
  const itemScore = Math.max(0, Math.min(9, Number(sys.invokeItemScore ?? 0)));
  const fromItemInvocation = itemScore > 0;
  // Attribute Substitution: pick the substituted (primary) score only when the
  // owned feat's tier covers THIS action's purpose. Tier 1 substitutes general
  // (non-attack/defend/invocation) rolls; Tier 2 also covers attack/defend/
  // invocation. The mapping: damaging/bane → attack, boon → invocation,
  // interrupt → defend, anything else → general. (Item invocations use the item
  // value, not the actor's attribute, so they bypass substitution.)
  const substitutionPurpose = ({ damaging: "attack", bane: "attack", boon: "invocation", interrupt: "defend" })[sys.actionCategory] ?? "general";
  const actorAttrScore = cfg.substitutedAttributeScore
    ? cfg.substitutedAttributeScore(actor, attrKey, substitutionPurpose)
    : Math.max(0, Math.min(9, Number(actor.system.attributes?.[attrKey]?.value ?? 0)));
  const score = fromItemInvocation
    ? itemScore
    : Math.max(0, Math.min(9, actorAttrScore));
  // Extraordinary Focus: treat the chosen attribute as one greater for ATTRIBUTE
  // DICE only (not item invocations, which use the item's value; not the score
  // shown on the card). Bump the dice-ladder index, clamped to the ladder max.
  const focusBonus = fromItemInvocation ? 0 : (cfg.extraordinaryFocusBonus?.(actor, attrKey) ?? 0);
  // Martial Focus: an ATTACK with the chosen weapon (or unarmed) AND attribute is
  // treated as one greater for attribute dice (same dice-only bump). The weapon is
  // the one configured on the action (null = unarmed). Only damaging/bane attacks.
  const mfIsAttack = (sys.actionCategory === "damaging") || (sys.actionCategory === "bane");
  const mfWeapon = (mfIsAttack && sys.weaponId) ? actor.items.get(sys.weaponId) : null;
  const martialFocusMatch = mfIsAttack && !fromItemInvocation
    && (cfg.martialFocusMatches?.(actor, { weapon: mfWeapon, attrKey }) ?? false);
  const martialFocusBonus = martialFocusMatch ? 1 : 0;
  const diceScore = Math.max(0, Math.min(cfg.maxScore ?? 10, score + focusBonus + martialFocusBonus));
  const bonusDice = (cfg.attributeDice ?? {})[diceScore] ?? "";
  const invokingItem = fromItemInvocation ? actor.items.get(sys.invokeFromItemId) : null;

  // Multi-targeting / area attacks add derived disadvantage on top of the
  // action's manual disadvantage (see CONFIG.OPENLEGEND.multiTargetDisadvantage).
  // The dialog is seeded with the combined total so the GM sees and can adjust it.
  // EXCEPTION: an Area weapon (built-in OR Extraordinary Area property) "does not
  // incur any of the disadvantage penalties usually associated with
  // multi-targeting" — so a selected Area weapon zeroes it.
  const areaWeapon = sys.weaponId ? weaponHasArea(actor.items.get(sys.weaponId)) : false;
  const multiTargetRaw = areaWeapon ? 0 : (cfg.multiTargetDisadvantage ? cfg.multiTargetDisadvantage(sys) : 0);
  // Multi-targeting disadvantage reduction, by category:
  //  - ATTACKS (damaging/bane): Multi-Target Attack Specialist (matching mode tier).
  //  - BOONS: Multi-Target Boon Specialist (per-tier, all boons).
  const mtReduction = (multiTargetRaw > 0)
    ? ((sys.actionCategory === "boon")
        ? (cfg.multiTargetBoonReduction?.(actor) ?? 0)
        : (cfg.multiTargetAttackReduction?.(actor, sys) ?? 0))
    : 0;
  const multiTarget = Math.max(0, multiTargetRaw - mtReduction);
  // Multi-Target Boon Expert (feat): when the Boon Specialist reduction COMPLETELY
  // negates a boon's multi-targeting disadvantage AND the actor has Boon Focus for
  // this boon, the multi-target invocation auto-succeeds (resolved after Boon Focus
  // is computed below).
  const boonFullyNegated = (sys.actionCategory === "boon") && (multiTargetRaw > 0)
    && (multiTarget === 0) && (cfg.hasMultiTargetBoonExpert?.(actor) ?? false);

  // Boss Edge: a boss actor adds advantage equal to its edge to ALL of its attack
  // rolls (damaging and bane actions — the categories resolved against a defense).
  // It stacks on top of the action's own advantage and seeds the dialog so the GM
  // sees and can adjust it. Non-attack actions (boon / interrupt) get no edge.
  const isAttack = (sys.actionCategory === "damaging") || (sys.actionCategory === "bane");
  const bossEdge = (actor.type === "boss" && isAttack)
    ? Math.max(0, Math.floor(Number(actor.system.bossEdge ?? 0)))
    : 0;

  // Multi-Bane Specialist (feat): when toggled on for a bane action AND the actor
  // owns the feat, the attack applies the feat's chosen PAIR with one roll. We
  // resolve the pair to live bane data; bane #1 overrides the action's single bane,
  // bane #2 rides along as an "extra bane" through the snapshot / per-target rows.
  // Both banes are inflicted on a hit vs the action's configured target defense and
  // are resisted independently. (Bane Focus benefits only when the actor has Bane
  // Focus for BOTH banes — enforced below.)
  let multiBane = null;
  if ( (sys.actionCategory === "bane") && sys.multiBane && (cfg.hasMultiBaneSpecialist?.(actor)) ) {
    // Use the action's chosen pair (system.multiBanePair); falls back to the first
    // owned pair when unset or no longer owned.
    multiBane = await cfg.resolveMultiBanePair?.(actor, { pairValue: sys.multiBanePair }) ?? null;
    if ( !multiBane && !quiet ) ui.notifications?.warn("Multi-Bane Specialist: could not resolve both banes — applying the action's single bane.");
  }

  // Wielded weapon + grip, configured on the action sheet (Weapons & Implements
  // rules): two-handed melee grants advantage 1 to all attacks; dual wielding
  // one-handed weapons grants advantage 1. A Defensive item forfeits BOTH ("you
  // don't gain the advantage 1 to attacks normally associated with Melee
  // One-handed or Two-handed weapons"). The grip is re-normalized against the
  // weapon's current categories in case they changed since it was configured.
  let weapon = null;
  let grip = "";
  let gripAdv = 0;
  let weaponBaneAdv = 0;
  let deadlyAdv = 0;
  if ( isAttack && sys.weaponId ) {
    const w = actor.items.get(sys.weaponId);
    if ( w?.type === "weapon" ) {
      weapon = w;
      const hands = cfg.weaponHandsFor ? cfg.weaponHandsFor(w.system.categories ?? []) : 1;
      const twoHanded = hands === 2;
      grip = sys.grip || "one-handed";
      // A two-handed weapon is locked to two-handed UNLESS the actor has Two Weapon
      // Brute (which lets it be wielded one-handed → dual-wield is allowed).
      if ( twoHanded && !(cfg.hasTwoWeaponBrute?.(actor) && (grip === "dual-wield")) ) grip = "two-handed";
      else if ( (grip === "two-handed") && (hands !== "versatile") && !twoHanded ) grip = "one-handed";
      const defensive = (w.system.properties ?? []).some(p => p.key === "defensive");
      // Wielding advantage (shared helper): two-handed → 1; dual-wield → 1, or 2 when
      // dual-wielding a two-handed weapon with Two Weapon Brute. Defensive forfeits it.
      gripAdv = cfg.gripWieldingAdvantage
        ? cfg.gripWieldingAdvantage(actor, { grip, twoHanded, defensive })
        : (!defensive && ((grip === "two-handed") || (grip === "dual-wield")) ? 1 : 0);

      // Weapon-bane synergy: inflicting one of the weapon's listed banes grants
      // advantage 1 on the bane attack (matched by name — embedded weapons may
      // carry stale compendium uuids).
      if ( (sys.actionCategory === "bane") && sys.baneName ) {
        const listed = (w.system.banes ?? []).some(b =>
          String(b.name ?? "").toLowerCase() === String(sys.baneName).toLowerCase()
        );
        if ( listed ) weaponBaneAdv = 1;
      }

      // Deadly (Extraordinary property): an attack made with this weapon gains
      // advantage equal to its Deadly value, on BOTH damaging and bane attacks.
      // Only an active (equipped) extraordinary weapon grants it; value capped at 3.
      deadlyAdv = deadlyAdvantage(w);
    }
  }

  // Powerful (Extraordinary): a bane/boon invocation made WITH an item that has
  // the Powerful property gains advantage equal to its value. The item is chosen
  // on the action sheet (system.powerfulItemId); only active items count.
  let powerfulAdv = 0;
  let powerfulItem = null;
  if ( ((sys.actionCategory === "bane") || (sys.actionCategory === "boon")) && sys.powerfulItemId ) {
    const it = actor.items.get(sys.powerfulItemId);
    const v = powerfulAdvantage(it);
    if ( v > 0 ) { powerfulItem = it; powerfulAdv = v; }
  }

  // Defend interrupts rolled straight from the sheet: a wielded Defensive
  // weapon grants advantage equal to its Defensive value (capped at 3). Defensive
  // Mastery raises the effective value by 1 (1→2, 2→3).
  let defendAdv = 0;
  let defendWeapon = null;
  if ( (sys.actionCategory === "interrupt") && (sys.interruptType === "defend") && sys.weaponId ) {
    const w = actor.items.get(sys.weaponId);
    const v = (w?.type === "weapon") ? (cfg.effectiveDefensiveValue ? cfg.effectiveDefensiveValue(w, actor) : 0) : 0;
    if ( v > 0 ) {
      defendWeapon = w;
      defendAdv = v;
    }
  }

  // Itemize every advantage / disadvantage source. The dialog renders this
  // breakdown AND derives its starting values from it, so the player sees
  // exactly how the seeded numbers came to be before adjusting them.
  const sources = [];
  if ( Number(sys.advantage ?? 0) > 0 ) sources.push({ label: "Action", advantage: Number(sys.advantage) });
  if ( Number(sys.disadvantage ?? 0) > 0 ) sources.push({ label: "Action", disadvantage: Number(sys.disadvantage) });
  if ( multiTarget > 0 ) {
    const base = (sys.targets === "area")
      ? `Area (${cfg.areaShapes?.[sys.area?.shape] ?? sys.area?.shape ?? "area"})`
      : (sys.targets === "summon")
        ? `Summoning ${Math.max(1, Math.floor(Number(sys.summonCount ?? 1)))} creatures`
        : `Multiple targets (${Math.max(0, Math.floor(Number(sys.targetCount ?? 0)))})`;
    // Note the Multi-Target Specialist reduction when it partially applies.
    const specName = (sys.actionCategory === "boon") ? "Multi-Target Boon Spec" : "Multi-Target Attack Spec";
    const label = mtReduction > 0 ? `${base} − ${specName} ${mtReduction}` : base;
    // Tagged so rollAction can swap this row for the dialog's live targeting
    // controls (world setting "dialogTargeting") without re-deriving it.
    sources.push({ label, disadvantage: multiTarget, kind: "multiTarget" });
  }
  if ( bossEdge > 0 ) sources.push({ label: "Boss Edge", advantage: bossEdge });
  if ( gripAdv > 0 ) {
    const label = (grip === "dual-wield")
      ? ((gripAdv >= 2)
        ? `Two Weapon Brute — dual two-handed (${weapon.name})`
        : `Dual wielding (${weapon.name})`)
      : `Two-handed (${weapon.name})`;
    sources.push({ label, advantage: gripAdv });
  }
  if ( weaponBaneAdv > 0 ) sources.push({ label: `Weapon bane — ${sys.baneName} (${weapon.name})`, advantage: weaponBaneAdv });
  if ( deadlyAdv > 0 ) sources.push({ label: `Deadly ${deadlyAdv} (${weapon.name})`, advantage: deadlyAdv });
  if ( powerfulAdv > 0 ) sources.push({ label: `Powerful ${powerfulAdv} (${powerfulItem.name})`, advantage: powerfulAdv });
  if ( defendAdv > 0 ) {
    const masteryTag = (cfg.hasDefensiveMastery && cfg.hasDefensiveMastery(actor)) ? " + Mastery" : "";
    sources.push({ label: `Defensive weapon${masteryTag} (${defendWeapon.name})`, advantage: defendAdv });
  }
  // Defensive Reflexes (feat): advantage 1 per tier on any defend action's roll
  // (regardless of weapon).
  if ( (sys.actionCategory === "interrupt") && (sys.interruptType === "defend") ) {
    const dr = cfg.defensiveReflexesAdvantage ? cfg.defensiveReflexesAdvantage(actor) : 0;
    if ( dr > 0 ) sources.push({ label: `Defensive Reflexes (tier ${dr})`, advantage: dr });
  }
  // Attack Specialization (feat): a DAMAGING attack gains advantage equal to the
  // tier of each owned Attack Specialization whose chosen weapon base type / damage
  // type matches this attack. Not for bane/boon invocations.
  if ( sys.actionCategory === "damaging" ) {
    const spec = cfg.attackSpecializationAdvantage
      ? cfg.attackSpecializationAdvantage(actor, { weapon, damageType: sys.damageType })
      : { value: 0, labels: [] };
    if ( spec.value > 0 ) {
      sources.push({ label: `Attack Specialization (${spec.labels.join(", ")})`, advantage: spec.value });
    }
  }
  // Bane Focus (feat): a BANE attack to inflict the feat's chosen bane gains
  // advantage 2 on the roll.
  if ( sys.actionCategory === "bane" ) {
    if ( multiBane ) {
      // Multi-bane attack: Bane Focus applies only if the actor has Bane Focus for
      // BOTH banes (per the feat's Special). The advantage is the single Bane Focus
      // bonus (2), not summed — it's one attack roll.
      const focusNames = cfg.baneFocusNames ? cfg.baneFocusNames(actor) : new Set();
      const bothFocused = multiBane.banes.every(b => focusNames.has(String(b.name).toLowerCase()));
      if ( bothFocused ) {
        sources.push({ label: `Bane Focus — ${multiBane.banes.map(b => b.name).join(" & ")}`, advantage: 2 });
      }
    } else {
      const baneFocusAdv = cfg.baneFocusAdvantage ? cfg.baneFocusAdvantage(actor, sys.baneName) : 0;
      if ( baneFocusAdv > 0 ) {
        sources.push({ label: `Bane Focus — ${sys.baneName}`, advantage: baneFocusAdv });
      }
    }
  }
  // Battle Trance (feat, toggled on): advantage 1 on all attacks (damaging + bane).
  if ( isAttack && cfg.battleTranceActive && cfg.battleTranceActive(actor) ) {
    sources.push({ label: "Battle Trance", advantage: 1 });
  }
  // Provoked (bane, stored provoker): the bearer's ATTACK that does not include
  // the provoker among its CURRENT targets is seeded with the bane's
  // disadvantage — PL − 3 (PL 4 → 1 … PL 9 → 6). Targeting the provoker (among
  // any others) clears it. Gated by the "provokedAutomation" world setting; the
  // seeded value is adjustable in the dialog like any other source.
  if ( isAttack && game.settings.get("tomucatos-open-legend-rpg-system", "provokedAutomation") ) {
    const targetUuids = new Set(actionTargetTokens().map(t => t.document?.uuid));
    for ( const e of (actor.appliedEffects ?? []) ) {
      const fl = e.flags?.openlegend ?? {};
      if ( (fl.fromBane !== "Provoked") || !fl.provoker?.tokenUuid ) continue;
      if ( targetUuids.has(fl.provoker.tokenUuid) ) continue;
      const dis = Math.max(1, Math.floor(Number(fl.powerLevel) || 4) - 3);
      sources.push({ label: `Provoked — not targeting ${fl.provoker.name}`, disadvantage: dis });
    }
  }
  // Martial Focus (feat): a matching attack (chosen weapon/unarmed + attribute) gets
  // the +1 attribute-dice step above; EVERY OTHER attack — damaging or bane, with any
  // other weapon/attribute — suffers disadvantage 1. (Item invocations bypass it.)
  if ( isAttack && !fromItemInvocation && cfg.martialFocus?.(actor) && !martialFocusMatch ) {
    sources.push({ label: "Martial Focus — not your focus", disadvantage: 1 });
  }
  // Boon Focus (feat): the actor is specialized in a particular boon. Resolve the
  // benefit for this invocation (matched by boon name, scaled by tier + targeting
  // mode). It contributes multi-targeting advantage to the dialog and, on a SINGLE
  // target, makes the invocation auto-succeed (handled below, before the dialog).
  let focus = null;
  if ( sys.actionCategory === "boon" && cfg.boonFocus ) {
    // The boon's duration governs the Tier-3 advantage split (Sustain Persists → 4,
    // else 5). Resolve the boon doc by uuid; fall back to no duration if missing.
    let boonDoc = sys.boonUuid ? await fromUuid(sys.boonUuid) : null;
    // Summoning ONE creature carries no multi-target penalty and reads as a
    // single-target invocation for Boon Focus (auto-success); summoning more is
    // multi-targeting (advantage scale).
    const focusTargets = (sys.targets === "summon")
      ? ((Math.max(1, Math.floor(Number(sys.summonCount ?? 1))) <= 1) ? "single" : "multiple")
      : sys.targets;
    focus = cfg.boonFocus(actor, {
      boonName: sys.boonName,
      duration: boonDoc?.system?.duration ?? "",
      targets: focusTargets
    });
    if ( focus && (focus.advantage > 0) ) {
      sources.push({ label: `Boon Focus — ${sys.boonName} (Tier ${focus.tier})`, advantage: focus.advantage });
    }
  }
  // Hospitaler (feat): advantage 1 whenever the actor invokes the Restoration boon.
  if ( (sys.actionCategory === "boon") && cfg.hasHospitaler && cfg.hasHospitaler(actor)
    && /restoration/i.test(String(sys.boonName ?? "")) ) {
    sources.push({ label: "Hospitaler — Restoration", advantage: 1 });
  }

  // Mount/vehicle weapon properties (SRD Mounts & Vehicles), on the MOUNT's own
  // attacks. Guided Weapons: an attack vs Guard made with an attribute above zero
  // rolls an EXTRA d20 and keeps the higher ("1d20x" → "2d20kh1x") — a d20-level
  // reroll, NOT Open Legend advantage (which affects the bonus dice). Targeted
  // Weapons: when the pilot's Agility exceeds the vehicle's attacking attribute,
  // the attack gets advantage equal to the difference. The pilot is chosen PER
  // ACTION (the action sheet's Pilot select, offering the mount's linked pilot
  // slots); the pilot actor's LIVE Agility score is read at roll time.
  let extraD20 = 0;
  if ( (actor.type === "mount") && isAttack ) {
    const props = actor.system?.properties ?? {};
    const mountScore = fromItemInvocation
      ? itemScore
      : Number(actor.system.attributes?.[attrKey]?.value ?? 0);
    if ( props.guidedWeapons && (sys.targetDefense === "guard") && (mountScore > 0) ) {
      extraD20 = 1;
      sources.push({ label: "Guided Weapons (vs Guard)", note: "+1d20, keep highest" });
    }
    if ( props.targetedWeapons && sys.pilotUuid ) {
      const pilotDoc = await fromUuid(sys.pilotUuid).catch(() => null);
      const pilotAgility = Number(pilotDoc?.system?.attributes?.agility?.value ?? 0);
      const diff = pilotAgility - mountScore;
      if ( pilotDoc && (diff > 0) ) {
        sources.push({ label: `Targeted Weapons (${pilotDoc.name}, Agility ${pilotAgility})`, advantage: diff });
      }
    }
  }

  // Active-effect roll modifiers on the actor: all-rolls, this action's
  // attribute, and (for attacks) attack-scoped.
  sources.push(...actorRollModifiers(actor, { attack: isAttack, attribute: attrKey }));

  // Auto-success for a boon invocation with NO action roll (skip dialog/roll, post a
  // success card; null total → the boon resolver bypasses the CR check, grant handle
  // still appears). Triggers:
  //  - Boon Focus SINGLE target (focus.autoSuccess), OR
  //  - Multi-Target Boon Expert: multi-targeting whose disadvantage is COMPLETELY
  //    negated by Multi-Target Boon Specialist (boonFullyNegated), OR
  //  - Reliable (extraordinary item property): an item-invoked boon targeting a
  //    single creature — or an area, when the item also has the Area property.
  const expertAutoSuccess = boonFullyNegated && !!focus;
  const reliableAutoSuccess = (sys.actionCategory === "boon") && fromItemInvocation
    && (cfg.reliableAutoSuccess?.(invokingItem, sys.targets) ?? false);
  let autoSuccess = null;
  if ( focus?.autoSuccess || expertAutoSuccess || reliableAutoSuccess ) {
    const autoScore = fromItemInvocation ? itemScore : Number(actor.system.attributes?.[attrKey]?.value ?? 0);
    const autoLabel = fromItemInvocation ? (invokingItem?.name ?? "Item") : attrLabel;
    // Boon Focus takes precedence for its extra notes; else name the trigger.
    const reason = focus?.autoSuccess ? "Boon Focus"
      : (expertAutoSuccess ? "Multi-Target Boon Expert" : "Reliable");
    autoSuccess = {
      action, actor, focus: focus?.autoSuccess ? focus : null, attrKey,
      attrScore: autoScore, attrLabel: autoLabel, reason
    };
  }

  // Destructive Trance (feat, while in a battle trance): an ATTACK roll's dice
  // explode on max OR one below (d6 on 5–6, etc.). The dialog reflects it in the
  // formula preview and the rolled formula.
  const explodeBelowMax = isAttack && cfg.attackExplodesBelowMax && cfg.attackExplodesBelowMax(actor);

  // Lethal Strike (feat): on a DAMAGING attack, offer a toggle. When the GM/player
  // judges the attack qualifies (target unaware, or within melee of an ally), they
  // check it — adding advantage equal to the tier AND converting up to `lethalCap`
  // of the dealt damage into lethal damage (resolved per target). Off by default.
  const lethalStrike = (sys.actionCategory === "damaging") ? (cfg.lethalStrike?.(actor) ?? null) : null;
  const extraToggles = lethalStrike ? [{
    name: "lethalStrike",
    label: `Lethal Strike (Tier ${lethalStrike.tier}): +${lethalStrike.advantage} Adv, up to ${lethalStrike.lethalCap} lethal`,
    title: "Check when the attack qualifies (target unaware, or within melee range of an ally). Adds advantage equal to your tier; up to the listed amount of damage dealt becomes lethal.",
    advantage: lethalStrike.advantage
  }] : [];

  // Available augmentations (Augmenting extraordinary items the actor owns): a
  // DAMAGING attack may deliver one of an augmenting item's banes on a hit. The
  // dialog offers a picker; picking one expends the item on roll.
  const augmentOptions = (sys.actionCategory === "damaging")
    ? (cfg.augmentOptionsFor?.(actor) ?? [])
    : [];

  return {
    sys, cfg, attrKey, attrLabel, fromItemInvocation, itemScore, invokingItem,
    bonusDice, isAttack, weapon, grip, multiBane, martialFocusMatch, focus,
    sources, explodeBelowMax, extraD20, extraToggles, lethalStrike, autoSuccess, augmentOptions,
    areaWeapon
  };
}

/**
 * Finish an action roll once the dialog has produced a `choice` and the `roll`
 * has been evaluated: apply Vicious Strike, build the flavor + per-target
 * section, post the chat card, and fire the on-roll macro. Split out of
 * {@link rollAction} so the heavy pre-roll context lives in
 * {@link prepareActionRoll}.
 * @param {object} args
 * @returns {Promise<ChatMessage>}
 */
async function finishActionRoll({ action, actor, ctx, choice, roll }) {
  const {
    sys, cfg, attrKey, attrLabel, fromItemInvocation, itemScore, invokingItem,
    isAttack, weapon, grip, multiBane, martialFocusMatch, explodeBelowMax, lethalStrike, focus
  } = ctx;

  // Unfailing (legendary item property): any die rolled using the item's
  // abilities treats a 1 as its maximum AND explodes as if it had rolled that
  // maximum. Applies to attack rolls made with an unfailing weapon and to an
  // unfailing item's own invocations. Patched post-roll (like Vicious Strike,
  // below — and BEFORE it, so an upgraded d20 counts as a natural 20 for it).
  const unfailingItem = fromItemInvocation
    ? (itemUnfailing(invokingItem) ? invokingItem : null)
    : ((weapon && itemUnfailing(weapon)) ? weapon : null);
  const unfailing = unfailingItem ? await applyUnfailing(roll) : false;

  // Vicious Strike (feat): on a NATURAL 20 on the attack d20, every subsequent d20
  // re-roll granted by a dice explosion is rolled with advantage 1 (2d20 keep
  // higher). Re-rolls the d20 explosion tail in place and recomputes the total.
  let viciousStrike = false;
  if ( isAttack && cfg.hasViciousStrike && cfg.hasViciousStrike(actor) ) {
    viciousStrike = await applyViciousStrike(roll, { explodeThreshold: explodeBelowMax ? 19 : 20 });
  }

  // "<Action> (<Attribute|Item N>[ · Weapon][ · vs. Defense | · CR N][ · Type])[ — N Advantage]".
  // An item invocation rolls the item's value (dice) instead of an attribute.
  const bits = [fromItemInvocation
    ? `${invokingItem?.name ?? "Item"} ${itemScore}`
    : attrLabel];
  if ( weapon ) {
    const gripTag = grip === "dual-wield" ? " (dual)" : grip === "two-handed" ? " (2H)" : "";
    bits.push(`${weapon.name}${gripTag}`);
  }
  const usesDefense = (sys.actionCategory === "damaging") || (sys.actionCategory === "bane");
  if ( usesDefense ) {
    const def = cfg.targetDefenses?.[sys.targetDefense];
    if ( def ) bits.push(`vs. ${def}`);
  } else if ( sys.actionCategory === "boon" ) {
    // Boons beat a fixed Challenge Rating (CR = 10 + 2·PL) rather than a defense.
    // No level is chosen up front — the roll lands the boon at the highest defined
    // level it clears, capped by the score — so show the CR span of the levels the
    // score can attempt (a single level shows one CR).
    const boonDoc = sys.boonUuid ? await fromUuid(sys.boonUuid).catch(() => null) : null;
    const boonCap = fromItemInvocation ? itemScore : Number(actor.system.attributes?.[attrKey]?.value ?? 0);
    let crLevels = [...new Set((boonDoc?.system?.powerEffects ?? [])
      .map(pe => Math.floor(Number(pe.powerLevel)))
      .filter(n => Number.isFinite(n) && (n > 0) && (n <= boonCap)))];
    if ( !crLevels.length ) crLevels = [Math.max(1, Math.floor(Number(sys.invokePowerLevel) || 1))];
    const crOf = pl => cfg.boonChallengeRating ? cfg.boonChallengeRating(pl) : (10 + 2 * pl);
    const crLo = crOf(Math.min(...crLevels));
    const crHi = crOf(Math.max(...crLevels));
    bits.push(crLo === crHi ? `CR ${crLo}` : `CR ${crLo}–${crHi}`);
  }
  if ( (sys.actionCategory === "damaging") && sys.damageType ) {
    bits.push((cfg.allDamageTypes ? cfg.allDamageTypes() : (cfg.damageTypes ?? {}))[sys.damageType] ?? sys.damageType);
  }
  // Header tags: advantage/disadvantage + feat riders, as a uniform pill row
  // under the title (see renderCardHeader / .ol-tag styles).
  const tags = [];
  if ( choice.net > 0 ) tags.push(`<span class="ol-tag ol-tag-adv" title="Net advantage on this roll."><i class="fas fa-angles-up"></i> Advantage ${choice.net}</span>`);
  else if ( choice.net < 0 ) tags.push(`<span class="ol-tag ol-tag-dis" title="Net disadvantage on this roll."><i class="fas fa-angles-down"></i> Disadvantage ${Math.abs(choice.net)}</span>`);
  if ( unfailing ) tags.push(`<span class="ol-tag ol-tag-crit" title="Unfailing (${foundry.utils.escapeHTML?.(unfailingItem?.name ?? "item") ?? (unfailingItem?.name ?? "item")}): dice that rolled a 1 count as their maximum and explode."><i class="fas fa-dice-one"></i> Unfailing</span>`);
  if ( viciousStrike ) tags.push(`<span class="ol-tag ol-tag-crit" title="Natural 20: explosion re-rolls made with advantage."><i class="fas fa-burst"></i> Vicious Strike</span>`);
  if ( choice.legendPoints > 0 ) tags.push(`<span class="ol-tag ol-tag-legend" title="Legend Points spent: each grants advantage 1 and +1 to the result."><i class="fas fa-star"></i> Legend Points: ${choice.legendPoints}</span>`);
  // Martial Focus: note the +1 attribute-dice step on a matching attack.
  if ( martialFocusMatch ) tags.push(`<span class="ol-tag ol-tag-feat" title="Martial Focus: your attribute is treated as one greater for attribute dice with this weapon and attribute."><i class="fas fa-hand-fist"></i> Martial Focus</span>`);
  // Augmenting item: note the bane this attack delivers on a hit.
  if ( (sys.actionCategory === "damaging") && choice.augment?.baneName ) {
    const escA = foundry.utils.escapeHTML ?? (s => s);
    tags.push(`<span class="ol-tag ol-tag-feat" title="Augmenting item: this attack delivers the chosen bane on a hit (roll ≥ defense), at the item's listed power level."><i class="fas fa-vial"></i> Augment: ${escA(choice.augment.baneName)}${choice.augment.powerLevel ? ` (PL ${choice.augment.powerLevel})` : ""}</span>`);
  }
  // Multi-Bane Specialist: note the signature pair on the card.
  if ( multiBane ) tags.push(`<span class="ol-tag ol-tag-feat" title="Multi-Bane Specialist: this attack inflicts both banes on a hit (each resisted separately)."><i class="fas fa-skull-crossbones"></i> Multi-Bane: ${multiBane.banes.map(b => (foundry.utils.escapeHTML ?? (s=>s))(b.name)).join(" & ")}</span>`);
  let flavor = renderCardHeader({ title: action.name, sub: bits.join(" · "), tags });

  // The attacker's effective SCORE (not the roll total) is shown on each line —
  // the item's listed value for an item invocation, else the attribute score.
  const attrScore = fromItemInvocation
    ? itemScore
    : Number(actor.system.attributes?.[attrKey]?.value ?? 0);
  // Label shown alongside the per-target score (item source for an item invocation).
  const scoreLabel = fromItemInvocation ? (invokingItem?.name ?? "Item") : attrLabel;
  const rollerName = actor.name;

  // A self-contained snapshot of everything the target section needs to be
  // (re)rendered — enough to recompute results & handles against a NEW target set
  // later, WITHOUT the live action item (it may be edited/deleted by then). See
  // {@link retargetActionMessage}.
  // Lethal Strike on: carry the lethal cap into the snapshot so resolveTargets can
  // split each target's damage into a lethal portion (capped at the cap and the
  // total damage). Off → 0 (no split).
  const lethalStrikeCap = (lethalStrike && choice.lethalStrike) ? lethalStrike.lethalCap : 0;

  // Multi-Bane Specialist override: bane #1 becomes the action's primary bane (so
  // the existing single-bane render/apply path drives it), and bane #2 rides along
  // as `extraBanes`. Each bane keeps its OWN power level (the action's target
  // defense is used for the hit). Potent is dropped (it's a single-bane option).
  // Baneful (Extraordinary weapon property): a DAMAGING attack with the weapon may
  // ALSO inflict its chosen bane when the roll beats the defense by 5+ (SRD). Carry
  // the chosen bane NAME so the margin-rider drops to 5 and the picker qualifies it
  // (like a Bane Focus bane). Survives re-targeting via the snapshot.
  const banefulBaneName = ((sys.actionCategory === "damaging") && (weapon?.type === "weapon"))
    ? ((weapon.system?.extraordinaryProperties ?? []).find(p => p.name === "baneful")?.value || "")
    : "";
  // Slaying (legendary weapon property): a damaging attack against the listed
  // creature type that exceeds the target's defense by 5+ kills it outright.
  // Carry the creature type in the snapshot (survives re-targeting); each hit
  // target with margin ≥ 5 gets a note + a GM "Slay" button.
  const slayingType = (sys.actionCategory === "damaging") ? weaponSlayingType(weapon) : "";

  // Augmenting item (chosen in the roll dialog): its bane rides this damaging
  // attack and is delivered on a HIT (roll ≥ defense) at the item's listed PL.
  // Resolve the bane's uuid for the card's Apply button; survives re-targeting.
  let augmentBane = null;
  if ( (sys.actionCategory === "damaging") && choice.augment?.baneName ) {
    const doc = await cfg.resolveBaneByName?.(choice.augment.baneName);
    augmentBane = {
      name: choice.augment.baneName,
      powerLevel: Math.max(0, Math.floor(Number(choice.augment.powerLevel) || 0)),
      uuid: doc?.uuid ?? ""
    };
  }

  let snapshotSys = { ...targetSnapshot(sys), lethalStrikeCap, banefulBaneName, augmentBane, slayingType };
  if ( multiBane ) {
    const [b1, b2] = multiBane.banes;
    snapshotSys = {
      ...snapshotSys,
      baneUuid: b1.uuid, baneName: b1.name, invokePowerLevel: b1.powerLevel, potent: false,
      extraBanes: [{ uuid: b2.uuid, name: b2.name, powerLevel: b2.powerLevel }]
    };
  }

  // Overpowering Strike / Crushing Blow: a Forceful weapon lets the attacker push
  // (and, with Crushing Blow, knock down) on a damaging hit. Carry whether the
  // wielded weapon is Forceful (+ its name) so the card can surface the rider; it
  // survives re-targeting via the snapshot.
  const weaponForceful = !!(weapon?.type === "weapon"
    && (weapon.system?.properties ?? []).some(p => p.key === "forceful"));

  const retarget = {
    sys: snapshotSys,
    total: roll.total, attrScore, scoreLabel, rollerName, isAttack,
    weaponForceful, weaponName: weapon?.name ?? "",
    // For the "+ Bane" (margin-10) rider on damaging attacks: the rolling actor
    // (whose invocable banes are offered) and the attribute used (its score caps
    // the appliable bane's power level).
    actorUuid: actor.uuid, attrKey
  };

  // Resolve against the user's current targets and render the per-target results
  // list, the Defend/Interrupt bar, the area-template handle, and the bane/boon
  // drag chips + invocation-dice roll buttons. Returns the HTML and the resolved
  // rows (stored in the flags for Defend and re-targeting).
  const section = await buildActionTargetSection({ snapshot: retarget, action });
  flavor += section.html;

  // Boon Focus Tier 2+/3 reminders (faster invocation, free-action sustain): the
  // GM applies these manually, so surface them as a card note.
  flavor += boonFocusNotes(focus);
  // Aura: note the radiated bane/boon (and its per-kind behaviour) on the card.
  flavor += auraRadiateNote(sys);

  const message = await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor,
    flags: { openlegend: { actionResult: {
      actionName: action.name, results: section.results, retarget
    } } }
  });

  // On-roll macro: fire it after the card is posted, with the roll/action in scope.
  await fireActionMacro(action, { actor, roll, message, results: section.results });

  return message;
}

/**
 * Execute an action's configured "on roll" macro (system.macroUuid), if any.
 * Runs AFTER the action's chat card is posted. The macro is executed with a
 * scope exposing the roll context, so a macro author can react to the result:
 *   - actor    : the rolling Actor
 *   - action   : the action Item that was rolled
 *   - roll     : the evaluated Roll (total, terms, …)
 *   - total    : roll.total (convenience)
 *   - message  : the posted ChatMessage
 *   - results  : the per-target result rows (hit/miss, damage, bane/boon, …)
 *   - targets  : the user's currently targeted Tokens (Set)
 * A missing/unresolvable uuid is a no-op (warned once); a macro that throws is
 * caught and surfaced so one bad macro never breaks the roll.
 * @param {Item} action
 * @param {object} ctx
 * @returns {Promise<void>}
 */
export async function fireActionMacro(action, { actor = null, roll = null, message = null, results = [] } = {}) {
  const uuid = action?.system?.macroUuid;
  if ( !uuid ) return;
  const macro = await fromUuid(uuid).catch(() => null);
  if ( !macro || (macro.documentName !== "Macro") ) {
    ui.notifications?.warn(`${action.name}: its on-roll macro could not be found (it may have been deleted).`);
    return;
  }
  try {
    // Macro#execute merges the given scope into the macro's execution context, so
    // `actor`, `roll`, `total`, etc. are available as locals in a script macro.
    await macro.execute({
      actor,
      action,
      item: action,
      roll,
      total: roll?.total ?? null,
      message,
      results: results ?? [],
      targets: game.user?.targets ?? new Set(),
      speaker: ChatMessage.getSpeaker({ actor })
    });
  } catch ( err ) {
    console.error(`OpenLegend | on-roll macro "${macro.name}" threw:`, err);
    ui.notifications?.error(`The on-roll macro "${macro.name}" errored — see the console (F12).`);
  }
}

/* -------------------------------------------- */

/**
 * Vicious Strike: when the attack's d20 came up a NATURAL 20 (its first, un-exploded
 * result), every SUBSEQUENT d20 re-roll from the dice explosion is re-made with
 * advantage 1 (roll 2 d20s, keep the higher). Operates on the already-evaluated
 * Roll: finds the d20 Die term, and if its first result is the max (20), discards
 * the auto-rolled explosion tail and rebuilds it with advantage, then patches the
 * term's results + the Roll's total in place. Returns whether it triggered (so the
 * caller can note it). The bonus (non-d20) dice are untouched.
 *
 * The explosion threshold matches the formula: 20 normally, 19 with Destructive
 * Trance (explode on max-or-one-below). Each advantage re-roll that itself meets the
 * threshold continues the chain (also with advantage), exactly as a natural explode.
 *
 * @param {Roll} roll
 * @param {object} [opts]
 * @param {number} [opts.explodeThreshold]  The d20 value at/above which it explodes.
 * @returns {Promise<boolean>}  True if a natural 20 triggered the advantage re-rolls.
 */
async function applyViciousStrike(roll, { explodeThreshold = 20 } = {}) {
  // The d20 Die term (faces === 20). There's exactly one in an attack formula.
  const d20 = (roll.dice ?? []).find(d => Number(d.faces) === 20);
  if ( !d20 || !Array.isArray(d20.results) || !d20.results.length ) return false;

  // The INITIAL d20 pool is the first `d20.number` results (e.g. 1 for "1d20x", 2
  // for a score-0 "2d20kh1x"); explosion re-rolls come AFTER them. Vicious Strike
  // triggers on a natural 20 on the KEPT initial die (the active one of the pool).
  const poolSize = Math.max(1, Math.floor(Number(d20.number) || 1));
  const initialPool = d20.results.slice(0, poolSize);
  const keptInitial = initialPool.find(r => r.active !== false) ?? initialPool[0];
  if ( !keptInitial || (Number(keptInitial.result) !== 20) ) return false;

  // The explosion tail = active results after the initial pool. If the nat-20 didn't
  // explode (shouldn't happen, 20 ≥ threshold), there's nothing to upgrade.
  const tail = d20.results.slice(poolSize).filter(r => r.active !== false);
  if ( !tail.length ) return false;

  // Sum the auto-rolled (non-advantage) explosion tail we're replacing.
  const oldTailSum = tail.reduce((s, r) => s + Number(r.result), 0);

  // Re-roll the explosion chain with advantage 1: the initial die hit the threshold,
  // so roll 2 d20s and keep the higher, repeatedly while the kept value also meets
  // the threshold. BOTH dice of each pair are recorded as results so the chat tooltip
  // shows the advantage rolls — the kept die active, the lower die inactive (greyed
  // out, not counted). Cap the chain to avoid a pathological loop.
  const rebuilt = [];
  let newTailSum = 0;
  let chain = true;
  let guard = 0;
  while ( chain && (guard++ < 100) ) {
    const pair = await (new Roll("2d20")).evaluate();
    const rolled = (pair.dice[0]?.results ?? []).map(r => Number(r.result));
    const a = rolled[0] ?? 0, b = rolled[1] ?? 0;
    const kept = Math.max(a, b);
    const dropped = Math.min(a, b);
    newTailSum += kept;
    chain = kept >= explodeThreshold;
    // The kept die explodes (continues the chain) when it meets the threshold; the
    // last kept die that doesn't is the chain terminator.
    rebuilt.push({ result: dropped, active: false });            // lower die (greyed)
    rebuilt.push({ result: kept, active: true, exploded: chain }); // kept (higher)
  }

  // Patch the term's results: keep the initial pool (mark the kept die exploded),
  // drop the old tail, append the advantage-pair re-rolls.
  keptInitial.exploded = true;
  d20.results = [...initialPool, ...rebuilt];

  // Patch the Roll total by the delta between the new and old explosion tails.
  // `DiceTerm#total` recomputes from active results (so the term is already correct);
  // `Roll#total` returns the cached `_total`, which we adjust here.
  const delta = newTailSum - oldTailSum;
  roll._total = Number(roll._total ?? roll.total) + delta;
  return true;
}

/**
 * Unfailing (legendary item property): every ACTIVE die result of 1 — on ANY die
 * in the roll, the d20 included — is upgraded to the die's maximum, and (as if it
 * had rolled that maximum) triggers a dice explosion. Operates on the already-
 * evaluated Roll: patches each 1 in place (marked exploded, so the chat tooltip
 * highlights it), appends a freshly-rolled exploding tail per upgraded die, and
 * adjusts the Roll's cached total. Discarded results (e.g. the dropped die of an
 * advantage pair) are left alone. Returns whether any die was upgraded.
 * @param {Roll} roll
 * @returns {Promise<boolean>}
 */
async function applyUnfailing(roll) {
  let delta = 0;
  let triggered = false;
  for ( const die of (roll.dice ?? []) ) {
    const faces = Math.floor(Number(die.faces) || 0);
    if ( faces < 2 || !Array.isArray(die.results) ) continue;
    const ones = die.results.filter(r => (r.active !== false) && (Number(r.result) === 1));
    if ( !ones.length ) continue;
    triggered = true;
    for ( const r of ones ) {
      r.result = faces;
      r.exploded = true;
      delta += faces - 1;
    }
    // Each upgraded die explodes: roll one exploding die per upgraded 1 and
    // append its results to the term (active, so DiceTerm#total counts them).
    const tail = await (new Roll(`${ones.length}d${faces}x`)).evaluate();
    for ( const r of (tail.dice[0]?.results ?? []) ) {
      die.results.push({ result: Number(r.result), active: true, exploded: !!r.exploded });
      delta += Number(r.result);
    }
  }
  if ( triggered ) roll._total = Number(roll._total ?? roll.total) + delta;
  return triggered;
}

/* -------------------------------------------- */

/**
 * The Boon Focus card note (Tier 2+ faster invocation, Tier 3 free-action sustain).
 * Both are applied manually by the GM, so they ride along the card as a reminder.
 * @param {object|null} focus  The {@link OPENLEGEND.boonFocus} benefit, or null.
 * @returns {string}  HTML note block, or "".
 */
function boonFocusNotes(focus) {
  if ( !focus ) return "";
  const esc = foundry.utils.escapeHTML ?? (s => s);
  const lines = [focus.fasterNote, focus.sustainNote].filter(Boolean);
  if ( !lines.length ) return "";
  return `<div class="ol-boon-focus-note">${lines.map(l =>
    `<p><i class="fas fa-bolt"></i> ${esc(l)}</p>`).join("")}</div>`;
}

/**
 * Aura card note: when the rolled boon is Aura and a radiated bane/boon is set,
 * surface what it radiates (with the per-kind behaviour reminder). The GM
 * adjudicates the aura's ongoing effect; this is informational. Returns "" when
 * the action isn't an Aura with a chosen radiated invocation.
 * @param {object} sys  The action's system data.
 * @returns {string}  HTML note, or "".
 */
function auraRadiateNote(sys) {
  if ( String(sys?.boonName ?? "").trim().toLowerCase() !== "aura" ) return "";
  if ( !sys?.auraRadiateName ) return "";
  const esc = foundry.utils.escapeHTML ?? (s => s);
  const kind = (sys.auraRadiateKind === "bane") ? "bane" : "boon";
  const pl = sys.auraRadiatePowerLevel ? ` (PL ${sys.auraRadiatePowerLevel})` : "";
  const behaviour = (kind === "bane")
    ? "Foes entering or ending their turn in the aura suffer a bane attack to inflict it (the aura's target is immune; once per round per creature)."
    : "The target and allies ending their turn in the aura gain it automatically; it's removed on leaving (once per round per creature).";
  return `<div class="ol-aura-note"><p><i class="fas fa-circle-notch"></i> <strong>Aura radiates ${kind}:</strong> ${esc(sys.auraRadiateName)}${pl}. ${behaviour}</p></div>`;
}

/**
 * Post a Boon Focus auto-success card for a SINGLE-target invocation: no action
 * roll is made (the boon simply succeeds). The card carries the same target
 * section as a normal boon invocation — the per-target row reads "Auto-Success",
 * and the grant handle/button is shown — so the GM grants the boon as usual.
 * @param {object} args
 * @param {Item} args.action      The boon action.
 * @param {Actor} args.actor      The invoking actor.
 * @param {object} args.focus     The boon-focus benefit (carries the notes + tier).
 * @param {string} args.attrKey   The action's attribute key.
 * @param {number} args.attrScore The score shown per target (item value or attribute).
 * @param {string} args.attrLabel The score's label (item name or attribute label).
 * @param {string} [args.reason]  What grants the auto-success ("Boon Focus" or
 *                                "Multi-Target Boon Expert"). Shown in the flavor.
 * @returns {Promise<ChatMessage|void>}
 */
async function postBoonFocusAutoSuccess({ action, actor, focus, attrKey, attrScore, attrLabel, reason = "Boon Focus" }) {
  const sys = action.system;
  const cfg = CONFIG.OPENLEGEND ?? {};

  // Flavor header: no dice rolled, so it reads "<Action> (<Attribute> · CR N) —
  // <reason> auto-success". The auto-success lands at the highest defined level
  // the score reaches (no level is chosen up front), so show that level's CR.
  const boonDoc = sys.boonUuid ? await fromUuid(sys.boonUuid).catch(() => null) : null;
  const autoLevels = (boonDoc?.system?.powerEffects ?? [])
    .map(pe => Math.floor(Number(pe.powerLevel)))
    .filter(n => Number.isFinite(n) && (n > 0) && (n <= Number(attrScore ?? Infinity)));
  const autoPl = autoLevels.length ? Math.max(...autoLevels) : Number(sys.invokePowerLevel ?? 0);
  const cr = cfg.boonChallengeRating ? cfg.boonChallengeRating(autoPl) : null;
  const bits = [attrLabel];
  if ( cr !== null ) bits.push(`CR ${cr}`);
  let flavor = renderCardHeader({
    title: action.name,
    sub: bits.join(" · "),
    tags: [`<span class="ol-tag ol-tag-auto" title="${reason}: this invocation succeeds without a roll."><i class="fas fa-bolt"></i> ${reason} auto-success</span>`]
  });

  // Snapshot mirrors the rolled path but with a null total + the auto-success flag,
  // so the section renderer (and any later re-targeting) bypasses the CR check.
  const retarget = {
    sys: targetSnapshot(sys),
    total: null, attrScore, scoreLabel: attrLabel, rollerName: actor.name,
    isAttack: false, actorUuid: actor.uuid, attrKey,
    boonAutoSuccess: true
  };

  const section = await buildActionTargetSection({ snapshot: retarget, action });
  flavor += section.html;
  flavor += boonFocusNotes(focus);
  flavor += auraRadiateNote(action.system);

  const message = await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor,
    flags: { openlegend: { actionResult: {
      actionName: action.name, results: section.results, retarget
    } } }
  });

  // On-roll macro: fire it for the auto-success path too (no dice were rolled,
  // so `roll` is null).
  await fireActionMacro(action, { actor, roll: null, message, results: section.results });

  return message;
}

/* -------------------------------------------- */

/**
 * The minimal slice of an action's system data the chat card's target section
 * needs to be (re)rendered: targeting/defense/damage/invocation fields. Stored
 * in the message flags so re-targeting doesn't depend on the live action item.
 * @param {object} sys  The action's system data.
 * @returns {object}
 */
function targetSnapshot(sys) {
  return {
    actionCategory: sys.actionCategory,
    targetDefense: sys.targetDefense ?? "",
    damageType: sys.damageType ?? "",
    targets: sys.targets ?? "",
    area: sys.area ? { shape: sys.area.shape, length: sys.area.length, lines: sys.area.lines } : null,
    baneUuid: sys.baneUuid ?? "", baneName: sys.baneName ?? "",
    potent: !!sys.potent,
    boonUuid: sys.boonUuid ?? "", boonName: sys.boonName ?? "",
    // Aura radiated bane/boon — carried so the Grant button can flag the granted
    // Aura effect for the live-aura engine (and survive re-targeting).
    auraRadiateKind: sys.auraRadiateKind ?? "", auraRadiateUuid: sys.auraRadiateUuid ?? "",
    auraRadiateName: sys.auraRadiateName ?? "", auraRadiatePowerLevel: Number(sys.auraRadiatePowerLevel ?? 0),
    auraRadiateResistanceType: sys.auraRadiateResistanceType ?? "",
    // Barrier chosen properties + Baneful bane — carried so the Grant button can
    // record them on the granted effect (and survive re-targeting).
    barrierProperties: sys.barrierProperties ?? "",
    barrierBaneUuid: sys.barrierBaneUuid ?? "", barrierBaneName: sys.barrierBaneName ?? "",
    barrierBanePowerLevel: Number(sys.barrierBanePowerLevel ?? 0),
    attribute: sys.attribute ?? "",
    extraordinaryHealing: !!sys.extraordinaryHealing,
    invokePowerLevel: Number(sys.invokePowerLevel ?? 0),
    // Item invocation: the item's value (supplies an Aura's radiated-attack dice).
    invokeItemScore: Number(sys.invokeItemScore ?? 0),
    // Lethal Strike: max lethal portion of the dealt damage (0 = off / not applicable).
    lethalStrikeCap: Math.max(0, Math.floor(Number(sys.lethalStrikeCap ?? 0)))
  };
}

/**
 * Build the entire target-dependent section of an action chat card from a
 * snapshot: the per-target results list (+ Change-targets control), the Defend
 * bar, the area-template handle, and the bane/boon drag chips with their
 * invocation-dice roll buttons. Used both when first rolling and when
 * re-targeting an existing card.
 * @param {object} args
 * @param {object} args.snapshot  The `retarget` payload (see {@link rollAction}).
 * @param {Item}   [args.action]  The live action item, when available (only used
 *                                for the area-template handle's data-uuid).
 * @returns {Promise<{html: string, results: Array}>}
 */
async function buildActionTargetSection({ snapshot, action = null }) {
  const cfg = CONFIG.OPENLEGEND ?? {};
  const sys = snapshot.sys;
  const { total, attrScore, scoreLabel, rollerName, isAttack, actorUuid, attrKey } = snapshot;
  const weaponForceful = !!snapshot.weaponForceful;
  const weaponName = snapshot.weaponName ?? "";
  // Boon Focus single-target auto-success rides along in the snapshot (so it
  // survives re-targeting) — total is null, the CR check is bypassed.
  const autoSuccess = !!snapshot.boonAutoSuccess;

  // The invoked bane/boon document (bane/boon actions only): re-fetched by uuid
  // so its power-effect dice (Heal 2d6, Persistent Damage 1d6/round) become roll
  // buttons. An INSTANTANEOUS boon with dice (Heal) is rolled, not applied.
  let invokedDoc = null;
  if ( (sys.actionCategory === "bane") && sys.baneUuid ) invokedDoc = await fromUuid(sys.baneUuid);
  else if ( (sys.actionCategory === "boon") && sys.boonUuid ) invokedDoc = await fromUuid(sys.boonUuid);
  const instantaneous = /instant/i.test(String(invokedDoc?.system?.duration ?? ""));

  // A boon's DISCRETE power levels (its power-effect breakpoints, ascending) — the
  // levels a player may actually land it at. No level is chosen up front: after
  // the roll, the boon lands at the highest discrete level ≤ the invoking score
  // whose CR the total cleared, and the card's PL picker offers every reachable
  // level below it (see resolveBoonTargets / boonAchievedPowerLevel). Empty → fall
  // back to the boon's minimum so a boon without breakpoints still works.
  let boonLevels = [];
  let boonAchievedPl = 0;
  if ( (sys.actionCategory === "boon") && invokedDoc ) {
    boonLevels = [...new Set((invokedDoc.system?.powerEffects ?? [])
      .map(pe => Math.floor(Number(pe.powerLevel)))
      .filter(n => Number.isFinite(n) && (n > 0)))].sort((a, b) => a - b);
    if ( !boonLevels.length ) {
      const base = Math.max(1, Math.floor(Number(invokedDoc.system?.powerLevel) || 1));
      boonLevels = [base];
    }
    // The level this invocation actually achieved (0 = failed). Mirrors the
    // per-target math in resolveBoonTargets; used for the invocation dice (a Heal
    // rolled at PL 5 heals more than at PL 1) and the drag chip below.
    const boonCap = Number(attrScore ?? Infinity);
    boonAchievedPl = autoSuccess
      ? Math.max(0, ...boonLevels.filter(l => l <= boonCap))
      : (cfg.boonAchievedPowerLevel ? (cfg.boonAchievedPowerLevel(total, boonLevels, boonCap) ?? 0) : 0);
  }
  // Invocation dice: banes roll at the action's stored level; boons at the level
  // the roll achieved (no button when the invocation failed).
  const invokeRoll = invokedDoc
    ? invocationRollFor(invokedDoc, (sys.actionCategory === "boon") ? boonAchievedPl : sys.invokePowerLevel)
    : null;

  // Bane Focus lowers the margin-rider threshold from 10 to 5 (for the focused
  // bane only — the picker enforces which banes qualify at 5–9). Resolve the
  // attacker from the snapshot's actorUuid to check it.
  const rollerActor = actorUuid ? await fromUuid(actorUuid) : null;
  const hasBaneFocus = !!(cfg.baneFocusNames && cfg.baneFocusNames(rollerActor).size);
  const minBaneMargin = hasBaneFocus ? 5 : 10;

  // resolveTargets reads only `action.system`, so a snapshot stand-in suffices.
  const results = resolveTargets({
    action: { system: sys }, total, attrScore,
    suppressGrant: instantaneous && !!invokeRoll,
    minBaneMargin, autoSuccess, actorUuid, boonLevels
  });

  let html = "";
  // The per-target list, with a "Change targets" control so the GM can re-resolve
  // this same roll against a fresh target selection. The control shows even with
  // no current targets (the GM can target after the fact).
  html += renderResultsBlock({ rollerName, attrLabel: scoreLabel, attrScore, results, retargetable: true, actorUuid, attrKey });
  // Only damaging / bane ATTACKS can be answered with a Defend interrupt.
  if ( results.length && isAttack ) html += renderInterruptButton();
  // Inspiring Champion (attacker feat): a damaging hit exceeding a target's defense
  // by 10+ grants allies in range a healing roll (dice/ally-count by tier). Surface
  // it when the attacker owns the feat and SOME damaging target was hit with margin
  // ≥ 10 (we don't track once-per-round — the GM decides whether to use it).
  if ( sys.actionCategory === "damaging" ) {
    const rider = cfg.inspiringChampionRider?.(rollerActor);
    const triggered = rider && results.some(r => !r.isBoon && !r.isBane && r.hit && (r.baneMargin >= 10));
    if ( triggered ) html += renderInspiringChampionBlock(rider, rollerName);
  }
  // Overpowering Strike (attacker feat): when you DEAL DAMAGE with a Forceful weapon,
  // you may push each damaged target 5'. Crushing Blow (prereq Overpowering Strike)
  // adds an optional Knockdown where the forced move ends. Surfaced on a damaging hit
  // with a Forceful weapon when the attacker owns the feat(s).
  if ( (sys.actionCategory === "damaging") && weaponForceful && (cfg.hasOverpoweringStrike?.(rollerActor)) ) {
    const hits = results.filter(r => !r.isBoon && !r.isBane && r.hit && r.tokenUuid);
    if ( hits.length ) {
      html += renderOverpoweringStrikeBlock({
        rollerName, weaponName, hits,
        crushing: !!(cfg.hasCrushingBlow?.(rollerActor))
      });
    }
  }
  // Attack-miss options (SRD "on a miss" rule): a per-actor bar (attacker + each
  // missed target) of deal-3 / inflict-bane / move-10 icon buttons. Only for
  // attacks, only when some target was missed, and NOT for NPC/boss attackers (the
  // miss choice is a player-facing option — the GM doesn't need it for their own
  // creatures). renderMissOptions returns "" when there's nothing to show.
  const attackerActor = rollerActor?.actor ?? rollerActor;
  const attackerIsNpc = (attackerActor?.type === "npc") || (attackerActor?.type === "boss");
  if ( isAttack && !attackerIsNpc ) html += renderMissOptions({ rollerName, actorUuid, results });

  // Area actions: a full-width draggable handle placing a Region area shape.
  const template = cfg.areaTemplateData ? cfg.areaTemplateData(sys) : null;
  if ( template ) html += renderTemplateHandle(action, sys, template);

  // Bane actions: a draggable chip applying the chosen bane to a dropped token,
  // plus a damage-roll button when the bane carries dice. The HIT targets ride
  // along so the rolled damage can be applied to them (with undo).
  if ( sys.actionCategory === "bane" ) {
    const damageTargets = results
      .filter(r => r.isBane && r.hit && r.tokenUuid)
      .map(r => ({ tokenUuid: r.tokenUuid, name: r.name }));
    html += renderBaneHandle(sys, invokeRoll, damageTargets);
  }

  // Boon actions: a draggable chip granting the chosen boon (at the achieved
  // level) — or, for an instantaneous dice boon, the healing roll instead.
  if ( sys.actionCategory === "boon" ) {
    const healTargets = results
      .filter(r => r.isBoon && r.hit && r.tokenUuid)
      .map(r => ({ tokenUuid: r.tokenUuid, name: r.name }));
    // Extraordinary Healing: a Heal boon flagged on the action heals lethal damage
    // too (and the invocation takes 1 hour). Only when it's the Heal boon AND the
    // acting actor still owns the Extraordinary Healing feat (the flag could
    // linger if the feat was later removed).
    const extraordinary = !!sys.extraordinaryHealing
      && /heal/i.test(String(sys.boonName ?? ""))
      && (cfg.hasExtraordinaryHealing?.(rollerActor) ?? false);
    html += renderBoonHandle(sys, attrScore, total, { invokeRoll, instantaneous, healTargets, autoSuccess, extraordinary, achievedPl: boonAchievedPl });
  }

  return { html, results };
}

/* -------------------------------------------- */

/**
 * Re-resolve an existing action chat card against the GM's CURRENT targets,
 * keeping the original roll total. Recomputes the per-target hit/damage results
 * and re-renders the whole target section (results list, Defend bar, area handle,
 * bane/boon chips), then updates the message content + flags in place. The chat
 * card carries the action's flavor header as the FIRST line; everything from the
 * results divider onward is replaced.
 * @param {ChatMessage} message  The action chat message to re-target.
 * @returns {Promise<void>}
 */
export async function retargetActionMessage(message) {
  if ( !game.user?.isGM ) {
    ui.notifications?.warn("Only the GM can change an attack's targets.");
    return;
  }
  const snapshot = message?.flags?.openlegend?.actionResult?.retarget;
  if ( !snapshot ) {
    ui.notifications?.warn("This card cannot be re-targeted.");
    return;
  }
  if ( !(game.user.targets?.size > 0) ) {
    ui.notifications?.warn("Target one or more tokens first, then click Change targets.");
    return;
  }

  const section = await buildActionTargetSection({ snapshot });

  // The card's flavor is "<header>…<target section>". The target section always
  // begins at our results divider; replace from there on so re-targeting swaps the
  // section in place (never appends a duplicate). Match the FIRST divider with a
  // regex — the browser/Foundry normalizes the stored HTML (e.g. drops the void
  // element's trailing slash: `<hr ... />` → `<hr ...>`), so an exact-string
  // indexOf would miss it and wrongly append.
  const flavor = String(message.flavor ?? "");
  const m = /<hr\b[^>]*\bol-card-divider\b[^>]*>/i.exec(flavor);
  const header = m ? flavor.slice(0, m.index) : flavor;
  const newFlavor = header + section.html;

  await message.update({
    flavor: newFlavor,
    "flags.openlegend.actionResult.results": section.results
  });
}

/* -------------------------------------------- */

/**
 * The dice roll a bane/boon invocation carries at a power level, if any —
 * e.g. Heal PL 5 → "2d6", Persistent Damage PL 4 → "1d6 damage per round".
 * Reads the strongest powerEffects entry at or below the invoked level whose
 * text contains dice notation. All Open Legend rolls explode, so the returned
 * formula appends `x` to every die term.
 * @param {Item} item         The bane or boon document.
 * @param {number} powerLevel The invoked power level.
 * @returns {{dice: string, formula: string, text: string}|null}
 */
function invocationRollFor(item, powerLevel = 0) {
  const pl = Math.max(0, Math.floor(Number(powerLevel) || 0));
  const entries = (item?.system?.powerEffects ?? [])
    .filter(pe => Number(pe.powerLevel ?? 0) <= pl)
    .sort((a, b) => Number(a.powerLevel) - Number(b.powerLevel));
  for ( let i = entries.length - 1; i >= 0; i-- ) {
    const text = String(entries[i].effect ?? "");
    const m = /(\d+)\s*d\s*(\d+)/i.exec(text);
    if ( m ) {
      const dice = `${m[1]}d${m[2]}`;
      return { dice, formula: `${dice}x`, text: text.trim() };
    }
  }
  return null;
}

/**
 * Render a chat-card button that rolls a bane/boon invocation's dice (healing
 * or damage). Clickable by any user (wired in renderChatMessageHTML); the roll
 * explodes per Open Legend rules.
 * @param {string} label       "Healing" | "Damage".
 * @param {object} invokeRoll  From {@link invocationRollFor}.
 * @param {string} sourceName  The bane/boon name, for the roll's chat flavor.
 * @param {number} [powerLevel]
 * @returns {string} HTML.
 */
function renderInvokeRollButton(label, invokeRoll, sourceName, powerLevel = 0, { healTargets = [], damageTargets = [], extraordinary = false } = {}) {
  const escape = foundry.utils.escapeHTML ?? (s => s);
  const plText = powerLevel ? ` PL ${powerLevel}` : "";
  // Extraordinary Healing: the invocation takes 1 hour and the roll heals lethal
  // damage too — note both on the card flavor.
  const xtraNote = extraordinary ? " — Extraordinary Healing (1 hour; also heals lethal damage)" : "";
  const flavor = `${sourceName}${plText} — ${invokeRoll.text || label}${xtraNote}`;
  // The roll kind drives what the rolled card offers: a Healing roll → Apply
  // Healing controls, a Damage roll → Apply Damage controls (target / selection).
  const kind = /heal/i.test(label) ? "healing" : "damage";
  // Healing / damage rolls carry any pre-resolved targets so the chat hook can
  // attach per-target Apply buttons (with undo) to the rolled result. When there
  // are none (e.g. an extraordinary-item invocation, which has no attack roll and
  // thus no resolved targets), the rolled card still gets "apply to current
  // target / selection" controls — driven by data-roll-kind alone.
  let targetsAttr = "";
  if ( healTargets.length ) targetsAttr = ` data-heal-targets="${escape(JSON.stringify(healTargets))}"`;
  else if ( damageTargets.length ) targetsAttr = ` data-damage-targets="${escape(JSON.stringify(damageTargets))}"`;
  const xtraAttr = extraordinary ? ` data-extraordinary="1"` : "";
  return `
    <button type="button" class="ol-roll-invoke" data-formula="${escape(invokeRoll.formula)}"
            data-roll-flavor="${escape(flavor)}" data-roll-kind="${kind}"${targetsAttr}${xtraAttr} data-tooltip="${escape(invokeRoll.text || label)}">
      <i class="fas fa-dice-d20"></i> Roll ${escape(label)} (${escape(invokeRoll.dice)})
    </button>`;
}

/**
 * Roll an invocation button's dice and post the result to chat. When the button
 * carries heal/damage targets (Regeneration's healing, Persistent Damage's
 * per-round damage), the rolled card bears per-target Apply Healing / Apply
 * Damage buttons (with undo). Used both from chat cards and from the same button
 * embedded in an applied effect's description (effects panel / sheet), so a
 * Regeneration/Persistent-Damage roll always becomes a healing/damage card
 * rather than a plain roll.
 * @param {HTMLElement} btn  An `.ol-roll-invoke` element with data-formula,
 *   data-roll-flavor, and optionally data-heal-targets / data-damage-targets.
 */
export async function rollInvokeButton(btn) {
  const { formula, rollFlavor, rollKind, healTargets, damageTargets, extraordinary } = btn.dataset;
  if ( !formula ) return;
  const xtra = extraordinary === "1";
  const roll = await (new Roll(formula)).evaluate();
  let flavor = rollFlavor ?? "";
  try {
    if ( healTargets ) {
      const targets = JSON.parse(healTargets);
      if ( Array.isArray(targets) && targets.length ) flavor += renderHealApplyButtons(targets, roll.total, { extraordinary: xtra });
    } else if ( damageTargets ) {
      const targets = JSON.parse(damageTargets);
      if ( Array.isArray(targets) && targets.length ) flavor += renderDamageApplyButtons(targets, roll.total);
    } else if ( rollKind === "healing" ) {
      // No pre-resolved targets (e.g. an extraordinary-item Heal/Regeneration): make
      // the rolled card a HEALING card — apply to the current target / selection.
      flavor += renderRolledAimButtons("healing", roll.total, { extraordinary: xtra });
    } else if ( rollKind === "damage" ) {
      // Likewise Persistent Damage invoked from an item: a DAMAGE card.
      flavor += renderRolledAimButtons("damage", roll.total);
    }
  } catch ( err ) { console.warn("openlegend | bad roll-targets payload", err); }
  await roll.toMessage({ speaker: ChatMessage.getSpeaker(), flavor });
}

/**
 * Auto-roll a combatant's per-turn condition dice at the START of its turn:
 * Regeneration (boon) rolls its healing, Persistent Damage (bane) rolls its
 * damage — each posting the same apply card (with undo) that the condition's
 * manual roll button produces, targeted at the combatant's token. Driven by the
 * "autoRollTurnEffects" world setting from the updateCombat hook (active-GM
 * gated there so it fires exactly once).
 * @param {Combatant} combatant  The combatant whose turn just began.
 * @returns {Promise<void>}
 */
export async function autoRollTurnStartEffects(combatant) {
  const actor = combatant?.actor;
  if ( !actor ) return;
  const cfg = CONFIG.OPENLEGEND ?? {};
  const esc = foundry.utils.escapeHTML ?? (s => s);
  const tokenUuid = combatant.token?.uuid ?? actor.uuid;
  for ( const effect of actor.effects ) {
    if ( effect.disabled ) continue;
    const fl = effect.flags?.openlegend ?? {};
    const kind = fl.fromBoon === "Regeneration" ? "healing"
      : (fl.fromBane === "Persistent Damage" ? "damage" : null);
    if ( !kind ) continue;
    const pl = Math.max(0, Math.floor(Number(fl.powerLevel) || 0));
    // The dice live on the source bane/boon's power-effect text at this level.
    const source = kind === "healing"
      ? await cfg.resolveBoonByName?.("Regeneration")
      : await cfg.resolveBaneByName?.("Persistent Damage");
    const invokeRoll = source ? invocationRollFor(source, pl) : null;
    if ( !invokeRoll ) continue;
    const roll = await (new Roll(invokeRoll.formula)).evaluate();
    const targets = [{ tokenUuid, name: combatant.name ?? actor.name }];
    let flavor = renderCardHeader({
      title: `${source.name}${pl ? ` (PL ${pl})` : ""}`,
      sub: `${esc(invokeRoll.text || "")} · start of turn`
    });
    flavor += kind === "healing"
      ? renderHealApplyButtons(targets, roll.total)
      : renderDamageApplyButtons(targets, roll.total);
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor });
  }
}

/** Whether an extraordinary item is ACTIVE on its owner: equipped weapon/armor, or
 *  any gear. Mirrors OpenLegendActor.#extraordinaryActive (private on the actor). */
function extraordinaryItemActive(item) {
  if ( !item?.system?.extraordinary ) return false;
  if ( (item.type === "weapon") || (item.type === "armor") ) return !!item.system.equipped;
  return true; // gear
}

/**
 * Persistent (extraordinary property) automation: at the start of a combatant's
 * turn, auto-apply the boon chosen on each of their ACTIVE items' Persistent
 * property, at the PL from the item's matching listed boon. A LASTING boon respects
 * uniqueness + power level (a same boon already borne at an equal/higher PL is left
 * alone; a lower-PL one is replaced). An INSTANTANEOUS boon (Heal, Restoration) has
 * no lasting effect, so its instantaneous action is re-run each turn instead (roll
 * healing / cure banes + Restoration immunity — see applyPersistentInstantaneous).
 * Per-item opt-out via flags.openlegend.persistentAuto === false. GM-gated by the
 * updateCombat caller.
 * @param {Combatant} combatant
 * @returns {Promise<void>}
 */
export async function applyPersistentItemBoons(combatant) {
  const actor = combatant?.actor;
  if ( !actor ) return;
  const cfg = CONFIG.OPENLEGEND ?? {};
  for ( const item of actor.items ) {
    if ( item.flags?.openlegend?.persistentAuto === false ) continue;
    if ( !extraordinaryItemActive(item) ) continue;
    const prop = (item.system?.extraordinaryProperties ?? []).find(p => p.name === "persistent");
    const boonName = prop?.value;
    if ( !boonName ) continue;
    // The PL comes from the item's OWN listed boon of that name.
    const listed = (item.system?.extraordinaryBoons ?? []).find(b => b?.name === boonName);
    const pl = Math.max(0, Math.floor(Number(listed?.powerLevel) || 0));
    if ( pl <= 0 ) continue;   // the boon isn't among the item's listed boons, or PL 0
    const boon = await cfg.resolveBoonByName?.(boonName);
    if ( boon?.type !== "boon" ) continue;

    // INSTANTANEOUS boons (Heal, Restoration) leave no lasting effect to sustain —
    // SRD: the item "invokes the boon each round at the start of the wielder's turn".
    // So re-run its instantaneous effect every turn instead of the uniqueness path.
    if ( /instant/i.test(String(boon.system?.duration ?? "")) ) {
      await applyPersistentInstantaneous(actor, boon, pl, item);
      continue;
    }

    // Aura: carry the item row's radiated bane/boon (picked on the item sheet)
    // into the granted effect as flags.openlegend.aura — the live-aura engine
    // (module/canvas/aura.mjs) only radiates from that payload. The radiated PL
    // is re-clamped to half the aura's PL (resolveAuraRadiateGrant); the item's
    // aura VALUE supplies the bane-attack dice (itemScore — an item invocation
    // never rolls the wielder's attribute).
    let aura = null;
    if ( String(boon.name).trim().toLowerCase() === "aura" ) {
      const rad = await cfg.resolveAuraRadiateGrant?.(listed, pl);
      if ( rad ) {
        aura = {
          radiateKind: rad.kind, radiateUuid: rad.uuid, radiateName: rad.name,
          radiatePowerLevel: rad.powerLevel, radiateResistanceType: rad.resistanceType,
          radius: cfg.auraRadiusForPowerLevel ? cfg.auraRadiusForPowerLevel(pl) : 0,
          attackAttr: "",
          itemScore: pl,
          attackerActorUuid: actor.uuid
        };
      }
    }

    // Lasting boon — uniqueness / power level: an existing same-boon effect at ≥ this
    // PL wins; a lower-PL one is replaced; none → apply.
    const existing = actor.effects.find(e => e.flags?.openlegend?.fromBoon === boon.name);
    if ( existing ) {
      const curPl = Math.max(0, Math.floor(Number(existing.flags?.openlegend?.powerLevel) || 0));
      if ( curPl >= pl ) {
        // Heal an Aura effect granted before the radiate data existed (or before
        // this fix): same PL, no radiate payload → stamp ours so it starts working.
        if ( aura && (curPl === pl) && !existing.flags?.openlegend?.aura?.radiateUuid ) {
          await existing.update({ "flags.openlegend.aura": aura });
        }
        continue;                                        // keep the higher/equal one
      }
      await existing.delete();                            // replace the lower one
    }
    await applyPersistentBoon(actor, boon, pl, item, { aura });
  }
}

/**
 * Perform an INSTANTANEOUS Persistent boon's effect for the wielder at turn start —
 * the SRD "invoke each round" behaviour. Restoration cures banes ≤ PL and adds its
 * fatigue immunity (via promptRestorationDispel, non-interactive when no higher-PL
 * banes are present); a dice boon (Heal) rolls its healing and posts an Apply
 * Healing card bound to the wielder. Mirrors the instantaneous branches of
 * {@link applyBoonToActor}. Other instantaneous/diceless boons fall through to a
 * plain re-grant (rare for Persistent).
 * @param {Actor} actor
 * @param {Item}  boon
 * @param {number} pl
 * @param {Item}  item
 * @returns {Promise<void>}
 */
async function applyPersistentInstantaneous(actor, boon, pl, item) {
  const esc = foundry.utils.escapeHTML ?? (s => s);
  // Restoration: cure banes ≤ PL (+ the 24h Fatigued immunity marker). Only invoke
  // when the wielder actually bears a bane — otherwise the automation would toast
  // "no banes to cure" every single turn.
  if ( boon.name === "Restoration" ) {
    const hasBane = (actor.effects?.contents ?? []).some(e => e.flags?.openlegend?.fromBane);
    if ( hasBane ) await promptRestorationDispel(actor, pl, null);
    return;
  }
  // Dice boon (Heal): roll its healing at PL and post an Apply Healing card bound
  // to the wielder — exactly like a manual instantaneous Heal grant.
  const invokeRoll = invocationRollFor(boon, pl);
  if ( invokeRoll ) {
    const roll = await (new Roll(invokeRoll.formula)).evaluate();
    const healTargets = [{ tokenUuid: actor.token?.uuid ?? actor.uuid, name: actor.name }];
    let flavor = `<strong>${esc(item?.name ?? "Persistent item")}</strong> — ${esc(boon.name)}${pl ? ` PL ${pl}` : ""} · ${esc(invokeRoll.text || "Healing")} (start of turn)`;
    flavor += renderHealApplyButtons(healTargets, roll.total);
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor });
    return;
  }
  // Diceless, non-Restoration instantaneous boon: nothing standard to re-run each
  // turn — apply the plain effect once (uniqueness handled by fromBoon on re-entry).
  const already = actor.effects.find(e => e.flags?.openlegend?.fromBoon === boon.name);
  if ( !already ) await applyPersistentBoon(actor, boon, pl, item);
}

/**
 * Non-interactive boon grant for the Persistent automation: create the boon's
 * leveled Active Effect(s) at a fixed PL directly on the actor (no prompt, no
 * duplicate/PL check — the caller {@link applyPersistentItemBoons} handles that),
 * stamp the source item, and post a brief chat note. Skips the special interactive
 * boons (Light/Detection/Invisible) prompts — a Persistent pick applies the plain
 * effect.
 * @param {Actor} actor
 * @param {Item}  boon        The boon document.
 * @param {number} powerLevel
 * @param {Item}  item        The source extraordinary item.
 * @returns {Promise<void>}
 */
export async function applyPersistentBoon(actor, boon, powerLevel, item, { aura = null } = {}) {
  const pl = Math.max(0, Math.floor(Number(powerLevel) || 0));
  const effectData = boonActiveEffectData(boon, pl).map(d => {
    d.flags ??= {};
    d.flags.openlegend = { ...(d.flags.openlegend ?? {}), persistentFromItem: item?.id ?? "" };
    return d;
  });
  // Aura: the radiated bane/boon payload rides on the (first) effect so the
  // live-aura engine picks it up — mirrors applyBoonToActor's grant path.
  if ( aura && effectData.length ) {
    effectData[0].flags.openlegend.aura = aura;
  }
  await actor.createEmbeddedDocuments("ActiveEffect", effectData);
  const esc = foundry.utils.escapeHTML ?? (s => s);
  const radiates = aura?.radiateName
    ? ` — radiates <strong>${esc(aura.radiateName)}</strong>${aura.radiatePowerLevel ? ` (PL ${aura.radiatePowerLevel})` : ""}`
    : "";
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="ol-boon-applied"><i class="fas fa-arrows-rotate"></i> <strong>${esc(item?.name ?? "Persistent item")}</strong> sustained <strong>${esc(boon.name)}</strong>${pl ? ` (PL ${pl})` : ""} on <strong>${esc(actor.name)}</strong>${radiates}.</div>`
  });
}

/**
 * Render a standalone "apply this rolled total" block for a healing/damage roll
 * that has NO pre-resolved targets (an extraordinary-item invocation has no attack
 * roll, so it resolves no targets): the rolled amount plus the two re-aim buttons
 * (bullseye → current target(s), square → current selection). GM-gated in the
 * chat hook. Mirrors a single row of {@link renderHealApplyButtons} /
 * {@link renderDamageApplyButtons} but without a bound token.
 * @param {"healing"|"damage"} kind
 * @param {number} amount  The rolled total.
 * @returns {string} HTML.
 */
function renderRolledAimButtons(kind, amount, { extraordinary = false } = {}) {
  const n = Math.max(0, Math.floor(Number(amount) || 0));
  const lethalNote = (kind === "healing" && extraordinary) ? " (+ lethal)" : "";
  const label = kind === "healing" ? `Heal ${n} HP${lethalNote}` : `Apply ${n} damage`;
  const icon = kind === "healing" ? "fa-heart" : "fa-heart-crack";
  return `
    <ul class="ol-target-results ol-heal-targets">
      <li class="ol-target-row is-hit">
        <span class="ol-target-name"><i class="fas ${icon}"></i> ${label}</span>
        <span class="ol-target-apply">
          ${renderApplyAimButtons(kind, n, "", { extraordinary })}
        </span>
      </li>
    </ul>`;
}

/**
 * Render a draggable chat-card handle that places an area Region. The shape
 * descriptor is JSON-encoded in a data attribute; the dragstart listener (wired
 * in renderChatMessageHTML) copies it into the drag payload, and the
 * dropCanvasData hook enters the interactive Region preview at the drop point.
 * @param {Item} action
 * @param {object} sys      The action system data (for the area-size label).
 * @param {object} template Region shape descriptor from areaTemplateData.
 * @returns {string} HTML.
 */
function renderTemplateHandle(action, sys, template) {
  const cfg = CONFIG.OPENLEGEND ?? {};
  const escape = foundry.utils.escapeHTML ?? (s => s);
  const shapeLabel = cfg.areaShapes?.[sys.area?.shape] ?? sys.area?.shape ?? "Area";
  // Size readout mirrors the sheet: line → "N × 5'×10'×10'" (chained segments),
  // cube/cone → "N'".
  let size = "";
  let ruleNote = "";
  if ( sys.area?.shape === "line" ) {
    const n = Math.max(1, Math.floor(Number(sys.area?.lines ?? 1)));
    size = n > 1 ? `${n} × 5'×10'×10'` : `5'×10'×10'`;
    // Surface the SRD chaining rule on the chip itself, before the drop.
    if ( n > 1 ) ruleNote = `. Lines are placed one at a time — each after the first must start from a corner of an already-placed line (no overlap); a counter by the cursor shows how many are left`;
  } else {
    const len = Math.max(0, Math.floor(Number(sys.area?.length ?? 0)));
    if ( len ) size = `${len}'`;
  }
  const payload = escape(JSON.stringify({ type: "openlegend.areaTemplate", template }));
  const tip = `Drag &amp; drop onto the battlefield to place this ${escape(shapeLabel)}${size ? ` (${escape(size)})` : ""} area template${ruleNote}`;
  return `
    <div class="ol-template-handle" draggable="true" data-template="${payload}"
         data-tooltip="${tip}" title="${tip}">
      <i class="fas fa-ruler-combined"></i>
      <span>Drag &amp; drop to place ${escape(shapeLabel)}${size ? ` (${escape(size)})` : ""}</span>
    </div>`;
}

/**
 * Render a draggable chat-card handle that applies a bane to a token when dropped
 * on it. Mirrors the area-template handle: the bane uuid + power level are JSON
 * encoded in a data attribute, the dragstart listener copies them into the drag
 * payload, and the dropCanvasData hook applies the bane to the token at the drop.
 * @param {object} sys  The bane action's system data (baneUuid, baneName, invokePowerLevel).
 * @param {object|null} [invokeRoll]  The bane's dice at the invoked level (from
 *   {@link invocationRollFor}) — rendered as a damage-roll button when present.
 * @returns {string} HTML, or "" if the action has no chosen bane.
 */
function renderBaneHandle(sys, invokeRoll = null, damageTargets = []) {
  if ( !sys.baneUuid ) return "";
  const escape = foundry.utils.escapeHTML ?? (s => s);
  const pl = Number(sys.invokePowerLevel ?? 0);
  const plText = pl ? ` (PL ${pl})` : "";
  const potent = !!sys.potent;
  const payload = escape(JSON.stringify({
    type: "openlegend.bane", baneUuid: sys.baneUuid, powerLevel: pl, potent
  }));
  // Compact chip: just the bane name + PL (+ Potent), both as the label and tooltip.
  const label = `${escape(sys.baneName)}${plText}${potent ? " · Potent" : ""}`;
  let html = `
    <span class="ol-bane-handle" draggable="true" data-bane="${payload}"
          data-tooltip="${label}" title="${label}">
      <i class="fas fa-skull"></i> ${label}
    </span>`;
  // Multi-Bane Specialist: an extra draggable chip per additional bane (each its
  // own PL; never Potent — Potent is a single-bane option).
  for ( const xb of (sys.extraBanes ?? []) ) {
    const xpl = Number(xb.powerLevel ?? 0);
    const xPayload = escape(JSON.stringify({ type: "openlegend.bane", baneUuid: xb.uuid, powerLevel: xpl, potent: false }));
    const xLabel = `${escape(xb.name)}${xpl ? ` (PL ${xpl})` : ""}`;
    html += `
    <span class="ol-bane-handle" draggable="true" data-bane="${xPayload}"
          data-tooltip="${xLabel}" title="${xLabel}">
      <i class="fas fa-skull"></i> ${xLabel}
    </span>`;
  }
  if ( invokeRoll ) html += renderInvokeRollButton("Damage", invokeRoll, sys.baneName, pl, { damageTargets });
  return html;
}

/**
 * Render a draggable chat-card handle that grants a boon to a token when dropped
 * on it. Mirrors the bane handle. Boons aren't opposed: the roll total decides
 * the highest power level achieved (CR = 10 + 2·PL), capped by the invoking
 * attribute's score — no level is chosen up front. That achieved level is encoded
 * in the handle so dropping it grants the boon at the level actually rolled. If
 * the roll failed to reach even the lowest defined level's CR, the handle is
 * omitted (nothing to grant).
 * @param {object} sys       The boon action's system data (boonUuid, boonName).
 * @param {number} attrScore The invoking attribute's score (caps the level).
 * @param {number} total     The evaluated roll total.
 * @param {object} [opts]
 * @param {object|null} [opts.invokeRoll]    The boon's dice at the achieved level.
 * @param {boolean} [opts.instantaneous]     The boon has no lasting duration.
 * @param {number}  [opts.achievedPl]        The level the roll achieved (0 = failed;
 *                                           auto-success passes the score's maximum).
 * @returns {string} HTML, or "" if the action has no chosen boon / the roll failed.
 */
function renderBoonHandle(sys, attrScore, total, { invokeRoll = null, instantaneous = false, healTargets = [], autoSuccess = false, extraordinary = false, achievedPl = 0 } = {}) {
  if ( !sys.boonUuid ) return "";
  const escape = foundry.utils.escapeHTML ?? (s => s);
  // The level the invocation landed at (computed by the caller from the roll
  // total, the boon's defined levels and the invoking score — auto-success lands
  // at the score's maximum). No level → the invocation failed, nothing to grant.
  const chosenPl = Math.max(0, Math.floor(Number(achievedPl) || 0));
  if ( chosenPl <= 0 ) return "";

  // Extraordinary Healing note shown on the card (before rolling) so the player
  // knows the upcoming roll will heal lethal damage too (1-hour invocation).
  const xhealNote = extraordinary
    ? `<div class="ol-xhealing-note"><i class="fas fa-skull"></i> Extraordinary Healing — this roll also heals <strong>lethal damage</strong> (restoring max HP); invocation takes 1 hour.</div>`
    : "";

  // An instantaneous dice boon (Heal) is rolled, not applied: only the button.
  if ( instantaneous && invokeRoll ) {
    return renderInvokeRollButton("Healing", invokeRoll, sys.boonName, chosenPl, { healTargets, extraordinary }) + xhealNote;
  }

  const plText = chosenPl ? ` (PL ${chosenPl})` : "";
  const payload = escape(JSON.stringify({
    type: "openlegend.boon", boonUuid: sys.boonUuid, powerLevel: chosenPl
  }));
  // Compact chip: the boon name + PL, both as the label and the tooltip.
  const label = `${escape(sys.boonName)}${plText}`;
  let html = `
    <span class="ol-boon-handle" draggable="true" data-boon="${payload}"
          data-tooltip="${label}" title="${label}">
      <i class="fas fa-hands-holding"></i> ${label}
    </span>`;
  // A lasting dice boon (Regeneration) gets the roll button alongside the chip.
  if ( invokeRoll ) html += renderInvokeRollButton("Healing", invokeRoll, sys.boonName, chosenPl, { healTargets, extraordinary });
  html += xhealNote;
  return html;
}

/**
 * The power level a bane/boon is actually invoked at, given the item's listed
 * GRANT VALUE. Per the rules, the granted numeric value is the MAXIMUM power
 * level; you invoke at the highest level the bane/boon defines at or below it
 * (e.g. Detection only defines PL 1, so a "Detection 6" grant invokes at PL 1
 * even though its dice come from the value 6). Falls back to clamping the grant
 * value to the doc's [min, 9] when it defines no explicit power-effect levels.
 * @param {Item} doc           The bane/boon document.
 * @param {number} grantValue  The item's listed numeric value (1–9).
 * @returns {number}           The capped invocation power level.
 */
function cappedInvokePowerLevel(doc, grantValue) {
  const v = Math.max(0, Math.floor(Number(grantValue) || 0));
  if ( v <= 0 ) return 0;
  const levels = [...new Set(
    (doc?.system?.powerEffects ?? []).map(pe => Number(pe.powerLevel)).filter(n => Number.isFinite(n) && (n > 0))
  )].sort((a, b) => a - b);
  if ( levels.length ) {
    const atOrBelow = levels.filter(l => l <= v);
    return atOrBelow.length ? atOrBelow[atOrBelow.length - 1] : levels[0];
  }
  const min = Math.max(1, Math.floor(Number(doc?.system?.powerLevel) || 1));
  return Math.min(v, Math.max(min, v));
}

/**
 * The invocation roll an item grants for a bane/boon: 1d20 plus the bonus dice
 * for an attribute score equal to the item's listed GRANT VALUE (the value sets
 * the attribute dice; rules treat it as an attribute of that score). All Open
 * Legend dice explode. Returns null when the value grants no dice (score 0).
 * @param {number} grantValue  The item's listed numeric value (1–9).
 * @returns {{dice: string, formula: string}}
 */
function itemInvocationRoll(grantValue) {
  const cfg = CONFIG.OPENLEGEND ?? {};
  const v = Math.max(0, Math.floor(Number(grantValue) || 0));
  const dice = cfg.diceForScore ? cfg.diceForScore(v) : ((cfg.attributeDice ?? {})[v] ?? "");
  const explodingDice = dice ? dice.replace(/(\d+d\d+)/gi, "$1x") : "";
  const formula = explodingDice ? `1d20x + ${explodingDice}` : "1d20x";
  return { dice, formula };
}

/**
 * Roll an item-granted bane/boon invocation and post a result card. The roll is
 * 1d20 + the grant value's attribute dice (per the rules — the item's numeric
 * value acts as the invoking attribute score). The card carries the DRAGGABLE
 * chip at the (value-capped) invocation power level so the GM can apply it to a
 * token, plus — for dice effects (Heal, Persistent Damage) — the existing
 * heal/damage roll button at the invoked level. Used by the extraordinary-item
 * sheet's invoke buttons.
 * @param {object} args
 * @param {Item}   args.doc         The resolved bane/boon document.
 * @param {"bane"|"boon"} args.kind
 * @param {number} args.powerLevel  The item's listed GRANT VALUE (1–9): sets the
 *   roll dice and caps the invocation level.
 * @param {string} [args.sourceName] The granting item's name, for the card text.
 * @param {Actor}  [args.actor]     Speaker actor for the chat message.
 * @param {boolean} [args.potent]   Mark a bane chip Potent (resists at disadvantage 1).
 * @returns {Promise<ChatMessage|void>}
 */
export async function postInvocationCard({ doc, kind, powerLevel = 0, sourceName = "", actor = null, potent = false }) {
  if ( !doc ) return;
  const escape = foundry.utils.escapeHTML ?? (s => s);
  const grantValue = Math.max(0, Math.floor(Number(powerLevel) || 0));
  const pl = cappedInvokePowerLevel(doc, grantValue);     // capped invocation level

  // The invocation roll itself: 1d20 + the grant value's attribute dice. This is
  // the roll the wielder makes to invoke (the value acts as the attribute score).
  const { dice: invDice, formula: invFormula } = itemInvocationRoll(grantValue);
  const speaker = actor ? ChatMessage.getSpeaker({ actor }) : ChatMessage.getSpeaker();
  const roll = await (new Roll(invFormula)).evaluate();

  const from = sourceName ? ` from <strong>${escape(sourceName)}</strong>` : "";
  const grantText = grantValue ? ` ${grantValue}` : "";
  const plNote = (pl && (pl !== grantValue)) ? ` — invoked at PL ${pl}` : "";
  const diceNote = invDice ? ` (1d20 + ${escape(invDice)})` : " (1d20)";

  // The 1d20 roll above is the wielder's INVOCATION roll only — it is NOT the
  // effect's magnitude. The effect's dice are FIXED by its power level (Heal PL 5
  // → 2d6; Persistent Damage 1d6/round) and get their own roll button. So Heal
  // mirrors Persistent Damage: post the invocation roll for the user, then offer
  // a "Roll Healing" button (the fixed PL dice). An INSTANTANEOUS dice boon (Heal)
  // is rolled-then-applied via that button only — no draggable chip; a lasting
  // boon/bane (Regeneration, conditions) gets the chip to apply at the invoked PL.
  const instantaneous = /instant/i.test(String(doc.system?.duration ?? ""));
  const invokeRoll = invocationRollFor(doc, pl);   // FIXED effect dice (Heal/Persistent Damage)
  const sys = (kind === "bane")
    ? { baneUuid: doc.uuid, baneName: doc.name, invokePowerLevel: pl, potent: !!potent }
    : { boonUuid: doc.uuid, boonName: doc.name, invokePowerLevel: pl };
  const handle = (kind === "bane")
    ? renderBaneHandle(sys, invokeRoll)
    // Boons aren't opposed by the chip path (no CR check here): pass scores that
    // always clear it. An instantaneous Heal returns only its "Roll Healing" button.
    : renderBoonHandle(sys, Infinity, Infinity, { invokeRoll, instantaneous });
  const extra = `<div class="ol-invocation-chips">${handle}</div>`;
  // An instantaneous Heal has no chip — just the roll-healing button.
  const action = (kind === "boon" && instantaneous && invokeRoll)
    ? "roll the healing below (its dice are fixed by power level)"
    : `drag the chip onto a token to ${kind === "bane" ? "afflict it" : "grant it"}, or onto the hotbar for a macro`;

  const flavor = `<div class="ol-item-invocation">
    ${renderCardHeader({ title: `${doc.name}${grantText}`, sub: `invocation roll${diceNote}${from}${plNote}` })}
    <p class="ol-card-hint">${action.charAt(0).toUpperCase()}${action.slice(1)}.</p>
    ${extra}
  </div>`;
  return roll.toMessage({ speaker, flavor });
}

/* -------------------------------------------- */

/**
 * The defense a bane targets (uniform across its attack lines), e.g. "guard".
 * @param {Item} bane
 * @returns {string} lowercase defense key, or "guard" as a fallback.
 */
function baneDefenseKey(bane) {
  const def = (bane?.system?.attacks ?? [])[0]?.defense;
  return String(def || "guard").trim().toLowerCase();
}

/**
 * Open the "apply a bane" picker for the margin rider on a damaging attack
 * (SRD: "If your attack roll exceeds the target's defense by 10 or more, you may
 * apply one bane of a power level ≤ the attribute you used; the attack roll must
 * also equal/exceed that bane's defense"). Bane Focus lowers the margin to 5 for
 * the FOCUSED bane(s). Lists every bane the actor can invoke whose power level ≤
 * `attrScore`; an option is selectable only when (a) the attack `total` meets the
 * target's defense for that bane, AND (b) the margin qualifies: ≥10 for any bane,
 * or ≥5 for a Bane Focus bane. On pick, posts a bane card (draggable chip +
 * Apply-to-target button + target/selection aim buttons) at the highest power
 * level ≤ attrScore the bane defines.
 * @param {object} args
 * @param {string} args.actorUuid   The attacking actor (its invocable banes + Bane Focus).
 * @param {string} args.tokenUuid   The originally-hit target token.
 * @param {number} args.attrScore   The attack attribute's score (caps bane PL).
 * @param {number} args.total       The attack roll total (must meet bane defense).
 * @param {number} [args.margin]    The attack's margin over the target's defense.
 * @returns {Promise<ChatMessage|void>}
 */
/**
 * Post a bane card: a draggable chip + an Apply-to-token button (bound to
 * `tokenUuid`) + target/selection aim buttons, invoked at the highest power level
 * the bane defines that is ≤ `cap`. Shared by the margin-10 rider
 * ({@link attackBaneDialog}), Battlefield Punisher ({@link postPunisherBaneCard}),
 * and the attack-miss "Inflict bane" option ({@link missEffectBaneDialog}).
 * @param {object} args
 * @param {Item}   args.bane        The bane document.
 * @param {number} args.cap         Highest power level allowed (caps the invoked PL).
 * @param {string} [args.tokenUuid] Token the Apply button targets (omit for chip-only).
 * @param {string} [args.targetName] Display name for the bound target.
 * @param {Actor}  [args.actor]     Speaker actor.
 * @param {string} [args.intro]     Lead sentence (HTML) for the card.
 * @param {boolean} [args.potent]   Apply the bane as Potent (target resists at
 *                                  disadvantage 1) — set by the Potent Bane feat.
 * @returns {Promise<ChatMessage|void>}
 */
async function postBaneCard({ bane, cap, tokenUuid = "", targetName = "the target", actor = null, intro = "", potent = false }) {
  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
  const capN = Math.max(0, Math.floor(Number(cap) || 0));
  // Highest power level the bane defines that is ≤ the cap.
  const levels = [...new Set((bane.system?.powerEffects ?? [])
    .map(pe => Number(pe.powerLevel)).filter(n => Number.isFinite(n) && (n > 0)))].sort((a, b) => a - b);
  const reachable = levels.filter(l => l <= capN);
  const pl = reachable.length ? reachable[reachable.length - 1] : Math.min(capN || Infinity, Math.max(1, Number(bane.system?.powerLevel) || 1));

  potent = !!potent;
  const potentTag = potent ? ` <i class="fas fa-biohazard" title="Potent"></i>` : "";
  const sys = { baneUuid: bane.uuid, baneName: bane.name, invokePowerLevel: pl, potent };
  const chip = renderBaneHandle(sys);
  const boundApply = tokenUuid
    ? `<button type="button" class="ol-apply-bane ol-apply-mini" data-token-uuid="${esc(tokenUuid)}" data-bane-uuid="${esc(bane.uuid)}" data-power-level="${pl}" data-potent="${potent ? 1 : 0}" data-tooltip="Apply ${esc(bane.name)} PL ${pl}${potent ? " (Potent)" : ""} to ${esc(targetName)}">
         <i class="fas fa-skull"></i> Apply${potentTag}
       </button>`
    : "";
  const applyRow = `
    <ul class="ol-target-results ol-heal-targets">
      <li class="ol-target-row is-hit">
        <span class="ol-target-name"><i class="fas fa-skull"></i> ${esc(bane.name)} (PL ${pl})${potentTag}</span>
        <span class="ol-target-apply">${boundApply}${renderBaneAimButtons(bane.uuid, pl, potent)}</span>
      </li>
    </ul>`;

  const flavor = `<div class="ol-item-invocation">
    <p>${intro || `<strong>${esc(bane.name)}</strong> (PL ${pl}).`} Apply below, drag the chip, or re-aim to your current target/selection.</p>
    <div class="ol-invocation-chips">${chip}</div>
    ${applyRow}
  </div>`;
  return ChatMessage.create({
    speaker: actor ? ChatMessage.getSpeaker({ actor }) : ChatMessage.getSpeaker(),
    content: flavor
  });
}

/**
 * The two "re-aim" mini-buttons for a boon card: apply to the GM's current
 * target(s) / current selection at click time. Mirrors {@link renderBaneAimButtons};
 * the chat hook grants them via applyRolledToAim(kind:"boon").
 * @param {string} boonUuid
 * @param {number} powerLevel
 * @returns {string} HTML.
 */
function renderBoonAimButtons(boonUuid, powerLevel = 0) {
  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
  const pl = Math.max(0, Math.floor(Number(powerLevel) || 0));
  return `
    <button type="button" class="ol-aim-target ol-apply-mini" data-kind="boon" data-boon-uuid="${esc(boonUuid)}" data-power-level="${pl}" data-tooltip="Grant to current target(s)">
      <i class="fas fa-bullseye"></i>
    </button>
    <button type="button" class="ol-aim-selected ol-apply-mini" data-kind="boon" data-boon-uuid="${esc(boonUuid)}" data-power-level="${pl}" data-tooltip="Grant to current selection">
      <i class="far fa-square"></i>
    </button>`;
}

/**
 * Post a boon card: a draggable chip + a Grant-to-token button (bound to
 * `tokenUuid`) + target/selection aim buttons, invoked at the highest power level
 * the boon defines that is ≤ `cap`. The invocation auto-succeeds (no roll) — used
 * by the Consumable-item "Consume" flow. An INSTANTANEOUS dice boon (Heal) shows a
 * "Roll Healing" button instead of a chip (its dice are fixed by power level);
 * applying/aiming runs the instantaneous effect via {@link applyBoonToActor}.
 * Mirrors {@link postBaneCard}.
 * @param {object} args
 * @param {Item}   args.boon        The boon document.
 * @param {number} args.cap         The item's granted value (caps the invoked PL).
 * @param {string} [args.tokenUuid] Token the Grant button targets (omit for chip-only).
 * @param {string} [args.targetName] Display name for the bound target.
 * @param {Actor}  [args.actor]     Speaker actor.
 * @param {string} [args.intro]     Lead sentence (HTML) for the card.
 * @returns {Promise<ChatMessage|void>}
 */
export async function postBoonCard({ boon, cap, tokenUuid = "", targetName = "the target", actor = null, intro = "" }) {
  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
  const pl = cappedInvokePowerLevel(boon, cap);
  const instantaneous = /instant/i.test(String(boon.system?.duration ?? ""));
  const invokeRoll = invocationRollFor(boon, pl);   // fixed effect dice (Heal), else null
  const sys = { boonUuid: boon.uuid, boonName: boon.name, invokePowerLevel: pl };
  // Auto-success invocation: pass scores that always clear the CR check. For an
  // instantaneous Heal this returns just the "Roll Healing" button; a lasting boon
  // returns the drag chip (+ a roll button for a lasting dice boon like Regeneration).
  const chip = renderBoonHandle(sys, Infinity, Infinity, { invokeRoll, instantaneous });

  // A lasting boon gets a bound Grant + aim buttons. An instantaneous dice boon is
  // rolled-then-applied through the "Roll Healing" button, so no Grant/aim row.
  let applyRow = "";
  if ( !(instantaneous && invokeRoll) ) {
    const boundApply = tokenUuid
      ? `<button type="button" class="ol-apply-boon ol-apply-mini" data-token-uuid="${esc(tokenUuid)}" data-boon-uuid="${esc(boon.uuid)}" data-power-level="${pl}" data-tooltip="Grant ${esc(boon.name)} PL ${pl} to ${esc(targetName)}">
           <i class="fas fa-hands-holding"></i> Grant
         </button>`
      : "";
    applyRow = `
      <ul class="ol-target-results ol-heal-targets">
        <li class="ol-target-row is-hit">
          <span class="ol-target-name"><i class="fas fa-hands-holding"></i> ${esc(boon.name)} (PL ${pl})</span>
          <span class="ol-target-apply">${boundApply}${renderBoonAimButtons(boon.uuid, pl)}</span>
        </li>
      </ul>`;
  }

  const flavor = `<div class="ol-item-invocation">
    <p>${intro || `<strong>${esc(boon.name)}</strong> (PL ${pl}).`} Grant below, drag the chip, or re-aim to your current target/selection.</p>
    <div class="ol-invocation-chips">${chip}</div>
    ${applyRow}
  </div>`;
  return ChatMessage.create({
    speaker: actor ? ChatMessage.getSpeaker({ actor }) : ChatMessage.getSpeaker(),
    content: flavor
  });
}

export async function attackBaneDialog({ actorUuid, tokenUuid, attrScore, total, margin = 10, baneful = "" }) {
  const cfg = CONFIG.OPENLEGEND ?? {};
  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
  const cap = Math.max(0, Math.floor(Number(attrScore) || 0));
  const rollTotal = Math.floor(Number(total) || 0);
  const mgn = Math.floor(Number(margin) || 0);
  // Baneful weapon: this specific bane also qualifies at margin 5 (like a focused
  // bane), even if the actor can't otherwise invoke it (SRD "in lieu of other
  // banes, even if the item or wielder cannot access the bane").
  const banefulName = String(baneful ?? "").trim().toLowerCase();

  const actor = actorUuid ? await fromUuid(actorUuid) : null;
  const focused = cfg.baneFocusNames ? cfg.baneFocusNames(actor) : new Set();

  const tokenDoc = await fromUuid(tokenUuid);
  const tActor = tokenDoc?.actor ?? tokenDoc;
  const tName = tokenDoc?.name ?? tActor?.name ?? "the target";

  // Banes invocable at power level ≤ the attribute score: non-private world
  // banes plus the system compendium's (world wins on a name tie). A bane's
  // `pl` here is the HIGHEST level it defines that is ≤ the cap — the same
  // level postBaneCard will actually apply — NOT its base/minimum level, so the
  // picker shows what you'll really get. `minPl` (its lowest breakpoint) decides
  // whether the bane is invocable at all (a bane whose cheapest level exceeds the
  // cap can't be applied). Falls back to the base powerLevel when a bane has no
  // powerEffects breakpoints.
  const docs = await selectableDocuments("bane", "tomucatos-open-legend-rpg-system.banes");
  const banes = docs
    .map(e => {
      const base = Math.max(0, Math.floor(Number(e.system?.powerLevel) || 0));
      const levels = [...new Set((e.system?.powerEffects ?? [])
        .map(pe => Math.floor(Number(pe.powerLevel))).filter(n => Number.isFinite(n) && (n > 0)))].sort((a, b) => a - b);
      const all = levels.length ? levels : (base > 0 ? [base] : []);
      const minPl = all.length ? all[0] : base;
      const reachable = all.filter(l => l <= cap);
      const pl = reachable.length ? reachable[reachable.length - 1] : minPl;   // highest ≤ cap
      return { id: e.uuid, name: e.name, pl, minPl,
               defenseKey: String((e.system?.attacks ?? [])[0]?.defense || "guard").trim().toLowerCase(),
               focus: focused.has(String(e.name).trim().toLowerCase()),
               baneful: !!banefulName && (String(e.name).trim().toLowerCase() === banefulName) };
    })
    .filter(b => b.minPl > 0 && b.minPl <= cap)
    .sort((a, b) => (a.pl - b.pl) || a.name.localeCompare(b.name));
  if ( !banes.length ) { ui.notifications?.warn(`No invocable banes at power level ≤ ${cap}.`); return; }

  // Each option is selectable only when the roll meets the bane's defense AND the
  // margin qualifies: ≥10 for any bane, or ≥5 for a Bane Focus OR the weapon's
  // Baneful bane.
  const opts = banes.map(b => {
    const defVal = Number(tActor?.system?.defenses?.[b.defenseKey]?.value);
    const meetsDef = !Number.isFinite(defVal) || (rollTotal >= defVal);
    const meetsMargin = (mgn >= 10) || ((b.focus || b.baneful) && (mgn >= 5));
    const ok = meetsDef && meetsMargin;
    const defLabel = cfg.targetDefenses?.[b.defenseKey] ?? b.defenseKey;
    let note = Number.isFinite(defVal) ? `${defLabel} ${defVal}` : defLabel;
    if ( !meetsDef ) note += " — roll misses";
    else if ( !meetsMargin ) note += " — needs margin 10";
    const tag = b.baneful ? " ★Baneful" : (b.focus ? " ★Focus" : "");
    return `<option value="${esc(b.id)}" data-pl="${b.pl}" ${ok ? "" : "disabled"}>${esc(b.name)}${tag} (PL ${b.pl}, vs ${esc(note)})</option>`;
  }).join("");

  // A Baneful weapon (or Bane Focus) surfaces the 5+ path in the header.
  const banefulHint = banefulName
    ? ` A ★Baneful bane (from your weapon) qualifies at margin 5.`
    : "";
  const content = `
    <div class="ol-attack-bane ol-feat-choice">
      <p>Apply one bane to <strong>${esc(tName)}</strong> at margin ≥ 10 (or ≥ 5 for a ★Focus/★Baneful bane) — power level ≤ ${cap}; the attack roll <strong>${rollTotal}</strong> must meet the bane's defense.${banefulHint}</p>
      <div class="form-group">
        <label>Bane</label>
        <select name="bane"><option value="">—</option>${opts}</select>
      </div>
    </div>`;

  const { DialogV2 } = foundry.applications.api;
  const baneId = await DialogV2.wait({
    window: { title: "Apply a Bane (margin 10)" },
    classes: ["openlegend"],
    content,
    rejectClose: false,
    buttons: [
      { action: "ok", label: "Choose Bane", icon: "fas fa-skull", default: true,
        callback: (event, button, dialog) => dialog.element.querySelector('select[name="bane"]')?.value ?? "" },
      { action: "cancel", label: "Cancel", icon: "fas fa-times" }
    ]
  });
  if ( !baneId ) return;

  const bane = await fromUuid(baneId);
  if ( !bane ) { ui.notifications?.warn("Bane not found."); return; }
  // Potent Bane (feat): if the attacker has it for this bane, the bane is Potent.
  const potent = cfg.isPotentBane?.(actor, bane.name) ?? false;
  const isBaneful = !!banefulName && (String(bane.name).trim().toLowerCase() === banefulName);
  const source = isBaneful ? "Baneful weapon" : "margin attack";
  return postBaneCard({
    bane, cap, tokenUuid, targetName: tName, actor, potent,
    intro: `<strong>${esc(bane.name)}</strong> — bane from a ${source} on <strong>${esc(tName)}</strong>.${potent ? " <em>Potent</em> (Potent Bane)." : ""}`
  });
}

/**
 * Post a bane card for the Battlefield Punisher feat: the defender's chosen bane,
 * pre-selected (no picker), bound to the ATTACKER token. Mirrors the bane card
 * from {@link attackBaneDialog} (chip + Apply-to-attacker + 🎯/▢ aim buttons).
 * Invoked at the highest power level the bane defines that is ≤ `attrScore` (the
 * defend attribute's score). Called from the Defend card's "Punish" button when
 * the defender dealt ≥10 Battlefield Retribution damage with a qualifying attribute.
 * @param {object} args
 * @param {string} args.baneName          The chosen bane's name.
 * @param {string} args.attackerTokenUuid The attacker token to afflict.
 * @param {string} [args.attackerName]    Display name for the card text.
 * @param {number} args.attrScore         The defend attribute's score (caps PL).
 * @param {Actor}  [args.actor]           Speaker actor (the defender).
 * @returns {Promise<ChatMessage|void>}
 */
export async function postPunisherBaneCard({ baneName, attackerTokenUuid, attackerName = "the attacker", attrScore, actor = null }) {
  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
  const cap = Math.max(0, Math.floor(Number(attrScore) || 0));
  // Resolve the bane (world item, then the banes compendium).
  let bane = game.items?.find(i => (i.type === "bane") && (i.name === baneName)) ?? null;
  if ( !bane ) {
    const pack = game.packs?.get("tomucatos-open-legend-rpg-system.banes");
    if ( pack ) {
      const idx = await pack.getIndex();
      const entry = idx.find(e => e.name === baneName);
      if ( entry ) bane = await pack.getDocument(entry._id);
    }
  }
  if ( !bane ) { ui.notifications?.warn(`Bane "${baneName}" not found.`); return; }
  return postBaneCard({
    bane, cap, tokenUuid: attackerTokenUuid, targetName: attackerName, actor,
    intro: `<strong>Battlefield Punisher</strong> — <strong>${esc(bane.name)}</strong> on <strong>${esc(attackerName)}</strong>.`
  });
}

/**
 * The 🎯 / ▢ "re-aim" buttons for a bane: apply the bane to the current target(s)
 * or current selection. Mirror the damage/heal aim buttons but carry a bane uuid
 * + power level; the chat hook applies them via applyRolledToAim(kind:"bane").
 * @param {string} baneUuid
 * @param {number} powerLevel
 * @param {boolean} [potent]  Apply the bane as Potent (resists at disadvantage 1).
 * @returns {string} HTML.
 */
function renderBaneAimButtons(baneUuid, powerLevel = 0, potent = false) {
  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
  const pl = Math.max(0, Math.floor(Number(powerLevel) || 0));
  const p = potent ? 1 : 0;
  return `
    <button type="button" class="ol-aim-target ol-apply-mini" data-kind="bane" data-bane-uuid="${esc(baneUuid)}" data-power-level="${pl}" data-potent="${p}" data-tooltip="Apply to current target(s)">
      <i class="fas fa-bullseye"></i>
    </button>
    <button type="button" class="ol-aim-selected ol-apply-mini" data-kind="bane" data-bane-uuid="${esc(baneUuid)}" data-power-level="${pl}" data-potent="${p}" data-tooltip="Apply to current selection">
      <i class="far fa-square"></i>
    </button>`;
}

/* -------------------------------------------- */
/*  Attack-miss effects (SRD "on a miss" rule)  */
/* -------------------------------------------- */

/** Power-level cap for a bane inflicted by the attack-miss option. */
const MISS_BANE_PL_CAP = 3;
/** Flat damage dealt by the attack-miss "Deal 3 damage" option. */
const MISS_DAMAGE = 3;
/** Distance (feet) of the attack-miss "Move" option. */
const MISS_MOVE_FEET = 10;

/**
 * Render the "Miss — choose 1" option bar shown on a missed attack card. The SRD
 * rule lets the GM and the PC EACH pick one of: deal 3 damage, inflict 1 bane
 * (PL ≤ 3), or move 10' without provoking opportunity attacks. We surface a row of
 * three icon buttons for every actor involved in the attack — the attacker and
 * each MISSED target — so either side can record their choice.
 * @param {object} args
 * @param {string} args.rollerName  The attacker's display name.
 * @param {string} args.actorUuid   The attacker actor uuid (also the bane PL source).
 * @param {Array}  args.results     Resolved target rows (missed ones get a bar).
 * @returns {string} HTML, or "" when there is nothing to miss against.
 */
function renderMissOptions({ rollerName, actorUuid, results }) {
  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
  const missed = (results ?? []).filter(r => !r.hit && !r.resistImmune && r.tokenUuid);
  // Only relevant when the attack actually MISSED a target — never on a clean hit.
  if ( !missed.length ) return "";
  // The attacker is listed alongside each missed target (both the GM and the PC
  // choose one of the miss options).
  const actors = [];
  if ( actorUuid ) actors.push({ uuid: actorUuid, name: rollerName, attacker: true });
  for ( const r of missed ) actors.push({ uuid: r.tokenUuid, name: r.name, attacker: false });

  const rows = actors.map(a => {
    const tip = esc(a.name);
    // data-token-uuid is the apply target (an actor uuid works for the attacker —
    // applyDamageToToken resolves actor-or-token uuids the same way).
    const dmgBtn = `<button type="button" class="ol-miss-damage ol-apply-mini" data-token-uuid="${esc(a.uuid)}" data-name="${tip}" data-tooltip="Deal ${MISS_DAMAGE} damage"><i class="fas fa-heart-crack"></i></button>`;
    const baneBtn = `<button type="button" class="ol-miss-bane ol-apply-mini" data-token-uuid="${esc(a.uuid)}" data-actor-uuid="${esc(actorUuid)}" data-name="${tip}" data-tooltip="Inflict 1 bane of power level &le; ${MISS_BANE_PL_CAP}"><i class="fas fa-skull"></i></button>`;
    const moveBtn = `<button type="button" class="ol-miss-move ol-apply-mini" data-name="${tip}" data-tooltip="Move ${MISS_MOVE_FEET}' w/o opportunity attacks"><i class="fas fa-person-walking"></i></button>`;
    return `
      <li class="ol-miss-row">
        <span class="ol-miss-name">${esc(a.name)}${a.attacker ? " <em>(attacker)</em>" : ""}</span>
        <span class="ol-miss-buttons">${dmgBtn}${baneBtn}${moveBtn}</span>
      </li>`;
  }).join("");

  return `
    <div class="ol-miss-options">
      <div class="ol-miss-head" data-tooltip="On a miss, the GM and the PC each choose one: deal ${MISS_DAMAGE} damage, inflict 1 bane (PL &le; ${MISS_BANE_PL_CAP}), or move ${MISS_MOVE_FEET}' without provoking opportunity attacks.">
        <i class="fas fa-circle-xmark"></i> Miss — choose 1 (GM &amp; PC)
      </div>
      <ul class="ol-miss-list">${rows}</ul>
    </div>`;
}

/**
 * Attack-miss "Deal 3 damage" option: apply the flat miss damage to a token (or
 * the attacker actor), reusing the standard damage path (chat note + undo).
 * @param {string} tokenUuid  Token or actor uuid to damage.
 * @returns {Promise<void>}
 */
export async function missDealDamage(tokenUuid) {
  if ( !tokenUuid ) return;
  return applyDamageToToken(tokenUuid, MISS_DAMAGE, "", `miss-${foundry.utils.randomID?.() ?? tokenUuid}`);
}

/**
 * Attack-miss "Move 10'" option: informational only (no token automation) — post a
 * chat note that the actor may move 10' without provoking opportunity attacks.
 * @param {string} name  The actor's display name.
 * @returns {Promise<ChatMessage|void>}
 */
export async function missMoveNote(name) {
  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
  return ChatMessage.create({
    content: `<div class="ol-rest-result"><i class="fas fa-person-walking"></i> <strong>${esc(name || "The creature")}</strong> may move ${MISS_MOVE_FEET}' without provoking opportunity attacks (miss effect).</div>`
  });
}

/**
 * Attack-miss "Inflict 1 bane (PL ≤ 3)" option: pick any bane from the banes
 * compendium with power level ≤ 3, then post a bane card bound to the chosen actor
 * (chip + Apply + aim buttons). Unlike the margin-10 rider, there is no defense /
 * margin gating — the miss rule just grants a low-power bane.
 * @param {object} args
 * @param {string} args.tokenUuid   Token (or actor) uuid the bane targets.
 * @param {string} [args.name]      Display name for the target.
 * @param {string} [args.actorUuid] The attacking actor (card speaker).
 * @returns {Promise<ChatMessage|void>}
 */
export async function missEffectBaneDialog({ tokenUuid, name = "the target", actorUuid = "" }) {
  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
  // Non-private world banes plus the system compendium's (world wins on a name tie).
  const docs = await selectableDocuments("bane", "tomucatos-open-legend-rpg-system.banes");
  const banes = docs
    .map(e => ({ id: e.uuid, name: e.name, pl: Math.max(0, Math.floor(Number(e.system?.powerLevel) || 0)) }))
    .filter(b => b.pl > 0 && b.pl <= MISS_BANE_PL_CAP)
    .sort((a, b) => (a.pl - b.pl) || a.name.localeCompare(b.name));
  if ( !banes.length ) { ui.notifications?.warn(`No banes at power level ≤ ${MISS_BANE_PL_CAP}.`); return; }

  const opts = banes.map(b => `<option value="${esc(b.id)}">${esc(b.name)} (PL ${b.pl})</option>`).join("");
  const content = `
    <div class="ol-attack-bane ol-feat-choice">
      <p>On a miss — inflict one bane (power level &le; ${MISS_BANE_PL_CAP}) on <strong>${esc(name)}</strong>.</p>
      <div class="form-group">
        <label>Bane</label>
        <select name="bane"><option value="">—</option>${opts}</select>
      </div>
    </div>`;

  const { DialogV2 } = foundry.applications.api;
  const baneId = await DialogV2.wait({
    window: { title: "Inflict a Bane (miss)" },
    classes: ["openlegend"],
    content,
    rejectClose: false,
    buttons: [
      { action: "ok", label: "Choose Bane", icon: "fas fa-skull", default: true,
        callback: (event, button, dialog) => dialog.element.querySelector('select[name="bane"]')?.value ?? "" },
      { action: "cancel", label: "Cancel", icon: "fas fa-times" }
    ]
  });
  if ( !baneId ) return;

  const bane = await fromUuid(baneId);
  if ( !bane ) { ui.notifications?.warn("Bane not found."); return; }
  const actor = actorUuid ? await fromUuid(actorUuid) : null;
  const cfg = CONFIG.OPENLEGEND ?? {};
  // Potent Bane (feat): if the attacker has it for this bane, the bane is Potent.
  const potent = cfg.isPotentBane?.(actor, bane.name) ?? false;
  return postBaneCard({
    bane, cap: MISS_BANE_PL_CAP, tokenUuid, targetName: name, actor, potent,
    intro: `<strong>${esc(bane.name)}</strong> — bane inflicted on a missed attack against <strong>${esc(name)}</strong>.${potent ? " <em>Potent</em> (Potent Bane)." : ""}`
  });
}

/* -------------------------------------------- */

/**
 * Place an area attack at a canvas point via the interactive Region preview.
 * Exposed on the game API for macros; the live drop path calls
 * previewAreaTemplate directly. MeasuredTemplate was deprecated in Foundry v14
 * (merged into the Region document), so areas are now native Region shapes.
 * @param {object} shape  Shape descriptor from CONFIG.areaTemplateData (game units).
 * @param {{x: number, y: number}} [point]  Starting canvas point.
 * @returns {Promise<RegionDocument|null>}
 */
export async function placeAreaTemplate(shape, point = {}) {
  const { previewAreaTemplate } = await import("../canvas/template-preview.mjs");
  return previewAreaTemplate(shape, point);
}

/* -------------------------------------------- */

/**
 * Build per-target hit/damage results for an action roll against the rolling
 * user's current targets. Only damaging actions produce damage (roll − defense
 * on a hit); other categories still report the roll vs. the chosen defense but
 * carry zero damage. Targets without a resolvable actor/defense are skipped.
 * @param {object} args
 * @param {Item} args.action  The action item.
 * @param {number} args.total The evaluated roll total.
 * @returns {Array<{tokenUuid: string, name: string, img: string, defenseLabel: string,
 *   defenseValue: number, total: number, hit: boolean, damage: number, applicable: boolean}>}
 */
/**
 * The tokens an action roll resolves against: the rolling user's explicit
 * targets (Foundry's target set — press T, or Shift+T / shift-click to target
 * more than one). As a convenience fallback, when NOTHING is targeted we use the
 * user's currently SELECTED (controlled) tokens instead, so a GM can group-select
 * several foes and roll without also target-clicking each. Returns an array (never
 * a live Set) so callers can rely on stable iteration.
 * @returns {Array<Token>}
 */
function actionTargetTokens() {
  const targeted = [...(game.user?.targets ?? [])];
  if ( targeted.length ) return targeted;
  return [...(canvas?.tokens?.controlled ?? [])];
}

function resolveTargets({ action, total, attrScore = Infinity, suppressGrant = false, minBaneMargin = 10, autoSuccess = false, actorUuid = "", boonLevels = [] }) {
  const cfg = CONFIG.OPENLEGEND ?? {};
  const sys = action.system;
  const isDamaging = (sys.actionCategory === "damaging");
  const isBane = (sys.actionCategory === "bane");
  const isBoon = (sys.actionCategory === "boon");

  // Boons resolve against a Challenge Rating, not a defense; handle separately.
  if ( isBoon ) return resolveBoonTargets({ sys, total, attrScore, suppressGrant, autoSuccess, actorUuid, boonLevels });

  const usesDefense = isDamaging || isBane;
  if ( !usesDefense ) return [];

  const defKey = sys.targetDefense || "guard";
  const defLabel = cfg.targetDefenses?.[defKey] ?? defKey;
  // Human-readable damage type label (damaging actions only), e.g. "Fire";
  // includes user-defined types.
  const damageType = (isDamaging && sys.damageType)
    ? ((cfg.allDamageTypes ? cfg.allDamageTypes() : (cfg.damageTypes ?? {}))[sys.damageType] ?? sys.damageType)
    : "";
  // Bane details (bane actions): applied to the target on a hit.
  const baneUuid = isBane ? (sys.baneUuid ?? "") : "";
  const baneName = isBane ? (sys.baneName ?? "") : "";
  const banePowerLevel = isBane ? Number(sys.invokePowerLevel ?? 0) : 0;
  const banePotent = isBane ? !!sys.potent : false;
  // Multi-Bane Specialist: additional banes inflicted by the SAME hit (each its own
  // PL, resisted independently). Carried on the snapshot when the toggle was on.
  const extraBanes = (isBane && Array.isArray(sys.extraBanes))
    ? sys.extraBanes.map(b => ({ uuid: String(b.uuid ?? ""), name: String(b.name ?? ""), powerLevel: Number(b.powerLevel ?? 0) }))
        .filter(b => b.uuid && b.name)
    : [];

  // Damage resistance (target): a damaging attack with a given damage type may be
  // resisted by the target — via the Energy Resistance feat (non-physical only) OR
  // the Resistance boon (any type, incl. precise/forceful). Both raise that target's
  // defense vs the attack by +3/+6/+9 (and grant immunity at the top tier/PL); the
  // STRONGER of the two applies. Resolved per-target below. Only damaging attacks
  // carry a type.
  const energyKey = isDamaging ? String(sys.damageType ?? "") : "";

  // Lethal Strike: when the toggle was on, up to `lethalStrikeCap` of each target's
  // dealt damage becomes lethal (the rest is normal HP damage). Capped at the cap
  // and at the total damage dealt.
  const lethalCap = isDamaging ? Math.max(0, Math.floor(Number(sys.lethalStrikeCap ?? 0))) : 0;

  // Baneful (Extraordinary weapon): a damaging attack with the weapon may inflict
  // its chosen bane at margin 5+ (like a Bane Focus bane). Lower the "+ Bane" gate
  // to 5 when the weapon is Baneful, so the rider button appears at margin 5; the
  // picker then qualifies the Baneful (+ any Focus) bane at 5 and others at 10.
  const banefulBaneName = isDamaging ? String(sys.banefulBaneName ?? "") : "";
  const effMinBaneMargin = banefulBaneName ? Math.min(minBaneMargin, 5) : minBaneMargin;
  // Slaying (legendary weapon): a damaging attack beating the defense by 5+ kills
  // the listed creature type outright. The GM confirms the type when applying.
  const slayingType = isDamaging ? String(sys.slayingType ?? "").trim() : "";
  // Augmenting item's bane (chosen in the roll dialog): delivered on a hit at the
  // item's listed PL. Only meaningful when it resolved to a real bane document.
  const augmentBane = (isDamaging && sys.augmentBane?.uuid)
    ? { name: String(sys.augmentBane.name ?? ""), uuid: String(sys.augmentBane.uuid),
        powerLevel: Math.max(0, Math.floor(Number(sys.augmentBane.powerLevel) || 0)) }
    : null;

  const out = [];
  for ( const token of actionTargetTokens() ) {
    const tActor = token.actor;
    const baseDefenseValue = Number(tActor?.system?.defenses?.[defKey]?.value);
    if ( !tActor || !Number.isFinite(baseDefenseValue) ) continue;

    // Best resistance for THIS target against the attack's damage type (feat or boon).
    const resist = (energyKey && cfg.damageResistance) ? cfg.damageResistance(tActor, energyKey) : null;
    const defenseValue = baseDefenseValue + (resist?.defenseBonus ?? 0);
    // Mount/vehicle defense immunity (SRD: "Immune" listed for a defense means
    // attacks targeting that defense have no effect).
    const vehicleImmune = !!tActor?.system?.defenseImmune?.[defKey];
    const immune = !!resist?.immune || vehicleImmune;

    const hit = !immune && (total >= defenseValue);
    // Damage = roll − defense, never negative; but a hit (meeting/exceeding the
    // defense) always deals a MINIMUM of 3 damage (SRD damaging-attack rule). An
    // immune target takes none.
    const damage = (isDamaging && hit) ? Math.max(3, total - defenseValue) : 0;
    // Margin rider: a damaging attack normally needs a margin of 10+ over the
    // defense to also apply a bane; Bane Focus lowers that to 5 (for the FOCUSED
    // bane only — enforced in the picker). `minBaneMargin` is 5 when the attacker
    // owns any Bane Focus, else 10. The actual margin rides along so the picker
    // can gate per-bane (focused → 5, others → 10).
    const baneMargin = total - defenseValue;
    const canApplyBane = isDamaging && hit && (baneMargin >= effMinBaneMargin);
    // Lethal Strike split: the lethal portion of this target's damage (≤ cap, ≤ damage).
    const lethalPortion = (lethalCap > 0 && damage > 0) ? Math.min(lethalCap, damage) : 0;
    out.push({
      tokenUuid: token.document?.uuid ?? token.document?.id,
      name: token.name ?? tActor.name,
      img: token.document?.texture?.src ?? tActor.img,
      defenseLabel: defLabel,
      defenseValue,
      total,
      hit,
      damage,
      lethalPortion,
      damageType,
      isBane,
      baneUuid,
      baneName,
      banePowerLevel,
      banePotent,
      extraBanes,
      canApplyBane,
      baneMargin,
      // Baneful weapon: the chosen bane the margin-5 rider offers (empty otherwise).
      banefulBaneName,
      // Slaying weapon: the creature type this margin-5+ hit would slay ("" when
      // the property is absent or the margin falls short).
      slaying: (slayingType && hit && (baneMargin >= 5)) ? slayingType : "",
      // Augmenting item's bane: delivered on THIS hit at the item's listed PL.
      augmentBane,
      // Resistance applied to this target (for the result-row note): the raised
      // defense (+N) or immunity to the attack's damage type, and which source
      // granted it (Energy Resistance feat vs Resistance boon) — or a mount/
      // vehicle's listed defense immunity ("vehicle" source, labeled by defense).
      resistTier: resist?.tier ?? 0,
      resistBonus: resist?.defenseBonus ?? 0,
      resistImmune: immune,
      resistLabel: (vehicleImmune && !resist?.immune) ? defLabel : (resist?.label ?? ""),
      resistSource: (vehicleImmune && !resist?.immune) ? "vehicle" : (resist?.source ?? ""),
      // Apply button shows for a damaging hit dealing > 0, or a bane hit with a
      // chosen bane to apply.
      applicable: isDamaging ? (hit && (damage > 0)) : (isBane && hit && !!baneUuid)
    });
  }
  return out;
}

/**
 * Resolve a boon action against the user's current targets. A boon has no
 * defense check: the roll total is compared against the boon's Challenge Rating
 * table (CR = 10 + 2·PL) to find the highest power level achieved, capped by the
 * invoking attribute's score. Every target gets the same achieved level (the
 * roll is rolled once); each row reports it, and the apply button (shown only
 * when the invocation succeeded) grants the boon at that level. Targets without
 * a resolvable actor are skipped.
 * @param {object} args
 * @param {object} args.sys        The boon action's system data.
 * @param {number} args.total      The evaluated roll total.
 * @param {number} args.attrScore  The invoking attribute's score (caps the level).
 * @returns {Array<object>}
 */
function resolveBoonTargets({ sys, total, attrScore = Infinity, suppressGrant = false, autoSuccess = false, actorUuid = "", boonLevels = [] }) {
  const cfg = CONFIG.OPENLEGEND ?? {};
  const boonUuid = sys.boonUuid ?? "";
  const boonName = sys.boonName ?? "";
  // No power level is chosen up front: the roll decides everything. The player
  // lands the boon at the HIGHEST discrete level ≤ their invoking score whose CR
  // the roll met — and may take ANY lower reachable level instead (the card's PL
  // picker). So a Haste roll of 14 lands at PL2 (CR 14) even though PL6 (CR 22)
  // was in reach of the score. See boonAchievedPowerLevel. Boon Focus
  // single-target auto-succeeds at the score's maximum (total is null → CR
  // bypassed).
  const cap = Number(attrScore ?? Infinity);
  // The discrete levels this boon offers (fallback to the stored level for
  // legacy snapshots that carry no boonLevels).
  const fallbackPl = Math.max(0, Math.floor(Number(sys.invokePowerLevel ?? 0)));
  const levels = (Array.isArray(boonLevels) && boonLevels.length)
    ? boonLevels.filter(l => Number.isFinite(l) && (l > 0))
    : [fallbackPl].filter(l => l > 0);
  // The effective ceiling: the highest defined level the score can reach at all.
  const attemptable = levels.filter(l => l <= cap);
  const ceiling = attemptable.length ? Math.max(...attemptable) : 0;
  // Highest level actually reached this roll, and every reachable discrete level
  // (for the card's PL picker). On a Boon Focus auto-success, everything ≤ cap is
  // reachable without a roll.
  const achievedPl = autoSuccess
    ? ceiling
    : (cfg.boonAchievedPowerLevel ? (cfg.boonAchievedPowerLevel(total, levels, cap) ?? 0) : 0);
  const reachableLevels = levels.filter(l => (l <= cap) && (l <= (achievedPl || 0)));
  const success = achievedPl > 0;
  // The level to GRANT: the highest reached (the player can pick a lower one from
  // the card's dropdown, which overrides this at apply time).
  const appliedPl = achievedPl;
  // CR shown on the card: the achieved level's CR on a success; on a failure, the
  // lowest attemptable level's CR (what the roll needed to succeed at all).
  const crPl = success ? achievedPl : (attemptable.length ? Math.min(...attemptable) : (levels.length ? Math.min(...levels) : 0));
  const cr = cfg.boonChallengeRating ? cfg.boonChallengeRating(crPl) : (10 + 2 * crPl);

  // Aura (boon): on a successful grant, the radiated bane/boon + the aura radius
  // ride along to the Grant button so the granted Aura effect can carry them (the
  // live-aura engine reads flags.openlegend.aura — see module/canvas/aura.mjs).
  const isAura = String(boonName).trim().toLowerCase() === "aura";
  const aura = (isAura && sys.auraRadiateUuid) ? {
    radiateKind: sys.auraRadiateKind ?? "",
    radiateUuid: sys.auraRadiateUuid ?? "",
    radiateName: sys.auraRadiateName ?? "",
    radiatePowerLevel: Number(sys.auraRadiatePowerLevel ?? 0),
    radiateResistanceType: sys.auraRadiateResistanceType ?? "",
    radius: cfg.auraRadiusForPowerLevel ? cfg.auraRadiusForPowerLevel(appliedPl) : 0,
    attackAttr: sys.attribute ?? "",
    // Item invocation: the item's value supplies the radiated bane-attack dice.
    itemScore: Math.max(0, Math.floor(Number(sys.invokeItemScore) || 0)),
    attackerActorUuid: actorUuid ?? ""
  } : null;

  // Barrier: chosen properties (CSV) + Baneful bane + the PL damage die, carried to
  // the Grant button so the granted effect records them (and offers a damage roll).
  const isBarrier = String(boonName).trim().toLowerCase()
    === String(cfg.BARRIER_BOON_NAME ?? "barrier").toLowerCase();
  const barrier = (isBarrier && success) ? {
    properties: sys.barrierProperties ?? "",
    damageDie: cfg.barrierDamageDie ? cfg.barrierDamageDie(appliedPl) : "",
    baneUuid: sys.barrierBaneUuid ?? "",
    baneName: sys.barrierBaneName ?? "",
    banePowerLevel: Number(sys.barrierBanePowerLevel ?? 0),
    powerLevel: appliedPl
  } : null;

  // Restoration: at ROLL TIME, surface on the card which of THIS target's banes
  // ABOVE the score's reachable ceiling the roll already reached — a bane at PL P
  // is dispellable when the roll met CR 20 + 2·P. Shown as a note on each
  // target's row (with the CRs) so the player knows before granting that they can
  // also clear the tougher banes. Only meaningful with a real numeric total.
  const isRestoration = String(boonName).trim().toLowerCase() === "restoration";
  const restorationTotal = Number.isFinite(Number(total)) && (total !== null) ? Number(total) : null;
  const restorationHigherCr = epl => 20 + (2 * Math.max(0, Math.floor(epl)));

  const out = [];
  for ( const token of actionTargetTokens() ) {
    const tActor = token.actor;
    if ( !tActor ) continue;

    // Restoration: list EVERY of this target's banes ABOVE the reachable ceiling
    // with its dispel CR, each flagged whether the roll reached it (total ≥ CR) — so the
    // player sees the tougher banes and their CRs at roll time even when the roll
    // fell short of some (or all) of them. The dispel prompt then offers the reached
    // ones.
    let restorationHigher = [];
    if ( isRestoration && (restorationTotal != null) ) {
      restorationHigher = (tActor.effects?.contents ?? [])
        .filter(e => e.flags?.openlegend?.fromBane)
        .map(e => {
          const pl = Math.max(0, Math.floor(Number(e.flags.openlegend.powerLevel) || 0));
          const dcr = restorationHigherCr(pl);
          return { name: e.flags.openlegend.fromBane, pl, cr: dcr, reached: restorationTotal >= dcr };
        })
        .filter(b => b.pl > ceiling)
        .sort((a, b) => a.pl - b.pl);
    }

    out.push({
      tokenUuid: token.document?.uuid ?? token.document?.id,
      name: token.name ?? tActor.name,
      img: token.document?.texture?.src ?? tActor.img,
      total,
      isBoon: true,
      hit: success,                 // "success" reuses the hit styling (green/red)
      boonChallengeRating: cr,
      boonUuid,
      boonName,
      boonPowerLevel: appliedPl,
      // Every discrete level the player may take this boon at (≤ ceiling, ≤
      // attribute, ≤ what the roll reached) — the card renders a PL picker from
      // this so a high-ceiling attempt that fell short can still be taken lower.
      boonReachableLevels: reachableLevels,
      boonCeiling: ceiling,
      // Restoration: tougher banes (above the ceiling) the roll ALSO reached, each
      // {name, pl}. Rendered as a card note with their CRs.
      restorationHigher,
      // Aura metadata for the Grant button (null for non-aura boons).
      aura,
      // Barrier metadata for the Grant button (null for non-barrier boons).
      barrier,
      // Apply (grant the boon) only when the invocation succeeded and a boon is
      // set — and it is something to APPLY: an instantaneous dice boon (Heal) is
      // rolled from the card instead.
      applicable: success && !!boonUuid && !suppressGrant
    });
  }
  return out;
}

/* -------------------------------------------- */

/**
 * Render the action-card results block: a divider, a "<roller> targets <names>"
 * line, then a per-target list. Each list row reads
 * "<Attribute> <score> vs <Defense> <value> — Hit/Miss" and carries a small
 * GM-only apply button (Apply Damage or Apply Bane), hidden on a miss.
 * @param {object} args
 * @param {string} args.rollerName
 * @param {string} args.attrLabel
 * @param {number} args.attrScore
 * @param {Array} args.results  Rows from {@link resolveTargets}.
 * @param {boolean} [args.retargetable]  Add a GM-only "Change targets" control
 *   (re-resolves this roll against a new selection — see retargetActionMessage).
 * @returns {string} HTML.
 */
/**
 * Render a chat card's structured header: a title line, a muted context line
 * (attribute · weapon · vs Defense …), and an optional row of tag pills
 * (advantage, feat riders …). Lives in the message FLAVOR, so it uses spans
 * styled as blocks (flavor is rendered inside a <span class="flavor-text">).
 * @param {object} args
 * @param {string} args.title    The action/effect name (escaped here).
 * @param {string} [args.sub]    Pre-built context line (may contain markup).
 * @param {string[]} [args.tags] Pre-built .ol-tag pill fragments.
 * @returns {string} HTML.
 */
function renderCardHeader({ title, sub = "", tags = [] }) {
  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
  const pills = tags.filter(Boolean);
  return `<span class="ol-card-head">` +
    `<span class="ol-card-title">${esc(title)}</span>` +
    (sub ? `<span class="ol-card-sub">${sub}</span>` : "") +
    (pills.length ? `<span class="ol-card-tags">${pills.join("")}</span>` : "") +
    `</span>`;
}

function renderResultsBlock({ rollerName, attrLabel, attrScore, results, retargetable = false, actorUuid = "", attrKey = "" }) {
  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
  const names = results.map(r => esc(r.name)).join(", ");

  // GM-only "Change targets" control (stripped for players in the chat hook).
  const retargetBtn = retargetable
    ? `<button type="button" class="ol-retarget ol-apply-mini" data-tooltip="Re-resolve this roll against your currently targeted tokens">
         <i class="fas fa-bullseye"></i> Change targets
       </button>`
    : "";

  // No targets resolved: still emit the divider (so re-targeting can find/replace
  // this section) plus the Change-targets control to target after the fact.
  if ( !results.length ) {
    return `
      <hr class="ol-card-divider"/>
      <div class="ol-target-line ol-target-line-empty"><strong>${esc(rollerName)}</strong> — no targets ${retargetBtn}</div>`;
  }

  const rows = results.map(r => {
    // A Boon Focus single-target invocation auto-succeeds with no action roll, so
    // it carries a null total (no CR comparison).
    const autoBoon = r.isBoon && (r.total === null || r.total === undefined);
    // Status badge: boons report Success/Failed vs a Challenge Rating; damaging /
    // bane attacks report Hit/Miss vs a defense; an Energy-Resistance-immune target
    // reports Immune. Color comes from is-hit/is-miss.
    const statusText = r.isBoon
      ? (autoBoon ? "Auto-Success" : (r.hit ? "Success" : "Failed"))
      : (r.resistImmune ? "Immune" : (r.hit ? "Hit" : "Miss"));
    const statusIcon = r.resistImmune ? "fa-shield-halved" : (r.hit ? "fa-circle-check" : "fa-circle-xmark");

    // Small per-row apply button (GM-only; wired/hidden in the chat hook). Hidden
    // on a miss/failure (no markup), shown for an applicable hit/success.
    const applyId = foundry.utils.randomID?.() ?? `ol-${r.tokenUuid}-${r.damage}`;
    let apply = "";
    if ( r.applicable && r.isBoon ) {
      // Aura: the Grant button carries the radiated bane/boon + radius so the
      // granted Aura effect gets flags.openlegend.aura (the live-aura engine).
      const auraAttrs = r.aura
        ? ` data-aura-kind="${esc(r.aura.radiateKind)}" data-aura-uuid="${esc(r.aura.radiateUuid)}" data-aura-name="${esc(r.aura.radiateName)}" data-aura-pl="${r.aura.radiatePowerLevel}" data-aura-radius="${r.aura.radius}" data-aura-attr="${esc(r.aura.attackAttr)}" data-aura-item-score="${Number(r.aura.itemScore) || 0}" data-aura-attacker="${esc(r.aura.attackerActorUuid)}" data-aura-resist="${esc(r.aura.radiateResistanceType ?? "")}"`
        : "";
      // Barrier: the Grant button carries the chosen properties + Baneful bane + die
      // so the granted effect records them (and offers a damage roll if Damaging).
      const barrierAttrs = r.barrier
        ? ` data-barrier-properties="${esc(r.barrier.properties)}" data-barrier-die="${esc(r.barrier.damageDie)}" data-barrier-bane-uuid="${esc(r.barrier.baneUuid)}" data-barrier-bane-name="${esc(r.barrier.baneName)}" data-barrier-bane-pl="${r.barrier.banePowerLevel}"`
        : "";
      // The invocation's roll context rides along so an instantaneous boon that
      // resolves at grant time (Restoration's beyond-PL dispel) can reuse the
      // roll — or, on a Boon Focus auto-success (empty total), re-roll with the
      // invoker's dice.
      const rollCtxAttrs = ` data-roll-total="${Number.isFinite(Number(r.total)) && (r.total !== null) ? r.total : ""}" data-invoker-uuid="${esc(actorUuid)}" data-attr-key="${esc(attrKey)}"`;
      // Power-level picker: when the roll reached more than one discrete level, the
      // player may take the boon at any of them (the default = highest reached).
      // The Grant button reads this select's value at apply time (see the chat
      // listener); a single reachable level shows no picker. Aura/Barrier boons
      // keep their fixed grant PL (their level rides in the aura/barrier payload).
      const reach = Array.isArray(r.boonReachableLevels) ? r.boonReachableLevels : [];
      const showPlPicker = !r.aura && !r.barrier && (reach.length > 1);
      const plSelect = showPlPicker
        ? `<select class="ol-boon-pl" data-tooltip="Choose the power level to grant (up to what your roll reached)">${
            reach.map(l => `<option value="${l}"${l === r.boonPowerLevel ? " selected" : ""}>PL ${l}</option>`).join("")
          }</select>`
        : "";
      apply = plSelect + `<button type="button" class="ol-apply-boon ol-apply-mini" data-token-uuid="${r.tokenUuid}" data-boon-uuid="${esc(r.boonUuid)}" data-power-level="${r.boonPowerLevel}"${auraAttrs}${barrierAttrs}${rollCtxAttrs} data-tooltip="Grant ${esc(r.boonName)}${r.boonPowerLevel ? ` PL ${r.boonPowerLevel}` : ""}">
           <i class="fas fa-hands-holding"></i> Grant ${esc(r.boonName)}${r.boonPowerLevel && !showPlPicker ? ` (PL ${r.boonPowerLevel})` : ""}
         </button>`;
    } else if ( r.applicable && r.isBane ) {
      apply = `<button type="button" class="ol-apply-bane ol-apply-mini" data-token-uuid="${r.tokenUuid}" data-bane-uuid="${esc(r.baneUuid)}" data-power-level="${r.banePowerLevel}" data-potent="${r.banePotent ? 1 : 0}" data-tooltip="Apply ${esc(r.baneName)}${r.banePowerLevel ? ` PL ${r.banePowerLevel}` : ""}${r.banePotent ? " (Potent)" : ""}">
           <i class="fas fa-skull"></i> Apply ${esc(r.baneName)}${r.banePowerLevel ? ` (PL ${r.banePowerLevel})` : ""}${r.banePotent ? ` <i class="fas fa-biohazard" title="Potent"></i>` : ""}
         </button>`;
      // Multi-Bane Specialist: one Apply button per ADDITIONAL bane (same hit; each
      // applied + resisted independently).
      for ( const xb of (r.extraBanes ?? []) ) {
        apply += `<button type="button" class="ol-apply-bane ol-apply-mini" data-token-uuid="${r.tokenUuid}" data-bane-uuid="${esc(xb.uuid)}" data-power-level="${xb.powerLevel}" data-potent="0" data-tooltip="Apply ${esc(xb.name)}${xb.powerLevel ? ` PL ${xb.powerLevel}` : ""}">
             <i class="fas fa-skull"></i> Apply ${esc(xb.name)}${xb.powerLevel ? ` (PL ${xb.powerLevel})` : ""}
           </button>`;
      }
    } else if ( r.applicable ) {
      // Lethal Strike split: data-lethal-split carries the lethal portion so the
      // apply handler deals that much as lethal damage and the rest as normal HP.
      // On a Lethal Strike, data-attacker-uuid lets the apply handler run the
      // attacker's Death Blow feat (instant defeat / silence / auto-stun) afterward.
      const lethal = Math.max(0, Math.floor(Number(r.lethalPortion) || 0));
      const splitAttr = lethal > 0 ? ` data-lethal-split="${lethal}"` : "";
      const attackerAttr = (lethal > 0 && actorUuid) ? ` data-attacker-uuid="${esc(actorUuid)}"` : "";
      const lethalTag = lethal > 0 ? ` (${lethal} lethal)` : "";
      apply = `<button type="button" class="ol-apply-damage ol-apply-mini" data-apply-id="${applyId}" data-token-uuid="${r.tokenUuid}" data-damage="${r.damage}" data-damage-type="${esc(r.damageType)}"${splitAttr}${attackerAttr} data-tooltip="Apply ${r.damage}${r.damageType ? ` ${esc(r.damageType)}` : ""} damage${lethal > 0 ? ` — ${lethal} of it lethal (Lethal Strike)` : ""}">
           <i class="fas fa-heart-crack"></i> Apply ${r.damage}${r.damageType ? ` ${esc(r.damageType)}` : ""}${lethalTag}
         </button>`;
    }
    // Augmenting item: a DAMAGING hit (roll ≥ defense) also delivers the augment
    // item's chosen bane at its listed PL. Bound Apply button (same wiring as the
    // margin/multi-bane apply → applyBaneByTokenUuid).
    if ( r.hit && !r.isBoon && !r.isBane && r.augmentBane?.uuid ) {
      const ab = r.augmentBane;
      apply += `<button type="button" class="ol-apply-bane ol-apply-mini" data-token-uuid="${r.tokenUuid}" data-bane-uuid="${esc(ab.uuid)}" data-power-level="${ab.powerLevel}" data-potent="0" data-tooltip="Augment: apply ${esc(ab.name)}${ab.powerLevel ? ` PL ${ab.powerLevel}` : ""} to this hit">
           <i class="fas fa-vial"></i> Augment: ${esc(ab.name)}${ab.powerLevel ? ` (PL ${ab.powerLevel})` : ""}
         </button>`;
    }
    // Slaying (legendary weapon): the hit beat the defense by 5+ — if the target
    // is of the listed creature type, it dies immediately. The GM confirms the
    // type via the Slay button (reduces to 0 HP, with undo). GM-only.
    if ( !r.isBoon && !r.isBane && r.hit && r.slaying && r.tokenUuid ) {
      apply += `<button type="button" class="ol-slaying-kill ol-apply-mini" data-token-uuid="${r.tokenUuid}" data-creature-type="${esc(r.slaying)}" data-tooltip="Slaying (${esc(r.slaying)}): the attack exceeded the defense by 5+ — if ${esc(r.name)} is of this creature type, it dies immediately">
           <i class="fas fa-skull-crossbones"></i> Slay
         </button>`;
    }
    // Margin rider: a damaging hit exceeding the defense by 10+ may ALSO apply a
    // bane (PL ≤ attribute score); Bane Focus lowers it to 5 for the focused bane.
    // A "+ Bane" button opens the bane picker for this target; GM-only (wired/
    // hidden in the chat hook). data-margin lets the picker gate per-bane.
    if ( r.canApplyBane && actorUuid ) {
      const bnf = r.banefulBaneName ? ` or Baneful (${esc(r.banefulBaneName)})` : "";
      apply += `<button type="button" class="ol-attack-bane ol-apply-mini" data-actor-uuid="${esc(actorUuid)}" data-token-uuid="${r.tokenUuid}" data-attr-score="${attrScore}" data-attr-key="${esc(attrKey)}" data-total="${r.total}" data-margin="${r.baneMargin}" data-baneful="${esc(r.banefulBaneName ?? "")}" data-tooltip="Margin ${r.baneMargin}: apply a bane (PL ≤ ${attrScore}; margin 10+, or 5+ for a Bane Focus${bnf} bane)">
           <i class="fas fa-skull-crossbones"></i> + Bane
         </button>`;
    }

    // Detail line — two zones with a clear hierarchy: the MATH (big roll total,
    // muted "vs Defense/CR", a signed margin pill) on the left, and NOTE CHIPS
    // (damage dealt, resistance, lethal split) on the right.
    let math;
    if ( autoBoon ) {
      // Boon Focus single-target: auto-success, no roll/CR comparison.
      math = `<span class="ol-tr-total ol-tr-auto"><i class="fas fa-bolt"></i></span>
        <span class="ol-tr-vs">Boon Focus — auto-success, no roll · ${esc(attrLabel)} ${attrScore}</span>`;
    } else {
      const versus = r.isBoon
        ? `CR ${r.boonChallengeRating}`
        : `${esc(r.defenseLabel)} ${r.defenseValue}`;
      const margin = r.isBoon ? (r.total - r.boonChallengeRating) : (r.total - r.defenseValue);
      const marginText = `${margin >= 0 ? "+" : "−"}${Math.abs(margin)}`;
      math = `<span class="ol-tr-total">${r.total}</span>
        <span class="ol-tr-vs">vs ${versus}${r.isBoon ? ` · ${esc(attrLabel)} ${attrScore}` : ""}</span>
        <span class="ol-tr-margin ${margin >= 0 ? "is-over" : "is-under"}" title="Margin over ${r.isBoon ? "the CR" : "the defense"}">${marginText}</span>`;
    }
    const notes = [];
    let restorationLine = "";   // full-width Restoration higher-bane line (set below)
    // Resistance note (target feat or boon): immunity, or the +N defense it added.
    if ( r.resistImmune || r.resistBonus > 0 ) {
      const resistName = r.resistSource === "boon" ? "Resistance"
        : (r.resistSource === "vehicle" ? "Vehicle/Mount" : "Energy Resistance");
      notes.push(r.resistImmune
        ? `<span class="ol-chip ol-tr-resist"><i class="fas fa-shield-halved"></i> Immune (${resistName}${r.resistLabel ? `: ${esc(r.resistLabel)}` : ""})</span>`
        : `<span class="ol-chip ol-tr-resist"><i class="fas fa-shield-halved"></i> +${r.resistBonus} ${resistName}${r.resistLabel ? ` (${esc(r.resistLabel)})` : ""}</span>`);
    }
    // Restoration: every bane above the chosen ceiling, with its dispel CR. Ones the
    // roll REACHED (total ≥ CR) are marked ✓ (dispellable when granting); ones it
    // fell short of are shown muted with ✗ so the player still sees the CR they'd
    // need. Rendered as its own full-width line (not an inline chip) so long lists
    // wrap cleanly instead of overflowing the card.
    if ( Array.isArray(r.restorationHigher) && r.restorationHigher.length ) {
      const items = r.restorationHigher.map(b =>
        `<span class="ol-hbane ${b.reached ? "is-reached" : "is-short"}">`
        + `<i class="fas ${b.reached ? "fa-circle-check" : "fa-circle-xmark"}"></i> `
        + `${esc(b.name)} <span class="ol-hbane-cr">PL ${b.pl} · CR ${b.cr}</span></span>`
      ).join("");
      const anyReached = r.restorationHigher.some(b => b.reached);
      restorationLine = `<div class="ol-tr-hbanes" title="Banes above your chosen power level. ✓ = your roll met its CR (dispellable when granting); ✗ = out of reach this roll.">`
        + `<span class="ol-hbanes-label"><i class="fas fa-hand-sparkles"></i> ${anyReached ? "Also reaches" : "Higher banes"}:</span> ${items}</div>`;
    }
    // Damaging hit: surface the damage prominently as its own chip.
    if ( !r.isBoon && !r.isBane && r.hit ) {
      notes.push(`<span class="ol-chip ol-tr-damage"><i class="fas fa-heart-crack"></i> ${r.damage}${r.damageType ? ` ${esc(r.damageType)}` : ""}</span>`);
      // Lethal Strike split note: how much of the damage is lethal.
      if ( Number(r.lethalPortion) > 0 ) {
        notes.push(`<span class="ol-chip ol-tr-lethal" title="Lethal Strike: this much of the damage reduces MAX HP (lethal)."><i class="fas fa-skull"></i> ${Math.floor(Number(r.lethalPortion))} lethal</span>`);
      }
      // Slaying (legendary weapon): margin 5+ vs the listed creature type.
      if ( r.slaying ) {
        notes.push(`<span class="ol-chip ol-tr-slay" title="Slaying: the attack exceeded the defense by 5 or more — if the target is a ${esc(r.slaying)}, it dies immediately."><i class="fas fa-skull-crossbones"></i> Slaying: ${esc(r.slaying)}</span>`);
      }
    }
    const detail = `<span class="ol-tr-math">${math}</span>` +
      (notes.length ? `<span class="ol-tr-notes">${notes.join("")}</span>` : "");

    const applyLine = apply ? `<div class="ol-tr-actions">${apply}</div>` : "";
    return `
      <li class="ol-target-row ${r.hit ? "is-hit" : "is-miss"}">
        <div class="ol-tr-head">
          <img src="${r.img}" width="24" height="24" alt=""/>
          <span class="ol-target-name">${esc(r.name)}</span>
          <span class="ol-tr-status"><i class="fas ${statusIcon}"></i> ${statusText}</span>
        </div>
        <div class="ol-tr-detail">${detail}</div>
        ${restorationLine}
        ${applyLine}
      </li>`;
  }).join("");

  return `
    <hr class="ol-card-divider"/>
    <div class="ol-target-line"><strong>${esc(rollerName)}</strong> targets <strong>${names}</strong> ${retargetBtn}</div>
    <ul class="ol-target-results">${rows}</ul>`;
}

/**
 * Render the "Interrupt?" button shown on damaging / bane attack cards. Clicking
 * it (wired in renderChatMessageHTML) opens the Defend dialog for this message —
 * any user may try to defend a target they (or their owned ally) were attacked
 * by, so the button is not GM-gated.
 * @returns {string} HTML.
 */
export function renderInterruptButton() {
  return `
    <div class="ol-interrupt-bar">
      <button type="button" class="ol-interrupt" data-tooltip="Defend a target against this attack">
        <i class="fas fa-shield-halved"></i> Interrupt?
      </button>
    </div>`;
}

/**
 * Render the Inspiring Champion healing rider for a damaging attack whose best
 * margin over a target's defense was 10 or more. Shows the in-range distance
 * (5' × Presence), the number of allies that may heal (by tier), and a Roll
 * Healing button (1d4 / 2d4 by tier) that produces a healing card — the GM then
 * applies it to the allies in range via the rolled card's aim buttons. We don't
 * enforce once-per-round; this just surfaces the option when the trigger is met.
 * @param {{tier:number, formula:string, dice:string, presence:number, range:number, allies:string}} rider
 * @param {string} rollerName
 * @returns {string} HTML.
 */
function renderInspiringChampionBlock(rider, rollerName) {
  const esc = foundry.utils.escapeHTML ?? (s => s);
  const flavor = `${rollerName} — Inspiring Champion (Tier ${rider.tier}) heals allies within ${rider.range}'`;
  const healButton = `
    <button type="button" class="ol-roll-invoke" data-formula="${esc(rider.formula)}"
            data-roll-flavor="${esc(flavor)}" data-roll-kind="healing" data-tooltip="Roll Inspiring Champion healing (${esc(rider.dice)}) — then apply to the allies in range">
      <i class="fas fa-dice-d20"></i> Roll Healing (${esc(rider.dice)})
    </button>`;
  return `
    <div class="ol-inspiring-champion">
      <div class="ol-ic-head"><i class="fas fa-hands-praying"></i> <strong>Inspiring Champion</strong> (Tier ${rider.tier})</div>
      <div class="ol-ic-body">
        Margin 10+! ${esc(rider.allies)} within <strong>${rider.range}'</strong> (5' × Presence ${rider.presence}) heal <strong>${esc(rider.dice)} HP</strong>.
      </div>
      <div class="ol-ic-actions">${healButton}</div>
    </div>`;
}

/**
 * Render the Overpowering Strike (+ optional Crushing Blow) rider for a damaging hit
 * made with a Forceful weapon. Overpowering Strike lets the attacker push each
 * damaged target 5' (informational — positioning is the GM's call). Crushing Blow
 * adds a per-target "Knockdown" button that inflicts the Knockdown bane where the
 * forced move ends.
 * @param {object} args
 * @param {string} args.rollerName
 * @param {string} args.weaponName
 * @param {Array<{tokenUuid: string, name: string}>} args.hits  Damaged targets.
 * @param {boolean} args.crushing  Whether the attacker also has Crushing Blow.
 * @returns {string} HTML.
 */
function renderOverpoweringStrikeBlock({ rollerName, weaponName, hits, crushing }) {
  const esc = foundry.utils.escapeHTML ?? (s => s);
  const wpn = weaponName ? ` with <strong>${esc(weaponName)}</strong>` : "";
  const body = crushing
    ? `Forceful hit${wpn}: you may push each target 5' (Overpowering Strike), then knock them down where the move ends (Crushing Blow → Knockdown).`
    : `Forceful hit${wpn}: you may push each target 5' away (Overpowering Strike).`;
  // Crushing Blow: a Knockdown button per damaged target (GM-gated; wired in the
  // chat hook). Resolves + applies the Knockdown bane to that token.
  const buttons = crushing ? hits.map(h =>
    `<button type="button" class="ol-crushing-knockdown ol-apply-mini" data-token-uuid="${esc(h.tokenUuid)}" data-name="${esc(h.name)}" data-tooltip="Knock down ${esc(h.name)} (Knockdown bane)">
       <i class="fas fa-person-falling"></i> Knock down ${esc(h.name)}
     </button>`).join("") : "";
  return `
    <div class="ol-overpowering-strike">
      <div class="ol-ops-head"><i class="fas fa-hand-back-fist"></i> <strong>Overpowering Strike</strong>${crushing ? " + Crushing Blow" : ""}</div>
      <div class="ol-ops-body">${body}</div>
      ${buttons ? `<div class="ol-ops-actions">${buttons}</div>` : ""}
    </div>`;
}

/* -------------------------------------------- */

/**
 * Apply healing to a target token's actor, adding to current health (clamped
 * to the maximum). Wired to the Apply Healing buttons on a healing-roll chat
 * card (GM, or the token's owner). Posts a chat message recording the ACTUAL
 * amount restored (less than rolled when the clamp hits), with an Undo button
 * that reverts it. Mirrors {@link applyDamageToToken}.
 * @param {string} tokenUuid  The targeted token document UUID.
 * @param {number} healing    Hit points to restore.
 * @param {string} [applyId]  Id of the source Apply button, so Undo can re-enable it.
 * @returns {Promise<void>}
 */
export async function applyHealingToToken(tokenUuid, healing, applyId = "", { extraordinary = false } = {}) {
  const tokenDoc = await fromUuid(tokenUuid);
  const tActor = tokenDoc?.actor ?? tokenDoc;
  if ( !tActor?.system?.health ) {
    ui.notifications?.warn("Could not find the target's health to apply healing.");
    return;
  }
  if ( !canModifyActorHealth(tActor) ) {
    ui.notifications?.warn(`You don't have permission to heal ${tActor.name}.`);
    return;
  }
  const heal = Math.max(0, Math.floor(Number(healing) || 0));

  // Extraordinary Healing (feat): the same roll also heals LETHAL damage — each
  // point of lethal removed restores 1 to the effective max HP. Apply it first so
  // the HP heal below clamps against the (now higher) effective max. Update both
  // in one write. The recovered max is reported alongside the HP healed.
  const update = {};
  let lethalBefore = 0, lethalAfter = 0;
  if ( extraordinary ) {
    lethalBefore = Math.max(0, Math.floor(Number(tActor.system.health.lethal ?? 0)));
    lethalAfter = Math.max(0, lethalBefore - heal);
    if ( lethalAfter !== lethalBefore ) update["system.health.lethal"] = lethalAfter;
  }
  // Effective max after any lethal healing (each lethal point removed raises it by 1).
  const lethalHealed = lethalBefore - lethalAfter;
  const max = Number(tActor.system.health.max);
  const effMax = Number.isFinite(max) ? (max + lethalHealed) : max;

  const current = Number(tActor.system.health.value ?? 0);
  const next = Number.isFinite(effMax) ? Math.min(effMax, current + heal) : current + heal;
  const delta = next - current;
  update["system.health.value"] = next;
  await tActor.update(update);

  // Announce the healing; Undo reverts the ACTUAL restored amount (HP + lethal)
  // and re-enables the source Apply button.
  const escape = foundry.utils.escapeHTML ?? (s => s);
  const lethalNote = lethalHealed > 0 ? ` and <strong>${lethalHealed}</strong> lethal (max HP)` : "";
  const undoBtn =
    `<button type="button" class="ol-undo-healing" data-apply-id="${escape(applyId)}"`
    + ` data-token-uuid="${escape(tokenUuid)}" data-healing="${delta}" data-lethal-healed="${lethalHealed}">`
    + `<i class="fas fa-rotate-left"></i> Undo</button>`;
  const content =
    `<div class="ol-damage-applied ol-healing-applied">`
    + `<span class="ol-damage-text"><strong>${escape(tActor.name)}</strong> was healed <strong>${delta}</strong> HP${lethalNote}.`
    + `<span class="ol-damage-hp"> (${current} → ${next} HP)</span></span>`
    + `<span class="ol-damage-actions">${undoBtn}</span>`
    + `</div>`;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: tActor }),
    content
  });
}

/**
 * The token document UUIDs to which the "re-aim" buttons apply: either the GM's
 * current targets, or the current selection (controlled tokens on the canvas).
 * @param {"target"|"selected"} aim
 * @returns {string[]}  Distinct token document UUIDs.
 */
function aimTokenUuids(aim) {
  const tokens = (aim === "selected")
    ? (canvas?.tokens?.controlled ?? [])
    : [...(game.user?.targets ?? [])];
  const uuids = tokens.map(t => t.document?.uuid).filter(Boolean);
  return [...new Set(uuids)];
}

/**
 * Apply a rolled damage/healing total to the user's CURRENT target(s) or CURRENT
 * selection — the two "re-aim" buttons beside a damage/heal apply row. Resolves
 * the token set at click time (not the row's bound token) and applies to each,
 * reusing the standard per-token apply (which posts its own "dealt/healed"
 * message with an Undo button). Each per-token apply enforces permission (GM, or
 * the token's owner), so a player can heal their own character; tokens the user
 * may not modify are skipped (a warning is shown for each).
 * @param {object} args
 * @param {"damage"|"healing"} args.kind
 * @param {"target"|"selected"} args.aim
 * @param {number} args.amount
 * @param {string} [args.damageType]
 * @returns {Promise<number>}  The number of tokens actually affected.
 */
export async function applyRolledToAim({ kind, aim, amount, damageType = "", baneUuid = "", boonUuid = "", powerLevel = 0, extraordinary = false, potent = false }) {
  const uuids = aimTokenUuids(aim);
  if ( !uuids.length ) {
    ui.notifications?.warn(aim === "selected"
      ? "Select (control) one or more tokens first."
      : "Target one or more tokens first.");
    return 0;
  }
  let applied = 0;
  for ( const uuid of uuids ) {
    if ( kind === "bane" ) {
      // Bane application is gated inside applyBaneToActor (GM or owner).
      if ( !baneUuid ) continue;
      await applyBaneByTokenUuid(uuid, baneUuid, Number(powerLevel) || 0, !!potent);
      applied++;
      continue;
    }
    if ( kind === "boon" ) {
      // Boon grant is gated inside applyBoonToActor (GM or owner); it also runs
      // an instantaneous boon's effect (Heal, Restoration) on grant.
      if ( !boonUuid ) continue;
      await applyBoonByTokenUuid(uuid, boonUuid, Number(powerLevel) || 0);
      applied++;
      continue;
    }
    // Only count tokens this user may actually modify (GM, or owner).
    const tokenDoc = await fromUuid(uuid);
    const tActor = tokenDoc?.actor ?? tokenDoc;
    if ( !canModifyActorHealth(tActor) ) {
      ui.notifications?.warn(`You don't have permission to ${kind === "healing" ? "heal" : "damage"} ${tActor?.name ?? "that token"}.`);
      continue;
    }
    if ( kind === "healing" ) await applyHealingToToken(uuid, Number(amount), "", { extraordinary });
    else await applyDamageToToken(uuid, Number(amount), damageType);
    applied++;
  }
  return applied;
}

/**
 * Revert previously-applied healing: subtract it from the target's health
 * (clamped at zero) and announce the reversal. Wired to the Undo button on a
 * "was healed" message (GM only). Mirrors {@link undoDamageToToken}.
 * @param {string} tokenUuid  The targeted token document UUID.
 * @param {number} healing    Hit points to take back.
 * @returns {Promise<void>}
 */
export async function undoHealingToToken(tokenUuid, healing, { lethalHealed = 0 } = {}) {
  if ( !game.user?.isGM ) {
    ui.notifications?.warn("Only a GM can revert healing.");
    return;
  }
  const tokenDoc = await fromUuid(tokenUuid);
  const tActor = tokenDoc?.actor ?? tokenDoc;
  if ( !tActor?.system?.health ) {
    ui.notifications?.warn("Could not find the target's health to revert healing.");
    return;
  }
  const heal = Math.max(0, Math.floor(Number(healing) || 0));
  const current = Number(tActor.system.health.value ?? 0);
  // Undoing a heal that crossed zero (Deathless Trance) should restore the negative
  // total, not floor at 0 — so reverting fully reverses the original heal delta.
  const allowNegative = CONFIG.OPENLEGEND?.canTakeNegativeDamage?.(tActor);
  const next = allowNegative ? (current - heal) : Math.max(0, current - heal);
  const update = { "system.health.value": next };

  // Extraordinary Healing also reduced lethal damage — restore it on undo.
  const reLethal = Math.max(0, Math.floor(Number(lethalHealed) || 0));
  if ( reLethal > 0 ) {
    const curLethal = Math.max(0, Math.floor(Number(tActor.system.health.lethal ?? 0)));
    update["system.health.lethal"] = curLethal + reLethal;
  }
  await tActor.update(update);

  const escape = foundry.utils.escapeHTML ?? (s => s);
  const lethalNote = reLethal > 0 ? ` and <strong>${reLethal}</strong> lethal restored` : "";
  const content =
    `<div class="ol-damage-reverted">`
    + `<strong>${escape(tActor.name)}</strong>: <strong>${heal}</strong> healing reverted${lethalNote}.`
    + `<span class="ol-damage-hp"> (${current} → ${next} HP)</span>`
    + `</div>`;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: tActor }),
    content
  });
}

/**
 * Render per-target Apply Damage mini-buttons for a damage-roll chat card
 * (Persistent Damage's per-round roll); GM-gated in the chat hook, reusing the
 * standard apply-damage / undo flow.
 * @param {Array<{tokenUuid: string, name: string}>} targets
 * @param {number} damage  The rolled damage total.
 * @returns {string} HTML.
 */
export function renderDamageApplyButtons(targets, damage) {
  const escape = foundry.utils.escapeHTML ?? (s => s);
  const dmg = Math.max(0, Math.floor(Number(damage) || 0));
  const rows = targets.map(t => {
    const applyId = foundry.utils.randomID?.() ?? `ol-dmg-${t.tokenUuid}-${dmg}`;
    return `
      <li class="ol-target-row is-hit">
        <span class="ol-target-name">${escape(t.name)}</span>
        <span class="ol-target-apply">
          <button type="button" class="ol-apply-damage ol-apply-mini" data-apply-id="${applyId}"
                  data-token-uuid="${escape(t.tokenUuid)}" data-damage="${dmg}" data-damage-type=""
                  data-tooltip="Apply ${dmg} damage">
            <i class="fas fa-heart-crack"></i> ${dmg}
          </button>
          ${renderApplyAimButtons("damage", dmg, "")}
        </span>
      </li>`;
  }).join("");
  return `<ul class="ol-target-results ol-heal-targets">${rows}</ul>`;
}

/**
 * Render the two "re-aim" mini-buttons shown beside a damage/healing apply button:
 * a bullseye that applies to the GM's CURRENT target(s), and a square that applies
 * to the CURRENT selection (controlled tokens). Unlike the row's own apply button
 * (which is bound to one token), these resolve their tokens at click time, so a GM
 * can re-aim a rolled total at whoever is targeted/selected now.
 * @param {"damage"|"healing"} kind
 * @param {number} amount    The rolled total to apply.
 * @param {string} [damageType]  Damage type label (damage only).
 * @returns {string} HTML.
 */
export function renderApplyAimButtons(kind, amount, damageType = "", { extraordinary = false } = {}) {
  const escape = foundry.utils.escapeHTML ?? (s => s);
  const n = Math.max(0, Math.floor(Number(amount) || 0));
  const verb = kind === "healing" ? "Heal" : "Apply";
  const noun = kind === "healing" ? "healing" : "damage";
  const dt = kind === "damage" ? ` data-damage-type="${escape(damageType)}"` : "";
  const amt = kind === "healing" ? `data-healing="${n}"` : `data-damage="${n}"`;
  // Extraordinary Healing rides along so the re-aim apply also heals lethal damage.
  const xtra = (kind === "healing" && extraordinary) ? ` data-extraordinary="1"` : "";
  return `
    <button type="button" class="ol-aim-target ol-apply-mini" data-kind="${kind}" ${amt}${dt}${xtra}
            data-tooltip="${verb} ${n} ${noun} to the current target(s)">
      <i class="fas fa-bullseye"></i>
    </button>
    <button type="button" class="ol-aim-selected ol-apply-mini" data-kind="${kind}" ${amt}${dt}${xtra}
            data-tooltip="${verb} ${n} ${noun} to the current selection (controlled token(s))">
      <i class="fas fa-vector-square"></i>
    </button>`;
}

/**
 * Render per-target Apply Healing mini-buttons for a healing-roll chat card
 * (GM-gated in the chat hook, like the damage apply buttons).
 * @param {Array<{tokenUuid: string, name: string}>} targets
 * @param {number} healing  The rolled healing total.
 * @returns {string} HTML.
 */
export function renderHealApplyButtons(targets, healing, { extraordinary = false } = {}) {
  const escape = foundry.utils.escapeHTML ?? (s => s);
  const heal = Math.max(0, Math.floor(Number(healing) || 0));
  const xtra = extraordinary ? ` data-extraordinary="1"` : "";
  const tip = extraordinary ? `Heal ${heal} HP and lethal damage` : `Heal ${heal} HP`;
  const rows = targets.map(t => {
    const applyId = foundry.utils.randomID?.() ?? `ol-heal-${t.tokenUuid}-${heal}`;
    return `
      <li class="ol-target-row is-hit">
        <span class="ol-target-name">${escape(t.name)}</span>
        <span class="ol-target-apply">
          <button type="button" class="ol-apply-healing ol-apply-mini" data-apply-id="${applyId}"
                  data-token-uuid="${escape(t.tokenUuid)}" data-healing="${heal}"${xtra}
                  data-tooltip="${tip}">
            <i class="fas fa-heart"></i> ${heal}${extraordinary ? ` <i class="fas fa-skull" title="Also heals lethal"></i>` : ""}
          </button>
          ${renderApplyAimButtons("healing", heal, "", { extraordinary })}
        </span>
      </li>`;
  }).join("");
  return `<ul class="ol-target-results ol-heal-targets">${rows}</ul>`;
}

/**
 * Whether the current user may change the given actor's health: the GM always,
 * or a player who OWNS that actor (so a player can heal/damage their own
 * character, while the GM can affect anyone). Mirrors the bane/boon apply gate.
 * @param {Actor} actor
 * @returns {boolean}
 */
function canModifyActorHealth(actor) {
  return !!(game.user?.isGM || actor?.isOwner);
}

/**
 * Apply damage to a target token's actor, subtracting from current health. Wired
 * to the chat card's Apply Damage button (GM, or the token's owner). Clamps HP at
 * zero, and posts a chat message recording how much (and what type of) damage the
 * target took, e.g. "Goblin was dealt 9 fire damage." That message carries an Undo
 * button.
 * @param {string} tokenUuid    The targeted token document UUID.
 * @param {number} damage       Damage to subtract.
 * @param {string} [damageType] Human-readable damage type label, e.g. "Fire".
 * @param {string} [applyId]    Id of the source Apply button, so Undo can re-enable it.
 * @returns {Promise<void>}
 */
export async function applyDamageToToken(tokenUuid, damage, damageType = "", applyId = "") {
  const tokenDoc = await fromUuid(tokenUuid);
  const tActor = tokenDoc?.actor ?? tokenDoc;
  if ( !tActor?.system?.health ) {
    ui.notifications?.warn("Could not find the target's health to apply damage.");
    return;
  }
  if ( !canModifyActorHealth(tActor) ) {
    ui.notifications?.warn(`You don't have permission to damage ${tActor.name}.`);
    return;
  }
  const dmg = Math.max(0, Math.floor(Number(damage) || 0));
  // Mount/vehicle (SRD Damage Threshold): reaching 0 HP inflicts a damage level
  // and HP returns to maximum, with remaining damage carried over — so one attack
  // can inflict several damage levels. Handled by its own apply path.
  if ( tActor.type === "mount" ) return applyDamageToMount(tActor, tokenUuid, dmg, damageType, applyId);
  const current = Number(tActor.system.health.value ?? 0);
  // HP normally floors at 0. Deathless Trance (while in a battle trance) lets it go
  // negative — damage is fully recorded so the trance-end death rule can apply.
  const allowNegative = CONFIG.OPENLEGEND?.canTakeNegativeDamage?.(tActor);
  const next = allowNegative ? (current - dmg) : Math.max(0, current - dmg);
  await tActor.update({ "system.health.value": next });

  // Announce the applied damage in chat. Damage type reads lowercase in the
  // sentence ("9 fire damage"); omitted cleanly when there is no type. An Undo
  // button reverts the change and re-enables the source Apply button.
  const name = tActor.name;
  const typeText = damageType ? ` ${String(damageType).toLowerCase()}` : "";
  const escape = foundry.utils.escapeHTML ?? (s => s);
  const undoBtn =
    `<button type="button" class="ol-undo-damage" data-apply-id="${escape(applyId)}"`
    + ` data-token-uuid="${escape(tokenUuid)}" data-damage="${dmg}" data-damage-type="${escape(damageType)}">`
    + `<i class="fas fa-rotate-left"></i> Undo</button>`;
  const content =
    `<div class="ol-damage-applied">`
    + `<span class="ol-damage-text"><strong>${escape(name)}</strong> was dealt <strong>${dmg}</strong>${escape(typeText)} damage.`
    + `<span class="ol-damage-hp"> (${current} → ${next} HP)</span></span>`
    + `<span class="ol-damage-actions">${undoBtn}</span>`
    + `</div>`;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: tActor }),
    content
  });
}

/**
 * Apply damage to a mount/vehicle (SRD Damage Threshold): when damage reduces it
 * to 0 HP it gains one damage level and its HP returns to maximum, with any
 * remaining damage carried over to the new total — repeatedly, so a single attack
 * can inflict multiple damage levels. Each damage level imposes disadvantage on
 * all of the mount's action rolls; at the damage threshold the mount is DISABLED
 * (unable to act until healed/repaired) and any leftover damage floors HP at 0.
 * The chat message's Undo restores the exact prior HP + damage level.
 * @param {Actor} tActor        The mount actor (permission already checked).
 * @param {string} tokenUuid    The targeted token document UUID.
 * @param {number} dmg          Damage to apply (already floored/clamped).
 * @param {string} [damageType] Human-readable damage type label, e.g. "Fire".
 * @param {string} [applyId]    Id of the source Apply button, so Undo can re-enable it.
 * @returns {Promise<void>}
 */
async function applyDamageToMount(tActor, tokenUuid, dmg, damageType = "", applyId = "") {
  const max = Math.max(1, Math.floor(Number(tActor.system.health.max ?? 1)));
  const threshold = Math.max(1, Math.floor(Number(tActor.system.damage?.threshold ?? 1)));
  const curHp = Number(tActor.system.health.value ?? 0);
  const curLevel = Math.max(0, Math.floor(Number(tActor.system.damage?.level ?? 0)));
  let hp = curHp - dmg;
  let level = curLevel;
  while ( (hp <= 0) && (level < threshold) ) {
    level += 1;
    hp += max;
  }
  // At the threshold the mount is disabled; leftover damage can't add more levels,
  // so HP just floors at 0.
  hp = Math.max(0, hp);
  await tActor.update({ "system.health.value": hp, "system.damage.level": level });

  const gained = level - curLevel;
  const disabled = level >= threshold;
  const name = tActor.name;
  const typeText = damageType ? ` ${String(damageType).toLowerCase()}` : "";
  const escape = foundry.utils.escapeHTML ?? (s => s);
  // Undo carries the PRIOR HP + damage level so the revert is exact across the
  // damage-level rollover (adding the damage back would land on the wrong side).
  const undoBtn =
    `<button type="button" class="ol-undo-damage" data-apply-id="${escape(applyId)}"`
    + ` data-token-uuid="${escape(tokenUuid)}" data-damage="${dmg}" data-damage-type="${escape(damageType)}"`
    + ` data-mount-hp="${curHp}" data-mount-level="${curLevel}">`
    + `<i class="fas fa-rotate-left"></i> Undo</button>`;
  const levelNote = gained > 0
    ? ` <strong class="ol-mount-dl"><i class="fas fa-car-burst"></i> +${gained} damage level${gained === 1 ? "" : "s"} (now ${level}/${threshold}).</strong>`
    : "";
  const disabledNote = disabled
    ? ` <strong class="ol-lethal-out"><i class="fas fa-ban"></i> Disabled until healed or repaired (1 day per wealth level per damage level).</strong>`
    : "";
  const content =
    `<div class="ol-damage-applied">`
    + `<span class="ol-damage-text"><strong>${escape(name)}</strong> was dealt <strong>${dmg}</strong>${escape(typeText)} damage.`
    + `<span class="ol-damage-hp"> (${curHp} → ${hp} HP)</span>${levelNote}${disabledNote}</span>`
    + `<span class="ol-damage-actions">${undoBtn}</span>`
    + `</div>`;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: tActor }),
    content
  });
}

/* -------------------------------------------- */

/**
 * Apply LETHAL damage to a target token's actor (Lethal Damage rules): instead of
 * subtracting from current HP, it reduces the MAXIMUM by the amount dealt — modeled
 * as accrued `system.health.lethal`, capped at the base max. At lethal ≥ max the
 * creature falls unconscious (surfaced on the sheet). Posts a chat message with an
 * Undo. Wired to a damaging Apply button flagged lethal (GM, or the token's owner).
 * @param {string} tokenUuid    The targeted token document UUID.
 * @param {number} damage       Lethal damage to accrue.
 * @param {string} [damageType] Human-readable damage type label, e.g. "Fire".
 * @param {string} [applyId]    Id of the source Apply button, so Undo can re-enable it.
 * @returns {Promise<void>}
 */
export async function applyLethalDamageToToken(tokenUuid, damage, damageType = "", applyId = "") {
  const tokenDoc = await fromUuid(tokenUuid);
  const tActor = tokenDoc?.actor ?? tokenDoc;
  if ( !tActor?.system?.health ) {
    ui.notifications?.warn("Could not find the target's health to apply lethal damage.");
    return;
  }
  if ( !canModifyActorHealth(tActor) ) {
    ui.notifications?.warn(`You don't have permission to damage ${tActor.name}.`);
    return;
  }
  const dmg = Math.max(0, Math.floor(Number(damage) || 0));
  const base = Math.max(0, Math.floor(Number(tActor.system.health.maxBase ?? tActor.system.health.max ?? 0)));
  const curLethal = Math.max(0, Math.floor(Number(tActor.system.health.lethal ?? 0)));
  // Accrued lethal can't exceed the base max (the rule's cap).
  const nextLethal = Math.min(base, curLethal + dmg);
  const dealt = nextLethal - curLethal;
  // Lethal damage is ALSO dealt to CURRENT HP (per the SRD: Trish 22/22 takes 8
  // lethal → 14 current / 14 max). So subtract the dealt amount from current HP as
  // normal damage, in lockstep with lowering the max. HP floors at 0 (Deathless
  // Trance allows negative, fully recording it for the trance-end death rule).
  const curHp = Number(tActor.system.health.value ?? 0);
  const allowNegative = CONFIG.OPENLEGEND?.canTakeNegativeDamage?.(tActor);
  const nextHp = allowNegative ? (curHp - dealt) : Math.max(0, curHp - dealt);
  await tActor.update({ "system.health.lethal": nextLethal, "system.health.value": nextHp });

  const name = tActor.name;
  const typeText = damageType ? ` ${String(damageType).toLowerCase()}` : "";
  const escape = foundry.utils.escapeHTML ?? (s => s);
  // Unconscious from lethal: accrued lethal ≥ full max.
  const out = (nextLethal >= base) && (base > 0);
  const undoBtn =
    `<button type="button" class="ol-undo-damage" data-apply-id="${escape(applyId)}"`
    + ` data-token-uuid="${escape(tokenUuid)}" data-damage="${dealt}" data-damage-type="${escape(damageType)}" data-lethal="1">`
    + `<i class="fas fa-rotate-left"></i> Undo</button>`;
  const content =
    `<div class="ol-damage-applied ol-lethal-applied">`
    + `<span class="ol-damage-text"><strong>${escape(name)}</strong> took <strong>${dealt}</strong>${escape(typeText)} <strong>lethal</strong> damage — current &amp; max HP reduced.`
    + `<span class="ol-damage-hp"> (${curHp} → ${nextHp} HP; max ${base - curLethal} → ${base - nextLethal})</span>`
    + `${out ? ` <strong class="ol-lethal-out"><i class="fas fa-bed"></i> Unconscious until 1 lethal is healed.</strong>` : ""}</span>`
    + `<span class="ol-damage-actions">${undoBtn}</span>`
    + `</div>`;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: tActor }),
    content
  });
}

/* -------------------------------------------- */

/**
 * Revert previously-applied LETHAL damage: subtract it from the accrued lethal
 * total (floored at 0) and announce the reversal. Mirrors {@link undoDamageToToken}.
 * @param {string} tokenUuid  The targeted token document UUID.
 * @param {number} damage     Lethal to remove.
 * @param {string} [damageType]
 * @returns {Promise<void>}
 */
export async function undoLethalDamageToToken(tokenUuid, damage, damageType = "") {
  if ( !game.user?.isGM ) {
    ui.notifications?.warn("Only a GM can revert lethal damage.");
    return;
  }
  const tokenDoc = await fromUuid(tokenUuid);
  const tActor = tokenDoc?.actor ?? tokenDoc;
  if ( !tActor?.system?.health ) return;
  const dmg = Math.max(0, Math.floor(Number(damage) || 0));
  const curLethal = Math.max(0, Math.floor(Number(tActor.system.health.lethal ?? 0)));
  const nextLethal = Math.max(0, curLethal - dmg);
  const restored = curLethal - nextLethal;
  // Lethal damage also reduced current HP, so restore that here (clamped to the
  // restored max). Mirrors applyLethalDamageToToken.
  const base = Math.max(0, Math.floor(Number(tActor.system.health.maxBase ?? tActor.system.health.max ?? 0)));
  const curHp = Number(tActor.system.health.value ?? 0);
  const nextHp = Math.min(base - nextLethal, curHp + restored);
  await tActor.update({ "system.health.lethal": nextLethal, "system.health.value": nextHp });

  const escape = foundry.utils.escapeHTML ?? (s => s);
  const content =
    `<div class="ol-damage-reverted">`
    + `<strong>${escape(tActor.name)}</strong>: <strong>${restored}</strong> lethal damage reverted.`
    + `<span class="ol-damage-hp"> (${curHp} → ${nextHp} HP; lethal ${curLethal} → ${nextLethal})</span>`
    + `</div>`;
  await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: tActor }), content });
}

/* -------------------------------------------- */

/**
 * Revert previously-applied damage: add it back to the target's health (clamped
 * to max) and announce the reversal in chat. Wired to the Undo button on a
 * "damage applied" message (GM only). The matching Apply button — found anywhere
 * in the chat log by its apply-id — is re-enabled by the caller.
 * @param {string} tokenUuid    The targeted token document UUID.
 * @param {number} damage       Damage to add back.
 * @param {string} [damageType] Human-readable damage type label, e.g. "Fire".
 * @param {object} [opts]
 * @param {number|null} [opts.mountHp]    Mount undo: the exact prior HP to restore.
 * @param {number|null} [opts.mountLevel] Mount undo: the exact prior damage level.
 * @returns {Promise<void>}
 */
export async function undoDamageToToken(tokenUuid, damage, damageType = "", { mountHp = null, mountLevel = null } = {}) {
  if ( !game.user?.isGM ) {
    ui.notifications?.warn("Only a GM can revert damage.");
    return;
  }
  const tokenDoc = await fromUuid(tokenUuid);
  const tActor = tokenDoc?.actor ?? tokenDoc;
  if ( !tActor?.system?.health ) {
    ui.notifications?.warn("Could not find the target's health to revert damage.");
    return;
  }
  const dmg = Math.max(0, Math.floor(Number(damage) || 0));
  const current = Number(tActor.system.health.value ?? 0);
  // Mount/vehicle: the apply may have rolled over one or more damage levels, so
  // the undo restores the recorded prior HP + damage level exactly.
  if ( (tActor.type === "mount") && (mountHp !== null) ) {
    const hp = Math.max(0, Math.floor(Number(mountHp) || 0));
    const lvl = Math.max(0, Math.floor(Number(mountLevel) || 0));
    await tActor.update({ "system.health.value": hp, "system.damage.level": lvl });
    const escapeM = foundry.utils.escapeHTML ?? (s => s);
    const typeTextM = damageType ? ` ${String(damageType).toLowerCase()}` : "";
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: tActor }),
      content: `<div class="ol-damage-reverted"><strong>${escapeM(tActor.name)}</strong>: <strong>${dmg}</strong>${escapeM(typeTextM)} damage reverted.`
        + `<span class="ol-damage-hp"> (${current} → ${hp} HP, damage level ${lvl})</span></div>`
    });
    return;
  }
  // Add the damage back, clamped to the health maximum where one is known.
  const max = Number(tActor.system.health.max);
  let next = current + dmg;
  if ( Number.isFinite(max) ) next = Math.min(max, next);
  await tActor.update({ "system.health.value": next });

  const name = tActor.name;
  const typeText = damageType ? ` ${String(damageType).toLowerCase()}` : "";
  const escape = foundry.utils.escapeHTML ?? (s => s);
  const content =
    `<div class="ol-damage-reverted">`
    + `<strong>${escape(name)}</strong>: <strong>${dmg}</strong>${escape(typeText)} damage reverted.`
    + `<span class="ol-damage-hp"> (${current} → ${next} HP)</span>`
    + `</div>`;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: tActor }),
    content
  });
}

/* -------------------------------------------- */

/**
 * Build ActiveEffect creation data for a bane invoked at a power level — a
 * LEVELED condition. The bane's own embedded Active Effects (the ones shown
 * and edited on its sheet's Effects tab) are cloned at the invoked power
 * level; a bane without embedded effects falls back to a condition
 * synthesized from its "disadvantage N" game effects. Stepping
 * flags.openlegend.powerLevel later re-scales the applied condition in place
 * (see OpenLegendActiveEffect). Always enabled.
 * @param {Item} bane
 * @param {number} [powerLevel]  Invoked power level (activates change rows whose level ≤ it).
 * @returns {object[]} ActiveEffect creation data (one entry per embedded effect; at least one).
 */
export function baneActiveEffectData(bane, powerLevel = 0) {
  return leveledEffectData(bane, powerLevel, {
    kind: "disadvantage",
    sourceFlag: "fromBane",
    defaultImg: "icons/svg/terror.svg"
  });
}

/**
 * Prompt the user to pick the power level to invoke a bane/boon at. The choices
 * are only the levels at which the item actually changes — its distinct
 * power-effect breakpoint thresholds (e.g. Bolster → 3, 6, 8), not every
 * integer in between. Each is labelled with that level's effect text where
 * available. Falls back to a single choice (the minimum) when there is no
 * power-effect breakdown. Resolves to the chosen integer, or null if dismissed.
 * @param {Item} item  The bane or boon being applied.
 * @returns {Promise<number|null>}
 */
/**
 * Prompt for the PROVOKING token when the Provoked bane is applied: a select of
 * scene tokens — every token for the GM, only VISIBLE ones for a player — minus
 * the afflicted creature's own token(s). The pick is stored on the condition
 * (flags.openlegend.provoker) so the roll pipeline can penalize attacks that
 * don't target the provoker.
 * @param {Actor} afflicted  The creature receiving Provoked.
 * @returns {Promise<{tokenUuid: string, name: string}|null|false>}
 *   The picked token, null when there are no candidates (apply unlinked), or
 *   false when the dialog is dismissed (abort the application).
 */
async function promptProvokerToken(afflicted) {
  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
  const candidates = (canvas?.tokens?.placeables ?? [])
    // A player only sees (and may pick) tokens visible to them; the GM sees all.
    .filter(t => game.user?.isGM || t.visible)
    // The provoker is someone ELSE — never the afflicted creature's own token.
    .filter(t => t.actor && (t.actor !== afflicted))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if ( !candidates.length ) {
    ui.notifications?.warn("No candidate tokens on the scene — Provoked is applied without a stored provoker.");
    return null;
  }
  const options = candidates.map((t, i) =>
    `<option value="${esc(t.document.uuid)}"${i === 0 ? " selected" : ""}>${esc(t.name)}</option>`).join("");
  const { DialogV2 } = foundry.applications.api;
  const picked = await DialogV2.wait({
    window: { title: `Provoked — who provokes ${afflicted.name}?` },
    classes: ["openlegend"],
    content: `
      <p><strong>${esc(afflicted.name)}</strong> is Provoked: their attacks that do not include the provoker as a target suffer the bane's disadvantage.</p>
      <div class="form-group">
        <label>Provoked by</label>
        <select name="provoker" style="flex:1;" autofocus>${options}</select>
      </div>`,
    rejectClose: false,
    buttons: [
      { action: "ok", label: "Apply Provoked", icon: "fas fa-bullseye", default: true,
        callback: (event, button) => button.form.elements.provoker.value },
      { action: "cancel", label: "Cancel", icon: "fas fa-times", callback: () => false }
    ]
  });
  if ( typeof picked !== "string" ) return false; // dismissed / cancelled
  const token = candidates.find(t => t.document.uuid === picked);
  return token ? { tokenUuid: token.document.uuid, name: token.name } : false;
}

/**
 * Prompt for a Detection boon's sensed phenomenon (CONFIG.detectionTypes).
 * @param {string} boonName
 * @returns {Promise<{key: string, label: string}|null>}  Null when dismissed.
 */
async function promptDetectionType(boonName) {
  const types = CONFIG.OPENLEGEND?.detectionTypes ?? {};
  const { DialogV2 } = foundry.applications.api;
  const options = Object.entries(types)
    .map(([k, t], i) => `<option value="${k}"${i === 0 ? " selected" : ""}>${t.label}</option>`)
    .join("");
  const key = await DialogV2.wait({
    window: { title: `${boonName} — sensed phenomenon` },
    content: `
      <p><strong>${boonName}</strong> attunes the target's senses to one phenomenon.</p>
      <div class="form-group">
        <label>Detect</label>
        <select name="detectionType" style="flex:1;">${options}</select>
      </div>`,
    buttons: [
      { action: "ok", label: "Apply", icon: "fas fa-eye", default: true,
        callback: (event, button) => button.form.elements.detectionType.value },
      { action: "cancel", label: "Cancel", icon: "fas fa-times", callback: () => null }
    ],
    rejectClose: false
  });
  if ( (typeof key !== "string") || !types[key] ) return null;
  return { key, label: types[key].label };
}

/**
 * Prompt for WHO may still see an Invisible / Concealment bearer: a checkbox
 * per non-GM user. Preselects `current` (when updating an existing condition)
 * or, on a fresh grant, the users who own the bearer (they should usually keep
 * seeing their own character). The GM always sees the token regardless.
 * @param {Actor} actor        The boon's bearer.
 * @param {string} boonName
 * @param {string[]|null} [current]  The existing allow-list, when updating.
 * @returns {Promise<string[]|null>}  Allowed user ids, or null when dismissed.
 */
async function promptVisibilityAllowList(actor, boonName, current = null) {
  const users = (game.users?.contents ?? []).filter(u => !u.isGM);
  // No players in the world: invisible to every (hypothetical) player.
  if ( !users.length ) return [];
  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
  const preselected = u => Array.isArray(current)
    ? current.includes(u.id)
    : actor.testUserPermission(u, "OWNER");
  const rows = users.map(u => `
    <label class="ol-check" style="display:flex;gap:6px;align-items:center;">
      <input type="checkbox" name="seer" value="${u.id}" ${preselected(u) ? "checked" : ""}/>
      <span>${esc(u.name)}${u.character ? ` (${esc(u.character.name)})` : ""}</span>
    </label>`).join("");
  const { DialogV2 } = foundry.applications.api;
  const result = await DialogV2.wait({
    window: { title: `${boonName} — who can see ${actor.name}?` },
    content: `
      <p><strong>${esc(actor.name)}</strong> turns hard to see. Check the players whose clients should STILL show the token (the GM always sees it).</p>
      ${rows}`,
    buttons: [
      { action: "ok", label: "Apply Visibility", icon: "fas fa-eye-slash", default: true,
        callback: (event, button) =>
          Array.from(button.form.querySelectorAll('input[name="seer"]:checked')).map(i => i.value) },
      { action: "cancel", label: "Cancel", icon: "fas fa-times", callback: () => null }
    ],
    rejectClose: false
  });
  return Array.isArray(result) ? result : null;
}

async function promptInvocationPowerLevel(item) {
  const sys = item.system ?? {};
  const min = Math.max(0, Math.floor(Number(sys.powerLevel) || 0));
  // Effect text per level, for labels.
  const textFor = lvl => {
    const exact = (sys.powerEffects ?? []).find(pe => Number(pe.powerLevel) === lvl);
    return exact?.effect ? String(exact.effect).trim() : "";
  };

  // Offer only the breakpoint levels: each distinct power-effect threshold that
  // is at or above the item's minimum. These are the levels where the applied
  // condition actually differs.
  const breakpoints = (sys.powerEffects ?? [])
    .map(pe => Math.max(0, Math.floor(Number(pe.powerLevel) || 0)))
    .filter(l => l >= min);
  const levels = [...new Set([min, ...breakpoints])]
    .filter(l => l >= 1)
    .sort((a, b) => a - b);
  if ( !levels.length ) levels.push(Math.max(1, min));

  const escape = foundry.utils.escapeHTML ?? (s => s);
  const options = levels.map(l => {
    const t = textFor(l);
    return `<option value="${l}"${l === min ? " selected" : ""}>PL ${l}${t ? ` — ${escape(t).slice(0, 80)}` : ""}</option>`;
  }).join("");

  const { DialogV2 } = foundry.applications.api;
  const result = await DialogV2.wait({
    window: { title: `Invoke ${item.name}` },
    content: `
      <p>Apply <strong>${escape(item.name)}</strong> at which power level?</p>
      <div class="form-group">
        <label>Power Level</label>
        <select name="powerLevel" style="flex:1;">${options}</select>
      </div>`,
    buttons: [
      {
        action: "apply",
        label: "Apply",
        icon: "fas fa-check",
        default: true,
        callback: (event, button) => Number(button.form.elements.powerLevel.value)
      },
      { action: "cancel", label: "Cancel", icon: "fas fa-times" }
    ],
    rejectClose: false
  });
  return (typeof result === "number") ? result : null;
}

/**
 * Placeholder subject key on a change whose attribute is chosen at drop time
 * (e.g. Bolster). Kept in sync with the same constant in build-boons.mjs.
 * @type {string}
 */
const PROMPT_ATTR_KEY = "attr.__prompt__";

/**
 * Prompt the user to pick a single attribute (for a promptSubject="attribute"
 * effect such as Bolster). Lists all 18 attributes. Resolves to the chosen
 * attribute KEY (e.g. "agility"), or null if dismissed.
 * @param {string} itemName  For the dialog title.
 * @returns {Promise<string|null>}
 */
async function promptAttributeSubject(itemName) {
  const labels = CONFIG.OPENLEGEND?.attributeLabels ?? {};
  const escape = foundry.utils.escapeHTML ?? (s => s);
  const options = Object.entries(labels)
    .map(([key, label]) => `<option value="${key}">${escape(label)}</option>`)
    .join("");
  const { DialogV2 } = foundry.applications.api;
  const result = await DialogV2.wait({
    window: { title: `${itemName} — Choose Attribute` },
    content: `
      <p>Which attribute does <strong>${escape(itemName)}</strong> bolster?</p>
      <div class="form-group">
        <label>Attribute</label>
        <select name="attribute" style="flex:1;">${options}</select>
      </div>`,
    buttons: [
      { action: "pick", label: "Choose", icon: "fas fa-check", default: true,
        callback: (event, button) => button.form.elements.attribute.value },
      { action: "cancel", label: "Cancel", icon: "fas fa-times" }
    ],
    rejectClose: false
  });
  return (typeof result === "string") && result ? result : null;
}

/**
 * Prompt the user to pick a single damage type (for the Resistance boon, whose
 * invoker chooses one attack type the bearer resists). Lists every damage type
 * (built-in AND user-defined — Resistance covers physical types too, unlike the
 * Energy Resistance feat). Resolves to `{ key, label }` for the chosen type, or
 * null if dismissed.
 * @param {string} itemName  For the dialog title.
 * @returns {Promise<{key: string, label: string}|null>}
 */
async function promptDamageTypeSubject(itemName) {
  const cfg = CONFIG.OPENLEGEND ?? {};
  const labels = cfg.allDamageTypes ? cfg.allDamageTypes() : (cfg.damageTypes ?? {});
  const escape = foundry.utils.escapeHTML ?? (s => s);
  const options = Object.entries(labels)
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    .map(([key, label]) => `<option value="${escape(key)}">${escape(label)}</option>`)
    .join("");
  const { DialogV2 } = foundry.applications.api;
  const result = await DialogV2.wait({
    window: { title: `${itemName} — Choose Damage Type` },
    content: `
      <p>Which type of attack does <strong>${escape(itemName)}</strong> resist? The bearer's defenses rise against attacks of this type.</p>
      <div class="form-group">
        <label>Damage Type</label>
        <select name="damageType" style="flex:1;">${options}</select>
      </div>`,
    buttons: [
      { action: "pick", label: "Choose", icon: "fas fa-check", default: true,
        callback: (event, button) => {
          const sel = button.form.elements.damageType;
          const opt = sel.selectedOptions?.[0];
          return JSON.stringify({ key: sel.value, label: opt?.textContent ?? sel.value });
        } },
      { action: "cancel", label: "Cancel", icon: "fas fa-times" }
    ],
    rejectClose: false
  });
  if ( (typeof result !== "string") || !result ) return null;
  try { const p = JSON.parse(result); return p?.key ? p : null; } catch { return null; }
}

/**
 * Prompt for a Barrier's properties at drop time (SRD): the PL's available pool as
 * checkboxes ("choose N"), plus a bane sub-picker when Baneful is selected. Returns
 * `{ properties, damageDie, baneUuid, baneName, banePowerLevel, powerLevel }` or null
 * if cancelled. The chosen count is clamped to N (extras beyond the first N ignored).
 * @param {Item} boon
 * @param {Actor} actor
 * @param {number} powerLevel
 * @returns {Promise<object|null>}
 */
async function promptBarrierProperties(boon, actor, powerLevel) {
  const cfg = CONFIG.OPENLEGEND ?? {};
  const escape = foundry.utils.escapeHTML ?? (s => s);
  const pl = Math.max(0, Math.floor(Number(powerLevel) || 0));
  const maxCount = cfg.barrierPropertyCount ? cfg.barrierPropertyCount(pl) : 0;
  const pool = cfg.barrierPropertyPool ? cfg.barrierPropertyPool(pl) : [];
  const die = cfg.barrierDamageDie ? cfg.barrierDamageDie(pl) : "";
  const defs = Object.fromEntries((cfg.BARRIER_PROPERTIES ?? []).map(p => [p.key, p]));

  // Banes the boon's attacking attributes can invoke at PL ≤ the barrier's PL, for
  // the Baneful sub-pick. Match against the boon's invoking-attribute list.
  const baneAttrs = new Set((boon.system?.attributes ?? []).map(a => String(a).toLowerCase()));
  const baneOpts = [];
  for ( const bane of await selectableDocuments("bane", "tomucatos-open-legend-rpg-system.banes") ) {
    const ba = (bane.system?.attacks ?? []).map(a => String(a.attackingAttribute ?? "").toLowerCase());
    if ( !ba.some(a => baneAttrs.has(a)) ) continue;
    const bpl = Number(bane.system?.powerLevel ?? 0);
    if ( bpl > pl ) continue;
    baneOpts.push({ uuid: bane.uuid, name: bane.name, powerLevel: bpl });
  }
  baneOpts.sort((a, b) => (a.powerLevel - b.powerLevel) || a.name.localeCompare(b.name));

  const checks = pool.map(key => {
    const def = defs[key] ?? { key, label: key, description: "" };
    const label = (key === "damaging") && die ? `${def.label} (${die})` : def.label;
    return `<label class="ol-check" title="${escape(def.description)}" style="display:flex;gap:6px;align-items:center;">
      <input type="checkbox" name="prop" value="${key}"/> <span>${escape(label)}</span></label>`;
  }).join("");
  const baneSelect = baneOpts.length
    ? `<div class="form-group" data-barrier-bane-row style="display:none;">
         <label>Baneful — bane (PL ≤ ${pl})</label>
         <select name="bane" style="flex:1;"><option value="">— None —</option>${
           baneOpts.map(o => `<option value="${escape(o.uuid)}" data-name="${escape(o.name)}" data-pl="${o.powerLevel}">${escape(o.name)} (PL ${o.powerLevel})</option>`).join("")
         }</select>
       </div>`
    : "";

  const { DialogV2 } = foundry.applications.api;
  const result = await DialogV2.wait({
    window: { title: `${boon.name} — Choose ${maxCount} Propert${maxCount === 1 ? "y" : "ies"} (PL ${pl})` },
    content: `
      <p>Choose <strong>${maxCount}</strong> propert${maxCount === 1 ? "y" : "ies"} for the barrier:</p>
      <div class="barrier-prop-list" style="display:flex;flex-direction:column;gap:4px;">${checks}</div>
      ${baneSelect}`,
    buttons: [
      { action: "pick", label: "Create Barrier", icon: "fas fa-check", default: true,
        callback: (event, button) => {
          const form = button.form;
          const chosen = [...form.querySelectorAll('input[name="prop"]:checked')].map(i => i.value).slice(0, maxCount);
          const baneEl = form.elements.bane;
          const baneUuid = (chosen.includes("baneful") && baneEl) ? baneEl.value : "";
          const baneOpt = baneEl?.selectedOptions?.[0];
          return JSON.stringify({
            properties: chosen.join(","),
            baneUuid,
            baneName: baneUuid ? (baneOpt?.dataset.name ?? "") : "",
            banePowerLevel: baneUuid ? Number(baneOpt?.dataset.pl ?? 0) : 0
          });
        } },
      { action: "cancel", label: "Cancel", icon: "fas fa-times" }
    ],
    render: (event, dialog) => {
      // Reveal the Baneful bane row only while Baneful is checked.
      const root = dialog.element;
      const baneRow = root.querySelector("[data-barrier-bane-row]");
      const sync = () => { if ( baneRow ) baneRow.style.display =
        root.querySelector('input[name="prop"][value="baneful"]')?.checked ? "" : "none"; };
      root.querySelectorAll('input[name="prop"]').forEach(cb => cb.addEventListener("change", sync));
      sync();
    },
    rejectClose: false
  });
  if ( (typeof result !== "string") || !result ) return null;
  let parsed;
  try { parsed = JSON.parse(result); } catch { return null; }
  return { ...parsed, damageDie: die, powerLevel: pl };
}

/**
 * Render the Barrier description note (chosen properties + their rule text + the
 * Baneful bane), appended to the granted effect's description so the effects panel
 * shows what the barrier does. Returns "" when no properties are chosen.
 * @param {object} barrier  {properties, damageDie, baneName, banePowerLevel}
 * @returns {string}  HTML, or "".
 */
function renderBarrierNote(barrier) {
  const cfg = CONFIG.OPENLEGEND ?? {};
  const escape = foundry.utils.escapeHTML ?? (s => s);
  const defs = Object.fromEntries((cfg.BARRIER_PROPERTIES ?? []).map(p => [p.key, p]));
  const keys = String(barrier?.properties ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if ( !keys.length ) return "";
  const lines = keys.map(key => {
    const def = defs[key] ?? { label: key, description: "" };
    let label = def.label;
    if ( (key === "damaging") && barrier.damageDie ) label += ` (${escape(barrier.damageDie)})`;
    if ( (key === "baneful") && barrier.baneName ) label += ` → ${escape(barrier.baneName)}${barrier.banePowerLevel ? ` (PL ${barrier.banePowerLevel})` : ""}`;
    return `<li><strong>${escape(label)}:</strong> ${escape(def.description)}</li>`;
  }).join("");
  return `<div class="ol-barrier-note"><p><i class="fas fa-block-brick"></i> <strong>Barrier properties:</strong></p><ul>${lines}</ul></div>`;
}

/**
 * Rewrite any PROMPT_ATTR_KEY placeholder in an effect-data list's change rows to
 * the chosen attribute subject (attr.<key>), in place. Returns the count
 * rewritten so callers can confirm the prompt was actually needed.
 * @param {object[]} effectDataList
 * @param {string} attrKey  e.g. "agility"
 * @returns {number}
 */
function applyChosenAttribute(effectDataList, attrKey) {
  let n = 0;
  for ( const data of effectDataList ) {
    for ( const change of data.system?.changes ?? [] ) {
      if ( change.key === PROMPT_ATTR_KEY ) { change.key = `attr.${attrKey}`; n++; }
    }
  }
  return n;
}

/**
 * Apply a bane to an actor: embed the bane item (keeping its full data) and add
 * a derived Active Effect at the given power level directly on the actor (so it
 * shows in the Effects tab regardless of compendium effect-storage quirks).
 * Posts a confirmation chat message. GM only.
 *
 * Power level: pass an explicit number to skip the prompt (chat-card buttons
 * pass the achieved level); pass null/undefined to prompt the user with
 * {@link promptInvocationPowerLevel} (drag-to-token / drag-to-sheet). A
 * dismissed prompt cancels the apply.
 * @param {Actor} actor       The target actor.
 * @param {string} baneUuid   The bane Item's UUID.
 * @param {number|null} [powerLevel]
 * @param {boolean} [potent]
 * @param {object} [opts]
 * @param {string} [opts.sourceTokenUuid]  Token UUID the chat-card Apply button
 *   targeted, stamped on the Undo button so it can re-enable that button.
 * @returns {Promise<void>}
 */
export async function applyBaneToActor(actor, baneUuid, powerLevel = null, potent = false, { sourceTokenUuid = "" } = {}) {
  if ( !actor ) return;
  // A GM can afflict anyone; a player may apply only to a character they own
  // (e.g. dropping a bane onto their own sheet).
  if ( !game.user?.isGM && !actor.isOwner ) {
    ui.notifications?.warn("Only a GM can apply a bane to that character.");
    return;
  }
  const bane = await fromUuid(baneUuid);
  if ( bane?.type !== "bane" ) {
    ui.notifications?.warn("That is not a bane.");
    return;
  }
  potent = !!potent;

  // Nullify is INSTANTANEOUS: it never lingers as a condition, so no bane Item
  // or ActiveEffect is written to the target (and a stale Nullify condition from
  // an older world can't block a new strike — this runs before the "already
  // afflicted" guard). Its entire effect is the boon cancelation — the prompt
  // removes the chosen boon and applies the 1-minute "Nullify Boon Cancelation"
  // blocker (see promptNullifyRemoval).
  if ( bane.name === "Nullify" ) {
    if ( powerLevel == null ) {
      powerLevel = await promptInvocationPowerLevel(bane);
      if ( powerLevel == null ) return; // dismissed
    }
    const escapeN = foundry.utils.escapeHTML ?? (s => s);
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="ol-bane-applied"><strong>${escapeN(actor.name)}</strong> is struck by <strong>Nullify</strong>${powerLevel ? ` (PL ${powerLevel})` : ""} — one active boon may be canceled.</div>`
    });
    await promptNullifyRemoval(actor, powerLevel);
    actor.sheet?.render(false);
    return;
  }

  // Stacking bane (e.g. Fatigued): if the target is ALREADY afflicted, each new
  // application escalates the stack by one tier (capped at the highest authored
  // row) rather than adding a second copy. Power level is irrelevant to the
  // stack axis, so no prompt — just bump and report.
  const baneStacks = (bane.effects?.contents ?? []).some(e => e.flags?.openlegend?.stacking);
  if ( baneStacks ) {
    const existing = actor.effects.find(e =>
      (e.flags?.openlegend?.fromBane === bane.name) && e.flags?.openlegend?.stacking);
    if ( existing ) {
      // Keep the potent flag in sync when re-applying a potent bane.
      if ( potent && !existing.flags?.openlegend?.potent ) await existing.update({ "flags.openlegend.potent": true });
      const max = stackingMax(existing);
      const cur = Math.max(1, Math.floor(Number(existing.flags.openlegend.stackLevel) || 1));
      const next = Math.min(max, cur + 1);
      const escape0 = foundry.utils.escapeHTML ?? (s => s);
      if ( next === cur ) {
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: `<div class="ol-bane-applied"><strong>${escape0(actor.name)}</strong> is already at maximum <strong>${escape0(bane.name)}</strong> (level ${cur}).</div>`
        });
        return;
      }
      await existing.update({ "flags.openlegend.stackLevel": next });
      // Undo reverts the stack to its pre-click level (it does not remove the bane).
      const undoStackBtn =
        `<button type="button" class="ol-undo-bane" data-actor-uuid="${escape0(actor.uuid)}"`
        + ` data-stack-effect-id="${escape0(existing.id)}" data-prev-level="${cur}"`
        + ` data-bane-name="${escape0(bane.name)}">`
        + `<i class="fas fa-rotate-left"></i> Undo</button>`;
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="ol-bane-applied"><span class="ol-bane-row"><span class="ol-damage-text"><strong>${escape0(actor.name)}</strong>'s <strong>${escape0(bane.name)}</strong> escalates to level <strong>${next}</strong>.</span><span class="ol-damage-actions">${undoStackBtn}</span></span></div>`
      });
      actor.sheet?.render(false);
      return;
    }
    // First application of a stacking bane: no power-level prompt; starts at 1.
    powerLevel = Math.max(0, Math.floor(Number(bane.system?.powerLevel) || 0));
  } else {
    // Non-stacking bane: only one copy per character. If already afflicted, don't
    // add a second — keep the existing one (syncing Potent if newly potent) and
    // report it. Only stacking banes (e.g. Fatigued) may be held more than once.
    const already = actor.effects.find(e => e.flags?.openlegend?.fromBane === bane.name);
    if ( already ) {
      const escape0 = foundry.utils.escapeHTML ?? (s => s);
      if ( potent && !already.flags?.openlegend?.potent ) await already.update({ "flags.openlegend.potent": true });
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="ol-bane-applied"><strong>${escape0(actor.name)}</strong> is already afflicted by <strong>${escape0(bane.name)}</strong>.</div>`
      });
      return;
    }
  }

  // No explicit level (a drop) → ask which power level to invoke at.
  if ( powerLevel == null ) {
    powerLevel = await promptInvocationPowerLevel(bane);
    if ( powerLevel == null ) return; // dismissed
  }

  // Provoked: ask WHO provokes (GM: any scene token; player: visible tokens) and
  // store the pick on the condition — the roll pipeline seeds the bane's
  // disadvantage (PL − 3) on the bearer's attacks that don't target the
  // provoker. Gated by the "provokedAutomation" world setting; resolved BEFORE
  // anything is written (cancel = nothing applied; no candidates = unlinked).
  let provoker = null;
  if ( (bane.name === "Provoked") && game.settings.get("tomucatos-open-legend-rpg-system", "provokedAutomation") ) {
    provoker = await promptProvokerToken(actor);
    if ( provoker === false ) return; // dismissed
  }

  const [baneItem] = await actor.createEmbeddedDocuments("Item", [bane.toObject()]);
  const effectDataList = baneActiveEffectData(bane, powerLevel);
  // Mark the applied effect(s) Potent (target resists at disadvantage 1). The
  // flag is toggleable later on the condition row / effects panel.
  if ( potent ) {
    for ( const data of effectDataList ) {
      data.flags ??= {};
      data.flags.openlegend = { ...(data.flags.openlegend ?? {}), potent: true };
    }
  }
  // Stamp the provoker on the primary condition (Provoked only, see above).
  if ( provoker ) {
    const first = effectDataList[0];
    first.flags ??= {};
    first.flags.openlegend = { ...(first.flags.openlegend ?? {}), provoker };
  }

  const escape = foundry.utils.escapeHTML ?? (s => s);
  // A bane with invocation dice (Persistent Damage's per-round roll) embeds a
  // Roll Damage button in the effect's description AND on the confirmation
  // message; both roll the dice and post an Apply Damage card targeting the
  // afflicted token (with undo) — one click per round. All rolls explode.
  const invokeRoll = invocationRollFor(bane, powerLevel);
  let rollButton = "";
  if ( invokeRoll ) {
    const damageTargets = [{ tokenUuid: actor.token?.uuid ?? actor.uuid, name: actor.name }];
    rollButton = renderInvokeRollButton("Damage", invokeRoll, bane.name, powerLevel, { damageTargets });
    const first = effectDataList[0];
    first.description = `${first.description ?? ""}<p>${rollButton}</p>`;
  }
  const createdEffects = await actor.createEmbeddedDocuments("ActiveEffect", effectDataList);

  const plText = powerLevel ? ` (PL ${powerLevel})` : "";
  const potentText = potent ? ` <span class="ol-potent-tag"><i class="fas fa-biohazard"></i> Potent</span>` : "";
  const provokerText = provoker
    ? ` Provoked by <strong>${escape(provoker.name)}</strong> — attacks not targeting them suffer disadvantage ${Math.max(1, (Number(powerLevel) || 4) - 3)}.`
    : "";
  // Undo (mirroring the damage flow): deletes exactly the effect(s) + embedded
  // bane item this apply created, and re-enables the source Apply button (found
  // in the chat log by its token + bane UUIDs, when the apply came from one).
  const undoBtn =
    `<button type="button" class="ol-undo-bane" data-actor-uuid="${escape(actor.uuid)}"`
    + ` data-effect-ids="${escape(createdEffects.map(e => e.id).join(","))}"`
    + ` data-item-id="${escape(baneItem?.id ?? "")}" data-bane-name="${escape(bane.name)}"`
    + (sourceTokenUuid ? ` data-token-uuid="${escape(sourceTokenUuid)}" data-bane-uuid="${escape(baneUuid)}"` : "")
    + `><i class="fas fa-rotate-left"></i> Undo</button>`;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="ol-bane-applied"><span class="ol-bane-row"><span class="ol-damage-text"><strong>${escape(actor.name)}</strong> is afflicted by <strong>${escape(bane.name)}</strong>${plText}.${potentText}${provokerText}</span><span class="ol-damage-actions">${undoBtn}</span></span>${rollButton}</div>`
  });
  actor.sheet?.render(false);
}

/**
 * Resolve a target token's actor by UUID and apply a bane to it. Used by the
 * chat-card "Apply Bane" button.
 * @param {string} tokenUuid
 * @param {string} baneUuid
 * @param {number} [powerLevel]
 * @param {boolean} [potent]
 * @returns {Promise<void>}
 */
export async function applyBaneByTokenUuid(tokenUuid, baneUuid, powerLevel = 0, potent = false) {
  const tokenDoc = await fromUuid(tokenUuid);
  const actor = tokenDoc?.actor ?? tokenDoc;
  if ( !actor ) {
    ui.notifications?.warn("Could not find the target to apply the bane.");
    return;
  }
  return applyBaneToActor(actor, baneUuid, powerLevel, potent, { sourceTokenUuid: tokenUuid });
}

/**
 * Undo a bane application from its confirmation chat card ("<Name> is afflicted
 * by <Bane>"): delete exactly the Active Effect(s) and embedded bane Item that
 * the apply created, and announce the reversal in chat. For a stacking-bane
 * escalation card, revert the stack to its recorded prior level instead of
 * removing the condition. Effects/items already gone (e.g. resisted or removed
 * from the sheet in the meantime) are skipped silently.
 * @param {string} actorUuid  UUID of the afflicted actor (world or token-synthetic).
 * @param {object} [opts]
 * @param {string[]} [opts.effectIds]     Ids of the ActiveEffects the apply created.
 * @param {string} [opts.itemId]          Id of the embedded bane Item the apply created.
 * @param {string} [opts.baneName]        The bane's name, for the chat note.
 * @param {string} [opts.stackEffectId]   Stacking escalation: id of the escalated effect.
 * @param {number} [opts.prevLevel]       Stacking escalation: the level to revert to.
 * @returns {Promise<void>}
 */
export async function undoBaneApply(actorUuid, { effectIds = [], itemId = "", baneName = "", stackEffectId = "", prevLevel = 0 } = {}) {
  const doc = await fromUuid(actorUuid);
  const actor = doc?.actor ?? doc;
  if ( !actor ) {
    ui.notifications?.warn("Could not find the afflicted character to undo the bane.");
    return;
  }
  // Mirror the apply permission: a GM always may; a player only on a character
  // they own (their own drag-and-drop applies).
  if ( !game.user?.isGM && !actor.isOwner ) {
    ui.notifications?.warn("Only a GM can undo a bane on that character.");
    return;
  }
  const escape = foundry.utils.escapeHTML ?? (s => s);
  // Stacking escalation: drop the stack back to its pre-click level.
  if ( stackEffectId ) {
    const effect = actor.effects.get(stackEffectId);
    if ( !effect ) {
      ui.notifications?.warn(`${baneName || "That bane"} is no longer on ${actor.name}.`);
      return;
    }
    const level = Math.max(1, Math.floor(Number(prevLevel) || 1));
    await effect.update({ "flags.openlegend.stackLevel": level });
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="ol-damage-reverted"><strong>${escape(actor.name)}</strong>'s <strong>${escape(baneName)}</strong> reverted to level <strong>${level}</strong>.</div>`
    });
    actor.sheet?.render(false);
    return;
  }
  const ids = effectIds.filter(id => actor.effects.get(id));
  if ( ids.length ) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
  if ( itemId && actor.items.get(itemId) ) await actor.deleteEmbeddedDocuments("Item", [itemId]);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="ol-damage-reverted"><strong>${escape(baneName)}</strong> removed from <strong>${escape(actor.name)}</strong> (undo).</div>`
  });
  actor.sheet?.render(false);
}

/**
 * Run an AURA's bane attack against one token (SRD: friend OR foe entering a bane
 * aura suffers a bane attack — only the aura's own target is exempt). Rolls the
 * aura owner's attacking-attribute dice vs the target's defense for the radiated
 * bane, with the owner's BANE FOCUS advantage folded into the roll, and — on a hit
 * — applies the bane (POTENT when the owner has Potent Bane for it). Posts a concise
 * chat card. GM-gated by the caller (single runner).
 * @param {object} args
 * @param {string} args.attackerActorUuid  The aura owner (supplies the dice + feats).
 * @param {string} args.attackAttr         Attribute KEY used to invoke the aura.
 * @param {string} args.targetTokenUuid    The token entering the aura.
 * @param {string} args.baneUuid           The radiated bane's uuid.
 * @param {string} args.baneName           The radiated bane's name (card text + feat match).
 * @param {number} args.powerLevel         The radiated bane's power level.
 * @param {string} [args.auraName]         The aura source label (card text).
 * @param {number} [args.itemScore]        An ITEM-invoked aura's value — when > 0 it
 *                                         supplies the attack dice instead of the
 *                                         wielder's attribute (item invocation).
 * @returns {Promise<boolean>}  Whether the attack hit (and the bane was applied).
 */
export async function auraBaneAttack({ attackerActorUuid, attackAttr, targetTokenUuid, baneUuid, baneName, powerLevel = 0, auraName = "Aura", itemScore = 0 }) {
  const cfg = CONFIG.OPENLEGEND ?? {};
  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
  const attacker = attackerActorUuid ? await fromUuid(attackerActorUuid) : null;
  const targetTok = targetTokenUuid ? await fromUuid(targetTokenUuid) : null;
  const target = targetTok?.actor ?? targetTok;
  const bane = baneUuid ? await fromUuid(baneUuid) : null;
  if ( !target || (bane?.type !== "bane") ) return false;

  // The defense the bane attacks (its first attack entry), defaulting to Guard.
  const defKey = String((bane.system?.attacks ?? [])[0]?.defense || "guard").trim().toLowerCase();
  const defValue = Number(target.system?.defenses?.[defKey]?.value);
  if ( !Number.isFinite(defValue) ) return false;

  // Bane Focus (owner feat): advantage 2 on a bane attack to inflict the focused
  // bane. Folded into the roll via buildFormula's net-advantage pool.
  const focusAdv = cfg.baneFocusAdvantage ? cfg.baneFocusAdvantage(attacker, baneName) : 0;
  // Potent Bane (owner feat): the inflicted bane is always Potent (resist at disadv 1).
  const potent = cfg.isPotentBane ? cfg.isPotentBane(attacker, baneName) : false;

  // Attack roll: 1d20x + the invoking dice — an item-invoked aura rolls the
  // ITEM's value; otherwise the attacker's attacking attribute — with Bane Focus
  // advantage applied to the pool (buildFormula handles the keep-highest math).
  const fixedScore = Math.max(0, Math.floor(Number(itemScore) || 0));
  const score = fixedScore > 0 ? fixedScore
    : Math.max(0, Math.floor(Number(attacker?.system?.attributes?.[attackAttr]?.value ?? 0)));
  const dice = cfg.diceForScore ? cfg.diceForScore(score) : "";
  const formula = buildFormula(dice, focusAdv);
  const roll = await (new Roll(formula)).evaluate();
  const hit = roll.total >= defValue;

  const defLabel = cfg.targetDefenses?.[defKey] ?? defKey;
  const focusTag = focusAdv > 0 ? ` <span class="ol-aura-feat" title="Bane Focus: advantage ${focusAdv}"><i class="fas fa-crosshairs"></i> Bane Focus</span>` : "";
  const potentTag = potent ? ` <span class="ol-aura-feat" title="Potent Bane: target resists at disadvantage 1"><i class="fas fa-biohazard"></i> Potent</span>` : "";
  const speaker = attacker ? ChatMessage.getSpeaker({ actor: attacker }) : ChatMessage.getSpeaker();
  let flavor = `<div class="ol-aura-attack"><p><i class="fas fa-circle-notch"></i> <strong>${esc(auraName)}</strong> radiates <strong>${esc(baneName)}</strong> at <strong>${esc(target.name)}</strong> — <span class="${hit ? "ol-aura-hit" : "ol-aura-miss"}">${hit ? "Hit" : "Miss"}</span> (vs ${esc(defLabel)} ${defValue}).${focusTag}${potentTag}</p></div>`;
  // SRD "on a miss": this bane attack missing offers the same deal-3 / bane
  // (PL ≤ 3) / move-10 choices as any other attack. Same NPC gate as the action
  // card (a player-facing option; the GM doesn't need it for their creatures).
  if ( !hit ) {
    const attackerIsNpc = (attacker?.type === "npc") || (attacker?.type === "boss");
    if ( !attackerIsNpc ) {
      flavor += renderMissOptions({
        rollerName: attacker?.name ?? auraName,
        actorUuid: attackerActorUuid ?? "",
        results: [{ hit: false, resistImmune: false, tokenUuid: targetTokenUuid, name: target.name }]
      });
    }
  }
  await roll.toMessage({ speaker, flavor });

  if ( hit ) await applyBaneToActor(target, baneUuid, powerLevel, potent);
  return hit;
}

/* -------------------------------------------- */

/**
 * Death Blow (feat) follow-up, run AFTER a Lethal Strike's damage was applied to a
 * target. Resolves the attacker's Death Blow tier and the target's resulting HP,
 * then:
 *   - Tier 2: automatically inflicts the Stunned bane (free — outside the usual
 *     one-bane-per-attack limit).
 *   - Either tier: if the target's current HP is ≤ the threshold (5 at T1, 10 at
 *     T2), posts a card offering "Reduce to 0 HP" (you MAY). On a target already at
 *     0 HP (this attack or otherwise), offers "Silence" (apply the Silenced bane).
 * Does nothing when the attacker lacks the feat. GM-gated by the apply flow.
 * @param {string} attackerUuid  The attacking actor's uuid (the Death Blow owner).
 * @param {string} tokenUuid     The damaged target token's uuid.
 * @returns {Promise<void>}
 */
export async function deathBlowFollowUp(attackerUuid, tokenUuid) {
  const cfg = CONFIG.OPENLEGEND ?? {};
  const attDoc = attackerUuid ? await fromUuid(attackerUuid) : null;
  const attacker = attDoc?.actor ?? attDoc;
  const db = attacker ? (cfg.deathBlow?.(attacker) ?? null) : null;
  if ( !db ) return;

  const tokenDoc = await fromUuid(tokenUuid);
  const target = tokenDoc?.actor ?? tokenDoc;
  if ( !target?.system?.health ) return;
  const escape = foundry.utils.escapeHTML ?? (s => s);

  // Tier 2: auto-inflict Stunned on a successful Lethal Strike (free, no limit).
  if ( db.autoStun && cfg.resolveBaneByName ) {
    const stunned = await cfg.resolveBaneByName("Stunned");
    if ( stunned ) await applyBaneToActor(target, stunned.uuid, Number(stunned.system?.powerLevel ?? 0), false);
  }

  const hp = Math.max(0, Math.floor(Number(target.system.health.value ?? 0)));
  const eligible = hp <= db.threshold;       // may reduce to 0
  const atZero = hp <= 0;                     // already down → may silence
  if ( !eligible && !atZero ) return;         // nothing Death Blow can offer

  // Build the options card. "Reduce to 0" shows when HP is in the threshold band
  // (and not already 0); "Silence" shows when the target is at 0 HP.
  const buttons = [];
  if ( eligible && !atZero ) {
    buttons.push(`<button type="button" class="ol-deathblow-zero ol-apply-mini" data-token-uuid="${escape(tokenUuid)}" data-attacker-uuid="${escape(attackerUuid)}" data-tooltip="Death Blow: reduce ${escape(target.name)} to 0 HP">
        <i class="fas fa-skull"></i> Reduce to 0 HP
      </button>`);
  }
  if ( atZero ) {
    buttons.push(`<button type="button" class="ol-deathblow-silence ol-apply-mini" data-token-uuid="${escape(tokenUuid)}" data-attacker-uuid="${escape(attackerUuid)}" data-tooltip="Death Blow: silence ${escape(target.name)} (apply the Silenced bane)">
        <i class="fas fa-comment-slash"></i> Silence
      </button>`);
  }
  const headline = atZero
    ? `<strong>${escape(target.name)}</strong> is at 0 HP from your Lethal Strike.`
    : `<strong>${escape(target.name)}</strong> is at <strong>${hp}</strong> HP (≤ ${db.threshold}) after your Lethal Strike.`;

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: attacker }),
    content: `<div class="ol-deathblow-card">
        <div class="ol-deathblow-head"><i class="fas fa-skull-crossbones"></i> <strong>Death Blow</strong> (Tier ${db.tier})</div>
        <div class="ol-deathblow-body">${headline}</div>
        <div class="ol-deathblow-actions">${buttons.join("")}</div>
      </div>`
  });
}

/**
 * Death Blow "Reduce to 0 HP": set the target token's actor to 0 HP (instant
 * defeat). Posts a chat note; an Undo restores the prior HP. GM / token owner only.
 * @param {string} tokenUuid
 * @returns {Promise<void>}
 */
export async function deathBlowReduceToZero(tokenUuid, attackerUuid = "") {
  const tokenDoc = await fromUuid(tokenUuid);
  const target = tokenDoc?.actor ?? tokenDoc;
  if ( !target?.system?.health ) return;
  if ( !canModifyActorHealth(target) ) {
    ui.notifications?.warn(`You don't have permission to modify ${target.name}.`);
    return;
  }
  const escape = foundry.utils.escapeHTML ?? (s => s);
  const before = Math.max(0, Math.floor(Number(target.system.health.value ?? 0)));
  if ( before <= 0 ) return;
  await target.update({ "system.health.value": 0 });
  const undoBtn =
    `<button type="button" class="ol-undo-deathblow" data-token-uuid="${escape(tokenUuid)}" data-hp="${before}">`
    + `<i class="fas fa-rotate-left"></i> Undo</button>`;
  // Reduced to 0 HP "by your attack" → offer the Death Blow silence option.
  const silenceBtn =
    `<button type="button" class="ol-deathblow-silence ol-apply-mini" data-token-uuid="${escape(tokenUuid)}" data-attacker-uuid="${escape(attackerUuid)}" data-tooltip="Death Blow: silence ${escape(target.name)} (apply the Silenced bane)">`
    + `<i class="fas fa-comment-slash"></i> Silence</button>`;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: target }),
    content: `<div class="ol-damage-applied"><span class="ol-damage-text"><strong>${escape(target.name)}</strong> is reduced to <strong>0 HP</strong> by Death Blow.<span class="ol-damage-hp"> (${before} → 0 HP)</span></span><span class="ol-damage-actions">${undoBtn} ${silenceBtn}</span></div>`
  });
  target.sheet?.render(false);
}

/**
 * Undo a Death Blow "Reduce to 0 HP" — restore the prior HP.
 * @param {string} tokenUuid
 * @param {number} hp  The HP to restore.
 * @returns {Promise<void>}
 */
export async function undoDeathBlowZero(tokenUuid, hp) {
  const tokenDoc = await fromUuid(tokenUuid);
  const target = tokenDoc?.actor ?? tokenDoc;
  if ( !target?.system?.health || !canModifyActorHealth(target) ) return;
  await target.update({ "system.health.value": Math.max(0, Math.floor(Number(hp) || 0)) });
  target.sheet?.render(false);
}

/**
 * Slaying (legendary weapon property): the GM confirmed the target is of the
 * listed creature type after a damaging hit with margin ≥ 5 — the target dies
 * immediately. Reduces it to 0 HP and posts a note with an Undo (the shared
 * ol-undo-deathblow restore-HP button). GM / token owner only.
 * @param {string} tokenUuid
 * @param {string} [creatureType]  The Slaying property's creature type (for the note).
 * @returns {Promise<void>}
 */
export async function slayingKill(tokenUuid, creatureType = "") {
  const tokenDoc = await fromUuid(tokenUuid);
  const target = tokenDoc?.actor ?? tokenDoc;
  if ( !target?.system?.health ) return;
  if ( !canModifyActorHealth(target) ) {
    ui.notifications?.warn(`You don't have permission to modify ${target.name}.`);
    return;
  }
  const escape = foundry.utils.escapeHTML ?? (s => s);
  const before = Math.max(0, Math.floor(Number(target.system.health.value ?? 0)));
  if ( before <= 0 ) return;
  await target.update({ "system.health.value": 0 });
  const undoBtn =
    `<button type="button" class="ol-undo-deathblow" data-token-uuid="${escape(tokenUuid)}" data-hp="${before}">`
    + `<i class="fas fa-rotate-left"></i> Undo</button>`;
  const typeNote = creatureType ? ` (Slaying: ${escape(creatureType)})` : " (Slaying)";
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: target }),
    content: `<div class="ol-damage-applied"><span class="ol-damage-text"><strong>${escape(target.name)}</strong> is slain${typeNote}.<span class="ol-damage-hp"> (${before} → 0 HP)</span></span><span class="ol-damage-actions">${undoBtn}</span></div>`
  });
  target.sheet?.render(false);
}

/**
 * Death Blow "Silence": apply the Silenced bane to a target reduced to 0 HP.
 * @param {string} tokenUuid
 * @returns {Promise<void>}
 */
export async function deathBlowSilence(tokenUuid) {
  const cfg = CONFIG.OPENLEGEND ?? {};
  const silenced = cfg.resolveBaneByName ? await cfg.resolveBaneByName("Silenced") : null;
  if ( !silenced ) {
    ui.notifications?.warn("Could not find the Silenced bane.");
    return;
  }
  return applyBaneByTokenUuid(tokenUuid, silenced.uuid, Number(silenced.system?.powerLevel ?? 0), false);
}

/**
 * Crushing Blow "Knock down": apply the Knockdown bane to a target the attacker
 * pushed via Overpowering Strike (resolved + applied where the forced move ends).
 * @param {string} tokenUuid
 * @returns {Promise<void>}
 */
export async function crushingKnockdown(tokenUuid) {
  const cfg = CONFIG.OPENLEGEND ?? {};
  const knockdown = cfg.resolveBaneByName ? await cfg.resolveBaneByName("Knockdown") : null;
  if ( !knockdown ) {
    ui.notifications?.warn("Could not find the Knockdown bane.");
    return;
  }
  return applyBaneByTokenUuid(tokenUuid, knockdown.uuid, Number(knockdown.system?.powerLevel ?? 0), false);
}

/**
 * Apply a bane to the token at a canvas point (used by the bane drag handle's
 * drop and the legacy compendium-drop path). Finds the token by hit-test.
 * Power level defaults to null → applyBaneToActor prompts for it; the chat-card
 * handle passes the achieved level to skip the prompt.
 * @param {string} baneUuid
 * @param {number} x  Canvas x.
 * @param {number} y  Canvas y.
 * @param {number|null} [powerLevel]
 * @returns {Promise<void>}
 */
export async function applyBaneToTokenAt(baneUuid, x, y, powerLevel = null, potent = false) {
  const token = canvas.tokens?.placeables.find(t => {
    const b = t.bounds;
    return b && (x >= b.x) && (x <= b.x + b.width) && (y >= b.y) && (y <= b.y + b.height);
  });
  if ( !token?.actor ) {
    ui.notifications?.warn("Drop the bane directly onto a token to apply it.");
    return;
  }
  return applyBaneToActor(token.actor, baneUuid, powerLevel, potent);
}

/* -------------------------------------------- */

/**
 * Build ActiveEffect creation data for a boon granted at a power level — a
 * leveled condition mirroring {@link baneActiveEffectData}: the boon's own
 * embedded Active Effects cloned at the granted level, falling back to its
 * "advantage N" game effects.
 * @param {Item} boon
 * @param {number} [powerLevel]  Granted power level (activates change rows whose level ≤ it).
 * @returns {object[]} ActiveEffect creation data (one entry per embedded effect; at least one).
 */
export function boonActiveEffectData(boon, powerLevel = 0) {
  return leveledEffectData(boon, powerLevel, {
    kind: "advantage",
    sourceFlag: "fromBoon",
    defaultImg: "icons/svg/aura.svg"
  });
}

/**
 * Shared builder for leveled bane/boon condition effects.
 *
 * Preferred source: the item's OWN embedded Active Effects — exactly what its
 * sheet's Effects tab lists and edits (the compendium packs seed one per
 * bane/boon, and users can author their own). Each is cloned with the invoked
 * power level stamped into flags.openlegend.powerLevel; its per-row levels
 * (flags.openlegend.changeLevels) come along verbatim, so at any power level
 * OpenLegendActiveEffect applies only the strongest row per key the level
 * unlocks, and stepping the power level re-scales the condition in place.
 *
 * Fallback (item has no embedded effects, e.g. hand-made before authoring
 * any): synthesize the same shape from the item's actionable game effects.
 * @param {Item} source       The bane or boon item.
 * @param {number} powerLevel The invoked / granted power level.
 * @param {object} opts
 * @param {"advantage"|"disadvantage"} opts.kind  Which game effects are actionable (fallback only).
 * @param {string} opts.sourceFlag                "fromBane" | "fromBoon".
 * @param {string} opts.defaultImg                Fallback effect icon.
 * @returns {object[]} ActiveEffect creation data (always at least one entry).
 */
/**
 * Highest stack tier a stacking condition defines = the maximum per-row Level
 * (flags.openlegend.changeLevels). Re-applying caps at this. Falls back to 1.
 * @param {ActiveEffect} effect
 * @returns {number}
 */
export function stackingMax(effect) {
  // An explicit ceiling (flags.openlegend.stackMax) wins — it lets a condition
  // escalate to levels that have no mechanical change row of their own (e.g.
  // Fatigued Levels 5–6 are narrative: unconscious, then death).
  const explicit = Math.floor(Number(effect?.flags?.openlegend?.stackMax) || 0);
  if ( explicit > 0 ) return explicit;
  const levels = (effect?.flags?.openlegend?.changeLevels ?? [])
    .map(Number).filter(n => Number.isFinite(n) && (n > 0));
  return levels.length ? Math.max(...levels) : 1;
}

function leveledEffectData(source, powerLevel, { kind, sourceFlag, defaultImg }) {
  const pl = Math.max(0, Math.floor(Number(powerLevel) || 0));
  const name = pl ? `${source.name} PL ${pl}` : source.name;
  // The source bane/boon's own description, prepended to the applied effect's
  // notes so the token's condition explains what it is (the invocation-roll
  // link, if any, is appended after this by applyBane/BoonToActor).
  const sourceDesc = String(source.system?.description ?? "").trim();

  // Disabled effects are authoring drafts — skip them (all-disabled falls back).
  const embedded = (source.effects?.contents ?? []).filter(e => !e.disabled);
  if ( embedded.length ) {
    return embedded.map((e, i) => {
      const data = e.toObject();
      delete data._id;
      data.name = name;
      data.img = data.img || source.img || defaultImg;
      data.disabled = false;
      // The clone IS the applied condition; never re-transfer.
      data.transfer = false;
      // Always render this effect's icon on the token (not just when temporary).
      data.showIcon = 2; /* CONST.ACTIVE_EFFECT_SHOW_ICON.ALWAYS */
      // Lead the primary effect's notes with the bane/boon description.
      if ( (i === 0) && sourceDesc ) data.description = `${sourceDesc}${data.description ?? ""}`;
      data.flags ??= {};
      data.flags.openlegend = { ...(data.flags.openlegend ?? {}), [sourceFlag]: source.name, powerLevel: pl };
      // A stacking condition (e.g. Fatigued) starts at stack level 1 — its tier
      // axis is separate from power level (see OpenLegendActiveEffect.isChangeActive).
      // Re-applying the bane increments this (applyBaneToActor), not powerLevel.
      // Its name reflects the stack, not the PL.
      if ( data.flags.openlegend.stacking ) {
        data.flags.openlegend.stackLevel = 1;
        data.name = `${source.name} Level 1`;
      }
      return data;
    });
  }

  // Fallback: one change row per actionable game effect; advantage /
  // disadvantage map to the roll-modifier flags the roll dialog reads
  // (attack-scoped or general).
  const entries = (source.system?.gameEffects ?? []).filter(g => g.kind === kind);
  const changes = entries.map(g => {
    const attack = g.scope === "attack-rolls";
    const key = kind === "advantage"
      ? (attack ? "flags.openlegend.advantageAttack" : "flags.openlegend.advantage")
      : (attack ? "flags.openlegend.disadvantageAttack" : "flags.openlegend.disadvantage");
    return { key, type: "add", value: String(g.value ?? 1), priority: 20 };
  });
  const changeLevels = entries.map(g => Math.max(0, Math.floor(Number(g.powerLevel) || 0)));

  return [{
    name,
    img: source.img || defaultImg,
    disabled: false,
    description: sourceDesc,
    system: { changes },
    showIcon: 2 /* CONST.ACTIVE_EFFECT_SHOW_ICON.ALWAYS */,
    flags: { openlegend: { [sourceFlag]: source.name, powerLevel: pl, changeLevels } }
  }];
}

/**
 * Grant a boon to an actor: embed the boon item (keeping its full data) and add
 * a derived Active Effect at the given power level directly on the actor (so it
 * shows in the Effects tab regardless of compendium effect-storage quirks).
 * Posts a confirmation chat message. GM only. Mirrors {@link applyBaneToActor}.
 *
 * Power level: pass an explicit number to skip the prompt (chat-card buttons
 * pass the achieved level); pass null/undefined to prompt the user
 * (drag-to-token / drag-to-sheet). A dismissed prompt cancels the grant.
 * @param {Actor} actor       The recipient actor.
 * @param {string} boonUuid   The boon Item's UUID.
 * @param {number|null} [powerLevel]
 * @returns {Promise<void>}
 */
export async function applyBoonToActor(actor, boonUuid, powerLevel = null, { aura = null, fromAura = "", barrier = null, resistanceType = null, rollCtx = null } = {}) {
  if ( !actor ) return;
  // A GM can grant to anyone; a player may grant only to a character they own
  // (e.g. dropping a boon onto their own sheet).
  if ( !game.user?.isGM && !actor.isOwner ) {
    ui.notifications?.warn("Only a GM can grant a boon to that character.");
    return;
  }
  const boon = await fromUuid(boonUuid);
  if ( boon?.type !== "boon" ) {
    ui.notifications?.warn("That is not a boon.");
    return;
  }
  // Nullify cancelation (SRD): a canceled boon "cannot benefit ... or be invoked
  // upon them for 1 minute". A still-running blocker effect remembering this
  // boon (flags.openlegend.blocksBoon, applied by promptNullifyRemoval) refuses
  // the grant. An expired blocker (duration run out but not yet cleaned up) or a
  // disabled one does not block.
  const blocker = actor.effects.find(e => {
    if ( e.disabled ) return false;
    if ( (e.flags?.openlegend?.blocksBoon ?? "") !== boon.name ) return false;
    const remaining = e.duration?.remaining;
    return !(Number.isFinite(remaining) && (remaining <= 0));
  });
  if ( blocker ) {
    const escapeB = foundry.utils.escapeHTML ?? (s => s);
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="ol-boon-applied"><strong>${escapeB(boon.name)}</strong> was nullified on <strong>${escapeB(actor.name)}</strong> — it cannot benefit them or be invoked upon them until the cancelation ends (1 minute).</div>`
    });
    return;
  }

  // Restoration is INSTANTANEOUS: like Nullify, no boon effect is written to the
  // target. Its whole effect is curing banes — every bane of PL ≤ the invoked
  // level outright, and optionally higher-PL banes checked against CR 20 + 2 ×
  // the bane's PL (see promptRestorationDispel; a Boon Focus auto-success rolls
  // fresh for those, with the feat's advantage).
  if ( boon.name === "Restoration" ) {
    if ( powerLevel == null ) {
      powerLevel = await promptInvocationPowerLevel(boon);
      if ( powerLevel == null ) return; // dismissed
    }
    await promptRestorationDispel(actor, powerLevel, rollCtx);
    actor.sheet?.render(false);
    return;
  }

  // An INSTANTANEOUS dice boon (Heal): granting it leaves nothing on the target.
  // Roll its dice at the invoked level immediately and post an Apply Healing card
  // (with undo) bound to the granted target — mirroring the action card, which
  // offers a "Roll Healing" button instead of a Grant for these boons. Boons that
  // are instantaneous but diceless are handled by their own branches above
  // (Restoration) or fall through to the normal grant.
  if ( /instant/i.test(String(boon.system?.duration ?? "")) ) {
    if ( powerLevel == null ) {
      powerLevel = await promptInvocationPowerLevel(boon);
      if ( powerLevel == null ) return; // dismissed
    }
    const invokeRoll = invocationRollFor(boon, powerLevel);
    if ( invokeRoll ) {
      const escapeH = foundry.utils.escapeHTML ?? (s => s);
      const roll = await (new Roll(invokeRoll.formula)).evaluate();
      const healTargets = [{ tokenUuid: actor.token?.uuid ?? actor.uuid, name: actor.name }];
      let flavor = `${escapeH(boon.name)}${powerLevel ? ` PL ${powerLevel}` : ""} — ${escapeH(invokeRoll.text || "Healing")}`;
      flavor += renderHealApplyButtons(healTargets, roll.total);
      await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor });
      return;
    }
  }
  // Only one copy of a boon per character (boons don't stack). If already granted,
  // don't add a second — report the existing one and stop. EXCEPTION: re-applying
  // Invisible / Concealment re-opens the who-can-see picker and UPDATES the
  // existing condition's allow-list (the sanctioned way to change it).
  const isInvisibility = ["invisible", "concealment"].includes(String(boon.name).trim().toLowerCase());
  const alreadyBoon = actor.effects.find(e => e.flags?.openlegend?.fromBoon === boon.name);
  if ( alreadyBoon ) {
    const escape0 = foundry.utils.escapeHTML ?? (s => s);
    if ( isInvisibility ) {
      const allow = await promptVisibilityAllowList(actor, boon.name,
        alreadyBoon.flags?.openlegend?.visibilityAllow ?? null);
      if ( allow === null ) return; // dismissed → keep the current list
      await alreadyBoon.update({ "flags.openlegend.visibilityAllow": allow });
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="ol-boon-applied"><strong>${escape0(boon.name)}</strong>: updated who can see <strong>${escape0(actor.name)}</strong>.</div>`
      });
      return;
    }
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="ol-boon-applied"><strong>${escape0(actor.name)}</strong> already has the benefit of <strong>${escape0(boon.name)}</strong>.</div>`
    });
    return;
  }
  // No explicit level (a drop) → ask which power level to invoke at.
  if ( powerLevel == null ) {
    powerLevel = await promptInvocationPowerLevel(boon);
    if ( powerLevel == null ) return; // dismissed
  }
  const effectDataList = boonActiveEffectData(boon, powerLevel);

  // Light boon: the bearer's token shines while the condition lasts — radius =
  // the granted POWER LEVEL × 5' (no extra prompt; the PL is already known or
  // was just asked for above). The radius is stamped on the applied effect
  // (flags.openlegend.lightRadius); create/delete hooks in openlegend.mjs swap
  // the token's light config and restore the original when the condition ends.
  if ( String(boon.name).trim().toLowerCase() === "light" ) {
    const radius = Math.max(5, Math.floor(Number(powerLevel) || 0) * 5);
    const first = effectDataList[0];
    first.flags ??= {};
    first.flags.openlegend = { ...(first.flags.openlegend ?? {}), lightRadius: radius };
  }

  // Detection boon: the invoker chooses WHICH phenomenon is sensed (holy /
  // unholy / life / death / magic). The choice is stamped on the condition
  // (flags.openlegend.detection); while borne, the bearer's player sees the
  // matching GM-placed "Detection Aura" glows on tokens (drawDetectionGlow).
  // Resolved BEFORE anything is written, so a cancelled prompt applies nothing.
  if ( String(boon.name).trim().toLowerCase() === "detection" ) {
    const choice = await promptDetectionType(boon.name);
    if ( !choice ) return; // dismissed
    const first = effectDataList[0];
    first.name = `${boon.name} (${choice.label})${powerLevel ? ` PL ${powerLevel}` : ""}`;
    first.flags ??= {};
    first.flags.openlegend = { ...(first.flags.openlegend ?? {}), detection: choice.key };
  }

  // Invisible / Concealment: pick WHO may still see the bearer's token. The
  // allow-list rides on the condition (flags.openlegend.visibilityAllow); the
  // token subclass hides the token from every other player's client (the GM
  // always sees it). Re-applying the boon later re-opens this picker to update
  // the list. Resolved BEFORE anything is written (cancel = no grant).
  if ( isInvisibility ) {
    const allow = await promptVisibilityAllowList(actor, boon.name);
    if ( allow === null ) return; // dismissed
    const first = effectDataList[0];
    first.flags ??= {};
    first.flags.openlegend = { ...(first.flags.openlegend ?? {}), visibilityAllow: allow };
  }

  // A boon whose subject is chosen at drop time (e.g. Bolster) prompts for an
  // attribute, then its placeholder change keys are rewritten to attr.<chosen>.
  // Done BEFORE anything is written, so a cancelled prompt applies nothing.
  const needsAttr = effectDataList.some(d => d.flags?.openlegend?.promptSubject === "attribute");
  let chosenAttrLabel = "";
  if ( needsAttr ) {
    const attrKey = await promptAttributeSubject(boon.name);
    if ( !attrKey ) return; // dismissed
    applyChosenAttribute(effectDataList, attrKey);
    chosenAttrLabel = CONFIG.OPENLEGEND?.attributeLabels?.[attrKey] ?? attrKey;
  }

  // Resistance boon: the invoker chooses one damage type the bearer resists. The
  // choice (+ the granted power level) is stamped onto the applied effect so a
  // later attack of that type is resisted (defense +3/+6/+9, immune at PL9) — see
  // OPENLEGEND.resistanceBoon / damageResistance, read at attack-resolution time.
  // Resolved BEFORE anything is written so a cancelled prompt applies nothing.
  const cfgR = CONFIG.OPENLEGEND ?? {};
  const isResistance = String(boon.name).trim().toLowerCase()
    === String(cfgR.RESISTANCE_BOON_NAME ?? "resistance").toLowerCase();
  let resistanceChoice = null;
  if ( isResistance ) {
    if ( resistanceType ) {
      // Pre-supplied (e.g. an aura radiating Resistance): resolve key → label.
      const labels = cfgR.allDamageTypes ? cfgR.allDamageTypes() : (cfgR.damageTypes ?? {});
      const key = String(resistanceType);
      resistanceChoice = { key, label: labels[key] ?? key };
    } else if ( !fromAura ) {
      // Interactive grant (drop / chat-card / action): prompt for the type.
      resistanceChoice = await promptDamageTypeSubject(boon.name);
      if ( !resistanceChoice ) return; // dismissed
    }
    // Aura radiation with no pre-supplied type: apply with no resistance marker
    // (no defense bonus) rather than spawning a dialog per entering ally.
  }

  // Barrier: resolve the chosen properties + Baneful bane. Pre-supplied `barrier`
  // (from the action's Grant button) skips the prompt; a bare drop prompts for them.
  // Resolved BEFORE the Item embed so a cancelled prompt applies nothing.
  const cfg2 = CONFIG.OPENLEGEND ?? {};
  const isBarrier = String(boon.name).trim().toLowerCase()
    === String(cfg2.BARRIER_BOON_NAME ?? "barrier").toLowerCase();
  let barrierData = barrier;
  if ( isBarrier && !barrierData ) {
    barrierData = await promptBarrierProperties(boon, actor, powerLevel);
    if ( barrierData == null ) return; // dismissed
  }

  const escape = foundry.utils.escapeHTML ?? (s => s);
  // A boon with invocation dice (Regeneration's per-turn healing) embeds a Roll
  // Healing button in the effect's description AND on the confirmation message;
  // both roll the dice and post an Apply Healing card targeting the recipient
  // (with undo) — one click per turn. All rolls explode.
  const invokeRoll = invocationRollFor(boon, powerLevel);
  let rollButton = "";
  if ( invokeRoll ) {
    const healTargets = [{ tokenUuid: actor.token?.uuid ?? actor.uuid, name: actor.name }];
    rollButton = renderInvokeRollButton("Healing", invokeRoll, boon.name, powerLevel, { healTargets });
    const first = effectDataList[0];
    first.description = `${first.description ?? ""}<p>${rollButton}</p>`;
  }
  // Barrier: note the chosen properties on the effect description (shown in the
  // effects panel) and, if Damaging was chosen, append a re-clickable Damage roll
  // button to BOTH the effect description and the grant chat card (the chat card's
  // button is the one that's wired + persistent — see renderChatMessageHTML).
  if ( isBarrier && barrierData ) {
    const note = renderBarrierNote(barrierData);
    if ( note ) {
      const first = effectDataList[0];
      first.description = `${first.description ?? ""}${note}`;
    }
    const props = String(barrierData.properties ?? "").split(",").map(s => s.trim());
    if ( props.includes("damaging") && barrierData.damageDie ) {
      const die = String(barrierData.damageDie);
      const exploding = die.replace(/(\d+d\d+)/gi, "$1x");
      const damageTargets = []; // applied to current target/selection from the card
      const barrierRoll = { formula: exploding, dice: die, text: `Barrier Damage (${die})` };
      rollButton += renderInvokeRollButton("Damage", barrierRoll, boon.name, powerLevel, { damageTargets });
    }
  }
  // Aura: stamp the radiate metadata onto the granted Aura effect so the live-aura
  // engine (module/canvas/aura.mjs) can render the ring and radiate to nearby
  // tokens. `fromAura` marks a boon an aura GRANTED to an ally (so it's auto-
  // removed on leaving, never confused with a self-invoked boon).
  if ( effectDataList.length ) {
    const f = effectDataList[0];
    f.flags = f.flags ?? {};
    f.flags.openlegend = f.flags.openlegend ?? {};
    if ( aura ) f.flags.openlegend.aura = aura;
    if ( fromAura ) f.flags.openlegend.fromAura = fromAura;
    if ( isBarrier && barrierData ) f.flags.openlegend.barrier = barrierData;
    // Resistance: stamp the chosen damage type + power level so the resolve-time
    // lookup can raise the bearer's defense against attacks of that type.
    if ( isResistance && resistanceChoice ) {
      f.flags.openlegend.resistance = {
        damageType: resistanceChoice.key,
        damageTypeLabel: resistanceChoice.label,
        powerLevel: Math.max(0, Math.floor(Number(powerLevel) || 0))
      };
      const { defenseBonus, immune } = cfgR.resistanceBoonBonus
        ? cfgR.resistanceBoonBonus(powerLevel) : { defenseBonus: 0, immune: false };
      const effectText = immune
        ? `Immune to <strong>${escape(resistanceChoice.label)}</strong> damage and harmful effects`
        : `Defenses +${defenseBonus} against <strong>${escape(resistanceChoice.label)}</strong> attacks`;
      f.description = `${f.description ?? ""}<div class="ol-resistance-note"><i class="fas fa-shield-halved"></i> ${effectText}.</div>`;
    }
  }
  await actor.createEmbeddedDocuments("ActiveEffect", effectDataList);

  const plText = powerLevel ? ` (PL ${powerLevel})` : "";
  const attrText = chosenAttrLabel ? ` on <strong>${escape(chosenAttrLabel)}</strong>` : "";
  const resistText = resistanceChoice ? ` against <strong>${escape(resistanceChoice.label)}</strong>` : "";
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="ol-boon-applied"><strong>${escape(actor.name)}</strong> gains the benefit of <strong>${escape(boon.name)}</strong>${attrText}${resistText}${plText}.${rollButton}</div>`
  });
  actor.sheet?.render(false);
}

/**
 * Resolve a target token's actor by UUID and grant a boon to it. Used by the
 * chat-card "Grant Boon" button. Mirrors {@link applyBaneByTokenUuid}.
 * @param {string} tokenUuid
 * @param {string} boonUuid
 * @param {number} [powerLevel]
 * @returns {Promise<void>}
 */
export async function applyBoonByTokenUuid(tokenUuid, boonUuid, powerLevel = 0, opts = {}) {
  const tokenDoc = await fromUuid(tokenUuid);
  const actor = tokenDoc?.actor ?? tokenDoc;
  if ( !actor ) {
    ui.notifications?.warn("Could not find the target to grant the boon.");
    return;
  }
  return applyBoonToActor(actor, boonUuid, powerLevel, opts);
}

/**
 * Grant a boon to the token at a canvas point (used by the boon drag handle's
 * drop and the compendium-drop path). Finds the token by hit-test. Mirrors
 * {@link applyBaneToTokenAt}. Power level defaults to null → applyBoonToActor
 * prompts for it; the chat-card handle passes the achieved level to skip it.
 * @param {string} boonUuid
 * @param {number} x  Canvas x.
 * @param {number} y  Canvas y.
 * @param {number|null} [powerLevel]
 * @returns {Promise<void>}
 */
export async function applyBoonToTokenAt(boonUuid, x, y, powerLevel = null) {
  const token = canvas.tokens?.placeables.find(t => {
    const b = t.bounds;
    return b && (x >= b.x) && (x <= b.x + b.width) && (y >= b.y) && (y <= b.y + b.height);
  });
  if ( !token?.actor ) {
    ui.notifications?.warn("Drop the boon directly onto a token to grant it.");
    return;
  }
  return applyBoonToActor(token.actor, boonUuid, powerLevel);
}

/**
 * Apply a standalone "effect" item to an actor: clone every ENABLED embedded
 * Active Effect onto the actor, as-is (no power-level prompt — an effect item
 * carries plain effects, unlike leveled bane/boon conditions). Each clone keeps
 * its authored name/changes, never re-transfers, always shows its token icon,
 * and is flagged with its source item's name (flags.openlegend.fromEffectItem)
 * so it reads as a condition-like marker rather than an item copy.
 * @param {Actor} actor
 * @param {string} itemUuid  UUID of the "effect" item (compendium or world).
 * @returns {Promise<void>}
 */
export async function applyEffectItemToActor(actor, itemUuid) {
  const item = await fromUuid(itemUuid).catch(() => null);
  if ( !actor || (item?.type !== "effect") ) return;
  const embedded = (item.effects?.contents ?? []).filter(e => !e.disabled);
  if ( !embedded.length ) {
    ui.notifications?.warn(`${item.name} has no enabled Active Effects to apply.`);
    return;
  }
  const sourceDesc = String(item.system?.description ?? "").trim();
  const data = embedded.map(e => {
    const d = e.toObject();
    delete d._id;
    d.img = d.img || item.img;
    d.disabled = false;
    d.transfer = false;
    // Always show the token icon — unless the effect was AUTHORED as hidden
    // (showIcon NEVER, e.g. the GM-only Detection Aura markers stay invisible).
    if ( d.showIcon !== 0 ) d.showIcon = 2; /* CONST.ACTIVE_EFFECT_SHOW_ICON.ALWAYS */
    if ( !d.description && sourceDesc ) d.description = sourceDesc;
    d.flags ??= {};
    d.flags.openlegend = { ...(d.flags.openlegend ?? {}), fromEffectItem: item.name };
    return d;
  });
  await actor.createEmbeddedDocuments("ActiveEffect", data);
  ui.notifications?.info(`${item.name} applied to ${actor.name}.`);
}

/**
 * Apply an "effect" item to the token at a canvas point (the sidebar/compendium
 * drop path). Finds the token by hit-test, mirroring {@link applyBaneToTokenAt}.
 * @param {string} itemUuid
 * @param {number} x  Canvas x.
 * @param {number} y  Canvas y.
 * @returns {Promise<void>}
 */
export async function applyEffectItemToTokenAt(itemUuid, x, y) {
  const token = canvas.tokens?.placeables.find(t => {
    const b = t.bounds;
    return b && (x >= b.x) && (x <= b.x + b.width) && (y >= b.y) && (y <= b.y + b.height);
  });
  if ( !token?.actor ) {
    ui.notifications?.warn("Drop the effect directly onto a token to apply it.");
    return;
  }
  return applyEffectItemToActor(token.actor, itemUuid);
}

/**
 * Create (or reuse) a hotbar macro that rolls the given action item, and assign
 * it to the requested slot. Intended to be called from the `hotbarDrop` hook.
 *
 * The macro resolves the action by UUID at execution time via the system API
 * (`game.openlegend.rollActionByUuid`), so it keeps working as the actor's state
 * changes. An identical macro (same command) is reused rather than duplicated.
 *
 * @param {Item} action      The dropped action item (must be owned by an actor).
 * @param {number|string} slot  The hotbar slot to assign to.
 * @returns {Promise<Macro|void>}
 */
export async function createActionMacro(action, slot) {
  if ( !action || (action.type !== "action") ) return;
  if ( !action.uuid || !(action.actor ?? action.parent) ) {
    ui.notifications?.warn("Only an actor's action can be dropped onto the hotbar.");
    return;
  }
  const command = `game.openlegend.rollActionByUuid("${action.uuid}");`;
  const existing = game.macros.find(m => (m.name === action.name) && (m.command === command));
  const macro = existing ?? await Macro.implementation.create({
    name: action.name,
    type: "script",
    img: action.img,
    command,
    flags: { openlegend: { actionMacro: true } }
  });
  if ( !macro ) return;
  await game.user.assignHotbarMacro(macro, slot);
  return macro;
}

/**
 * Create (or reuse) a hotbar macro that applies a bane/boon — built when a chat
 * invocation chip is dropped on the hotbar. The macro applies to the user's
 * targeted token (a bane) / first controlled token (a boon) at apply time via
 * {@link applyInvocationByUuid}.
 * @param {object} data   The drag payload ({type, baneUuid|boonUuid, powerLevel}).
 * @param {number} slot   The hotbar slot.
 * @returns {Promise<Macro|void>}
 */
export async function createInvocationMacro(data, slot) {
  const kind = (data.type === "openlegend.bane") ? "bane" : "boon";
  const uuid = (kind === "bane") ? data.baneUuid : data.boonUuid;
  if ( !uuid ) return;
  const pl = Math.max(0, Math.floor(Number(data.powerLevel) || 0));
  const potent = (kind === "bane") && !!data.potent;
  const doc = await fromUuid(uuid);
  const name = `${doc?.name ?? (kind === "bane" ? "Bane" : "Boon")}${pl ? ` (PL ${pl})` : ""}${potent ? " Potent" : ""}`;
  const command = `game.openlegend.applyInvocationByUuid("${kind}", "${uuid}", ${pl}, ${potent});`;
  const existing = game.macros.find(m => (m.name === name) && (m.command === command));
  const macro = existing ?? await Macro.implementation.create({
    name,
    type: "script",
    img: doc?.img ?? (kind === "bane" ? "icons/svg/terror.svg" : "icons/svg/aura.svg"),
    command,
    flags: { openlegend: { invocationMacro: true } }
  });
  if ( !macro ) return;
  await game.user.assignHotbarMacro(macro, slot);
  return macro;
}

/**
 * Apply a bane/boon (by uuid + power level) to the relevant token: a bane to each
 * TARGETED token (banes afflict targets), a boon to each CONTROLLED token (or the
 * user's character). The system API entry point used by invocation hotbar macros.
 * @param {"bane"|"boon"} kind
 * @param {string} uuid
 * @param {number} [powerLevel]
 * @param {boolean} [potent]  Mark an applied bane Potent (resists at disadvantage 1).
 * @returns {Promise<void>}
 */
export async function applyInvocationByUuid(kind, uuid, powerLevel = 0, potent = false) {
  const pl = Math.max(0, Math.floor(Number(powerLevel) || 0));
  if ( kind === "bane" ) {
    const targets = [...(game.user?.targets ?? [])];
    if ( !targets.length ) { ui.notifications?.warn("Target a token to afflict with the bane."); return; }
    for ( const t of targets ) if ( t.actor ) await applyBaneToActor(t.actor, uuid, pl, potent);
    return;
  }
  const recipients = (canvas?.tokens?.controlled ?? []).map(t => t.actor).filter(Boolean);
  if ( !recipients.length && game.user?.character ) recipients.push(game.user.character);
  if ( !recipients.length ) { ui.notifications?.warn("Select a token to grant the boon to."); return; }
  for ( const a of recipients ) await applyBoonToActor(a, uuid, pl);
}

/**
 * Resolve an action item by UUID and roll it. The system API entry point used by
 * generated hotbar macros.
 * @param {string} uuid  The action item's UUID (e.g. "Actor.x.Item.y").
 * @returns {Promise<ChatMessage|void>}
 */
export async function rollActionByUuid(uuid) {
  const action = await fromUuid(uuid);
  if ( !action ) {
    ui.notifications?.warn("The action this macro points to no longer exists.");
    return;
  }
  return rollAction(action);
}

/* -------------------------------------------- */
/*  Attribute roll (sheet button + hotbar macro)  */
/* -------------------------------------------- */

/**
 * Roll a plain attribute action: open the roll dialog (advantage/disadvantage,
 * itemized sources), then post the result. Shared by the Attributes-tab roll button
 * and the hotbar macro it can be dragged to, so both behave identically — including
 * the Skill Specialization advantage and Active-Effect modifiers.
 * @param {Actor} actor
 * @param {string} key                The attribute key (e.g. "agility").
 * @param {object} [opts]
 * @param {boolean} [opts.substituted] Roll the SUBSTITUTED dice (the locked row of a
 *                                     substituted attribute) instead of the own dice.
 * @returns {Promise<ChatMessage|void>}
 */
export async function rollActorAttribute(actor, key, { substituted = false } = {}) {
  const attr = actor?.system?.attributes?.[key];
  if ( !attr ) {
    ui.notifications?.warn("That attribute no longer exists on this actor.");
    return;
  }
  // A mount/vehicle at its damage threshold is DISABLED — unable to act until
  // healed or repaired (lower its damage level on the sheet to override).
  if ( CONFIG.OPENLEGEND?.mountDisabled?.(actor) ) {
    ui.notifications?.warn(`${actor.name} is disabled (damage level at its damage threshold) and cannot act until repaired.`);
    return;
  }
  const cfg = CONFIG.OPENLEGEND ?? {};
  const bonusDice = (substituted ? attr.subDice : attr.dice) || "";
  const baseLabel = attr.label ?? key;
  const label = substituted ? `${baseLabel} (substituted)` : baseLabel;

  // General-roll Active Effect modifiers (banes/boons) seed the dialog, itemized.
  const sources = actorRollModifiers(actor, { attribute: key });
  // Skill Specialization (feat): advantage 1 per tier on a plain attribute check with
  // the chosen attribute (excludes attacks/invocations/defends/initiative, which are
  // separate roll paths).
  const skillSpec = cfg.skillSpecializationAdvantage?.(actor, key) ?? 0;
  if ( skillSpec > 0 ) sources.push({ label: `Skill Specialization (${baseLabel})`, advantage: skillSpec });

  // Sworn Enemy (feat): on a MENTAL attribute roll (Learning/Logic/Perception/Will),
  // offer one opt-in toggle per chosen group — checking it adds advantage equal to
  // that group's tier (the roll must "pertain" to the group, a narrative call).
  const swornGroups = (cfg.isMentalAttribute?.(key))
    ? (cfg.swornEnemyGroups?.(actor) ?? []) : [];
  const extraToggles = swornGroups.map((g, i) => ({
    name: `sworn-${i}`,
    label: `Sworn Enemy: ${g.label} (advantage ${g.tier})`,
    title: `Sworn Enemy — advantage ${g.tier} when this ${baseLabel} roll pertains to ${g.label}.`,
    advantage: g.tier,
    checked: false
  }));

  // Well-Rounded (feat): advantage 1 on an OUT-OF-COMBAT action roll using an
  // attribute scored ≤ 2 (this attribute-check path is never a bane/boon invocation,
  // so that condition is already met). The score used is the row's score (own for the
  // normal row, substituted for the locked row). Out of combat it auto-applies; in an
  // active combat it's an opt-in toggle (a roll the GM rules is non-combat).
  const wrScore = substituted
    ? Number(attr.value ?? attr.ownValue ?? 0)
    : Number(attr.ownValue ?? attr.value ?? 0);
  const wellRounded = cfg.wellRoundedApplies?.(actor, wrScore) ?? false;
  const inCombat = cfg.actorInActiveCombat?.(actor) ?? false;
  if ( wellRounded && !inCombat ) {
    sources.push({ label: `Well-Rounded (${baseLabel} ${wrScore}, out of combat)`, advantage: 1 });
  } else if ( wellRounded && inCombat ) {
    extraToggles.push({
      name: "wellRounded",
      label: `Well-Rounded (advantage 1)`,
      title: `Well-Rounded — advantage 1 when this ${baseLabel} (${wrScore}) roll is made outside of combat.`,
      advantage: 1,
      checked: false
    });
  }

  const choice = await openRollDialog({ title: `${label} Action`, bonusDice, sources, extraToggles, legend: cfg.legendSpendContext?.(actor) });
  if ( !choice ) return;

  const roll = await (new Roll(choice.formula, actor.getRollData())).evaluate();
  await cfg.spendLegendPoints?.(actor, choice.legendPoints);
  let advText = "";
  if ( choice.net > 0 ) advText = ` — ${choice.net} Advantage`;
  else if ( choice.net < 0 ) advText = ` — ${Math.abs(choice.net)} Disadvantage`;
  // Note which Sworn Enemy group(s) the player engaged, for table transparency.
  const swornEngaged = swornGroups.filter((g, i) => choice[`sworn-${i}`]).map(g => g.label);
  const swornText = swornEngaged.length ? ` (Sworn Enemy: ${swornEngaged.join(", ")})` : "";
  const wrText = (wellRounded && (choice.wellRounded || !inCombat)) ? " (Well-Rounded)" : "";
  const lpText = choice.legendPoints > 0 ? ` (Legend Points: ${choice.legendPoints})` : "";
  return roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: `${label} Action${advText}${swornText}${wrText}${lpText}`
  });
}

/**
 * Roll a plain attribute for the actor a hotbar macro points to (by uuid). The system
 * API entry point used by attribute hotbar macros.
 * @param {string} actorUuid
 * @param {string} key                The attribute key.
 * @param {boolean} [substituted]     Roll the substituted dice.
 * @returns {Promise<ChatMessage|void>}
 */
export async function rollAttributeByActorUuid(actorUuid, key, substituted = false) {
  const doc = await fromUuid(actorUuid);
  const actor = doc?.actor ?? doc;
  if ( !actor ) {
    ui.notifications?.warn("The actor this attribute macro points to no longer exists.");
    return;
  }
  return rollActorAttribute(actor, key, { substituted });
}

/**
 * Create (or reuse) a hotbar macro that rolls an actor's attribute — built when an
 * Attributes-tab roll button is dropped on the hotbar.
 * @param {object} data   The drag payload ({type:"openlegend.attribute", actorUuid, key, label, substituted}).
 * @param {number|string} slot   The hotbar slot.
 * @returns {Promise<Macro|void>}
 */
export async function createAttributeMacro(data, slot) {
  const actorUuid = data?.actorUuid;
  const key = data?.key;
  if ( !actorUuid || !key ) return;
  const doc = await fromUuid(actorUuid);
  const actor = doc?.actor ?? doc;
  const sub = !!data.substituted;
  const baseLabel = data.label || key;
  const name = `${baseLabel}${sub ? " (substituted)" : ""}${actor ? ` — ${actor.name}` : ""}`;
  const command = `game.openlegend.rollAttributeByActorUuid("${actorUuid}", "${key}", ${sub});`;
  const existing = game.macros.find(m => (m.name === name) && (m.command === command));
  const macro = existing ?? await Macro.implementation.create({
    name,
    type: "script",
    img: "icons/svg/d20-black.svg",
    command,
    flags: { openlegend: { attributeMacro: true } }
  });
  if ( !macro ) return;
  await game.user.assignHotbarMacro(macro, slot);
  return macro;
}

/* -------------------------------------------- */

/**
 * Remove a bane/boon condition from an actor: delete the Active Effect and its
 * source bane/boon item, unless another effect still references that item.
 * @param {Actor} actor
 * @param {ActiveEffect} effect
 * @returns {Promise<void>}
 */
async function removeConditionEffect(actor, effect) {
  const fl = effect.flags?.openlegend ?? {};
  const sourceName = fl.fromBane ?? fl.fromBoon;
  await effect.delete();
  if ( !sourceName ) return;
  const stillReferenced = actor.effects.some(e =>
    (e.flags?.openlegend?.fromBane === sourceName) || (e.flags?.openlegend?.fromBoon === sourceName));
  if ( stillReferenced ) return;
  const item = actor.items.find(i => ((i.type === "bane") || (i.type === "boon")) && (i.name === sourceName));
  if ( item ) await item.delete();
}

/**
 * Record a FAILED resist roll against a bane condition, incrementing its
 * per-application fail counter (flags.openlegend.resistFails). This count is
 * scoped to the current APPLICATION: it lives on the applied ActiveEffect, so
 * removing the bane and re-applying it starts a fresh effect with the count back
 * at zero. Many banes end after a set number of failed resists (SRD durations
 * like "Resist (minor) ends (Fail x 3 = 1 minute)") — this makes that progress
 * visible on the condition and in the resist card.
 * @param {ActiveEffect} effect  A flags.openlegend.fromBane condition.
 * @returns {Promise<number>}  The new fail count for this application.
 */
async function recordResistFailure(effect) {
  const prior = Math.max(0, Math.floor(Number(effect.flags?.openlegend?.resistFails) || 0));
  const next = prior + 1;
  await effect.update({ "flags.openlegend.resistFails": next });
  return next;
}

/**
 * A "· failed N×" note for a resist-card line after a failed roll, or "" for the
 * first failure (nothing accumulated yet to be worth showing beyond "remains").
 * @param {number} count  The post-increment fail count for this application.
 * @returns {string} HTML fragment.
 */
function resistFailNote(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return n > 0 ? ` <span class="ol-resist-fails" title="Failed resist rolls against this application of the bane.">· failed ${n}×</span>` : "";
}

/**
 * Open the Resist Banes dialog for an actor: list every bane afflicting it, each
 * with a Potent checkbox (pre-checked when the bane is already potent). On
 * confirm, roll a resist check per chosen bane — 1d20 (≥10 shakes it off), or
 * 2d20 keep-the-lower when Potent — removing the successes and posting a chat
 * summary. The Potent choice is persisted onto the effect. The system API entry
 * point used by both the sheet's Resist control and its hotbar macro.
 * @param {Actor} actor
 * @returns {Promise<void>}
 */
export async function resistBanesDialog(actor) {
  if ( !actor ) return;
  const { DialogV2 } = foundry.applications.api;
  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;

  const banes = actor.effects
    .filter(e => e.flags?.openlegend?.fromBane)
    // Fatigued cannot be resisted with a resist roll (SRD) — only rest removes it.
    .filter(e => String(e.flags.openlegend.fromBane).toLowerCase() !== "fatigued")
    .map(e => ({ id: e.id, name: e.flags.openlegend.fromBane, potent: !!e.flags.openlegend.potent,
                 fails: Math.max(0, Math.floor(Number(e.flags.openlegend.resistFails) || 0)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if ( !banes.length ) {
    ui.notifications?.info(`${actor.name} has no banes a resist roll can remove.`);
    return;
  }

  const rows = banes.map(b => `
    <li class="ol-resist-row" data-effect-id="${b.id}">
      <label class="ol-check">
        <input type="checkbox" name="resist" value="${b.id}" checked/>
        <span>${esc(b.name)}${b.fails ? ` <span class="ol-resist-fails" title="Failed resist rolls so far against this application.">· failed ${b.fails}×</span>` : ""}</span>
      </label>
      <label class="ol-check ol-resist-potent" title="Potent: roll 2d20 and take the lower.">
        <input type="checkbox" name="potent" value="${b.id}" ${b.potent ? "checked" : ""}/>
        <span><i class="fas fa-biohazard"></i> Potent</span>
      </label>
    </li>`).join("");
  // Resilient (feat): advantage 1 on ANY resist roll. Stacks onto each bane's net
  // (a Potent bane's disadvantage 1 cancels one step).
  const resilientAdv = CONFIG.OPENLEGEND?.resilientResistAdvantage?.(actor) ?? 0;
  const resilientHint = resilientAdv
    ? ` You have <strong>Resilient</strong> (advantage 1 on resist rolls — it cancels a Potent bane's disadvantage, or stacks to advantage 2 with Hospitaler aid).`
    : "";
  const content = `
    <div class="ol-resist-dialog">
      <p class="bane-hint">Roll to shake off each selected bane: <strong>1d20, 10+ succeeds</strong>. A <strong>Potent</strong> bane gives disadvantage 1.${resilientHint}</p>
      <ul class="ol-resist-list">${rows}</ul>
    </div>`;

  const choice = await DialogV2.wait({
    window: { title: `Resist Banes — ${actor.name}` },
    classes: ["openlegend"],
    content,
    rejectClose: false,
    buttons: [
      { action: "roll", label: "Roll Resist", icon: "fas fa-dice-d20", default: true,
        callback: (ev, button, dialog) => {
          const root = dialog.element;
          const sel = [...root.querySelectorAll('input[name="resist"]:checked')].map(i => i.value);
          const pot = [...root.querySelectorAll('input[name="potent"]:checked')].map(i => i.value);
          return { ids: sel, potent: pot };
        } },
      { action: "cancel", label: "Cancel", icon: "fas fa-times" }
    ]
  });
  if ( !choice || (choice === "cancel") || !choice.ids?.length ) return;

  const potentSet = new Set(choice.potent ?? []);
  const lines = [];
  for ( const id of choice.ids ) {
    const effect = actor.effects.get(id);
    if ( !effect ) continue;
    const name = effect.flags?.openlegend?.fromBane ?? effect.name;
    const potent = potentSet.has(id);
    if ( potent !== !!effect.flags?.openlegend?.potent ) {
      await effect.update({ "flags.openlegend.potent": potent });
    }

    // Net advantage on this resist roll: Resilient (+1) minus a Potent bane (−1).
    // buildFormula turns the net into the kept-d20 pool — net 0 → 1d20, +N → roll
    // (1+N) keep highest, −N → roll (1+N) keep lowest (the d20 still explodes).
    const net = resilientAdv - (potent ? 1 : 0);
    const formula = buildFormula("", net);
    const roll = await (new Roll(formula)).evaluate();
    const total = roll.total;
    const success = total >= 10;
    const esc2 = foundry.utils.escapeHTML ?? (s => s);
    const advNote = net > 0 ? ` <span class="ol-resist-adv">(advantage ${net})</span>`
      : net < 0 ? ` <span class="ol-resist-dis">(disadvantage ${Math.abs(net)})</span>` : "";
    const allDice = (roll.dice?.[0]?.results ?? []).map(r => r.result).join(", ");
    const diceText = (net === 0)
      ? `1d20 = <strong>${total}</strong>`
      : `${esc2(formula)} [${allDice}] = <strong>${total}</strong>`;
    // A failed resist bumps this application's fail counter (reset when the bane
    // is removed & re-applied); show the running tally on the line.
    const failNote = success ? "" : resistFailNote(await recordResistFailure(effect));
    lines.push(`<li class="${success ? "ol-resist-ok" : "ol-resist-fail"}"><strong>${esc2(name)}</strong>${potent ? ` <i class="fas fa-biohazard" title="Potent"></i>` : ""}${advNote}: ${diceText} — ${success ? "shaken off" : "remains"}${failNote}</li>`);

    if ( success ) await removeConditionEffect(actor, effect);
  }

  if ( lines.length ) {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="ol-resist-result"><strong>${esc(actor.name)}</strong> resists banes:<ul>${lines.join("")}</ul></div>`
    });
  }
}

/**
 * Hospitaler (feat): a major action that gives each TARGETED ally an immediate
 * resist roll (a free action for them) with ADVANTAGE 1 — the opposite of Potent:
 * roll 2d20 and keep the HIGHER. Each ally rolls against every bane afflicting it
 * (10+ shakes it off, removing the condition). Resolves the targeted tokens at call
 * time and posts a per-ally chat summary. Used by the sheet's Hospitaler control
 * and its hotbar macro.
 * @param {Actor} actor  The Hospitaler (the card's speaker).
 * @returns {Promise<void>}
 */
export async function hospitalerResist(actor) {
  if ( !actor ) return;
  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
  const targets = [...(game.user?.targets ?? [])];
  if ( !targets.length ) {
    ui.notifications?.warn("Target one or more allies to grant a Hospitaler resist roll.");
    return;
  }

  const allyBlocks = [];
  for ( const token of targets ) {
    const ally = token.actor;
    if ( !ally ) continue;
    // Fatigued cannot be resisted with a resist roll (SRD) — only rest removes it.
    const banes = ally.effects.filter(e => e.flags?.openlegend?.fromBane
      && (String(e.flags.openlegend.fromBane).toLowerCase() !== "fatigued"));
    if ( !banes.length ) {
      allyBlocks.push(`<li class="ol-resist-fail"><strong>${esc(token.name ?? ally.name)}</strong>: no banes a resist roll can remove.</li>`);
      continue;
    }
    // The Hospitaler grants advantage 1. The ALLY's own Resilient feat adds another
    // (+1 → advantage 2: 3d20 keep highest); a Potent bane on the ally subtracts one.
    const allyResilient = CONFIG.OPENLEGEND?.resilientResistAdvantage?.(ally) ?? 0;
    const lines = [];
    for ( const effect of banes ) {
      const name = effect.flags?.openlegend?.fromBane ?? effect.name;
      const potent = !!effect.flags?.openlegend?.potent;
      const net = 1 + allyResilient - (potent ? 1 : 0);   // Hospitaler +1, Resilient +1, Potent −1
      const formula = buildFormula("", net);
      const roll = await (new Roll(formula)).evaluate();
      const total = roll.total;
      const success = total >= 10;
      const allDice = (roll.dice?.[0]?.results ?? []).map(r => r.result).join(", ");
      const advLabel = net > 0 ? `advantage ${net}` : net < 0 ? `disadvantage ${Math.abs(net)}` : "even";
      const failNote = success ? "" : resistFailNote(await recordResistFailure(effect));
      lines.push(`<li class="${success ? "ol-resist-ok" : "ol-resist-fail"}">${esc(name)}${potent ? ` <i class="fas fa-biohazard" title="Potent"></i>` : ""} <span class="ol-resist-adv">(${advLabel})</span>: ${esc(formula)} [${allDice}] = <strong>${total}</strong> — ${success ? "shaken off" : "remains"}${failNote}</li>`);
      if ( success ) await removeConditionEffect(ally, effect);
    }
    allyBlocks.push(`<li><strong>${esc(token.name ?? ally.name)}</strong><ul>${lines.join("")}</ul></li>`);
  }

  if ( allyBlocks.length ) {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="ol-resist-result"><strong>${esc(actor.name)}</strong> (Hospitaler) grants an immediate resist roll with <strong>advantage 1</strong> (more if the ally is <em>Resilient</em>) to:<ul>${allyBlocks.join("")}</ul></div>`
    });
  }
}

/**
 * Roll resist for EVERY bane on EVERY given token, unprompted (the group version
 * of the Resist dialog, used by the "Resist All" compendium macro). Each bane:
 * 1d20, 10+ shakes it off — Resilient adds advantage, Potent subtracts one,
 * Fatigued is excluded (SRD: rest only). Successes remove the condition (and its
 * embedded bane item). Posts ONE combined chat summary.
 * @param {Array<Token|TokenDocument>} tokens
 * @returns {Promise<void>}
 */
export async function groupResistBanes(tokens = []) {
  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
  const blocks = [];
  for ( const token of tokens ) {
    const actor = token?.actor ?? token;
    if ( !actor?.effects ) continue;
    const tokenName = token?.name ?? actor.name;
    // Fatigued cannot be resisted with a resist roll (SRD) — only rest removes it.
    const banes = actor.effects.filter(e => e.flags?.openlegend?.fromBane
      && (String(e.flags.openlegend.fromBane).toLowerCase() !== "fatigued"));
    if ( !banes.length ) {
      blocks.push(`<li class="ol-resist-fail"><strong>${esc(tokenName)}</strong>: no banes a resist roll can remove.</li>`);
      continue;
    }
    const resilient = CONFIG.OPENLEGEND?.resilientResistAdvantage?.(actor) ?? 0;
    const lines = [];
    for ( const effect of banes ) {
      const name = effect.flags?.openlegend?.fromBane ?? effect.name;
      const potent = !!effect.flags?.openlegend?.potent;
      const net = resilient - (potent ? 1 : 0);   // Resilient +1, Potent −1
      const formula = buildFormula("", net);
      const roll = await (new Roll(formula)).evaluate();
      const success = roll.total >= 10;
      const allDice = (roll.dice?.[0]?.results ?? []).map(r => r.result).join(", ");
      const advLabel = net > 0 ? `advantage ${net}` : net < 0 ? `disadvantage ${Math.abs(net)}` : "even";
      const failNote = success ? "" : resistFailNote(await recordResistFailure(effect));
      lines.push(`<li class="${success ? "ol-resist-ok" : "ol-resist-fail"}">${esc(name)}${potent ? ` <i class="fas fa-biohazard" title="Potent"></i>` : ""} <span class="ol-resist-adv">(${advLabel})</span>: ${esc(formula)} [${allDice}] = <strong>${roll.total}</strong> — ${success ? "shaken off" : "remains"}${failNote}</li>`);
      if ( success ) await removeConditionEffect(actor, effect);
    }
    blocks.push(`<li><strong>${esc(tokenName)}</strong><ul>${lines.join("")}</ul></li>`);
  }
  if ( !blocks.length ) {
    ui.notifications?.info("None of the chosen tokens have an actor.");
    return;
  }
  await ChatMessage.create({
    content: `<div class="ol-resist-result"><strong>Group resist</strong> — each creature rolls to shake off its banes (<strong>1d20, 10+</strong>):<ul>${blocks.join("")}</ul></div>`
  });
}

/**
 * Rest EVERY given token at once (the group version of the Rest dialog, used by
 * the "Rest All" compendium macro). ONE prompt asks the days of rest and an
 * optional shared attendant score; then each actor heals
 * `days × (max(1, Fortitude) + attendant)` lethal damage (capped at its accrued
 * lethal) and recovers one Fatigued level PER DAY rested (SRD: each 24h period
 * removes one level). Posts ONE combined chat summary.
 * @param {Array<Token|TokenDocument>} tokens
 * @returns {Promise<void>}
 */
export async function groupLethalRest(tokens = []) {
  const { DialogV2 } = foundry.applications.api;
  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;

  const actors = [];
  for ( const token of tokens ) {
    const actor = token?.actor ?? token;
    if ( actor?.system ) actors.push({ actor, tokenName: token?.name ?? actor.name });
  }
  if ( !actors.length ) {
    ui.notifications?.info("None of the chosen tokens have an actor.");
    return;
  }

  const names = actors.map(a => esc(a.tokenName)).join(", ");
  const choice = await DialogV2.wait({
    window: { title: `Rest — ${actors.length} creature${actors.length === 1 ? "" : "s"}` },
    classes: ["openlegend"],
    position: { width: 400 },
    content: `
      <div class="ol-rest-dialog">
        <p class="bane-hint">Rest <strong>${names}</strong>. Each heals lethal damage at <strong>1/day per Fortitude point</strong> (min 1),
        plus the attendant score below (their best Creation, Presence, or Learning — applied to everyone, 0 if unattended).
        Each day of rest also relieves one stack of <strong>Fatigued</strong>.</p>
        <div class="ol-rest-field">
          <label for="ol-group-rest-days">Rest (days)</label>
          <input id="ol-group-rest-days" type="number" name="days" value="1" min="1" step="1"/>
        </div>
        <div class="ol-rest-field">
          <label for="ol-group-rest-attendant">Attendant score</label>
          <input id="ol-group-rest-attendant" type="number" name="attendant" value="0" min="0" step="1"/>
        </div>
      </div>`,
    rejectClose: false,
    buttons: [
      { action: "rest", label: "Rest & Heal", icon: "fas fa-bed", default: true,
        callback: (ev, button, dialog) => {
          const root = dialog.element;
          return {
            days: Math.max(1, Math.floor(Number(root.querySelector('[name="days"]')?.value) || 1)),
            attendant: Math.max(0, Math.floor(Number(root.querySelector('[name="attendant"]')?.value) || 0))
          };
        } },
      { action: "cancel", label: "Cancel", icon: "fas fa-times" }
    ]
  });
  if ( !choice || (choice === "cancel") ) return;
  const { days, attendant } = choice;
  const dayWord = days === 1 ? "day" : "days";

  const blocks = [];
  for ( const { actor, tokenName } of actors ) {
    const lethal = Math.max(0, Math.floor(Number(actor.system?.health?.lethal ?? 0)));
    const fatigued = actor.effects.find(e =>
      e.flags?.openlegend?.stacking &&
      (e.flags?.openlegend?.fromBane ?? "").toLowerCase() === "fatigued");
    const fatiguedLevel = fatigued
      ? Math.max(1, Math.floor(Number(fatigued.flags.openlegend.stackLevel) || 1))
      : 0;
    if ( !lethal && !fatigued ) {
      blocks.push(`<li><strong>${esc(tokenName)}</strong>: nothing to heal (no lethal damage, not Fatigued).</li>`);
      continue;
    }
    const lines = [];
    if ( lethal > 0 ) {
      const baseRate = Math.max(1, Math.max(0, Math.floor(Number(actor.system?.attributes?.fortitude?.value ?? 0))));
      const perDay = baseRate + attendant;
      const healed = Math.min(lethal, perDay * days);
      const next = Math.max(0, lethal - healed);
      await actor.update({ "system.health.lethal": next });
      lines.push(`heals <strong>${healed}</strong> lethal (${perDay}/day × ${days} ${dayWord}): ${lethal} &rarr; <strong>${next}</strong>`);
    }
    if ( fatigued ) {
      const relieved = Math.min(days, fatiguedLevel);
      const nextLevel = fatiguedLevel - relieved;
      if ( nextLevel > 0 ) {
        await fatigued.update({ "flags.openlegend.stackLevel": nextLevel });
        lines.push(`recovers ${relieved} stack${relieved === 1 ? "" : "s"} of <strong>Fatigued</strong>: level ${fatiguedLevel} &rarr; <strong>${nextLevel}</strong>`);
      } else {
        await removeConditionEffect(actor, fatigued);
        lines.push(`recovers from <strong>Fatigued</strong> (cleared)`);
      }
    }
    actor.sheet?.render(false);
    blocks.push(`<li><strong>${esc(tokenName)}</strong>: ${lines.join("; ")}.</li>`);
  }

  await ChatMessage.create({
    content: `<div class="ol-rest-result"><i class="fas fa-bed"></i> <strong>Group rest</strong> — ${days} ${dayWord}${attendant ? `, attendant ${attendant}` : ""}:<ul>${blocks.join("")}</ul></div>`
  });
}

/**
 * Resolve an actor by UUID and run its Hospitaler ally-resist. The system API entry
 * point used by the Hospitaler hotbar macro.
 * @param {string} actorUuid
 * @returns {Promise<void>}
 */
export async function hospitalerByActorUuid(actorUuid) {
  const doc = await fromUuid(actorUuid);
  const actor = doc?.actor ?? doc;
  if ( !actor ) {
    ui.notifications?.warn("The actor this Hospitaler macro points to no longer exists.");
    return;
  }
  return hospitalerResist(actor);
}

/**
 * Create (or reuse) a hotbar macro that runs an actor's Hospitaler ally-resist —
 * built when the sheet's Hospitaler control is dropped on the hotbar.
 * @param {object} data   The drag payload ({type:"openlegend.hospitaler", actorUuid, name}).
 * @param {number} slot   The hotbar slot.
 * @returns {Promise<Macro|void>}
 */
export async function createHospitalerMacro(data, slot) {
  const actorUuid = data?.actorUuid;
  if ( !actorUuid ) return;
  const doc = await fromUuid(actorUuid);
  const actor = doc?.actor ?? doc;
  const name = `Hospitaler${actor ? ` — ${actor.name}` : ""}`;
  const command = `game.openlegend.hospitalerByActorUuid("${actorUuid}");`;
  const existing = game.macros.find(m => (m.name === name) && (m.command === command));
  const macro = existing ?? await Macro.implementation.create({
    name,
    type: "script",
    img: "icons/svg/heal.svg",
    command,
    flags: { openlegend: { hospitalerMacro: true } }
  });
  if ( !macro ) return;
  await game.user.assignHotbarMacro(macro, slot);
  return macro;
}

/**
 * Open the Rest / Heal Lethal Damage dialog for an actor (Lethal Damage rules).
 *
 * A creature heals lethal damage at a rate of **1 HP per day per Fortitude point
 * (minimum 1)** on its own. With the full-time attendance of a capable healer or
 * doctor, it heals an ADDITIONAL amount equal to the attendant's best Creation,
 * Presence, or Learning score (multiple attendants don't stack — use the highest).
 * The dialog asks for the number of rest days and an optional attendant score, then
 * heals `days × (max(1, Fortitude) + attendant)` lethal damage (capped at current
 * lethal). Healing lethal restores max HP, so cleared lethal is reflected on the
 * effective max next derive.
 * @param {Actor} actor
 * @returns {Promise<void>}
 */
export async function lethalRestDialog(actor) {
  if ( !actor ) return;
  const { DialogV2 } = foundry.applications.api;
  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;

  const lethal = Math.max(0, Math.floor(Number(actor.system?.health?.lethal ?? 0)));

  // Resting also relieves one stack of Fatigued (a stacking bane). Find the
  // afflicting Fatigued effect, if any, so we can drop a level after the rest.
  const fatigued = actor.effects.find(e =>
    e.flags?.openlegend?.stacking &&
    (e.flags?.openlegend?.fromBane ?? "").toLowerCase() === "fatigued");
  const fatiguedLevel = fatigued
    ? Math.max(1, Math.floor(Number(fatigued.flags.openlegend.stackLevel) || 1))
    : 0;

  if ( !lethal && !fatigued ) {
    ui.notifications?.info(`${actor.name} has no lethal damage to heal and is not Fatigued.`);
    return;
  }

  const fortitude = Math.max(0, Math.floor(Number(actor.system?.attributes?.fortitude?.value ?? 0)));
  const baseRate = Math.max(1, fortitude);
  const maxBase = Math.max(0, Math.floor(Number(actor.system?.health?.maxBase ?? 0)));

  const fatiguedRow = fatigued
    ? `<div class="ol-rest-line"><span>Fatigued</span><span>level ${fatiguedLevel} &rarr; ${fatiguedLevel - 1 > 0 ? `level ${fatiguedLevel - 1}` : "cleared"}</span></div>`
    : "";

  const content = `
    <div class="ol-rest-dialog">
      <p class="bane-hint">Heal lethal damage: <strong>${baseRate}</strong>/day on your own (1 per Fortitude point, min 1).
      A full-time attendant adds their best <strong>Creation, Presence, or Learning</strong> score (highest only — attendants don't stack).${fatigued ? " Resting also relieves one stack of <strong>Fatigued</strong>." : ""}</p>
      <div class="ol-rest-field">
        <label for="ol-rest-days">Rest (days)</label>
        <input id="ol-rest-days" type="number" name="days" value="1" min="1" step="1"/>
      </div>
      <div class="ol-rest-field">
        <label for="ol-rest-attendant">Attendant score</label>
        <input id="ol-rest-attendant" type="number" name="attendant" value="0" min="0" step="1" title="Attendant's highest Creation, Presence, or Learning score (0 if resting unattended)."/>
      </div>
      <div class="ol-rest-summary">
        <div class="ol-rest-line"><span>Fortitude</span><span>${fortitude}</span></div>
        <div class="ol-rest-line"><span>Per day</span><span data-rest="perday">${baseRate}</span></div>
        <div class="ol-rest-line"><span>Current lethal</span><span>${lethal}${maxBase ? ` / ${maxBase}` : ""}</span></div>
        ${fatiguedRow}
        <div class="ol-rest-line ol-rest-total"><span>Will heal</span><span data-rest="healed">${Math.min(lethal, baseRate)}</span></div>
      </div>
    </div>`;

  // Live-update the per-day rate and total healed as days / attendant change.
  const recompute = root => {
    const days = Math.max(1, Math.floor(Number(root.querySelector('[name="days"]')?.value) || 1));
    const attendant = Math.max(0, Math.floor(Number(root.querySelector('[name="attendant"]')?.value) || 0));
    const perDay = baseRate + attendant;
    const healed = Math.min(lethal, perDay * days);
    const perEl = root.querySelector('[data-rest="perday"]');
    const healEl = root.querySelector('[data-rest="healed"]');
    if ( perEl ) perEl.textContent = String(perDay);
    if ( healEl ) healEl.textContent = `${healed}${days > 1 ? ` (${perDay}/day × ${days})` : ""}`;
  };

  const choice = await DialogV2.wait({
    window: { title: `Heal Lethal — ${actor.name}` },
    classes: ["openlegend"],
    position: { width: 380 },
    content,
    rejectClose: false,
    render: (ev, dialog) => {
      const root = dialog.element;
      root.querySelectorAll('input[name="days"], input[name="attendant"]')
        .forEach(i => i.addEventListener("input", () => recompute(root)));
      recompute(root);
    },
    buttons: [
      { action: "rest", label: "Rest & Heal", icon: "fas fa-bed", default: true,
        callback: (ev, button, dialog) => {
          const root = dialog.element;
          const days = Math.max(1, Math.floor(Number(root.querySelector('[name="days"]')?.value) || 1));
          const attendant = Math.max(0, Math.floor(Number(root.querySelector('[name="attendant"]')?.value) || 0));
          return { days, attendant };
        } },
      { action: "cancel", label: "Cancel", icon: "fas fa-times" }
    ]
  });
  if ( !choice || (choice === "cancel") ) return;

  const { days, attendant } = choice;
  const perDay = baseRate + attendant;
  const healed = Math.min(lethal, perDay * days);
  const dayWord = days === 1 ? "day" : "days";

  const lines = [];

  // Heal lethal damage (reduces accrued lethal → restores effective max HP).
  if ( healed > 0 ) {
    const next = Math.max(0, lethal - healed);
    await actor.update({ "system.health.lethal": next });
    const attLine = attendant > 0
      ? ` (Fortitude ${baseRate} + attendant ${attendant} = ${perDay}/day × ${days} ${dayWord})`
      : ` (${baseRate}/day × ${days} ${dayWord})`;
    lines.push(`Heals <strong>${healed}</strong> lethal damage${attLine}. Lethal damage: ${lethal} &rarr; <strong>${next}</strong>.`);
  }

  // Relieve one stack of Fatigued: decrement the stack level, removing the
  // condition entirely when it would drop below 1.
  if ( fatigued ) {
    if ( fatiguedLevel > 1 ) {
      await fatigued.update({ "flags.openlegend.stackLevel": fatiguedLevel - 1 });
      lines.push(`Recovers one stack of <strong>Fatigued</strong>: level ${fatiguedLevel} &rarr; <strong>${fatiguedLevel - 1}</strong>.`);
    } else {
      await removeConditionEffect(actor, fatigued);
      lines.push(`Recovers from <strong>Fatigued</strong> (cleared).`);
    }
  }

  if ( !lines.length ) return;
  actor.sheet?.render(false);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="ol-rest-result"><i class="fas fa-bed"></i> <strong>${esc(actor.name)}</strong> rests. ${lines.join(" ")}</div>`
  });
}

/**
 * Resolve an actor by UUID and open its Resist Banes dialog. The system API entry
 * point used by the Resist hotbar macro.
 * @param {string} actorUuid
 * @returns {Promise<void>}
 */
export async function resistBanesByActorUuid(actorUuid) {
  const doc = await fromUuid(actorUuid);
  const actor = doc?.actor ?? doc;
  if ( !actor ) {
    ui.notifications?.warn("The actor this Resist macro points to no longer exists.");
    return;
  }
  return resistBanesDialog(actor);
}

/**
 * Create (or reuse) a hotbar macro that opens an actor's Resist Banes dialog —
 * built when the sheet's Resist control is dropped on the hotbar.
 * @param {object} data   The drag payload ({type:"openlegend.resist", actorUuid, name}).
 * @param {number} slot   The hotbar slot.
 * @returns {Promise<Macro|void>}
 */
export async function createResistMacro(data, slot) {
  const actorUuid = data?.actorUuid;
  if ( !actorUuid ) return;
  const doc = await fromUuid(actorUuid);
  const actor = doc?.actor ?? doc;
  const name = `Resist Banes${actor ? ` — ${actor.name}` : ""}`;
  const command = `game.openlegend.resistBanesByActorUuid("${actorUuid}");`;
  const existing = game.macros.find(m => (m.name === name) && (m.command === command));
  const macro = existing ?? await Macro.implementation.create({
    name,
    type: "script",
    img: "icons/svg/combat.svg",
    command,
    flags: { openlegend: { resistMacro: true } }
  });
  if ( !macro ) return;
  await game.user.assignHotbarMacro(macro, slot);
  return macro;
}

/* -------------------------------------------- */

/** The flag marking the Battle Trance tracker Active Effect (shown on the token
 *  + effects panel; removing it deactivates the trance). */
const BATTLE_TRANCE_EFFECT_FLAG = "battleTrance";

/** The Battle Trance tracker effect on an actor, if present. */
function battleTranceEffect(actor) {
  return (actor?.effects ?? []).find(e => e.flags?.openlegend?.[BATTLE_TRANCE_EFFECT_FLAG]) ?? null;
}

/**
 * Set an actor's Battle Trance on/off (flips the owned feat's
 * `flags.openlegend.battleTranceActive`), reconciles a tracker Active Effect (a
 * flame icon shown on the token + effects panel — removing it deactivates the
 * trance), and posts a short chat note. Used by the feat-row toggle, the hotbar
 * macro, and the effects-panel-removal sync. While entranced: advantage 1 on
 * attacks, Toughness & Resolve +3, Guard armor bonus floored at 3.
 * @param {Actor} actor
 * @param {object} [opts]
 * @param {boolean} [opts.state]   Force a target state; omit to flip current.
 * @param {boolean} [opts.silent]  Suppress the chat note.
 * @returns {Promise<boolean|void>}  The new on/off state.
 */
export async function toggleBattleTrance(actor, { state, silent = false } = {}) {
  const cfg = CONFIG.OPENLEGEND ?? {};
  const feat = cfg.battleTranceFeat ? cfg.battleTranceFeat(actor) : null;
  if ( !feat ) { ui.notifications?.warn(`${actor?.name ?? "This actor"} does not have the Battle Trance feat.`); return; }
  const now = (state === undefined) ? !feat.flags?.openlegend?.battleTranceActive : !!state;
  await feat.update({ "flags.openlegend.battleTranceActive": now });

  // Reconcile the tracker effect: create it on enter, delete it on exit.
  const existing = battleTranceEffect(actor);
  if ( now && !existing ) {
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name: "Battle Trance",
      img: "icons/svg/fire.svg",
      origin: feat.uuid,
      showIcon: 2,   // CONST.ACTIVE_EFFECT_SHOW_ICON.ALWAYS — token badge + panel
      description: "<p>Entranced: advantage 1 on attacks; +3 Toughness & Resolve; Guard armor bonus floored at 3. Remove to end.</p>",
      flags: { openlegend: { [BATTLE_TRANCE_EFFECT_FLAG]: true } }
    }]);
  } else if ( !now && existing ) {
    await existing.delete();
  }

  if ( !silent ) {
    const escape = foundry.utils.escapeHTML ?? (s => s);
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="ol-item-invocation"><p><i class="fas fa-fire-flame-curved"></i> <strong>${escape(actor.name)}</strong> ${now
        ? "enters a <strong>Battle Trance</strong> — advantage 1 on attacks, +3 Toughness & Resolve, armor bonus floored at 3."
        : "ends their <strong>Battle Trance</strong>."}</p></div>`
    });
  }

  // Deathless Trance, trance-END rule: damage taken in the trance could have driven
  // HP below zero. On ending the trance with HP < 0, the actor collapses unconscious
  // and DIES if not healed to ≥0 within 1 round. Surface this (the GM resolves the
  // 1-round timer); HP is NOT floored — the negative total stands until healed.
  if ( !now && cfg.hasDeathlessTrance && cfg.hasDeathlessTrance(actor) ) {
    const hp = Number(actor.system?.health?.value ?? 0);
    if ( hp < 0 ) {
      const escape = foundry.utils.escapeHTML ?? (s => s);
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="ol-deathless-collapse"><p><i class="fas fa-skull-crossbones"></i> <strong>${escape(actor.name)}</strong>'s Battle Trance ends at <strong>${hp} HP</strong> — they collapse <strong>unconscious</strong>. <strong>If not healed to 0 or more HP within 1 round, they die.</strong></p></div>`
      });
    }
  }
  return now;
}

/**
 * Sync helper for when the Battle Trance tracker effect is DELETED (e.g. removed
 * from the effects panel / token HUD): if the feat is still flagged active, flip
 * it off (without re-deleting the already-gone effect). Wired to the
 * deleteActiveEffect hook in openlegend.mjs.
 * @param {ActiveEffect} effect
 * @returns {Promise<void>}
 */
export async function onBattleTranceEffectDeleted(effect) {
  if ( !effect?.flags?.openlegend?.[BATTLE_TRANCE_EFFECT_FLAG] ) return;
  const actor = effect.parent;
  const cfg = CONFIG.OPENLEGEND ?? {};
  const feat = (actor && cfg.battleTranceFeat) ? cfg.battleTranceFeat(actor) : null;
  if ( feat?.flags?.openlegend?.battleTranceActive ) {
    // The effect is already gone; just flip the feat off (silent reconcile won't
    // find an effect to delete).
    await toggleBattleTrance(actor, { state: false });
  }
}

/**
 * Toggle Battle Trance for the actor a hotbar macro points to (by uuid).
 * @param {string} actorUuid
 * @returns {Promise<boolean|void>}
 */
export async function toggleBattleTranceByActorUuid(actorUuid) {
  const doc = await fromUuid(actorUuid);
  const actor = doc?.actor ?? doc;
  if ( !actor ) {
    ui.notifications?.warn("The actor this Battle Trance macro points to no longer exists.");
    return;
  }
  return toggleBattleTrance(actor);
}

/**
 * Create (or reuse) a hotbar macro that toggles an actor's Battle Trance — built
 * when the feat's toggle control is dropped on the hotbar.
 * @param {object} data   The drag payload ({type:"openlegend.battleTrance", actorUuid, name}).
 * @param {number} slot   The hotbar slot.
 * @returns {Promise<Macro|void>}
 */
export async function createBattleTranceMacro(data, slot) {
  const actorUuid = data?.actorUuid;
  if ( !actorUuid ) return;
  const doc = await fromUuid(actorUuid);
  const actor = doc?.actor ?? doc;
  const name = `Battle Trance${actor ? ` — ${actor.name}` : ""}`;
  const command = `game.openlegend.toggleBattleTranceByActorUuid("${actorUuid}");`;
  const existing = game.macros.find(m => (m.name === name) && (m.command === command));
  const macro = existing ?? await Macro.implementation.create({
    name,
    type: "script",
    img: "icons/svg/fire.svg",
    command,
    flags: { openlegend: { battleTranceMacro: true } }
  });
  if ( !macro ) return;
  await game.user.assignHotbarMacro(macro, slot);
  return macro;
}

/* -------------------------------------------- */
/*  Reckless Attack                             */
/* -------------------------------------------- */

/**
 * Perform a Reckless Attack (feat; requires being in a Battle Trance): inflict a
 * flat, unmitigable {@link CONFIG.OPENLEGEND.RECKLESS_ATTACK_COST} HP of self-damage
 * to gain one extra attack as a minor action this turn. Per the SRD the damage is
 * suffered BEFORE the attack and effects that prevent or reduce damage cannot affect
 * it — so it bypasses any resistance and is a straight HP subtraction. HP floors at 0
 * unless Deathless Trance (while in a trance) lets it go negative; we warn the GM if
 * the cost would drop the actor unconscious, since you must remain conscious to make
 * the attack. Posts a chat note announcing the extra attack, with an Undo.
 * @param {Actor} actor
 * @returns {Promise<void>}
 */
export async function recklessAttack(actor) {
  const cfg = CONFIG.OPENLEGEND ?? {};
  if ( !actor?.system?.health ) {
    ui.notifications?.warn("Could not find this actor's health.");
    return;
  }
  if ( !cfg.hasRecklessAttack?.(actor) ) {
    ui.notifications?.warn(`${actor?.name ?? "This actor"} does not have the Reckless Attack feat.`);
    return;
  }
  if ( !cfg.battleTranceActive?.(actor) ) {
    ui.notifications?.warn(`${actor.name} must be in a Battle Trance to make a Reckless Attack.`);
    return;
  }
  if ( !canModifyActorHealth(actor) ) {
    ui.notifications?.warn(`You don't have permission to modify ${actor.name}'s health.`);
    return;
  }

  const cost = Math.max(0, Math.floor(Number(cfg.RECKLESS_ATTACK_COST) || 5));
  const current = Number(actor.system.health.value ?? 0);
  // Flat, unmitigable self-damage. Deathless Trance (while entranced) permits HP < 0;
  // otherwise it floors at 0.
  const allowNegative = cfg.canTakeNegativeDamage?.(actor);
  const next = allowNegative ? (current - cost) : Math.max(0, current - cost);
  await actor.update({ "system.health.value": next });

  // You must remain conscious after the self-damage to benefit from the extra attack.
  const remainsConscious = next > 0;
  const escape = foundry.utils.escapeHTML ?? (s => s);
  // Resolve a token uuid for the Undo button where one exists; fall back to the
  // actor uuid (undoDamageToToken resolves either via fromUuid).
  const tokenUuid = actor.getActiveTokens?.()[0]?.document?.uuid ?? actor.uuid;
  const undoBtn =
    `<button type="button" class="ol-undo-damage"`
    + ` data-token-uuid="${escape(tokenUuid)}" data-damage="${cost}" data-damage-type="">`
    + `<i class="fas fa-rotate-left"></i> Undo</button>`;

  const lead = remainsConscious
    ? `gains an <strong>extra attack</strong> as a minor action`
    : `<strong>drops to ${next} HP</strong> — unconscious, so the extra attack is <strong>lost</strong>`;
  const content =
    `<div class="ol-reckless-attack ol-item-invocation">`
    + `<p><i class="fas fa-burst"></i> <strong>${escape(actor.name)}</strong> makes a <strong>Reckless Attack</strong>: `
    + `suffers <strong>${cost}</strong> HP of unmitigable self-damage <span class="ol-damage-hp">(${current} → ${next} HP)</span> and ${lead}.</p>`
    + `<div class="ol-reckless-actions"><span class="ol-damage-actions">${undoBtn}</span></div>`
    + `</div>`;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content
  });
}

/**
 * Perform a Reckless Attack for the actor a hotbar macro points to (by uuid).
 * @param {string} actorUuid
 * @returns {Promise<void>}
 */
export async function recklessAttackByActorUuid(actorUuid) {
  const doc = await fromUuid(actorUuid);
  const actor = doc?.actor ?? doc;
  if ( !actor ) {
    ui.notifications?.warn("The actor this Reckless Attack macro points to no longer exists.");
    return;
  }
  return recklessAttack(actor);
}

/**
 * Create (or reuse) a hotbar macro that makes an actor's Reckless Attack — built
 * when the sheet's Reckless Attack control is dropped on the hotbar.
 * @param {object} data   The drag payload ({type:"openlegend.recklessAttack", actorUuid, name}).
 * @param {number} slot   The hotbar slot.
 * @returns {Promise<Macro|void>}
 */
export async function createRecklessAttackMacro(data, slot) {
  const actorUuid = data?.actorUuid;
  if ( !actorUuid ) return;
  const doc = await fromUuid(actorUuid);
  const actor = doc?.actor ?? doc;
  const name = `Reckless Attack${actor ? ` — ${actor.name}` : ""}`;
  const command = `game.openlegend.recklessAttackByActorUuid("${actorUuid}");`;
  const existing = game.macros.find(m => (m.name === name) && (m.command === command));
  const macro = existing ?? await Macro.implementation.create({
    name,
    type: "script",
    img: "icons/svg/explosion.svg",
    command,
    flags: { openlegend: { recklessAttackMacro: true } }
  });
  if ( !macro ) return;
  await game.user.assignHotbarMacro(macro, slot);
  return macro;
}
