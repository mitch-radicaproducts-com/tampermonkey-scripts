// ==UserScript==
// @name         Airtable — Restyle "Production Numbers" chart from "Palette" chart
// @namespace    radicaproducts.com
// @version      3.8.0
// @description  Reads the "Palette" chart once per page load — its rows, their order and their colors are the single source of truth — then holds the "Production Numbers" chart to that axis all day: missing workstations become 0 rows, existing bar lengths are never touched, Done segments take their workstation color, In-Progress tips become diagonal stripes overlaid with the serial numbers currently on that station (a serial in progress at a second station is drawn in the stripe colour), the "Hidden" padding segments are painted out, and the end of each bar carries that station's takt time, with a thumbs-up after it when a single on-time unit is on that station.
// @author       Mitch
// @match        https://airtable.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ================================================================== *
   * Config
   * ================================================================== */

  const SOURCE_CHART = 'Palette';            // chart that defines the axis order + colors
  const TARGET_CHART = 'Production Numbers'; // chart to restyle

  // Workstations in the target chart that the Palette chart doesn't list.
  // The palette is the source of truth for which rows exist, so these are
  // dropped by default. Set to false to keep them, appended at the bottom.
  const PALETTE_IS_COMPLETE = true;

  const FIX_AXIS = true;   // add missing workstations + enforce palette order
  const RECOLOR  = true;   // recolor the green (Done) segments
  const STRIPES  = true;   // stripe the yellow (In-Progress) tips
  const ZERO_LABELS = true; // in count mode, draw a "0" on rows Airtable had no data for
  // Replace the number at the end of each bar with that station's takt time,
  // read from the serial table. Rows with nothing in progress show nothing.
  const TAKT_TOTALS = true;
  const HIDE_PADDING = true;     // make the "Hidden" spacer segments invisible
  const TOTALS_AT_VISIBLE_END = true; // ...and put the end label after the last visible segment

  // Overlay the in-progress serial numbers on top of each striped tip, read
  // from a table elsewhere on the page and refreshed on every pass.
  const SERIAL_OVERLAY = true;
  const SERIAL_TABLE = 'Serial Numbers In-Progress'; // that element's label
  const SERIAL_COLUMNS = {
    status: 'Status',            // column headers, matched by title
    serial: 'Serial Number',
    station: 'Workstation Link',
    takt: 'Takt Time',
    ontime: 'On Time',          // checkbox: green thumb = true, white = false
  };
  // Workstations that get no takt time and no thumb, whatever the table says.
  const TAKT_EXCLUDE = ['GOAL'];
  // The on-time mark. Drawn with Airtable's own thumbs-up sprite, so it is the
  // same glyph the table shows; the href is read off the table at runtime.
  const ONTIME_ICON = {
    enabled: true,
    size: 12,               // px square
    gap: 3,                 // px between the takt text and the thumb
    fill: 'rgb(4, 138, 14)',// Airtable's checked green
    href: '/icons/icon_definitions.svg#ThumbsUpFill', // fallback if not found
    glyph: '\ud83d\udc4d',  // last-resort fallback if the sprite won't load
  };
  // Only these statuses are overlaid. Empty = take every row in the table.
  const SERIAL_STATUSES = ['In-Progress', 'In Progress'];
  const SERIAL_STYLE = {
    fontSize: 11,          // px
    fill: 'var(--colors-foreground-default)',
    bg: '#ffffff',         // white plate behind the text
    bgOpacity: 1,          // 1 = solid; lower it to let the stripes show through
    padX: 3,               // px of plate either side of the text
    padY: 2,
    radius: 2,
    sort: true,            // sort serials so the string is stable day to day
    separator: ', ',
    clamp: true,           // keep long strings from running off the canvas
    clampLeftToPlot: true, // ...and out of the y-axis label gutter on the left
  };
  // A serial can be in progress at more than one station at once. The first
  // station it appears at (reading down the axis) keeps the normal text colour;
  // every later appearance is drawn in the stripe colour to flag the repeat.
  const REPEAT_SERIAL_COLOR = 'stripe'; // 'stripe' = match STRIPE.base, or any CSS colour

  // Push a bar's end label clear of its serial plate instead of letting the
  // plate cover it. Only applies when TOTALS_AT_VISIBLE_END is on.
  const NUDGE_TOTALS_PAST_SERIALS = true;

  // Series values (bar aria-label "Status: ...") used only to pad a bar out to
  // a fixed length. Kept in the DOM — they hold the x-axis domain steady and
  // still answer to hover — but painted invisible.
  const HIDDEN_SERIES = ['Hidden'];

  // Fills that count as "the green series" in the target chart.
  const GREEN_FILLS = ['rgb(154, 224, 149)'];
  // Series values (bar aria-label "Status: ...") that count as green. Fallback
  // in case Airtable ever changes the green hex.
  const GREEN_SERIES = ['Done'];

  // Fills / series that count as "the yellow series" — these get striped.
  const YELLOW_FILLS = ['rgb(255, 214, 107)'];
  const YELLOW_SERIES = ['In-Progress', 'In Progress'];

  // Diagonal stripe pattern for the yellow tips.
  const STRIPE = {
    id: 'tm-inprogress-stripes',
    base: '#d54401', // yellow
    stripe: '#ffffff',          // white
    period: 6,                  // px: one yellow + one white band
    width: 5,                   // px of white per period
    angle: 55,                  // degrees
  };

  // Vega band-scale constants, measured from Airtable's own render.
  const BAND = {
    outerPad: 0.2,   // top offset as a fraction of one step
    denomPad: 0.2,   // step = plotHeight / (rowCount + denomPad)
    innerPad: 0.2,   // barHeight = step * (1 - innerPad)
    cornerR: 4,      // rounded bar end radius
    labelDy: 3.5,    // axis label baseline offset below the band centre
    valueDy: 3,      // bar-total label baseline offset below the band centre
    valueGap: 8,     // gap between the end of a bar and its total label
  };

  // The palette is read once, when it is fully rendered, and then frozen for
  // the rest of the page's life. If a label somehow never resolves to a
  // colour, accept the best reading available after this long and move on.
  const PALETTE_GRACE_MS = 15000;

  const DEBUG = false;

  /* ================================================================== *
   * Small helpers
   * ================================================================== */

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const log = (...a) => DEBUG && console.log('[chart-restyle]', ...a);
  const normFill = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, '');

  const GREEN_SET = new Set(GREEN_FILLS.map(normFill));
  const YELLOW_SET = new Set(YELLOW_FILLS.map(normFill));

  // Every write goes through these so an unchanged value never fires a
  // mutation record (which would otherwise re-trigger this script forever).
  function setAttr(el, name, value) {
    const v = String(value);
    if (el.getAttribute(name) !== v) el.setAttribute(name, v);
  }
  function setText(el, value) {
    if (el.textContent !== value) el.textContent = value;
  }
  const round = (n) => Math.round(n * 1e6) / 1e6;

  function findChart(label) {
    for (const el of document.querySelectorAll('div[role="figure"][aria-label]')) {
      if (el.getAttribute('aria-label') === label) return el;
    }
    return null;
  }

  const barsIn = (el) =>
    el ? [...el.querySelectorAll('path[aria-roledescription="bar"]')] : [];

  // aria-label: "... chartPageElementAxisX: Welding; Status: Done; ..."
  function parseLabel(el) {
    const out = {};
    (el.getAttribute('aria-label') || '').split(';').forEach((part) => {
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

  function originalFill(el) {
    if (el.dataset.origFill) return el.dataset.origFill;
    const f = el.getAttribute('fill') || '';
    el.dataset.origFill = f;
    return f;
  }

  const stripEllipsis = (s) => (s || '').replace(/[\u2026.]+$/, '').trim();

  /* ================================================================== *
   * Chart anatomy
   * ================================================================== */

  function anatomy(chartEl) {
    if (!chartEl) return null;
    const svg = chartEl.querySelector('svg.marks') || chartEl.querySelector('svg');
    if (!svg) return null;

    const root = svg.querySelector('g.mark-group.role-frame.root > g');
    if (!root) return null;

    // Plot frame: d="M0.5,0.5h123v377h-123Z"
    const bg = root.querySelector(':scope > path.background');
    const m = /h([\d.]+)v([\d.]+)h/.exec(bg && bg.getAttribute('d') || '');
    if (!m) return null;
    const plotW = parseFloat(m[1]);
    const plotH = parseFloat(m[2]);

    // Y axis label group (discrete axis; its labels are right-aligned at a
    // negative x). Fall back to "the axis whose labels sit left of the plot".
    let yAxis = null;
    for (const ax of root.querySelectorAll('g.mark-group.role-axis')) {
      const lbl = ax.querySelector('g.mark-text.role-axis-label');
      if (!lbl) continue;
      const first = lbl.querySelector('text');
      const t = /translate\(\s*(-?[\d.]+)/.exec(first && first.getAttribute('transform') || '');
      if ((ax.getAttribute('aria-label') || '').startsWith('Y-axis') ||
          (t && parseFloat(t[1]) < 0)) {
        yAxis = lbl;
        break;
      }
    }

    // Row container: the scope group holding one <g transform="translate(0,y)">
    // per category. Plus the per-bar total labels, which live outside the rows.
    const scope = root.querySelector(':scope > g > g.mark-group.role-scope');
    const totals = root.querySelector('g.mark-text.role-mark');

    // Left offset of the plot inside the SVG, and the SVG's own width: needed
    // to work out how much room a label really has before it gets clipped.
    const outerG = svg.querySelector(':scope > g');
    const ox = /translate\(\s*(-?[\d.]+)/.exec(outerG && outerG.getAttribute('transform') || '');
    const outerX = ox ? parseFloat(ox[1]) : 148;
    const svgW = parseFloat(svg.getAttribute('width')) || (outerX + plotW);

    return { chartEl, svg, root, plotW, plotH, yAxis, scope, totals, outerX, svgW };
  }

  const rowGroups = (a) =>
    a && a.scope ? [...a.scope.querySelectorAll(':scope > g[transform]')] : [];

  function rowCategory(g) {
    if (g.dataset.tmCategory) return g.dataset.tmCategory;
    const b = g.querySelector('path[aria-roledescription="bar"]');
    return b ? parseLabel(b).category : null;
  }

  /* ================================================================== *
   * Palette: axis order (top to bottom) + colour per workstation
   * ================================================================== */

  // Read once, then frozen. The Palette chart may be unmounted, re-rendered or
  // scrolled away afterwards; none of that can change what we locked in.
  let palette = null;
  let firstAttempt = 0;

  // `targetCats` helps resolve ellipsised palette labels back to real names.
  function readPalette(targetCats) {
    if (palette) return palette;

    const a = anatomy(findChart(SOURCE_CHART));
    if (!a) return null;
    if (!firstAttempt) firstAttempt = Date.now();

    const colors = new Map();
    barsIn(a.chartEl).forEach((el) => {
      const { category } = parseLabel(el);
      const fill = el.getAttribute('fill');
      if (category && fill && !colors.has(category)) colors.set(category, fill);
    });

    // The y-axis labels give both the row order (top to bottom) and the row
    // names. Labels can be ellipsised, so resolve them against the names the
    // palette's own bars report, then against the target chart's categories.
    const names = [...colors.keys()];
    const known = names.concat(targetCats || []);
    // Read the labels top to bottom by POSITION, not by DOM order. Vega reuses
    // SVG nodes across updates and appends new ones at the end, so the element
    // order in the markup drifts away from what's on screen even though every
    // transform stays correct. Sorting by y is what keeps a recently changed
    // workstation from looking like it belongs at the bottom.
    const labels = a.yAxis ? sortByY([...a.yAxis.querySelectorAll('text')]) : [];
    const order = [];

    labels.forEach((t) => {
      const raw = (t.textContent || '').trim();
      if (!raw) return;
      const stem = stripEllipsis(raw);
      const cat = (colors.has(raw) && raw) ||
                  known.find((n) => n === stem) ||
                  (stem && known.find((n) => n.startsWith(stem))) ||
                  stem;
      if (cat && !order.includes(cat)) order.push(cat);
    });

    if (!order.length) return null;

    // Don't lock in a half-drawn chart. Vega announces how many rows the axis
    // has; wait until we have that many, each with a colour of its own.
    const declared = declaredRowCount(a.yAxis);
    const complete = (!declared || order.length === declared) &&
                     order.every((c) => colors.has(c));

    if (!complete && Date.now() - firstAttempt < PALETTE_GRACE_MS) {
      log('palette still settling:', order.length, 'of', declared || '?');
      return null;
    }

    palette = { order, colors };
    log('palette locked:', order.join(', '));
    return palette;
  }

  // Sort elements by the y of their own transform: their visual order.
  function sortByY(nodes) {
    return nodes
      .map((el, i) => {
        const m = /translate\(\s*-?[\d.]+\s*,\s*(-?[\d.]+)/.exec(el.getAttribute('transform') || '');
        return { el, i, y: m ? parseFloat(m[1]) : NaN };
      })
      .sort((a, b) => {
        if (isNaN(a.y) || isNaN(b.y)) return a.i - b.i;
        return a.y - b.y || a.i - b.i;
      })
      .map((r) => r.el);
  }

  // "Y-axis for a discrete scale with 17 values: Welding, Panels, ..."
  function declaredRowCount(yAxis) {
    const src = yAxis && (yAxis.getAttribute('aria-label') || '');
    const m = /with (\d+) value/.exec(src || '');
    return m ? parseInt(m[1], 10) : 0;
  }

  /* ================================================================== *
   * In-progress serial numbers (read from a table elsewhere on the page)
   * ================================================================== */

  // Airtable renders these tables with react-virtualized, so rows scrolled out
  // of view simply aren't in the DOM — and the whole element may be unmounted
  // while the chart is on screen. A partial read would wrongly blank a
  // workstation, so only a complete read replaces what we know.
  let serialCache = new Map();

  const EMPTY_CELL = /^[\s\u2013\u2014-]*$/; // "", "-", en/em dash

  function findTable(label) {
    for (const el of document.querySelectorAll('[data-elementtype="levels"]')) {
      const l = el.querySelector('[data-testid="page-element-label"]');
      if (l && l.textContent.trim() === label) return el;
    }
    return null;
  }

  // Column header title -> aria-colindex, so reordering columns can't break us.
  function columnIndex(box) {
    const map = new Map();
    box.querySelectorAll('[role="columnheader"][aria-colindex]').forEach((h) => {
      const span = h.querySelector('[title]');
      const name = (span && span.getAttribute('title') || h.textContent).trim();
      if (name && !map.has(name)) map.set(name, h.getAttribute('aria-colindex'));
    });
    return map;
  }

  function readSerials() {
    if (!SERIAL_OVERLAY) return serialCache;

    const box = findTable(SERIAL_TABLE);
    if (!box) return serialCache; // element not mounted: keep what we had

    const grid = box.querySelector('[role="treegrid"], [role="grid"]');
    const declared = grid ? parseInt(grid.getAttribute('aria-rowcount') || '0', 10) : 0;
    const rows = [...box.querySelectorAll('[role="row"][aria-rowindex]')];

    // A short read means rows are virtualised away. An empty table is only
    // believable when it says it has no rows.
    if (declared && rows.length < declared) return serialCache;
    if (!declared && !rows.length) return serialCache;

    const cols = columnIndex(box);
    const cellEl = (row, name, fallback) => {
      const idx = cols.get(name) || fallback;
      return (idx && row.querySelector(`[aria-colindex="${idx}"]`)) || null;
    };
    const cell = (row, name, fallback) => {
      const c = cellEl(row, name, fallback);
      return c ? c.textContent.trim().replace(/\s+/g, ' ') : '';
    };
    // Checkbox columns carry no text: the state is on the checkbox itself.
    // A green thumb is aria-checked="true"; a white one is "false".
    const checked = (row, name, fallback) => {
      const c = cellEl(row, name, fallback);
      if (!c) return false;
      const box2 = c.querySelector('[role="checkbox"][aria-checked]');
      const on = box2
        ? box2.getAttribute('aria-checked') === 'true'
        : /,\s*checked\s*$/i.test((c.querySelector('[aria-label]') || c)
            .getAttribute('aria-label') || '');
      if (on) rememberIconHref(c);
      return on;
    };

    // One entry per in-progress unit: its serial, its takt time, its on-time flag.
    const found = new Map();
    rows.forEach((row) => {
      const status = cell(row, SERIAL_COLUMNS.status, '1');
      if (SERIAL_STATUSES.length && !SERIAL_STATUSES.includes(status)) return;
      const serial = cell(row, SERIAL_COLUMNS.serial, '2');
      const station = cell(row, SERIAL_COLUMNS.station, '3');
      const takt = cell(row, SERIAL_COLUMNS.takt, '4');
      const onTime = checked(row, SERIAL_COLUMNS.ontime, '5');
      if (!station || EMPTY_CELL.test(station)) return;
      if (!found.has(station)) found.set(station, []);
      const list = found.get(station);
      if (EMPTY_CELL.test(serial) && EMPTY_CELL.test(takt)) return; // nothing on it
      if (list.some((e) => e.serial === serial && e.takt === takt)) return;
      list.push({
        serial: EMPTY_CELL.test(serial) ? '' : serial,
        takt: EMPTY_CELL.test(takt) ? '' : takt,
        onTime,
      });
    });

    if (SERIAL_STYLE.sort) {
      found.forEach((list) => list.sort(
        (a, b) => a.serial.localeCompare(b.serial, undefined, { numeric: true })));
    }

    serialCache = found;
    return serialCache;
  }

  // Serials and takt times are joined in the same order, so the string over a
  // bar and the string after it line up unit for unit.
  const joinField = (list, key) => (list || [])
    .map((e) => e[key])
    .filter(Boolean)
    .join(SERIAL_STYLE.separator);

  const serialText = (list) => joinField(list, 'serial');

  // Airtable's thumbs-up sprite, lifted from the table so the version hash in
  // the URL always matches the one the page is already using.
  let iconHref = null;
  function rememberIconHref(cellNode) {
    if (iconHref) return iconHref;
    const u = cellNode.querySelector('use[href], use[*|href]');
    const h = u && (u.getAttribute('href') || u.getAttribute('xlink:href'));
    if (h && h.indexOf('#') > -1) iconHref = h;
    return iconHref;
  }

  // Per-character fallback for when nothing has been laid out yet.
  function estimateWidth(s) {
    let w = 0;
    for (const ch of s || '') {
      w += ch === ' ' ? 0.28 : (ch === ',' || ch === '.' || ch === '\u2013') ? 0.3 : 0.61;
    }
    return w * SERIAL_STYLE.fontSize;
  }

  // Width of a string in this font. Real measurement when the browser offers
  // it, otherwise a per-character estimate.
  function textWidth(node, s) {
    if (typeof node.getComputedTextLength === 'function') {
      try {
        const w = node.getComputedTextLength();
        if (w) return w;
      } catch (e) { /* not rendered yet */ }
    }
    return estimateWidth(s);
  }

  // Width of the first `chars` characters of the node's own text: where inside
  // a label a given unit's takt time ends.
  function prefixWidth(node, s, chars) {
    if (!chars) return 0;
    if (typeof node.getSubStringLength === 'function' && node.textContent === s) {
      try {
        const w = node.getSubStringLength(0, chars);
        if (w) return w;
      } catch (e) { /* not rendered yet */ }
    }
    return estimateWidth(s.slice(0, chars));
  }

  // x span of each row's striped In-Progress segment(s), in plot coordinates.
  function wipSpans(a) {
    const out = new Map();
    barsIn(a.chartEl).forEach((el) => {
      const { category, series } = parseLabel(el);
      if (!category || el.dataset.tmPlaceholder) return;
      if (isHidden(el, series) || !isYellow(el, series)) return;
      const g = barGeom(el);
      if (!g || !(g.w > 0)) return;
      const s = out.get(category) || { x0: Infinity, x1: -Infinity };
      s.x0 = Math.min(s.x0, g.x);
      s.x1 = Math.max(s.x1, g.x + g.w);
      out.set(category, s);
    });
    return out;
  }

  // Our two drawing layers, always the last children of the plot group so the
  // bars Vega just redrew can't paint over them. Order: plates, then thumbs.
  const OVERLAYS = ['data-tm-serials', 'data-tm-ontime'];
  function overlayLayers(a) {
    const out = {};
    const nodes = OVERLAYS.map((attr) => {
      let g = a.root.querySelector(`:scope > g[${attr}]`);
      if (!g) {
        g = document.createElementNS(SVG_NS, 'g');
        g.setAttribute(attr, '1');
        g.setAttribute('aria-hidden', 'true');
        a.root.appendChild(g);
      }
      return g;
    });
    // Reorder only when they aren't already the final children, in order.
    const tail = [...a.root.children].slice(-nodes.length);
    if (nodes.some((g, i) => tail[i] !== g)) nodes.forEach((g) => a.root.appendChild(g));
    out.serials = nodes[0];
    out.ontime = nodes[1];
    return out;
  }

  // A plate's text is built from one <tspan> per serial (plus one per comma) so
  // a repeat appearance can be coloured on its own without splitting the plate.
  function paintSerials(text, entries, seen) {
    const repeat = REPEAT_SERIAL_COLOR === 'stripe' ? STRIPE.base : REPEAT_SERIAL_COLOR;
    const want = [];
    entries.forEach((e, i) => {
      if (i) want.push({ t: SERIAL_STYLE.separator, fill: SERIAL_STYLE.fill });
      const again = seen.has(e.serial);
      seen.add(e.serial);
      want.push({ t: e.serial, fill: again ? repeat : SERIAL_STYLE.fill });
    });

    const kids = [...text.children];
    want.forEach((seg, i) => {
      let n = kids[i];
      if (!n || n.tagName !== 'tspan') {
        n = document.createElementNS(SVG_NS, 'tspan');
        if (kids[i]) text.replaceChild(n, kids[i]); else text.appendChild(n);
      }
      setText(n, seg.t);
      setAttr(n, 'fill', seg.fill);
    });
    [...text.children].slice(want.length).forEach((n) => n.remove());
    // Any bare text left over from an earlier version of this script.
    [...text.childNodes].forEach((n) => { if (n.nodeType === 3) n.remove(); });

    return want.map((seg) => seg.t).join('');
  }

  // Draws the plates. Returns cat -> right edge, so the totals can dodge them.
  function placeSerials(a, cats, metrics, takts) {
    const edges = new Map();
    if (!SERIAL_OVERLAY || !a.root) return edges;

    const serials = readSerials();
    const spans = wipSpans(a);

    const layer = overlayLayers(a).serials;

    const existing = new Map();
    [...layer.children].forEach((g) => {
      const cat = g.dataset.tmSerialCat;
      if (cat && !existing.has(cat)) existing.set(cat, g); else g.remove();
    });

    const wanted = [];
    const S = SERIAL_STYLE;
    const half = S.fontSize / 2;
    // Serials already seen further up the axis: their next appearance is a
    // repeat. Walked in axis order, so "first" means topmost on the chart.
    const seen = new Set();

    cats.forEach((cat, i) => {
      const span = spans.get(cat);
      const entries = (serials.get(cat) || []).filter((e) => e.serial);
      const label = serialText(serials.get(cat));
      if (!span || !label) {
        // Still count them: a station whose stripe isn't drawn yet shouldn't
        // make the station below it look like the first appearance.
        entries.forEach((e) => seen.add(e.serial));
        return;
      }

      let g = existing.get(cat);
      let rect, text;
      if (!g) {
        g = document.createElementNS(SVG_NS, 'g');
        g.dataset.tmSerialCat = cat;
        rect = document.createElementNS(SVG_NS, 'rect');
        text = document.createElementNS(SVG_NS, 'text');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-size', `${S.fontSize}px`);
        text.setAttribute('fill', S.fill);
        const tpl = a.totals && a.totals.querySelector('text');
        const family = tpl && tpl.getAttribute('font-family');
        if (family) text.setAttribute('font-family', family);
        rect.setAttribute('fill', S.bg);
        rect.setAttribute('fill-opacity', String(S.bgOpacity));
        rect.setAttribute('rx', String(S.radius));
        g.appendChild(rect);
        g.appendChild(text);
        layer.appendChild(g);
      } else {
        rect = g.querySelector('rect');
        text = g.querySelector('text');
      }

      const shown = paintSerials(text, entries, seen);
      const w = textWidth(text, shown);
      const centre = metrics.top + i * metrics.step + metrics.height / 2;

      // Centred on the striped segment, then nudged back inside the canvas if
      // the string is wider than the room available.
      let cx = (span.x0 + span.x1) / 2;
      if (S.clamp) {
        const room = w / 2 + S.padX;
        // Hold back the room this row's takt time (and its thumb) will need,
        // so a plate on a long bar slides left off its stripe rather than
        // squatting on the space the number has to occupy.
        const info = takts && takts.get(cat);
        const reserve = info
          ? estimateWidth(info.text) + BAND.valueGap +
            thumbCount(info) * (ONTIME_ICON.gap + ONTIME_ICON.size)
          : 0;
        const maxX = a.svgW - a.outerX - 1 - reserve;
        const minX = S.clampLeftToPlot ? 1 : -a.outerX + 1;
        if (cx + room > maxX) cx = maxX - room;
        if (cx - room < minX) cx = minX + room;
      }

      setAttr(text, 'transform', `translate(${round(cx)},${round(centre + BAND.labelDy)})`);
      setAttr(rect, 'x', round(cx - w / 2 - S.padX));
      setAttr(rect, 'y', round(centre - half - S.padY));
      setAttr(rect, 'width', round(w + S.padX * 2));
      setAttr(rect, 'height', round(S.fontSize + S.padY * 2));

      edges.set(cat, cx + w / 2 + S.padX);
      wanted.push(g);
    });

    [...layer.children].forEach((g) => { if (!wanted.includes(g)) g.remove(); });
    wanted.forEach((g, i) => {
      if (layer.children[i] !== g) layer.insertBefore(g, layer.children[i] || null);
    });

    return edges;
  }

  /* ================================================================== *
   * Geometry
   * ================================================================== */

  function bandMetrics(plotH, n) {
    const step = plotH / (n + BAND.denomPad);
    return { step, height: step * (1 - BAND.innerPad), top: BAND.outerPad * step };
  }

  // Rounded-right-end row shape, matching Airtable's own path style.
  function rowShapePath(w, h) {
    if (!(w > 0) || !(h > 0)) return '';
    const k = 0.551915024494;
    const r = Math.min(BAND.cornerR, w, h / 2);
    const x = round(w - r), cx = round(w - r + r * k);
    const W = round(w), H = round(h);
    const r1 = round(r), ry = round(r - r * k);
    const hb = round(h - r), cyb = round(h - r + r * k);
    return `M0,0L${x},0C${cx},0,${W},${ry},${W},${r1}` +
           `L${W},${hb}C${W},${cyb},${cx},${H},${x},${H}` +
           `L0,${H}C0,${H},0,${H},0,${H}L0,0C0,0,0,0,0,0Z`;
  }

  // Bar path: "M{x},0h{w}v{h}h-{w}Z"
  const BAR_D = /^M(-?[\d.]+),0h(-?[\d.]+)v(-?[\d.]+)h(-?[\d.]+)Z$/;

  function barGeom(el) {
    const m = BAR_D.exec((el.getAttribute('d') || '').trim());
    if (!m) return null;
    return { x: parseFloat(m[1]), w: parseFloat(m[2]), h: parseFloat(m[3]) };
  }

  function setRowHeight(rowG, h) {
    const H = round(h);
    let width = 0;

    barsIn(rowG).forEach((el) => {
      const g = barGeom(el);
      if (!g) return;
      width = Math.max(width, g.x + g.w);
      setAttr(el, 'd', `M${round(g.x)},0h${round(g.w)}v${H}h${round(-g.w)}Z`);
    });

    // Inner placeholder backgrounds: "M0,0h0v{h}h0Z"
    rowG.querySelectorAll('path.background').forEach((p) => {
      const d = (p.getAttribute('d') || '').trim();
      const m = /^M0,0h(-?[\d.]+)v(-?[\d.]+)h(-?[\d.]+)Z$/.exec(d);
      if (m) setAttr(p, 'd', `M0,0h${m[1]}v${H}h${m[3]}Z`);
    });

    // The row's own rounded shape + the matching clipPath.
    const shape = rowShapePath(width, h);
    const own = rowG.querySelector(':scope > path.background');
    if (own && !/^M0,0h/.test((own.getAttribute('d') || '').trim())) {
      setAttr(own, 'd', shape);
    }
    const clipHost = rowG.querySelector('[clip-path]');
    const cid = /url\(#([^)]+)\)/.exec(clipHost && clipHost.getAttribute('clip-path') || '');
    if (cid) {
      const cp = rowG.ownerDocument.getElementById(cid[1]);
      const p = cp && cp.querySelector('path');
      if (p) setAttr(p, 'd', shape);
    }
  }

  /* ================================================================== *
   * Placeholder rows (workstations Airtable returned no data for)
   * ================================================================== */

  function makePlaceholderRow(category, height) {
    const el = (tag, attrs) => {
      const n = document.createElementNS(SVG_NS, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      return n;
    };
    const H = round(height);

    const row = el('g', { transform: 'translate(0,0)' });
    row.dataset.tmPlaceholder = '1';
    row.dataset.tmCategory = category;
    row.appendChild(el('path', { class: 'background', 'aria-hidden': 'true', d: '' }));

    const wrap = el('g', {});
    const scope = el('g', {
      class: 'mark-group role-scope',
      role: 'graphics-object',
      'aria-roledescription': 'group mark container',
    });
    const inner = el('g', { transform: 'translate(0,0)' });
    inner.appendChild(el('path', { class: 'background', 'aria-hidden': 'true', d: `M0,0h0v${H}h0Z` }));

    const holder = el('g', {});
    const marks = el('g', {
      class: 'mark-rect role-mark layer_0_marks',
      role: 'graphics-object',
      'aria-roledescription': 'rect mark container',
    });
    marks.appendChild(el('path', {
      'aria-label': `chartPageElementAxisX: ${category}; Status: No data; ` +
                    `Workstation (Color+Sort): ${category}; Number of entries: 0 records`,
      role: 'graphics-symbol',
      'aria-roledescription': 'bar',
      d: `M0,0h0v${H}h0Z`,
      fill: 'transparent',
    }));

    holder.appendChild(marks);
    inner.appendChild(holder);
    scope.appendChild(inner);
    wrap.appendChild(scope);
    row.appendChild(wrap);
    row.appendChild(el('path', { class: 'foreground', 'aria-hidden': 'true', d: '', display: 'none' }));
    return row;
  }

  /* ================================================================== *
   * Fixed y-axis
   * ================================================================== */

  function fixAxis(a, palette) {
    const order = palette.order;
    if (!a.scope || !a.yAxis || !order.length) return;

    const { step, height, top } = bandMetrics(a.plotH, order.length);

    // 1. Rows: reuse, create, position and resize.
    const existing = new Map();
    rowGroups(a).forEach((g) => {
      const cat = rowCategory(g);
      if (cat && !existing.has(cat)) existing.set(cat, g);
    });

    // Workstations the chart has but the palette doesn't list.
    const extras = PALETTE_IS_COMPLETE
      ? []
      : [...existing.keys()].filter((c) => !order.includes(c));
    const full = order.concat(extras);
    const metrics = extras.length ? bandMetrics(a.plotH, full.length) : { step, height, top };

    const desired = full.map((cat) => {
      let g = existing.get(cat);
      if (!g) {
        g = makePlaceholderRow(cat, metrics.height);
        a.scope.appendChild(g);
      } else if (!g.dataset.tmCategory) {
        g.dataset.tmCategory = cat;
      }
      return g;
    });

    // Drop rows the palette doesn't list: stale placeholders (Airtable now has
    // real data for that row) and, when the palette is treated as complete,
    // any workstation it no longer contains.
    rowGroups(a).forEach((g) => {
      if (desired.includes(g)) return;
      if (g.dataset.tmPlaceholder || PALETTE_IS_COMPLETE) g.remove();
    });

    desired.forEach((g, i) => {
      setAttr(g, 'transform', `translate(0,${round(metrics.top + i * metrics.step)})`);
      setRowHeight(g, metrics.height);
      if (a.scope.children[i] !== g) a.scope.insertBefore(g, a.scope.children[i] || null);
    });

    // 2. Axis labels: one per row, same order, cloned for identical styling.
    const texts = [...a.yAxis.querySelectorAll('text')];
    const template = texts[0];
    if (!template) return;
    const xOff = (() => {
      const t = /translate\(\s*(-?[\d.]+)/.exec(template.getAttribute('transform') || '');
      return t ? parseFloat(t[1]) : -16;
    })();
    // Space available for label text before it runs off the left edge.
    const outer = /translate\(\s*(-?[\d.]+)/.exec(
      (a.svg.querySelector(':scope > g') || {}).getAttribute
        ? a.svg.querySelector(':scope > g').getAttribute('transform') || '' : ''
    );
    const avail = (outer ? parseFloat(outer[1]) : 148) + xOff - 2;

    const used = new Set();
    const byText = new Map();
    texts.forEach((t) => {
      const key = stripEllipsis((t.textContent || '').trim());
      if (!byText.has(key)) byText.set(key, t);
    });

    full.forEach((cat, i) => {
      let t = byText.get(cat) || byText.get(stripEllipsis(cat));
      if (!t) {
        for (const [key, node] of byText) {
          if (key && cat.startsWith(key) && !used.has(node)) { t = node; break; }
        }
      }
      if (!t) {
        t = template.cloneNode(true);
        a.yAxis.appendChild(t);
      }
      used.add(t);
      setText(t, fitLabel(t, cat, avail));
      setAttr(t, 'transform',
        `translate(${round(xOff)},${round(metrics.top + i * metrics.step + metrics.height / 2 + BAND.labelDy)})`);
      if (a.yAxis.children[i] !== t) a.yAxis.insertBefore(t, a.yAxis.children[i] || null);
    });

    // Remove any leftover labels beyond the row count.
    [...a.yAxis.querySelectorAll('text')].slice(full.length).forEach((t) => t.remove());

    // 3. Serial-number plates over the striped tips. Drawn before the totals
    //    are placed so a total can be moved clear of its plate.
    const takts = TAKT_TOTALS ? taktByStation() : null;
    const plates = placeSerials(a, full, metrics, takts);

    // 4. Per-bar end labels live outside the rows, so move them too.
    placeTotals(a, full, desired, metrics, takts,
      TOTALS_AT_VISIBLE_END ? visibleEnds(a) : null,
      NUDGE_TOTALS_PAST_SERIALS ? plates : null);

    setAttr(a.yAxis.parentElement.closest('g.mark-group.role-axis') || a.yAxis,
      'aria-label',
      `Y-axis for a discrete scale with ${full.length} values: ${full.join(', ')}`);
  }

  // Station -> { text, units }, from whatever the serial table last told us.
  // `units` keeps each unit's own takt and on-time flag, in the same order as
  // the string, so a thumb can be placed against the right one.
  function taktByStation() {
    const out = new Map();
    readSerials().forEach((list, station) => {
      if (TAKT_EXCLUDE.includes(station)) return; // GOAL: no clock, no thumb
      const units = (list || []).filter((e) => e.takt);
      if (!units.length) return;
      out.set(station, {
        text: units.map((e) => e.takt).join(SERIAL_STYLE.separator),
        units,
      });
    });
    return out;
  }

  // The thumb only means anything when a station has exactly one unit on it.
  // Two units share one takt label, so a single mark can't say which is on
  // time — in that case the row gets no thumb at all.
  function thumbCount(info) {
    if (!ONTIME_ICON.enabled || !info || info.units.length !== 1) return 0;
    return info.units[0].onTime ? 1 : 0;
  }

  // The thumbs-up, sitting just after the station's takt time.
  function placeThumbs(a, cat, labelNode, label, labelX, centre, info) {
    const layer = overlayLayers(a).ontime;
    let g = layer.querySelector(`:scope > g[data-tm-ontime-cat="${cssEscape(cat)}"]`);
    const marks = [];

    if (thumbCount(info)) {
      const w = labelNode ? textWidth(labelNode, label) : estimateWidth(label);
      marks.push(w + ONTIME_ICON.gap);
    }

    if (!marks.length) {
      if (g) g.remove();
      return 0;
    }

    if (!g) {
      g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('data-tm-ontime-cat', cat);
      layer.appendChild(g);
    }

    const kids = [...g.children];
    marks.forEach((dx, i) => {
      let icon = kids[i];
      if (!icon) {
        icon = makeThumb();
        g.appendChild(icon);
      }
      setAttr(icon, 'x', round(labelX + dx));
      setAttr(icon, 'y', round(centre - ONTIME_ICON.size / 2));
    });
    kids.slice(marks.length).forEach((n) => n.remove());

    // Total width this row's thumbs add to the label.
    return marks.length * (ONTIME_ICON.gap + ONTIME_ICON.size);
  }

  // A nested <svg> holding Airtable's own sprite, so it scales cleanly and can
  // be positioned with plain x/y like any other mark.
  function makeThumb() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', ONTIME_ICON.size);
    svg.setAttribute('height', ONTIME_ICON.size);
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('overflow', 'visible');
    const href = iconHref || ONTIME_ICON.href;
    if (href) {
      const use = document.createElementNS(SVG_NS, 'use');
      use.setAttribute('href', href);
      use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', href);
      use.setAttribute('fill', ONTIME_ICON.fill);
      svg.appendChild(use);
    } else {
      const t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('font-size', '13');
      t.setAttribute('y', '13');
      t.textContent = ONTIME_ICON.glyph;
      svg.appendChild(t);
    }
    return svg;
  }

  // Attribute-selector-safe category name.
  const cssEscape = (s) => String(s).replace(/["\\]/g, '\\$&');

  // Drop thumb groups for rows that no longer have any.
  function pruneThumbs(a, keep) {
    const layer = a.root.querySelector(':scope > g[data-tm-ontime]');
    if (!layer) return;
    [...layer.children].forEach((g) => {
      if (!keep.has(g.dataset.tmOntimeCat)) g.remove();
    });
  }

  function placeTotals(a, cats, rows, metrics, takts, ends, plates) {
    const group = a.totals;
    if (!group) return;

    const real = new Map();  // Airtable's own totals
    const mine = new Map();  // end labels this script added itself
    [...group.querySelectorAll('text')].forEach((t) => {
      const cat = parseLabel(t).category;
      if (!cat) return;
      const bucket = t.dataset.tmZero ? mine : real;
      if (!bucket.has(cat)) bucket.set(cat, t);
    });

    const template = group.querySelector('text:not([data-tm-zero])') ||
                     group.querySelector('text');
    const kept = new Set();   // rows whose script-made label is still wanted
    const thumbed = new Set(); // rows carrying an on-time thumb

    cats.forEach((cat, i) => {
      const centre = metrics.top + i * metrics.step + metrics.height / 2;
      const y = round(centre + BAND.valueDy);
      // In takt mode this is the whole content of the label: a station with
      // nothing in progress has no takt clock, so it shows nothing, and the
      // stations in TAKT_EXCLUDE never get one at all.
      const info = takts ? takts.get(cat) : null;
      const takt = takts ? (info ? info.text : '') : null;
      const thumbs = thumbCount(info);
      const reserve = thumbs * (ONTIME_ICON.gap + ONTIME_ICON.size);
      let t = real.get(cat);

      if (!t) {
        // Airtable gave this row no label of its own (a row we invented, or a
        // row with no records). Add one only if there's something to say — an
        // idle station has no takt clock running, so it gets nothing.
        const want = takts ? takt : (ZERO_LABELS ? '0' : '');
        if (!want || !template) { placeThumbs(a, cat, null, '', 0, centre, null); return; }
        t = mine.get(cat);
        if (!t) {
          t = template.cloneNode(true);
          t.dataset.tmZero = '1';
          group.appendChild(t);
        }
        kept.add(cat);
        setAttr(t, 'aria-label',
          `${takts ? 'Takt Time' : 'chartPageElementAxisY_rowCountGroupTotalPerBar'}: ` +
          `${want}; chartPageElementAxisX: ${cat}`);
        setText(t, want);
        setAttr(t, 'transform', `translate(${BAND.valueGap},${y})`);
        if (placeThumbs(a, cat, t, want, BAND.valueGap, centre, info)) thumbed.add(cat);
        return;
      }

      if (takts) {
        setText(t, takt);
        setAttr(t, 'aria-label',
          `Takt Time: ${takt}${thumbs ? ', on time' : ''}; chartPageElementAxisX: ${cat}`);
      }

      // x: just past the last visible segment when we can work that out,
      // otherwise leave Airtable's own offset alone.
      const m = /translate\(\s*(-?[\d.]+)\s*,/.exec(t.getAttribute('transform') || '');
      const end = ends && ends.get(cat);
      let x = end !== undefined && end !== null
        ? end + BAND.valueGap
        : (m ? parseFloat(m[1]) : BAND.valueGap);

      // Keep the label inside the canvas, allowing for its own width plus any
      // thumbs hanging off it — takt strings are several times wider than the
      // counts used to be.
      const maxX = a.svgW - a.outerX - textWidth(t, t.textContent) - reserve - 2;

      // A serial plate centred on the striped tip usually covers this spot.
      // Step out past it, but never so far that the label leaves the canvas.
      const plate = plates && plates.get(cat);
      if (plate !== undefined && plate + BAND.valueGap > x) {
        x = Math.min(plate + BAND.valueGap, Math.max(x, maxX));
      }
      if (x > maxX) x = Math.max(maxX, 0);
      setAttr(t, 'transform', `translate(${round(x)},${y})`);
      if (placeThumbs(a, cat, t, t.textContent, x, centre, info)) thumbed.add(cat);
    });

    pruneThumbs(a, thumbed);

    // Drop labels we made that are no longer wanted (the row has real data of
    // its own now, or there's nothing left to show on it), and any label whose
    // row is no longer on the axis.
    const shown = new Set(cats);
    [...group.querySelectorAll('text')].forEach((t) => {
      const cat = parseLabel(t).category;
      if (!cat) return;
      if (t.dataset.tmZero ? !kept.has(cat) : (PALETTE_IS_COMPLETE && !shown.has(cat))) {
        t.remove();
      }
    });
  }

  // Truncate with an ellipsis only if the text really doesn't fit.
  function fitLabel(textNode, label, avail) {
    if (!(avail > 0) || typeof textNode.getComputedTextLength !== 'function') return label;
    const prev = textNode.textContent;
    setText(textNode, label);
    let len = 0;
    try { len = textNode.getComputedTextLength(); } catch (e) { len = 0; }
    if (!len || len <= avail) { if (textNode.textContent !== prev) { /* keep */ } return label; }
    let s = label;
    while (s.length > 1) {
      s = s.slice(0, -1);
      setText(textNode, s + '\u2026');
      try { if (textNode.getComputedTextLength() <= avail) break; } catch (e) { break; }
    }
    return s + '\u2026';
  }

  /* ================================================================== *
   * Stripe pattern
   * ================================================================== */

  function ensureStripePattern(svg) {
    if (!svg) return null;
    if (svg.querySelector(`#${STRIPE.id}`)) return `url(#${STRIPE.id})`;

    let defs = svg.querySelector('defs');
    if (!defs) {
      defs = document.createElementNS(SVG_NS, 'defs');
      svg.insertBefore(defs, svg.firstChild);
    }
    const pattern = document.createElementNS(SVG_NS, 'pattern');
    pattern.setAttribute('id', STRIPE.id);
    pattern.setAttribute('patternUnits', 'userSpaceOnUse');
    pattern.setAttribute('width', STRIPE.period);
    pattern.setAttribute('height', STRIPE.period);
    pattern.setAttribute('patternTransform', `rotate(${STRIPE.angle})`);

    const bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('width', STRIPE.period);
    bg.setAttribute('height', STRIPE.period);
    bg.setAttribute('fill', STRIPE.base);

    const band = document.createElementNS(SVG_NS, 'rect');
    band.setAttribute('width', STRIPE.width);
    band.setAttribute('height', STRIPE.period);
    band.setAttribute('fill', STRIPE.stripe);

    pattern.appendChild(bg);
    pattern.appendChild(band);
    defs.appendChild(pattern);
    return `url(#${STRIPE.id})`;
  }

  /* ================================================================== *
   * Recolour
   * ================================================================== */

  function isHidden(el, series) {
    return !!series && HIDDEN_SERIES.includes(series);
  }

  function isYellow(el, series) {
    const orig = normFill(originalFill(el));
    return YELLOW_SET.has(orig) || (!!series && YELLOW_SERIES.includes(series));
  }

  function isGreen(el, series) {
    const orig = normFill(originalFill(el));
    if (orig === 'transparent' || orig === 'none') return false;
    return GREEN_SET.has(orig) || (!!series && GREEN_SERIES.includes(series));
  }

  // Right edge of the last segment a viewer can actually see, per row, so the
  // label lands against the bar instead of out past the invisible padding.
  function visibleEnds(a) {
    const out = new Map();
    barsIn(a.chartEl).forEach((el) => {
      const { category, series } = parseLabel(el);
      if (!category || el.dataset.tmPlaceholder) return;
      if (HIDE_PADDING && isHidden(el, series)) return;
      const m = /^M\s*(-?[\d.]+)\s*,\s*-?[\d.]+\s*h\s*(-?[\d.]+)/.exec(el.getAttribute('d') || '');
      if (!m) return;
      const end = parseFloat(m[1]) + parseFloat(m[2]);
      if (!isFinite(end)) return;
      out.set(category, Math.max(out.get(category) || 0, end));
    });
    return out;
  }

  function recolor(a, colors) {
    const stripeFill = STRIPES ? ensureStripePattern(a.svg) : null;

    barsIn(a.chartEl).forEach((el) => {
      const { category, series } = parseLabel(el);
      if (!category) return;
      if (isHidden(el, series)) {
        // fill-opacity rather than fill: the segment keeps its real colour, so
        // it stays hit-testable for hover and Airtable's own logic is unharmed.
        if (HIDE_PADDING) setAttr(el, 'fill-opacity', '0');
        return;
      }

      const orig = normFill(originalFill(el));
      if (orig === 'transparent' || orig === 'none') return; // placeholder row

      if (isYellow(el, series)) {
        if (stripeFill) setAttr(el, 'fill', stripeFill);
        return;
      }
      if (!RECOLOR) return;
      if (!isGreen(el, series)) return;

      const color = colors.get(category);
      if (!color) return;
      setAttr(el, 'fill', color);
    });
  }

  /* ================================================================== *
   * Orchestration
   * ================================================================== */

  let applying = false;

  function apply() {
    if (applying) return;
    const target = anatomy(findChart(TARGET_CHART));
    if (!target) return;

    // Nothing happens to the target chart until the palette has been read.
    const targetCats = rowGroups(target).map(rowCategory).filter(Boolean);
    const p = readPalette(targetCats);
    if (!p) { log('waiting for the Palette chart'); return; }

    applying = true;
    try {
      if (FIX_AXIS) fixAxis(target, p);
      recolor(target, p.colors);
    } catch (e) {
      console.warn('[chart-restyle] failed:', e);
    } finally {
      applying = false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Stay applied across Vega re-renders (resize, filters, data changes)
   * ------------------------------------------------------------------ */

  // A repeat pass over already-correct markup writes nothing, so re-running
  // freely is safe: there is no feedback loop to guard against.
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

  // Any DOM change inside the page — filter changes, data refreshes, Vega
  // re-renders, virtualised elements mounting on scroll — reschedules a pass.
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

  // Poll quickly until the Palette chart has been read and locked in — however
  // long that takes — then fall back to the slow safety net below.
  const boot = setInterval(() => {
    apply();
    if (palette) clearInterval(boot);
  }, 500);

  setInterval(apply, 2000);
  apply();
})();
