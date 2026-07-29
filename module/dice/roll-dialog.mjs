/**
 * Open Legend roll dialog & formula builder.
 *
 * Advantage / disadvantage in Open Legend modifies only the *bonus* (attribute)
 * dice, never the d20. Net = advantage − disadvantage (they cancel out). For a
 * bonus term of `N` dice:
 *   - net advantage A  → roll N+A dice, keep the N HIGHEST
 *   - net disadvantage D → roll N+D dice, keep the N LOWEST
 * Every die that is *kept* (and the d20) explodes recursively on its maximum.
 *
 * The keep/explode interaction relies on Foundry resolving die modifiers
 * left-to-right: `kh{N}x` keeps first (marking dropped dice inactive) and then
 * explodes, and Die#explode skips inactive results — so only the kept dice
 * explode. See foundry Die#keep / Die#explode.
 */

const { DialogV2 } = foundry.applications.api;

/**
 * Parse a single bonus-dice term like "2d6" or "3d8" into its parts.
 * @param {string} dice  e.g. "2d6"; "" for a score-0 attribute (no bonus dice).
 * @returns {{count: number, faces: number}|null}
 */
function parseBonusDice(dice) {
  const m = /^\s*(\d+)\s*d\s*(\d+)\s*$/i.exec(dice ?? "");
  if ( !m ) return null;
  return { count: Number(m[1]), faces: Number(m[2]) };
}

/**
 * The explode modifier for a die of `faces` sides. Normally `x` (explode on max).
 * Destructive Trance (the `explodeBelowMax` option) explodes on max OR one below —
 * `x>=N-1` (d4→x>=3, d6→x>=5, d8→x>=7, d20→x>=19) — while the rolled value still
 * counts as itself (Foundry's compound `x>=` adds an extra die without changing the
 * original result).
 * @param {number} faces
 * @param {boolean} below
 * @returns {string}
 */
function explodeMod(faces, below) {
  return below ? `x>=${Math.max(2, faces - 1)}` : "x";
}

/**
 * Build an Open Legend roll formula from a bonus-dice spec and a net advantage.
 * The d20 always explodes; the bonus dice keep/explode per the net adv/disadv.
 * @param {string} bonusDice   The attribute's bonus dice, e.g. "2d6" or "" (none).
 * @param {number} net         Net advantage (positive) or disadvantage (negative).
 * @param {object} [opts]
 * @param {boolean} [opts.explodeBelowMax]  Destructive Trance: every die explodes
 *        on its maximum OR the value one below (d6 on 5–6, d8 on 7–8, …).
 * @param {number} [opts.extraD20]  Extra d20s rolled alongside the base d20,
 *        keeping only the highest (e.g. Guided Weapons: "1d20x" → "2d20kh1x").
 *        Distinct from advantage, which affects the BONUS dice when any exist.
 * @returns {string}           A Foundry roll formula, e.g. "1d20x + 5d6kh2x".
 */
export function buildFormula(bonusDice, net = 0, { explodeBelowMax = false, extraD20 = 0 } = {}) {
  const bonus = parseBonusDice(bonusDice);
  const d20x = explodeMod(20, explodeBelowMax);
  const d20Extra = Math.max(0, Math.floor(Number(extraD20) || 0));

  // Score 0 (no bonus dice): advantage/disadvantage applies to the d20 itself —
  // roll extra d20s and keep the best (advantage) or worst (disadvantage). An
  // extraD20 is exactly a d20 advantage here, so it folds into the net. With
  // no net, it's a single exploding d20. The kept d20 still explodes on a 20.
  if ( !bonus ) {
    const effNet = net + d20Extra;
    if ( effNet === 0 ) return `1d20${d20x}`;
    const pool = 1 + Math.abs(effNet);
    const dir = effNet > 0 ? "kh" : "kl";
    // Keep BEFORE explode so only the kept d20 explodes.
    return `${pool}d20${dir}1${d20x}`;
  }

  // Skilled attribute: the d20 always explodes; adv/disadv applies to the bonus
  // dice, rolling extra and keeping the original count (highest / lowest). An
  // extraD20 widens the d20 pool itself, keeping the single highest.
  const d20 = d20Extra > 0 ? `${1 + d20Extra}d20kh1${d20x}` : `1d20${d20x}`;
  const { count, faces } = bonus;
  const bx = explodeMod(faces, explodeBelowMax);
  if ( net === 0 ) return `${d20} + ${count}d${faces}${bx}`;

  const extra = Math.abs(net);
  const pool = count + extra;
  const dir = net > 0 ? "kh" : "kl"; // advantage keeps highest, disadvantage lowest
  // Keep BEFORE explode so only the kept dice explode.
  return `${d20} + ${pool}d${faces}${dir}${count}${bx}`;
}

