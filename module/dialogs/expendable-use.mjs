/**
 * The "Use" dialog for an EXPENDABLE extraordinary item that is NOT Augmenting
 * (SRD Expendable: "An expendable item can be used once to make an attack or
 * invoke a bane. Afterwards, the item is expended."). Boons are deliberately
 * excluded — an expendable only attacks / invokes banes.
 *
 * The dialog configures a TEMPORARY action (never saved to the actor):
 *   - Rolling stat: one of the item's listed banes (the listed power level
 *     is the rolling stat — a Provoked 5 rolls 1d20 + 2d6) or one of its granted
 *     attributes (its granted score is the rolling stat).
 *   - Picking a bane adds a Power Level select: the invocation may land at
 *     any of its discrete levels up to the listed value (the dice stay at the
 *     item's value — the standard item-invocation rule).
 *   - Picking an attribute reveals an Invoke select of every bane that
 *     attribute unlocks at the item's granted score (PL ≤ score).
 *   - Targets / Area and Range mirror the action sheet's fields; advantage and
 *     disadvantage seed the roll dialog like an action's own values.
 *
 * Rolling routes through the SAME pipeline as a real action (prepareActionRoll →
 * roll dialog → chat card), so feats, active effects and multi-target/area
 * disadvantage all apply normally. A completed roll expends one use of the item
 * (stack decrements, the last one is deleted) — gated by the "Expend Used
 * Expendable Items" world setting.
 */

/** The item's usable bane grants, resolved to their compendium docs. */
async function resolveGrants(item, cfg) {
  const clampPl = v => Math.max(0, Math.min(9, Math.floor(Number(v) || 0)));
  const banes = [];
  for ( const b of (item.system.extraordinaryBanes ?? []) ) {
    const pl = clampPl(b?.powerLevel);
    if ( !b?.name || (pl <= 0) ) continue;
    const doc = await cfg.resolveBaneByName?.(b.name);
    banes.push({
      kind: "bane", name: doc?.name ?? b.name, uuid: doc?.uuid ?? "", score: pl,
      defense: ((doc?.system?.attacks ?? [])[0]?.defense ?? "guard").toLowerCase(),
      attrLabel: (doc?.system?.attacks ?? [])[0]?.attackingAttribute ?? "",
      levels: discreteLevels(doc, pl)
    });
  }
  return { banes };
}

/**
 * A bane/boon's DISCRETE power levels (its power-effect breakpoints) up to `cap`,
 * ascending. Falls back to [cap] so a doc without breakpoints (or an unresolved
 * name) is still invocable at the listed value.
 */
function discreteLevels(doc, cap) {
  const levels = [...new Set(
    (doc?.system?.powerEffects ?? [])
      .map(pe => Math.floor(Number(pe.powerLevel)))
      .filter(n => Number.isFinite(n) && (n > 0) && (n <= cap))
  )].sort((a, b) => a - b);
  return levels.length ? levels : [cap];
}

/**
 * Every bane a granted attribute unlocks at the item's granted score: banes
 * with an attack entry for the attribute at PL ≤ score. Sorted PL, then name.
 */
async function attributeInvocables(attrLabel, score) {
  const out = [];
  const banePack = game.packs?.get("tomucatos-open-legend-rpg-system.banes");
  for ( const bane of (banePack ? await banePack.getDocuments() : []) ) {
    const attacks = bane.system?.attacks ?? [];
    const match = attacks.find(a => String(a.attackingAttribute ?? "").toLowerCase() === String(attrLabel).toLowerCase());
    if ( !match ) continue;
    const pl = Number(bane.system?.powerLevel ?? 0);
    if ( pl > score ) continue;
    out.push({
      kind: "bane", uuid: bane.uuid, name: bane.name, powerLevel: pl,
      defense: (match.defense ?? "guard").toLowerCase(),
      levels: discreteLevels(bane, score)
    });
  }
  out.sort((a, b) => (a.powerLevel - b.powerLevel) || a.name.localeCompare(b.name));
  return out;
}

