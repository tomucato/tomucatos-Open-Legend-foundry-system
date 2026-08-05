/**
 * Open Legend FEAT configuration: feat-point costs, feat-choice option lists, and
 * the large body of per-feat automation (Attack Specialization, Lethal Strike,
 * Bane Focus, Battle Trance, Boon Access/Focus, movement feats, …). Detected by a
 * feat's base name and applied at roll/derive time. Merged into the public
 * {@link OPENLEGEND} object in ./index.mjs (see stats.mjs for the same pattern).
 *
 * WEAPON and BANE are imported directly: both are leaf modules (they import
 * nothing), so feat -> weapon and feat -> bane are acyclic. The Energy Resistance
 * feat lives in resistance.mjs (with the Resistance boon), keeping this file free
 * of any dependency on damage.mjs — so there is no import cycle and no OL()
 * indirection anywhere in the config graph.
 */
import WEAPON from "./weapon.mjs";
import BANE from "./bane.mjs";
import STATS from "./stats.mjs";

const FEATS = {};
export default FEATS;

/**
 * Cumulative feat-point cost to own a feat up to a purchased tier: the sum of the
 * per-tier costs for tiers 1..tier. A feat with cost [3,3] costs 3 at tier 1 and
 * 6 at tier 2.
 * @param {number[]} costPerTier  The feat's per-tier cost array.
 * @param {number} tier           The purchased tier (0 = not owned).
 * @returns {number}
 */
FEATS.featCostForTier = function(costPerTier = [], tier = 0) {
  const t = Math.max(0, Math.floor(Number(tier) || 0));
  let sum = 0;
  for ( let i = 0; i < t; i++ ) sum += Number(costPerTier[i] ?? costPerTier[costPerTier.length - 1] ?? 0);
  return sum;
};

/**
 * Fixed option lists for feat choices (system.choice.type). Types without a
 * fixed list resolve at pick time: "bane"/"boon"/"weapon" from the matching
 * compendium index, "attribute" from STATS.attributeLabels, "text" is
 * free-form. Types listed in `open` accept free text beyond the suggestions
 * (e.g. Energy Resistance allows "another at the GM's discretion"; Attack
 * Specialization accepts attack types like "Fire" as well as weapons).
 */
FEATS.featChoices = {
  energy: ["Fire", "Cold", "Lightning", "Acid", "Poison"],
  mode: ["Area", "Ranged", "Melee"],
  // Craft Mundane Item: a non-exhaustive list of crafts/professions the player can
  // pick from OR write their own (the feat is "just bookkeeping" — the GM
  // adjudicates what each craft can make). Listed in `open` so free text is allowed.
  craft: ["Alchemy", "Arcane", "Blacksmithing", "Chemistry", "Engineering", "Geography", "Herbalism", "Medicine"],
  // Knowledge: example spheres of knowledge (non-exhaustive — the player may write
  // their own; the feat is "just bookkeeping"). "Location" should be specified.
  // Listed in `open` so free text is allowed.
  knowledge: [
    "alchemy", "anatomy", "arcane", "computers", "explosives", "engineering",
    "geography", "herbalism", "history", "location (must specify)", "medicine",
    "military strategy", "supernatural", "wilderness"
  ],
  open: ["weapon", "energy", "text", "craft", "knowledge"]
};

/**
 * The compendium base name of the Craft Mundane Item feat (multi-take). Each copy
 * picks a craft/profession (a featChoices.craft suggestion OR free text). The pack
 * carries choice.type "text"; this constant lets the choice dialog upgrade it to
 * the "craft" type so the suggestion datalist is offered.
 * @type {string}
 */
FEATS.CRAFT_MUNDANE_BASE = "Craft Mundane Item (I - II)";

/**
 * The compendium base name of the Knowledge feat (multi-take). Each copy picks a
 * sphere of knowledge (a featChoices.knowledge suggestion OR free text — pure
 * bookkeeping). The pack carries choice.type "text"; this constant lets the choice
 * dialog upgrade it to the "knowledge" type so the suggestion datalist is offered.
 * @type {string}
 */
FEATS.KNOWLEDGE_BASE = "Knowledge (I - III)";

/**
 * The compendium base name of the Attack Specialization feat (it carries bespoke
 * automation — a weapon-base-type / damage-type pick — keyed off this name).
 * @type {string}
 */
FEATS.ATTACK_SPEC_BASE = "Attack Specialization (I - IX)";

/**
 * Total Attack Specialization advantage for a damaging attack: sum each owned
 * Attack Specialization feat's tier whose chosen specialization matches THIS
 * attack — a damage type matching the action's damage type, or a weapon base
 * type matching the wielded weapon's base type. The pick is stored on the feat
 * as `flags.openlegend.attackSpec = { kind:"weapon"|"damageType", key, label }`
 * (key = the weapon's baseType, or the damageType key). Bane/boon invocations do
 * NOT benefit (the feat is explicit: "does not apply to bane attacks or boon
 * invocations").
 * @param {Actor} actor
 * @param {object} ctx
 * @param {Item|null} [ctx.weapon]      The wielded weapon (for base-type match).
 * @param {string} [ctx.damageType]     The action's damage type key.
 * @returns {{value: number, labels: string[]}}  Total advantage + per-match labels.
 */
FEATS.attackSpecializationAdvantage = function(actor, { weapon = null, damageType = "" } = {}) {
  const base = FEATS.ATTACK_SPEC_BASE;
  const weaponBaseType = (weapon?.type === "weapon")
    ? String(weapon.system?.baseType ?? "").trim().toLowerCase() : "";
  const dt = String(damageType ?? "").trim().toLowerCase();

  let value = 0;
  const labels = [];
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    const spec = feat.flags?.openlegend?.attackSpec;
    if ( !spec?.key ) continue;
    const key = String(spec.key).trim().toLowerCase();
    const tier = Math.max(1, Math.floor(Number(feat.system?.purchasedTier) || 1));
    const matches = (spec.kind === "weapon")
      ? (!!weaponBaseType && (weaponBaseType === key))
      : (!!dt && (dt === key));
    if ( !matches ) continue;
    value += tier;
    labels.push(`${spec.label || spec.key} ${tier}`);
  }
  return { value, labels };
};

/**
 * The set of WEAPON base types the actor has taken the Attack Specialization feat
 * for (kind "weapon" picks only — damage-type picks are excluded). Lowercased keys.
 * @param {Actor} actor
 * @returns {Set<string>}
 */
FEATS.attackSpecWeaponBaseTypes = function(actor) {
  const base = FEATS.ATTACK_SPEC_BASE;
  const out = new Set();
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    const spec = feat.flags?.openlegend?.attackSpec;
    if ( (spec?.kind === "weapon") && spec.key ) out.add(String(spec.key).trim().toLowerCase());
  }
  return out;
};

/**
 * The compendium base name of the Two Weapon Defense feat (single take, passive).
 * While wielding a weapon you've taken Attack Specialization for in EACH hand, you
 * gain a +1 armor bonus to Guard.
 * @type {string}
 */
FEATS.TWO_WEAPON_DEFENSE_BASE = "Two Weapon Defense";

/**
 * Whether the actor owns the Two Weapon Defense feat.
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.hasTwoWeaponDefense = function(actor) {
  const base = FEATS.TWO_WEAPON_DEFENSE_BASE;
  return (actor?.items ?? []).some(feat =>
    (feat.type === "feat") && ((feat.system?.baseName || feat.name) === base));
};

/**
 * The compendium base name of the Two Weapon Brute feat (single take, passive). You
 * can wield a two-handed weapon in one hand, gaining BOTH the two-handed and the
 * one-handed (dual-wield) wielding benefit — so dual-wielding two-handed weapons
 * grants advantage 2 (1 from the two-handed power + 1 from one weapon in each hand).
 * @type {string}
 */
FEATS.TWO_WEAPON_BRUTE_BASE = "Two Weapon Brute";

/**
 * Whether the actor owns the Two Weapon Brute feat.
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.hasTwoWeaponBrute = function(actor) {
  const base = FEATS.TWO_WEAPON_BRUTE_BASE;
  return (actor?.items ?? []).some(feat =>
    (feat.type === "feat") && ((feat.system?.baseName || feat.name) === base));
};

/**
 * The wielding advantage from a weapon's grip (Weapons & Implements rules), as
 * resolved for THIS actor — the single source of truth shared by the action sheet's
 * grip hint and the roll path. A Defensive weapon forfeits it entirely. Otherwise:
 *   - two-handed grip → advantage 1
 *   - dual-wield grip → advantage 1, OR advantage 2 when the weapon is two-handed and
 *     the actor has Two Weapon Brute (two-handed power + one-in-each-hand)
 *   - one-handed grip → advantage 0
 * @param {Actor} actor
 * @param {object} ctx
 * @param {string} ctx.grip        The normalized grip ("one-handed"|"dual-wield"|"two-handed").
 * @param {boolean} ctx.twoHanded  Whether the weapon requires two hands (hands === 2).
 * @param {boolean} ctx.defensive  Whether the weapon has the Defensive property.
 * @returns {number}
 */
