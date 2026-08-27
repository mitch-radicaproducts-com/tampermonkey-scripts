// ==UserScript==
// @name         Mission Control Chart - Layer 1
// @namespace    radicaproducts.com
// @version      1.0.0
// @description  Layer 1 of 2. Lays an addressable grid of fixed-width cells over the Vega bar chart Airtable renders, names every cell A01..Z99, writes the Done count over the last Done cell of each row, and exposes window.__TM_GRID__ so a layer 2 script can recolour, pattern and label any cell by name. Changes nothing else about the chart.
// @author       Mitch
// @match        https://airtable.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/* ====================================================================== *
 * MAINTENANCE NOTES
 *
 * Read this before changing anything. Everything below was learned the hard
 * way from the markup Airtable actually ships; if Airtable changes their
 * chart renderer, this section is what tells you where to look.
 *
 * ---------------------------------------------------------------------- *
 * WHAT THIS SCRIPT DOES
 *
 * Airtable draws its charts with Vega. A bar of "4 Done" is one <path>. This
 * script leaves that path alone and overlays a grid of one-unit-wide cells on
 * top of it, so a bar of 4 becomes four addressable cells, and the rest of the
 * row out to the plot edge becomes invisible cells of the same width. Each
 * cell has a rect (transparent by default) and a centred <text> anchor. It
 * writes exactly one thing of its own: the Done count over the last Done cell.
 * Everything else is a hook for layer 2.
 *
 * ---------------------------------------------------------------------- *
 * THE DOM IT READS  (verified against Airtable, Aug 2026)
 *
 * chart element   div[role="figure"][aria-label="Production Numbers"]
 * svg             svg.marks inside it
 * plot group      g.mark-group.role-frame.root > g          ("a.root")
 * plot size       root > path.background, d="M0.5,0.5h639v377h-639Z"
 *                 -> h = plot width, v = plot height
 * axes            g.mark-group.role-axis, aria-label starting "X-axis for a
 *                 linear scale with values from 0 to 8" / "Y-axis for a
 *                 discrete scale with 16 values: GOAL, Welding, ..."
 *                 Their labels live in g.mark-text.role-axis-label > text,
 *                 positioned by transform="translate(x,y)".
 *                 X labels are the numbers 0..8 at exact fractional x
 *                 (1 sits at 79.875 in a 639px plot). Y labels sit at
 *                 negative x, one per row, y = row centre + 3.5.
 * rows            root > g > g.mark-group.role-scope > g[transform]
 * bars            path[aria-roledescription="bar"], d="M{x},0h{w}v{h}h-{w}Z"
 * bar metadata    aria-label, semicolon separated key: value pairs, e.g.
 *                 "chartPageElementAxisX: Welding; Status: Done;
 *                  Workstation (Color+Sort): Welding; Number of...: 4 records"
 *                 Status is the series name: Done / In-Progress / Hidden.
 * end labels      root > g > g.mark-text.role-mark (Vega's own per-bar text,
 *                 a sibling of the row scope group, not inside the rows)
 *
 * Known fills: Done rgb(154, 224, 149), In-Progress rgb(255, 214, 107),
 * Hidden rgb(229, 233, 240), GOAL rgb(65, 69, 77). Note that Hidden and the
 * Electrical workstation colour are byte-identical, so never identify the
 * padding series by colour — only by "Status: Hidden" in the aria-label.
 *
 * ---------------------------------------------------------------------- *
 * VEGA BEHAVIOURS THAT WILL BITE YOU
 *
 * 1. Vega reuses SVG nodes and appends new ones at the end of the group, so
 *    document order does NOT match visual order. Only the transforms are
 *    trustworthy. Never assume the nth row group is the nth row on screen.
 * 2. Transforms nest. A bar's y offset is the SUM of every translate() from
 *    the bar up to the plot group; several of the intermediate ones are
 *    translate(0,0), so taking the first match you find gives 0 and puts your
 *    overlay in the wrong place (or clips it away entirely).
 * 3. Long y-axis labels are truncated with an ellipsis ("Insulation - Board
 *    Fo…"), which then matches no category in any aria-label. Resolve by
 *    prefix against the categories the bars declare.
 * 4. Each row is clipped by a clipPath whose path rounds the right-hand end
 *    of the bar. Anything you draw outside the row group is NOT clipped, so a
 *    filled last cell squares that end off unless you borrow the same shape.
 *    The plot-wide clip also exists; tell them apart by the row clip's path
 *    starting "M0,0".
 * 5. A category with no records has a y-axis label but no row group at all.
 *    Build rows from the axis, not from the row groups.
 * 6. Airtable mutates the DOM constantly. An observer that writes on every
 *    mutation will loop forever. See IDEMPOTENCE.
 *
 * ---------------------------------------------------------------------- *
 * HOW GEOMETRY IS DERIVED
 *
 * Cell width  = px per x-axis unit, taken from two x-axis tick labels:
 *               (x_last - x_first) / (v_last - v_first). Read off the labels,
 *               not off a bar: the labels are exact and exist even when every
 *               row is empty. Fallback is bar width / record count from any
 *               bar's aria-label.
 * Column count= round((plotW - x_of_zero) / unit).
 * Row centre  = y-axis label y - 3.5.
 * Row top and height come from a real bar in that row when there is one
 *               (v{h} in its path, plus the summed translate). Only rows with
 *               no bars fall back to the band maths: step = plotH / (n + 0.2),
 *               height = step * 0.8. Those constants were reverse-engineered
 *               from Airtable's own layout; if rows ever look misaligned,
 *               re-derive them by comparing two real bars' tops and heights.
 * Cell owner  = the bar segment under the cell's midpoint.
 *
 * ---------------------------------------------------------------------- *
 * IDEMPOTENCE  (the single most important rule here)
 *
 * Every write goes through setAttr/setText/dropAttr, which compare before
 * they write. A pass over already-correct markup therefore performs zero DOM
 * mutations, which is what makes it safe to re-run from a MutationObserver
 * watching the whole document. Break this rule anywhere and the script will
 * feed its own observer and spin the page. The test for a healthy build is
 * literally "zero mutations observed over six idle seconds".
 *
 * ---------------------------------------------------------------------- *
 * LAYER ORDER
 *
 * The grid layer is inserted as a sibling immediately BEFORE Vega's end-label
 * group (g.mark-text.role-mark), not appended at the end of the plot group.
 * Appended at the end, a filled cell paints over the numbers Airtable writes
 * at the end of each bar. The layer carries pointer-events="none" so the real
 * bars underneath keep their hover tooltips.
 *
 * ---------------------------------------------------------------------- *
 * THE LAYER 2 CONTRACT
 *
 * Signals on the chart element: data-tm-grid="1", -version, -rows, -cols,
 * -unit, -shape, plus a bubbling "tm-grid" CustomEvent whenever the shape
 * changes (resize, filter, data change) — that is the cue to repaint.
 *
 * window.__TM_GRID__ (see buildApi at the bottom):
 *   read    cell(id) at(rowOrCat, col) row(r) status(r, s) rows() cells()
 *           Each cell reports `cover`, the share of it its segment actually
 *           covers (1 = full). Trust that over status alone at the tail of a
 *           bar; see EDGE_TOL for why a cell can be flagged but unpainted.
 *   nodes   node(id) anchor(id) layer() svg() pattern(colour, kind)
 *           A cell's fill rect is g[data-tm-fill] > rect, NOT the first
 *           rect child: the text plate is a direct child of the cell too.
 *   write   paint(id, colour, {pattern, opacity}) paintAll(spec) unpaint(id)
 *           label(id, text, style) unlabel(id) refresh()
 *
 * Paint and label requests are held in the `fills` and `labels` Maps, NOT read
 * back off the SVG, so they survive Vega destroying and rebuilding the chart:
 * the next pass reapplies them. Layer 2 should therefore state what it wants
 * once and let this script keep it true.
 *
 * ---------------------------------------------------------------------- *
 * IF AIRTABLE CHANGES THE MARKUP — RECOVERY CHECKLIST
 *
 * Chart margins unchanged  -> shrinkPadding() found no padded wrapper between
 *                             the svg and the figure. Check which ancestor
 *                             carries the padding now (class "p3" today).
 * Margins shrink every pass -> the data-tm-pad memo is being stripped, so the
 *                             already-reduced value is read as the original.
 * Nothing renders          -> anatomy() returned null. Check the four
 *                             selectors in it against the new HTML: figure
 *                             aria-label, svg.marks, the role-frame root, and
 *                             the background path's "h{w}v{h}" shape.
 * Cells the wrong width    -> xScale(). Are the x-axis tick labels still
 *                             plain numbers positioned by translate()?
 * Rows misaligned          -> readRows() (y-axis label y minus 3.5) and the
 *                             BAND fallback constants.
 * Everything says "Empty"  -> parseLabel(). The aria-label key names changed;
 *                             log one bar's aria-label and re-map the keys.
 *                             Same fix if the Done count disappears (that
 *                             depends on Status being exactly "Done").
 * Square bar ends          -> rowClipPath() no longer finds the row clip.
 * Overlay in the wrong row -> offsetY() must SUM the nested translates.
 * Page hangs / CPU spins   -> something is writing unconditionally. Find it
 *                             and route it through setAttr/setText.
 * ====================================================================== */

(function () {
  'use strict';

  /* ================================================================== *
   * Settings
   * ================================================================== */

  const VERSION = '1.3.0';
  const TARGET_CHART = 'Production Numbers';

  const SIGNAL = {
    ready: 'data-tm-grid',           // "1" on the chart element and its <svg>
    version: 'data-tm-grid-version',
    rows: 'data-tm-grid-rows',
    cols: 'data-tm-grid-cols',
    unit: 'data-tm-grid-unit',       // px per x-axis unit = one cell's width
    shape: 'data-tm-grid-shape',     // "16x8@79.875"
    event: 'tm-grid',                // CustomEvent, fired when the shape changes
    global: '__TM_GRID__',
  };

  // Grey text on a white box, as the serial plates used. Two treatments, either
  // of which may be null: `plate` draws a measured rect behind the glyphs,
  // `halo` draws a stroke under them instead (needs no measurement, but
  // paint-order="stroke" must be set or the stroke swallows the glyph).
  const CELL_TEXT = {
    fontSize: 11,
    weight: '600',
    fill: 'var(--colors-foreground-subtler)', // the same grey Airtable's own labels use
    halo: null,            // set to '#ffffff' for a haloed outline instead of a box
    haloWidth: 3,
    opacity: 1,
    plate: '#ffffff',      // white box behind the text; null for none
    platePadX: 3,
    platePadY: 2,
    plateRadius: 2,
  };

  // The only text this layer draws of its own: how many Done cells the row
  // has, written over the last of them.
  const COLUMN_LABEL = { enabled: true };

  // Statuses exactly as they appear in each bar's aria-label.
  const DONE_SERIES = ['Done'];
  // Segments that only pad a row out to a common length: real cells, but
  // deliberately invisible, so nothing here counts as work.
  const PADDING_SERIES = ['Hidden'];

  // Pattern stock for layer 2. Stripe geometry is the canon 6 / 2 / 55.
  const PATTERNS = {
    stripes: { period: 6, width: 2, angle: 55, ink: '#ffffff' },
    dots: { period: 7, radius: 1.6, ink: '#ffffff' },
  };

  // Half a pixel of overlap between neighbouring filled cells, or the renderer
  // leaves a hairline seam where two colours meet.
  const SEAM_BLEED = 0.5;

  // The Vega svg sits inside a padded wrapper (class "p3" today, 32px a side).
  // scale 0.25 leaves 8px. The wrapper is found by MEASURED padding rather than
  // by class name, so an Airtable class rename can't break it, and the original
  // is parked in data-tm-pad so repeated passes scale the original and not the
  // already-shrunk value. Set enabled false to leave Airtable's spacing alone.
  // Note this only moves the outer margin: the ~148px gutter on the left is the
  // y-axis labels, which Vega sizes from the label text and this cannot shrink.
  const CHART_PADDING = { enabled: true, scale: 0.25, memo: 'data-tm-pad' };

  // Debug aid: outline every cell, including the invisible ones.
  const CELL_OUTLINE = { enabled: false, stroke: 'rgba(0,0,0,0.15)' };

  // Coverage tolerances for the cell classifier. A bar's right edge landing on a
  // cell boundary does not always subtract to exactly zero: at zoom levels whose
  // unit width is not exactly representable in binary, the NEXT cell overlaps the
  // bar by a few billionths of a pixel. Without EDGE_TOL that cell gets claimed
  // and reported as part of the segment — a phantom one cell past the paint, with
  // nothing drawn in it. MIN_COVER then stops a partly-covered cell being claimed
  // on a sliver; a cell must hold a real share of the segment to belong to it.
  const EDGE_TOL = 0.05;   // px of slop on every edge comparison
  const MIN_COVER = 0.05;  // minimum share of a cell, 0..1, for a partial claim

  // Fallback band geometry; only used for rows that have no bar to measure.
  const BAND = { denomPad: 0.2, innerPad: 0.2, labelDy: 3.5 };

  const DEBUG = false;

  /* ================================================================== *
   * Helpers
   * ================================================================== */

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const log = (...a) => DEBUG && console.log('[chart-grid]', ...a);
  const round = (n) => Math.round(n * 1e6) / 1e6;

  // Compare-then-write. See IDEMPOTENCE in the notes above.
  function setAttr(el, name, value) {
    if (el.getAttribute(name) !== String(value)) el.setAttribute(name, value);
  }

  function setText(el, value) {
    if (el.textContent !== String(value)) el.textContent = value;
  }

  function dropAttr(el, name) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  }

  function el(tag, attrs) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  const cssEscape = (s) =>
    (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&');

  function findChart(label) {
    for (const node of document.querySelectorAll('div[role="figure"][aria-label]')) {
      if (node.getAttribute('aria-label') === label) return node;
    }
    return null;
  }

  const barsIn = (node) =>
    node ? [...node.querySelectorAll('path[aria-roledescription="bar"]')] : [];

  // "chartPageElementAxisX: Welding; Status: Done; ...: 4 records"
  // If the grid ever reports every cell as Empty, these key names are why.
  function parseLabel(node) {
    const out = {};
    (node.getAttribute('aria-label') || '').split(';').forEach((part) => {
      const i = part.indexOf(':');
      if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    });
    const count = out['Distinct of chartPageElementAxisY_rowCount'] ||
                  out['chartPageElementAxisY_rowCount'] ||
                  out['chartPageElementAxisY_rowCountGroupTotalPerBar'];
    return {
      category: out['chartPageElementAxisX'] || out['Workstation (Color+Sort)'] || null,
      series: out['Status'] || null,
      count: count === undefined ? null : parseFloat(count),
    };
  }

  const translateOf = (node) =>
    /translate\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/.exec(node && node.getAttribute('transform') || '');

  const stripEllipsis = (s) => (s || '').replace(/[\u2026.]+$/, '').trim();

  const isDone = (series) => !!series && DONE_SERIES.includes(series);
  const isPadding = (series) => !!series && PADDING_SERIES.includes(series);

  /* ================================================================== *
   * Cell names: A01 .. Z99
   * ================================================================== */

  // Rows past the 26th continue AA, AB, ... rather than running out of names.
  function rowName(i) {
    let n = i, out = '';
    do {
      out = String.fromCharCode(65 + (n % 26)) + out;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return out;
  }

  const colName = (n) => String(n).padStart(n > 99 ? 3 : 2, '0');
  const cellName = (row, col) => rowName(row) + colName(col);

  /* ================================================================== *
   * Chart anatomy
   * ================================================================== */

  function anatomy(chartEl) {
    if (!chartEl) return null;
    const svg = chartEl.querySelector('svg.marks') || chartEl.querySelector('svg');
    if (!svg) return null;

    const root = svg.querySelector('g.mark-group.role-frame.root > g');
    if (!root) return null;

    // Plot frame: d="M0.5,0.5h639v377h-639Z"
    const bg = root.querySelector(':scope > path.background');
    const m = /h([\d.]+)v([\d.]+)h/.exec(bg && bg.getAttribute('d') || '');
    if (!m) return null;
    const plotW = parseFloat(m[1]);
    const plotH = parseFloat(m[2]);
    if (!(plotW > 0) || !(plotH > 0)) return null;

    // The two axes, told apart by where their labels sit: the discrete one
    // writes to the left of the plot, the linear one below it.
    let yAxis = null, xAxis = null;
    for (const ax of root.querySelectorAll('g.mark-group.role-axis')) {
      const lbl = ax.querySelector('g.mark-text.role-axis-label');
      if (!lbl) continue;
      const aria = ax.getAttribute('aria-label') || '';
      const t = translateOf(lbl.querySelector('text'));
      if (!yAxis && (aria.startsWith('Y-axis') || (t && parseFloat(t[1]) < 0))) yAxis = lbl;
      else if (!xAxis && (aria.startsWith('X-axis') || (t && parseFloat(t[1]) >= 0))) xAxis = lbl;
    }

    // Rows live in `scope`; Vega's own end labels are a sibling of it.
    const scope = root.querySelector(':scope > g > g.mark-group.role-scope');
    const totals = root.querySelector('g.mark-text.role-mark');

    return { chartEl, svg, root, plotW, plotH, yAxis, xAxis, scope, totals };
  }

  // Pixels per x-axis unit, from the tick labels. Exact, and present even when
  // every row is empty.
  function xScale(a) {
    const ticks = [];
    if (a.xAxis) {
      a.xAxis.querySelectorAll('text').forEach((t) => {
        const v = parseFloat((t.textContent || '').replace(/[^\d.-]/g, ''));
        const m = translateOf(t);
        if (isFinite(v) && m) ticks.push({ v, x: parseFloat(m[1]) });
      });
    }
    ticks.sort((p, q) => p.v - q.v);

    if (ticks.length >= 2) {
      const first = ticks[0], last = ticks[ticks.length - 1];
      const span = last.v - first.v;
      if (span > 0) {
        const unit = (last.x - first.x) / span;
        if (unit > 1) {
          const zero = first.x - first.v * unit; // in case the axis doesn't start at 0
          return { unit, zero, cols: Math.max(1, Math.round((a.plotW - zero) / unit)) };
        }
      }
    }

    // Fallback: any bar whose aria-label says how many records it holds.
    for (const bar of barsIn(a.chartEl)) {
      const { count } = parseLabel(bar);
      const g = barGeom(bar);
      if (g && count > 0 && g.w > 0) {
        const unit = g.w / count;
        if (unit > 1) return { unit, zero: 0, cols: Math.max(1, Math.round(a.plotW / unit)) };
      }
    }
    return null;
  }

  // Rows come from the y-axis, not the row groups: a category with no records
  // has a label but no group.
  function readRows(a, known) {
    if (!a.yAxis) return [];
    const rows = [];
    a.yAxis.querySelectorAll('text').forEach((t) => {
      const m = translateOf(t);
      if (!m) return;
      const label = stripEllipsis(t.textContent);
      if (!label) return;
      const truncated = /[\u2026]/.test(t.textContent || '');
      rows.push({
        category: truncated ? resolveCategory(label, known) : label,
        label,
        truncated,
        centre: parseFloat(m[2]) - BAND.labelDy,
      });
    });
    rows.sort((p, q) => p.centre - q.centre);
    rows.forEach((r, i) => { r.index = i; r.name = rowName(i); });
    return rows;
  }

  // "Insulation - Board Fo…" -> the one category starting with that prefix.
  // Ambiguous prefixes are left alone rather than guessed at.
  function resolveCategory(prefix, known) {
    if (!prefix || !known || known.has(prefix)) return prefix;
    let hit = null;
    for (const name of known) {
      if (name.startsWith(prefix)) {
        if (hit) return prefix;
        hit = name;
      }
    }
    return hit || prefix;
  }

  // Bar path: "M{x},0h{w}v{h}h-{w}Z"
  const BAR_D = /^M(-?[\d.]+),0h(-?[\d.]+)v(-?[\d.]+)h(-?[\d.]+)Z$/;

  function barGeom(node) {
    const m = BAR_D.exec((node.getAttribute('d') || '').trim());
    if (!m) return null;
    return { x: parseFloat(m[1]), w: parseFloat(m[2]), h: parseFloat(m[3]) };
  }

  // Sum every nested translate up to the plot group. Taking only the first
  // match lands on an inner translate(0,0) and misplaces the whole overlay.
  function offsetY(a, node) {
    let y = 0;
    for (let n = node; n && n !== a.root; n = n.parentElement) {
      const m = translateOf(n);
      if (m) y += parseFloat(m[2]);
    }
    return y;
  }

  // The clipPath that rounds this row's right-hand end. Cells are drawn
  // outside the row group, so they must borrow it or they square the end off.
  // The row clip's path starts "M0,0"; the plot-wide clip does not.
  function rowClipPath(a, bar) {
    for (let n = bar; n && n !== a.root; n = n.parentElement) {
      const ref = /url\(#([^)]+)\)/.exec(n.getAttribute('clip-path') || '');
      if (!ref) continue;
      const cp = a.svg.ownerDocument.getElementById(ref[1]);
      const path = cp && cp.querySelector('path');
      const d = path && path.getAttribute('d');
      if (d && /^M0,0/.test(d.trim())) return d;
    }
    return null;
  }

  // Every bar segment, in plot coordinates, grouped by category.
  function readSegments(a) {
    const byCat = new Map();
    barsIn(a.chartEl).forEach((bar) => {
      const { category, series, count } = parseLabel(bar);
      const g = barGeom(bar);
      if (!category || !g || !(g.w > 0)) return;
      const fill = bar.getAttribute('fill') || '';
      if (fill === 'transparent' || fill === 'none') return; // placeholder row
      const list = byCat.get(category) || [];
      list.push({
        x0: g.x, x1: g.x + g.w, h: g.h, series, count, fill,
        y: offsetY(a, bar), node: bar, clip: rowClipPath(a, bar),
      });
      byCat.set(category, list);
    });
    byCat.forEach((list) => list.sort((p, q) => p.x0 - q.x0));
    return byCat;
  }

  /* ================================================================== *
   * Build the grid
   * ================================================================== */

  function buildRow(row, segs, scale, cols, band) {
    // Geometry from a real bar when there is one, so cells sit exactly on the
    // bar rather than on our idea of where it should be.
    const sample = segs && segs.length ? segs[0] : null;
    const h = sample ? sample.h : band.height;
    const top = sample ? sample.y : row.centre - band.height / 2;

    // The row group is translated to `top`, so cells are positioned in row
    // coordinates and the borrowed clip path applies unchanged.
    row.top = round(top);
    row.height = round(h);
    row.clip = sample ? sample.clip : null;

    const cells = [];
    for (let c = 1; c <= cols; c++) {
      const x0 = scale.zero + (c - 1) * scale.unit;
      const x1 = x0 + scale.unit;
      const mid = (x0 + x1) / 2;

      // The segment under the cell's midpoint owns it. Counts are whole
      // numbers, so in practice a cell sits squarely inside one segment.
      let seg = null, cover = 0;
      (segs || []).forEach((s) => {
        const overlap = Math.min(s.x1, x1) - Math.max(s.x0, x0);
        if (overlap <= EDGE_TOL) return;                    // touching, not covering
        if (mid >= s.x0 - EDGE_TOL && mid < s.x1 - EDGE_TOL) {
          seg = s; cover = overlap;                         // segment holds the midpoint
        } else if (!seg && overlap > cover && overlap >= scale.unit * MIN_COVER) {
          seg = s; cover = overlap;                         // partial, but a real share
        }
      });

      cells.push({
        id: cellName(row.index, c),
        row: row.name,
        rowIndex: row.index,
        category: row.category,
        col: c,
        // x/w are plot coordinates; y is absolute in the plot, so callers can
        // position anything against a cell without walking transforms.
        x: round(x0),
        y: round(top),
        w: round(scale.unit),
        h: round(h),
        cx: round(x0 + scale.unit / 2),
        cy: round(top + h / 2),
        status: seg ? (seg.series || 'Unknown') : 'Empty',
        filled: !!seg,
        done: seg ? isDone(seg.series) : false,
        padding: seg ? isPadding(seg.series) : false,
        fill: seg ? seg.fill : '',
        // How far into its own segment this cell is: the 3rd of 4 Done cells.
        ordinal: seg ? Math.round((x0 - seg.x0) / scale.unit) + 1 : 0,
        cover: round(cover / scale.unit),
      });
    }

    const done = cells.filter((c) => c.done);
    row.doneCount = done.length;
    row.lastDone = done.length ? done[done.length - 1].id : null;
    row.cells = cells;
    return cells;
  }

  /* ================================================================== *
   * Fills: the harness layer 2 paints through
   * ================================================================== */

  function defsOf(svg) {
    let defs = svg.querySelector(':scope > defs');
    if (!defs) {
      defs = el('defs', {});
      svg.insertBefore(defs, svg.firstChild);
    }
    return defs;
  }

  const slug = (s) => String(s).replace(/[^a-z0-9]+/gi, '');

  // One pattern per colour and kind, reused by every cell that asks for it.
  function ensurePattern(svg, color, kind) {
    if (!kind || kind === 'solid' || !PATTERNS[kind]) return color;
    const id = `tm-grid-${kind}-${slug(color)}`;
    const defs = defsOf(svg);
    if (defs.querySelector(`pattern[id="${id}"]`)) return `url(#${id})`;

    const g = PATTERNS[kind];
    const attrs = { id, width: g.period, height: g.period, patternUnits: 'userSpaceOnUse' };
    if (g.angle) attrs.patternTransform = `rotate(${g.angle})`;
    const pattern = el('pattern', attrs);
    pattern.appendChild(el('rect', { width: g.period, height: g.period, fill: color }));
    if (kind === 'dots') {
      pattern.appendChild(el('circle', {
        cx: g.period / 2, cy: g.period / 2, r: g.radius, fill: g.ink,
      }));
    } else {
      pattern.appendChild(el('rect', { width: g.width, height: g.period, fill: g.ink }));
    }
    defs.appendChild(pattern);
    return `url(#${id})`;
  }

  // One clipPath per row, holding the shape Airtable clips that row with.
  function ensureRowClip(a, row) {
    if (!row.clip) return null;
    const id = `tm-grid-clip-${row.name}`;
    const defs = defsOf(a.svg);
    let cp = defs.querySelector(`clipPath[id="${id}"]`);
    if (!cp) {
      cp = el('clipPath', { id });
      cp.appendChild(el('path', { d: row.clip }));
      defs.appendChild(cp);
    } else {
      setAttr(cp.querySelector('path'), 'd', row.clip);
    }
    return `url(#${id})`;
  }

  // What layer 2 has asked for. Held here rather than read back off the SVG so
  // a fill or a label survives Vega rebuilding the chart: the next pass
  // reapplies it.
  const fills = new Map();   // cell id -> { color, pattern, opacity }
  const labels = new Map();  // cell id -> { text, ...style }

  /* ================================================================== *
   * Draw
   * ================================================================== */

  // Immediately before Vega's end-label group: after the bars so cell fills
  // and text read over them, before the labels so nothing buries a number
  // Airtable drew. pointer-events="none" keeps the real bars hoverable.
  function gridLayer(a) {
    const anchor = a.totals && a.totals.parentElement ? a.totals : null;
    const host = anchor ? anchor.parentElement : a.root;

    let layer = host.querySelector(':scope > g[data-tm-grid]') ||
                a.root.querySelector('g[data-tm-grid]');
    if (!layer) {
      layer = el('g', {
        'data-tm-grid': '1',
        'aria-hidden': 'true',
        'pointer-events': 'none',
      });
      host.insertBefore(layer, anchor);
    } else if (layer.parentElement !== host || layer.nextSibling !== anchor) {
      host.insertBefore(layer, anchor); // only when Vega has actually moved it
    }
    return layer;
  }

  const cellNode = (a, id) =>
    a.svg.querySelector(`g[data-tm-cell="${cssEscape(id)}"]`);

  function fillFor(a, id) {
    const want = fills.get(id);
    if (!want || !want.color) return null;
    return ensurePattern(a.svg, want.color, want.pattern);
  }

  // Filled neighbours overlap to hide the seam between them — but never past
  // the last filled cell, or the paint runs off the end of the bar.
  const bleedFor = (cells, i) =>
    fills.has(cells[i].id) && cells[i + 1] && fills.has(cells[i + 1].id) ? SEAM_BLEED : 0;

  function applyFill(a, cells, i) {
    const cell = cells[i];
    const g = cellNode(a, cell.id);
    if (!g) return;
    const rect = g.querySelector(':scope > g[data-tm-fill] > rect');
    const paint = fillFor(a, cell.id);
    const want = fills.get(cell.id);

    setAttr(rect, 'width', round(cell.w + bleedFor(cells, i)));
    setAttr(rect, 'height', cell.h);
    setAttr(rect, 'fill', paint || 'none');
    if (want && want.opacity !== undefined) setAttr(rect, 'fill-opacity', want.opacity);
    else dropAttr(rect, 'fill-opacity');

    if (want && want.pattern) setAttr(g, 'data-tm-paint', want.pattern);
    else if (paint) setAttr(g, 'data-tm-paint', 'solid');
    else dropAttr(g, 'data-tm-paint');
  }

  // Whatever layer 2 asked for, else this layer's own Done count on the last
  // Done cell, else nothing.
  function labelFor(row, cell) {
    const own = labels.get(cell.id);
    if (own) return own;
    if (COLUMN_LABEL.enabled && cell.id === row.lastDone) return { text: String(cell.col) };
    return null;
  }

  function styleText(text, label) {
    const host = text.parentElement;
    const plateOf = () => host.querySelector(':scope > rect[data-tm-plate]');

    setText(text, label ? label.text : '');
    if (!label) {
      const stale = plateOf();
      if (stale) stale.remove();   // a cell that loses its text must lose its box
      return;
    }

    const size = label.fontSize || CELL_TEXT.fontSize;
    setAttr(text, 'font-size', `${size}px`);
    setAttr(text, 'font-weight', label.weight || CELL_TEXT.weight);
    setAttr(text, 'fill', label.fill || CELL_TEXT.fill);
    setAttr(text, 'opacity', label.opacity === undefined ? CELL_TEXT.opacity : label.opacity);

    const halo = label.halo === undefined ? CELL_TEXT.halo : label.halo;
    if (halo) {
      setAttr(text, 'stroke', halo);
      setAttr(text, 'stroke-width', label.haloWidth || CELL_TEXT.haloWidth);
      setAttr(text, 'stroke-linejoin', 'round');
      setAttr(text, 'paint-order', 'stroke');   // or the stroke covers the glyph
    } else {
      ['stroke', 'stroke-width', 'stroke-linejoin', 'paint-order']
        .forEach((n) => dropAttr(text, n));
    }

    const want = label.plate === undefined ? CELL_TEXT.plate : label.plate;
    let box = plateOf();
    if (!want) {
      if (box) box.remove();
      return;
    }
    if (!box) {
      box = el('rect', { 'data-tm-plate': '1' });
      host.insertBefore(box, text);   // under the text, over the cell fill
    }
    const px = CELL_TEXT.platePadX, py = CELL_TEXT.platePadY;
    // getComputedTextLength is exact but returns 0 until the text has been laid
    // out, so the first pass estimates and a later pass corrects it. 0.6 is the
    // width-per-em fudge; retune it if boxes sit consistently wide or narrow.
    const w = (text.getComputedTextLength ? text.getComputedTextLength() : 0) ||
              String(label.text).length * size * 0.6;
    setAttr(box, 'x', round(+text.getAttribute('x') - w / 2 - px));
    setAttr(box, 'y', round(+text.getAttribute('y') - size / 2 - py));
    setAttr(box, 'width', round(w + px * 2));
    setAttr(box, 'height', round(size + py * 2));
    setAttr(box, 'rx', CELL_TEXT.plateRadius);
    setAttr(box, 'fill', want);
  }

  function render(a, layer, rows) {
    const wantedRows = new Set();

    rows.forEach((row) => {
      wantedRows.add(row.name);
      let group = layer.querySelector(`:scope > g[data-tm-row="${cssEscape(row.name)}"]`);
      if (!group) {
        group = el('g', { 'data-tm-row': row.name });
        layer.appendChild(group);
      }
      setAttr(group, 'data-tm-cat', row.category);
      setAttr(group, 'data-tm-done', row.doneCount);
      setAttr(group, 'transform', `translate(0,${row.top})`);

      // The row group is NOT clipped: the borrowed clip stops at the row's bar
      // width, so clipping here would silently swallow any text a layer 2
      // script writes in a cell past the end of the bar. Only fills are clipped.
      dropAttr(group, 'clip-path');

      const keep = new Set();
      row.cells.forEach((cell, i) => {
        keep.add(cell.id);
        let g = group.querySelector(`:scope > g[data-tm-cell="${cell.id}"]`);
        if (!g) {
          g = el('g', { 'data-tm-cell': cell.id });
          const wrap = el('g', { 'data-tm-fill': '1' });
          wrap.appendChild(el('rect', { y: 0, fill: 'none' }));
          g.appendChild(wrap);
          g.appendChild(el('text', { 'data-tm-anchor': '1' }));
          group.appendChild(g);
        }

        setAttr(g, 'transform', `translate(${cell.x},0)`);
        setAttr(g, 'data-tm-col', cell.col);
        setAttr(g, 'data-tm-cat', cell.category);
        setAttr(g, 'data-tm-status', cell.status);
        setAttr(g, 'data-tm-ordinal', cell.ordinal);
        // Share of the cell its segment actually covers, 0..1. A layer 2 can use
        // this to ignore anything the paint does not really reach.
        setAttr(g, 'data-tm-cover', cell.cover);
        setAttr(g, 'data-tm-fill', cell.fill);
        setAttr(g, 'data-tm-padding', cell.padding ? '1' : '0');
        setAttr(g, 'data-tm-empty', cell.filled ? '0' : '1');

        // The wrapper undoes the cell's translate so the row clip, which is
        // expressed in row coordinates, applies to the rect unchanged.
        const wrap = g.querySelector(':scope > g[data-tm-fill]');
        setAttr(wrap, 'transform', `translate(${round(-cell.x)},0)`);
        const clip = ensureRowClip(a, row);
        if (clip) setAttr(wrap, 'clip-path', clip);
        else dropAttr(wrap, 'clip-path');

        const rect = wrap.querySelector(':scope > rect');
        setAttr(rect, 'x', cell.x);
        if (CELL_OUTLINE.enabled) setAttr(rect, 'stroke', CELL_OUTLINE.stroke);
        else dropAttr(rect, 'stroke');
        applyFill(a, row.cells, i);

        // The anchor exists on every cell whether or not anything is written
        // in it, so layer 2 only ever has to set textContent.
        const text = g.querySelector(':scope > text');
        setAttr(text, 'x', round(cell.w / 2));
        setAttr(text, 'y', round(cell.h / 2));
        setAttr(text, 'text-anchor', 'middle');
        setAttr(text, 'dominant-baseline', 'central');
        styleText(text, labelFor(row, cell));
      });

      [...group.children].forEach((g) => {
        if (!keep.has(g.dataset.tmCell)) g.remove();
      });
    });

    [...layer.children].forEach((g) => {
      if (!wantedRows.has(g.dataset.tmRow)) g.remove();
    });
  }

  // Shrink the wrapper's padding so the plot gets more of the card. Changing it
  // makes Airtable re-render the chart at a new size, which this script's own
  // observer then picks up; it converges because the second pass writes nothing.
  function shrinkPadding(a) {
    if (!CHART_PADDING.enabled) return;

    let host = null, orig = null;
    for (let n = a.svg.parentElement; n && n !== a.chartEl; n = n.parentElement) {
      const memo = n.getAttribute(CHART_PADDING.memo);
      if (memo) { host = n; orig = memo.split(' ').map(Number); break; }
      const cs = window.getComputedStyle ? window.getComputedStyle(n) : null;
      if (!cs) continue;
      const sides = ['Top', 'Right', 'Bottom', 'Left']
        .map((side) => parseFloat(cs['padding' + side]) || 0);
      if (sides.some((v) => v > 0)) {
        host = n; orig = sides;
        setAttr(n, CHART_PADDING.memo, sides.join(' '));   // remember the original
        break;
      }
    }
    if (!host) return;

    const want = orig.map((v) => `${round(v * CHART_PADDING.scale)}px`).join(' ');
    if (host.style.padding !== want) host.style.padding = want;
  }

  /* ================================================================== *
   * The API layer 2 talks to
   * ================================================================== */

  let current = null; // { a, rows, scale, index }

  const resolveCell = (id) =>
    current ? (current.index.get(String(id).toUpperCase()) || null) : null;

  const rowOf = (cell) =>
    current ? current.rows.find((r) => r.name === cell.row) : null;

  // Repaint one cell now, plus its left neighbour, whose bleed may have changed.
  function repaint(id) {
    const cell = resolveCell(id);
    if (!cell) return false;
    const row = rowOf(cell);
    if (!row) return false;
    const i = cell.col - 1;
    applyFill(current.a, row.cells, i);
    if (i > 0) applyFill(current.a, row.cells, i - 1);
    return true;
  }

  function relabel(id) {
    const cell = resolveCell(id);
    if (!cell) return false;
    const row = rowOf(cell);
    const g = cellNode(current.a, cell.id);
    const text = g && g.querySelector(':scope > text');
    if (!text || !row) return false;
    styleText(text, labelFor(row, cell));
    return true;
  }

  function buildApi(a, rows, scale, index) {
    const findRow = (key) => rows.find((r) => r.name === key || r.category === key);
    const api = {
      version: VERSION,
      chart: TARGET_CHART,
      unit: scale.unit,
      zero: scale.zero,
      cols: scale.cols,

      /* read */
      rows: () => rows.map((r) => ({
        name: r.name, category: r.category, index: r.index,
        done: r.doneCount, lastDone: r.lastDone, cells: r.cells.map((c) => c.id),
      })),
      cell: (id) => resolveCell(id),
      cells: () => [...index.values()],
      at: (rowOrCat, col) => {                    // at('Finish', 5) or at('L', 5)
        const r = findRow(rowOrCat);
        return r ? (r.cells[col - 1] || null) : null;
      },
      row: (rowOrCat) => {
        const r = findRow(rowOrCat);
        return r ? r.cells.slice() : [];
      },
      status: (rowOrCat, status) => {
        const r = findRow(rowOrCat);
        return r ? r.cells.filter((c) => c.status === status) : [];
      },

      /* the nodes themselves, for anything bespoke */
      node: (id) => cellNode(a, id),
      anchor: (id) => {
        const g = cellNode(a, id);
        return g ? g.querySelector(':scope > text') : null;
      },
      layer: () => a.svg.querySelector('g[data-tm-grid]'),
      svg: () => a.svg,
      pattern: (color, kind) => ensurePattern(a.svg, color, kind),
      patterns: () => Object.keys(PATTERNS),

      /* write */
      // paint('L05', 'rgb(22, 110, 225)')
      // paint('L06', '#166ee1', { pattern: 'stripes' })
      paint: (id, color, opts) => {
        const cell = resolveCell(id);
        if (!cell) return false;
        if (!color) fills.delete(cell.id);
        else fills.set(cell.id, {
          color,
          pattern: (opts && opts.pattern) || null,
          opacity: opts && opts.opacity,
        });
        return repaint(cell.id);
      },
      // paintAll({ L05: '#166ee1', L06: { color: '#ccc', pattern: 'dots' } })
      paintAll: (spec) => {
        let n = 0;
        Object.keys(spec || {}).forEach((id) => {
          const v = spec[id];
          const ok = (v === null || v === undefined || typeof v === 'string')
            ? api.paint(id, v)
            : api.paint(id, v.color, v);
          if (ok) n++;
        });
        return n;
      },
      unpaint: (id) => {
        if (id === undefined) { const n = fills.size; fills.clear(); refresh(); return n; }
        const cell = resolveCell(id);
        if (!cell) return false;
        fills.delete(cell.id);
        return repaint(cell.id);
      },
      painted: () => [...fills.keys()],

      // label('L05', 'MLX00000', { fill: '#000', halo: '#fff', fontSize: 11 })
      // Pass halo: null for text with no outline.
      label: (id, text, style) => {
        const cell = resolveCell(id);
        if (!cell) return false;
        if (text === null || text === undefined || text === '') labels.delete(cell.id);
        else labels.set(cell.id, Object.assign({ text: String(text) }, style || {}));
        return relabel(cell.id);
      },
      unlabel: (id) => {
        if (id === undefined) { const n = labels.size; labels.clear(); refresh(); return n; }
        const cell = resolveCell(id);
        if (!cell) return false;
        labels.delete(cell.id);
        return relabel(cell.id);
      },
      labelled: () => [...labels.keys()],

      refresh: () => refresh(),
    };
    return api;
  }

  function signal(a, rows, scale) {
    const node = a.chartEl;
    const shape = `${rows.length}x${scale.cols}@${round(scale.unit)}`;
    const changed = node.getAttribute(SIGNAL.shape) !== shape;

    setAttr(node, SIGNAL.ready, '1');
    setAttr(node, SIGNAL.version, VERSION);
    setAttr(node, SIGNAL.rows, rows.length);
    setAttr(node, SIGNAL.cols, scale.cols);
    setAttr(node, SIGNAL.unit, round(scale.unit));
    setAttr(node, SIGNAL.shape, shape);
    setAttr(a.svg, SIGNAL.ready, '1');

    if (changed) {
      log('grid', shape);
      node.dispatchEvent(new CustomEvent(SIGNAL.event, {
        bubbles: true,
        detail: { version: VERSION, rows: rows.length, cols: scale.cols, unit: scale.unit },
      }));
    }
  }

  /* ================================================================== *
   * Orchestration
   * ================================================================== */

  let applying = false;

  function apply() {
    if (applying) return;
    const a = anatomy(findChart(TARGET_CHART));
    if (!a) return;

    const scale = xScale(a);
    if (!scale) { log('waiting for the x axis'); return; }

    const segments = readSegments(a);
    const rows = readRows(a, new Set(segments.keys()));
    if (!rows.length) { log('waiting for the y axis'); return; }

    applying = true;
    try {
      const step = a.plotH / (rows.length + BAND.denomPad);
      const band = { step, height: step * (1 - BAND.innerPad) };

      rows.forEach((row) => buildRow(row, segments.get(row.category), scale, scale.cols, band));

      const index = new Map();
      rows.forEach((r) => r.cells.forEach((c) => index.set(c.id, c)));
      current = { a, rows, scale, index };

      shrinkPadding(a);
      render(a, gridLayer(a), rows);
      window[SIGNAL.global] = buildApi(a, rows, scale, index);
      signal(a, rows, scale);
    } catch (e) {
      console.warn('[chart-grid] failed:', e);
    } finally {
      applying = false;
    }
  }

  const refresh = () => { apply(); return !!current; };

  // Stay applied across Vega re-renders (resize, filters, data changes). Safe
  // to re-run because a correct pass writes nothing — see IDEMPOTENCE.
  const MIN_GAP = 250; // ms; Airtable mutates constantly, so throttle passes
  let timer = null;
  let pending = false;
  let last = 0;

  function run() {
    timer = null;
    last = Date.now();
    apply();
    if (pending) { pending = false; schedule(); }
  }

  function schedule(delay) {
    if (applying) { pending = true; return; }
    if (timer) return;
    timer = setTimeout(run, Math.max(delay || 80, MIN_GAP - (Date.now() - last)));
  }

  new MutationObserver(() => schedule()).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['fill', 'd', 'transform', 'aria-label', 'style', 'class'],
  });

  ['resize', 'scroll', 'visibilitychange', 'focus', 'popstate', 'hashchange']
    .forEach((ev) => window.addEventListener(ev, () => schedule(120), true));

  document.addEventListener('DOMContentLoaded', () => schedule());
  window.addEventListener('load', () => schedule());

  // Poll while the chart mounts, then let the observer take over.
  let tries = 0;
  const boot = setInterval(() => {
    schedule();
    if (++tries > 60 || document.querySelector(`[${SIGNAL.ready}="1"]`)) clearInterval(boot);
  }, 500);

  schedule(0);
})();
