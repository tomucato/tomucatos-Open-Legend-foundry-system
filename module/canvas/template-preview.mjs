/**
 * Interactive area placement for SRD area attacks — Foundry v14 Regions.
 *
 * MeasuredTemplate was deprecated in v14 (merged into the Region document), so
 * area attacks now place a native Region shape (cone / rectangle / line /
 * circle). Placement uses core's own `canvas.regions.placeRegion(...)`, which
 * shows a live ghost that follows the cursor, snaps to the grid, rotates with
 * the mouse wheel, and commits on left-click (right-click / Esc cancels) — the
 * same UX the old hand-rolled preview provided, but built-in and version-safe.
 *
 * Usage: `await previewAreaTemplate(shape, {x, y})` — resolves to the created
 * RegionDocument, or null if cancelled.
 *
 * Lines are special: an SRD Line area is N separate 5'×10' segments chained
 * corner-to-corner, so `type:"line"` shapes enter a sequential multi-segment
 * placement (previewChainedLines) instead of a single ghost.
 */

import { autoTargetForRegion } from "./template-target.mjs";

/**
 * Set while a cone is ghosting (see previewAreaTemplate): a callback that flips
 * the frontal-cone alternation side and rebuilds the live preview. Null when no
 * cone placement is active. Invoked by the "flip cone side" keybinding.
 * @type {(() => void) | null}
 */
let _activeConeMirrorToggle = null;

/** Whether a cone is currently ghosting (so the keybinding is meaningful). */
export function isConePlacementActive() {
  return !!_activeConeMirrorToggle;
}

/** Flip the ghosting frontal cone's alternation side, if a cone is being placed. */
export function flipActiveConeSide() {
  _activeConeMirrorToggle?.();
}

/**
 * Open Legend's stepped, grid-square cone rows. Row 1 is a single square (the
 * tip, nearest the caster). Each row after is one square wider than the last,
 * and the newly-added square alternates sides. By default the first widening
 * goes RIGHT (row 2 → right, row 3 → left, …); `mirror` starts on the LEFT
 * instead, producing the horizontal mirror image. Every 5' out adds a row.
 * @param {number} distanceFt  Cone length in feet.
 * @param {boolean} [mirror=false]  Start the alternation on the left instead of the right.
 * @returns {{row: number, cols: number[]}[]}  Per-row contiguous column ranges,
 *   with column 0 centered on the apex.
 */
function computeConeRows(distanceFt, mirror = false) {
  const totalRows = Math.max(1, Math.floor(distanceFt / 5));
  let left = 0, right = 0;
  const rows = [{ row: 1, cols: [0] }];
  for ( let r = 2; r <= totalRows; r++ ) {
    // Even rows grow one side, odd rows the other; `mirror` swaps which.
    const growRight = (r % 2 === 0) !== mirror;
    if ( growRight ) right += 1; else left -= 1;
    const cols = [];
    for ( let c = left; c <= right; c++ ) cols.push(c);
    rows.push({ row: r, cols });
  }
  return rows;
}

/** The eight aim directions the cone snaps to. */
const CONE_DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/**
 * The set of grid cells covered by an OL cone of the given length aimed in one of
 * the eight directions, with the apex cell at the local origin (0,0) and y
 * growing DOWN (screen space). Both variants use the same cell count (n = rows =
 * distance/5) and are edge-connected, so the union is always one valid polygon.
 *
 *   - Orthogonal (N/E/S/W): the staircase from computeConeRows, rotated into the
 *     axis direction. Row r is r cells wide, centered with the alternating rule.
 *   - Diagonal (NE/NW/SE/SW): a right-triangle staircase filling the quadrant
 *     corner — the row on the apex's outward axis is n cells, shrinking by one per
 *     step, so the triangle's two legs run along the grid axes (matches the SRD
 *     diagonal cone).
 * @param {number} distanceFt  Cone length in feet.
 * @param {string} dir         One of CONE_DIRS.
 * @param {boolean} [mirror=false]  Mirror a FRONTAL cone's alternation side
 *   (ignored for diagonals, which are symmetric triangles).
 * @returns {{x: number, y: number}[]}  Integer cell coordinates.
 */
function coneCells(distanceFt, dir, mirror = false) {
  // Diagonal: right-triangle staircase into the quadrant (sx, sy). Apex cell at
  // the inner corner (0,0); fill cells (sx·i, sy·j) for i,j ≥ 0 with i + j < n —
  // giving rows of n, n−1, … , 1 along the two axes. Symmetric → mirror has no
  // effect, so it uses the unmirrored row count.
  const quad = { NE: [1, -1], NW: [-1, -1], SE: [1, 1], SW: [-1, 1] }[dir];
  if ( quad ) {
    const [sx, sy] = quad;
    const n = computeConeRows(distanceFt).length;
    const cells = [];
    for ( let i = 0; i < n; i++ ) for ( let j = 0; j < n - i; j++ ) cells.push({ x: sx * i, y: sy * j });
    return cells;
  }

  // Orthogonal: the canonical "up" (N) staircase (mirrorable), then rotate into dir.
  const rows = computeConeRows(distanceFt, mirror);
  const base = [];
  for ( const { row, cols } of rows ) for ( const c of cols ) base.push({ x: c, y: -row });
  const rot = {
    N: p => ({ x: p.x, y: p.y }),
    S: p => ({ x: -p.x, y: -p.y }),
    E: p => ({ x: -p.y, y: p.x }),
    W: p => ({ x: p.y, y: -p.x })
  }[dir] ?? (p => p);
  return base.map(rot);
}