FEATS.gripWieldingAdvantage = function(actor, { grip, twoHanded = false, defensive = false } = {}) {
  if ( defensive ) return 0;
  if ( grip === "two-handed" ) return 1;
  if ( grip === "dual-wield" ) {
    return (twoHanded && FEATS.hasTwoWeaponBrute(actor)) ? 2 : 1;
  }
  return 0;
};

/**
 * How many HAND SLOTS a weapon occupies for THIS actor, honoring Two Weapon Brute —
 * which lets a two-handed weapon be wielded in ONE hand (so it costs 1 slot, allowing
 * two of them). Without the feat: two-handed → 2, versatile → its equipped grip
 * (1 or 2, defaulting to 1), one-handed → 1.
 * @param {Actor} actor
 * @param {Item} weapon
 * @param {object} [opts]
 * @param {number} [opts.equipHands]  A versatile weapon's chosen grip (1 or 2). Falls
 *                                    back to the weapon's stored equipHands, then 1.
 * @returns {number}  Hand slots used (≥ 1).
 */
FEATS.effectiveWeaponHands = function(actor, weapon, { equipHands } = {}) {
  const hands = WEAPON.weaponHandsFor(weapon?.system?.categories ?? []);
  if ( hands === 2 ) return FEATS.hasTwoWeaponBrute(actor) ? 1 : 2;
  if ( hands === "versatile" ) {
    const eh = (equipHands !== undefined) ? equipHands : weapon?.system?.equipHands;
    return Math.max(1, Math.min(2, Number(eh ?? 1)));
  }
  return 1;
};

/**
 * Whether Two Weapon Defense's +1 Guard armor bonus currently applies: the actor owns
 * the feat AND is wielding (equipped) a one-handed weapon in EACH hand, each of whose
 * base type the actor has an Attack Specialization (weapon) pick for. Two equipped,
 * one-hand-usable, Attack-Spec'd weapons satisfy "one in each hand"; a two-handed
 * weapon cannot (it occupies both hands).
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.wieldsTwoWeaponDefense = function(actor) {
  if ( !FEATS.hasTwoWeaponDefense(actor) ) return false;
  const specced = FEATS.attackSpecWeaponBaseTypes(actor);
  if ( !specced.size ) return false;

  let qualifying = 0;
  for ( const item of (actor?.items ?? []) ) {
    if ( (item.type !== "weapon") || !item.system?.equipped ) continue;
    const hands = WEAPON.weaponHandsFor(item.system.categories ?? []);
    // Must be usable one-handed: a two-handed weapon occupies both hands; a versatile
    // weapon held in two hands likewise can't leave a hand for a second weapon.
    if ( hands === 2 ) continue;
    if ( (hands === "versatile") && (Number(item.system.equipHands) === 2) ) continue;
    const baseType = String(item.system.baseType ?? "").trim().toLowerCase();
    if ( baseType && specced.has(baseType) ) qualifying += 1;
  }
  return qualifying >= 2;
};

/**
 * The compendium base name of the Well-Rounded feat (single take, passive). Any time
 * you use an attribute with a score of 2 or less to make an action roll OUTSIDE of
 * combat that is NOT a bane or boon invocation, you gain advantage 1 to the roll.
 * @type {string}
 */
FEATS.WELL_ROUNDED_BASE = "Well-Rounded";

/**
 * Whether the actor owns the Well-Rounded feat.
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.hasWellRounded = function(actor) {
  const base = FEATS.WELL_ROUNDED_BASE;
  return (actor?.items ?? []).some(feat =>
    (feat.type === "feat") && ((feat.system?.baseName || feat.name) === base));
};

/**
 * The maximum attribute score Well-Rounded applies to (a score of 2 or less).
 * @type {number}
 */
FEATS.WELL_ROUNDED_MAX_SCORE = 2;

/**
 * Whether Well-Rounded could apply to an attribute check with this effective score:
 * the actor owns the feat AND the score is ≤ 2. (The "outside of combat" and
 * "not a bane/boon invocation" conditions are enforced by the caller — invocations
 * use a different roll path, and combat state gates auto-apply vs. opt-in toggle.)
 * @param {Actor} actor
 * @param {number} effectiveScore  The score used for the roll (substituted where applicable).
 * @returns {boolean}
 */
FEATS.wellRoundedApplies = function(actor, effectiveScore) {
  return FEATS.hasWellRounded(actor)
    && (Number(effectiveScore) <= FEATS.WELL_ROUNDED_MAX_SCORE);
};

/**
 * Whether the actor is currently in an ACTIVE (started) combat encounter — used to
 * decide whether Well-Rounded auto-applies (out of combat) or is offered as an opt-in
 * toggle (in combat, for a roll the GM rules is non-combat).
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.actorInActiveCombat = function(actor) {
  const combat = game?.combat;
  if ( !combat?.started ) return false;
  const inIt = combat.getCombatantsByActor?.(actor) ?? [];
  return inIt.length > 0;
};

/**
 * The compendium base name of the Skill Specialization feat (multi-take, maxTier 5
 * per attribute). Each copy chooses one attribute (stored as the attribute LABEL in
 * `system.choice.value`, e.g. "Agility"). Any roll using that attribute that is NOT
 * an initiative, attack, invocation, or defend roll gains advantage 1 per owned tier
 * for that attribute. Tiers are tracked per attribute (and summed across copies that
 * picked the same attribute).
 * @type {string}
 */
FEATS.SKILL_SPEC_BASE = "Skill Specialization (I - V)";

/**
 * Total Skill Specialization advantage on a PLAIN attribute check with `attrKey`
 * (callers must only invoke this for non-attack, non-invocation, non-defend,
 * non-initiative rolls). Sums the purchased tier of every owned Skill Specialization
 * copy whose chosen attribute matches `attrKey` — matched by the attribute label
 * stored in `system.choice.value`, case-insensitively, so two copies on the same
 * attribute (or one copy bought up in tier) stack.
 * @param {Actor} actor
 * @param {string} attrKey   The rolled attribute key (e.g. "agility").
 * @returns {number}         Total advantage (0 if none).
 */
FEATS.skillSpecializationAdvantage = function(actor, attrKey) {
  const base = FEATS.SKILL_SPEC_BASE;
  const key = String(attrKey ?? "").trim().toLowerCase();
  if ( !key ) return 0;
  const wantLabel = String(STATS.attributeLabels?.[key] ?? key).trim().toLowerCase();

  let value = 0;
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    const chosen = String(feat.system?.choice?.value ?? "").trim().toLowerCase();
    // Match on the attribute label (what the picker stores) OR the raw key, so a
    // feat keyed by either form resolves to the same attribute.
    if ( (chosen !== wantLabel) && (chosen !== key) ) continue;
    value += Math.max(1, Math.floor(Number(feat.system?.purchasedTier) || 1));
  }
  return value;
};

/**
 * The compendium base name of the Lethal Strike feat (single take, maxTier 9). On a
 * qualifying attack (target unaware, or within melee of an ally — adjudicated by the
 * player via a toggle), it grants advantage equal to its tier and converts up to a
 * tier-based amount of the damage into lethal damage (harder to heal).
 * @type {string}
 */
FEATS.LETHAL_STRIKE_BASE = "Lethal Strike (I - IX)";

/**
 * The maximum lethal-damage portion granted by Lethal Strike, indexed by tier
 * (SRD table): T1–2 → 5, T3–4 → 10, T5 → 15, T6–7 → 20, T8–9 → 25.
 * @type {Record<number, number>}
 */
FEATS.LETHAL_STRIKE_CAP = { 1: 5, 2: 5, 3: 10, 4: 10, 5: 15, 6: 20, 7: 20, 8: 25, 9: 25 };

/**
 * The Lethal Strike benefit for an actor, or null if the feat isn't owned. The tier
 * is the advantage on a qualifying attack roll; `lethalCap` is the maximum portion of
 * the dealt damage that becomes lethal (capped at the total damage when applied).
 * @param {Actor} actor
 * @returns {{tier: number, advantage: number, lethalCap: number}|null}
 */
FEATS.lethalStrike = function(actor) {
  const base = FEATS.LETHAL_STRIKE_BASE;
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    const tier = Math.max(1, Math.min(9, Math.floor(Number(feat.system?.purchasedTier) || 1)));
    return { tier, advantage: tier, lethalCap: FEATS.LETHAL_STRIKE_CAP[tier] ?? 0 };
  }
  return null;
};

/**
 * The compendium base name of the Death Blow feat (maxTier 2). It triggers AFTER a
 * Lethal Strike damages an enemy:
 *   Tier 1 — if the target's total HP is ≤ 5 after the attack, you may reduce them
 *            to 0 HP; you may also silence any enemy reduced to 0 HP by the attack.
 *   Tier 2 — the instant-defeat threshold rises to ≤ 10 HP, AND the Stunned bane is
 *            automatically inflicted on a successful Lethal Strike (free — it does
 *            not consume the usual one-bane-per-attack limit).
 * @type {string}
 */
