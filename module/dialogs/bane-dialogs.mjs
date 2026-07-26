import {numberGuard} from "../../module/helpers/utils.mjs"
import {buildFormula} from "../dice/roll-dialog.mjs"
/**
 * Dialogs for bane side-effects, split out of action-roll.mjs to keep that file
 * manageable.
 */

/**
 * On a successful Nullify affliction, prompt to cancel one active boon on the
 * target whose power level is ≤ the Nullify's power level, then remove the
 * chosen boon's ActiveEffect and its embedded boon Item. GM/owner only; a
 * no-candidate target or a dismissed dialog is a no-op.
 * @param {Actor} actor    The nullified target.
 * @param {number} banePl  The Nullify's invoked power level.
 * @returns {Promise<void>}
 */

export async function promptNullifyRemoval(actor, banePl){
   try {
      const pl = numberGuard(banePl);

    const boons = (actor?.effects?.contents ?? []).filter(e =>
    e.flags?.openlegend?.fromBoon &&
    (numberGuard(e.flags.openlegend.powerLevel) <= pl));
  if ( !boons.length ) return;
  const escape = foundry.utils.escapeHTML ?? (s => s);

  const options = boons.map((e, i) => {
    const name = e.flags.openlegend.fromBoon;
    const epl = numberGuard(e.flags.openlegend.powerLevel);

    return `<option value="${e.id}"${i === 0 ? " selected" : ""}>
    ${escape(name)}${epl ? ` (PL ${epl})` : ""}
    </option>`;

  }).join("");

  const { DialogV2 } = foundry.applications.api;
  if ( !DialogV2 ) {
    ui.notifications?.error("Nullify: the dialog API is unavailable in this Foundry version.");
    return;
  }
    const chosenBoonId= await DialogV2.wait({
        window:{title:`Nullify - ${actor.name}`},
        content:`
        <p><strong>Nullify</strong> (PL ${pl}) may cancel one boon on <strong>${escape(actor.name)}</strong> of ${pl} PL or lower.</p>
      <div class="form-group">
        <label>Boons</label>
        <select name="effectId" style="flex:1;">${options}</select>
      </div>`,
        buttons: [
      { action: "cancel-boon", label: "Cancel Boon", icon: "fas fa-ban", default: true,
        callback: (event, button) => button.form.elements.effectId.value },
      { action: "skip", label: "Leave It", icon: "fas fa-times",
        callback:(event,button)=> "cancelled"
       }
    ],
        rejectClose: false
    })
    if ( typeof chosenBoonId !== "string" ){
        ui.notifications?.error("Error on dialog code:7594");
        return;
    } 
     if ( chosenBoonId == "cancelled" ){
        ui.notifications?.error("Nevermind I will nullify nothing");
        return;
    }    
    const getEffect = actor.effects.get(chosenBoonId);

    // Granted boons live ONLY as ActiveEffects (applyBoonToActor embeds no boon
    // Item, unlike applyBaneToActor) — so deleting the effect fully removes it.
    if(getEffect){
        const boonName = getEffect.flags?.openlegend?.fromBoon ?? "";
        await getEffect.delete();
        // SRD: "the target cannot benefit from or have the target boon invoked
        // upon them for 1 minute" — apply the blocker effect remembering which
        // boon was canceled (enforced in applyBoonToActor).
        await applyNullifyBlocker(actor, boonName);
    }else{
        ui.notifications?.error("Cant find boon to delete  error 0code:7595");
    }

   } catch (error) {
    console.log(error)
    ui.notifications?.error("Nullify removal error. Dev step up your game please code:420");
   }


}

/**
 * Fully remove a bane CONDITION from an actor: delete the ActiveEffect, then —
 * when no other condition still references the same bane — the embedded bane
 * Item copy that applyBaneToActor added alongside it (mirrors the actor sheet's
 * condition-delete cleanup).
 * @param {Actor} actor
 * @param {ActiveEffect} effect  A condition carrying flags.openlegend.fromBane.
 * @returns {Promise<void>}
 */
