export class OpenLegendCombatant extends Combatant {
  /**
   * @override
   * Use the actor's Open Legend initiative formula (1d20 + Agility dice) for the
   * combat tracker. Falls back to a flat d20 if the actor is unavailable.
   * @returns {string}
   */
  _getInitiativeFormula() {
    return this.actor?.initiativeFormula ?? "1d20";
  }
}