FEATS.DEATH_BLOW_BASE = "Death Blow (I - II)";

/**
 * The Death Blow benefit for an actor, or null if not owned. `threshold` is the
 * post-attack HP at/under which a Lethal Strike may reduce the target to 0;
 * `autoStun` (Tier 2) inflicts Stunned automatically on a successful Lethal Strike.
 * @param {Actor} actor
 * @returns {{tier: number, threshold: number, autoStun: boolean}|null}
 */
FEATS.deathBlow = function(actor) {
  const base = FEATS.DEATH_BLOW_BASE;
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    const tier = Math.max(1, Math.min(2, Math.floor(Number(feat.system?.purchasedTier) || 1)));
    return { tier, threshold: tier >= 2 ? 10 : 5, autoStun: tier >= 2 };
  }
  return null;
};

/**
 * The compendium base name of the Longshot feat (multi-take). Each copy selects
 * one weapon (matched by base type) OR one attack type (matched by the action's
 * damage type). The pick is stored on the feat as
 * `flags.openlegend.longshot = { kind:"weapon"|"attackType", key, label }`.
 * @type {string}
 */
FEATS.LONGSHOT_BASE = "Longshot";

/**
 * The range multiplier Longshot grants a ranged attack: 2 when an owned Longshot
 * feat's pick matches this attack — a weapon of the chosen base type, or the
 * chosen attack type matching the action's damage type — else 1. (Doubling never
 * stacks: a matched attack is doubled once, regardless of how many copies match.)
 * Only meaningful for ranged / non-physical attacks (melee has no range to double).
 * @param {Actor} actor
 * @param {object} ctx
 * @param {Item|null} [ctx.weapon]     The wielded weapon (for base-type match).
 * @param {string} [ctx.damageType]    The action's damage type key.
 * @returns {{multiplier: number, label: string}}  2 + the matched pick's label, or 1 + "".
 */
FEATS.longshotRangeMultiplier = function(actor, { weapon = null, damageType = "" } = {}) {
  const base = FEATS.LONGSHOT_BASE;
  const weaponBaseType = (weapon?.type === "weapon")
    ? String(weapon.system?.baseType ?? "").trim().toLowerCase() : "";
  const dt = String(damageType ?? "").trim().toLowerCase();

  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    const pick = feat.flags?.openlegend?.longshot;
    if ( !pick?.key ) continue;
    const key = String(pick.key).trim().toLowerCase();
    const matches = (pick.kind === "weapon")
      ? (!!weaponBaseType && (weaponBaseType === key))
      : (!!dt && (dt === key));
    if ( matches ) return { multiplier: 2, label: pick.label || pick.key };
  }
  return { multiplier: 1, label: "" };
};

/**
 * The compendium base name of the Bane Focus feat (multi-take; each copy picks a
 * bane via the generic bane choice, stored in `system.choice.value`).
 * @type {string}
 */
FEATS.BANE_FOCUS_BASE = "Bane Focus";

/**
 * Advantage from Bane Focus for a bane attack inflicting `baneName`: the feat
 * grants advantage 2 on a bane attack roll to inflict its chosen bane. Multiple
 * Bane Focus feats are independent (one bane each); a given bane attack matches at
 * most one, so the bonus is a flat 2 (not summed across feats).
 * @param {Actor} actor
 * @param {string} baneName  The bane the action inflicts (action's system.baneName).
 * @returns {number}  2 when an owned Bane Focus targets this bane, else 0.
 */
FEATS.baneFocusAdvantage = function(actor, baneName) {
  const base = FEATS.BANE_FOCUS_BASE;
  const target = String(baneName ?? "").trim().toLowerCase();
  if ( !target ) return 0;
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    if ( String(feat.system?.choice?.value ?? "").trim().toLowerCase() === target ) return 2;
  }
  return 0;
};

/**
 * The set of bane names the actor has Bane Focus on (lowercased). On a damaging
 * attack, a focused bane may be inflicted "for free" when the roll exceeds the
 * target's defense by 5+ (instead of the usual 10) — see the margin rider in
 * action-roll.mjs.
 * @param {Actor} actor
 * @returns {Set<string>}  Lowercased focused bane names (empty if none owned).
 */
FEATS.baneFocusNames = function(actor) {
  const base = FEATS.BANE_FOCUS_BASE;
  const out = new Set();
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    const name = String(feat.system?.choice?.value ?? "").trim().toLowerCase();
    if ( name ) out.add(name);
  }
  return out;
};

/**
 * The compendium base name of the Potent Bane feat (multi-take, one bane each). For
 * a chosen "resist ends" bane, the target resists at disadvantage 1 — i.e. the
 * invocation is always Potent. Stored in `system.choice.value` (the bane name).
 * @type {string}
 */
FEATS.POTENT_BANE_BASE = "Potent Bane";

/**
 * The set of bane names the actor has Potent Bane for (lowercased). An invocation of
 * any of these banes is automatically Potent (target resists at disadvantage 1).
 * @param {Actor} actor
 * @returns {Set<string>}  Lowercased Potent-Bane names (empty if none owned).
 */
FEATS.potentBaneNames = function(actor) {
  const base = FEATS.POTENT_BANE_BASE;
  const out = new Set();
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    const name = String(feat.system?.choice?.value ?? "").trim().toLowerCase();
    if ( name ) out.add(name);
  }
  return out;
};

/**
 * Whether the actor has Potent Bane for `baneName` (so the bane is always Potent).
 * @param {Actor} actor
 * @param {string} baneName
 * @returns {boolean}
 */
FEATS.isPotentBane = function(actor, baneName) {
  const name = String(baneName ?? "").trim().toLowerCase();
  return !!name && FEATS.potentBaneNames(actor).has(name);
};

/**
 * The compendium base name of the Multi-Bane Specialist feat (multi-take, each copy
 * a distinct PAIR of banes). Each copy lets the actor invoke its two chosen banes
 * with a single attack. The pair is stored in `system.choice.value` as
 * "Bane A & Bane B" (the generic two-pick feat choice). The player is responsible
 * for picking a valid pair (shared prerequisite attribute; the required score is the
 * SUM of the two power levels).
 * @type {string}
 */
FEATS.MULTI_BANE_SPECIALIST_BASE = "Multi-Bane Specialist";

/**
 * The bane-name PAIRS the actor has Multi-Bane Specialist for: one [nameA, nameB]
 * per owned copy (original-case names, as stored in the feat choice). Empty when
 * the feat isn't owned.
 * @param {Actor} actor
 * @returns {Array<[string, string]>}
 */
FEATS.multiBanePairs = function(actor) {
  const base = FEATS.MULTI_BANE_SPECIALIST_BASE;
  const out = [];
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    const parts = String(feat.system?.choice?.value ?? "").split("&").map(s => s.trim()).filter(Boolean);
    if ( parts.length === 2 ) out.push([parts[0], parts[1]]);
  }
  return out;
};

/**
 * Whether the actor owns Multi-Bane Specialist (any pair).
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.hasMultiBaneSpecialist = function(actor) {
  return FEATS.multiBanePairs(actor).length > 0;
};

/**
 * The canonical value string for a Multi-Bane pair ("Bane A & Bane B"), matching the
 * feat's stored `choice.value`. Used as the action's `system.multiBanePair` key.
 * @param {[string, string]} pair
 * @returns {string}
 */
FEATS.multiBanePairValue = function(pair) {
  return (pair ?? []).map(n => String(n).trim()).join(" & ");
};

/**
 * The actor's Multi-Bane pairs as { value, label } options for a picker. `value` is
 * the canonical "A & B" string (the action stores this in system.multiBanePair).
 * @param {Actor} actor
 * @returns {Array<{value: string, label: string}>}
 */
FEATS.multiBanePairOptions = function(actor) {
  return FEATS.multiBanePairs(actor).map(p => {
    const value = FEATS.multiBanePairValue(p);
    return { value, label: value };
  });
};

/**
 * Resolve a Multi-Bane Specialist pair to live bane data. The pair is chosen by, in
 * order: an exact `pairValue` ("A & B") match, then a `preferNames` set match, then
 * the actor's first owned pair. Each resolved entry carries the bane's uuid, name,
 * power level, and the defense its attacks target. Returns null when the feat isn't
 * owned or a bane name can't be resolved.
 * @param {Actor} actor
 * @param {object} [opts]
 * @param {string} [opts.pairValue]      The chosen pair's canonical "A & B" value.
 * @param {string[]} [opts.preferNames]  Names to prefer when no pairValue matches.
 * @returns {Promise<{requiredScore: number, pairValue: string, banes: Array<{uuid: string, name: string, powerLevel: number, defense: string}>}|null>}
 */
