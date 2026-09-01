// ==UserScript==
// @name         Mission Control Chart - Layer 2.2 - Serials In-Progress
// @namespace    radicaproducts.com
// @version      1.0.1
// @description  Overlays serial numbers from the "Tampermonkey: Serial Numbers In-Progress" table onto the In-Progress bar segments of the Production Numbers chart, and appends that row's Takt Time (plus a green thumbs-up when On Time) into the first empty cell after the bar. Uses only the Layer 1 grid harness, so stripes/fills/colors are irrelevant.
// @author       Mitch
// @match        https://airtable.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * ---------------------------------------------------------------------------
 * HOW THIS WORKS
 * ---------------------------------------------------------------------------
 * Layer 1 injects a grid harness over the Vega chart:
 *
 *   <g data-tm-grid="1">
 *     <g data-tm-row="H" data-tm-cat="Windows" data-tm-done="3" transform="translate(0,Y)">
 *       <g data-tm-cell="H04" transform="translate(212.7,0)" data-tm-col="4"
 *          data-tm-cat="Windows" data-tm-status="In-Progress" data-tm-ordinal="1">
 *         <g clip-path="url(#tm-grid-clip-H)" data-tm-fill="1"> <rect .../> </g>
 *         <text data-tm-anchor="1" x="35.45" y="9.92" .../>
 *
 * Layer 2 NEVER looks at fills, patterns, colors or path geometry. A segment is
 * "In-Progress" purely because data-tm-status says so, so striped, solid,
 * recolored, light or dark all behave identically.
 *
 * TWO OVERLAYS
 * ------------
 * 1. SERIALS — inside each In-Progress cell. White plate + subtler text,
 *    matching the Done-count labels Layer 1 draws.
 *
 * 2. TAKT TIME — one label per In-Progress segment, in the consecutive empty
 *    cells that follow the bar. Left-most segment -> left-most takt cell, so a
 *    row with two segments (e.g. Windows) gets two takt times in order. Each is
 *    suffixed with a green thumbs-up when that table row's "On Time" box is
 *    checked.
 *
 * 3. REPEAT-SERIAL RECOLOUR — walking the grid top -> bottom, the first station
 *    a serial appears at owns its colour; any later station showing the same
 *    serial is repainted with that first station's In-Progress fill.
 *
 * WHERE THE LABELS LIVE (this matters — see v1.2.0 note below)
 * -----------------------------------------------------------
 * Layer 1 reconciles the DIRECT CHILDREN of the grid root: anything there that
 * isn't one of its own g[data-tm-row] groups gets pruned on its next pass. It
 * does NOT touch the inside of cell subtrees. So every Layer 2 node is hosted
 * inside a g[data-tm-cell] and survives Layer 1 re-renders.
 *
 * Harness 1.1.0 clipped each ROW group to the bar's extent, which would have
 * hidden a label drawn in a trailing empty cell; 1.1.2 moved that clip down
 * into a per-cell <g data-tm-fill="1"> wrapper, leaving the cell group itself
 * unclipped. TAKT_HOST:'auto' detects which situation applies: if any clipping
 * ancestor sits between the target cell and the grid root, it falls back to an
 * external host placed as the grid root's NEXT SIBLING (never a child, so the
 * root reconcile cannot prune it).
 *
 * ASSIGNMENT
 * ----------
 *   1. Table rows become per-workstation FIFO queues, in table order.
 *   2. Each grid row drains its own queue across its In-Progress cells in
 *      ordinal order (left -> right). Two Windows segments therefore take the
 *      1st and 2nd Windows serials.
 *   3. Defensive fallback: a cell whose workstation produced no table row takes
 *      the next unclaimed serial in raw table order.
 *
 * CHANGELOG
 * ---------
 * 1.6.0  (a) Trimming the x-axis now also hides the gridline and tick belonging
 *        to each hidden label, so no bare vertical columns are left standing past
 *        8. Vega draws the gridlines in a SEPARATE, unlabelled axis group from
 *        the labels, so they are matched by x position rather than by structure.
 *        (b) Serial text is auto-fitted again (SERIAL_FONT: 'auto'), keeping the
 *        1.4.0 behaviour where all serials share one size.
 * 1.5.0  (a) Serial labels no longer resize at all: the size is copied from
 *        Layer 1's Done-bar count label (text[data-tm-anchor]) so the two always
 *        match, and a serial too wide for its cell is ellipsised rather than
 *        shrunk — the ellipsis is the cue to zoom out. (b) The GOAL row's takt
 *        time and thumb are suppressed (TAKT_SKIP_CATS). (c) X-axis tick labels
 *        above 8 are hidden (AXIS_HIDE_ABOVE); the axis runs to 10 purely for
 *        spacing, and the extra numbers only invite questions.
 * 1.4.0  (a) UNIFORM TEXT SIZE. Every serial label now shares one font size, and
 *        every takt label shares another, each being the largest size that fits
 *        the tightest label on the chart. Previously each label was fitted on its
 *        own, so zooming out shrank some and not others ("MLX003…" at 6.5px next
 *        to "RVR00025", takt at 9.5px next to 10.5px). All measurement now runs
 *        against a hidden scratch text node, so the visible nodes are written
 *        exactly once with their final values — no intermediate churn for the
 *        observer to react to. (b) A row with several In-Progress segments gets
 *        ONE takt label in the first empty cell: a comma-separated run, each
 *        takt followed by its own thumbs-up (e.g. "6h 56m 👍, 13h 0m").
 * 1.3.0  (a) One takt label PER In-Progress segment, placed in consecutive
 *        trailing cells, left-most segment -> left-most takt cell (so Windows'
 *        two segments get two takt times). (b) Repeat-serial recolour: walking
 *        the grid top -> bottom, the FIRST row a serial appears in owns its
 *        colour; later appearances of the same serial are repainted with that
 *        first station's In-Progress fill (e.g. Finish's RVR00025 takes
 *        Electrical's stripes). The repaint is an opaque overlay drawn inside
 *        the cell using a clone of Layer 1's own clip/transform envelope, so we
 *        never fight Layer 1 for ownership of the bar path's fill.
 * 1.2.0  Fixed flashing takt labels. They previously lived in a layer appended
 *        to the grid root, which Layer 1 1.1.2 prunes as a foreign child; the
 *        script re-added it, Layer 1 pruned it again, and the strobe was that
 *        loop. Labels are now cell-hosted, and every DOM write is idempotent
 *        (attributes/text are only touched when the value actually changes) so
 *        a steady-state pass emits zero mutations and cannot feed a loop.
 * 1.1.0  Takt Time + green thumbs-up. Opaque white plate, subtler text.
 * 1.0.0  Serial overlay.
 * ---------------------------------------------------------------------------
 */

