// ==UserScript==
// @name         Mission Control Chart - Layer 2.3 - Buffer
// @namespace    tm.mission-control.layer-2.3
// @version      2.1.0
// @description  Prefix Production Numbers Y-axis stations with BUF: N and a connector. Board Foam is always BUF: ?.
// @match        https://airtable.com/*
// @match        https://*.airtable.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/**
 * Layer 2.3 — Buffer (v2.1.0)
 *
 * Standalone userscript. Does not patch Layer 2.2 (Serials In-Progress).
 * Built from lib/buffer-logic.js + src/overlay.js via scripts/build-userscript.js.
 *
 *   Welding (5)     →  BUF: 5 ── Panels
 *   Panels (5)      →  forked BUF: 5 between Trim 1 and Trim 2
 *   Trim 1 + Trim 2 →  BUF: N ── Seals
 *   Finish          →  BUF: N ── Water Test
 *   Board Foam      →  BUF: ? ── Insulation - Board Foam (always)
 */

(function () {
  "use strict";

  const VERSION = "2.1.0";

/**
 * Pure helpers for Mission Control Chart Layer 2.3 (Buffer).
 * Shared by the userscript (inlined at build) and Node tests. No DOM here.
 */

const DEFAULT_AXIS = [
  "GOAL",
  "Welding",
  "Panels",
  "Trim 1",
  "Trim 2",
  "Seals",
  "Final Seals",
  "Doors",
  "Windows",
  "Accessories",
  "Electrical",
  "Finish",
  "Water Test",
  "Insulation - Board Foam",
  "Insulation - Carpet",
  "Insulation - Finish",
];

const DISPLAY_OVERRIDES = {
  "trim 1": "seals",
  "trim 2": "seals",
};

const FORCED_UNKNOWN_STATIONS = ["insulation - board foam"];
const FORCED_UNKNOWN = new Set(FORCED_UNKNOWN_STATIONS);
const FORK_DISPLAY_GROUPS = [["trim 1", "trim 2"]];

function normalizeStation(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function sameStation(a, b) {
  return normalizeStation(a) === normalizeStation(b);
}

function slugStation(name) {
  return normalizeStation(name).replace(/[^a-z0-9]+/g, "-");
}

function countCommaSeparatedValues(text) {
  if (text == null) return 0;
  const raw = String(text).trim();
  if (!raw || raw === "–" || raw === "-" || raw === "—") return 0;
  return raw.split(",").reduce((n, part) => n + (part.trim() ? 1 : 0), 0);
}

function axisIndexByKey(axisStations) {
  const indexByKey = new Map();
  axisStations.forEach((name, index) => {
    const key = normalizeStation(name);
    if (key && !indexByKey.has(key)) indexByKey.set(key, index);
  });
  return indexByKey;
}

function canonicalAxisName(axisStations, indexByKey, wantedKey) {
  const index = indexByKey.get(wantedKey);
  return index == null ? null : axisStations[index];
}

function resolveDisplayStation(sourceName, axisStations, indexByKey) {
  const sourceKey = normalizeStation(sourceName);
  const sourceIndex = indexByKey.get(sourceKey);
  if (sourceIndex == null) return null;
  const overrideKey = DISPLAY_OVERRIDES[sourceKey];
  if (overrideKey) return canonicalAxisName(axisStations, indexByKey, overrideKey);
  return axisStations[sourceIndex + 1] || null;
}

function mappedValueFor(mapped, name) {
  if (mapped.has(name)) return mapped.get(name);
  const wanted = normalizeStation(name);
  for (const [key, value] of mapped) {
    if (normalizeStation(key) === wanted) return value;
  }
}

/**
 * Map each Buffer-table row onto the station that should show BUF: N.
 * Default: next Y-axis station. Trim 1 + Trim 2 sum onto Seals.
 * Insulation - Board Foam is always "?".
 */
function mapBufferCountsToNextStations(bufferRows, axisStations) {
  const indexByKey = axisIndexByKey(axisStations);
  const mapped = new Map();

  for (const row of bufferRows) {
    const count = countCommaSeparatedValues(row.bufferAfter);
    if (count <= 0) continue;
    const target = resolveDisplayStation(row.name, axisStations, indexByKey);
    if (!target || FORCED_UNKNOWN.has(normalizeStation(target))) continue;
    mapped.set(target, (mapped.get(target) || 0) + count);
  }

  for (const key of FORCED_UNKNOWN_STATIONS) {
    const name = canonicalAxisName(axisStations, indexByKey, key);
    if (name) mapped.set(name, "?");
  }
  return mapped;
}

function formatBufferPrefix(count) {
  return `BUF: ${count}`;
}

/**
 * Shared incoming buffers (Panels → Trim 1 / Trim 2) become one forked
 * overlay. Falls back to a straight prefix if a member is off-axis.
 */
function resolveForkOverlays(mapped, axisStations) {
  const indexByKey = axisIndexByKey(axisStations);
  const forks = [];
  const consumed = new Set();

  for (const group of FORK_DISPLAY_GROUPS) {
    const names = group
      .map((key) => canonicalAxisName(axisStations, indexByKey, key))
      .filter(Boolean);
    if (names.length < 2) continue;

    let source = null;
    let count;
    for (const name of names) {
      const value = mappedValueFor(mapped, name);
      if (value !== undefined) {
        source = name;
        count = value;
        break;
      }
    }
    if (!source) continue;

    forks.push({ stations: names, count, source });
    names.forEach((name) => consumed.add(normalizeStation(name)));
  }

  return { forks, consumed };
}

  const CHART_TITLE = "Production Numbers";
  const BUFFER_TABLE_LABEL = "Tampermonkey: Buffer";
  const ATTR = "data-tmsb";
  const ATTR_STATION = "data-tmsb-station";
  const OVERLAY_ID = "tm-l23-buffer-overlay";
  const CACHE_KEY = "tm-l23-buffer-rows";
  const DEBOUNCE_MS = 80;
  const TICK_MS = 1500;
  const LABEL_GAP = 6;
  const FONT_SIZE_FALLBACK = 11;
  const FONT_WEIGHT = "700";
  const CHART_RIGHT_SHIFT_PCT = 4;
  const FORK_ARM = 8;
  const FORK_STEM = 12;
  const STRAIGHT_LEN = (FORK_STEM + FORK_ARM) * 0.5;
  const PREFIX_COLOR = "var(--colors-foreground-subtler,#5b6475)";
  const HANDLE = "TM_BUF_L23";
  const SVG_NS = "http://www.w3.org/2000/svg";

  function textContent(el) {
    return (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
  }

  function closestPageElement(el) {
    return el
      ? el.closest("[data-testid='page-element:levels'], [data-elementtype='levels']")
      : null;
  }

  function readColumnIndex(page, headerTitle) {
    const wanted = normalizeStation(headerTitle);
    const headers = page.querySelectorAll(
      "[data-testid='level-header-column-display-element'] span, [role='columnheader']"
    );
    let index = 0;
    const seen = new Set();
    for (const header of headers) {
      const title = header.getAttribute("title") || textContent(header);
      const key = normalizeStation(title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (key === wanted) return index;
      index += 1;
    }
    return -1;
  }

  function findBufferPage() {
    const wanted = normalizeStation(BUFFER_TABLE_LABEL);
    for (const label of document.querySelectorAll("[data-testid='page-element-label']")) {
      if (normalizeStation(textContent(label)) !== wanted) continue;
      const page = closestPageElement(label);
      if (page) return page;
    }

    for (const page of document.querySelectorAll(
      "[data-testid='page-element:levels'], [data-elementtype='levels']"
    )) {
      if (readColumnIndex(page, "Name") >= 0 && readColumnIndex(page, "Assembly Buffer After") >= 0) {
        return page;
      }
    }
    return null;
  }

  function findProductionFigure() {
    return (
      document.querySelector(`[role="figure"][aria-label="${CHART_TITLE}"]`) ||
      document.querySelector(`[aria-label="${CHART_TITLE}"]`) ||
      document.querySelector(`figure[aria-label="${CHART_TITLE}"]`)
    );
  }

  function cellText(cell) {
    if (!cell) return "";
    const titled = cell.querySelector("[title]");
    const title = titled && titled.getAttribute("title");
    if (title && title.length < 200) {
      const trimmed = title.trim();
      if (trimmed && trimmed !== "Name" && trimmed !== "Assembly Buffer After") return trimmed;
    }
    const truncate = cell.querySelector(
      ".truncate-block-1-line, .truncate-pre, .line-height-4.truncate, .truncate"
    );
    return textContent(truncate || cell);
  }

  function loadCache() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }

  let cachedRows = loadCache();

  function saveCache(rows) {
    cachedRows = rows;
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(rows));
    } catch (err) {
      /* ignore quota */
    }
  }

  function cachedTable(error) {
    return {
      rows: cachedRows,
      error: cachedRows.length ? null : error,
      cached: cachedRows.length > 0,
    };
  }

  function readBufferTable() {
    const page = findBufferPage();
    if (!page) return cachedTable("buffer table not found");

    const nameIdx = readColumnIndex(page, "Name");
    const bufferIdx = readColumnIndex(page, "Assembly Buffer After");
    if (nameIdx < 0 || bufferIdx < 0) return cachedTable("buffer columns not found");

    const rows = [];
    for (const item of page.querySelectorAll("[data-testid='level-row-clickable']")) {
      const cells = item.querySelectorAll("[data-testid='row-column-container']");
      if (!cells.length) continue;
      const name = cellText(cells[nameIdx]);
      if (!name) continue;
      rows.push({ name, bufferAfter: cellText(cells[bufferIdx]) });
    }

    if (rows.length) saveCache(rows);
    return { rows: rows.length ? rows : cachedRows, error: null, cached: !rows.length };
  }

  function parseTranslateY(transform) {
    const match = /translate\(\s*[-\d.]+(?:[,\s]+([-\d.]+))?\s*\)/.exec(transform || "");
    return match ? Number(match[1]) || 0 : 0;
  }

  function yAxisGroup(figure) {
    const axes = figure.querySelectorAll("g.mark-group.role-axis");
    for (const axis of axes) {
      const label = axis.getAttribute("aria-label") || "";
      if (/y-axis|discrete scale/i.test(label)) return axis;
    }
    let best = null;
    let bestCount = 0;
    axes.forEach((axis) => {
      const count = axis.querySelectorAll("g.mark-text.role-axis-label text").length;
      if (count > bestCount) {
        best = axis;
        bestCount = count;
      }
    });
    return best;
  }

  function collectAxisStations(figure) {
    const axis = yAxisGroup(figure);
    if (!axis) return [];
    const entries = [];
    axis.querySelectorAll("g.mark-text.role-axis-label text").forEach((text) => {
      if (text.hasAttribute(ATTR) || text.closest(`[${ATTR}]`)) return;
      const name = (text.getAttribute("data-tm2-row") || textContent(text)).trim();
      if (!name) return;
      entries.push({ name, y: parseTranslateY(text.getAttribute("transform")), node: text });
    });
    entries.sort((a, b) => a.y - b.y);
    const stations = [];
    const seen = new Set();
    for (const entry of entries) {
      const key = normalizeStation(entry.name);
      if (seen.has(key)) continue;
      seen.add(key);
      stations.push(entry);
    }
    return stations;
  }

  function findChartShiftTarget(figure) {
    const embed = figure.querySelector(".vega-embed");
    if (embed && embed !== figure && !embed.closest(`#${OVERLAY_ID}`)) return embed;
    const svg = figure.querySelector("svg.marks") || figure.querySelector("svg");
    if (!svg || svg.closest(`#${OVERLAY_ID}`)) return null;
    const parent = svg.parentElement;
    return parent && parent !== figure && !parent.closest(`#${OVERLAY_ID}`) ? parent : svg;
  }

  function applyRightShift(node) {
    if (!node || node === document.documentElement) return;
    const positioned = /^(absolute|fixed)$/.test(window.getComputedStyle(node).position);
    node.style.boxSizing = "border-box";
    node.style.width = `${100 - CHART_RIGHT_SHIFT_PCT}%`;
    node.style.maxWidth = `${100 - CHART_RIGHT_SHIFT_PCT}%`;
    if (positioned) {
      node.style.left = `${CHART_RIGHT_SHIFT_PCT}%`;
      node.style.right = "0";
      node.style.marginLeft = "0";
    } else {
      node.style.marginLeft = `${CHART_RIGHT_SHIFT_PCT}%`;
    }
    node.setAttribute("data-tmsb-chart-shift", String(CHART_RIGHT_SHIFT_PCT));
  }

  function nudgeChartRight(figure) {
    const target = findChartShiftTarget(figure);
    if (!target || target === figure) return null;
    applyRightShift(target);
    figure.querySelectorAll("canvas").forEach((canvas) => {
      if (canvas.closest(`#${OVERLAY_ID}`)) return;
      if (target.contains(canvas) && target !== canvas) return;
      applyRightShift(canvas);
    });
    return target;
  }

  function ensureHtmlOverlay(figure) {
    if (window.getComputedStyle(figure).position === "static") figure.style.position = "relative";
    let overlay = figure.querySelector(`#${OVERLAY_ID}`);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = OVERLAY_ID;
      overlay.setAttribute(ATTR, "html");
      overlay.setAttribute("aria-hidden", "true");
      overlay.style.cssText =
        "position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:8;overflow:visible;";
      figure.appendChild(overlay);
    }
    figure.setAttribute("data-tmsb-active", "1");
    return overlay;
  }

  function pxSize(value, fallback) {
    const n = parseFloat(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  function bufferFontSize(labelNode) {
    if (!labelNode) return Math.max(8, FONT_SIZE_FALLBACK - 1);
    const attr = labelNode.getAttribute("font-size");
    if (attr) return Math.max(8, pxSize(attr, FONT_SIZE_FALLBACK) - 1);
    try {
      return Math.max(8, pxSize(window.getComputedStyle(labelNode).fontSize, FONT_SIZE_FALLBACK) - 1);
    } catch (err) {
      return Math.max(8, FONT_SIZE_FALLBACK - 1);
    }
  }

  function labelFont(sample) {
    return (
      (sample && sample.getAttribute("font-family")) ||
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
    );
  }

  function figurePoint(figure, node) {
    const figBox = figure.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    if (!box.width && !box.height) return null;
    return {
      right: box.left - figBox.left - LABEL_GAP,
      midY: box.top - figBox.top + box.height / 2,
    };
  }

  function ensureConnectorHost(overlay, id, attrs) {
    let node = overlay.querySelector(`[data-tmsb-id="${id}"]`);
    if (!node) {
      node = document.createElement("div");
      node.setAttribute(ATTR, "label");
      node.setAttribute("data-tmsb-id", id);
      if (attrs) Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
      overlay.appendChild(node);
    }
    node.style.cssText =
      "position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;" +
      `color:${PREFIX_COLOR}`;
    return node;
  }

  function strokePath(d, width, height) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width", String(Math.max(1, Math.ceil(width))));
    svg.setAttribute("height", String(Math.max(1, Math.ceil(height))));
    svg.style.cssText = "position:absolute;left:0;top:0;overflow:visible;pointer-events:none;";
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.25");
    path.setAttribute("stroke-linecap", "square");
    path.setAttribute("stroke-linejoin", "miter");
    svg.appendChild(path);
    return svg;
  }

  function bufLabelNode(prefix, left, top, sample) {
    const label = document.createElement("div");
    label.textContent = prefix;
    label.style.cssText = [
      "position:absolute",
      `left:${left}px`,
      `top:${top}px`,
      "transform:translate(-100%,-50%)",
      `font-family:${labelFont(sample)}`,
      `font-size:${bufferFontSize(sample)}px`,
      `font-weight:${FONT_WEIGHT}`,
      "line-height:1",
      "white-space:nowrap",
      "pointer-events:none",
    ].join(";");
    return label;
  }

  function paintConnector(overlay, spec) {
    const node = ensureConnectorHost(overlay, spec.id, spec.attrs);
    node.setAttribute(ATTR_STATION, spec.stationKey);
    node.setAttribute("data-tmsb-count", String(spec.count));
    const signature = [
      spec.count,
      spec.d,
      spec.labelX.toFixed(1),
      spec.labelY.toFixed(1),
      bufferFontSize(spec.sample),
    ].join("|");
    if (node.getAttribute("data-tmsb-sig") === signature) return node;
    node.setAttribute("data-tmsb-sig", signature);
    node.replaceChildren(
      strokePath(spec.d, spec.width, spec.height),
      bufLabelNode(formatBufferPrefix(spec.count), spec.labelX, spec.labelY, spec.sample)
    );
    return node;
  }

  function upsertPrefix(overlay, figure, station, count, labelNode) {
    const pt = figurePoint(figure, labelNode);
    if (!pt) return null;
    const stemX = pt.right - STRAIGHT_LEN;
    return paintConnector(overlay, {
      id: slugStation(station),
      stationKey: station,
      count,
      sample: labelNode,
      d: `M ${stemX} ${pt.midY} H ${pt.right}`,
      width: pt.right + 2,
      height: pt.midY + 2,
      labelX: stemX - 4,
      labelY: pt.midY,
    });
  }

  function findAxisEntry(stations, name) {
    return stations.find((entry) => sameStation(entry.name, name)) || null;
  }

  function upsertForkPrefix(overlay, figure, fork, stations) {
    const entries = fork.stations.map((name) => findAxisEntry(stations, name)).filter((entry) => entry && entry.node);
    if (entries.length < 2) return null;

    const points = entries.map((entry) => figurePoint(figure, entry.node));
    if (points.some((pt) => !pt)) return null;

    const y1 = Math.min(...points.map((pt) => pt.midY));
    const y2 = Math.max(...points.map((pt) => pt.midY));
    const midY = (y1 + y2) / 2;
    const forkRight = Math.min(...points.map((pt) => pt.right));
    const vertX = forkRight - FORK_ARM;
    const stemX = vertX - FORK_STEM;

    return paintConnector(overlay, {
      id: `fork-${fork.stations.map(slugStation).join("-")}`,
      stationKey: fork.stations.join("|"),
      count: fork.count,
      sample: entries[0].node,
      attrs: { "data-tmsb-fork": "1" },
      d: [
        `M ${stemX} ${midY} H ${vertX}`,
        `M ${vertX} ${y1} V ${y2}`,
        `M ${vertX} ${y1} H ${forkRight}`,
        `M ${vertX} ${y2} H ${forkRight}`,
      ].join(" "),
      width: forkRight + 2,
      height: y2 + 2,
      labelX: stemX - 4,
      labelY: midY,
    });
  }

  function pruneStale(overlay, keepKeys) {
    overlay.querySelectorAll(`[${ATTR}="label"]`).forEach((node) => {
      if (!keepKeys.has(node.getAttribute(ATTR_STATION))) node.remove();
    });
  }

  function apply() {
    const figure = findProductionFigure();
    if (!figure) return { ok: false, reason: "Production Numbers chart not found" };

    const table = readBufferTable();
    const shiftTarget = nudgeChartRight(figure);
    const stations = collectAxisStations(figure);
    const mapped = mapBufferCountsToNextStations(table.rows, DEFAULT_AXIS);
    const overlay = ensureHtmlOverlay(figure);
    const keep = new Set();
    const applied = [];
    const { forks, consumed } = resolveForkOverlays(
      mapped,
      stations.map((entry) => entry.name)
    );

    for (const fork of forks) {
      const node = upsertForkPrefix(overlay, figure, fork, stations);
      if (!node) continue;
      keep.add(node.getAttribute(ATTR_STATION));
      applied.push({ station: fork.stations.join("|"), count: fork.count, fork: true });
    }

    for (const [station, count] of mapped) {
      if (consumed.has(normalizeStation(station))) continue;
      const entry = findAxisEntry(stations, station);
      if (!entry) continue;
      const node = upsertPrefix(overlay, figure, entry.name, count, entry.node);
      if (!node) continue;
      keep.add(entry.name);
      applied.push({ station: entry.name, count });
    }

    pruneStale(overlay, keep);
    return {
      ok: applied.length > 0 || mapped.size === 0,
      bufferRows: table.rows.length,
      mapped: Array.from(mapped.entries()),
      applied,
      error: table.error,
      cached: table.cached || false,
      chartShift: shiftTarget ? CHART_RIGHT_SHIFT_PCT : 0,
    };
  }

  let timer = 0;
  let applying = false;

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  }

  function run() {
    if (applying) return;
    applying = true;
    try {
      window[HANDLE].last = apply();
    } catch (err) {
      window[HANDLE].last = { ok: false, reason: String(err && err.message ? err.message : err) };
    } finally {
      applying = false;
    }
  }

  function isOwnNode(node) {
    if (!node) return false;
    if (node.nodeType === 3) return isOwnNode(node.parentElement);
    if (node.nodeType !== 1) return false;
    return !!(node.hasAttribute(ATTR) || node.closest(`[${ATTR}]`));
  }

  const observer = new MutationObserver((mutations) => {
    if (mutations.every((mutation) => isOwnNode(mutation.target))) return;
    schedule();
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
  });

  window[HANDLE] = {
    version: VERSION,
    refresh: run,
    apply,
    countCommaSeparatedValues,
    mapBufferCountsToNextStations,
    last: null,
    observer,
  };

  run();
  [200, 800, 2000, 5000].forEach((ms) => setTimeout(run, ms));
  setInterval(run, TICK_MS);

})();
