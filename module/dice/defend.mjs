/**
 * Open Legend "Defend" interrupt resolution.
 *
 * Every damaging / bane attack chat card carries an "Interrupt?" button. Clicking
 * it opens a dialog where the user picks:
 *   1. a defending actor (a player sees only actors they own; a GM sees all),
 *   2. which of the attack's targets is being defended (a defend covers one
 *      target — self or an ally), and
 *   3. one of that actor's Defend-type interrupt actions to roll.
 *
 * The defend action is rolled with its own attribute via the standard roll
 * dialog, seeded with an itemized source list (the action's own modifiers, the
 * configured Defensive weapon's advantage, Active Effect modifiers). If the
 * defend roll beats the defended target's defense score, the roll REPLACES that
 * defense for this attack only; we post a follow-up chat message re-resolving the
 * hit/miss (and damage, for a damaging attack) against the raised defense. The
 * original attack card is left untouched.
 *
 * Per the rules: "If your attribute roll is higher than the targeted defense
 * score, then your roll replaces the targeted defense score for that attack
 * only." A tie does not replace (must be strictly higher).
 */
import { openRollDialog, actorRollModifiers } from "./roll-dialog.mjs";
import { renderApplyAimButtons, renderInterruptButton } from "./action-roll.mjs";

const { DialogV2 } = foundry.applications.api;

/* -------------------------------------------- */

/**
 * Resolve a token UUID to its actor instance. Crucially uses the TOKEN's actor
 * (synthetic for unlinked tokens), which is where that token's own items — and
 * thus its defend actions — actually live. Falls back to null.
 * @param {string} tokenUuid
 * @returns {Actor|null}
 */
function actorFromTokenUuid(tokenUuid) {
  const doc = foundry.utils.fromUuidSync(tokenUuid, { strict: false });
  return doc?.actor ?? (doc?.documentName === "Actor" ? doc : null);
}

/**
 * The candidate defenders for an attack: the actors behind the attack's targets
 * (resolved from each target token, so unlinked-token actors are used), plus the
 * current user's other owned world actors (an ally not targeted can still step
 * in). For a player, only actors they own are offered; a GM may use any. Each
 * entry pairs the resolved actor with the index of the attack target it defends
 * by default (the target it came from, or the first target for non-target allies).
 * Deduplicated by actor id.
 * @param {Array} results  The attack's per-target result rows.
 * @returns {Array<{actor: Actor, defaultTargetIdx: number, isTarget: boolean}>}
 */
function candidateDefenders(results) {
  const isGM = !!game.user?.isGM;
  const seen = new Set();
  const out = [];

  // 1) The attack's targets, in order — these are the natural defenders.
  results.forEach((r, idx) => {
    const actor = actorFromTokenUuid(r.tokenUuid);
    if ( !actor || seen.has(actor.id) ) return;
    if ( !isGM && !actor.isOwner ) return;
    seen.add(actor.id);
    out.push({ actor, defaultTargetIdx: idx, isTarget: true });
  });

  // 2) Other controllable actors (allies who could defend a target). They default
  //    to defending the first target.
  const world = game.actors?.contents ?? [];
  for ( const actor of world ) {
    if ( seen.has(actor.id) ) continue;
    if ( !isGM && !actor.isOwner ) continue;
    seen.add(actor.id);
    out.push({ actor, defaultTargetIdx: 0, isTarget: false });
  }
  return out;
}

/**
 * The Defend-type interrupt actions owned by an actor.
 * @param {Actor} actor
 * @returns {Item[]}
 */
function defendActions(actor) {
  return (actor?.items?.contents ?? []).filter(i =>
    (i.type === "action") &&
    (i.system?.actionCategory === "interrupt") &&
    // Treat a missing interruptType as "defend" (the schema default), so interrupt
    // actions created before the Type field existed still appear.
    ((i.system?.interruptType ?? "defend") === "defend")
  );
}

/* -------------------------------------------- */

/**
 * Open the Interrupt / Defend dialog for an attack chat message and run the
 * chosen defend. Reads the attack's per-target results from the message flags.
 * @param {ChatMessage} message  The attack chat message bearing actionResult flags.
 * @returns {Promise<void>}
 */