/**
 * Trace the outline of a set of unit grid cells into a single closed polygon
 * (flat [x0,y0,…] point list, in pixels — cell coords × sq). Each cell occupies
 * [x,x+1]×[y,y+1] in cell space. Boundary edges (sides with no neighbor) are
 * emitted with a consistent winding and walked into one ring; collinear vertices
 * are dropped so there are no zero-length edges. Assumes an edge-connected,
 * hole-free cell set (true for every coneCells result).
 * @param {{x: number, y: number}[]} cells
 * @param {number} sq  Grid square size in pixels.
 * @returns {number[]}  Polygon points relative to the apex, in pixels.
 */
function cellsToPolygon(cells, sq) {
  const set = new Set(cells.map(c => c.x + "," + c.y));
  const has = (x, y) => set.has(x + "," + y);
  const edges = new Map();   // "x,y" (start) → {x, y} (end)
  const add = (x1, y1, x2, y2) => edges.set(x1 + "," + y1, { x: x2, y: y2 });
  for ( const { x, y } of cells ) {
    if ( !has(x, y - 1) ) add(x, y, x + 1, y);           // top    L→R
    if ( !has(x + 1, y) ) add(x + 1, y, x + 1, y + 1);   // right  T→B
    if ( !has(x, y + 1) ) add(x + 1, y + 1, x, y + 1);   // bottom R→L
    if ( !has(x - 1, y) ) add(x, y + 1, x, y);           // left   B→T
  }
  // Walk the edge chain into a ring.
  const ring = [];
  let cur = edges.keys().next().value;
  const seen = new Set();
  while ( cur && !seen.has(cur) ) {
    seen.add(cur);
    const [cx, cy] = cur.split(",").map(Number);
    ring.push(cx, cy);
    const nxt = edges.get(cur);
    if ( !nxt ) break;
    cur = nxt.x + "," + nxt.y;
  }
  // Drop collinear vertices, then scale to pixels.
  const m = ring.length / 2;
  const out = [];
  for ( let i = 0; i < m; i++ ) {
    const px = ring[((i - 1 + m) % m) * 2], py = ring[((i - 1 + m) % m) * 2 + 1];
    const cx = ring[i * 2], cy = ring[i * 2 + 1];
    const nx = ring[((i + 1) % m) * 2], ny = ring[((i + 1) % m) * 2 + 1];
    if ( (cx - px) * (ny - cy) - (cy - py) * (nx - cx) !== 0 ) out.push(cx * sq, cy * sq);
  }
  return out;
}

/**
 * Where the apex POINT (the caster / placement origin) sits within the cell
 * footprint, in cell-lattice units. Subtracting this from the traced polygon puts
 * that feature exactly on the placement origin (ax, ay):
 *   - Frontal (N/E/S/W): the mid-point of the tip cell's near edge → the caster
 *     stands on a square EDGE.
 *   - Diagonal: the triangle's inner right-angle grid vertex → the caster stands
 *     on a square CORNER.
 * @param {string} dir  One of CONE_DIRS.
 * @returns {{x: number, y: number}}
 */
function coneApexOffset(dir) {
  switch ( dir ) {
    case "N":  return { x: 0.5, y: 0 };
    case "S":  return { x: 0.5, y: 1 };
    case "E":  return { x: 1,   y: 0.5 };
    case "W":  return { x: 0,   y: 0.5 };
    case "NE": return { x: 0,   y: 1 };
    case "NW": return { x: 1,   y: 1 };
    case "SE": return { x: 0,   y: 0 };
    case "SW": return { x: 1,   y: 0 };
    default:   return { x: 0,   y: 0 };
  }
}

/** True for the four diagonal headings (apex on a grid CORNER, not an edge). */
function isDiagonalDir(dir) {
  return dir === "NE" || dir === "NW" || dir === "SE" || dir === "SW";
}

/**
 * The OL stepped-cone outline polygon in ABSOLUTE canvas pixels: build the cell
 * footprint for the direction, trace it to a polygon, shift it so the apex
 * feature (coneApexOffset) lands on (ax, ay), i.e. the caster point.
 * @param {number} distanceFt  Cone length in feet.
 * @param {number} sq          Grid square size in pixels.
 * @param {string} dir         One of CONE_DIRS.
 * @param {number} ax          Apex x (canvas px).
 * @param {number} ay          Apex y (canvas px).
 * @param {boolean} [mirror=false]  Mirror a frontal cone's alternation side.
 * @returns {number[]}  Polygon points (flat [x0,y0,…]) in canvas pixels.
 */
