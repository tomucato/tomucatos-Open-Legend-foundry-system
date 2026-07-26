/**
 * Open Legend Active Effect configuration.
 * The subject/action/modifier vocabulary an Active Effect change is authored
 * with, the subject metadata table (data paths, roll scopes, phases), and the
 * derived lookups + describe helper. Split out of config.mjs; depends on the
 * attribute data in stats.mjs.
 */
import STATS from "./stats.mjs";

const EFFECTS = {};
export default EFFECTS;

/* -------------------------------------------- */
/*  Active Effects                              */
/* -------------------------------------------- */

/**
 * An Active Effect change is authored as three choices on the config sheet:
 *   - Subject  (the "key" dropdown): WHAT is affected — an attribute, a
 *              defense, a resource, or a roll scope ("All Rolls"/"All Attacks").
 *   - Action   (bonus / penalty / override): how the value is combined.
 *   - Modifier (flat / adv-dis): whether the value changes the stat NUMBER or
 *              grants advantage / disadvantage on the relevant rolls.
 *
 * The subject's `key` is an opaque identifier; the real data path (or roll
 * flag) it resolves to depends on the chosen Modifier — see
 * EFFECTS.effectSubjects below and OpenLegendActiveEffect.applyChange. This
 * decoupling is why the key dropdown no longer lists "Advantage (all rolls)"
 * etc.: advantage is now the Modifier, not the subject.
 */

/** Action choices for the config sheet's "Action" dropdown. @type {Record<string,string>} */
EFFECTS.effectActions = {
  bonus: "Bonus (+)",
  penalty: "Penalty (−)",
  override: "Override (=)",
  half: "Half (×½)",
  double: "Double (×2)"
};

/**
 * Actions that operate on the subject's NUMBER by a fixed factor — no value or
 * modifier-type input (the operation is self-contained). Used by the config
 * sheet to disable those fields and by apply-time resolution. Maps the action to
 * the native multiply factor.
 * @type {Record<string, number>}
 */
EFFECTS.effectFactorActions = { half: 0.5, double: 2 };

/** Modifier-type choices for the config sheet's "Modifier" dropdown. @type {Record<string,string>} */
EFFECTS.effectModifierTypes = {
  flat: "Flat modifier",
  advdis: "Adv/Dis modifier"
};

/**
 * Metadata for every subject an effect change can target. Keyed by the subject
 * id stored in change.key.
 *   - label:    display name.
 *   - flat:     data path for a FLAT modifier (number changed in place), or null
 *               if the subject has no flat form (roll scopes).
 *   - attr:     the attribute key, for per-attribute adv/dis (its rolls only).
 *   - rollScope:"all" | "attack" for the global roll scopes.
 *   - finalPhase:flat changes here must apply in the "final" AE phase, because
 *               the value is recomputed in prepareDerivedData (defenses, max HP).
 *
 * A FLAT modifier applies to `flat` (no-op if null). An ADV/DIS modifier grants
 * advantage (bonus) or disadvantage (penalty) on: that attribute's rolls
 * (attr), or all rolls / all attacks (rollScope); it is a no-op for subjects
 * with neither (a defense, Speed, HP — "adv/dis on a flat number does nothing").
 * @type {Record<string, {label: string, flat: string|null, attr?: string, rollScope?: string, finalPhase?: boolean}>}
 */
EFFECTS.effectSubjects = {
  ...Object.fromEntries(Object.entries(STATS.attributeLabels).map(([k, label]) =>
    [`attr.${k}`, { label, flat: `system.attributes.${k}.value`, attr: k }])),
  guard: { label: "Guard", flat: "system.defenses.guard.value", finalPhase: true },
  toughness: { label: "Toughness", flat: "system.defenses.toughness.value", finalPhase: true },
  resolve: { label: "Resolve", flat: "system.defenses.resolve.value", finalPhase: true },
  hpCurrent: { label: "Hit Points (current)", flat: "system.health.value" },
  hpMax: { label: "Hit Points (max)", flat: "system.health.max", finalPhase: true },
  // Speed is recomputed in prepareDerivedData (encumbrance + armor penalties
  // are folded into system.speed.value in place), so a flat modifier must apply
  // in the "final" phase — otherwise the derivation overwrites it. Like the
  // defenses, the base stays editable and the modifier shows in the effective value.
  speed: { label: "Speed", flat: "system.speed.value", finalPhase: true },
  allRolls: { label: "All Rolls", flat: null, rollScope: "all" },
  allAttacks: { label: "All Attacks", flat: null, rollScope: "attack" },
  // Every action roll that is NOT an attack: attribute checks, boon invocations,
  // and interrupt (defend/improvise) rolls. Fatigued Level 1 uses this.
  allNonAttackRolls: { label: "Non-Attack Action Rolls", flat: null, rollScope: "non-attack" },
  // Strips the ATTRIBUTE bonuses from all three defenses (Agility/Might → Guard,
  // Fortitude/Will → Toughness, Will/Presence → Resolve), keeping armor,
  // extraordinary, and feat bonuses. A TOGGLE subject: a pure on/off boolean flag
  // SET in the INITIAL Active Effect phase (so it's present when prepareDerivedData
  // runs) and read by the actor's defense formula, which drops the attribute terms
  // when set. No Action/Value/Modifier inputs apply (the config sheet disables
  // them and forces override 1 / flat). Fatigued Level 4 uses this.
  // @see OpenLegendActor#prepareDerivedData
  defenseAttrLoss: { label: "Lose Attribute Defense Bonuses", flat: "flags.openlegend.defenseAttrLoss", toggle: true }
};