/** Map an attribute LABEL ("Entropy") back to its key ("entropy"); "will" fallback. */
function attrKeyForLabel(cfg, label) {
  const want = String(label ?? "").toLowerCase();
  for ( const [k, lbl] of Object.entries(cfg.attributeLabels ?? {}) ) {
    if ( String(lbl).toLowerCase() === want ) return k;
  }
  return "will";
}

/**
 * Open the Use dialog for an Expendable item, roll the configured temporary
 * action, and expend one use on a completed roll (canceling either dialog keeps
 * the item). No-op with a warning when the item lists nothing usable.
 * @param {Item} item    The expendable extraordinary item (weapon/armor/gear).
 * @param {Actor} actor  The owning actor.
 * @returns {Promise<void>}
 */
export async function useExpendableItem(item, actor) {
  const cfg = CONFIG.OPENLEGEND ?? {};
  const esc = s => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");
  const { DialogV2 } = foundry.applications.api;

  const { banes } = await resolveGrants(item, cfg);
  const attrs = (item.system.extraordinaryAttributes ?? [])
    .filter(a => a?.key && (Number(a.score) > 0))
    .map(a => ({
      key: a.key,
      label: cfg.attributeLabels?.[a.key] ?? a.key,
      score: Math.max(0, Math.min(9, Math.floor(Number(a.score))))
    }));
  if ( !banes.length && !attrs.length ) {
    ui.notifications?.warn(`${item.name} lists no banes or attributes to use.`);
    return;
  }

  // Per-attribute invocable banes (PL ≤ the granted score), resolved up
  // front so the Invoke select can repopulate synchronously on selection.
  const invocablesByAttr = {};
  for ( const a of attrs ) invocablesByAttr[a.key] = await attributeInvocables(a.label, a.score);

  // Rolling-stat options: the item's banes, then attributes. The value
  // encodes the choice; grant PLs / attribute scores ARE the rolling stat.
  const statGroups = [];
  if ( banes.length ) statGroups.push(`<optgroup label="Banes">${banes.map((b, i) =>
    `<option value="bane:${i}">&#128128; ${esc(b.name)} (&#10024; ${b.score})</option>`).join("")}</optgroup>`);
  if ( attrs.length ) statGroups.push(`<optgroup label="Attributes">${attrs.map(a =>
    `<option value="attr:${a.key}">${esc(a.label)} (${a.score})</option>`).join("")}</optgroup>`);

  // An item Area property pre-selects area targeting with its definition.
  const areaDefs = cfg.extraordinaryAreaDefinitions?.(item) ?? [];
  const defaultArea = areaDefs[0] ?? { shape: "cone", length: 10, lines: 1 };
  const defaultTargets = areaDefs.length ? "area" : "single";

  const selectOptions = (map, selected) => Object.entries(map)
    .map(([k, v]) => `<option value="${esc(k)}" ${k === selected ? "selected" : ""}>${esc(v.label ?? v)}</option>`)
    .join("");

  const content = `
    <div class="ol-expend-use">
      <p class="ol-expend-intro">Use <strong>${esc(item.name)}</strong> once — rolling expends it.</p>
      <div class="ol-expend-grid">
        <div class="ol-expend-field ol-expend-wide">
          <label>Rolling Stat</label>
          <select name="stat">${statGroups.join("")}</select>
        </div>
        <div class="ol-expend-field ol-expend-wide" data-row="invoke" hidden>
          <label data-invoke-label>Invoke</label>
          <select name="invoke"></select>
        </div>
        <div class="ol-expend-field" data-row="pl">
          <label>Power Level</label>
          <select name="pl"></select>
        </div>
        <div class="ol-expend-field">
          <label>Targets</label>
          <select name="targets">${selectOptions(cfg.targetModes ?? {}, defaultTargets)}</select>
        </div>
        <div class="ol-expend-field" data-row="targetCount" hidden>
          <label>Number of Targets</label>
          <input type="number" name="targetCount" min="1" step="1" value="2"/>
        </div>
        <div class="ol-expend-field" data-row="areaShape" hidden>
          <label>Area Shape</label>
          <select name="areaShape">${selectOptions(cfg.areaShapes ?? {}, defaultArea.shape)}</select>
        </div>
        <div class="ol-expend-field" data-row="areaLength" hidden>
          <label>Length (ft)</label>
          <span class="ol-expend-stepper">
            <button type="button" class="ol-step-btn" data-step="-5" tabindex="-1" data-tooltip="Decrease by 5 ft">&minus;</button>
            <input type="number" name="areaLength" min="5" step="5" value="${Math.max(5, defaultArea.length || 10)}"/>
            <button type="button" class="ol-step-btn" data-step="5" tabindex="-1" data-tooltip="Increase by 5 ft">+</button>
          </span>
        </div>
        <div class="ol-expend-field" data-row="areaLines" hidden>
          <label>Number of Lines</label>
          <span class="ol-expend-stepper">
            <button type="button" class="ol-step-btn" data-step="-1" tabindex="-1" data-tooltip="Fewer lines">&minus;</button>
            <input type="number" name="areaLines" min="1" step="1" value="${Math.max(1, defaultArea.lines || 1)}"/>
            <button type="button" class="ol-step-btn" data-step="1" tabindex="-1" data-tooltip="More lines">+</button>
          </span>
        </div>
        <div class="ol-expend-field">
          <label>Range Mode</label>
          <select name="rangeMode">${selectOptions(cfg.rangeModes ?? {}, "melee")}</select>
        </div>
        <div class="ol-expend-field" data-row="rangeBand" hidden>
          <label>Range Band</label>
          <select name="rangeBand">${selectOptions(cfg.rangeBands ?? {}, "close")}</select>
        </div>
        <div class="ol-expend-field">
          <label>Advantage</label>
          <input type="number" name="advantage" min="0" step="1" value="0"/>
        </div>
        <div class="ol-expend-field">
          <label>Disadvantage</label>
          <input type="number" name="disadvantage" min="0" step="1" value="0"/>
        </div>
      </div>
      <p class="ol-expend-hint">Multi-target and area disadvantage are added automatically in the roll
      dialog, where your feats and dice modifiers apply as usual.</p>
    </div>`;

  const choice = await DialogV2.wait({
    window: { title: `Use ${item.name}`, icon: "fas fa-vial" },
    classes: ["openlegend", "ol-expend-use-app"],
    content,
    rejectClose: false,
    buttons: [
      { action: "use", label: "Use", icon: "fas fa-dice-d20", default: true,
        callback: (ev, button, dialog) => {
          const root = dialog.element;
          const val = n => root.querySelector(`[name="${n}"]`)?.value ?? "";
          return {
            stat: val("stat"),
            invoke: val("invoke"),
            pl: Math.max(0, Math.floor(Number(val("pl")) || 0)),
            targets: val("targets"),
            targetCount: Math.max(1, Math.floor(Number(val("targetCount")) || 1)),
            areaShape: val("areaShape"),
            areaLength: Math.max(5, Math.round((Number(val("areaLength")) || 5) / 5) * 5),
            areaLines: Math.max(1, Math.floor(Number(val("areaLines")) || 1)),
            rangeMode: val("rangeMode"),
            rangeBand: val("rangeBand"),
            advantage: Math.max(0, Math.floor(Number(val("advantage")) || 0)),
            disadvantage: Math.max(0, Math.floor(Number(val("disadvantage")) || 0))
          };
        } },
      { action: "cancel", label: "Cancel", icon: "fas fa-times" }
    ],
    render: (event, dialog) => {
      const root = dialog.element;
      const statSel = root.querySelector('[name="stat"]');
      const invokeRow = root.querySelector('[data-row="invoke"]');
      const invokeSel = root.querySelector('[name="invoke"]');
      const invokeLabel = root.querySelector("[data-invoke-label]");
      const plRow = root.querySelector('[data-row="pl"]');
      const plSel = root.querySelector('[name="pl"]');
      const show = (row, on) => { if ( row ) row.hidden = !on; };

      // Repopulate the Power Level select: the choice's discrete levels, highest
      // preselected (the "invoke at full value" default).
      const setLevels = levels => {
        plSel.innerHTML = levels.map((pl, i) =>
          `<option value="${pl}" ${i === levels.length - 1 ? "selected" : ""}>${pl}</option>`).join("");
        show(plRow, levels.length > 0);
      };

      // The attribute grant currently picked as the rolling stat (null when a
      // bane grant is picked instead).
      const currentAttr = () => {
        const [type, arg] = String(statSel.value).split(":");
        return type === "attr" ? (attrs.find(a => a.key === arg) ?? null) : null;
      };

      // PL options follow the picked invocation (attribute path) without
      // rebuilding the Invoke list — rebuilding would reset its selection.
      const syncPlForInvoke = () => {
        const attr = currentAttr();
        const list = attr ? (invocablesByAttr[attr.key] ?? []) : [];
        const picked = list[Number(invokeSel.value)] ?? null;
        setLevels(picked ? picked.levels : []);
      };

      // Attribute picked: fill the Invoke select with what it unlocks, then sync
      // the PL options to the picked invocation.
      const syncInvoke = attr => {
        const list = invocablesByAttr[attr.key] ?? [];
        invokeLabel.textContent = `Invoke (${attr.label} ${attr.score})`;
        invokeSel.innerHTML = list.length
          ? list.map((o, i) => `<option value="${i}">\u{1F480} ${esc(o.name)} (PL ${o.powerLevel})</option>`).join("")
          : `<option value="">— nothing unlocked —</option>`;
        invokeSel.disabled = !list.length;
        syncPlForInvoke();
      };

      const syncStat = () => {
        const attr = currentAttr();
        if ( attr ) {
          show(invokeRow, true);
          syncInvoke(attr);
        } else {
          const [, arg] = String(statSel.value).split(":");
          show(invokeRow, false);
          const grant = banes[Number(arg)] ?? null;
          setLevels(grant ? grant.levels : []);
        }
      };

      const syncTargets = () => {
        const mode = root.querySelector('[name="targets"]').value;
        const shape = root.querySelector('[name="areaShape"]').value;
        show(root.querySelector('[data-row="targetCount"]'), mode === "multiple");
        show(root.querySelector('[data-row="areaShape"]'), mode === "area");
        show(root.querySelector('[data-row="areaLength"]'), (mode === "area") && (shape !== "line"));
        show(root.querySelector('[data-row="areaLines"]'), (mode === "area") && (shape === "line"));
      };

      const syncRange = () => {
        show(root.querySelector('[data-row="rangeBand"]'),
          root.querySelector('[name="rangeMode"]').value === "ranged");
      };

      // ± steppers beside the area inputs (mirrors the action sheet / extraordinary
      // property steppers): bump by the signed step, clamped to the input's min;
      // typed values snap to the step grid (whole 5' increments for Length).
      const snap = input => {
        const step = Math.max(1, Number(input.getAttribute("step")) || 1);
        const min = Number(input.getAttribute("min")) || step;
        input.value = String(Math.max(min, Math.round((Number(input.value) || 0) / step) * step));
      };
      for ( const btn of root.querySelectorAll(".ol-expend-stepper .ol-step-btn") ) {
        btn.addEventListener("click", ev => {
          ev.preventDefault();
          const input = btn.parentElement.querySelector('input[type="number"]');
          input.value = String((Number(input.value) || 0) + (Number(btn.dataset.step) || 0));
          snap(input);
        });
      }
      for ( const input of root.querySelectorAll(".ol-expend-stepper input[type=\"number\"]") ) {
        input.addEventListener("change", () => snap(input));
      }

      statSel.addEventListener("change", syncStat);
      invokeSel.addEventListener("change", syncPlForInvoke);
      root.querySelector('[name="targets"]').addEventListener("change", syncTargets);
      root.querySelector('[name="areaShape"]').addEventListener("change", syncTargets);
      root.querySelector('[name="rangeMode"]').addEventListener("change", syncRange);
      syncStat(); syncTargets(); syncRange();
    }
  });
  if ( !choice || (typeof choice !== "object") ) return;   // canceled — keep the item

  // Resolve the picked bane to { kind, name, uuid, defense, score }.
  // score = the rolling stat (grant PL / attribute score) → invokeItemScore.
  const [type, arg] = String(choice.stat).split(":");
  let picked = null;
  let attribute = "will";
  if ( type === "attr" ) {
    const attr = attrs.find(a => a.key === arg);
    const inv = (invocablesByAttr[arg] ?? [])[Number(choice.invoke)] ?? null;
    if ( !attr || !inv ) {
      ui.notifications?.warn(`${item.name}: nothing is unlocked to invoke with that attribute.`);
      return;
    }
    picked = { ...inv, score: attr.score };
    attribute = attr.key;
  } else {
    picked = banes[Number(arg)] ?? null;
    if ( !picked ) return;
    attribute = attrKeyForLabel(cfg, picked.attrLabel);
  }
  if ( !picked.uuid ) {
    ui.notifications?.warn(`Bane "${picked.name}" was not found in any compendium.`);
    return;
  }

  // The temporary action's system data — the same shape the extraordinary action
  // builders produce, plus the dialog's targeting/range/advantage choices.
  const invokePl = Math.min(Math.max(1, choice.pl || picked.score), picked.score);
  const sys = {
    actionCategory: picked.kind,
    actionType: "major",
    attribute,
    targets: choice.targets,
    targetCount: choice.targetCount,
    rangeMode: choice.rangeMode,
    rangeBand: choice.rangeBand,
    advantage: choice.advantage,
    disadvantage: choice.disadvantage,
    invokeFromItemId: item.id,
    invokeItemScore: picked.score,
    invokePowerLevel: invokePl
  };
  if ( choice.targets === "area" ) {
    sys.area = (choice.areaShape === "line")
      ? { shape: "line", length: 0, lines: choice.areaLines }
      : { shape: choice.areaShape, length: choice.areaLength, lines: 1 };
  }
  sys.targetDefense = picked.defense ?? "guard";
  sys.baneUuid = picked.uuid;
  sys.baneName = picked.name;
  // A bane delivered by an item with the Potent property is potent.
  sys.potent = (item.system.extraordinaryProperties ?? []).some(p => p.name === "potent");

  // An EPHEMERAL action document (never saved): rollAction runs the full pipeline
  // — prepareActionRoll (feats, multi-target disadvantage), the roll dialog, the
  // chat card — and returns the posted message, or undefined when canceled.
  const ItemCls = CONFIG.Item.documentClass;
  const temp = new ItemCls({
    name: `${item.name}: ${picked.name}`, type: "action", img: item.img, system: sys
  }, { parent: actor });
  const { rollAction } = await import("../dice/action-roll.mjs");
  const message = await rollAction(temp, { actor });
  if ( !message ) return;                                  // roll canceled — keep the item

  // Expend one use (stack decrements, the last one is deleted), gated by the
  // "Expend Used Expendable Items" world setting.
  const live = actor.items.get(item.id);
  if ( !live ) return;
  const qtyBefore = Math.max(1, Math.floor(Number(live.system?.quantity) || 1));
  const name = live.name;
  const outcome = await (cfg.expendItem?.(live, { setting: "expendExpendableItems" }) ?? "kept");
  if ( outcome === "decremented" ) ui.notifications?.info(`Used one ${name} (${qtyBefore - 1} left).`);
  else if ( outcome === "deleted" ) ui.notifications?.info(`Expended ${name}.`);
  else ui.notifications?.info(`Used ${name} (item kept — expending is disabled).`);
}