FEATS.resolveMultiBanePair = async function(actor, { pairValue = "", preferNames = [] } = {}) {
  const pairs = FEATS.multiBanePairs(actor);
  if ( !pairs.length ) return null;
  const wantValue = String(pairValue ?? "").trim().toLowerCase();
  const want = new Set((preferNames ?? []).map(n => String(n).toLowerCase()));
  const pair =
    (wantValue && pairs.find(p => FEATS.multiBanePairValue(p).toLowerCase() === wantValue))
    || (want.size && pairs.find(p => p.every(n => want.has(String(n).toLowerCase()))))
    || pairs[0];

  const banes = [];
  for ( const name of pair ) {
    const doc = await BANE.resolveBaneByName(name);
    if ( !doc ) return null;
    const attacks = doc.system?.attacks ?? [];
    banes.push({
      uuid: doc.uuid,
      name: doc.name,
      powerLevel: Number(doc.system?.powerLevel ?? 0),
      defense: String(attacks[0]?.defense ?? "guard").toLowerCase()
    });
  }
  // The combined attribute requirement is the SUM of the two power levels.
  const requiredScore = banes.reduce((s, b) => s + b.powerLevel, 0);
  return { requiredScore, pairValue: FEATS.multiBanePairValue(pair), banes };
};

/**
 * The compendium base name of the Boon Access feat (multi-take). Each copy buys an
 * ATTRIBUTE LEVEL to invoke ONE boon the actor lacks the attribute for; the pick
 * is stored in `flags.openlegend.boonAccess = { boonUuid, boonName, attribute,
 * powerLevel }` where `powerLevel` is the BOUGHT attribute level (= the feat cost
 * AND the effective invocation score; must be ≥ the boon's minimum PL). Invocation
 * treats the actor's attribute score as that level.
 * @type {string}
 */
FEATS.BOON_ACCESS_BASE = "Boon Access";

/**
 * The Boon Access grants an actor owns: one per Boon Access feat. `powerLevel` is
 * the BOUGHT attribute level — the effective attribute score for invocation +
 * prerequisites (≥ the boon's minimum PL, supplies the roll dice). The owning
 * feat's id is included so a boon action can route the invocation through it
 * (reusing the item-invocation roll path: value supplies score + dice).
 * @param {Actor} actor
 * @returns {Array<{featId: string, boonUuid: string, boonName: string, attribute: string, powerLevel: number}>}
 */
FEATS.boonAccessGrants = function(actor) {
  const base = FEATS.BOON_ACCESS_BASE;
  const out = [];
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    const ba = feat.flags?.openlegend?.boonAccess;
    if ( !ba?.boonUuid || !ba?.attribute ) continue;
    out.push({
      featId: feat.id,
      boonUuid: ba.boonUuid,
      boonName: ba.boonName ?? "",
      attribute: ba.attribute,                                   // attribute KEY
      powerLevel: Math.max(1, Math.floor(Number(ba.powerLevel) || 1))
    });
  }
  return out;
};

/**
 * The compendium base name of the Boon Focus feat (multi-take, maxTier 3). Each
 * copy picks a boon via the generic boon choice (stored in `system.choice.value`);
 * its TIER (independent per boon) governs the benefits — see {@link FEATS.boonFocus}.
 * @type {string}
 */
FEATS.BOON_FOCUS_BASE = "Boon Focus (I - III)";

/**
 * Resolve the Boon Focus benefit for invoking a particular boon at a particular
 * targeting mode. Matches an owned Boon Focus feat whose chosen boon equals
 * `boonName` (case-insensitive) and returns its benefits by tier:
 *
 * - SINGLE target, Tier 1+: the invocation AUTO-SUCCEEDS (no action roll needed;
 *   `autoSuccess: true`). It may still be invoked at any power level the actor
 *   could otherwise reach.
 * - NOT single-targeting (multiple OR area): advantage on the action roll, scaled
 *   by tier — Tier 1 → 2, Tier 2 → 3, Tier 3 → 4 (if the boon's duration is
 *   "Sustain Persists") or 5 (any other duration). This advantage is FLAT (it does
 *   not reduce the multi-targeting disadvantage; both apply).
 * - Tier 2+: the invocation time is reduced one increment — surfaced as a manual
 *   `fasterNote` (the GM applies it; the system does not track action economy).
 * - Tier 3 + Sustain Persists: an extra `sustainNote` (sustain as a free action,
 *   re-invoke a canceled boon as a free action, nullify resistance).
 *
 * @param {Actor} actor
 * @param {object} ctx
 * @param {string} ctx.boonName        The invoked boon's name (action's system.boonName).
 * @param {string} [ctx.duration]      The boon's duration string (for the Tier-3 split).
 * @param {string} [ctx.targets]       The action's targeting mode ("single"/"multiple"/"area").
 * @returns {{tier: number, autoSuccess: boolean, advantage: number, fasterNote: string, sustainNote: string}|null}
 *          The benefit, or null when no owned Boon Focus matches this boon.
 */
FEATS.boonFocus = function(actor, { boonName, duration = "", targets = "single" } = {}) {
  const base = FEATS.BOON_FOCUS_BASE;
  const target = String(boonName ?? "").trim().toLowerCase();
  if ( !target ) return null;
  let feat = null;
  for ( const f of (actor?.items ?? []) ) {
    if ( (f.type !== "feat") || ((f.system?.baseName || f.name) !== base) ) continue;
    if ( String(f.system?.choice?.value ?? "").trim().toLowerCase() === target ) { feat = f; break; }
  }
  if ( !feat ) return null;

  const tier = Math.max(1, Math.min(3, Math.floor(Number(feat.system?.purchasedTier) || 1)));
  const single = String(targets ?? "single") === "single";
  const sustainPersists = /sustain\s*persists/i.test(String(duration ?? ""));

  // Advantage when multi-targeting (single-targeting gets auto-success, not advantage).
  let advantage = 0;
  if ( !single ) {
    if ( tier === 1 ) advantage = 2;
    else if ( tier === 2 ) advantage = 3;
    else advantage = sustainPersists ? 4 : 5;            // tier 3
  }

  // Tier 2+: one-increment-faster invocation, applied manually by the GM.
  const fasterNote = (tier >= 2)
    ? "Boon Focus: invoke one time increment faster (major/move → minor, focus → major, 1 min → focus, 10 min → 1 min, 1 hr → 10 min, 8 hr → 1 hr; a minor-action boon may be invoked as a minor action only once per round, otherwise expend a move/major action)."
    : "";

  // Tier 3 + Sustain Persists: free-action sustain / re-invocation, nullify resistance.
  const sustainNote = ((tier >= 3) && sustainPersists)
    ? "Boon Focus (Tier 3): sustain one instance each round as a free action; re-invoke as a free action if temporarily canceled; only a power-level-6+ Nullify can cancel it."
    : "";

  return { tier, autoSuccess: single, advantage, fasterNote, sustainNote };
};

/**
 * The compendium base name of the Superior Concentration feat (single take, maxTier
 * 3). When you take the SUSTAIN A BOON minor action, you may sustain one additional
 * boon per tier you possess.
 * @type {string}
 */
FEATS.SUPERIOR_CONCENTRATION_BASE = "Superior Concentration (I - III)";

/**
 * The owned tier of Superior Concentration (0 if not owned), clamped to its maxTier 3.
 * @param {Actor} actor
 * @returns {number}
 */
FEATS.superiorConcentrationTier = function(actor) {
  const base = FEATS.SUPERIOR_CONCENTRATION_BASE;
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    return Math.max(1, Math.min(3, Math.floor(Number(feat.system?.purchasedTier) || 1)));
  }
  return 0;
};

/**
 * How many boons the actor can sustain with a single SUSTAIN A BOON minor action:
 * a base of 1, plus one per tier of Superior Concentration. Always ≥ 1.
 * @param {Actor} actor
 * @returns {number}
 */
FEATS.sustainBoonSlots = function(actor) {
  return 1 + FEATS.superiorConcentrationTier(actor);
};

/**
 * The compendium base name of the Battle Trance feat (single take). It's a
 * TOGGLED feat: the owned copy carries `flags.openlegend.battleTranceActive`.
 * @type {string}
 */
FEATS.BATTLE_TRANCE_BASE = "Battle Trance";

/**
 * The compendium base name of the Battlefield Retribution feat (single take,
 * passive). When the owner uses a Defend interrupt, they deal damage to the
 * attacker equal to how much their defend roll exceeds the attacker's roll.
 * @type {string}
 */
FEATS.BATTLEFIELD_RETRIBUTION_BASE = "Battlefield Retribution";

/**
 * Whether an actor owns the Battlefield Retribution feat.
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.hasBattlefieldRetribution = function(actor) {
  const base = FEATS.BATTLEFIELD_RETRIBUTION_BASE;
  return (actor?.items ?? []).some(feat =>
    (feat.type === "feat") && ((feat.system?.baseName || feat.name) === base));
};

/**
 * The compendium base name of the Battlefield Punisher feat (single take). It
 * picks a bane via the generic bane choice (stored in `system.choice.value`).
 * @type {string}
 */
