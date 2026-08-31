// ==UserScript==
// @name         Mission Control Chart - Layer 2.1 - Recolor Bars
// @namespace    radicaproducts.com
// @version      1.0.0
// @description  Recolors the Production Numbers chart from the frozen "Tampermonkey: Mission Control Recolor Palette" chart (Done = solid, In-Progress = 55deg white stripes) guarantees the chart always shows one row per palette workstation (synthesizing zero-value rows for stations with no data yet), and makes Hidden-status rows invisible while leaving them in the DOM.
// @author       Mitch
// @match        https://airtable.com/*
// @match        https://*.airtable.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 ------------------------------------------------------------------------------
 LAYER MODEL
 ------------------------------------------------------------------------------
 Layer 1 (installed separately, v1.1.0) builds the addressable cell grid over
 the main chart: figure[data-tm-grid] / g[data-tm-row] / g[data-tm-cell="A01"],
 each cell owning a paint <rect> and an overlay <text>. Layer 2 never writes
 into that overlay. It only edits what Vega itself drew — bar fills and row
 geometry — so Layer 1 can keep deriving its grid from the DOM.

 WHAT LAYER 2 DOES
 1. Freezes the palette once at load (it never refreshes): workstation -> color,
    plus the palette's row order, which is the authoritative sort order.
 2. Guarantees row parity with the palette:
      - palette row with no data in the main chart -> a real row is INSERTED at
        its palette position with a zero-length bar, so Monday mornings still
        show every station sitting at 0;
      - row in the main chart that the palette has never heard of -> painted
        with STRIPE.base and reported in a badge + console (only Airtable can
        fix that one).
    Inserting rows re-lays-out the chart inside its existing height: band step,
    bar heights, row clips and Y-axis label positions are all recomputed from
    Vega's own scale math, so 8 rows of data and 16 rows of data both fit.
 3. Hides rows whose records carry a Hidden status (CONFIG.HIDDEN_STATUSES,
    or force-hide by name with CONFIG.HIDE_ROWS). Hidden rows still exist in
    the DOM with their geometry intact — they just get visibility:hidden,
    pointer-events:none and aria-hidden, are excluded from the band layout so
    no gap is left behind, and are never synthesized as zero rows. Remove the
    Hidden status and they reappear on the next pass.
 4. Recolors live: Done = solid workstation color, In-Progress = striped
    workstation color. Reapplied after every Vega redraw, all day.

 CONSOLE API
   TM_LAYER2.audit()    -> parity report
   TM_LAYER2.rows()     -> current row layout (name, y, synthetic?)
   TM_LAYER2.hidden()   -> rows hidden but still present in the DOM
   TM_LAYER2.palette()  -> frozen palette snapshot
   TM_LAYER2.apply()    -> force a reflow + recolor pass
   TM_LAYER2.revert()   -> undo everything this script did
   TM_LAYER2.config     -> live-tweakable settings
 ------------------------------------------------------------------------------
*/