async function removeBaneCondition(actor, effect) {
  const name = effect?.flags?.openlegend?.fromBane ?? "";
  await effect.delete();
  if ( !name ) return;
  const stillReferenced = actor.effects.some(e =>
    (e.flags?.openlegend?.fromBane === name) || (e.flags?.openlegend?.fromBoon === name));
  if ( stillReferenced ) return;
  const item = actor.items.find(i => (i.type === "bane") && (i.name === name));
  if ( item ) await item.delete();
}

/**
 * Whether the actor already benefited from a Restoration against Fatigued
 * within the last 24 hours (the "Restoration Fatigue Immunity" marker, applied
 * below; removed MANUALLY by the user when the 24 hours have passed).
 * @param {Actor} actor
 * @returns {boolean}
 */
function restorationFatigueBlocked(actor) {
  return (actor?.effects ?? []).some(e => !e.disabled && e.flags?.openlegend?.blocksRestorationFatigue);
}

/**
 * Apply the "Restoration Fatigue Immunity" marker: SRD — "A target may only
 * benefit from one invocation of the restoration boon to remove fatigue within
 * a 24 hour period." Applied whenever a Restoration reduces Fatigued; while
 * present, promptRestorationDispel leaves Fatigued untouched. NO automated
 * duration — the user removes it once the 24 hours have passed. The template
 * comes from the system's `effects` pack (fallback: inline equivalent).
 * @param {Actor} actor
 * @returns {Promise<void>}
 */
async function applyRestorationFatigueImmunity(actor) {
  if ( restorationFatigueBlocked(actor) ) return;
  let data = null;
  try {
    const pack = game.packs?.get("tomucatos-open-legend-rpg-system.effects");
    const entry = pack ? (await pack.getIndex()).find(i => i.name === "Restoration Fatigue Immunity") : null;
    const item = entry ? await pack.getDocument(entry._id) : null;
    const src = (item?.effects?.contents ?? []).find(e => !e.disabled);
    if ( src ) {
      data = src.toObject();
      delete data._id;
    }
  } catch ( _err ) { /* pack unavailable → inline fallback below */ }
  data ??= {
    name: "Restoration Fatigue Immunity",
    type: "base",
    img: "icons/svg/regen.svg",
    disabled: false,
    transfer: false,
    showIcon: 2, /* CONST.ACTIVE_EFFECT_SHOW_ICON.ALWAYS */
    description: "<p>This character already benefited from a Restoration boon against Fatigued. They may not benefit from another for 24 hours. Remove this effect manually once the 24 hours have passed.</p>",
    system: { changes: [] },
    flags: { openlegend: {} }
  };
  data.flags ??= {};
  data.flags.openlegend = {
    ...(data.flags.openlegend ?? {}),
    blocksRestorationFatigue: true,
    fromEffectItem: "Restoration Fatigue Immunity"
  };
  await actor.createEmbeddedDocuments("ActiveEffect", [data]);
  ui.notifications?.info(`${actor.name} cannot benefit from Restoration against Fatigued again for 24 hours (remove the marker manually when it passes).`);
}

/**
 * Cure ONE bane condition via Restoration, honoring Fatigued's special rules
 * (SRD): a Restoration removes only ONE level of fatigue — unless the boon's PL
 * is 7+, which removes them all — and using it marks the target immune to
 * further Restoration-vs-Fatigued for 24 hours. Every other bane is removed
 * outright (condition + embedded bane item).
 * @param {Actor} actor
 * @param {ActiveEffect} effect       A flags.openlegend.fromBane condition.
 * @param {number} restorationPl      The invoked Restoration power level.
 * @returns {Promise<string>}  An HTML fragment describing what was removed.
 */
