import STATS from "./stats.mjs"
import EFFECTS from "./effects.mjs"
import DAMAGE from "./damage.mjs"
import RESISTANCE from "./resistance.mjs"
import BANE from "./bane.mjs"
import BOON from "./boon.mjs"
import WEAPON from "./weapon.mjs"
import FEATS from "./feat.mjs"
import CONFIG from "./config.mjs"

export const OPENLEGEND = {...STATS,
     ...EFFECTS,
      ...DAMAGE,
       ...RESISTANCE,
        ...BANE,
         ...BOON,
          ...WEAPON,
           ...FEATS,
            ...CONFIG};