(function () {
    'use strict';

    // ------------------------------------------------------------------ config
    // In-Progress hatch. One pattern is generated per workstation from this.
    const STRIPE = {
        id: 'tm-inprogress-stripes',
        base: '#000000',            // fallback when a station has no palette colour
        stripe: '#ffffff',          // white
        period: 6,                  // px: one coloured + one white band
        width: 2,                   // px of white per period
        angle: 55                   // degrees
    };

    const CONFIG = {
        // Chart identification
        MAIN_TITLE_MATCH: /production\s*numbers/i,
        PALETTE_TITLE_MATCH: /recolor\s*palette/i,

        // Status handling (compared case/space-insensitively)
        SOLID_STATUSES: ['Done'],
        STRIPED_STATUSES: ['In-Progress', 'In Progress', 'WIP'],
        IGNORED_STATUSES: ['Empty'],          // never painted, never warned about
        HIDDEN_STATUSES: ['Hidden'],          // made invisible, but kept in the DOM

        // 'row'     -> a station whose only data is Hidden drops out of the layout
        //              entirely (no band, no zero row, label hidden too)
        // 'segment' -> only the Hidden bar disappears; the row keeps its slot
        HIDE_MODE: 'row',
        HIDE_ROWS: [],                        // force-hide by name, e.g. ['Install']

        STRIPE,

        // Row parity
        SYNTHESIZE_MISSING_ROWS: true,        // palette row with no data -> zero row
        ENFORCE_PALETTE_ORDER: true,          // palette order is the sort order
        BAND_PADDING_INNER: 0.2,              // only used if it can't be measured
        BAND_PADDING_OUTER: 0.2,
        CORNER_RADIUS_FALLBACK: 4,

        // Rows the palette has no color for: 'base' | 'flag' | 'keep'
        UNKNOWN_ROW_MODE: 'base',
        UNKNOWN_ROW_FLAG_COLOR: 'rgb(255, 0, 200)',

        SHOW_BADGE: true,                     // red badge for palette gaps

        // Reconcile cadence
        DEBOUNCE_MS: 60,
        POLL_MS: 2000,

        DEBUG: false
    };

    const TAG = '[TM Layer 2]';
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const BEZIER_K = 0.5519150244935106;      // Vega's circular-arc constant
    const log = (...a) => CONFIG.DEBUG && console.log(TAG, ...a);
    const warn = (...a) => console.warn(TAG, ...a);

    // ------------------------------------------------------------------ helpers
    function normKey(s) {
        return String(s == null ? '' : s)
            .replace(/[\u2010-\u2015\u2212]/g, '-')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    const slug = s => normKey(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
    const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
    const median = a => {
        if (!a.length) return NaN;
        const s = a.slice().sort((x, y) => x - y);
        const m = s.length >> 1;
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };

    function figureTitle(fig) {
        const h2 = fig.querySelector('h2');
        return (fig.getAttribute('aria-label') || '').trim() || (h2 ? h2.textContent.trim() : '');
    }

    const allFigures = () => Array.from(document.querySelectorAll('div[role="figure"]'));

    function findMainChart() {
        return document.querySelector('div[role="figure"][data-tm-grid="1"]') ||
               allFigures().find(f => CONFIG.MAIN_TITLE_MATCH.test(figureTitle(f))) || null;
    }
    const findPaletteChart = () =>
        allFigures().find(f => CONFIG.PALETTE_TITLE_MATCH.test(figureTitle(f))) || null;

    const barsIn = el => el ? Array.from(el.querySelectorAll('path[aria-roledescription="bar"]')) : [];
    const mainSvg = fig => fig ? fig.querySelector('svg.marks') : null;

    // Vega packs everything we need into each bar's aria-label.
    function readBar(path) {
        const label = path.getAttribute('aria-label') || '';
        const pick = re => { const m = re.exec(label); return m ? m[1].trim() : ''; };
        return {
            row: pick(/Workstation\s*\(Color\+Sort\)\s*:\s*([^;]+)/i) ||
                 pick(/chartPageElementAxisX\s*:\s*([^;]+)/i),
            status: pick(/(?:^|;)\s*Status\s*:\s*([^;]+)/i)
        };
    }

    const translateY = t => { const m = /translate\(\s*(-?[\d.]+)[ ,]\s*(-?[\d.]+)/.exec(t || ''); return m ? num(m[2]) : 0; };
    const translateX = t => { const m = /translate\(\s*(-?[\d.]+)/.exec(t || ''); return m ? num(m[1]) : 0; };

    // --- original-value bookkeeping ------------------------------------------
    // Vega updates its own DOM in place, so "what did this look like before we
    // touched it" has to be re-derived whenever Vega writes a value we didn't.
    function origY(el) {
        const cur = translateY(el.getAttribute('transform'));
        const applied = el.getAttribute('data-tm2-applied-y');
        if (applied !== null && Math.abs(num(applied) - cur) < 1e-6 && el.hasAttribute('data-tm2-orig-y')) {
            return num(el.getAttribute('data-tm2-orig-y'));
        }
        el.setAttribute('data-tm2-orig-y', String(cur));
        el.removeAttribute('data-tm2-applied-y');
        return cur;
    }

    function setY(el, x, y) {
        const t = `translate(${x},${y})`;
        if ((el.getAttribute('transform') || '') !== t) el.setAttribute('transform', t);
        el.setAttribute('data-tm2-applied-y', String(y));
    }

    function origD(el) {
        const cur = el.getAttribute('d') || '';
        const applied = el.getAttribute('data-tm2-applied-d');
        if (applied !== null && applied === cur && el.hasAttribute('data-tm2-orig-d')) {
            return el.getAttribute('data-tm2-orig-d');
        }
        el.setAttribute('data-tm2-orig-d', cur);
        el.removeAttribute('data-tm2-applied-d');
        return cur;
    }

    function setD(el, d) {
        if ((el.getAttribute('d') || '') !== d) el.setAttribute('d', d);
        el.setAttribute('data-tm2-applied-d', d);
    }

    // --- path geometry -------------------------------------------------------
    const SQUARE_RE = /^M(-?[\d.]+),(-?[\d.]+)h(-?[\d.]+)v(-?[\d.]+)h(-?[\d.]+)Z$/i;

    function squareRectWithHeight(d, h) {
        const m = SQUARE_RE.exec(d.trim());
        if (!m) return null;
        const x = num(m[1]), y = num(m[2]), w = num(m[3]);
        return `M${x},${y}h${w}v${h}h${-w}Z`;
    }

    // Rounded-on-the-right rect, byte-compatible with Vega's own output.
    function roundedRightRect(w, h, r) {
        r = Math.max(0, Math.min(r, h / 2, w));
        if (!r) return `M0,0h${w}v${h}h${-w}Z`;
        const c = r * BEZIER_K;
        return `M0,0L${w - r},0C${w - r + c},0,${w},${r - c},${w},${r}` +
               `L${w},${h - r}C${w},${h - r + c},${w - r + c},${h},${w - r},${h}` +
               `L0,${h}C0,${h},0,${h},0,${h}L0,0C0,0,0,0,0,0Z`;
    }

    function measurePath(d) {
        let w = 0, h = 0;
        const re = /(-?[\d.]+),(-?[\d.]+)/g;
        let m;
        while ((m = re.exec(d))) { w = Math.max(w, num(m[1])); h = Math.max(h, num(m[2])); }
        const rm = /^M0,0L(-?[\d.]+),0C/.exec(d);
        const r = rm ? Math.max(0, w - num(rm[1])) : 0;
        return { w, h, r };
    }

    // ------------------------------------------------------- frozen palette data
    let PALETTE = null;

    function capturePalette() {
        if (PALETTE) return PALETTE;
        const fig = findPaletteChart();
        if (!fig) return null;
        const bars = barsIn(fig);
        if (!bars.length) return null;

        const colors = new Map();
        bars.forEach(p => {
            const { row } = readBar(p);
            const fill = (p.getAttribute('fill') || '').trim();
            if (!row || !fill || /^(none|transparent)$/i.test(fill)) return;
            const k = normKey(row);
            if (!colors.has(k)) colors.set(k, { name: row, color: fill });
        });
        if (!colors.size) return null;

        const order = rowLabelNames(fig);
        // Palette rows drawn but not labelled, and labelled but not drawn.
        colors.forEach(v => { if (!order.some(n => normKey(n) === normKey(v.name))) order.push(v.name); });
        const colorless = order.filter(n => !colors.has(normKey(n)));

        PALETTE = Object.freeze({
            order: Object.freeze(order.slice()),
            colors,
            colorless: Object.freeze(colorless),
            capturedAt: new Date().toISOString()
        });
        console.info(`${TAG} palette frozen — ${colors.size} colors, ${order.length} rows @ ${PALETTE.capturedAt}`);
        if (colorless.length) warn('palette rows with no color bar:', colorless);
        return PALETTE;
    }

    const colorFor = name => {
        const hit = PALETTE && PALETTE.colors.get(normKey(name));
        return hit ? hit.color : null;
    };

    // ------------------------------------------------------------- chart anatomy
    function yAxisGroup(fig) {
        const svg = mainSvg(fig);
        if (!svg) return null;
        return Array.from(svg.querySelectorAll('g.mark-group.role-axis[aria-label]'))
            .find(g => /^Y-axis/i.test(g.getAttribute('aria-label') || '')) || null;
    }

    function rowLabelNodes(fig) {
        const axis = yAxisGroup(fig);
        if (!axis) return [];
        return Array.from(axis.querySelectorAll('g.mark-text.role-axis-label text'));
    }

    function rowLabelNames(fig) {
        return rowLabelNodes(fig)
            .map(t => ({ name: (t.textContent || '').trim(), y: translateY(t.getAttribute('transform')) }))
            .filter(o => o.name)
            .sort((a, b) => a.y - b.y)
            .map(o => o.name);
    }

    // The facets container is the shallowest role-scope group in the chart.
    function facetsContainer(svg) {
        const scopes = Array.from(svg.querySelectorAll('g.mark-group.role-scope'));
        if (!scopes.length) return null;
        let best = null, bestDepth = Infinity;
        scopes.forEach(s => {
            let d = 0, n = s;
            while (n && n !== svg) { d++; n = n.parentNode; }
            if (d < bestDepth) { bestDepth = d; best = s; }
        });
        return best;
    }

    function facetNodes(svg) {
        const cont = facetsContainer(svg);
        if (!cont) return { cont: null, facets: [] };
        const facets = Array.from(cont.children).filter(
            el => el.tagName.toLowerCase() === 'g' && el.hasAttribute('transform')
        );
        return { cont, facets };
    }

    // Plot height: prefer the Y-axis domain rule, fall back to the frame path.
    function plotHeight(svg) {
        const axis = Array.from(svg.querySelectorAll('g.mark-group.role-axis[aria-label]'))
            .find(g => /^Y-axis/i.test(g.getAttribute('aria-label') || ''));
        const rule = axis && axis.querySelector('g.mark-rule.role-axis-domain line');
        if (rule) { const h = Math.abs(num(rule.getAttribute('y2'))); if (h > 1) return h; }
        const frame = svg.querySelector('g.mark-group.role-frame.root > g > path.background');
        if (frame) { const h = measurePath(frame.getAttribute('d') || '').h; if (h > 1) return h; }
        return 0;
    }

    // ------------------------------------------------------------------- reflow
    let lastRowSignature = null;
    let LAYOUT = [];
    let HIDDEN = [];      // rows present in the DOM but deliberately invisible

    function reflow() {
        const fig = findMainChart();
        const svg = mainSvg(fig);
        const pal = PALETTE;
        if (!fig || !svg || !pal) return null;

        const { cont, facets } = facetNodes(svg);
        if (!cont) return null;

        const H = plotHeight(svg);
        if (!H) return null;

        // 1. Split real Vega facets from rows we synthesized on a previous pass.
        const real = [], stale = [];
        facets.forEach(f => {
            if (f.hasAttribute('data-tm2-synthetic')) { stale.push(f); return; }
            const bar = f.querySelector('path[aria-roledescription="bar"]');
            const name = bar ? readBar(bar).row : '';
            real.push({ node: f, name, y: origY(f), bar });
        });

        // 1b. Decide which stations are hidden. A row goes dark when it is listed
        //     in HIDE_ROWS, or (in 'row' mode) when every record it has is Hidden.
        const forcedHide = setOf(CONFIG.HIDE_ROWS || []);
        const hiddenKeys = new Set();
        const hiddenNames = [];
        const markHidden = name => {
            const k = normKey(name);
            if (!k || hiddenKeys.has(k)) return;
            hiddenKeys.add(k);
            hiddenNames.push(name);
        };
        real.forEach(r => {
            const c = facetStatusCounts(r.node);
            r.hidden = !!r.name && (
                forcedHide.has(normKey(r.name)) ||
                (CONFIG.HIDE_MODE === 'row' && c.hidden > 0 && c.visible === 0)
            );
            if (r.hidden) markHidden(r.name);
        });

        // Facets Vega drew with no bars at all get named by nearest axis label.
        const labels = rowLabelNodes(fig).map(t => ({
            node: t, name: (t.textContent || '').trim(),
            y: origY(t), x: translateX(t.getAttribute('transform'))
        }));

        // 2. Measure Vega's own band scale from the untouched values.
        const ys = real.map(r => r.y).sort((a, b) => a - b);
        const diffs = [];
        for (let i = 1; i < ys.length; i++) diffs.push(ys[i] - ys[i - 1]);
        const oldStep = diffs.length ? median(diffs) : NaN;

        let oldBw = NaN;
        for (const r of real) {
            if (!r.bar) continue;
            const m = SQUARE_RE.exec(origD(r.bar).trim());
            if (m) { oldBw = Math.abs(num(m[4])); break; }
        }
        if (!Number.isFinite(oldBw) && Number.isFinite(oldStep)) {
            oldBw = oldStep * (1 - CONFIG.BAND_PADDING_INNER);
        }

        const pi = (Number.isFinite(oldStep) && Number.isFinite(oldBw) && oldStep > 0)
            ? Math.min(0.9, Math.max(0, 1 - oldBw / oldStep))
            : CONFIG.BAND_PADDING_INNER;
        const po = (Number.isFinite(oldStep) && oldStep > 0 && ys.length)
            ? Math.min(1, Math.max(0, ys[0] / oldStep))
            : CONFIG.BAND_PADDING_OUTER;

        // Label baseline offset (Vega bakes the text baseline into the y).
        const deltas = [];
        real.forEach(r => {
            const l = labels.find(l => l.name && normKey(l.name) === normKey(r.name));
            if (l && Number.isFinite(oldBw)) deltas.push(l.y - (r.y + oldBw / 2));
        });
        const labelDelta = deltas.length ? median(deltas) : 0;

        // 3. Target row order: palette order first, then anything the palette
        //    doesn't know about (those can only be fixed in Airtable).
        const byName = new Map();
        real.forEach(r => { if (r.name) byName.set(normKey(r.name), r); });

        const order = [];
        const used = new Set();
        const paletteOrder = CONFIG.ENFORCE_PALETTE_ORDER
            ? pal.order
            : pal.order.slice().sort((a, b) => {
                const ra = byName.get(normKey(a)), rb = byName.get(normKey(b));
                return (ra ? ra.y : Infinity) - (rb ? rb.y : Infinity);
            });

        paletteOrder.forEach(name => {
            const k = normKey(name);
            const hit = byName.get(k);
            if (hit && hit.hidden) { used.add(k); return; }     // in the DOM, out of sight
            if (!hit && forcedHide.has(k)) { markHidden(name); return; }  // never conjure a hidden row
            if (hit) { used.add(k); order.push({ name: hit.name, real: hit, synthetic: false }); }
            else if (CONFIG.SYNTHESIZE_MISSING_ROWS) order.push({ name, real: null, synthetic: true });
        });
        real.forEach(r => {
            if (r.hidden) return;
            if (r.name && !used.has(normKey(r.name)) && !pal.colors.has(normKey(r.name))) {
                order.push({ name: r.name, real: r, synthetic: false, orphan: true });
            }
        });

        const n = order.length;
        if (!n) return null;

        // 4. Recompute the band scale for the full row set, same plot height.
        const step = H / (n - pi + 2 * po);
        const bw = step * (1 - pi);
        const yOf = i => po * step + i * step;

        // 5. Place every row.
        order.forEach((row, i) => {
            row.y = yOf(i);
            row.node = row.synthetic ? ensureSyntheticFacet(cont, row.name, bw) : row.real.node;
            setY(row.node, 0, row.y);
            if (!row.synthetic) resizeFacet(svg, row.node, bw);
            else resizeSyntheticFacet(row.node, bw);

            const label = labels.find(l => l.name && normKey(l.name) === normKey(row.name));
            const labelY = row.y + bw / 2 + labelDelta;
            if (label) {
                setY(label.node, label.x, labelY);
                label.node.removeAttribute('data-tm2-orphan-label');
            } else {
                const made = ensureSyntheticLabel(fig, row.name, labels);
                if (made) setY(made, labels.length ? labels[0].x : -16, labelY);
            }
        });

        // 5b. Hide / unhide facets and axis labels. Hidden nodes keep their
        //     geometry so nothing has to be rebuilt if they come back.
        real.forEach(r => setNodeHidden(r.node, !!r.hidden));
        labels.forEach(l => setNodeHidden(l.node, hiddenKeys.has(normKey(l.name))));
        HIDDEN = hiddenNames.slice();

        // 6. Drop synthetic rows/labels that are no longer needed.
        const keep = new Set(order.filter(r => r.synthetic).map(r => normKey(r.name)));
        stale.forEach(f => { if (!keep.has(normKey(f.getAttribute('data-tm2-row') || ''))) f.remove(); });
        Array.from(mainSvg(fig).querySelectorAll('text[data-tm2-synthetic-label]')).forEach(t => {
            if (!keep.has(normKey(t.getAttribute('data-tm2-row') || ''))) t.remove();
        });

        LAYOUT = order.map(r => ({
            name: r.name, y: +r.y.toFixed(3), band: +bw.toFixed(3),
            synthetic: !!r.synthetic, orphan: !!r.orphan
        }));

        const sig = JSON.stringify([LAYOUT.map(r => [r.name, r.synthetic]), HIDDEN]);
        if (sig !== lastRowSignature) {
            lastRowSignature = sig;
            const made = LAYOUT.filter(r => r.synthetic).map(r => r.name);
            console.info(
                `${TAG} layout — ${n} rows @ step ${step.toFixed(2)}px / band ${bw.toFixed(2)}px` +
                (made.length ? `; zero rows created: ${made.join(', ')}` : '; no zero rows needed') +
                (HIDDEN.length ? `; hidden (still in DOM): ${HIDDEN.join(', ')}` : '')
            );
        }
        return { n, step, bw, hidden: HIDDEN.length };
    }

    // Rewrite a real Vega facet to the new band height: bars, inner background
    // and the rounded clip that gives the row its shape.
    function resizeFacet(svg, facet, bw) {
        facet.querySelectorAll('path').forEach(p => {
            const d = origD(p);
            const sq = squareRectWithHeight(d, bw);
            if (sq) { setD(p, sq); return; }
            if (/^M0,0L/.test(d)) {
                const g = measurePath(d);
                if (g.w > 0) setD(p, roundedRightRect(g.w, bw, g.r || CONFIG.CORNER_RADIUS_FALLBACK));
            }
        });
        const clipped = facet.querySelector('[clip-path]');
        const ref = clipped && /url\(#([^)]+)\)/.exec(clipped.getAttribute('clip-path') || '');
        if (!ref) return;
        // Look the clip up by id, not tag name — SVG selectors are case-sensitive.
        const holder = svg.querySelector(`[id="${cssEscapeAttr(ref[1])}"]`);
        const clipPath = holder && holder.querySelector('path');
        if (!clipPath) return;
        const d = origD(clipPath);
        const g = measurePath(d);
        if (g.w > 0) setD(clipPath, roundedRightRect(g.w, bw, g.r || CONFIG.CORNER_RADIUS_FALLBACK));
    }

    // A synthetic row mirrors Vega's facet shape so Layer 1 can discover it,
    // but its bar has zero length — the station is simply at 0.
    function ensureSyntheticFacet(cont, name, bw) {
        let g = cont.querySelector(`g[data-tm2-synthetic][data-tm2-row="${cssEscapeAttr(name)}"]`);
        if (g) return g;

        g = document.createElementNS(SVG_NS, 'g');
        g.setAttribute('data-tm2-synthetic', '1');
        g.setAttribute('data-tm2-row', name);

        const bg = document.createElementNS(SVG_NS, 'path');
        bg.setAttribute('aria-hidden', 'true');
        bg.setAttribute('class', 'background');
        g.appendChild(bg);

        const scope = document.createElementNS(SVG_NS, 'g');
        scope.setAttribute('class', 'mark-group role-scope');
        scope.setAttribute('role', 'graphics-object');
        scope.setAttribute('aria-roledescription', 'group mark container');

        const inner = document.createElementNS(SVG_NS, 'g');
        inner.setAttribute('transform', 'translate(0,0)');

        const innerBg = document.createElementNS(SVG_NS, 'path');
        innerBg.setAttribute('aria-hidden', 'true');
        innerBg.setAttribute('class', 'background');
        inner.appendChild(innerBg);

        const wrap = document.createElementNS(SVG_NS, 'g');
        const marks = document.createElementNS(SVG_NS, 'g');
        marks.setAttribute('class', 'mark-rect role-mark layer_0_marks');
        marks.setAttribute('role', 'graphics-object');
        marks.setAttribute('aria-roledescription', 'rect mark container');

        const bar = document.createElementNS(SVG_NS, 'path');
        bar.setAttribute('aria-roledescription', 'bar');
        bar.setAttribute('role', 'graphics-symbol');
        bar.setAttribute('data-tm2-synthetic-bar', '1');
        bar.setAttribute('aria-label',
            `Distinct of chartPageElementAxisY_rowCount: 0; chartPageElementAxisX: ${name}; ` +
            `Status: Empty; groupByOrder: 1; Workstation (Color+Sort): ${name}; ` +
            `Number of entries: 0 records; Total: 0 records`);
        bar.setAttribute('fill', colorFor(name) || CONFIG.STRIPE.base);

        marks.appendChild(bar);
        wrap.appendChild(marks);
        inner.appendChild(wrap);
        scope.appendChild(inner);
        g.appendChild(scope);
        cont.appendChild(g);
        resizeSyntheticFacet(g, bw);
        return g;
    }

    function resizeSyntheticFacet(g, bw) {
        const d = `M0,0h0v${bw}h0Z`;
        g.querySelectorAll('path').forEach(p => setD(p, d));
    }

    function ensureSyntheticLabel(fig, name, labels) {
        const axis = yAxisGroup(fig);
        if (!axis) return null;
        const group = axis.querySelector('g.mark-text.role-axis-label');
        if (!group) return null;

        let t = group.querySelector(`text[data-tm2-synthetic-label][data-tm2-row="${cssEscapeAttr(name)}"]`);
        if (t) return t;

        const template = labels.length ? labels[0].node : group.querySelector('text');
        if (template) {
            t = template.cloneNode(false);
            ['data-tm2-orig-y', 'data-tm2-applied-y', 'data-tm2-orig-d', 'data-tm2-applied-d']
                .forEach(a => t.removeAttribute(a));
        } else {
            t = document.createElementNS(SVG_NS, 'text');
            t.setAttribute('fill', 'var(--colors-foreground-subtler)');
            t.setAttribute('font-size', '12px');
            t.setAttribute('text-anchor', 'end');
            t.setAttribute('opacity', '1');
        }
        t.textContent = name;
        t.setAttribute('data-tm2-synthetic-label', '1');
        t.setAttribute('data-tm2-row', name);
        group.appendChild(t);
        return t;
    }

    const cssEscapeAttr = s => String(s).replace(/["\\]/g, '\\$&');

    // ------------------------------------------------------------------ hiding
    // Invisible but still in the DOM: no ink, no hit-testing, no screen-reader
    // noise, geometry and attributes left intact so it can come back later.
    function setNodeHidden(el, on) {
        if (!el) return;
        if (on) {
            if (el.getAttribute('data-tm2-hidden') === '1') return;
            el.setAttribute('data-tm2-hidden', '1');
            el.setAttribute('data-tm2-orig-style', el.getAttribute('style') || '');
            el.setAttribute('data-tm2-orig-aria', el.getAttribute('aria-hidden') || '');
            el.setAttribute('style',
                `${el.getAttribute('style') || ''};visibility:hidden;pointer-events:none`.replace(/^;/, ''));
            el.setAttribute('aria-hidden', 'true');
        } else if (el.hasAttribute('data-tm2-hidden')) {
            const s = el.getAttribute('data-tm2-orig-style');
            if (s) el.setAttribute('style', s); else el.removeAttribute('style');
            const a = el.getAttribute('data-tm2-orig-aria');
            if (a) el.setAttribute('aria-hidden', a); else el.removeAttribute('aria-hidden');
            el.removeAttribute('data-tm2-orig-style');
            el.removeAttribute('data-tm2-orig-aria');
            el.removeAttribute('data-tm2-hidden');
        }
    }

    // What a facet's bars say about it: how many are hidden vs actually showing.
    function facetStatusCounts(facet) {
        const HID = setOf(CONFIG.HIDDEN_STATUSES);
        const IGN = setOf(CONFIG.IGNORED_STATUSES);
        let hidden = 0, visible = 0;
        Array.from(facet.querySelectorAll('path[aria-roledescription="bar"]')).forEach(b => {
            const sk = normKey(readBar(b).status);
            if (HID.has(sk)) hidden++;
            else if (!IGN.has(sk) && !b.hasAttribute('data-tm2-synthetic-bar')) visible++;
        });
        return { hidden, visible };
    }

    // -------------------------------------------------------------- stripe defs
    function ensureDefs(svg) {
        let defs = svg.querySelector('defs[data-tm2-defs="1"]');
        if (!defs || !svg.contains(defs)) {
            defs = document.createElementNS(SVG_NS, 'defs');
            defs.setAttribute('data-tm2-defs', '1');
            svg.appendChild(defs);
        }
        return defs;
    }

    function stripePatternId(svg, rowName, color) {
        const S = CONFIG.STRIPE;
        const defs = ensureDefs(svg);
        const id = `${S.id}-${slug(rowName)}`;
        const period = Math.max(S.width + 0.5, S.period);
        const sig = [color, period, S.width, S.angle, S.stripe].join('|');

        let pat = defs.querySelector(`pattern[id="${id}"]`);
        if (pat && pat.getAttribute('data-tm2-sig') === sig) return id;
        if (pat) pat.remove();

        pat = document.createElementNS(SVG_NS, 'pattern');
        pat.setAttribute('id', id);
        pat.setAttribute('data-tm2-sig', sig);
        pat.setAttribute('patternUnits', 'userSpaceOnUse');
        pat.setAttribute('patternContentUnits', 'userSpaceOnUse');
        pat.setAttribute('width', String(period));
        pat.setAttribute('height', String(period));
        // Rotation preserves lengths, so the white band stays S.width wide.
        pat.setAttribute('patternTransform', `rotate(${S.angle})`);

        const base = document.createElementNS(SVG_NS, 'rect');
        base.setAttribute('x', '0');
        base.setAttribute('y', '-1');
        base.setAttribute('width', String(period));
        base.setAttribute('height', String(period + 2));   // overdraw hides tile seams
        base.setAttribute('fill', color || S.base);
        pat.appendChild(base);

        const line = document.createElementNS(SVG_NS, 'rect');
        line.setAttribute('x', '0');
        line.setAttribute('y', '-1');
        line.setAttribute('width', String(S.width));
        line.setAttribute('height', String(period + 2));
        line.setAttribute('fill', S.stripe);
        pat.appendChild(line);

        defs.appendChild(pat);
        return id;
    }

    // ------------------------------------------------------------------- audit
    let lastAuditSignature = null;

    function audit() {
        const fig = findMainChart();
        const pal = PALETTE || capturePalette();
        if (!fig || !pal) {
            return { ok: false, ready: false, reason: !fig ? 'main chart not found' : 'palette not captured' };
        }

        const seen = new Set();
        const mainRows = [];
        rowLabelNames(fig).forEach(n => { if (!seen.has(normKey(n))) { seen.add(normKey(n)); mainRows.push(n); } });
        barsIn(mainSvg(fig)).forEach(p => {
            const r = readBar(p).row;
            if (r && !seen.has(normKey(r))) { seen.add(normKey(r)); mainRows.push(r); }
        });

        const palKeys = new Set(pal.order.map(normKey));
        const hiddenKeys = setOf(HIDDEN);
        // Hidden rows are intentional, so they are neither orphans nor gaps.
        const orphans = mainRows.filter(n => !palKeys.has(normKey(n)) && !hiddenKeys.has(normKey(n)));
        const synthesized = LAYOUT.filter(r => r.synthetic).map(r => r.name); // created at zero
        const stillMissing = CONFIG.SYNTHESIZE_MISSING_ROWS
            ? []
            : pal.order.filter(n => !seen.has(normKey(n)) && !hiddenKeys.has(normKey(n)));

        const report = {
            ok: orphans.length === 0 && stillMissing.length === 0 && pal.colorless.length === 0,
            ready: true,
            paletteRowCount: pal.order.length,
            chartRowCount: LAYOUT.length || mainRows.length,
            rowsWithData: LAYOUT.length ? LAYOUT.filter(r => !r.synthetic).length : mainRows.length,
            synthesized,
            orphans,
            stillMissing,
            hidden: HIDDEN.slice(),           // invisible on purpose, still in the DOM
            colorless: pal.colorless.slice(),
            capturedAt: pal.capturedAt
        };

        const sig = JSON.stringify([report.ok, orphans, stillMissing, report.colorless]);
        if (sig !== lastAuditSignature) {
            lastAuditSignature = sig;
            if (report.ok) {
                console.info(`${TAG} row parity OK — ${report.chartRowCount} rows, all backed by the palette.`);
            } else {
                warn('ROW PARITY PROBLEM:',
                    '\n  in chart but NOT in palette (add to palette in Airtable):', orphans.length ? orphans : '(none)',
                    '\n  palette rows still missing from the chart:', stillMissing.length ? stillMissing : '(none)',
                    '\n  palette rows with no color:', report.colorless.length ? report.colorless : '(none)');
            }
        }
        renderBadge(fig, report);
        return report;
    }

    function renderBadge(fig, report) {
        let badge = fig.querySelector('[data-tm2-badge]');
        if (!CONFIG.SHOW_BADGE || report.ok) { if (badge) badge.remove(); return; }

        const parts = [];
        if (report.orphans.length) parts.push(`palette missing: ${report.orphans.join(', ')}`);
        if (report.stillMissing.length) parts.push(`rows missing: ${report.stillMissing.join(', ')}`);
        if (report.colorless.length) parts.push(`no color: ${report.colorless.join(', ')}`);
        const text = `\u26A0 Layer 2 — ${parts.join(' | ')}`;

        if (!badge) {
            badge = document.createElement('div');
            badge.setAttribute('data-tm2-badge', '1');
            badge.style.cssText = [
                'position:absolute', 'top:6px', 'right:8px', 'z-index:9', 'max-width:60%',
                'padding:3px 8px', 'border-radius:10px', 'background:#b3261e', 'color:#fff',
                'font:600 11px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
                'box-shadow:0 1px 3px rgba(0,0,0,.25)', 'pointer-events:none'
            ].join(';');
            fig.appendChild(badge);
        }
        if (badge.textContent !== text) badge.textContent = text;
        badge.title = text;
    }

    // ------------------------------------------------------------------ recolor
    const setOf = arr => new Set(arr.map(normKey));
    const unknownStatusSeen = new Set();
    let applying = false;

    function recolor() {
        const fig = findMainChart();
        const svg = mainSvg(fig);
        if (!svg || !PALETTE) return { ok: false };

        const SOLID = setOf(CONFIG.SOLID_STATUSES);
        const STRIPED = setOf(CONFIG.STRIPED_STATUSES);
        const IGNORE = setOf(CONFIG.IGNORED_STATUSES);

        const HID = setOf(CONFIG.HIDDEN_STATUSES);

        let solid = 0, striped = 0, unmatched = 0, hiddenBars = 0;
        barsIn(svg).forEach(p => {
            const { row, status } = readBar(p);
            const sk = normKey(status);

            if (!p.hasAttribute('data-tm2-orig-fill')) {
                p.setAttribute('data-tm2-orig-fill', p.getAttribute('fill') || '');
            }
            if (row) p.setAttribute('data-tm2-row', row);
            if (status) p.setAttribute('data-tm2-status', status);

            // Hidden records never draw, in either hide mode. The path stays put.
            if (HID.has(sk)) { setNodeHidden(p, true); hiddenBars++; return; }
            setNodeHidden(p, false);

            if (p.hasAttribute('data-tm2-synthetic-bar') || IGNORE.has(sk)) return; // zero-length

            const color = colorFor(row);
            if (!color) {
                unmatched++;
                p.setAttribute('data-tm2-unmatched', '1');
                if (CONFIG.UNKNOWN_ROW_MODE === 'keep') {
                    setFill(p, p.getAttribute('data-tm2-orig-fill'));
                    return;
                }
                const fallback = CONFIG.UNKNOWN_ROW_MODE === 'flag'
                    ? CONFIG.UNKNOWN_ROW_FLAG_COLOR
                    : CONFIG.STRIPE.base;
                setFill(p, STRIPED.has(sk) ? `url(#${stripePatternId(svg, row || '_none', fallback)})` : fallback);
                return;
            }
            p.removeAttribute('data-tm2-unmatched');

            if (STRIPED.has(sk)) {
                setFill(p, `url(#${stripePatternId(svg, row, color)})`);
                striped++;
            } else {
                if (!SOLID.has(sk) && sk && !unknownStatusSeen.has(sk)) {
                    unknownStatusSeen.add(sk);
                    warn(`unmapped status "${status}" — painting solid. Add it to SOLID_STATUSES, STRIPED_STATUSES or IGNORED_STATUSES.`);
                }
                setFill(p, color);
                solid++;
            }
        });

        log(`recolored ${solid} solid, ${striped} striped, ${unmatched} unmatched, ${hiddenBars} hidden`);
        return { ok: true, solid, striped, unmatched, hiddenBars };
    }

    function setFill(el, value) {
        if ((el.getAttribute('fill') || '') !== (value || '')) el.setAttribute('fill', value || '');
    }

    function apply() {
        if (!capturePalette()) return { ok: false, reason: 'palette not captured yet' };
        const fig = findMainChart();
        if (!fig) return { ok: false, reason: 'main chart not found' };
        applying = true;
        let layout = null, paint = null;
        try {
            layout = reflow();
            paint = recolor();
        } finally {
            applying = false;
        }
        audit();
        return { ok: true, rows: layout && layout.n, band: layout && +layout.bw.toFixed(2), paint };
    }

    function revert() {
        const fig = findMainChart();
        const svg = mainSvg(fig);
        if (!svg) return;
        applying = true;
        try {
            svg.querySelectorAll('[data-tm2-hidden]').forEach(el => setNodeHidden(el, false));
            svg.querySelectorAll('g[data-tm2-synthetic]').forEach(g => g.remove());
            svg.querySelectorAll('text[data-tm2-synthetic-label]').forEach(t => t.remove());
            svg.querySelectorAll('defs[data-tm2-defs="1"]').forEach(d => d.remove());

            svg.querySelectorAll('[data-tm2-orig-d]').forEach(el => {
                el.setAttribute('d', el.getAttribute('data-tm2-orig-d'));
            });
            svg.querySelectorAll('[data-tm2-orig-y]').forEach(el => {
                const x = translateX(el.getAttribute('transform'));
                el.setAttribute('transform', `translate(${x},${el.getAttribute('data-tm2-orig-y')})`);
            });
            svg.querySelectorAll('[data-tm2-orig-fill]').forEach(el => {
                el.setAttribute('fill', el.getAttribute('data-tm2-orig-fill'));
            });
            svg.querySelectorAll('*').forEach(el => {
                Array.from(el.attributes)
                    .filter(a => a.name.startsWith('data-tm2-'))
                    .forEach(a => el.removeAttribute(a.name));
            });
            const badge = fig.querySelector('[data-tm2-badge]');
            if (badge) badge.remove();
        } finally {
            applying = false;
        }
        LAYOUT = [];
        HIDDEN = [];
        lastRowSignature = lastAuditSignature = null;
        console.info(`${TAG} reverted.`);
    }

    // ------------------------------------------------------------- reconcile loop
    let timer = null;
    function schedule(why) {
        if (applying || timer) return;
        timer = setTimeout(() => { timer = null; log('reconcile:', why); apply(); }, CONFIG.DEBOUNCE_MS);
    }

    let observer = null, observedFigure = null;
    function observeMain() {
        const fig = findMainChart();
        if (!fig || fig === observedFigure) return;
        if (observer) observer.disconnect();
        observer = new MutationObserver(muts => {
            if (applying) return;
            for (const m of muts) {
                if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) return schedule('childList');
                if (m.type === 'attributes') {
                    if (m.attributeName && m.attributeName.startsWith('data-tm2-')) continue;
                    return schedule('attr:' + m.attributeName);
                }
            }
        });
        observer.observe(fig, {
            childList: true, subtree: true, attributes: true,
            attributeFilter: ['d', 'fill', 'transform', 'aria-label', 'width', 'height', 'clip-path']
        });
        observedFigure = fig;
        log('observing main chart');
    }

    let booted = false;
    function boot() {
        const fig = findMainChart();
        if (!fig || !mainSvg(fig) || !capturePalette()) return false;
        observeMain();
        apply();
        return true;
    }

    function tryBoot() {
        if (booted) return;
        if (boot()) { booted = true; console.info(`${TAG} v1.2.0 active.`); }
    }

    new MutationObserver(() => {
        if (!booted) tryBoot();
        else { observeMain(); schedule('document'); }
    }).observe(document.documentElement, { childList: true, subtree: true });

    tryBoot();

    setInterval(() => {
        if (!booted) { tryBoot(); return; }
        observeMain();
        apply();
    }, CONFIG.POLL_MS);

    // ------------------------------------------------------------------ console API
    window.TM_LAYER2 = {
        version: '1.2.0',
        config: CONFIG,
        audit,
        apply,
        revert,
        rows: () => LAYOUT.slice(),
        hidden: () => HIDDEN.slice(),
        palette: () => PALETTE && {
            capturedAt: PALETTE.capturedAt,
            order: PALETTE.order.slice(),
            colors: Object.fromEntries(Array.from(PALETTE.colors.values()).map(v => [v.name, v.color]))
        }
    };
})();