/**
 * Subjects grouped for the config sheet's "key" (subject) dropdown.
 * @type {Array<{group: string, keys: Record<string, string>}>}
 */
EFFECTS.effectChangeKeys = [
  {
    group: "Attributes",
    keys: Object.fromEntries(Object.keys(STATS.attributeLabels)
      .map(k => [`attr.${k}`, EFFECTS.effectSubjects[`attr.${k}`].label]))
  },
  {
    group: "Defenses",
    keys: {
      guard: "Guard", toughness: "Toughness", resolve: "Resolve",
      defenseAttrLoss: "Lose Attribute Defense Bonuses"
    }
  },
  {
    group: "Resources",
    keys: { hpCurrent: "Hit Points (current)", hpMax: "Hit Points (max)", speed: "Speed" }
  },
  {
    group: "Roll Scopes",
    keys: {
      allRolls: "All Rolls",
      allAttacks: "All Attacks",
      allNonAttackRolls: "Non-Attack Action Rolls"
    }
  }
];

/**
 * Subject ids whose FLAT change targets a value RECOMPUTED in
 * prepareDerivedData (character defenses, max HP). Such flat changes must apply
 * in the "final" Active Effect phase — after derivation — or the derived
 * formula would overwrite them. The effect-config sheet assigns the phase
 * automatically from the chosen subject. Derived from effectSubjects.
 * @type {Set<string>}
 */
EFFECTS.finalPhaseChangeKeys = new Set(
  Object.entries(EFFECTS.effectSubjects).filter(([, s]) => s.finalPhase).map(([k]) => k)
);

/**
 * Subject ids that are pure ON/OFF TOGGLES — a boolean flag, with no meaningful
 * Action / Value / Modifier. When such a subject is chosen, the config sheet
 * disables those fields and the change is stored canonically as override 1 /
 * flat / initial phase, so the flag is reliably truthy. Derived from
 * effectSubjects (`toggle: true`).
 * @type {Set<string>}
 */
EFFECTS.toggleSubjectKeys = new Set(
  Object.entries(EFFECTS.effectSubjects).filter(([, s]) => s.toggle).map(([k]) => k)
);

/**
 * A human-readable one-line description of a change row, for read-only displays
 * (the actor Conditions tab, the bane/boon item Effects tab). Decodes the
 * subject + modifier type + signed value into phrasing like:
 *   "Agility — Bonus 3"  /  "All Rolls — Advantage 2"  /  "Speed — Half (×½)"
 * @param {object} change  { key (subject id), value, type, modifierType }
 * @returns {{subject: string, detail: string}}
 */
EFFECTS.describeChange = function(change) {
  const subj = EFFECTS.effectSubjects[change?.key];
  const subject = subj?.label ?? change?.key ?? "—";
  // Boolean toggle subjects (a flag, not a number): describe as on/off, not "Bonus N".
  if ( change?.key === "defenseAttrLoss" ) {
    return { subject: "Defenses", detail: "Lose attribute bonuses" };
  }
  const advdis = (change?.modifierType === "advdis");
  const num = Number(change?.value);
  if ( change?.type === "multiply" ) return { subject, detail: (num === 2) ? "Double (×2)" : "Half (×½)" };
  if ( change?.type === "override" ) return { subject, detail: `Override ${change?.value}` };
  if ( advdis ) {
    const n = Math.abs(Number.isFinite(num) ? num : 0);
    return { subject, detail: (num < 0) ? `Disadvantage ${n}` : `Advantage ${n}` };
  }
  const n = Number.isFinite(num) ? num : 0;
  return { subject, detail: (n < 0) ? `Penalty ${Math.abs(n)}` : `Bonus ${n}` };
};