/**
 * Collect roll modifiers granted by Active Effects on an actor, read from the
 * adv/dis flags those effects write (see OpenLegendActiveEffect.resolveTarget):
 *   - flags.openlegend.rollMod          net adv/dis on EVERY action roll
 *   - flags.openlegend.attackMod        net adv/dis on attack rolls only
 *   - flags.openlegend.nonAttackMod     net adv/dis on every NON-attack roll
 *                                       (attribute checks, boons, interrupts)
 *   - flags.openlegend.attrMod[<attr>]  net adv/dis on rolls with that attribute
 * Each flag is a signed integer (positive = advantage, negative = disadvantage)
 * accumulated by the effects' ADD changes. Returns one labeled source per
 * non-zero applicable flag, ready for openRollDialog's `sources`.
 * @param {Actor|null} actor
 * @param {object} [options]
 * @param {boolean} [options.attack]    Include the attack-scoped flag.
 * @param {string}  [options.attribute] The rolled attribute key (for attrMod).
 * @returns {Array<{label: string, advantage?: number, disadvantage?: number}>}
 */
export function actorRollModifiers(actor, { attack = false, attribute = null } = {}) {
  const f = actor?.flags?.openlegend ?? {};
  const out = [];
  const push = (label, net) => {
    const n = Number(net ?? 0);
    if ( n > 0 ) out.push({ label, advantage: n });
    else if ( n < 0 ) out.push({ label, disadvantage: -n });
  };
  // Current model: signed net flags written by the new Adv/Dis modifier.
  push("Active effects", f.rollMod);
  if ( attribute ) {
    const attr = CONFIG.OPENLEGEND?.attributeLabels?.[attribute] ?? attribute;
    push(`Active effects (${attr})`, f.attrMod?.[attribute]);
    // Extraordinary item granting Advantage on the actor's OWN attribute: when
    // the actor's score leads its item attribute by 1–2, the item gives up its
    // (lower) score and instead grants Advantage 1 on rolls with their own. That
    // advantage applies to the NORMAL attribute roll too — seed it here, sourced
    // to the item so the player sees where it comes from.
    const ia = (actor?.system?.itemAttributes ?? []).find(a => (a.key === attribute) && (a.mode === "own+adv"));
    if ( ia?.advantage > 0 ) push(`Extraordinary item (${ia.source})`, ia.advantage);
  }
  if ( attack ) push("Active effects (attacks)", f.attackMod);
  // Non-attack scope: every action roll EXCEPT an attack (attribute checks, boon
  // invocations, interrupt/defend rolls). Skipped when this is an attack roll.
  else push("Active effects (non-attack)", f.nonAttackMod);
  // Mount/vehicle damage level (SRD Damage Threshold): disadvantage equal to the
  // current damage level on ALL of the mount's action rolls.
  const mountDamage = CONFIG.OPENLEGEND?.mountDamageState?.(actor);
  if ( mountDamage?.level > 0 ) {
    push(`Damage level ${mountDamage.level}`, -mountDamage.level);
  }
  // Back-compat: conditions applied before the modifier redesign wrote separate
  // positive advantage / disadvantage flags. Fold them in so old effects on
  // existing actors keep working until re-applied.
  push("Active effects", Number(f.advantage ?? 0) - Number(f.disadvantage ?? 0));
  if ( attack ) push("Active effects (attacks)", Number(f.advantageAttack ?? 0) - Number(f.disadvantageAttack ?? 0));
  return out;
}