function steppedConePolygonPoints(distanceFt, sq, dir, ax, ay, mirror = false) {
  const local = cellsToPolygon(coneCells(distanceFt, dir, mirror), sq);
  const off = coneApexOffset(dir);
  const ox = off.x * sq, oy = off.y * sq;
  const points = [];
  for ( let i = 0; i < local.length; i += 2 ) points.push(ax + local[i] - ox, ay + local[i + 1] - oy);
  return points;
}

/**
 * Build the v14 Region document data for an OL area shape descriptor (from
 * CONFIG.areaTemplateData, whose distances are in game units / feet). The shape
 * origin is placed at (x, y); rotation defaults to 0 and is adjusted live by the
 * placement wheel. Grid-based so dimensions follow the scene's grid metric.
 * @param {object} shape  { type, radius?, length?, width?, height?, angle?, curvature? } in feet.
 * @param {{x?: number, y?: number}} [origin]  Starting canvas point.
 * @returns {object|null}  RegionData for placeRegion, or null if unmappable.
 */
export function buildAreaRegionData(shape, origin = {}) {
  if ( !shape?.type ) return null;
  const dims = canvas?.dimensions;
  // distancePixels converts game units (feet) → pixels for a gridBased shape.
  const px = dims?.distancePixels ?? ((canvas?.grid?.size ?? 100) / (canvas?.grid?.distance ?? 5));
  const x = Math.round(Number(origin.x) || (dims ? dims.width / 2 : 0));
  const y = Math.round(Number(origin.y) || (dims ? dims.height / 2 : 0));
  const gridBased = !!(canvas?.grid && !canvas.grid.isGridless);

  let shp;
  // Vertical extent (feet) of the area. null → unbounded. Per SRD: a cube is as
  // tall as it is wide; a line is 10' tall. Others are left unbounded.
  let elevationTopFt = null;
  switch ( shape.type ) {
    case "steppedCone": {
      // Grid-square stepped cone (OL): a polygon whose apex is the drop point.
      // The apex stays fixed; aiming (cursor direction → one of 8 headings)
      // rebuilds the footprint during placement (see previewAreaTemplate.onMove).
      // `origin` is the apex so the shape stays pinned to the caster.
      const sq = canvas?.grid?.size ?? px;
      const points = steppedConePolygonPoints(shape.radius ?? 0, sq, "N", x, y);
      shp = { type: "polygon", points, origin: { x, y } };
      break;
    }
    case "cone":
      shp = { type: "cone", x, y, radius: (shape.radius ?? 0) * px,
        angle: shape.angle ?? 53.13, rotation: 0, curvature: shape.curvature ?? "round", gridBased };
      break;
    case "rectangle":
      shp = { type: "rectangle", x, y, width: (shape.width ?? 0) * px, height: (shape.height ?? 0) * px,
        anchorX: 0.5, anchorY: 0.5, rotation: 0, gridBased };
      // A cube's height equals its side (a 20' cube is 20' tall).
      elevationTopFt = Math.max(0, Number(shape.width ?? 0)) || null;
      break;
    case "line":
      // Only reached via direct API calls: the interactive flow places lines as
      // a chain of rectangles instead (previewChainedLines).
      shp = { type: "line", x, y, length: (shape.length ?? 0) * px, width: (shape.width ?? 5) * px,
        rotation: 0, gridBased };
      // Lines are 10' tall (5' wide × 10' high).
      elevationTopFt = 10;
      break;
    case "circle":
      shp = { type: "circle", x, y, radius: (shape.radius ?? 0) * px, gridBased };
      break;
    default:
      return null;
  }

  const labels = { steppedCone: "Cone", rectangle: "Cube", line: "Line", circle: "Circle" };
  const label = labels[shape.type] ?? (shape.type.charAt(0).toUpperCase() + shape.type.slice(1));
  const regionData = { ...areaRegionChrome(`${label} Area`), shapes: [shp] };
  // Bound the vertical extent (feet) for shapes with a defined height; leave
  // others unbounded (bottom −∞, top +∞).
  if ( elevationTopFt ) regionData.elevation = { bottom: 0, top: elevationTopFt };
  return regionData;
}

/**
 * The non-shape scaffolding every OL area Region shares: a non-restricting,
 * always-visible coverage highlight owned by the placing user — purely a
 * targeting aid, not a movement/vision barrier.
 * @param {string} name  The Region's display name.
 * @returns {object}  Partial RegionData (everything but `shapes`/`elevation`).
 */
function areaRegionChrome(name) {
  return {
    name,
    color: game.user?.color?.css ?? game.user?.color ?? "#ff0000",
    restriction: { enabled: false, type: "move", priority: 0 },
    visibility: CONST.REGION_VISIBILITY.ALWAYS,
    highlightMode: "coverage",
    displayMeasurements: true,
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE,
      [game.user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER }
  };
}

/**
 * Snap a rectangle's CENTER so its footprint aligns to whole grid cells: snap the
 * top-left corner to a grid vertex, then center = corner + half-size. Works for
 * any width/height parity. Gridless scenes just round to the pixel.
 * @param {{x: number, y: number}} pt  The desired center.
 * @param {number} wPx  Rectangle width in pixels.
 * @param {number} hPx  Rectangle height in pixels.
 * @returns {{x: number, y: number}}  The snapped center.
 */
