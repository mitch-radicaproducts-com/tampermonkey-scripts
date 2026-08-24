// ==UserScript==
// @name         Airtable — Recolor "Production Numbers" bars from "Palette" chart
// @namespace    radicaproducts.com
// @version      1.1.0
// @description  Recolors only the green (Status: Done) segments of the "Production Numbers" chart using the per-workstation colors read live from the "Palette" chart at the bottom of the page. The yellow (In-Progress) tips stay yellow and get a diagonal yellow/white stripe pattern.
// @author       Mitch
// @match        https://airtable.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Config
   * ------------------------------------------------------------------ */

  const SOURCE_CHART = 'Palette';            // chart whose bar colors are the palette
  const TARGET_CHART = 'Production Numbers'; // chart to recolor

  // Fills that count as "the green series" in the target chart.
  const GREEN_FILLS = [
    'rgb(154, 224, 149)',
  ];

  // Series values (from the bar's aria-label "Status: ...") that count as green.
  // Used as a fallback in case Airtable ever changes the green hex.
  const GREEN_SERIES = ['Done'];

  // Series values that stay yellow — these get the stripe pattern instead.
  const KEEP_SERIES = ['In-Progress', 'In Progress'];

  // Fills that count as "the yellow series" in the target chart.
  const YELLOW_FILLS = [
    'rgb(255, 214, 107)',
  ];

  // Diagonal stripe pattern for the yellow tips.
  const STRIPE = {
    id: 'tm-inprogress-stripes',
    base: 'rgb(255, 214, 107)', // yellow
    stripe: '#ffffff',          // white
    period: 6,                  // px, one yellow + one white band
    width: 3,                   // px of white per period
    angle: 45,                  // degrees
  };

  const DEBUG = false;

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  const log = (...a) => DEBUG && console.log('[bar-recolor]', ...a);

  const normFill = (s) =>
    (s || '').trim().toLowerCase().replace(/\s+/g, '');

  const GREEN_SET = new Set(GREEN_FILLS.map(normFill));
  const YELLOW_SET = new Set(YELLOW_FILLS.map(normFill));
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function findChart(label) {
    const all = document.querySelectorAll('div[role="figure"][aria-label]');
    for (const el of all) {
      if (el.getAttribute('aria-label') === label) return el;
    }
    return null;
  }

  function bars(chartEl) {
    if (!chartEl) return [];
    return [...chartEl.querySelectorAll(
      'g.mark-rect path[aria-roledescription="bar"], path[aria-roledescription="bar"]'
    )];
  }

  // aria-label looks like:
  // "... chartPageElementAxisX: Welding; Status: Done; groupByOrder: 1; Workstation (Color+Sort): Welding; ..."
  function parseLabel(el) {
    const label = el.getAttribute('aria-label') || '';
    const out = {};
    label.split(';').forEach((part) => {
      const i = part.indexOf(':');
      if (i === -1) return;
      out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    });
    return {
      category:
        out['chartPageElementAxisX'] ||
        out['Workstation (Color+Sort)'] ||
        null,
      series: out['Status'] || null,
      raw: label,
    };
  }

  function originalFill(el) {
    if (el.dataset.origFill) return el.dataset.origFill;
    const f = el.getAttribute('fill') || '';
    el.dataset.origFill = f;
    return f;
  }

  /* ------------------------------------------------------------------ *
   * Palette
   * ------------------------------------------------------------------ */

  function readPalette() {
    const chart = findChart(SOURCE_CHART);
    const map = new Map();
    bars(chart).forEach((el) => {
      const { category } = parseLabel(el);
      const fill = el.getAttribute('fill');
      if (category && fill && !map.has(category)) map.set(category, fill);
    });
    return map;
  }

  /* ------------------------------------------------------------------ *
   * Stripe pattern (injected into the target chart's own <svg>)
   * ------------------------------------------------------------------ */

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

  /* ------------------------------------------------------------------ *
   * Apply
   * ------------------------------------------------------------------ */

  let applying = false;

  function apply() {
    if (applying) return;

    const target = findChart(TARGET_CHART);
    if (!target) return;

    const palette = readPalette();
    if (!palette.size) {
      log('palette chart not found / not rendered yet');
      return;
    }

    applying = true;
    try {
      const stripeFill = ensureStripePattern(target.querySelector('svg.marks, svg'));

      bars(target).forEach((el) => {
        const { category, series } = parseLabel(el);
        if (!category) return;

        const orig = normFill(originalFill(el));

        // Yellow tips: keep yellow, but make them striped.
        const isYellow =
          YELLOW_SET.has(orig) || (series && KEEP_SERIES.includes(series));
        if (isYellow) {
          if (stripeFill && el.getAttribute('fill') !== stripeFill) {
            el.setAttribute('fill', stripeFill);
            el.dataset.recolored = 'stripes';
          }
          return;
        }

        // Green segments: recolor from the palette.
        const isGreen =
          GREEN_SET.has(orig) || (series && GREEN_SERIES.includes(series));
        if (!isGreen) return;

        const color = palette.get(category);
        if (!color) return;

        if (el.getAttribute('fill') !== color) {
          el.setAttribute('fill', color);
          el.dataset.recolored = color;
        }
      });
    } finally {
      // Let the observer settle before accepting new mutations.
      setTimeout(() => { applying = false; }, 0);
    }
  }

  /* ------------------------------------------------------------------ *
   * Keep it applied (Vega re-renders on resize, filter and data changes)
   * ------------------------------------------------------------------ */

  let timer = null;
  const schedule = () => {
    if (applying) return;
    clearTimeout(timer);
    timer = setTimeout(apply, 60);
  };

  new MutationObserver(schedule).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['fill', 'd', 'aria-label'],
  });

  // Initial attempts while the interface streams in, then a slow safety net.
  let tries = 0;
  const boot = setInterval(() => {
    apply();
    if (++tries > 40) clearInterval(boot); // ~20s
  }, 500);

  setInterval(apply, 5000);
  window.addEventListener('resize', schedule);
  apply();
})();