/**
 * Open the Open Legend roll dialog. Lets the user adjust advantage and
 * disadvantage (which cancel to a net) and shows a live preview of the
 * resolved formula before rolling.
 *
 * @param {object} options
 * @param {string} options.title          Dialog/window title, e.g. "Agility Action".
 * @param {string} options.bonusDice      The attribute's bonus dice, e.g. "2d6" (or "").
 * @param {number} [options.advantage]    Starting advantage (e.g. from an action). Default 0.
 * @param {number} [options.disadvantage] Starting disadvantage. Default 0.
 * @param {Array<{label: string, advantage?: number, disadvantage?: number}>} [options.sources]
 *        Itemized advantage / disadvantage sources. When given, they are BOTH
 *        rendered as a breakdown in the dialog AND summed into the starting
 *        advantage / disadvantage (the `advantage` / `disadvantage` params are
 *        ignored) — one source of truth, so the player sees exactly how the
 *        seeded values came to be. The steppers adjust on top as usual.
 * @param {Array<{name: string, label: string, title?: string, advantage?: number, checked?: boolean}>} [options.extraToggles]
 *        Optional checkboxes shown above the adv/dis steppers (e.g. Lethal Strike).
 *        Checking one adds its `advantage` to the live net; each toggle's on/off
 *        state is returned on the result keyed by its `name`.
 * @param {{available: number, max: number}|null} [options.legend]
 *        Legend Points the roller may spend (PC only). `available` is the actor's
 *        current pool, `max` the per-roll cap (level + 1). A stepper 0..min(both)
 *        appears; each point spent adds advantage 1 AND a flat +1 to the result.
 *        The chosen count is returned as `legendPoints` so the caller can deduct it.
 * @param {object|null} [options.targeting]
 *        Live targeting controls (world setting "dialogTargeting"): lets the roller
 *        change the targeting mode / target count / area (or summon count) on the
 *        fly, with the multi-targeting disadvantage recomputed as they do. Fields:
 *        `targets` ("single"/"multiple"/"area"/"summon"), `targetCount`,
 *        `summonCount`, `area` ({shape,length,lines}), `summon` (true locks the UI
 *        to a summon-count stepper), `areaShapes` ({key: label}), and `compute(t)`
 *        — a callback returning `{disadvantage, raw, reduction, reductionLabel}`
 *        for a candidate targeting `t` (the caller owns the rules math, feats
 *        included). The derived disadvantage is folded into the live net and the
 *        chosen targeting is returned as `targeting` on the result.
 * @returns {Promise<{formula: string, advantage: number, disadvantage: number, net: number, legendPoints: number, targeting?: object, [toggle:string]: boolean}|null>}
 *          The chosen roll spec, or null if the dialog was dismissed.
 */