function snapRectCenter(pt, wPx, hPx) {
  const grid = canvas?.grid;
  if ( !grid || grid.isGridless ) return { x: Math.round(pt.x), y: Math.round(pt.y) };
  const corner = grid.getSnappedPoint(
    { x: pt.x - wPx / 2, y: pt.y - hPx / 2 },
    { mode: CONST.GRID_SNAPPING_MODES.VERTEX, resolution: 1 }
  );
  return { x: corner.x + wPx / 2, y: corner.y + hPx / 2 };
}

/* -------------------------------------------- */
/*  Chained line placement (SRD Line area)      */
/* -------------------------------------------- */

/**
 * Interactive placement for an SRD Line area: N SEPARATE 5'×10' segments (two
 * grid squares), placed one at a time. The first goes anywhere; every further
 * segment must TOUCH the already-placed chain at a grid corner (diagonal
 * corner-to-corner contact counts; sharing an edge does too) and may not overlap
 * a placed segment. The mouse wheel rotates the ghost in 45° steps through four
 * orientations — vertical, "\" diagonal, horizontal, "/" diagonal; a diagonal
 * segment covers two diagonally-adjacent squares meeting at a corner. The ghost
 * tints red while its spot is illegal, and an illegal click is rejected with a
 * warning and the segment re-enters placement.
 *
 * The ghost is a polygon shape rebuilt on every move/rotate (the same technique
 * the stepped cone uses) since a diagonal footprint is not a rectangle. Already-
 * committed segments are drawn on a local PIXI overlay while the rest are
 * ghosting (per-segment documents are ephemeral). On completion all segments are
 * merged into ONE Region (one rectangle shape per covered cell — clean geometry
 * for coverage rendering and targeting even at the diagonal pinch points) which
 * is auto-targeted and persisted exactly like every other OL area. Cancelling
 * mid-chain keeps what was placed (an attack may legally use fewer lines);
 * cancelling the FIRST segment aborts entirely.
 * @param {object} shape  Line descriptor from CONFIG.areaTemplateData:
 *   { type:"line", length: 10, width: 5, lines: N } in feet. Legacy payloads
 *   ({ length: N×10 } without `lines`) are converted (one segment per 10').
 * @param {{x?: number, y?: number}} [start]  Starting canvas point (drop point).
 * @returns {Promise<RegionDocument|null>}  An ephemeral document combining the
 *   placed segments, or null if nothing was placed.
 */