export async function openDefendDialog(message) {
  const data = message?.flags?.openlegend?.actionResult;
  const results = data?.results ?? [];
  if ( !results.length ) {
    ui.notifications?.warn("This attack has no resolved targets to defend.");
    return;
  }

  const candidates = candidateDefenders(results);
  if ( !candidates.length ) {
    ui.notifications?.warn("You have no actor to defend with.");
    return;
  }

  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;

  // Pre-select the defended target as the defender: the first candidate that is
  // itself one of the attack's targets (e.g. test3 was attacked → test3 defends
  // itself). Falls back to the first candidate.
  const initialIdx = Math.max(0, candidates.findIndex(c => c.isTarget));

  // Defender select: one option per candidate, keyed by candidate index.
  const actorOptions = candidates.map((c, i) =>
    `<option value="${i}"${i === initialIdx ? " selected" : ""}>${esc(c.actor.name)}</option>`
  ).join("");

  // Defending (which attacked target gets the raised defense). The default is set
  // per-defender in refresh().
  const targetOptions = results.map((r, i) =>
    `<option value="${i}">${esc(r.name)} (${esc(r.defenseLabel)} ${r.defenseValue})</option>`
  ).join("");

  const content = `
    <div class="ol-defend-dialog">
      <div class="ol-defend-row">
        <label>Defender</label>
        <select name="candidateIdx">${actorOptions}</select>
      </div>
      <div class="ol-defend-row">
        <label>Defending</label>
        <select name="targetIdx">${targetOptions}</select>
      </div>
      <div class="ol-defend-row">
        <label>Defend Action</label>
        <select name="actionId" data-defend-action></select>
      </div>
      <p class="ol-defend-hint" data-defend-hint></p>
    </div>`;

  // Populate the defend-action select for the currently-chosen defender, refresh
  // the hint, and (when the defender changed) snap the "Defending" target to that
  // defender's own target if it has one.
  const refresh = (root, { syncTarget = false } = {}) => {
    const ci = Number(root.querySelector('select[name="candidateIdx"]')?.value);
    const cand = candidates[ci];
    const actor = cand?.actor ?? null;
    if ( syncTarget && cand ) {
      const tsel = root.querySelector('select[name="targetIdx"]');
      if ( tsel ) tsel.value = String(cand.defaultTargetIdx);
    }
    const sel = root.querySelector("[data-defend-action]");
    const hint = root.querySelector("[data-defend-hint]");
    const defends = defendActions(actor);
    sel.innerHTML = defends.length
      ? defends.map(a => {
          const attrKey = a.system?.attribute;
          const attrLabel = CONFIG.OPENLEGEND?.attributeLabels?.[attrKey] ?? attrKey;
          return `<option value="${a.id}">${esc(a.name)} (${esc(attrLabel)})</option>`;
        }).join("")
      : "";
    sel.disabled = !defends.length;
    if ( hint ) {
      hint.textContent = defends.length
        ? "If the defend roll beats the target's defense, it replaces that defense for this attack."
        : `${actor?.name ?? "This actor"} has no Defend interrupt actions — pressing Defend will do nothing.`;
    }
  };

  const choice = await DialogV2.wait({
    window: { title: "Interrupt — Defend" },
    classes: ["openlegend", "ol-defend-dialog-app"],
    content,
    rejectClose: false,
    buttons: [
      {
        action: "defend",
        label: "Defend",
        icon: "fas fa-shield-halved",
        default: true,
        callback: (event, button, dialog) => {
          const root = dialog.element;
          return {
            candidateIdx: Number(root.querySelector('select[name="candidateIdx"]')?.value),
            targetIdx: Number(root.querySelector('select[name="targetIdx"]')?.value),
            actionId: root.querySelector('select[name="actionId"]')?.value
          };
        }
      },
      { action: "cancel", label: "Cancel", icon: "fas fa-times" }
    ],
    render: (event, dialog) => {
      const root = dialog.element;
      // Changing the defender re-lists their defend actions and snaps the
      // defended target to that defender's own target (when it is one).
      root.querySelector('select[name="candidateIdx"]')?.addEventListener("change", () => refresh(root, { syncTarget: true }));
      // Initial fill also sets the defended target to the pre-selected defender's.
      refresh(root, { syncTarget: true });
    }
  });

  if ( !choice || (typeof choice !== "object") || !choice.actionId ) return;

  const actor = candidates[choice.candidateIdx]?.actor ?? null;
  const action = actor?.items.get(choice.actionId);
  const target = results[choice.targetIdx];
  if ( !actor || !action || !target ) {
    ui.notifications?.warn("Could not resolve the defend action or target.");
    return;
  }
  return rollDefend({ message, actor, action, target });
}