async function cureViaRestoration(actor, effect, restorationPl) {
  const escape = foundry.utils.escapeHTML ?? (s => s);
  const name = effect.flags?.openlegend?.fromBane ?? effect.name;
  if ( String(name).toLowerCase() !== "fatigued" ) {
    const epl = numberGuard(effect.flags?.openlegend?.powerLevel);
    await removeBaneCondition(actor, effect);
    return `<strong>${escape(name)}</strong>${epl ? ` (PL ${epl})` : ""}`;
  }
  // Fatigued: one level per Restoration; PL 7+ clears the whole stack.
  const stack = Math.max(1, numberGuard(effect.flags?.openlegend?.stackLevel) || 1);
  const removeAll = (numberGuard(restorationPl) >= 7) || (stack <= 1);
  if ( removeAll ) {
    await removeBaneCondition(actor, effect);
  } else {
    await effect.update({ "flags.openlegend.stackLevel": stack - 1 });
  }
  await applyRestorationFatigueImmunity(actor);
  return removeAll
    ? `<strong>Fatigued</strong> (all ${stack} level${stack > 1 ? "s" : ""}${numberGuard(restorationPl) >= 7 ? " — PL 7+" : ""})`
    : `one level of <strong>Fatigued</strong> (${stack} → ${stack - 1})`;
}

/**
 * Resolve a successful Restoration invocation on a target (SRD). Restoration is
 * INSTANTANEOUS — nothing is written to the target; its whole effect is:
 *
 * 1. Every bane of power level ≤ the chosen Restoration PL is cured OUTRIGHT and
 *    UNCONDITIONALLY (the invocation's guaranteed benefit). The player does not
 *    need to have aimed high enough for the tougher banes to still clear these.
 * 2. Banes ABOVE the chosen PL are each dispellable ONLY if the invocation's own
 *    action roll already met that bane's CR (20 + 2 × its PL) — no re-stake, no
 *    extra roll: the roll happened, so we simply offer the ones it cleared (all
 *    pre-checked; the player may deselect). When there's no attached total (a
 *    Boon Focus auto-success, or a bare drop), ONE roll is made here with the
 *    invoker's attribute dice + the feat's advantage to get a total to check —
 *    and it never risks the low-PL cure, which already happened in step 1.
 *
 * @param {Actor} actor    The restored target.
 * @param {number} boonPl  The chosen Restoration power level (cure ceiling).
 * @param {object|null} [rollCtx]  The invocation's roll context, from the chat
 *   card's Grant button: { total, invokerUuid, attrKey }. total is null for a
 *   Boon Focus auto-success or a bare drop (a roll is then made for higher banes).
 * @returns {Promise<void>}
 */
