

export function numberGuard(number){
   return Math.max(0, Math.floor(Number(number) || 0));
}

/**
 * Candidate documents of an Item type for a selection list: visible world items
 * that are not marked Private come first (so a GM's customised copy wins over a
 * same-named compendium entry), then the named system compendium's documents,
 * deduped by name.
 * @param {string} type    Item type, e.g. "bane".
 * @param {string} packId  Compendium id, e.g. "tomucatos-open-legend-rpg-system.banes".
 * @returns {Promise<Item[]>}
 */
export async function selectableDocuments(type, packId) {
  const docs = [];
  const seen = new Set();
  for ( const item of game.items ?? [] ) {
    if ( item.type !== type ) continue;
    if ( !item.visible || item.system?.private ) continue;
    if ( seen.has(item.name) ) continue;
    seen.add(item.name);
    docs.push(item);
  }
  const pack = game.packs?.get(packId);
  if ( pack ) {
    for ( const doc of await pack.getDocuments() ) {
      if ( !seen.has(doc.name) ) docs.push(doc);
    }
  }
  return docs;
}