async function previewChainedLines(shape, start = {}) {
  const dims = canvas?.dimensions;
  const grid = canvas?.grid;
  const sq = grid?.size ?? 100;
  const gridBased = !!(grid && !grid.isGridless);
  const ftPerCell = grid?.distance || 5;

  // Legacy chat cards carried one long line ({length: N×10} with no `lines`);
  // split it back into 10' segments.
  const total = Math.max(1, Math.floor(Number(shape.lines ?? (Number(shape.length ?? 10) / 10)) || 1));
  const lengthFt = (shape.lines != null) ? Number(shape.length ?? 10) : 10;
  const wCells = Math.max(1, Math.round(Number(shape.width ?? 5) / ftPerCell));
  const lCells = Math.max(1, Math.round(lengthFt / ftPerCell));

  /* ---- Orientations ---- */

  // The outline ring of a w×h cell rectangle, as flat [x0,y0,…] in CELL units.
  const rectRing = (w, h) => [0, 0, w, 0, w, h, 0, h];
  // The outline ring of a "\" diagonal run of n cells (cells (k,k), k = 0…n−1):
  // staircase down the top-right side, back up the bottom-left. The ring passes
  // through each pinch vertex twice — a weakly-simple polygon, which Foundry's
  // clipper-based Region geometry accepts.
  const diagRing = n => {
    const pts = [];
    for ( let k = 0; k < n; k++ ) pts.push(k, k, k + 1, k);
    pts.push(n, n);
    for ( let k = n - 1; k > 0; k-- ) pts.push(k, k + 1, k, k);
    pts.push(0, 1);
    return pts;
  };
  // "/" = "\" mirrored about y = ½ (maps cell (k,k) → (k,−k)).
  const mirrorRing = pts => pts.map((v, i) => (i % 2) ? 1 - v : v);
  const gridCells = (w, h) => {
    const cells = [];
    for ( let i = 0; i < w; i++ ) for ( let j = 0; j < h; j++ ) cells.push([i, j]);
    return cells;
  };
  const diagCells = (n, up) => Array.from({ length: n }, (_, k) => [k, up ? -k : k]);

  // Each orientation: covered cells + outline ring, both in cell units relative
  // to the ANCHOR (the top-left vertex of the first cell), plus the footprint's
  // bounding-box center (for cursor-following). Wheel order = 45° steps:
  // vertical, "\", horizontal, "/". Diagonals only exist for 1-cell-wide lines
  // (the SRD 5' width) longer than one cell — coarse grids skip them.
  const bboxCenter = ring => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for ( let i = 0; i < ring.length; i += 2 ) {
      minX = Math.min(minX, ring[i]);     maxX = Math.max(maxX, ring[i]);
      minY = Math.min(minY, ring[i + 1]); maxY = Math.max(maxY, ring[i + 1]);
    }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  };
  const orients = [];
  const addOrient = (cells, ring) => orients.push({ cells, ring, c: bboxCenter(ring) });
  const allowDiag = (wCells === 1) && (lCells > 1);
  addOrient(gridCells(wCells, lCells), rectRing(wCells, lCells));            // vertical |
  if ( allowDiag ) addOrient(diagCells(lCells, false), diagRing(lCells));    // diagonal \
  addOrient(gridCells(lCells, wCells), rectRing(lCells, wCells));            // horizontal —
  if ( allowDiag ) addOrient(diagCells(lCells, true), mirrorRing(diagRing(lCells)));  // diagonal /

  /* ---- Chain bookkeeping ---- */

  // Occupied cells and their lattice vertices, over all committed segments.
  // Touching = a candidate cell vertex coincides with any placed-cell vertex
  // (corner-to-corner or edge contact); overlap = sharing a cell.
  const placedCells = new Set();
  const placedVerts = new Set();
  const placedShapes = [];
  let placedCount = 0;
  const cellVerts = ([cx, cy]) => [[cx, cy], [cx + 1, cy], [cx, cy + 1], [cx + 1, cy + 1]];
  // Absolute integer cell coords of an orientation's footprint at an anchor (px).
  const cellsAt = (anchor, o) => {
    const gx = Math.round(anchor.x / sq), gy = Math.round(anchor.y / sq);
    return o.cells.map(([cx, cy]) => [gx + cx, gy + cy]);
  };
  const isValid = (anchor, o, index) => {
    if ( !gridBased ) return true;   // gridless → no corner rule to enforce
    // Every segment must sit exactly on the cell lattice — a free/shift-placed
    // segment would make the corner bookkeeping (rounded cells) meaningless.
    if ( Math.abs(anchor.x / sq - Math.round(anchor.x / sq)) > 0.01
      || Math.abs(anchor.y / sq - Math.round(anchor.y / sq)) > 0.01 ) return false;
    const cells = cellsAt(anchor, o);
    for ( const [cx, cy] of cells ) if ( placedCells.has(`${cx},${cy}`) ) return false;   // no overlap
    if ( index === 0 ) return true;
    for ( const c of cells ) for ( const [vx, vy] of cellVerts(c) ) {
      if ( placedVerts.has(`${vx},${vy}`) ) return true;   // touches the chain
    }
    return false;
  };

  // Local overlay showing the committed segments while the rest are ghosting.
  const colorNum = (() => { try { return Number(game.user?.color) || 0xff3333; } catch { return 0xff3333; } })();
  const overlay = new PIXI.Graphics();
  overlay.eventMode = "none";
  (canvas.interface ?? canvas.stage).addChild(overlay);
  const drawOverlay = () => {
    overlay.clear();
    for ( const s of placedShapes ) {
      overlay.lineStyle(3, colorNum, 0.9);
      overlay.beginFill(colorNum, 0.25);
      overlay.drawRect(s.x - s.width / 2, s.y - s.height / 2, s.width, s.height);
      overlay.endFill();
    }
  };

  // Tint the live ghost red while its position is illegal (advisory — the hard
  // gate is the post-commit validation below). Same preview-poke pattern as the
  // cone mirror toggle.
  const baseColor = game.user?.color?.css ?? "#ff0000";
  let ghostValid = true;
  const setGhostValidity = valid => {
    if ( valid === ghostValid ) return;
    ghostValid = valid;
    try {
      const preview = canvas.regions?._placementContext?.preview;
      if ( !preview ) return;
      preview.document.updateSource({ color: valid ? baseColor : "#e03030" });
      preview.renderFlags?.set({ refreshShapes: true, refreshState: true });
    } catch { /* cosmetic only */ }
  };

  // The polygon ring of an orientation at an anchor, in absolute canvas pixels.
  const ringAt = (anchor, o) => {
    const pts = [];
    for ( let i = 0; i < o.ring.length; i += 2 ) pts.push(anchor.x + o.ring[i] * sq, anchor.y + o.ring[i + 1] * sq);
    return pts;
  };
  // Snap the anchor (a cell's top-left vertex) so the footprint's center lands
  // nearest the cursor point.
  const snapAnchor = (pt, o) => {
    const desired = { x: pt.x - o.c.x * sq, y: pt.y - o.c.y * sq };
    if ( !gridBased ) return { x: Math.round(desired.x), y: Math.round(desired.y) };
    return grid.getSnappedPoint(desired, { mode: CONST.GRID_SNAPPING_MODES.VERTEX, resolution: 1 });
  };

  // The ghost's orientation persists across segments (wheel = one 45° step).
  let orient = 0;
  let cursor = {
    x: Math.round(Number(start.x) || (dims ? dims.width / 2 : 0)),
    y: Math.round(Number(start.y) || (dims ? dims.height / 2 : 0))
  };
  let cancelled = false;

  try {
    for ( let i = 0; i < total; i++ ) {
      let committed = null;
      while ( !committed && !cancelled ) {
        let o = orients[orient];
        let anchor = snapAnchor(cursor, o);
        ghostValid = true;
        const data = {
          ...areaRegionChrome(total > 1 ? `Line ${i + 1} of ${total}` : "Line Area"),
          shapes: [{ type: "polygon", points: ringAt(anchor, o), origin: { ...anchor } }],
          elevation: { bottom: 0, top: 10 }   // lines are 10' tall
        };
        const rebuild = shp => {
          shp.updateSource({ points: ringAt(anchor, o), origin: { ...anchor } });
          setGhostValidity(isValid(anchor, o, i));
        };
        const onMove = ({ shape: shp, position, snap }) => {
          anchor = (snap || !gridBased)
            ? snapAnchor(position, o)
            : { x: position.x - o.c.x * sq, y: position.y - o.c.y * sq };   // shift → free
          rebuild(shp);
          return false;
        };
        const onRotate = ({ shape: shp, event }) => {
          // One wheel notch = one orientation step (45° with diagonals enabled).
          const step = Math.sign(event.delta ?? event.deltaY ?? 1) || 1;
          const center = { x: anchor.x + o.c.x * sq, y: anchor.y + o.c.y * sq };
          orient = ((orient + step) % orients.length + orients.length) % orients.length;
          o = orients[orient];
          anchor = snapAnchor(center, o);   // keep the footprint centered in place
          rebuild(shp);
          return false;
        };
        let doc = null;
        try {
          doc = await canvas.regions.placeRegion(data, { create: false, allowRotation: true, onMove, onRotate });
        } catch ( err ) {
          console.error("OL|line placement failed", err);
          cancelled = true;
          break;
        }
        if ( !doc ) { cancelled = true; break; }   // user cancelled (Esc / right-click)
        if ( !isValid(anchor, o, i) ) {
          ui.notifications?.warn(i === 0
            ? "Lines must align to the grid. Place it again."
            : "Each additional line must align to the grid and touch a corner of an already-placed line (no overlap). Place it again.");
          cursor = { x: anchor.x + o.c.x * sq, y: anchor.y + o.c.y * sq };   // resume the retry ghost where they clicked
          continue;
        }
        committed = { anchor, o };
      }
      if ( cancelled ) break;

      for ( const c of cellsAt(committed.anchor, committed.o) ) {
        placedCells.add(`${c[0]},${c[1]}`);
        for ( const [vx, vy] of cellVerts(c) ) placedVerts.add(`${vx},${vy}`);
      }
      // Commit one rectangle per covered cell — clean geometry for coverage
      // rendering and targeting even at a diagonal's pinch point. Positions come
      // from the anchor (already lattice-snapped on grids), so this also works
      // free-floating on gridless scenes.
      for ( const [cx, cy] of committed.o.cells ) {
        placedShapes.push({
          type: "rectangle",
          x: committed.anchor.x + (cx + 0.5) * sq, y: committed.anchor.y + (cy + 0.5) * sq,
          width: sq, height: sq, anchorX: 0.5, anchorY: 0.5, rotation: 0, gridBased
        });
      }
      placedCount++;
      drawOverlay();
      // Chain the next ghost from this one's center.
      cursor = { x: committed.anchor.x + committed.o.c.x * sq, y: committed.anchor.y + committed.o.c.y * sq };
    }
  } finally {
    overlay.destroy();
  }

  if ( !placedCount ) return null;   // first segment cancelled → abort
  if ( placedCount < total ) {
    ui.notifications?.info(`Placed ${placedCount} of ${total} lines.`);
  }

  // One combined Region carrying every segment, targeted + persisted like any
  // other area. An ephemeral document is enough for targeting (its polygonTree
  // derives from shape data, no canvas object needed).
  const combined = {
    ...areaRegionChrome(placedCount > 1 ? `Line Area (${placedCount} lines)` : "Line Area"),
    shapes: placedShapes,
    elevation: { bottom: 0, top: 10 }
  };
  let region = null;
  try {
    region = new CONFIG.Region.documentClass(combined, { parent: canvas.scene });
  } catch ( err ) {
    console.error("OL|failed to build combined line region", err);
  }
  if ( region ) autoTargetForRegion(region, game.user);
  persistAreaRegion(combined);
  return region;
}