export async function openRollDialog({ title, bonusDice, advantage = 0, disadvantage = 0, sources = null, explodeBelowMax = false, extraD20 = 0, extraToggles = [], legend = null, augmentOptions = [], targeting = null }) {
  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
  const hasBonus = !!parseBonusDice(bonusDice);
  // Starting adv/disadv: derived from the itemized sources when provided, else
  // the bare seed params. Clamped non-negative.
  const srcAdv = (sources ?? []).reduce((s, m) => s + Math.max(0, Number(m.advantage ?? 0)), 0);
  const srcDis = (sources ?? []).reduce((s, m) => s + Math.max(0, Number(m.disadvantage ?? 0)), 0);
  const startAdv = sources ? srcAdv : Math.max(0, Math.floor(Number(advantage) || 0));
  const startDis = sources ? srcDis : Math.max(0, Math.floor(Number(disadvantage) || 0));

  // Breakdown of every modifier source, so the player knows how the starting
  // advantage / disadvantage were assembled before adjusting them.
  const sourceRows = (sources ?? []).map(m => {
    const adv = Math.max(0, Number(m.advantage ?? 0));
    const dis = Math.max(0, Number(m.disadvantage ?? 0));
    const parts = [];
    if ( adv ) parts.push(`<strong class="ol-src-adv">+${adv} Adv</strong>`);
    if ( dis ) parts.push(`<strong class="ol-src-dis">&minus;${dis} Dis</strong>`);
    // Informational source (no adv/dis), e.g. Guided Weapons' extra d20.
    if ( m.note ) parts.push(`<strong class="ol-src-adv">${esc(m.note)}</strong>`);
    if ( !parts.length ) return "";
    return `<li class="ol-source-row"><span class="ol-source-label">${esc(m.label)}</span><span class="ol-source-vals">${parts.join(" ")}</span></li>`;
  }).filter(Boolean).join("");
  const sourcesBlock = sourceRows ? `
      <div class="ol-roll-row">
        <label>Modifiers</label>
        <ul class="ol-roll-sources">${sourceRows}</ul>
      </div>` : "";

  // Optional toggle checkboxes (e.g. Lethal Strike): checking one adds its
  // advantage to the live net and flags the roll. Rendered above the steppers.
  const toggles = (extraToggles ?? []).filter(t => t?.name);
  const togglesBlock = toggles.length ? `
      <div class="ol-roll-row ol-roll-toggles">
        ${toggles.map(t => `
          <label class="ol-roll-toggle" ${t.title ? `title="${esc(t.title)}"` : ""}>
            <input type="checkbox" name="${esc(t.name)}" data-toggle-adv="${Math.max(0, Number(t.advantage ?? 0))}" ${t.checked ? "checked" : ""}/>
            <span>${esc(t.label)}</span>
          </label>`).join("")}
      </div>` : "";

  // Available augmentations (Augmenting extraordinary items): pick an item + one of
  // its banes to ride this damaging attack (delivered on a hit). Expended on Roll.
  const augItems = (augmentOptions ?? []).filter(a => a?.itemId && (a.banes ?? []).length);
  const augmentBlock = augItems.length ? `
      <div class="ol-roll-row ol-roll-augment">
        <label title="Augmenting items you own: pick one and one of its banes to deliver with this attack (on a hit). Using it expends the item.">Augmentation</label>
        <div class="ol-augment-controls">
          <select class="ol-augment-item">
            <option value="">— none —</option>
            ${augItems.map(a => `<option value="${esc(a.itemId)}">${esc(a.itemName)}</option>`).join("")}
          </select>
          <select class="ol-augment-bane" disabled><option value="">—</option></select>
        </div>
      </div>` : "";

  // Live targeting controls (see options.targeting): a mode select with
  // contextual inputs (target count / area shape+size), or a summon-count input
  // for a summon invocation. The multi-targeting disadvantage is recomputed via
  // targeting.compute on every change and folded into the net (state.targetingDis).
  const tgt = (targeting && (typeof targeting.compute === "function")) ? targeting : null;
  const tgtShapes = tgt ? (tgt.areaShapes ?? { cone: "Cone", line: "Line", cube: "Cube" }) : {};
  const tgtState = tgt ? {
    targets: tgt.summon ? "summon"
      : (["single", "multiple", "area"].includes(tgt.targets) ? tgt.targets : "single"),
    targetCount: Math.max(1, Math.floor(Number(tgt.targetCount) || 1)),
    summonCount: Math.max(1, Math.floor(Number(tgt.summonCount) || 1)),
    area: {
      shape: ((tgt.area?.shape ?? "") in tgtShapes) ? tgt.area.shape : (Object.keys(tgtShapes)[0] ?? "cone"),
      length: Math.max(5, Math.floor(Number(tgt.area?.length) || 5)),
      lines: Math.max(1, Math.floor(Number(tgt.area?.lines) || 1))
    }
  } : null;
  // The candidate targeting in the caller's shape (a line area carries its line
  // count, other shapes a length) — fed to compute() and returned on the result.
  const currentTargeting = () => tgt.summon
    ? { targets: "summon", targetCount: tgtState.targetCount, summonCount: tgtState.summonCount, area: { ...tgtState.area } }
    : {
      targets: tgtState.targets,
      targetCount: tgtState.targetCount,
      summonCount: tgtState.summonCount,
      area: (tgtState.area.shape === "line")
        ? { shape: "line", length: 0, lines: tgtState.area.lines }
        : { shape: tgtState.area.shape, length: tgtState.area.length, lines: 1 }
    };
  const tgtIsArea = tgtState?.targets === "area";
  const tgtIsMulti = tgtState?.targets === "multiple";
  const tgtIsLine = tgtState?.area.shape === "line";
  const targetingBlock = !tgt ? "" : (tgt.summon ? `
      <div class="ol-roll-row ol-roll-targeting">
        <label title="Change how many creatures this invocation summons; the multi-targeting disadvantage updates to match.">Targeting</label>
        <div class="ol-targeting-controls">
          <span class="ol-tgt-static">Summon</span>
          <input type="number" class="ol-tgt-summon" min="1" step="1" value="${tgtState.summonCount}"
                 title="Creatures summoned by this invocation (disadvantage 2 per creature beyond the first)."/>
        </div>
        <span class="ol-tgt-penalty" data-tgt-penalty></span>
      </div>` : `
      <div class="ol-roll-row ol-roll-targeting">
        <label title="Change this roll's targeting on the fly; the multi-targeting disadvantage updates to match (feat reductions included).">Targeting</label>
        <div class="ol-targeting-controls">
          <select class="ol-tgt-mode">
            <option value="single" ${tgtState.targets === "single" ? "selected" : ""}>Single Target</option>
            <option value="multiple" ${tgtState.targets === "multiple" ? "selected" : ""}>Multiple Targets</option>
            <option value="area" ${tgtState.targets === "area" ? "selected" : ""}>Area</option>
          </select>
          <input type="number" class="ol-tgt-count" min="1" step="1" value="${tgtState.targetCount}"
                 title="Number of targets (disadvantage equal to the count when above one)."
                 ${tgtIsMulti ? "" : `style="display:none"`}/>
          <select class="ol-tgt-shape" ${tgtIsArea ? "" : `style="display:none"`}>
            ${Object.entries(tgtShapes).map(([k, v]) => `<option value="${esc(k)}" ${tgtState.area.shape === k ? "selected" : ""}>${esc(v)}</option>`).join("")}
          </select>
          <input type="number" class="ol-tgt-size" min="${tgtIsLine ? 1 : 5}" step="${tgtIsLine ? 1 : 5}"
                 value="${tgtIsLine ? tgtState.area.lines : tgtState.area.length}"
                 ${tgtIsArea ? "" : `style="display:none"`}/>
        </div>
        <span class="ol-tgt-penalty" data-tgt-penalty></span>
      </div>`);

  // Legend Points (PC only): a stepper 0..cap, where cap = min(pool, level+1).
  // Each point spent adds advantage 1 AND a flat +1 to the result (SRD rule).
  const legendAvail = legend ? Math.max(0, Math.floor(Number(legend.available) || 0)) : 0;
  const legendMax = legend ? Math.max(0, Math.floor(Number(legend.max) || 0)) : 0;
  const legendCap = legend ? Math.min(legendAvail, legendMax) : 0;
  const legendBlock = legend ? `
      <div class="ol-roll-row ol-legend-row" title="Spend Legend Points: each grants advantage 1 and +1 to the result. Max per roll = your level + 1 (${legendMax}); you have ${legendAvail}.">
        <label>Legend Points</label>
        <div class="ol-stepper ol-legend-stepper">
          <button type="button" class="ol-step" data-legend-step="-1">&minus;</button>
          <span class="ol-adv-value" data-value="legend">0</span>
          <button type="button" class="ol-step" data-legend-step="1">+</button>
        </div>
        <span class="ol-legend-cap">/ ${legendCap} ${legendCap < legendMax ? `(pool ${legendAvail}, cap ${legendMax})` : `(level + 1)`}</span>
      </div>` : "";

  const content = `
    <div class="ol-roll-dialog">
      <div class="ol-roll-row">
        <label>Dice Formula</label>
        <input type="text" name="bonusDice" value="${bonusDice ?? ""}"
               placeholder="${hasBonus ? "e.g. 2d6" : "(no bonus dice)"}"
               ${hasBonus ? "" : "disabled"}/>
      </div>
      ${sourcesBlock}
      ${targetingBlock}
      ${togglesBlock}
      ${augmentBlock}
      ${legendBlock}

      <div class="ol-roll-advrow">
        <div class="ol-adv-control" data-kind="advantage">
          <span class="ol-adv-label">Advantage</span>
          <div class="ol-stepper">
            <button type="button" class="ol-step" data-step="-1" data-kind="advantage">&minus;</button>
            <span class="ol-adv-value" data-value="advantage">${startAdv}</span>
            <button type="button" class="ol-step" data-step="1" data-kind="advantage">+</button>
          </div>
        </div>
        <div class="ol-adv-control" data-kind="disadvantage">
          <span class="ol-adv-label">Disadvantage</span>
          <div class="ol-stepper">
            <button type="button" class="ol-step" data-step="-1" data-kind="disadvantage">&minus;</button>
            <span class="ol-adv-value" data-value="disadvantage">${startDis}</span>
            <button type="button" class="ol-step" data-step="1" data-kind="disadvantage">+</button>
          </div>
        </div>
      </div>

      <div class="ol-roll-net">
        <span class="ol-net-text">Net: <strong data-net-text>None</strong></span>
        <code class="ol-formula-preview" data-formula-preview>1d20x</code>
      </div>
    </div>`;

  // Per-dialog mutable advantage/disadvantage state, seeded from the caller.
  // `toggleAdv` is the summed advantage of currently-checked extra toggles; it
  // adds to the net on top of the stepper advantage (seeded from checked toggles).
  const state = {
    advantage: startAdv,
    disadvantage: startDis,
    toggleAdv: toggles.reduce((s, t) => s + (t.checked ? Math.max(0, Number(t.advantage ?? 0)) : 0), 0),
    // Multi-targeting disadvantage from the live targeting controls, seeded from
    // the incoming targeting so the first paint matches the caller's derivation.
    targetingDis: tgt ? Math.max(0, Math.floor(Number(tgt.compute(currentTargeting())?.disadvantage) || 0)) : 0,
    legendPts: 0
  };

  // The live net advantage: stepper + toggle + legend advantage, minus the
  // stepper disadvantage and the targeting-derived multi-target penalty.
  const netAdv = () => (state.advantage + state.toggleAdv + state.legendPts)
    - (state.disadvantage + state.targetingDis);

  // Compose the final roll: advantage formula (legend points count as advantage too)
  // plus a flat "+N" for the N legend points spent. One source of truth for preview
  // and the rolled formula.
  const composeFormula = (dice) => {
    const base = buildFormula(dice, netAdv(), { explodeBelowMax, extraD20 });
    return state.legendPts > 0 ? `${base} + ${state.legendPts}` : base;
  };

  /**
   * Recompute net, formula preview, and labels from current state + the
   * (possibly edited) dice-formula input.
   * @param {HTMLElement} root  The dialog form element.
   */
  const refresh = (root) => {
    const dice = root.querySelector('input[name="bonusDice"]')?.value ?? bonusDice ?? "";
    const net = netAdv();
    root.querySelector('[data-value="advantage"]').textContent = String(state.advantage + state.toggleAdv + state.legendPts);
    root.querySelector('[data-value="disadvantage"]').textContent = String(state.disadvantage + state.targetingDis);
    const lp = root.querySelector('[data-value="legend"]');
    if ( lp ) lp.textContent = String(state.legendPts);
    const netText = net === 0 ? "None" : `${Math.abs(net)} ${net > 0 ? "Advantage" : "Disadvantage"}`;
    root.querySelector("[data-net-text]").textContent = netText + (state.legendPts > 0 ? ` · +${state.legendPts} (Legend)` : "");
    root.querySelector("[data-formula-preview]").textContent = composeFormula(dice);
  };

  const result = await DialogV2.wait({
    window: { title: title ?? "Roll" },
    classes: ["openlegend", "ol-roll-dialog-app"],
    content,
    rejectClose: false,
    buttons: [
      {
        action: "roll",
        label: "Roll",
        icon: "fas fa-dice-d20",
        default: true,
        callback: (event, button, dialog) => {
          const root = dialog.element;
          const dice = root.querySelector('input[name="bonusDice"]')?.value ?? bonusDice ?? "";
          const out = {
            formula: composeFormula(dice),
            advantage: state.advantage + state.toggleAdv + state.legendPts,
            disadvantage: state.disadvantage + state.targetingDis,
            net: netAdv(),
            legendPoints: state.legendPts
          };
          // The targeting chosen in the dialog (mode / count / area / summon),
          // so the caller can resolve the roll against it.
          if ( tgt ) out.targeting = currentTargeting();
          // Report each extra toggle's final on/off state, keyed by its name.
          for ( const t of toggles ) {
            out[t.name] = !!root.querySelector(`input[name="${t.name}"]`)?.checked;
          }
          // Chosen augmentation: an item + one of its banes at the item's PL.
          const augItemSel = root.querySelector(".ol-augment-item");
          const augBaneSel = root.querySelector(".ol-augment-bane");
          const augItemId = augItemSel?.value ?? "";
          const augBaneName = augBaneSel?.value ?? "";
          if ( augItemId && augBaneName ) {
            const opt = augItems.find(a => a.itemId === augItemId);
            const bane = opt?.banes.find(b => b.name === augBaneName);
            out.augment = bane
              ? { itemId: augItemId, itemName: opt.itemName, baneName: bane.name, powerLevel: bane.powerLevel }
              : null;
          } else {
            out.augment = null;
          }
          return out;
        }
      },
      { action: "cancel", label: "Cancel", icon: "fas fa-times" }
    ],
    render: (event, dialog) => {
      const root = dialog.element;
      for ( const btn of root.querySelectorAll(".ol-step") ) {
        btn.addEventListener("click", () => {
          const kind = btn.dataset.kind;       // "advantage" | "disadvantage"
          const step = Number(btn.dataset.step); // +1 | -1
          state[kind] = Math.max(0, state[kind] + step);
          refresh(root);
        });
      }
      root.querySelector('input[name="bonusDice"]')?.addEventListener("input", () => refresh(root));
      // Legend Points stepper: clamp to 0..legendCap.
      for ( const btn of root.querySelectorAll("[data-legend-step]") ) {
        btn.addEventListener("click", () => {
          const step = Number(btn.dataset.legendStep);
          state.legendPts = Math.max(0, Math.min(legendCap, state.legendPts + step));
          refresh(root);
        });
      }
      // Augmentation: repopulate the bane select from the chosen item's banes.
      const augItemSel = root.querySelector(".ol-augment-item");
      const augBaneSel = root.querySelector(".ol-augment-bane");
      if ( augItemSel && augBaneSel ) {
        augItemSel.addEventListener("change", () => {
          const opt = augItems.find(a => a.itemId === augItemSel.value);
          const banes = opt?.banes ?? [];
          augBaneSel.innerHTML = banes.length
            ? banes.map(b => `<option value="${esc(b.name)}">${esc(b.name)} (PL ${b.powerLevel})</option>`).join("")
            : `<option value="">—</option>`;
          augBaneSel.disabled = !banes.length;
        });
      }
      // Targeting controls: re-read the inputs, recompute the multi-target
      // penalty via the caller's compute(), toggle the contextual inputs, and
      // refresh the preview.
      if ( tgt ) {
        const modeSel = root.querySelector(".ol-tgt-mode");
        const countInput = root.querySelector(".ol-tgt-count");
        const shapeSel = root.querySelector(".ol-tgt-shape");
        const sizeInput = root.querySelector(".ol-tgt-size");
        const summonInput = root.querySelector(".ol-tgt-summon");
        const penalty = root.querySelector("[data-tgt-penalty]");
        // The size input doubles as line count / length in feet — swap its
        // constraints and remembered value when the shape changes.
        const applySizeInput = () => {
          if ( !sizeInput ) return;
          const line = tgtState.area.shape === "line";
          sizeInput.min = line ? "1" : "5";
          sizeInput.step = line ? "1" : "5";
          sizeInput.value = String(line ? tgtState.area.lines : tgtState.area.length);
          sizeInput.title = line
            ? "Number of 5'-wide lines (disadvantage 1 per line)."
            : "Length in feet (disadvantage 1 per full 5'; a single 5' incurs none).";
        };
        const syncTargeting = () => {
          if ( modeSel ) tgtState.targets = modeSel.value;
          if ( summonInput ) tgtState.summonCount = Math.max(1, Math.floor(Number(summonInput.value) || 1));
          if ( countInput ) tgtState.targetCount = Math.max(1, Math.floor(Number(countInput.value) || 1));
          if ( shapeSel && (shapeSel.value !== tgtState.area.shape) ) {
            tgtState.area.shape = shapeSel.value;
            applySizeInput();
          } else if ( sizeInput && (tgtState.targets === "area") ) {
            if ( tgtState.area.shape === "line" ) {
              tgtState.area.lines = Math.max(1, Math.floor(Number(sizeInput.value) || 0));
            } else {
              // Snap the length to the 5' steps SRD areas use: round to the
              // NEAREST multiple of 5 (12 → 10, 13 → 15), never in between.
              const v = Number(sizeInput.value) || 0;
              tgtState.area.length = Math.max(5, Math.round(v / 5) * 5);
            }
          }
          if ( countInput ) countInput.style.display = (tgtState.targets === "multiple") ? "" : "none";
          if ( shapeSel ) shapeSel.style.display = (tgtState.targets === "area") ? "" : "none";
          if ( sizeInput ) sizeInput.style.display = (tgtState.targets === "area") ? "" : "none";
          const res = tgt.compute(currentTargeting()) ?? {};
          state.targetingDis = Math.max(0, Math.floor(Number(res.disadvantage) || 0));
          if ( penalty ) {
            const raw = Math.max(0, Math.floor(Number(res.raw) || 0));
            const red = Math.max(0, Math.floor(Number(res.reduction) || 0));
            if ( state.targetingDis > 0 ) {
              const feat = red > 0 ? ` (${raw} &minus; ${red} ${esc(res.reductionLabel ?? "feat")})` : "";
              penalty.innerHTML = `Multi-targeting: <strong class="ol-src-dis">&minus;${state.targetingDis} Dis</strong>${feat}`;
            } else if ( raw > 0 ) {
              penalty.innerHTML = `Multi-targeting: <strong class="ol-src-adv">no penalty</strong> &mdash; negated by ${esc(res.reductionLabel ?? "feats")}`;
            } else {
              penalty.textContent = "No multi-targeting penalty.";
            }
          }
          refresh(root);
        };
        for ( const el of [countInput, sizeInput, summonInput] ) el?.addEventListener("input", syncTargeting);
        for ( const el of [modeSel, shapeSel] ) el?.addEventListener("change", syncTargeting);
        // On commit (blur / Enter), snap the size input's DISPLAYED value back to
        // the state's snapped value — the penalty already used it; typing is left
        // alone mid-edit so "1" on the way to "15" isn't clobbered.
        sizeInput?.addEventListener("change", () => {
          if ( tgtState.targets !== "area" ) return;
          sizeInput.value = String(tgtState.area.shape === "line" ? tgtState.area.lines : tgtState.area.length);
        });
        syncTargeting();
      }
      // Extra toggles: recompute the summed toggle advantage on any change.
      for ( const cb of root.querySelectorAll(".ol-roll-toggles input[type='checkbox']") ) {
        cb.addEventListener("change", () => {
          let sum = 0;
          for ( const c of root.querySelectorAll(".ol-roll-toggles input[type='checkbox']") ) {
            if ( c.checked ) sum += Math.max(0, Number(c.dataset.toggleAdv) || 0);
          }
          state.toggleAdv = sum;
          refresh(root);
        });
      }
      refresh(root);
    }
  });

  // `wait` resolves to the button's callback return for "roll", or the bare
  // action string "cancel" / null otherwise.
  return (result && typeof result === "object") ? result : null;
}
