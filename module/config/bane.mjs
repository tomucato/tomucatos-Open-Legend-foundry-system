/**
 * Open Legend bane configuration: the standard bane-name catalog and generic
 * bane-document resolution. Merged into the public {@link OPENLEGEND} object in
 * ./index.mjs (see stats.mjs for the same pattern). Feat logic that happens to
 * involve banes (Bane Focus, Potent Bane, Multi-Bane Specialist, …) lives in
 * feat.mjs, not here; the boon equivalents stay in config.mjs.
 */

const BANE = {};
export default BANE;

/**
 * The standard bane names (Open Legend SRD), for the extraordinary-item bane
 * picker. @type {string[]}
 */
BANE.baneNames = [
  "Blinded", "Charmed", "Deafened", "Death", "Demoralized", "Disarmed",
  "Dominated", "Fatigued", "Fear", "Forced Move", "Immobile", "Incapacitated",
  "Knockdown", "Memory Alteration", "Mind Dredge", "Nullify", "Persistent Damage",
  "Phantasm", "Polymorph", "Provoked", "Spying", "Sickened", "Silenced",
  "Slowed", "Stunned", "Stupefied", "Truthfulness"
];

/**
 * Resolve a bane document by name, preferring the picker's source it draws its
 * lists from — the system banes compendium ("tomucatos-open-legend-rpg-system.banes") — so a
 * generated bane action's uuid matches a picker option. Falls back to a world
 * bane item, then any other Item compendium. Returns the first match or null.
 * @param {string} name
 * @returns {Promise<Item|null>}
 */
BANE.resolveBaneByName = async function(name) {
  if ( !name ) return null;
  const lower = String(name).toLowerCase();
  // The picker's pack first, matched case-insensitively.
  const banesPack = game.packs?.get("tomucatos-open-legend-rpg-system.banes");
  if ( banesPack ) {
    const entry = (await banesPack.getIndex()).find(e => String(e.name).toLowerCase() === lower);
    if ( entry ) return banesPack.getDocument(entry._id);
  }
  // A world copy, then any other Item compendium.
  const local = game.items?.find(i => (i.type === "bane") && (String(i.name).toLowerCase() === lower));
  if ( local ) return local;
  for ( const pack of game.packs ?? [] ) {
    if ( (pack.documentName !== "Item") || (pack.collection === "tomucatos-open-legend-rpg-system.banes") ) continue;
    const entry = (await pack.getIndex()).find(e => (String(e.name).toLowerCase() === lower) && (e.type === "bane"));
    if ( entry ) return pack.getDocument(entry._id);
  }
  return null;
};