FEATS.BATTLEFIELD_PUNISHER_BASE = "Battlefield Punisher";

/**
 * The Battlefield Punisher bane name to offer on a Defend interrupt, or "" — set
 * when the actor owns the feat AND the defend ATTRIBUTE could inflict the chosen
 * bane (the bane lists that attribute as an attacking attribute). The caller adds
 * the ≥10 Battlefield-Retribution-damage condition. Returns the bane's display
 * name (matching the compendium), for the punish card.
 * @param {Actor} actor
 * @param {string} defendAttrKey  The attribute key the defend was rolled with.
 * @returns {Promise<string>}
 */
FEATS.battlefieldPunisherBane = async function(actor, defendAttrKey) {
  const base = FEATS.BATTLEFIELD_PUNISHER_BASE;
  const feat = (actor?.items ?? []).find(f =>
    (f.type === "feat") && ((f.system?.baseName || f.name) === base));
  const baneName = String(feat?.system?.choice?.value ?? "").trim();
  if ( !baneName || !defendAttrKey ) return "";
  // The defend attribute must be able to inflict the bane: the bane lists it
  // among its attacking attributes. Resolve the bane (world item, then compendium).
  const attrLabel = String(STATS.attributeLabels?.[defendAttrKey] ?? defendAttrKey).trim().toLowerCase();
  let bane = game.items?.find(i => (i.type === "bane") && (i.name === baneName)) ?? null;
  if ( !bane ) {
    const pack = game.packs?.get("tomucatos-open-legend-rpg-system.banes");
    if ( pack ) {
      const idx = await pack.getIndex({ fields: ["system.attacks"] });
      const entry = idx.find(e => e.name === baneName);
      if ( entry ) bane = await pack.getDocument(entry._id);
    }
  }
  const attrs = (bane?.system?.attacks ?? [])
    .map(a => String(a.attackingAttribute ?? "").trim().toLowerCase());
  // If we can't resolve the bane's attacks, allow it (don't block on missing data).
  if ( attrs.length && !attrs.includes(attrLabel) ) return "";
  return baneName;
};

/**
 * The owned Battle Trance feat that is currently TOGGLED ON, if any (so callers
 * can flip the flag), or null. While active: advantage 1 on all attacks (damaging
 * + bane), Toughness & Resolve +3, and the Guard armor bonus floored at 3.
 * @param {Actor} actor
 * @returns {Item|null}
 */
FEATS.battleTranceFeat = function(actor) {
  const base = FEATS.BATTLE_TRANCE_BASE;
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    return feat;
  }
  return null;
};

/**
 * Whether the actor is currently in a Battle Trance (owns the feat and has it
 * toggled on).
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.battleTranceActive = function(actor) {
  const feat = FEATS.battleTranceFeat(actor);
  return !!(feat && feat.flags?.openlegend?.battleTranceActive);
};

/**
 * The compendium base name of the Deathless Trance feat (single take, passive).
 * Requires Battle Trance. While IN a battle trance you can't be knocked
 * unconscious — damage is recorded even below 0 HP; when the trance ends, if HP < 0
 * you collapse, and die if not healed to ≥0 within 1 round.
 * @type {string}
 */
FEATS.DEATHLESS_TRANCE_BASE = "Deathless Trance";

/**
 * Whether the actor owns the Deathless Trance feat.
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.hasDeathlessTrance = function(actor) {
  const base = FEATS.DEATHLESS_TRANCE_BASE;
  return (actor?.items ?? []).some(feat =>
    (feat.type === "feat") && ((feat.system?.baseName || feat.name) === base));
};

/**
 * Whether the actor's hit points may currently drop BELOW ZERO when taking damage:
 * true only while IN a battle trance AND owning Deathless Trance (otherwise damage
 * floors HP at 0). Damage-apply paths consult this to skip the 0 floor.
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.canTakeNegativeDamage = function(actor) {
  return !!(actor && FEATS.battleTranceActive(actor) && FEATS.hasDeathlessTrance(actor));
};

/**
 * The compendium base name of the Destructive Trance feat (single take, passive;
 * requires Battle Trance). While in a battle trance, every die in an ATTACK roll's
 * pool explodes on its max OR one below (d6 on 5–6, d8 on 7–8, … d20 on 19–20),
 * the rolled value still counting as itself.
 * @type {string}
 */
FEATS.DESTRUCTIVE_TRANCE_BASE = "Destructive Trance";

/**
 * Whether the actor owns the Destructive Trance feat.
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.hasDestructiveTrance = function(actor) {
  const base = FEATS.DESTRUCTIVE_TRANCE_BASE;
  return (actor?.items ?? []).some(feat =>
    (feat.type === "feat") && ((feat.system?.baseName || feat.name) === base));
};

/**
 * Whether an ATTACK roll's dice should explode on max OR one-below-max right now:
 * true only while IN a battle trance AND owning Destructive Trance.
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.attackExplodesBelowMax = function(actor) {
  return !!(actor && FEATS.battleTranceActive(actor) && FEATS.hasDestructiveTrance(actor));
};

/**
 * The compendium base name of the Reckless Attack feat (single take; requires
 * Battle Trance). While in a battle trance, on your turn you may inflict 5 HP of
 * self-damage to make an extra attack as a minor action. The self-damage is flat
 * and unmitigable (effects that prevent or reduce damage cannot affect it), and is
 * suffered BEFORE the extra attack, so you must remain conscious afterwards to
 * benefit. Surfaces a draggable control in the Actions section.
 * @type {string}
 */
FEATS.RECKLESS_ATTACK_BASE = "Reckless Attack";

/**
 * Whether the actor owns the Reckless Attack feat.
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.hasRecklessAttack = function(actor) {
  const base = FEATS.RECKLESS_ATTACK_BASE;
  return (actor?.items ?? []).some(feat =>
    (feat.type === "feat") && ((feat.system?.baseName || feat.name) === base));
};

/** Fixed self-damage cost of a Reckless Attack extra attack. */
FEATS.RECKLESS_ATTACK_COST = 5;

/**
 * The compendium base name of the Vicious Strike feat (single take, passive). On a
 * natural 20 on the attack d20, every SUBSEQUENT d20 re-roll from a dice explosion
 * is rolled with advantage 1 (roll 2 d20s, keep the higher).
 * @type {string}
 */
FEATS.VICIOUS_STRIKE_BASE = "Vicious Strike";

/**
 * Whether the actor owns the Vicious Strike feat.
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.hasViciousStrike = function(actor) {
  const base = FEATS.VICIOUS_STRIKE_BASE;
  return (actor?.items ?? []).some(feat =>
    (feat.type === "feat") && ((feat.system?.baseName || feat.name) === base));
};

/**
 * The compendium base name of the Defensive Mastery feat (single take, passive).
 * While wielding a weapon with the Defensive property: +1 ADDITIONAL armor bonus to
 * Guard (on top of the base +1 for wielding any defensive weapon), AND the wielded
 * item's Defensive VALUE is increased by 1 (1→2, 2→3) for the defend-roll advantage.
 * @type {string}
 */
FEATS.DEFENSIVE_MASTERY_BASE = "Defensive Mastery";

/**
 * Whether the actor owns the Defensive Mastery feat.
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.hasDefensiveMastery = function(actor) {
  const base = FEATS.DEFENSIVE_MASTERY_BASE;
  return (actor?.items ?? []).some(feat =>
    (feat.type === "feat") && ((feat.system?.baseName || feat.name) === base));
};

/**
 * The compendium base name of the Defensive Reflexes feat (single take, maxTier 9,
 * passive). Each tier grants advantage 1 on the defend action's roll.
 * @type {string}
 */
FEATS.DEFENSIVE_REFLEXES_BASE = "Defensive Reflexes (I - IX)";

/**
 * The actor's Defensive Reflexes advantage on a defend roll: the owned feat's
 * purchased tier (advantage 1 per tier), or 0 if not owned.
 * @param {Actor} actor
 * @returns {number}
 */
FEATS.defensiveReflexesAdvantage = function(actor) {
  const base = FEATS.DEFENSIVE_REFLEXES_BASE;
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    return Math.max(1, Math.floor(Number(feat.system?.purchasedTier) || 1));
  }
  return 0;
};

/**
 * The compendium base name of the Extraordinary Defense feat (single take, maxTier
 * 3, passive). Grants +1 to ALL defenses (Guard, Toughness, Resolve) per tier.
 * @type {string}
 */
FEATS.EXTRAORDINARY_DEFENSE_BASE = "Extraordinary Defense (I - III)";

/**
 * The Extraordinary Defense bonus to every defense: the owned feat's purchased tier
 * (+1 per tier, Guard/Toughness/Resolve alike), or 0 if not owned.
 * @param {Actor} actor
 * @returns {number}
 */
