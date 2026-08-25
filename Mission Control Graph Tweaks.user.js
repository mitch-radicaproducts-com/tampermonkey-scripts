// ==UserScript==
// @name         Airtable — Restyle "Production Numbers" chart from "Palette" chart
// @namespace    radicaproducts.com
// @version      3.2.0
// @description  Reads the "Palette" chart once per page load — its rows, their order and their colors are the single source of truth — then holds the "Production Numbers" chart to that axis all day: missing workstations become 0 rows, existing bar lengths are never touched, Done segments take their workstation color, and In-Progress tips become diagonal yellow/white stripes.
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
  const ZERO_LABELS = true; // draw a "0" total on rows Airtable returned no data for
  const DONE_ONLY_TOTALS = true; // the number at the end of a bar counts Done only

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
    base: 'rgb(255, 214, 107)', // yellow
    stripe: '#ffffff',          // white
    period: 6,                  // px: one yellow + one white band
    width: 3,                   // px of white per period
    angle: 45,                  // degrees
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

    return { chartEl, svg, root, plotW, plotH, yAxis, scope, totals };
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

    // 3. Per-bar total labels live outside the rows, so move them too.
    placeTotals(a, full, desired, metrics, DONE_ONLY_TOTALS ? doneCounts(a) : null);

    setAttr(a.yAxis.parentElement.closest('g.mark-group.role-axis') || a.yAxis,
      'aria-label',
      `Y-axis for a discrete scale with ${full.length} values: ${full.join(', ')}`);
  }

  const fmtCount = (n) => (Math.round(n * 100) / 100).toString();

  function placeTotals(a, cats, rows, metrics, dones) {
    const group = a.totals;
    if (!group) return;

    const real = new Map();  // Airtable's own totals
    const mine = new Map();  // "0" totals this script added
    [...group.querySelectorAll('text')].forEach((t) => {
      const cat = parseLabel(t).category;
      if (!cat) return;
      const bucket = t.dataset.tmZero ? mine : real;
      if (!bucket.has(cat)) bucket.set(cat, t);
    });

    const template = group.querySelector('text:not([data-tm-zero])') ||
                     group.querySelector('text');
    const empty = new Set();

    cats.forEach((cat, i) => {
      const centre = metrics.top + i * metrics.step + metrics.height / 2;
      const y = round(centre + BAND.valueDy);
      let t = real.get(cat);

      if (!t) {
        empty.add(cat);
        if (!ZERO_LABELS || !template) return;
        t = mine.get(cat);
        if (!t) {
          t = template.cloneNode(true);
          t.dataset.tmZero = '1';
          setAttr(t, 'aria-label',
            `chartPageElementAxisY_rowCountGroupTotalPerBar: 0; chartPageElementAxisX: ${cat}`);
          setText(t, '0');
          group.appendChild(t);
        }
        setAttr(t, 'transform', `translate(${BAND.valueGap},${y})`);
        return;
      }

      const m = /translate\(\s*(-?[\d.]+)\s*,/.exec(t.getAttribute('transform') || '');
      setAttr(t, 'transform', `translate(${round(m ? parseFloat(m[1]) : BAND.valueGap)},${y})`);

      // Airtable's number counts every segment. Show the Done count instead,
      // so an In-Progress tip doesn't inflate it.
      if (dones) {
        const done = fmtCount(dones.get(cat) || 0);
        setText(t, done);
        const aria = t.getAttribute('aria-label') || '';
        setAttr(t, 'aria-label',
          aria.replace(/(GroupTotalPerBar:\s*)[\d.]+/, `$1${done}`));
      }
    });

    // Drop "0" labels for rows that now have real data, and any total whose
    // row is no longer on the axis.
    const shown = new Set(cats);
    [...group.querySelectorAll('text')].forEach((t) => {
      const cat = parseLabel(t).category;
      if (!cat) return;
      if (t.dataset.tmZero ? !empty.has(cat) : (PALETTE_IS_COMPLETE && !shown.has(cat))) {
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

  function isYellow(el, series) {
    const orig = normFill(originalFill(el));
    return YELLOW_SET.has(orig) || (!!series && YELLOW_SERIES.includes(series));
  }

  function isGreen(el, series) {
    const orig = normFill(originalFill(el));
    if (orig === 'transparent' || orig === 'none') return false;
    return GREEN_SET.has(orig) || (!!series && GREEN_SERIES.includes(series));
  }

  // How many Done records each row has, from the bars' own aria-labels.
  function doneCounts(a) {
    const out = new Map();
    barsIn(a.chartEl).forEach((el) => {
      const { category, series, count } = parseLabel(el);
      if (!category || el.dataset.tmPlaceholder) return;
      if (!isGreen(el, series) || isYellow(el, series)) return;
      out.set(category, (out.get(category) || 0) + (count || 0));
    });
    return out;
  }

  function recolor(a, colors) {
    const stripeFill = STRIPES ? ensureStripePattern(a.svg) : null;

    barsIn(a.chartEl).forEach((el) => {
      const { category, series } = parseLabel(el);
      if (!category) return;
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