export async function promptRestorationDispel(actor, boonPl, rollCtx = null) {
  try {
    const pl = numberGuard(boonPl);
    const escape = foundry.utils.escapeHTML ?? (s => s);
    const cfg = CONFIG.OPENLEGEND ?? {};

    let banes = (actor?.effects?.contents ?? []).filter(e => e.flags?.openlegend?.fromBane);
    // SRD: only ONE Restoration may reduce Fatigued per 24 hours — while the
    // immunity marker is present, Fatigued is simply not on the table (other
    // banes are cured as normal).
    const isFatiguedEffect = e => String(e.flags.openlegend.fromBane).toLowerCase() === "fatigued";
    if ( restorationFatigueBlocked(actor) && banes.some(isFatiguedEffect) ) {
      banes = banes.filter(e => !isFatiguedEffect(e));
      ui.notifications?.info(`${actor.name} already benefited from a Restoration against Fatigued within 24 hours — Fatigued is unaffected.`);
    }
    if ( !banes.length ) {
      ui.notifications?.info(`${actor.name} suffers no banes Restoration can cure.`);
      return;
    }
    const banePlOf = e => numberGuard(e.flags.openlegend.powerLevel);
    const low = banes.filter(e => banePlOf(e) <= pl);
    const high = banes.filter(e => banePlOf(e) > pl);

    // Cure every bane at or below the Restoration's PL (the invocation's base
    // benefit). NOT run up front when higher-PL banes are present — a beyond-PL
    // dispel ATTEMPT re-stakes the whole invocation on its roll (see below), so
    // the low cure must wait for that choice.
    const cureLow = async () => {
      const cured = [];
      for ( const e of low ) {
        cured.push(await cureViaRestoration(actor, e, pl));
      }
      if ( cured.length ) {
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: `<div class="ol-boon-applied"><strong>Restoration</strong> (PL ${pl}) cures <strong>${escape(actor.name)}</strong> of ${cured.join(", ")}.</div>`
        });
      } else {
        ui.notifications?.info(`${actor.name} has no banes of PL ${pl} or lower.`);
      }
    };

    // Always cure the banes at or below the chosen PL — that's the invocation's
    // guaranteed benefit and does NOT depend on any higher-bane decision.
    await cureLow();

    // No higher-PL banes: done.
    if ( !high.length ) return;

    // Higher-PL banes: the player does NOT need to have aimed for them. Each is
    // dispellable ONLY if the invocation's OWN action roll already met that bane's
    // CR (20 + 2 × its PL). No re-stake, no separate roll — the roll happened; we
    // just offer the ones it cleared. (For a Boon Focus auto-success with no total,
    // or a grant with no roll attached, we roll ONCE here to get a total to check —
    // this is the only case a die is thrown, and it never risks the low-PL cure,
    // which is already done above.)
    const hasTotal = (rollCtx != null) && Number.isFinite(Number(rollCtx.total)) && (rollCtx.total !== null);
    let total = hasTotal ? Number(rollCtx.total) : null;
    let rollNote = hasTotal ? `action roll ${total}` : "";
    if ( !hasTotal ) {
      const invokerDoc = rollCtx?.invokerUuid ? await fromUuid(rollCtx.invokerUuid).catch(() => null) : null;
      const invoker = invokerDoc?.actor ?? invokerDoc;
      if ( invoker ) {
        const score = Math.max(0, Math.floor(Number(invoker.system?.attributes?.[rollCtx.attrKey]?.value ?? 0)));
        const dice = cfg.diceForScore ? cfg.diceForScore(score) : ((cfg.attributeDice ?? {})[score] ?? "");
        const adv = cfg.boonFocus?.(invoker, { boonName: "Restoration", targets: "multiple" })?.advantage ?? 0;
        const roll = await (new Roll(buildFormula(dice, adv))).evaluate();
        await roll.toMessage({
          speaker: ChatMessage.getSpeaker({ actor: invoker }),
          flavor: `Restoration — higher-bane check${adv ? ` <span class="ol-roll-sub">(Boon Focus advantage ${adv})</span>` : ""}`
        });
        total = roll.total;
        rollNote = `dispel roll ${total}`;
      }
    }

    // Which higher banes the roll actually beat (their CR ≤ total). Offer only
    // these — the ones the invocation genuinely reached.
    const highCr = e => 20 + 2 * banePlOf(e);
    const beatable = (total != null) ? high.filter(e => total >= highCr(e)) : [];
    if ( !beatable.length ) {
      // Roll didn't reach any higher bane (or no roll to check): report them as out
      // of reach so it's clear why they weren't offered.
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="ol-boon-applied"><strong>${escape(actor.name)}</strong>'s banes above PL ${pl} are beyond this Restoration${total != null ? ` (${rollNote} did not reach their CR)` : ""}.</div>`
      });
      return;
    }

    const rows = beatable.map(e => `
      <label class="form-group" style="display:flex;gap:6px;align-items:center;">
        <input type="checkbox" name="dispel" value="${e.id}" checked/>
        <span>${escape(e.flags.openlegend.fromBane)} (PL ${banePlOf(e)}) — CR ${highCr(e)} ✓</span>
      </label>`).join("");
    const { DialogV2 } = foundry.applications.api;
    const choice = await DialogV2.wait({
      window: { title: `Restoration - ${actor.name}` },
      content: `
        <p><strong>Restoration</strong> (PL ${pl}) also reached ${beatable.length} bane(s) <em>above</em> PL ${pl}
        — your ${rollNote} met their CR. Dispel any you choose (they're all pre-checked):</p>
        ${rows}`,
      buttons: [
        { action: "dispel", label: "Dispel Selected", icon: "fas fa-hand-sparkles", default: true,
          callback: (event, button) =>
            Array.from(button.form.querySelectorAll("input[name=dispel]:checked")).map(i => i.value) },
        { action: "skip", label: "Skip these", icon: "fas fa-times", callback: () => null }
      ],
      rejectClose: false
    });
    if ( !Array.isArray(choice) || !choice.length ) return; // higher banes left as-is

    const lines = [];
    for ( const id of choice ) {
      const e = actor.effects.get(id);
      if ( !e ) continue;
      const epl = banePlOf(e);
      const what = await cureViaRestoration(actor, e, pl);
      lines.push(`${what} — <span class="ol-aura-hit">dispelled</span> (${rollNote} vs CR ${20 + 2 * epl})`);
    }
    if ( lines.length ) {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="ol-boon-applied"><strong>Restoration</strong> also dispels on <strong>${escape(actor.name)}</strong>:<br/>${lines.join("<br/>")}</div>`
      });
    }
  } catch ( error ) {
    console.error(error);
    ui.notifications?.error("Restoration dispel error.");
  }
}

/**
 * Apply the "Nullify Boon Cancelation" blocker to a nullified target: for 1
 * minute (10 rounds) the canceled boon cannot be granted to them again. The
 * effect template comes from the system's `effects` compendium pack (so a GM
 * can restyle it there); a missing pack falls back to an inline equivalent.
 * The canceled boon's name is stamped into flags.openlegend.blocksBoon — the
 * guard in applyBoonToActor refuses to grant a boon whose name matches a
 * still-running blocker.
 * @param {Actor} actor      The nullified target.
 * @param {string} boonName  The canceled boon's name (blank → no-op).
 * @returns {Promise<void>}
 */
async function applyNullifyBlocker(actor, boonName) {
  if ( !boonName ) return;
  let data = null;
  try {
    const pack = game.packs?.get("tomucatos-open-legend-rpg-system.effects");
    const entry = pack ? (await pack.getIndex()).find(i => i.name === "Nullify Boon Cancelation") : null;
    const item = entry ? await pack.getDocument(entry._id) : null;
    const src = (item?.effects?.contents ?? []).find(e => !e.disabled);
    if ( src ) {
      data = src.toObject();
      delete data._id;
    }
  } catch ( _err ) { /* pack unavailable → inline fallback below */ }
  data ??= {
    name: "Nullify Boon Cancelation",
    type: "base",
    img: "icons/svg/cancel.svg",
    disabled: false,
    transfer: false,
    showIcon: 2, /* CONST.ACTIVE_EFFECT_SHOW_ICON.ALWAYS */
    duration: { seconds: 60, rounds: 10 },
    description: "<p>This boon has been canceled by Nullify: the bearer cannot benefit from it or have it invoked upon them again for 1 minute.</p>",
    system: { changes: [] },
    flags: { openlegend: {} }
  };
  data.name = `${boonName} Canceled (Nullify)`;
  data.flags ??= {};
  data.flags.openlegend = {
    ...(data.flags.openlegend ?? {}),
    blocksBoon: boonName,
    fromEffectItem: "Nullify Boon Cancelation"
  };
  await actor.createEmbeddedDocuments("ActiveEffect", [data]);
  ui.notifications?.info(`${boonName} is nullified on ${actor.name} for 1 minute.`);
}