FEATS.extraordinaryDefenseBonus = function(actor) {
  const base = FEATS.EXTRAORDINARY_DEFENSE_BASE;
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    return Math.max(1, Math.min(3, Math.floor(Number(feat.system?.purchasedTier) || 1)));
  }
  return 0;
};

/**
 * The compendium base name of the Natural Defense feat (single take, maxTier 3,
 * passive). While NOT wearing armor, it grants +tier to Guard AND Toughness.
 * @type {string}
 */
FEATS.NATURAL_DEFENSE_BASE = "Natural Defense (I - III)";

/**
 * The Natural Defense bonus to Guard and Toughness: the owned feat's purchased tier
 * (+1 per tier, max 3), or 0 if not owned. The no-armor condition is applied by the
 * caller (it knows whether armor is equipped).
 * @param {Actor} actor
 * @returns {number}
 */
FEATS.naturalDefenseBonus = function(actor) {
  const base = FEATS.NATURAL_DEFENSE_BASE;
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    return Math.max(1, Math.min(3, Math.floor(Number(feat.system?.purchasedTier) || 1)));
  }
  return 0;
};

/**
 * The compendium base name of the Tough as Nails feat (single take, maxTier 2,
 * passive). You permanently gain 5 extra hit points per tier you possess.
 * @type {string}
 */
FEATS.TOUGH_AS_NAILS_BASE = "Tough as Nails (I - II)";

/**
 * The Tough as Nails bonus to the (unreduced) hit-point maximum: 5 × the owned feat's
 * purchased tier (max tier 2 → +10), or 0 if not owned. Folded into the base max
 * BEFORE lethal-damage reduction.
 * @param {Actor} actor
 * @returns {number}
 */
FEATS.toughAsNailsBonus = function(actor) {
  const base = FEATS.TOUGH_AS_NAILS_BASE;
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    return 5 * Math.max(1, Math.min(2, Math.floor(Number(feat.system?.purchasedTier) || 1)));
  }
  return 0;
};

/**
 * The compendium base name of the Indomitable Resolve feat (multi-take, maxTier 3,
 * passive). For each tier possessed, the RESOLVE defense is increased by 1.
 * @type {string}
 */
FEATS.INDOMITABLE_RESOLVE_BASE = "Indomitable Resolve (I - III)";

/**
 * The Indomitable Resolve bonus to the Resolve defense: +1 per purchased tier,
 * summed across all owned Indomitable Resolve feats (0 if none).
 * @param {Actor} actor
 * @returns {number}
 */
FEATS.indomitableResolveBonus = function(actor) {
  const base = FEATS.INDOMITABLE_RESOLVE_BASE;
  let tiers = 0;
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    tiers += Math.max(1, Math.floor(Number(feat.system?.purchasedTier) || 1));
  }
  return tiers;
};

/**
 * The compendium base name of the Inspiring Champion feat (single take, maxTier 3,
 * passive). When a damaging attack roll exceeds an enemy's defense by 10+, allies
 * within 5' × your Presence score who can see the attack are healed:
 *   Tier 1 — one ally heals 1d4 HP.
 *   Tier 2 — a number of allies equal to your Presence score heal 1d4 HP.
 *   Tier 3 — all allies who can see the attack heal 2d4 HP.
 * @type {string}
 */
/**
 * The compendium base name of the Overpowering Strike feat (single take). Each time
 * you deal damage with a Forceful weapon, you may push the target 5' away.
 * @type {string}
 */
FEATS.OVERPOWERING_STRIKE_BASE = "Overpowering Strike";

/**
 * Whether the actor owns Overpowering Strike.
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.hasOverpoweringStrike = function(actor) {
  const base = FEATS.OVERPOWERING_STRIKE_BASE;
  return (actor?.items ?? []).some(f =>
    (f.type === "feat") && ((f.system?.baseName || f.name) === base));
};

/**
 * The compendium base name of the Crushing Blow feat (single take; prereq
 * Overpowering Strike). When you deal damage and use the Overpowering Strike push,
 * you may also knock the target down where the forced move ends (Knockdown bane).
 * @type {string}
 */
FEATS.CRUSHING_BLOW_BASE = "Crushing Blow";

/**
 * Whether the actor owns Crushing Blow.
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.hasCrushingBlow = function(actor) {
  const base = FEATS.CRUSHING_BLOW_BASE;
  return (actor?.items ?? []).some(f =>
    (f.type === "feat") && ((f.system?.baseName || f.name) === base));
};

FEATS.INSPIRING_CHAMPION_BASE = "Inspiring Champion (I - III)";

/**
 * The owned Inspiring Champion tier (1–3), or 0 if not owned.
 * @param {Actor} actor
 * @returns {number}
 */
FEATS.inspiringChampionTier = function(actor) {
  const base = FEATS.INSPIRING_CHAMPION_BASE;
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    return Math.max(1, Math.min(3, Math.floor(Number(feat.system?.purchasedTier) || 1)));
  }
  return 0;
};

/**
 * The Inspiring Champion healing rider for an attacker, or null if not owned. The
 * tier sets the healing dice, the affected-ally count, and the in-range distance
 * (5' × Presence). The roll is granted on a damaging hit whose margin is ≥ 10; we
 * don't enforce the once-per-round limit (the GM tracks it).
 * @param {Actor} actor
 * @returns {{tier:number, formula:string, dice:string, presence:number, range:number, allies:string}|null}
 */
FEATS.inspiringChampionRider = function(actor) {
  const tier = FEATS.inspiringChampionTier(actor);
  if ( !tier ) return null;
  const presence = Math.max(0, Math.floor(Number(actor?.system?.attributes?.presence?.value) || 0));
  const range = presence * 5;
  const formula = tier >= 3 ? "2d4" : "1d4";
  // Affected-ally description: T1 one ally, T2 allies up to Presence, T3 all.
  const allies = tier === 1
    ? "A single ally that can see the attack"
    : tier === 2
      ? `Up to ${presence} all${presence === 1 ? "y" : "ies"} (your Presence score) that can see the attack`
      : "All allies that can see the attack";
  return { tier, formula, dice: formula, presence, range, allies };
};

/**
 * The compendium base name of the Lightning Reflexes feat (single take, maxTier 5,
 * passive). For each tier possessed, you gain advantage 1 on ALL initiative rolls.
 * @type {string}
 */
FEATS.LIGHTNING_REFLEXES_BASE = "Lightning Reflexes (I - V)";

/**
 * The Lightning Reflexes advantage on initiative rolls: the owned feat's purchased
 * tier (advantage 1 per tier, capped at 5), or 0 if not owned.
 * @param {Actor} actor
 * @returns {number}
 */
FEATS.lightningReflexesAdvantage = function(actor) {
  const base = FEATS.LIGHTNING_REFLEXES_BASE;
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    return Math.max(1, Math.min(5, Math.floor(Number(feat.system?.purchasedTier) || 1)));
  }
  return 0;
};

/**
 * The compendium base name of the Extraordinary Focus feat (multi-take, one per
 * attribute). Each copy picks a focus item (free text / bookkeeping) and the
 * extraordinary attribute it empowers; the pick is stored on the feat as
 * `flags.openlegend.extraordinaryFocus = { attribute, focus }`.
 * @type {string}
 */
FEATS.EXTRAORDINARY_FOCUS_BASE = "Extraordinary Focus";

/**
 * Attribute keys empowered by an owned Extraordinary Focus feat. The feat treats
 * the chosen attribute as ONE GREATER for the purpose of attribute DICE on action
 * rolls only (the score itself is unchanged for feats/banes/boons/defenses/etc.).
 * Multi-take requires a distinct attribute per copy, so a key appears at most once.
 * @param {Actor} actor
 * @returns {Set<string>}  The focused attribute keys.
 */
FEATS.extraordinaryFocusAttributes = function(actor) {
  const base = FEATS.EXTRAORDINARY_FOCUS_BASE;
  const out = new Set();
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    const key = String(feat.flags?.openlegend?.extraordinaryFocus?.attribute ?? "").trim();
    if ( key ) out.add(key);
  }
  return out;
};

/**
 * Extraordinary Focus dice bonus for an attribute on an ACTION ROLL: +1 step on
 * the attribute-dice ladder (treat the score as one greater) when the actor owns
 * an Extraordinary Focus for that attribute, else 0. Applies to attribute dice
 * only — never to the score used by HP, defenses, feat prerequisites, or
 * bane/boon power levels.
 * @param {Actor} actor
 * @param {string} attrKey
 * @returns {number}  1 if focused, else 0.
 */
FEATS.extraordinaryFocusBonus = function(actor, attrKey) {
  if ( !attrKey ) return 0;
  return FEATS.extraordinaryFocusAttributes(actor).has(attrKey) ? 1 : 0;
};

/**
 * The compendium base name of the Martial Focus feat (single take). The character
 * picks one weapon (matched by base type — Unarmed Strike is itself a weapon in the
 * catalog) and the attribute the focus relies on (Agility or Might). Stored on the
 * feat as `flags.openlegend.martialFocus = { weapon, attribute, label }`, where
 * `weapon` is the chosen weapon's base type.
 * @type {string}
 */