(function () {
  'use strict';

  /* ======================= CONFIG ======================= */
  const CFG = {
    /* --- source table --- */
    TABLE_LABEL: 'Tampermonkey: Serial Numbers In-Progress',
    COL_SERIAL: 'Serial Number',
    COL_WORKSTATION: 'Workstation Link',
    COL_STATUS: 'Status',
    COL_TAKT: 'Takt Time',
    COL_ONTIME: 'On Time',

    /* --- shared typography --- */
    FONT_MAX: 10.5,
    FONT_MIN: 6.5, // floor for takt labels
    FONT_STEP: 0.5,
    // Takt labels share one size — the largest that fits the tightest one.
    // Set false to fit each label independently.
    UNIFORM_FONT: true,

    /* --- serial label size (never auto-fitted) --- */
    // 'done-label' -> copy the size of Layer 1's Done-bar count label
    //                 (text[data-tm-anchor]), so serials and counts always match.
    // <number>     -> a fixed px size.
    // 'auto'       -> shrink to fit, floor SERIAL_FONT_MIN (all serials still
    //                 share one size, so they stay consistent with each other).
    SERIAL_FONT: 'auto',
    SERIAL_FONT_FALLBACK: 11, // used when no Done label can be read
    SERIAL_FONT_MIN: 5, // only consulted when SERIAL_FONT is 'auto'
    // A serial too wide for its cell is ellipsised, not shrunk: the "…" is a
    // deliberate cue to the user to zoom out.
    SERIAL_ELLIPSIS: true,
    FONT_WEIGHT: 600,
    FONT_FAMILY: 'inherit',
    // Same subtler shade Layer 1 uses for the Done-bar counts.
    TEXT_FILL: 'var(--colors-foreground-subtler)',
    TEXT_OPACITY: 1,

    /* --- serial labels (inside the In-Progress segment) --- */
    PLATE: true,
    PLATE_FILL: '#ffffff',
    PLATE_OPACITY: 1, // fully opaque white
    PLATE_PAD_X: 2.5,
    PLATE_PAD_Y: 1.5,
    PLATE_RADIUS: 2,
    PLATE_MAX_HEIGHT_RATIO: 0.86, // of cell height
    CELL_PAD_X: 3,

    /* --- x-axis trimming --- */
    // The scale runs to 10 for spacing, but production never reaches it, so
    // everything above this value is hidden. null disables the trimming.
    AXIS_HIDE_ABOVE: 8,
    AXIS_HIDE_GRID: true, // the vertical gridline through the chart
    AXIS_HIDE_TICKS: true, // the little tick below the axis line
    AXIS_MATCH_TOL: 2, // px tolerance when matching gridlines to labels

    /* --- repeat-serial recolour --- */
    // A serial that appears at more than one station is repainted, at every
    // later station, with the In-Progress fill of the station it first appeared
    // at (first = top-most grid row, then left-most segment).
    DUP_RECOLOR: true,
    // Where the donor colour comes from:
    //   'in-progress' -> the donor cell's own data-tm-fill (keeps stripes)
    //   'done'        -> the donor row's solid Done fill (flat colour)
    DUP_SOURCE: 'in-progress',
    DUP_OPACITY: 1,

    /* --- takt labels (in the empty cell after the bar) --- */
    TAKT_ENABLED: true,
    // Rows with several In-Progress segments list every segment's takt in ONE
    // label, comma-separated, left-most segment first, each with its own thumb.
    // false = only the left-most segment's takt is shown (<= 1.2.0 behaviour).
    TAKT_ALL_SEGMENTS: true,
    // Workstations that never get a takt label (the GOAL row is a target, not a
    // station, so a takt time there is meaningless). Matched case-insensitively.
    TAKT_SKIP_CATS: ['GOAL'],
    TAKT_SEP: ',', // separator glyph between segments
    TAKT_SEP_LEAD: 0.5, // gap before the separator
    TAKT_SEP_TRAIL: 3, // gap after the separator
    TAKT_ALIGN: 'start', // 'start' hugs the bar end; 'middle' centers in the cell
    TAKT_PAD_X: 6, // gap from the empty cell's leading edge when align = start
    TAKT_PLATE: false, // sits over empty background, no plate needed
    // 'auto'  -> host in the cell, unless a clipping ancestor forces external
    // 'cell'  -> always host in the cell
    // 'layer' -> always use the external host (grid root's next sibling)
    TAKT_HOST: 'auto',
    // When a row has no Empty cell left (e.g. the GOAL row, whose trailing
    // cells are Hidden padding), fall back to the next non-bar cell.
    TAKT_ALLOW_PADDING_FALLBACK: true,

    /* --- green thumbs-up --- */
    THUMB_ENABLED: true,
    THUMB_MODE: 'path', // 'path' = self-contained glyph; 'sprite' = reuse Airtable's icon
    THUMB_COLOR: '#048a0e', // matches Airtable's rgb(4, 138, 14) On Time badge
    THUMB_GAP: 3.5, // gap between takt text and glyph
    THUMB_SCALE: 1.15, // glyph box = font-size * this
    // Glyph ink spans y 2.6..14.6 of the 16-unit box, so nudge up to optically
    // center it against the text.
    THUMB_NUDGE_Y: -0.6,
    // 16x16 thumbs-up: palm + separate cuff.
    THUMB_PATH:
      'M6.35,14.6h5.1c0.82,0,1.53-0.55,1.72-1.35l1.02-4.17c0.24-0.99-0.5-1.94-1.5-1.94h-3.02l0.42-2.3' +
      'c0.19-1.05-0.61-2.02-1.66-2.02c-0.5,0-0.96,0.25-1.24,0.66L4.9,7.32v7.28H6.35z ' +
      'M1.85,7.6h2.3v7H1.85c-0.44,0-0.8-0.36-0.8-0.8V8.4C1.05,7.96,1.41,7.6,1.85,7.6z',

    /* --- blank handling --- */
    BLANK_TOKENS: ['', '-', '–', '—', 'n/a', 'na', 'null', 'none'],

    /* --- re-render handling --- */
    DEBOUNCE_MS: 120,
    BOOT_POLL_MS: 400,
    BOOT_TIMEOUT_MS: 60000,

    DEBUG: false,
  };

  const NS = 'http://www.w3.org/2000/svg';
  const XLINK = 'http://www.w3.org/1999/xlink';
  const TAG = '[TM L2]';
  const MARK = 'data-tmsn'; // our namespace; Layer 1 owns data-tm-* and data-tm2-*
  const OURS = `g[${MARK}="serial"], g[${MARK}="takt"], g[${MARK}="takt-layer"], g[${MARK}="recolor"], g[${MARK}="scratch"]`;

  const log = (...a) => CFG.DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const el = (name) => document.createElementNS(NS, name);

  /* ======================= HELPERS ======================= */

  const norm = (s) =>
    (s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  // Case/space/dash-insensitive key so "Insulation - Board Foam",
  // "Insulation – Board Foam" and "insulation board foam" all collapse together.
  const keyOf = (s) =>
    norm(s)
      .toLowerCase()
      .replace(/[\u2010-\u2015]/g, '-')
      .replace(/[\s_-]+/g, ' ')
      .trim();

  const isBlank = (s) => CFG.BLANK_TOKENS.includes(norm(s).toLowerCase());
  const looksInProgress = (s) => /in[\s._-]*progress/i.test(norm(s));
  const looksEmpty = (cell) =>
    cell.getAttribute('data-tm-empty') === '1' ||
    /^empty$/i.test(norm(cell.getAttribute('data-tm-status')));
  const isBarCell = (cell) => {
    const st = norm(cell.getAttribute('data-tm-status'));
    return /^done$/i.test(st) || looksInProgress(st);
  };

  /**
   * Idempotent attribute write. Writing an identical value still emits a
   * MutationObserver record, which is exactly how a redraw loop gets fed, so
   * never touch the DOM unless the value really changed.
   */
  function setA(node, name, value) {
    const v = String(value);
    if (node.getAttribute(name) !== v) node.setAttribute(name, v);
  }
  function setText(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }

  /** get-or-create a child element, so repeat passes reuse nodes. */
  function child(parent, selector, tagName, init) {
    let n = parent.querySelector(`:scope > ${selector}`);
    if (!n) {
      n = el(tagName);
      if (init) init(n);
      parent.appendChild(n);
    }
    return n;
  }

  function translateOf(node) {
    const t = node && node.getAttribute && node.getAttribute('transform');
    const m = t && t.match(/translate\(\s*(-?[\d.eE+]+)(?:\s*[, ]\s*(-?[\d.eE+]+))?/);
    if (!m) return { x: 0, y: 0 };
    return { x: parseFloat(m[1]) || 0, y: parseFloat(m[2] || '0') || 0 };
  }

  /** Any clip-path between `node` and `stop` (inclusive of node)? */
  function clippedUpTo(node, stop) {
    let n = node;
    while (n && n !== stop) {
      if (n.getAttribute && n.getAttribute('clip-path')) return true;
      n = n.parentNode;
    }
    return false;
  }

  /* ======================= 1. READ THE TABLE ======================= */

  function findSerialTable() {
    const els = Array.from(
      document.querySelectorAll('[data-testid="page-element:levels"]')
    );
    const labelOf = (e) => {
      const l = e.querySelector('[data-testid="page-element-label"]');
      return norm(l && l.textContent);
    };
    const want = keyOf(CFG.TABLE_LABEL);
    return (
      els.find((e) => keyOf(labelOf(e)) === want) ||
      // Tolerant fallback: any levels element mentioning serials + in-progress.
      els.find((e) => {
        const k = keyOf(labelOf(e));
        return k.includes('serial') && k.includes('in progress');
      }) ||
      null
    );
  }

  function columnIndexByTitle(tableEl) {
    const map = new Map();
    tableEl
      .querySelectorAll('[data-testid="header-column-container"]')
      .forEach((h) => {
        const idx = h.getAttribute('aria-colindex');
        const span = h.querySelector('span[title]');
        const title = norm(span ? span.getAttribute('title') : h.textContent);
        if (idx && title) map.set(keyOf(title), idx);
      });
    return map;
  }

  function cellEl(row, cols, title) {
    const idx = cols.get(keyOf(title));
    if (!idx) return null;
    return row.querySelector(
      `[aria-colindex="${idx}"][role="gridcell"], [aria-colindex="${idx}"][role="rowheader"], [aria-colindex="${idx}"]`
    );
  }

  const cellText = (row, cols, title) =>
    norm((cellEl(row, cols, title) || {}).textContent);

  /**
   * On Time is a disabled checkbox rendered as a ThumbsUpFill icon; green
   * (rgb(4,138,14)) + aria-checked="true" when on time.
   */
  function readOnTime(row, cols) {
    const c = cellEl(row, cols, CFG.COL_ONTIME);
    const box = c && c.querySelector('[role="checkbox"]');
    if (!box) return { onTime: false, iconHref: null };
    const checked = box.getAttribute('aria-checked') === 'true';
    const use = box.querySelector('use');
    const href =
      use && (use.getAttribute('href') || use.getAttributeNS(XLINK, 'href'));
    return { onTime: checked, iconHref: href || null };
  }

  function readTable() {
    const tableEl = findSerialTable();
    if (!tableEl) return null;
    const cols = columnIndexByTitle(tableEl);

    const rowEls = Array.from(
      tableEl.querySelectorAll('[data-testid="level-row-clickable"]')
    ).sort(
      (a, b) =>
        (+a.getAttribute('aria-rowindex') || 0) -
        (+b.getAttribute('aria-rowindex') || 0)
    );

    const rows = rowEls.map((r) => {
      const ot = readOnTime(r, cols);
      return {
        key: r.getAttribute('data-level-item-key') || '',
        status: cellText(r, cols, CFG.COL_STATUS),
        serial: cellText(r, cols, CFG.COL_SERIAL),
        workstation: cellText(r, cols, CFG.COL_WORKSTATION),
        takt: cellText(r, cols, CFG.COL_TAKT),
        onTime: ot.onTime,
        iconHref: ot.iconHref,
      };
    });

    // Table is already scoped to In-Progress; filter defensively when a Status
    // column exists and actually carries values.
    const statused = rows.filter((r) => r.status);
    const usable =
      statused.length === rows.length && rows.length
        ? rows.filter((r) => looksInProgress(r.status))
        : rows;

    return { rows: usable.filter((r) => r.workstation || r.serial) };
  }

  /* ======================= 2. READ THE GRID ======================= */

  function gridRoots() {
    return Array.from(document.querySelectorAll('g[data-tm-grid]')).filter((g) =>
      g.querySelector('g[data-tm-cell]')
    );
  }

  const byColumn = (a, b) => {
    const ca = +a.getAttribute('data-tm-col') || 0;
    const cb = +b.getAttribute('data-tm-col') || 0;
    if (ca !== cb) return ca - cb;
    return String(a.getAttribute('data-tm-cell')).localeCompare(
      String(b.getAttribute('data-tm-cell'))
    );
  };

  /**
   * @returns {Array<{root, rowEl, row, cat, cells, allCells}>}
   *   cells    = In-Progress cells, ordinal order (left -> right)
   *   allCells = every cell in the row, column order
   */
  function inProgressByRow(root) {
    const out = [];
    const rowEls = Array.from(root.querySelectorAll('g[data-tm-row]'));
    (rowEls.length ? rowEls : [root]).forEach((rowEl) => {
      const allCells = Array.from(rowEl.querySelectorAll('g[data-tm-cell]')).sort(
        byColumn
      );
      const cells = allCells
        .filter((c) => looksInProgress(c.getAttribute('data-tm-status')))
        .sort((a, b) => {
          const oa = +a.getAttribute('data-tm-ordinal');
          const ob = +b.getAttribute('data-tm-ordinal');
          if (Number.isFinite(oa) && Number.isFinite(ob) && oa !== ob) return oa - ob;
          return byColumn(a, b);
        });
      if (!cells.length) return;

      out.push({
        root,
        rowEl,
        row: (rowEl.getAttribute && rowEl.getAttribute('data-tm-row')) || '',
        cat:
          norm(rowEl.getAttribute && rowEl.getAttribute('data-tm-cat')) ||
          norm(cells[0].getAttribute('data-tm-cat')),
        cells,
        allCells,
      });
    });

    out.sort((a, b) => String(a.row).localeCompare(String(b.row)));
    return out;
  }

  /**
   * The consecutive cells after the last In-Progress cell that can host takt
   * labels. Prefers true Empty cells; falls back to Hidden/padding cells when
   * the row has none (e.g. the GOAL row, padded out to full width).
   *
   * `count` labels are wanted, so `count` cells are handed back when the row's
   * trailing run is long enough. Position i in the result belongs to In-Progress
   * segment i, so left-most segment -> left-most takt cell. The final label may
   * spill across whatever run cells are left over.
   *
   * @returns {Array<{cell: Element, span: number}>}
   */
  function taktTargets(group, count) {
    const last = group.cells[group.cells.length - 1];
    const idx = group.allCells.indexOf(last);
    if (idx < 0) return [];
    const tail = group.allCells.slice(idx + 1);

    let start = tail.findIndex((c) => looksEmpty(c));
    if (start < 0 && CFG.TAKT_ALLOW_PADDING_FALLBACK) {
      start = tail.findIndex((c) => !isBarCell(c));
    }
    if (start < 0) return [];

    const run = [];
    for (let i = start; i < tail.length; i++) {
      if (isBarCell(tail[i])) break;
      run.push(tail[i]);
    }

    const n = Math.max(1, Math.min(count || 1, run.length));
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({
        cell: run[i],
        span: i === n - 1 ? Math.max(1, run.length - i) : 1,
      });
    }
    return out;
  }

  /** Rows excluded from takt labelling altogether, e.g. GOAL. */
  function taktSkipped(group) {
    const cats = CFG.TAKT_SKIP_CATS || [];
    const cat = keyOf(group.cat || '');
    return cats.some((c) => keyOf(c) === cat);
  }

  /**
   * Table rows behind a row's takt labels, in segment order. Rows whose Takt
   * Time is blank are skipped rather than eating a cell.
   */
  function taktEntries(group) {
    const src = CFG.TAKT_ALL_SEGMENTS
      ? group.entries || []
      : [group.leader].filter(Boolean);
    return src.filter((e) => e && !isBlank(e.takt));
  }

  /* ======================= 3. MATCH TABLE -> CELLS ======================= */

  function buildAssignments(tableRows, rowGroups) {
    const queues = new Map();
    tableRows.forEach((r, i) => {
      const k = keyOf(r.workstation);
      if (!queues.has(k)) queues.set(k, []);
      queues.get(k).push({ ...r, tableIndex: i });
    });

    const consumed = new Set();
    const assignments = [];
    const unmatched = [];

    rowGroups.forEach((group) => {
      group.leader = null; // table row of the LEFT-MOST In-Progress cell
      group.entries = []; // table row per In-Progress cell, left -> right
      const rowQueue = queues.get(keyOf(group.cat));
      group.cells.forEach((cell, i) => {
        const pool =
          queues.get(keyOf(cell.getAttribute('data-tm-cat') || group.cat)) || rowQueue;
        const entry = pool && pool.shift();
        if (entry) {
          consumed.add(entry.tableIndex);
          assignments.push({ cell, entry, group });
          group.entries[i] = entry;
          if (i === 0) group.leader = entry;
        } else {
          unmatched.push({ cell, group, ordinalIndex: i });
        }
      });
    });

    // Defensive fallback: cells whose workstation produced no table row get the
    // next serial nobody claimed, in table order.
    if (unmatched.length) {
      const leftovers = tableRows
        .map((r, i) => ({ ...r, tableIndex: i }))
        .filter((r) => !consumed.has(r.tableIndex));
      unmatched.forEach(({ cell, group, ordinalIndex }) => {
        const entry = leftovers.shift();
        if (!entry) return;
        consumed.add(entry.tableIndex);
        assignments.push({ cell, entry, group, fallback: true });
        group.entries[ordinalIndex] = entry;
        if (ordinalIndex === 0) group.leader = entry;
      });
    }

    // Safety net: a group must have a leader if it got any assignment.
    rowGroups.forEach((g) => {
      g.entries = (g.entries || []).filter(Boolean); // compact any holes
      if (!g.leader) {
        const a = assignments.find((x) => x.group === g && x.cell === g.cells[0]);
        if (a) g.leader = a.entry;
      }
    });

    return {
      assignments,
      orphanRows: tableRows.filter((r, i) => !consumed.has(i)),
    };
  }

  /* ======================= 4. DRAW ======================= */

  function cellBox(cell) {
    // 1.1.2 nests the sizing rect inside <g data-tm-fill="1" clip-path=...>,
    // so search descendants but skip our own plates.
    const rect = cell.querySelector(
      `rect:not([data-tm-plate]):not([${MARK}-plate])`
    );
    const anchor = cell.querySelector('text[data-tm-anchor]');
    const w = rect ? parseFloat(rect.getAttribute('width')) : NaN;
    const h = rect ? parseFloat(rect.getAttribute('height')) : NaN;
    let cx = anchor ? parseFloat(anchor.getAttribute('x')) : NaN;
    let cy = anchor ? parseFloat(anchor.getAttribute('y')) : NaN;
    if (!Number.isFinite(cx) && Number.isFinite(w)) cx = w / 2;
    if (!Number.isFinite(cy) && Number.isFinite(h)) cy = h / 2;
    return {
      w: Number.isFinite(w) ? w : 0,
      h: Number.isFinite(h) ? h : 0,
      cx: Number.isFinite(cx) ? cx : 0,
      cy: Number.isFinite(cy) ? cy : 0,
    };
  }

  function styleText(text) {
    setA(text, 'font-weight', CFG.FONT_WEIGHT);
    if (CFG.FONT_FAMILY && CFG.FONT_FAMILY !== 'inherit') {
      setA(text, 'font-family', CFG.FONT_FAMILY);
    }
    setA(text, 'fill', CFG.TEXT_FILL);
    setA(text, 'opacity', CFG.TEXT_OPACITY);
    setA(text, 'dominant-baseline', 'central');
    return text;
  }

  function measure(textEl) {
    try {
      const len = textEl.getComputedTextLength();
      if (Number.isFinite(len) && len > 0) return len;
    } catch (e) {
      /* not laid out yet */
    }
    const fs = parseFloat(textEl.getAttribute('font-size')) || CFG.FONT_MAX;
    return (textEl.textContent || '').length * fs * 0.58;
  }

  /**
   * MEASUREMENT
   * -----------
   * Sizing is decided against a hidden scratch <text> instead of the visible
   * labels. Fitting in place would write several font sizes (and truncated
   * strings) per pass, which both flickers and feeds the observer; measuring off
   * to the side means every visible node is written exactly once, already
   * holding its final value. The scratch node lives inside a cell so it inherits
   * the same font context as the real labels.
   */
  let scratch = null;

  function scratchText(root) {
    const host = root && root.querySelector('g[data-tm-cell]');
    if (!host) return null;
    const g = child(host, `g[${MARK}="scratch"]`, 'g', (n) => {
      n.setAttribute(MARK, 'scratch');
      n.setAttribute('aria-hidden', 'true');
      n.setAttribute('pointer-events', 'none');
      n.setAttribute('opacity', '0');
    });
    return styleText(child(g, 'text', 'text'));
  }

  // Measurements are memoised per pass: fitting shared sizes asks for the same
  // string at the same size many times, and each miss is a DOM write + layout.
  const widthCache = new Map();

  function widthOf(str, fs) {
    const s = String(str);
    if (!scratch) return s.length * fs * 0.58; // pre-boot fallback
    const key = `${fs}|${s}`;
    if (widthCache.has(key)) return widthCache.get(key);
    setText(scratch, s);
    setA(scratch, 'font-size', `${fs}px`);
    const w = measure(scratch);
    widthCache.set(key, w);
    return w;
  }

  /**
   * The largest size, walking down from FONT_MAX, at which EVERY item fits.
   * One shared size is what keeps the chart looking consistent when the window
   * (and therefore every cell) gets narrower. Shrinking only ever helps, so a
   * single downward pass over the items is sufficient.
   *
   * @param {Array<{width:(fs:number)=>number, avail:number}>} items
   */
  function commonFontSize(items, minFs) {
    let fs = CFG.FONT_MAX;
    items.forEach((it) => {
      while (it.width(fs) > it.avail && fs - CFG.FONT_STEP >= minFs) {
        fs = +(fs - CFG.FONT_STEP).toFixed(2);
      }
    });
    return fs;
  }

  /**
   * The size Layer 1 uses for the Done-bar count labels. Every cell carries an
   * anchor text node (`text[data-tm-anchor]`) styled exactly like those counts,
   * whether or not it holds a number, so the cell's own anchor is the first
   * place to look and any anchor in the grid is a good enough fallback.
   */
  function doneLabelFont(cell) {
    const own = cell.querySelector('text[data-tm-anchor]');
    const any = own || document.querySelector('g[data-tm-cell] text[data-tm-anchor]');
    const px = any && parseFloat(any.getAttribute('font-size'));
    if (Number.isFinite(px) && px > 0) return px;
    // No attribute? Fall back to whatever the browser actually resolved.
    if (any && window.getComputedStyle) {
      const cs = parseFloat(window.getComputedStyle(any).fontSize);
      if (Number.isFinite(cs) && cs > 0) return cs;
    }
    return CFG.SERIAL_FONT_FALLBACK;
  }

  /**
   * Serial size is LOCKED — never fitted to the cell. Auto-fitting made the
   * numbers change size as the user zoomed, which read as a rendering glitch.
   */
  function serialFontSize(cell) {
    if (typeof CFG.SERIAL_FONT === 'number') return CFG.SERIAL_FONT;
    if (CFG.SERIAL_FONT === 'done-label') return doneLabelFont(cell);
    return null; // 'auto' -> caller fits it the old way
  }

  /** Ellipsise, but only when even the floor size overflows. */
  function clampText(str, fs, avail) {
    if (widthOf(str, fs) <= avail) return String(str);
    let s = String(str);
    while (s.length > 1 && widthOf(`${s}…`, fs) > avail) s = s.slice(0, -1);
    return `${s}…`;
  }

  function plateOf(g) {
    return child(g, `rect[${MARK}-plate]`, 'rect', (r) => {
      r.setAttribute(`${MARK}-plate`, '1');
      r.setAttribute('rx', String(CFG.PLATE_RADIUS));
      r.setAttribute('ry', String(CFG.PLATE_RADIUS));
    });
  }

  function hostGroup(parent, kind) {
    const g = child(parent, `g[${MARK}="${kind}"]`, 'g', (n) => {
      n.setAttribute(MARK, kind);
      n.setAttribute('aria-hidden', 'true');
      n.setAttribute('pointer-events', 'none');
    });
    return g;
  }

  /* --- 4a. serial inside the In-Progress cell --- */

  /**
   * Everything needed to size a serial label, WITHOUT touching the DOM. The
   * jobs for the whole chart are collected first so one shared font size can be
   * chosen, then each job is drawn in a single pass of writes.
   */
  function serialJob(cell, serial) {
    const box = cellBox(cell);
    const avail = Math.max(
      4,
      box.w - 2 * CFG.CELL_PAD_X - (CFG.PLATE ? 2 * CFG.PLATE_PAD_X : 0)
    );
    return {
      cell,
      serial,
      box,
      avail,
      width: (fs) => widthOf(serial, fs),
    };
  }

  function drawSerial(job, fs) {
    const { cell, box } = job;
    const g = hostGroup(cell, 'serial');

    const plate = CFG.PLATE ? plateOf(g) : null;
    const text = styleText(
      child(g, `text[${MARK}-label="serial"]`, 'text', (t) =>
        t.setAttribute(`${MARK}-label`, 'serial')
      )
    );

    // At a locked size the serial simply will not fit in a narrow cell, and
    // that's intended: the trailing "…" tells the user to zoom out.
    const shown = CFG.SERIAL_ELLIPSIS
      ? clampText(job.serial, fs, job.avail)
      : job.serial;
    const len = widthOf(shown, fs);

    setA(text, 'x', box.cx);
    setA(text, 'y', box.cy);
    setA(text, 'text-anchor', 'middle');
    setA(text, 'font-size', `${fs}px`);
    setText(text, shown);

    if (plate) {
      const ph = Math.min(
        fs + 2 * CFG.PLATE_PAD_Y + 2,
        Math.max(6, box.h * CFG.PLATE_MAX_HEIGHT_RATIO)
      );
      const pw = Math.min(len + 2 * CFG.PLATE_PAD_X, Math.max(4, box.w - 1));
      setA(plate, 'fill', CFG.PLATE_FILL);
      setA(plate, 'fill-opacity', CFG.PLATE_OPACITY);
      setA(plate, 'x', box.cx - pw / 2);
      setA(plate, 'y', box.cy - ph / 2);
      setA(plate, 'width', pw);
      setA(plate, 'height', ph);
    }

    setA(cell, `${MARK}-serial`, job.serial);
  }

  /* --- 4b. takt time in the trailing empty cell --- */

  /**
   * Layer 1 prunes foreign DIRECT CHILDREN of the grid root, so the label is
   * hosted inside the target cell. Only when a clipping ancestor sits between
   * the cell and the root (harness <= 1.1.0, where rows were clipped to the bar
   * extent) does it fall back to an external host, which is inserted as the grid
   * root's NEXT SIBLING rather than a child.
   */
  function taktHost(root, group, target) {
    const mode = CFG.TAKT_HOST;
    const clipped = clippedUpTo(target.cell, root);
    if (mode === 'cell' || (mode === 'auto' && !clipped)) {
      return { g: hostGroup(target.cell, 'takt'), local: true };
    }
    let layer = root.parentNode.querySelector(`:scope > g[${MARK}="takt-layer"]`);
    if (!layer) {
      layer = el('g');
      layer.setAttribute(MARK, 'takt-layer');
      layer.setAttribute('aria-hidden', 'true');
      layer.setAttribute('pointer-events', 'none');
      root.parentNode.insertBefore(layer, root.nextSibling);
    }
    const key = `${group.row}:${target.cell.getAttribute('data-tm-cell')}`;
    const g = child(layer, `g[${MARK}="takt"][${MARK}-key="${key}"]`, 'g', (n) => {
      n.setAttribute(MARK, 'takt');
      n.setAttribute(`${MARK}-key`, key);
      n.setAttribute('aria-hidden', 'true');
      n.setAttribute('pointer-events', 'none');
    });
    return { g, local: false };
  }

  /**
   * One takt label per ROW, in the first cell after the bar, listing every
   * In-Progress segment's takt in segment order:
   *
   *     6h 56m [thumb], 13h 0m [thumb]
   *
   * The label may spill across the whole run of trailing empty cells, so a row
   * with two segments does not need two cells.
   */
  function taktJob(root, group) {
    if (taktSkipped(group)) return null;
    const entries = taktEntries(group);
    if (!entries.length) return null;

    // count = 1: a single label, spanning the entire trailing run.
    const targets = taktTargets(group, 1);
    if (!targets.length) return null;
    const target = targets[0];

    const box = cellBox(target.cell);
    // Glyph size is capped by the cell height as well as by the font size.
    const glyphBox = Math.min(
      CFG.FONT_MAX * CFG.THUMB_SCALE,
      Math.max(7, box.h * 0.92)
    );
    const runWidth = box.w * target.span;
    const avail = Math.max(6, runWidth - 2 * CFG.TAKT_PAD_X);

    const parts = entries.map((e) => ({
      takt: norm(e.takt),
      thumb: !!(CFG.THUMB_ENABLED && e.onTime),
      iconHref: e.iconHref,
      serial: norm(e.serial),
    }));

    const width = (fs) => {
      const size = Math.min(glyphBox, fs * CFG.THUMB_SCALE);
      let w = 0;
      parts.forEach((p, i) => {
        w += widthOf(p.takt, fs);
        if (p.thumb) w += CFG.THUMB_GAP + size;
        if (i < parts.length - 1) {
          w +=
            CFG.TAKT_SEP_LEAD +
            widthOf(CFG.TAKT_SEP, fs) +
            CFG.TAKT_SEP_TRAIL;
        }
      });
      return w;
    };

    return { root, group, target, box, glyphBox, avail, parts, width };
  }

  /** Paint the thumbs-up glyph into `holder` at `size` px. */
  function drawThumb(holder, part, size) {
    if (CFG.THUMB_MODE === 'sprite' && part.iconHref) {
      const use = child(holder, 'use', 'use');
      setA(use, 'href', part.iconHref);
      if (use.getAttributeNS(XLINK, 'href') !== part.iconHref) {
        use.setAttributeNS(XLINK, 'href', part.iconHref);
      }
      setA(use, 'width', size);
      setA(use, 'height', size);
      setA(use, 'fill', CFG.THUMB_COLOR);
      setA(use, 'color', CFG.THUMB_COLOR);
    } else {
      const path = child(holder, 'path', 'path');
      setA(path, 'd', CFG.THUMB_PATH);
      setA(path, 'fill', CFG.THUMB_COLOR);
      setA(
        path,
        'transform',
        `scale(${(size / 16).toFixed(4)}) translate(0,${CFG.THUMB_NUDGE_Y})`
      );
    }
  }

  function drawTakt(job, fs) {
    const { root, group, target, box, parts } = job;
    const { g, local } = taktHost(root, group, target);

    if (local) {
      if (g.getAttribute('transform')) g.removeAttribute('transform');
    } else {
      const rowT = translateOf(group.rowEl);
      const cellT = translateOf(target.cell);
      setA(g, 'transform', `translate(${rowT.x + cellT.x},${rowT.y + cellT.y})`);
    }

    const size = Math.min(job.glyphBox, fs * CFG.THUMB_SCALE);
    const total = job.width(fs);
    const start =
      CFG.TAKT_ALIGN === 'middle'
        ? Math.max(CFG.TAKT_PAD_X, box.cx - total / 2)
        : CFG.TAKT_PAD_X;

    const plate = CFG.TAKT_PLATE ? plateOf(g) : null;
    let x = start;

    parts.forEach((p, i) => {
      /* the takt itself */
      const text = styleText(
        child(g, `text[${MARK}-part="${i}"]`, 'text', (t) => {
          t.setAttribute(`${MARK}-part`, String(i));
          t.setAttribute(`${MARK}-label`, 'takt');
        })
      );
      // Only a lone label may be ellipsised; a multi-segment run relies on the
      // shared font size instead so the segments stay comparable.
      const shown =
        parts.length === 1 ? clampText(p.takt, fs, job.avail) : p.takt;
      setA(text, 'y', box.cy);
      setA(text, 'text-anchor', 'start');
      setA(text, 'font-size', `${fs}px`);
      setA(text, 'x', +x.toFixed(3));
      setText(text, shown);
      x += widthOf(shown, fs);

      /* its thumbs-up */
      const thumbSel = `g[${MARK}-thumb="${i}"]`;
      const had = g.querySelector(`:scope > ${thumbSel}`);
      if (p.thumb) {
        const holder =
          had ||
          child(g, thumbSel, 'g', (n) =>
            n.setAttribute(`${MARK}-thumb`, String(i))
          );
        drawThumb(holder, p, size);
        x += CFG.THUMB_GAP;
        setA(
          holder,
          'transform',
          `translate(${x.toFixed(3)},${(box.cy - size / 2).toFixed(3)})`
        );
        x += size;
      } else if (had) {
        had.remove();
      }

      /* separator before the next segment */
      const sepSel = `text[${MARK}-sep="${i}"]`;
      const hadSep = g.querySelector(`:scope > ${sepSel}`);
      if (i < parts.length - 1) {
        const sep = styleText(
          hadSep ||
            child(g, sepSel, 'text', (t) =>
              t.setAttribute(`${MARK}-sep`, String(i))
            )
        );
        x += CFG.TAKT_SEP_LEAD;
        setA(sep, 'y', box.cy);
        setA(sep, 'text-anchor', 'start');
        setA(sep, 'font-size', `${fs}px`);
        setA(sep, 'x', +x.toFixed(3));
        setText(sep, CFG.TAKT_SEP);
        x += widthOf(CFG.TAKT_SEP, fs) + CFG.TAKT_SEP_TRAIL;
      } else if (hadSep) {
        hadSep.remove();
      }
    });

    /* a previous pass may have drawn more segments than this one needs */
    g.querySelectorAll(
      `:scope > [${MARK}-part], :scope > [${MARK}-sep], :scope > [${MARK}-thumb]`
    ).forEach((n) => {
      const raw =
        n.getAttribute(`${MARK}-part`) ||
        n.getAttribute(`${MARK}-sep`) ||
        n.getAttribute(`${MARK}-thumb`);
      if (Number(raw) >= parts.length) n.remove();
    });

    if (plate) {
      const ph = Math.min(
        fs + 2 * CFG.PLATE_PAD_Y + 2,
        Math.max(6, box.h * CFG.PLATE_MAX_HEIGHT_RATIO)
      );
      setA(plate, 'fill', CFG.PLATE_FILL);
      setA(plate, 'fill-opacity', CFG.PLATE_OPACITY);
      setA(plate, 'x', start - CFG.PLATE_PAD_X);
      setA(plate, 'y', box.cy - ph / 2);
      setA(plate, 'width', x - start + 2 * CFG.PLATE_PAD_X);
      setA(plate, 'height', ph);
    }

    const joined = parts.map((p) => p.takt).join(`${CFG.TAKT_SEP} `);
    setA(g, `${MARK}-cell`, target.cell.getAttribute('data-tm-cell') || '');
    setA(g, `${MARK}-row`, group.row);
    setA(g, `${MARK}-takt`, joined);
    setA(g, `${MARK}-ontime`, parts.map((p) => (p.thumb ? '1' : '0')).join(''));
    setA(g, `${MARK}-of`, parts.map((p) => p.serial).join(','));

    if (local) setA(target.cell, `${MARK}-takt`, joined);
    return parts.length;
  }

  /* --- 4c. repeat-serial recolour --- */

  /**
   * Layer 1 gives every cell its own fill envelope:
   *   <g data-tm-fill="1" clip-path="url(#tm-grid-clip-R)" transform="translate(-X,0)">
   *     <rect x="X" y="0" width="70.9" height="H" fill="none"/>
   *   </g>
   * The clip is the bar's rounded outline, so cloning that envelope gives a
   * swatch that lands exactly on the segment — including its rounded end —
   * without measuring any path geometry. The harness rect itself is left alone;
   * Layer 1 owns it and repainting it would restart the ownership fight that
   * caused the 1.1.0 flashing.
   */
  function fillEnvelope(cell) {
    const g = cell.querySelector(`:scope > g[data-tm-fill="1"]`);
    const rect = g && g.querySelector('rect');
    if (!g || !rect) return null;
    return {
      clip: g.getAttribute('clip-path') || '',
      transform: g.getAttribute('transform') || '',
      x: rect.getAttribute('x') || '0',
      y: rect.getAttribute('y') || '0',
      width: rect.getAttribute('width') || '0',
      height: rect.getAttribute('height') || '0',
    };
  }

  /**
   * The colour to borrow from the station a serial first appeared at. The
   * In-Progress fill is a striped <pattern> whose base rect is opaque, so
   * copying the paint server reference reproduces the donor exactly and keeps
   * the striping — no assumption is made about what the fill actually is.
   */
  function donorFill(donorCell) {
    if (CFG.DUP_SOURCE === 'done') {
      const rowEl = donorCell.closest('g[data-tm-row]');
      const done =
        rowEl && rowEl.querySelector('g[data-tm-cell][data-tm-status="Done"]');
      const flat = done && done.getAttribute('data-tm-fill');
      if (flat) return flat;
    }
    return donorCell.getAttribute('data-tm-fill') || '';
  }

  function drawRecolor(cell, fill, tag) {
    const env = fillEnvelope(cell);
    if (!env || !fill) return false;

    let g = cell.querySelector(`:scope > g[${MARK}="recolor"]`);
    if (!g) {
      g = el('g');
      g.setAttribute(MARK, 'recolor');
      g.setAttribute('aria-hidden', 'true');
      g.setAttribute('pointer-events', 'none');
      // First child: paints over the bar path (the whole harness sits above the
      // chart marks) but under our own serial label.
      cell.insertBefore(g, cell.firstChild);
    }
    if (env.clip) setA(g, 'clip-path', env.clip);
    else g.removeAttribute('clip-path');
    if (env.transform) setA(g, 'transform', env.transform);
    else g.removeAttribute('transform');

    const rect = child(g, `rect[${MARK}-swatch="1"]`, 'rect', (n) =>
      n.setAttribute(`${MARK}-swatch`, '1')
    );
    setA(rect, 'x', env.x);
    setA(rect, 'y', env.y);
    setA(rect, 'width', env.width);
    setA(rect, 'height', env.height);
    setA(rect, 'fill', fill);
    setA(rect, 'fill-opacity', CFG.DUP_OPACITY);

    setA(cell, `${MARK}-recolor`, tag);
    return true;
  }

  /**
   * Walk the grid top -> bottom (row letter, then segment ordinal). The first
   * appearance of a serial owns its colour; every later appearance at a
   * different station is repainted with the first station's fill.
   */
  function duplicateRecolors(assignments) {
    const order = assignments.slice().sort((a, b) => {
      const r = String(a.group.row).localeCompare(String(b.group.row));
      if (r) return r;
      return (
        (+a.cell.getAttribute('data-tm-ordinal') || 0) -
        (+b.cell.getAttribute('data-tm-ordinal') || 0)
      );
    });

    const first = new Map();
    const dups = [];
    order.forEach(({ cell, entry, group }) => {
      const serial = norm(entry.serial);
      if (isBlank(serial)) return;
      const k = keyOf(serial);
      const seen = first.get(k);
      if (!seen) {
        first.set(k, { cell, group });
        return;
      }
      if (seen.group === group) return; // two segments of the same station
      const fill = donorFill(seen.cell);
      if (!fill) return;
      dups.push({
        cell,
        fill,
        serial,
        from: seen.group.cat || seen.group.row,
        tag: `${serial}<${seen.group.cat || seen.group.row}`,
      });
    });
    return dups;
  }

  /* --- 4d. x-axis trimming --- */

  /**
   * The x-axis scale runs to 10 so the bars have room to breathe, but the shop
   * never gets past 8, and a bare column labelled 9 or 10 just raises questions.
   * Label, gridline and tick are all faded out together.
   *
   * They are faded rather than removed: Vega owns those nodes, and deleting them
   * would be a fight we'd lose on the next re-render. `opacity` is not in the
   * observer's attributeFilter, so writing it cannot trigger a redraw of our own,
   * and the trim runs on every pass so a re-rendered axis is re-trimmed.
   */

  /** Horizontal position of an axis mark, however the renderer expressed it. */
  function axisX(node) {
    const m = /translate\(\s*([-\d.eE+]+)/.exec(node.getAttribute('transform') || '');
    if (m) return parseFloat(m[1]);
    const a = node.getAttribute('x') || node.getAttribute('x1');
    const v = parseFloat(a);
    return Number.isFinite(v) ? v : null;
  }

  /** Hide (or restore) one axis mark, remembering that it was ours to hide. */
  function fade(node, hide) {
    if (hide) {
      setA(node, 'opacity', '0');
      setA(node, `${MARK}-axis-hidden`, '1');
      return true;
    }
    if (node.getAttribute(`${MARK}-axis-hidden`)) {
      // limit was raised (or trimming switched off) - give it back
      node.removeAttribute(`${MARK}-axis-hidden`);
      setA(node, 'opacity', '1');
    }
    return false;
  }

  /** @returns {number} how many axis marks are currently faded out */
  function trimAxis(roots) {
    const limit = CFG.AXIS_HIDE_ABOVE;
    const on = limit !== null && limit !== undefined;
    let hidden = 0;

    const scopes = new Set();
    roots.forEach((root) => {
      const fig = root.closest('[aria-label][data-tm-grid="1"]') || root.ownerSVGElement;
      if (fig) scopes.add(fig);
    });

    scopes.forEach((scope) => {
      /* 1. the labels themselves, and where the doomed ones sit */
      const doomedX = [];
      scope.querySelectorAll('g.role-axis').forEach((axis) => {
        if (!/^x-axis/i.test(axis.getAttribute('aria-label') || '')) return;
        axis
          .querySelectorAll('g.role-axis-label > text, text.role-axis-label')
          .forEach((t) => {
            const v = parseFloat((t.textContent || '').trim());
            const kill = on && Number.isFinite(v) && v > limit;
            if (kill) {
              const x = axisX(t);
              if (x !== null) doomedX.push(x);
            }
            if (fade(t, kill)) hidden++;
          });
      });

      /* 2. the gridline and tick standing at each of those positions.
         Vega emits the gridlines in their own unlabelled axis group, so there is
         no structural link back to the label - position is the only join, and the
         two groups round their coordinates differently (410 vs 410.4), hence the
         tolerance. */
      const sel = []
        .concat(CFG.AXIS_HIDE_GRID ? ['g.role-axis-grid > line', 'line.role-axis-grid'] : [])
        .concat(CFG.AXIS_HIDE_TICKS ? ['g.role-axis-tick > line', 'line.role-axis-tick'] : []);
      if (!sel.length) return;

      scope.querySelectorAll(sel.join(', ')).forEach((line) => {
        // Vertical marks only: a horizontal rule here is the axis baseline.
        const y2 = parseFloat(line.getAttribute('y2'));
        if (Number.isFinite(y2) && y2 === 0) return;
        const x = axisX(line);
        const kill =
          x !== null &&
          doomedX.some((dx) => Math.abs(dx - x) <= CFG.AXIS_MATCH_TOL);
        if (fade(line, kill)) hidden++;
      });
    });

    return hidden;
  }

  /* --- 4e. cleanup --- */

  function clearSerial(cell) {
    const g = cell.querySelector(`g[${MARK}="serial"]`);
    if (g) g.remove();
    cell.removeAttribute(`${MARK}-serial`);
  }

  function clearTakt(cell) {
    const g = cell.querySelector(`g[${MARK}="takt"]`);
    if (g) g.remove();
    cell.removeAttribute(`${MARK}-takt`);
  }

  function clearRecolor(cell) {
    const g = cell.querySelector(`g[${MARK}="recolor"]`);
    if (g) g.remove();
    cell.removeAttribute(`${MARK}-recolor`);
  }

  function clearStale(keepSerials, keepTaktGroups, keepRecolors) {
    document.querySelectorAll(`g[data-tm-cell][${MARK}-serial]`).forEach((cell) => {
      if (!keepSerials.has(cell)) clearSerial(cell);
    });
    document.querySelectorAll(`g[data-tm-cell][${MARK}-takt]`).forEach((cell) => {
      const g = cell.querySelector(`g[${MARK}="takt"]`);
      if (!g || !keepTaktGroups.has(g)) clearTakt(cell);
    });
    document.querySelectorAll(`g[data-tm-cell][${MARK}-recolor]`).forEach((cell) => {
      if (!keepRecolors || !keepRecolors.has(cell)) clearRecolor(cell);
    });
    document.querySelectorAll(`g[${MARK}="takt-layer"]`).forEach((layer) => {
      Array.from(layer.children).forEach((g) => {
        if (!keepTaktGroups.has(g)) g.remove();
      });
      if (!layer.children.length) layer.remove();
    });
  }

  /* ======================= 5. ORCHESTRATION ======================= */

  let applying = false;
  let lastSignature = '';

  function apply(force) {
    if (applying) return;

    const roots = gridRoots();
    if (!roots.length) return;

    // Runs before the signature check: Vega re-renders the axis on its own
    // schedule, and re-hiding is cheap and idempotent.
    const axisHidden = trimAxis(roots);

    const table = readTable();
    if (!table) {
      warn(`table "${CFG.TABLE_LABEL}" not found — leaving existing labels alone`);
      return;
    }

    const rowGroups = [];
    roots.forEach((root) => rowGroups.push(...inProgressByRow(root)));

    if (!table.rows.length || !rowGroups.length) {
      clearStale(new Set(), new Set(), new Set());
      lastSignature = '';
      return;
    }

    const { assignments, orphanRows } = buildAssignments(table.rows, rowGroups);

    const signature =
      assignments
        .map((a) => {
          const b = cellBox(a.cell);
          return `${a.cell.getAttribute('data-tm-cell')}:${a.entry.serial}:${b.w}`;
        })
        .join('|') +
      '||' +
      rowGroups
        .map((g) => {
          const es = taktEntries(g);
          const ts = taktTargets(g, 1);
          const t = ts[0];
          const run = es
            .map((e) => `${e.takt}/${e.onTime ? 1 : 0}`)
            .join(',');
          return `${g.row}>${
            t ? `${t.cell.getAttribute('data-tm-cell')}x${t.span}` : '-'
          }=${run || '-'}`;
        })
        .join('|') +
      '||' +
      duplicateRecolors(assignments)
        .map((d) => `${d.cell.getAttribute('data-tm-cell')}=${d.fill}`)
        .join('|');

    // Fold in how many of OUR nodes actually still exist, so a Layer 1 pass
    // that silently drops them (without changing any status) still redraws.
    const present = `~${document.querySelectorAll(`g[${MARK}="serial"]`).length}/${
      document.querySelectorAll(`g[${MARK}="takt"]`).length
    }/${document.querySelectorAll(`g[${MARK}="recolor"]`).length}`;

    if (!force && signature + present === lastSignature) return;

    applying = true;
    try {
      scratch = scratchText(roots[0]); // hidden node all measuring runs against
      widthCache.clear(); // cell widths may have changed since the last pass

      /* --- serials: plan every label, size them all alike, then draw --- */
      const keepSerials = new Set();
      const serialJobs = [];
      assignments.forEach(({ cell, entry }) => {
        const serial = norm(entry.serial);
        if (isBlank(serial)) {
          clearSerial(cell); // e.g. the GOAL row, whose serial is "–"
          return;
        }
        serialJobs.push(serialJob(cell, serial));
      });
      // Locked size (default) or, with SERIAL_FONT: 'auto', the old shared fit.
      const lockedFs = serialJobs.length ? serialFontSize(serialJobs[0].cell) : null;
      const serialFs =
        lockedFs !== null
          ? lockedFs
          : CFG.UNIFORM_FONT
          ? commonFontSize(serialJobs, CFG.SERIAL_FONT_MIN)
          : null;
      serialJobs.forEach((job) => {
        drawSerial(
          job,
          serialFs === null
            ? commonFontSize([job], CFG.SERIAL_FONT_MIN)
            : serialFs
        );
        keepSerials.add(job.cell);
      });
      const serials = serialJobs.length;

      /* --- repeat-serial recolour --- */
      const keepRecolors = new Set();
      const recolored = [];
      if (CFG.DUP_RECOLOR) {
        duplicateRecolors(assignments).forEach((d) => {
          if (drawRecolor(d.cell, d.fill, d.tag)) {
            keepRecolors.add(d.cell);
            recolored.push(
              `${d.serial}@${d.cell.getAttribute('data-tm-cell')}<-${d.from}`
            );
          }
        });
      }

      /* --- takt times: one comma-separated label per row --- */
      const keepTaktGroups = new Set();
      let takts = 0;
      let segments = 0;
      const noRoom = [];
      if (CFG.TAKT_ENABLED) {
        const taktJobs = [];
        rowGroups.forEach((group) => {
          const job = taktJob(group.root, group);
          if (!job) {
            if (!taktSkipped(group) && taktEntries(group).length) {
              noRoom.push(group.row);
            }
            return;
          }
          taktJobs.push(job);
        });
        const taktFs = CFG.UNIFORM_FONT
          ? commonFontSize(taktJobs, CFG.FONT_MIN)
          : null;
        taktJobs.forEach((job) => {
          const n = drawTakt(
            job,
            taktFs === null ? commonFontSize([job], CFG.FONT_MIN) : taktFs
          );
          if (!n) return;
          const cellName = job.target.cell.getAttribute('data-tm-cell');
          const g = job.target.cell.querySelector(`g[${MARK}="takt"]`);
          const ext = job.root.parentNode.querySelector(
            `g[${MARK}="takt-layer"] > g[${MARK}-key="${job.group.row}:${cellName}"]`
          );
          if (g) keepTaktGroups.add(g);
          if (ext) keepTaktGroups.add(ext);
          takts++;
          segments += n;
        });
      }

      clearStale(keepSerials, keepTaktGroups, keepRecolors);
      lastSignature = `${signature}~${serials}/${takts}/${recolored.length}`;

      log(
        `${serials}/${assignments.length} serial(s) @${serialFs || 'auto'}px, ` +
          `${takts} takt label(s) over ${segments} segment(s)` +
          (recolored.length ? `; recoloured ${recolored.join(', ')}` : '') +
          (axisHidden ? `; ${axisHidden} x-axis mark(s) hidden` : '') +
          (noRoom.length ? `; no empty cell in row(s) ${noRoom.join(',')}` : '') +
          (orphanRows.length
            ? `; unplaced table row(s): ${orphanRows
                .map((r) => `${r.serial}@${r.workstation}`)
                .join(', ')}`
            : '')
      );
    } finally {
      applying = false;
    }
  }

  let timer = null;
  const schedule = (force) => {
    clearTimeout(timer);
    timer = setTimeout(() => apply(force), CFG.DEBOUNCE_MS);
  };

  function watch() {
    const observer = new MutationObserver((records) => {
      const external = records.some((r) => {
        const t = r.target;
        if (!(t instanceof Element)) return true;
        return !t.closest(OURS);
      });
      if (external) schedule(false);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'data-tm-status',
        'data-tm-ordinal',
        'data-tm-cat',
        'data-tm-cell',
        'data-tm-done',
        'data-tm-grid',
        'data-tm-empty',
        'aria-checked',
        'title',
      ],
    });

    window.addEventListener('resize', () => schedule(true), { passive: true });
    return observer;
  }

  function boot(startedAt) {
    if (gridRoots().length && document.querySelector('g[data-tm-cell][data-tm-status]')) {
      apply(true);
      watch();
      log('Layer 2 v1.6.0 online');
      return;
    }
    if (Date.now() - startedAt > CFG.BOOT_TIMEOUT_MS) {
      warn('Layer 1 grid harness never appeared — Layer 2 idle');
      return;
    }
    setTimeout(() => boot(startedAt), CFG.BOOT_POLL_MS);
  }

  /* Console handle for debugging / manual refresh. */
  window.TM_SN_L2 = {
    version: '1.6.0',
    config: CFG,
    refresh: () => {
      lastSignature = '';
      apply(true);
    },
    clear: () => {
      document.querySelectorAll(`g[data-tm-cell][${MARK}-serial]`).forEach(clearSerial);
      document.querySelectorAll(`g[data-tm-cell][${MARK}-takt]`).forEach(clearTakt);
      document
        .querySelectorAll(`g[data-tm-cell][${MARK}-recolor]`)
        .forEach(clearRecolor);
      document.querySelectorAll(`g[${MARK}="takt-layer"]`).forEach((l) => l.remove());
      document.querySelectorAll(`g[${MARK}="scratch"]`).forEach((n) => n.remove());
      scratch = null;
      lastSignature = '';
    },
    dump: () => {
      const t = readTable();
      const groups = [];
      gridRoots().forEach((r) => groups.push(...inProgressByRow(r)));
      if (t) buildAssignments(t.rows, groups);
      return {
        table: t && t.rows,
        rows: groups.map((g) => {
          const es = taktEntries(g);
          const ts = taktTargets(g, 1);
          return {
            row: g.row,
            cat: g.cat,
            inProgress: g.cells.map((c) => c.getAttribute('data-tm-cell')),
            serials: g.entries ? g.entries.map((e) => e.serial) : [],
            takt: ts.length
              ? {
                  cell: ts[0].cell.getAttribute('data-tm-cell'),
                  span: ts[0].span,
                  segments: es.map((e) => ({
                    value: e.takt,
                    of: e.serial,
                    onTime: e.onTime,
                  })),
                }
              : null,
            hostedInCell: ts.length ? !clippedUpTo(ts[0].cell, g.root) : null,
            recolored: g.cells
              .filter((c) => c.getAttribute(`${MARK}-recolor`))
              .map((c) => `${c.getAttribute('data-tm-cell')}:${c.getAttribute(`${MARK}-recolor`)}`),
          };
        }),
      };
    },
  };

  boot(Date.now());
})();