/**
 * Show an interactive placement for an area attack and resolve once the user
 * commits or cancels. Wraps core `canvas.regions.placeRegion`, which handles the
 * ghost, grid snapping, wheel-rotate, and click-to-commit.
 *
 * The placement is always EPHEMERAL (create:false) so any user — GM or player —
 * can place and target, regardless of the GM-only REGION_CREATE permission. On
 * commit we (1) auto-target the tokens the area covers, using the ephemeral
 * document's polygon tree (derived from shape data, no canvas object needed),
 * then (2) persist the Region so it shows on everyone's map: directly if this
 * user is a GM, otherwise via a query to the active GM (see registerAreaRegionQuery).
 * @param {object} shape  Shape descriptor from CONFIG.areaTemplateData (game units).
 * @param {{x?: number, y?: number}} [start]  Optional starting canvas point (the drop point).
 * @returns {Promise<RegionDocument|null>}  The ephemeral placed document, or null if cancelled.
 */
export async function previewAreaTemplate(shape, start = {}) {
  if ( !canvas?.scene ) {
    ui.notifications?.warn("Place a scene on the canvas before placing an area.");
    return null;
  }
  // SRD lines are several separate 5'×10' segments chained corner-to-corner —
  // a dedicated sequential placement flow, not a single ghost.
  if ( shape?.type === "line" ) return previewChainedLines(shape, start);
  const data = buildAreaRegionData(shape, start);
  if ( !data ) {
    ui.notifications?.warn("This action has no placeable area shape.");
    return null;
  }

  // Stepped cones: the apex follows the cursor (snapped to the grid) and the
  // mouse wheel cycles the eight headings, rebuilding the footprint. Both handlers
  // rewrite the polygon points for the current apex + direction and suppress the
  // default move/rotate. Other shapes use core's default behavior.
  const isCone = shape.type === "steppedCone";
  const sq = canvas?.grid?.size ?? (canvas?.dimensions?.distancePixels ?? 100);
  const cone = { apex: { x: data.shapes[0]?.origin?.x ?? 0, y: data.shapes[0]?.origin?.y ?? 0 }, dirIndex: 0, mirror: false };
  const rebuildCone = (shp) => {
    const dir = CONE_DIRS[((cone.dirIndex % 8) + 8) % 8];
    const points = steppedConePolygonPoints(shape.radius ?? 0, sq, dir, cone.apex.x, cone.apex.y, cone.mirror);
    shp.updateSource({ points, origin: { x: cone.apex.x, y: cone.apex.y } });
  };
  const snapApex = (pt, dir) => {
    const grid = canvas?.grid;
    if ( !grid || grid.isGridless ) return { x: Math.round(pt.x), y: Math.round(pt.y) };
    const M = CONST.GRID_SNAPPING_MODES;
    let mode;
    if ( isDiagonalDir(dir) ) {
      // Diagonal: apex is a grid corner.
      mode = M.VERTEX;
    } else if ( dir === "N" || dir === "S" ) {
      // Vertical aim: the base edge is HORIZONTAL, so the apex snaps only to a
      // top/bottom side midpoint (never a left/right one, which would let the
      // cone straddle two columns and widen).
      mode = M.TOP_SIDE_MIDPOINT | M.BOTTOM_SIDE_MIDPOINT;
    } else {
      // Horizontal aim (E/W): base edge is VERTICAL → left/right side midpoints.
      mode = M.LEFT_SIDE_MIDPOINT | M.RIGHT_SIDE_MIDPOINT;
    }
    return grid.getSnappedPoint(pt, { mode, resolution: 1 });
  };
  const onMove = isCone ? ({ shape: shp, position, snap }) => {
    const dir = CONE_DIRS[((cone.dirIndex % 8) + 8) % 8];
    cone.apex = snap ? snapApex(position, dir) : { x: position.x, y: position.y };
    rebuildCone(shp);
    return false;   // apex is placed by us, not by the default shape.move
  } : undefined;
  const onRotate = isCone ? ({ shape: shp, event }) => {
    // One wheel notch = one 45° heading step. Core's wheel event exposes `delta`;
    // fall back to deltaY defensively.
    cone.dirIndex += Math.sign(event.delta ?? event.deltaY ?? 1) || 1;
    rebuildCone(shp);
    return false;   // replace the default continuous rotation
  } : undefined;

  // Rectangle (cube): the origin is the CENTER, but the footprint must align to
  // whole grid cells, so we snap a CORNER of the rectangle to a grid vertex and
  // derive the center from it (snapRectCenter). Cones handle their own move
  // above; lines never reach here (previewChainedLines).
  const isRect = shape.type === "rectangle";
  const onMoveOther = isRect ? ({ shape: shp, position, snap }) => {
    if ( !snap ) return;   // shift held → free placement, let default handle it
    const target = snapRectCenter(position, shp.width, shp.height);
    shp.move(target, { snap: false });   // we already snapped; move to the exact point
    return false;
  } : undefined;

  // While a cone is ghosting, expose a toggle the keybinding can call to flip the
  // frontal-cone alternation side and rebuild the live preview. Diagonals ignore
  // it (symmetric). Cleared when placement resolves.
  if ( isCone ) {
    _activeConeMirrorToggle = () => {
      const dir = CONE_DIRS[((cone.dirIndex % 8) + 8) % 8];
      if ( isDiagonalDir(dir) ) return;   // no visible effect on diagonals
      cone.mirror = !cone.mirror;
      const shp = canvas.regions?._placementContext?.shape;
      if ( !shp ) return;
      rebuildCone(shp);
      // Nudge the preview to redraw with the new points.
      const preview = canvas.regions._placementContext.preview;
      preview?.document?.updateSource({ shapes: [shp] });
      preview?.renderFlags?.set({ refreshShapes: true });
    };
  }

  let region = null;
  try {
    // create:false → the returned RegionDocument is ephemeral (not persisted).
    // Its polygonTree is still available (computed from shape data), so targeting
    // works without any create permission or drawn canvas object.
    region = await canvas.regions.placeRegion(data, {
      create: false, allowRotation: true, onMove: onMove ?? onMoveOther, onRotate
    });
  } catch ( err ) {
    console.error("OL|area placement failed", err);
    return null;
  } finally {
    _activeConeMirrorToggle = null;   // placement ended (committed or cancelled)
  }
  if ( !region ) return null;   // cancelled / skipped

  // Auto-target off the ephemeral document's geometry.
  autoTargetForRegion(region, game.user);

  // Persist the Region on the map (GM-side if we're not a GM).
  persistAreaRegion(region.toObject());
  return region;
}