FEATS.MARTIAL_FOCUS_BASE = "Martial Focus";

/**
 * The owned Martial Focus pick, or null if not owned.
 * @param {Actor} actor
 * @returns {{weapon: string, attribute: string, label: string}|null}
 */
FEATS.martialFocus = function(actor) {
  const base = FEATS.MARTIAL_FOCUS_BASE;
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    const mf = feat.flags?.openlegend?.martialFocus;
    if ( !mf?.attribute ) continue;
    return {
      weapon: String(mf.weapon ?? "").trim().toLowerCase(),
      attribute: String(mf.attribute ?? "").trim().toLowerCase(),
      label: mf.label || ""
    };
  }
  return null;
};

/**
 * Whether an attack matches the actor's Martial Focus: the chosen weapon (by base
 * type) — or unarmed (no weapon) when the focus is unarmed — AND the chosen
 * attribute. Used both to grant the +1 attribute-dice step and to decide the
 * disadvantage-1 penalty on NON-focus attacks.
 * @param {Actor} actor
 * @param {object} ctx
 * @param {Item|null} [ctx.weapon]   The wielded weapon.
 * @param {string} [ctx.attrKey]     The attack's attribute key.
 * @returns {boolean}
 */
FEATS.martialFocusMatches = function(actor, { weapon = null, attrKey = "" } = {}) {
  const mf = FEATS.martialFocus(actor);
  if ( !mf || !mf.weapon ) return false;
  if ( String(attrKey).trim().toLowerCase() !== mf.attribute ) return false;
  const weaponBaseType = (weapon?.type === "weapon")
    ? String(weapon.system?.baseType ?? "").trim().toLowerCase() : "";
  return weaponBaseType === mf.weapon;
};

/**
 * The compendium base name of the Extraordinary Healing feat. The Heal action's
 * "Extraordinary Healing" toggle is offered only when the acting actor owns it.
 * @type {string}
 */
FEATS.EXTRAORDINARY_HEALING_BASE = "Extraordinary Healing";

/**
 * Whether the actor owns the Extraordinary Healing feat.
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.hasExtraordinaryHealing = function(actor) {
  const base = FEATS.EXTRAORDINARY_HEALING_BASE;
  return [...(actor?.items ?? [])].some(i => (i.type === "feat") && ((i.system?.baseName || i.name) === base));
};

/**
 * The compendium base name of the Armor Mastery feat. Hard-coded passive
 * automation keyed off this name (no purchase-time choice — it scales with tier).
 * @type {string}
 */
FEATS.ARMOR_MASTERY_BASE = "Armor Mastery (I - II)";

/**
 * The actor's effective Armor Mastery tier: the highest tier among owned Armor
 * Mastery feats (0 if none). WHILE WEARING ARMOR it grants a +tier armor bonus to
 * Guard (Tier 1 → +1, Tier 2 → +2) and reduces the Fortitude prerequisite for
 * wearing armor by `tier` (informational). At Tier 2 ONLY, the armor movement
 * penalty is reduced by a flat 5' (it offsets the penalty, never lowers base
 * speed). See the feat text — the speed relief is flat and Tier-2-gated, NOT
 * 5'×tier.
 * @param {Actor} actor
 * @returns {number}  The Armor Mastery tier (0–maxTier), or 0 if not owned.
 */
FEATS.armorMasteryTier = function(actor) {
  const base = FEATS.ARMOR_MASTERY_BASE;
  let tier = 0;
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    tier = Math.max(tier, Math.max(1, Math.floor(Number(feat.system?.purchasedTier) || 1)));
  }
  return tier;
};

/**
 * The compendium base name of the Climbing feat (single take, passive): "You gain
 * a climb speed equal to your base speed …". Detected by name; grants a derived
 * climb speed in prepareDerivedData (= the final effective speed).
 * @type {string}
 */
FEATS.CLIMBING_BASE = "Climbing";

/**
 * Whether the actor owns the Climbing feat (→ a climb speed equal to their speed).
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.hasClimbSpeed = function(actor) {
  const base = FEATS.CLIMBING_BASE;
  return (actor?.items ?? []).some(feat =>
    (feat.type === "feat") && ((feat.system?.baseName || feat.name) === base));
};

/**
 * The compendium base name of the Hospitaler feat. Hard-coded automation keyed off
 * this name: a major action grants targeted allies an immediate resist roll with
 * advantage 1, and the actor invokes the Restoration boon with advantage 1.
 * @type {string}
 */
FEATS.HOSPITALER_BASE = "Hospitaler";

/**
 * Whether the actor owns the Hospitaler feat.
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.hasHospitaler = function(actor) {
  const base = FEATS.HOSPITALER_BASE;
  return (actor?.items ?? []).some(feat =>
    (feat.type === "feat") && ((feat.system?.baseName || feat.name) === base));
};

/**
 * The compendium base name of the Resilient feat (single take, passive). Any time
 * the actor makes a resist roll (to shake off a bane), they have advantage 1. This
 * STACKS with a Hospitaler-granted advantage 1 → advantage 2 (3d20, keep highest);
 * a Potent bane's disadvantage 1 cancels one step of it.
 * @type {string}
 */
FEATS.RESILIENT_BASE = "Resilient";

/**
 * Whether the actor owns the Resilient feat.
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.hasResilient = function(actor) {
  const base = FEATS.RESILIENT_BASE;
  return (actor?.items ?? []).some(feat =>
    (feat.type === "feat") && ((feat.system?.baseName || feat.name) === base));
};

/**
 * The net advantage Resilient contributes to a resist roll: 1 if the actor owns the
 * feat, else 0. Callers add this to any other adv/disadv (Hospitaler +1, Potent −1).
 * @param {Actor} actor
 * @returns {number}
 */
FEATS.resilientResistAdvantage = function(actor) {
  return FEATS.hasResilient(actor) ? 1 : 0;
};

/**
 * The compendium base name of the Flying feat (→ a fly speed equal to their speed).
 * @type {string}
 */
FEATS.FLYING_BASE = "Flying";

/**
 * Whether the actor owns the Flying feat (→ a fly speed equal to their speed).
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.hasFlySpeed = function(actor) {
  const base = FEATS.FLYING_BASE;
  return (actor?.items ?? []).some(feat =>
    (feat.type === "feat") && ((feat.system?.baseName || feat.name) === base));
};

/**
 * The compendium base name of the Swimming feat (single take, passive): "You gain a
 * swimming speed equal to your base speed …". Grants a derived swim speed in
 * prepareDerivedData (= the final effective speed).
 * @type {string}
 */
FEATS.SWIMMING_BASE = "Swimming";

/**
 * Whether the actor owns the Swimming feat (→ a swim speed equal to their speed).
 * @param {Actor} actor
 * @returns {boolean}
 */
FEATS.hasSwimSpeed = function(actor) {
  const base = FEATS.SWIMMING_BASE;
  return (actor?.items ?? []).some(feat =>
    (feat.type === "feat") && ((feat.system?.baseName || feat.name) === base));
};

/**
 * The compendium base name of the Sworn Enemy feat (multi-take, maxTier 9 per group).
 * Each copy names a species/race/faction (free-text bookkeeping, stored in
 * `system.choice.value`) and grants advantage equal to its tier on MENTAL attribute
 * rolls (Learning, Logic, Perception, Will) pertaining to that group. Whether a roll
 * "pertains" is a narrative call, so it's applied via an opt-in toggle on the roll
 * dialog (one per group) rather than always-on.
 * @type {string}
 */
FEATS.SWORN_ENEMY_BASE = "Sworn Enemy (I - IX)";

/**
 * The Mental attribute keys (Sworn Enemy applies only to rolls with these).
 * @type {string[]}
 */
FEATS.MENTAL_ATTRIBUTES = ["learning", "logic", "perception", "will"];

/**
 * The actor's Sworn Enemy groups: one entry per chosen group, with the total tier
 * for that group (summed across copies that picked the same group, per the SRD —
 * "your total advantage … is equal to your tier for that particular group").
 * @param {Actor} actor
 * @returns {Array<{label: string, tier: number}>}
 */
FEATS.swornEnemyGroups = function(actor) {
  const base = FEATS.SWORN_ENEMY_BASE;
  const byGroup = new Map();   // lowercased label → { label, tier }
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    const label = String(feat.system?.choice?.value ?? "").trim();
    if ( !label ) continue;
    const tier = Math.max(1, Math.min(9, Math.floor(Number(feat.system?.purchasedTier) || 1)));
    const key = label.toLowerCase();
    const cur = byGroup.get(key);
    if ( cur ) cur.tier = Math.min(9, cur.tier + tier);
    else byGroup.set(key, { label, tier });
  }
  return [...byGroup.values()];
};

/**
 * Whether `attrKey` is a Mental attribute (Sworn Enemy's scope).
 * @param {string} attrKey
 * @returns {boolean}
 */