/* -------------------------------------------- */

/**
 * Roll a defend action and post the follow-up result. If the defend roll beats
 * the defended target's defense, the roll replaces that defense for this attack:
 * the hit/miss (and damage, for a damaging attack) is re-resolved against the
 * raised defense and announced; a damaging hit carries an Apply Damage button.
 * @param {object} args
 * @param {ChatMessage} args.message  The original attack message.
 * @param {Actor} args.actor          The defending actor.
 * @param {Item} args.action          The defend interrupt action.
 * @param {object} args.target        The defended target's result row.
 * @returns {Promise<ChatMessage|void>}
 */
async function rollDefend({ message, actor, action, target }) {
  const cfg = CONFIG.OPENLEGEND ?? {};
  const attrKey = action.system?.attribute;
  const score = Math.max(0, Math.min(9, Number(actor.system?.attributes?.[attrKey]?.value ?? 0)));
  const bonusDice = (cfg.attributeDice ?? {})[score] ?? "";
  const attrLabel = cfg.attributeLabels?.[attrKey] ?? attrKey;

  // Roll via the standard dialog, seeded from an itemized source list (the
  // dialog shows the breakdown): the action's own adv/disadv, the wielded
  // Defensive weapon's bonus (advantage equal to its Defensive value, capped
  // at 3 — configured on the action sheet via system.weaponId), and any
  // general-roll Active Effect modifiers on the defender.
  const sources = [];
  if ( Number(action.system?.advantage ?? 0) > 0 ) sources.push({ label: "Action", advantage: Number(action.system.advantage) });
  if ( Number(action.system?.disadvantage ?? 0) > 0 ) sources.push({ label: "Action", disadvantage: Number(action.system.disadvantage) });
  if ( action.system?.weaponId ) {
    const cfg = CONFIG.OPENLEGEND ?? {};
    const weapon = actor.items.get(action.system.weaponId);
    // Defensive Mastery raises the effective Defensive value by 1 (1→2, 2→3).
    const v = (weapon?.type === "weapon") ? (cfg.effectiveDefensiveValue ? cfg.effectiveDefensiveValue(weapon, actor) : 0) : 0;
    if ( v > 0 ) {
      const masteryTag = (cfg.hasDefensiveMastery && cfg.hasDefensiveMastery(actor)) ? " + Mastery" : "";
      sources.push({
        label: `Defensive weapon${masteryTag} (${weapon.name})`,
        advantage: v
      });
    }
  }
  // Defensive Reflexes (feat): advantage 1 per tier on the defend roll.
  {
    const cfg = CONFIG.OPENLEGEND ?? {};
    const dr = cfg.defensiveReflexesAdvantage ? cfg.defensiveReflexesAdvantage(actor) : 0;
    if ( dr > 0 ) sources.push({ label: `Defensive Reflexes (tier ${dr})`, advantage: dr });
  }
  sources.push(...actorRollModifiers(actor));

  const choice = await openRollDialog({
    title: `${action.name} — Defend`,
    bonusDice,
    sources,
    legend: cfg.legendSpendContext?.(actor)
  });
  if ( !choice ) return;

  const roll = await (new Roll(choice.formula, actor.getRollData())).evaluate();
  await cfg.spendLegendPoints?.(actor, choice.legendPoints);
  const defenseValue = Number(target.defenseValue);
  // Strictly higher replaces the defense (a tie does not).
  const replaced = roll.total > defenseValue;
  const newDefense = replaced ? roll.total : defenseValue;

  // Re-resolve the attack against the (possibly raised) defense. The attack roll
  // total is the defended target's recorded `total`.
  const attackTotal = Number(target.total);

  // Battlefield Retribution (feat): the defender deals damage to the ATTACKER
  // equal to how much the defend roll exceeds the attacker's roll. Resolve the
  // attacker's token (preferred — so the damage card's apply button is bound) and
  // actor from the original attack message.
  const retributionDamage = (cfg.hasBattlefieldRetribution?.(actor) && (roll.total > attackTotal))
    ? (roll.total - attackTotal) : 0;
  const sp = message?.speaker ?? {};
  const attackerTokenUuid = (sp.scene && sp.token) ? `Scene.${sp.scene}.Token.${sp.token}` : "";
  const attackerName = sp.alias || message?.flags?.openlegend?.actionResult?.retarget?.rollerName || "the attacker";
  const hit = attackTotal >= newDefense;
  const isDamaging = !target.isBane;          // bane rows carry isBane:true
  const damage = (isDamaging && hit) ? Math.max(0, attackTotal - newDefense) : 0;

  // Margin-bane rider: a damaging attack that STILL hits after the raised defense
  // can also apply a bane if its (re-resolved) margin over the new defense is 10+
  // (or 5+ for a Bane Focus bane). This mirrors the original attack card's "+ Bane"
  // control — the raised defense simply lowers the margin. The attacker's context
  // (uuid / attribute / score) rides in the original message's retarget snapshot.
  const retarget = message?.flags?.openlegend?.actionResult?.retarget ?? {};
  const attackerActor = retarget.actorUuid ? await fromUuid(retarget.actorUuid) : null;
  const attackerActorDoc = attackerActor?.actor ?? attackerActor;
  const hasBaneFocus = !!(cfg.baneFocusNames && attackerActorDoc && cfg.baneFocusNames(attackerActorDoc).size);
  const minBaneMargin = hasBaneFocus ? 5 : 10;
  const reMargin = isDamaging && hit ? (attackTotal - newDefense) : -Infinity;
  const canApplyBane = isDamaging && hit && !!retarget.actorUuid && (reMargin >= minBaneMargin);

  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
  const damageType = target.damageType ? esc(target.damageType) : "";

  // Build the follow-up content (structured like the action-card header:
  // title line, muted context line, tag pills — see .ol-card-head styles).
  const header = `<span class="ol-card-head">`
    + `<span class="ol-card-title">${esc(actor.name)} defends ${esc(target.name)}</span>`
    + `<span class="ol-card-sub">${esc(attrLabel)} · ${esc(action.name)}</span>`
    + (choice.legendPoints > 0 ? `<span class="ol-card-tags"><span class="ol-tag ol-tag-legend" title="Legend Points spent: each grants advantage 1 and +1 to the result."><i class="fas fa-star"></i> Legend Points: ${choice.legendPoints}</span></span>` : "")
    + `</span>`;

  let body;
  if ( replaced ) {
    // The defense was raised. Show the new value and the re-resolved outcome.
    const outcome = hit
      ? (isDamaging
          ? `Attack still hits for <strong>${damage}</strong>${damageType ? ` ${damageType}` : ""} damage.`
          : `Attack still hits.`)
      : `Attack is warded off — <span class="ol-hit">Miss</span>.`;
    let apply = "";
    if ( game.user?.isGM && isDamaging && hit && (damage > 0) ) {
      const applyId = foundry.utils.randomID?.() ?? `ol-def-${target.tokenUuid}-${damage}`;
      let buttons = `<button type="button" class="ol-apply-damage ol-apply-mini"`
        + ` data-apply-id="${applyId}" data-token-uuid="${esc(target.tokenUuid)}" data-damage="${damage}"`
        + ` data-damage-type="${damageType}" data-tooltip="Apply ${damage}${damageType ? ` ${damageType}` : ""}">`
        + `<i class="fas fa-heart-crack"></i> ${damage}</button>`;
      // "+ Bane" (margin rider): the still-hitting attack's margin over the RAISED
      // defense qualifies (10+, or 5+ for a Bane Focus bane). Opens the attacker's
      // bane picker — same control as the original attack card, re-gated on the
      // lowered margin. Bound to the attacker's context from the retarget snapshot.
      if ( canApplyBane ) {
        const aScore = Number(retarget.attrScore) || 0;
        const aKey = retarget.attrKey ?? "";
        buttons += `<button type="button" class="ol-attack-bane ol-apply-mini"`
          + ` data-actor-uuid="${esc(retarget.actorUuid)}" data-token-uuid="${esc(target.tokenUuid)}"`
          + ` data-attr-score="${aScore}" data-attr-key="${esc(aKey)}" data-total="${attackTotal}" data-margin="${reMargin}"`
          + ` data-tooltip="Margin ${reMargin}: apply a bane (PL ≤ ${aScore}; margin 10+, or 5+ for a Bane Focus bane)">`
          + `<i class="fas fa-skull-crossbones"></i> + Bane</button>`;
      }
      apply = `<div class="ol-defend-apply">${buttons}</div>`;
    }
    body = `<div class="ol-defend-line">Roll <strong>${roll.total}</strong> &gt; ${esc(target.defenseLabel)} `
      + `${defenseValue} — defense raised to <strong>${newDefense}</strong> for this attack.</div>`
      + `<div class="ol-defend-line">${outcome}</div>${apply}`;
  } else {
    // Roll did not beat the defense: no change.
    body = `<div class="ol-defend-line">Roll <strong>${roll.total}</strong> &le; ${esc(target.defenseLabel)} `
      + `${defenseValue} — the defend fails; defense is unchanged.</div>`;
  }

  // Battlefield Retribution rider: a damage block dealing (defend roll − attacker
  // roll) to the attacker, with a bound Apply button (when the attacker token is
  // known) plus the 🎯/▢ aim icons to re-aim at the current target/selection.
  let retribution = "";
  if ( retributionDamage > 0 ) {
    const applyId = foundry.utils.randomID?.() ?? `ol-retrib-${attackerTokenUuid}-${retributionDamage}`;
    const boundApply = attackerTokenUuid
      ? `<button type="button" class="ol-apply-damage ol-apply-mini" data-apply-id="${applyId}"`
        + ` data-token-uuid="${esc(attackerTokenUuid)}" data-damage="${retributionDamage}" data-damage-type=""`
        + ` data-tooltip="Apply ${retributionDamage} damage to ${esc(attackerName)}">`
        + `<i class="fas fa-heart-crack"></i> Apply ${retributionDamage}</button>`
      : "";

    // Battlefield Punisher (feat): when ≥10 retribution damage is dealt with an
    // attribute that could inflict the chosen bane, you MAY afflict the attacker
    // with it — a "Punish" button (the chat hook posts the chosen-bane card).
    let punish = "";
    if ( retributionDamage >= 10 ) {
      const punisherBane = await (cfg.battlefieldPunisherBane?.(actor, attrKey) ?? "");
      if ( punisherBane ) {
        punish = `<button type="button" class="ol-defend-punish ol-apply-mini" data-actor-uuid="${esc(actor.uuid)}"`
          + ` data-token-uuid="${esc(attackerTokenUuid)}" data-bane-name="${esc(punisherBane)}" data-attr-score="${score}"`
          + ` data-attacker-name="${esc(attackerName)}" data-tooltip="Battlefield Punisher: afflict ${esc(attackerName)} with ${esc(punisherBane)}">`
          + `<i class="fas fa-skull-crossbones"></i> Punish: ${esc(punisherBane)}</button>`;
      }
    }

    retribution = `<div class="ol-defend-line ol-retribution">`
      + `<i class="fas fa-burst"></i> <strong>Battlefield Retribution</strong> — `
      + `${esc(attackerName)} takes <strong>${retributionDamage}</strong> damage `
      + `(defend roll ${roll.total} − attack roll ${attackTotal}).`
      + `</div>`
      + `<div class="ol-defend-apply ol-retribution-apply">${boundApply}${renderApplyAimButtons("damage", retributionDamage, "")}${punish}</div>`;
  }

  // Re-interrupt: if the attack STILL hits after this defend, another actor may
  // interrupt in turn (Open Legend allows multiple defenders). We do NOT gate who
  // has already interrupted — players track that themselves. Surface an "Interrupt?"
  // button and give this card its own actionResult snapshot so openDefendDialog can
  // re-resolve against the RAISED defense (the next defend must beat `newDefense`).
  let reInterrupt = "";
  let reFlags = null;
  if ( hit ) {
    const nextRow = {
      ...target,
      defenseValue: newDefense,
      // A further defend re-resolves against this raised defense; damage/margin are
      // recomputed there from `total` vs the (possibly higher) defense.
      damage,
      canApplyBane,
      baneMargin: isDamaging ? reMargin : target.baneMargin
    };
    reInterrupt = renderInterruptButton();
    // Carry the original attacker context so the next defend's own card can, in
    // turn, offer the margin-bane rider and chain further interrupts.
    reFlags = { openlegend: { actionResult: { results: [nextRow], retarget } } };
  }

  const flavor = `<div class="ol-defend-card">${header}</div>${body}${retribution}${reInterrupt}`;
  const messageData = {
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor
  };
  if ( reFlags ) messageData.flags = reFlags;
  return roll.toMessage(messageData);
}