/** The query name used to ask the active GM to create an area Region. */
const CREATE_QUERY = "openlegend.createAreaRegion";

/**
 * Persist an area Region on the current scene so it renders on every client. If
 * this user can create Regions (a GM), do it directly. Otherwise forward the
 * data to the active GM via a User query, which runs registerAreaRegionQuery's
 * handler on their client. Best-effort: a failure is logged, not thrown (the
 * placer already has their local targets).
 * @param {object} regionData  A RegionData object (from region.toObject()).
 * @returns {Promise<void>}
 */
async function persistAreaRegion(regionData) {
  const sceneId = canvas?.scene?.id;
  if ( !sceneId ) return;
  try {
    if ( CONFIG.Region.documentClass.canUserCreate(game.user) ) {
      await canvas.scene.createEmbeddedDocuments("Region", [regionData]);
      return;
    }
    const gm = game.users?.activeGM;
    if ( !gm ) {
      ui.notifications?.warn("No active GM to place the area on the map; your targets are still set.");
      return;
    }
    await gm.query(CREATE_QUERY, { sceneId, regionData });
  } catch ( err ) {
    console.error("OL|failed to persist area region", err);
  }
}

/**
 * Register the GM-side handler that creates an area Region on request from a
 * non-GM placer. Call once during setup. The handler runs on the GM's client,
 * where it has create permission, and returns the new Region's id.
 */