FEATS.isMentalAttribute = function(attrKey) {
  return FEATS.MENTAL_ATTRIBUTES.includes(String(attrKey ?? "").trim().toLowerCase());
};

/**
 * The compendium base name of the Fleet of Foot feat (tiers I–III): your speed is
 * permanently increased by 5' per tier.
 * @type {string}
 */
FEATS.FLEET_OF_FOOT_BASE = "Fleet of Foot (I - III)";

/**
 * The Fleet of Foot speed bonus in feet: +5' per purchased tier across all owned
 * Fleet of Foot feats (0 if none).
 * @param {Actor} actor
 * @returns {number}
 */
FEATS.fleetOfFootBonus = function(actor) {
  const base = FEATS.FLEET_OF_FOOT_BASE;
  let tiers = 0;
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    tiers += Math.max(1, Math.floor(Number(feat.system?.purchasedTier) || 1));
  }
  return tiers * 5;
};

/**
 * The compendium base name of the Attribute Substitution feat. Hard-coded
 * automation keyed off this name: a primary/dependent attribute pick stored in
 * `flags.openlegend.substitution = { primary, dependent }`.
 * @type {string}
 */
FEATS.ATTR_SUBSTITUTION_BASE = "Attribute Substitution (I - II)";

/**
 * The actor's active attribute substitutions. Each owned Attribute Substitution
 * feat permanently links a stronger PRIMARY attribute to a weaker DEPENDENT one:
 * the dependent's effective score becomes the primary's score (only when the
 * primary leads — substitution never lowers a score). The feat's TIER governs
 * WHICH purposes may substitute (see {@link FEATS.SUBSTITUTION_PURPOSES}):
 * Tier 1 covers secondary stats + non-attack/non-defend/non-invocation rolls;
 * Tier 2 adds attack & defend rolls and bane/boon invocations.
 * @param {Actor} actor
 * @returns {Array<{dependent: string, primary: string, tier: number}>}
 */
FEATS.attributeSubstitutions = function(actor) {
  const base = FEATS.ATTR_SUBSTITUTION_BASE;
  const out = [];
  for ( const feat of (actor?.items ?? []) ) {
    if ( (feat.type !== "feat") || ((feat.system?.baseName || feat.name) !== base) ) continue;
    const sub = feat.flags?.openlegend?.substitution;
    if ( !sub?.primary || !sub?.dependent || (sub.primary === sub.dependent) ) continue;
    const tier = Math.max(1, Math.floor(Number(feat.system?.purchasedTier) || 1));
    out.push({ dependent: sub.dependent, primary: sub.primary, tier });
  }
  return out;
};

/**
 * Whether a substitution that reaches `tier` may apply for a given PURPOSE.
 * Tier 1: "secondary" (HP/defenses/secondary stats) and "general" (non-attack,
 * non-defend, non-invocation action rolls). Tier 2 additionally: "attack",
 * "defend", "invocation".
 * @type {Record<string, number>}  purpose → minimum tier required.
 */
FEATS.SUBSTITUTION_PURPOSES = {
  secondary: 1, general: 1,
  attack: 2, defend: 2, invocation: 2
};

/**
 * The score to USE for an attribute given a purpose: the substituted (primary)
 * score when the actor has a substitution making `attrKey` its dependent AND the
 * feat tier covers `purpose`; otherwise the attribute's OWN score. Reads the
 * actor's already-derived attributes (which carry `ownValue` = the player's own
 * clamped score and `value` = the substituted score for a dependent attribute).
 * @param {Actor} actor
 * @param {string} attrKey
 * @param {string} purpose  One of {@link FEATS.SUBSTITUTION_PURPOSES}.
 * @returns {number}
 */
FEATS.substitutedAttributeScore = function(actor, attrKey, purpose = "general") {
  const attr = actor?.system?.attributes?.[attrKey];
  if ( !attr ) return 0;
  const own = Number(attr.ownValue ?? attr.value ?? 0);
  const subbed = Number(attr.value ?? own);
  // No substitution on this attribute, or it doesn't raise the score: use own.
  if ( !(subbed > own) ) return own;
  const minTier = FEATS.SUBSTITUTION_PURPOSES[purpose] ?? 1;
  const tier = Math.max(0, Math.floor(Number(attr.substitutionTier ?? 0)));
  return (tier >= minTier) ? subbed : own;
};

/**
 * Format a parsed prerequisite tier (see build-feats.mjs parsePrereqTier) into a
 * short human-readable string. Attribute alternatives are joined with "or"; feat
 * and other requirements are appended. Returns "None" when there are no real
 * requirements.
 * @param {{attribute: Array, feats: string[], other: string[], hasNone: boolean}} pre
 * @returns {string}
 */
FEATS.formatPrerequisite = function(pre = {}) {
  const parts = [];
  // Skip incomplete entries — the feat sheet's prerequisite editor keeps
  // in-progress rows (no attribute picked yet, empty text) in the data.
  const attrs = (pre.attribute ?? []).filter(a => a?.label);
  if ( attrs.length ) {
    parts.push(attrs.map(a => `${a.label} ${a.min}`).join(" or "));
  }
  for ( const f of (pre.feats ?? []) ) if ( String(f).trim() ) parts.push(f);
  for ( const o of (pre.other ?? []) ) if ( String(o).trim() ) parts.push(o);
  return parts.length ? parts.join(", ") : "None";
};

/**
 * Evaluate whether an actor meets a feat tier's prerequisites. Attribute
 * alternatives are satisfied if ANY listed attribute meets its minimum ("Any
 * Extraordinary N" is met if any of the extraordinary attributes ≥ N). Feat
 * prerequisites check the actor owns that feat (by name) at a high-enough tier
 * when the requirement names a tier (e.g. "Lethal Strike III"). "Other" textual
 * requirements can't be auto-checked, so they're reported as unverifiable, not
 * failed. Returns { met, unmet: [string], unverifiable: [string] }.
 * @param {Actor} actor
 * @param {object} pre  A parsed prerequisite tier.
 * @returns {{met: boolean, unmet: string[], unverifiable: string[]}}
 */
FEATS.checkPrerequisite = function(actor, pre = {}) {
  const unmet = [];
  const unverifiable = [];
  const extraordinary = STATS.categories?.extraordinary?.attributes ?? [];

  // Attribute alternatives — ANY satisfies. Incomplete editor rows (no
  // attribute picked yet) are not requirements.
  const attrs = (pre.attribute ?? []).filter(a => a?.key || a?.label);
  if ( attrs.length ) {
    const ok = attrs.some(a => {
      const min = Number(a.min) || 0;
      if ( /^any extraordinary$/i.test(a.label) ) {
        return extraordinary.some(k => Number(actor?.system?.attributes?.[k]?.value ?? 0) >= min);
      }
      if ( /^any attribute$/i.test(a.label) ) {
        return Object.values(actor?.system?.attributes ?? {}).some(at => Number(at?.value ?? 0) >= min);
      }
      return Number(actor?.system?.attributes?.[a.key]?.value ?? 0) >= min;
    });
    if ( !ok ) unmet.push(attrs.map(a => `${a.label} ${a.min}`).join(" or "));
  }

  // Feat prerequisites — the actor must own a feat of that name (and tier, if the
  // requirement names one like "Lethal Strike III"). Empty rows are skipped.
  for ( const req of (pre.feats ?? []) ) {
    if ( !String(req).trim() ) continue;
    const m = /^(.*?)(?:\s+([IVX]+))?$/.exec(req.trim());
    const baseName = (m?.[1] ?? req).trim();
    const reqTier = m?.[2] ? FEATS.romanToInt(m[2]) : 1;
    const owned = (actor?.items?.contents ?? []).find(i =>
      (i.type === "feat") && featBaseName(i.name) === baseName.toLowerCase()
    );
    if ( !owned || (Number(owned.system?.purchasedTier ?? 0) < reqTier) ) unmet.push(req);
  }

  // Other textual prerequisites can't be auto-verified.
  for ( const o of (pre.other ?? []) ) if ( String(o).trim() ) unverifiable.push(o);

  return { met: unmet.length === 0, unmet, unverifiable };
};

/** Roman numeral (I..IX) to integer; 0 if unparseable. */
FEATS.romanToInt = function(s = "") {
  const map = { I: 1, V: 5, X: 10 };
  const str = String(s).toUpperCase();
  let total = 0;
  for ( let i = 0; i < str.length; i++ ) {
    const cur = map[str[i]] ?? 0;
    const next = map[str[i + 1]] ?? 0;
    total += cur < next ? -cur : cur;
  }
  return total;
};

/** Base feat name (lowercased, tier-suffix stripped), e.g. "Lethal Strike (I - IX)" -> "lethal strike". */
function featBaseName(name = "") {
  return String(name).replace(/\s*\(.*?\)\s*$/, "").replace(/\s+[IVX]+$/i, "").trim().toLowerCase();
}
FEATS.featBaseName = featBaseName;