export function registerAreaRegionQuery() {
  CONFIG.queries ??= {};
  CONFIG.queries[CREATE_QUERY] = async ({ sceneId, regionData }) => {
    const scene = game.scenes?.get(sceneId);
    if ( !scene ) return null;
    const [created] = await scene.createEmbeddedDocuments("Region", [regionData]);
    return created?.id ?? null;
  };
}

/* -------------------------------------------- */

/** Remembered last cone length (ft), so the prompt pre-fills a sensible value. */
let _lastConeFt = 30;

/**
 * Prompt for a cone length, then enter the interactive OL stepped-cone placement.
 * Wired to the "OL Cone" Regions toolbar button (see registerOLConeControl).
 * @returns {Promise<void>}
 */
async function placeOLConeFromControl() {
  if ( !canvas?.ready ) return;
  const { DialogV2 } = foundry.applications.api;
  const result = await DialogV2.input({
    window: { title: "Place OL Cone", icon: "fa-solid icon-fa-cone" },
    content: `<p>Cone length (feet), in 5' steps:</p>
      <input type="number" name="ft" min="5" step="5" value="${_lastConeFt}" autofocus>`,
    ok: { label: "Place", icon: "fa-solid fa-location-crosshairs" },
    rejectClose: false
  });
  if ( !result ) return;   // dismissed
  const ft = Math.max(5, Math.round((Number(result.ft) || 0) / 5) * 5);
  _lastConeFt = ft;
  await previewAreaTemplate({ type: "steppedCone", radius: ft });
}

/**
 * Add an "OL Cone" button to the Regions scene-control group. It's a one-shot
 * button (not a drag-to-draw shape tool): clicking it prompts for a length and
 * places the Open Legend grid-square stepped cone via the shared preview flow.
 * Register on the `getSceneControlButtons` hook.
 * @param {Record<string, object>} controls  The scene-control groups, keyed by name.
 */
export function registerOLConeControl(controls) {
  const regions = controls?.regions;
  if ( !regions?.tools ) return;   // group hidden (user lacks REGION_CREATE) — nothing to add
  regions.tools.olCone = {
    name: "olCone",
    // After the native shape tools, before the palette/clear utilities.
    order: 9.5,
    title: "Open Legend Cone",
    icon: "fa-solid icon-fa-cone",
    button: true,   // fires onChange on click; does not become the active tool
    visible: !canvas.regions?.templateMode,
    onChange: () => { placeOLConeFromControl(); }
  };
}

/* -------------------------------------------- */

/**
 * Register the user-rebindable keybinding that flips a ghosting FRONTAL cone's
 * alternation side (first widening square right ↔ left). MUST be called during
 * the `init` hook (Foundry forbids registering keybindings later). The binding
 * appears in Configure Controls, so the user sets their own key. It only acts
 * while a cone is being placed; otherwise the keypress is ignored (not consumed).
 * @param {string} systemId  The system id (keybinding namespace).
 */
export function registerConeKeybinding(systemId) {
  game.keybindings.register(systemId, "flipConeSide", {
    name: "Flip Cone Side",
    hint: "While placing an Open Legend cone, flip which side the widening squares add to first (frontal cones only).",
    editable: [{ key: "KeyF" }],   // default; user-rebindable in Configure Controls
    onDown: () => {
      if ( !isConePlacementActive() ) return false;   // not placing → let others handle the key
      flipActiveConeSide();
      return true;                                     // consume the event
    },
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
  });
}
