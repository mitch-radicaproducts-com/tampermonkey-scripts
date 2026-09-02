// ==UserScript==
// @name         Mission Control - Schedule Lock Calendar
// @namespace    radicaproducts.com
// @version      1.2.1
// @description  First action is timescale → Custom → 4 weeks (Month view has no Previous week). Then Compact, Hide weekends, Today + Previous week ×2. Holiday names from the Visible Holidays table. Weekend-gray fill on holidays and Fridays. Hourly reset if the range has drifted.
// @author       Mitch
// @match        https://airtable.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/* ====================================================================== *
 * Airtable calendar chrome  (verified against the Interface widget HTML)
 *
 * chart element   [data-testid="page-element:calendar"]
 * toolbar         the 44px .baymax row that holds Previous week / Today /
 *                 Change timescale / calendar-expansion-height-picker
 * footer          the "N products" line in the bottom .px2-and-half
 * date cells      .calendarDate  (weekend fill: colors-background-subtler)
 * range title     [title] on the huge date-range label, e.g. "Aug 16 - Sep 12"
 *
 * Timescale menu  aria-label="Change timescale"
 *                 Custom → dialog: number 1–6 + days|weeks
 *                 Hide weekends lives at the bottom of that same menu
 * Height menu     [data-testid="calendar-expansion-height-picker"]
 *                 Compact | Expanded
 *
 * Hide the nav button cluster (not the whole 44px row) and write a month
 * heading into the huge title, keeping the real range on [title] so
 * isFavoriteView() can still parse it. Collapse the footer. Never
 * display:none / remove(), so button.click() still works. Compare-then-write
 * so the observer cannot loop.
 *
 * Holidays come from the Interface table labeled
 * "Tampermonkey: Visible Holidays" (Holiday Name + Holiday Date). The
 * first complete read is Object.freeze()'d; later table edits are ignored
 * until reload. Names are written under the date number. Holiday and
 * Friday cells use the same colors-background-subtler fill as weekends.
 * ====================================================================== */

(function () {
  'use strict';

  const VERSION = '1.2.1';
  const TICK_MS = 60 * 60 * 1000;
  const STEP_MS = 1000;
  const SETTLE_MS = 2000;
  const CLICK_WAIT_MS = 3000;
  const HIDE_TOOLBAR = true;
  const HIDE_FOOTER = true;
  const HIDE_ATTR = 'data-tm-cal-hide';
  const WEEKEND_BG = 'colors-background-subtler';
  const WEEKDAY_BG = 'colors-background-default';
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, sept: 8, september: 8,
    oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
  };
  const MONTH_LONG = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  const DEBUG = false;
  const log = (...a) => DEBUG && console.log('[schedule-lock]', ...a);
  const say = (...a) => console.info('[schedule-lock]', VERSION, ...a);

  /* ------------------------------------------------------------------ */
  /* Idempotent writes                                                  */
  /* ------------------------------------------------------------------ */

  function setAttr(el, name, value) {
    if (el.getAttribute(name) !== String(value)) el.setAttribute(name, value);
  }

  function dropAttr(el, name) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  }

  function addClass(el, name) {
    if (!el.classList.contains(name)) el.classList.add(name);
  }

  function dropClass(el, name) {
    if (el.classList.contains(name)) el.classList.remove(name);
  }

  function setText(el, value) {
    if (el.textContent !== String(value)) el.textContent = value;
  }

  function ensureStyle() {
    let s = document.getElementById('tm-cal-chrome-style');
    if (!s) {
      s = document.createElement('style');
      s.id = 'tm-cal-chrome-style';
      document.documentElement.appendChild(s);
    }
    const css =
      '[' + HIDE_ATTR + '="nav"]{' +
      'position:absolute!important;width:1px!important;height:1px!important;' +
      'overflow:hidden!important;opacity:0!important;clip:rect(0,0,0,0)!important;' +
      'pointer-events:none!important;border:none!important;' +
      '}' +
      '[' + HIDE_ATTR + '="footer"]{' +
      'height:0!important;min-height:0!important;max-height:0!important;' +
      'margin:0!important;padding:0!important;overflow:hidden!important;' +
      'opacity:0!important;border:none!important;pointer-events:none!important;' +
      '}' +
      '[data-tm-holiday-label]{' +
      'clear:both;display:block;width:100%;box-sizing:border-box;' +
      'font-size:inherit;font-style:italic;font-weight:inherit;line-height:inherit;' +
      'text-align:right;padding:0;max-width:100%;overflow:hidden;word-break:break-word;' +
      'pointer-events:none;color:inherit;' +
      '}';
    if (s.textContent !== css) s.textContent = css;
  }

  /* ------------------------------------------------------------------ */
  /* Holidays: one snapshot from "Tampermonkey: Visible Holidays"       */
  /* ------------------------------------------------------------------ */

  function ymd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  // Airtable levels cells use "September 1, 2026". Also accept ISO and
  // numeric forms so a column-format change does not empty the snapshot.
  function parseHolidayDate(text) {
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    if (!raw) return null;
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3]);
      d.setHours(0, 0, 0, 0);
      return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3]
        ? d
        : null;
    }
    m = /^([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(raw);
    if (m) {
      const month = MONTHS[m[1].toLowerCase()];
      if (month == null) return null;
      const d = new Date(+m[3], month, +m[2]);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(raw);
    if (m) {
      const d = new Date(+m[3], +m[1] - 1, +m[2]);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    return null;
  }

  function holidaysTable() {
    const labels = document.querySelectorAll(
      '[data-testid="page-element-label"], [data-testid="page-element-label"] span'
    );
    for (let i = 0; i < labels.length; i++) {
      const text = (labels[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (!/^tampermonkey:\s*visible holidays$/i.test(text)) continue;
      return labels[i].closest('[data-testid="page-element:levels"]') ||
        labels[i].closest('[data-elementtype="levels"]');
    }
    return null;
  }

  function readHolidayRows() {
    const table = holidaysTable();
    if (!table) return null;
    const rows = table.querySelectorAll('[data-testid="level-row-clickable"]');
    const dict = Object.create(null);
    rows.forEach((row) => {
      let date = null;
      const nodes = row.querySelectorAll('div, span');
      for (let i = 0; i < nodes.length; i++) {
        const t = (nodes[i].textContent || '').replace(/\s+/g, ' ').trim();
        const parsed = parseHolidayDate(t);
        if (parsed) {
          date = parsed;
          break;
        }
      }
      const titles = [...row.querySelectorAll('[title]')]
        .map((el) => (el.getAttribute('title') || '').trim())
        .filter((t) => t && !parseHolidayDate(t));
      let name = titles[0] || '';
      if (!name) {
        const cells = row.querySelectorAll('[data-testid="row-column-container"]');
        for (let i = 0; i < cells.length; i++) {
          const t = (cells[i].textContent || '').replace(/\s+/g, ' ').trim();
          if (t && !parseHolidayDate(t)) {
            name = t;
            break;
          }
        }
      }
      if (name && date) {
        const key = ymd(date);
        if (!dict[key]) dict[key] = name;
      }
    });
    const grid = table.querySelector('[role="treegrid"][aria-rowcount]');
    const expected = grid ? parseInt(grid.getAttribute('aria-rowcount'), 10) : NaN;
    const count = Object.keys(dict).length;
    if (!grid) return count ? dict : null;
    if (expected > 0 && count < expected) return null;
    return dict;
  }

  // Frozen after the first complete read. Later table edits are ignored
  // until the page is reloaded.
  let HOLIDAYS_FROZEN = null;

  function commitHolidays(dict) {
    if (HOLIDAYS_FROZEN) return HOLIDAYS_FROZEN;
    if (!dict) return null;
    HOLIDAYS_FROZEN = Object.freeze(Object.assign(Object.create(null), dict));
    const keys = Object.keys(HOLIDAYS_FROZEN).sort();
    say('holidays frozen', keys.length
      ? keys.map((k) => k + ' ' + HOLIDAYS_FROZEN[k]).join(', ')
      : '(empty table)');
    return HOLIDAYS_FROZEN;
  }

  function tryCommitHolidays() {
    if (HOLIDAYS_FROZEN) return HOLIDAYS_FROZEN;
    if (!holidaysTable()) return null;
    return commitHolidays(readHolidayRows());
  }

  function holidayNameFor(date) {
    return (HOLIDAYS_FROZEN && HOLIDAYS_FROZEN[ymd(date)]) || '';
  }

  /* ------------------------------------------------------------------ */
  /* DOM                                                                */
  /* ------------------------------------------------------------------ */

  const calendar = () =>
    document.querySelector('[data-testid="page-element:calendar"]') ||
    document.querySelector('[data-elementtype="calendar"]') ||
    document.querySelector('[data-testid="calendar-month-view-dates-container"]');

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function buttonText(btn) {
    return (
      (btn.getAttribute('aria-label') || '') + ' ' +
      (btn.getAttribute('aria-description') || '') + ' ' +
      (btn.textContent || '')
    ).replace(/\s+/g, ' ').trim();
  }

  function toolbarButton(re) {
    const root = calendar();
    if (!root) return null;
    return [...root.querySelectorAll('button')].find((b) => re.test(buttonText(b))) || null;
  }

  const buttons = {
    today: () => {
      const root = calendar();
      if (!root) return null;
      return [...root.querySelectorAll('button')].find((b) => {
        const text = (b.textContent || '').replace(/\s+/g, ' ').trim();
        const spoken = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('aria-description') || '');
        return text === 'Today' || /go to today/i.test(spoken);
      }) || null;
    },
    prevWeek: () => {
      const root = calendar();
      if (!root) return null;
      const all = [...root.querySelectorAll('button')];
      const spokenOf = (b) => buttonText(b);
      const byLabel = all.find((b) =>
        /previous week/i.test(spokenOf(b)) && !/(?:4|\d+) weeks/i.test(spokenOf(b))
      );
      if (byLabel) return byLabel;
      const nextIdx = all.findIndex((b) =>
        /next week/i.test(spokenOf(b)) && !/(?:4|\d+) weeks/i.test(spokenOf(b))
      );
      if (nextIdx > 0) return all[nextIdx - 1];
      const prev4 = all.findIndex((b) => /previous (?:4|\d+) weeks/i.test(spokenOf(b)));
      if (prev4 >= 0 && all[prev4 + 1]) return all[prev4 + 1];
      return null;
    },
    nextWeek: () => toolbarButton(/next week/i),
    prevPeriod: () => toolbarButton(/previous 4 weeks|previous \d+ weeks/i),
    nextPeriod: () => toolbarButton(/next 4 weeks|next \d+ weeks/i),
    goToDate: () => toolbarButton(/go to date/i),
    timescale: () => toolbarButton(/change timescale/i),
    height: () =>
      document.querySelector('[data-testid="calendar-expansion-height-picker"]') ||
      toolbarButton(/height of dates|calendar date height/i),
    seeProducts: () => toolbarButton(/see products/i),
  };

  function tap(el) {
    if (!el) return false;
    el.click();
    return true;
  }

  function toolbarRow() {
    const btn = buttons.prevWeek() || buttons.today() || buttons.timescale();
    if (!btn) return null;
    let n = btn;
    const root = calendar();
    while (n && n !== root) {
      if (n.style && n.style.height === '44px') return n;
      if (n.classList && n.classList.contains('baymax') && n.classList.contains('items-center')) return n;
      n = n.parentElement;
    }
    n = btn.parentElement;
    while (n && n !== root) {
      if (n.querySelector && n.querySelector('[aria-label="See products"], [aria-label="Change timescale"]')) {
        if (n.querySelector('.huge, [title]')) return n;
      }
      n = n.parentElement;
    }
    return null;
  }

  function footerRow() {
    const root = calendar();
    if (!root) return null;
    for (const span of root.querySelectorAll('span')) {
      if (!/^\d+\s+products?$/i.test((span.textContent || '').trim())) continue;
      let n = span.parentElement;
      while (n && n !== root) {
        if (n.classList && n.classList.contains('px2-and-half')) return n;
        n = n.parentElement;
      }
      return span.parentElement;
    }
    return null;
  }

  function navControls() {
    const today = buttons.today();
    if (!today) return null;
    const bar = toolbarRow();
    const other = buttons.seeProducts() || buttons.prevWeek() || buttons.timescale();
    let n = today.parentElement;
    while (n && n !== bar) {
      if (other && n.contains(other)) return n;
      n = n.parentElement;
    }
    return today.parentElement;
  }

  function titleEl() {
    const root = calendar();
    return root ? root.querySelector('.huge[title], .huge') : null;
  }

  function monthHeading(range) {
    if (!range || !range.start) return '';
    const a = range.start;
    const b = range.end || range.start;
    const sameMonth = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
    if (sameMonth) return MONTH_LONG[a.getMonth()] + ' ' + a.getFullYear();
    if (a.getFullYear() === b.getFullYear()) {
      return MONTH_LONG[a.getMonth()] + ' – ' + MONTH_LONG[b.getMonth()] + ' ' + a.getFullYear();
    }
    return MONTH_LONG[a.getMonth()] + ' ' + a.getFullYear() +
      ' – ' + MONTH_LONG[b.getMonth()] + ' ' + b.getFullYear();
  }

  // Visible label only. The real "Aug 16 - Sep 12" stays on [title]
  // so isFavoriteView() / currentRange() keep working.
  function applyMonthHeading() {
    const el = titleEl();
    if (!el) return;
    const range = currentRange();
    if (range) rememberRange(range);
    const heading = monthHeading(range);
    if (heading) setText(el, heading);
  }

  function hideChrome() {
    ensureStyle();
    const bar = toolbarRow();
    if (bar) dropAttr(bar, HIDE_ATTR);
    const nav = navControls();
    if (nav) {
      if (HIDE_TOOLBAR) setAttr(nav, HIDE_ATTR, 'nav');
      else dropAttr(nav, HIDE_ATTR);
    }
    const foot = footerRow();
    if (foot) {
      if (HIDE_FOOTER) setAttr(foot, HIDE_ATTR, 'footer');
      else dropAttr(foot, HIDE_ATTR);
    }
    if (HIDE_TOOLBAR) applyMonthHeading();
  }

  /* ------------------------------------------------------------------ */
  /* Menus (Airtable portals these onto document.body)                  */
  /* ------------------------------------------------------------------ */

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitFor(fn, ms) {
    const t0 = Date.now();
    const limit = ms == null ? CLICK_WAIT_MS : ms;
    while (Date.now() - t0 < limit) {
      const v = fn();
      if (v) return v;
      await sleep(50);
    }
    return null;
  }

  function labelled(re) {
    return [...document.querySelectorAll(
      'button, [role="menuitem"], [role="option"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="switch"], label'
    )].find((el) => {
      if (!visible(el) || el.closest('[' + HIDE_ATTR + ']')) return false;
      const text = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).replace(/\s+/g, ' ').trim();
      return re.test(text);
    }) || null;
  }

  function chosen(el) {
    if (!el) return false;
    return (
      el.getAttribute('aria-checked') === 'true' ||
      el.getAttribute('aria-selected') === 'true' ||
      el.getAttribute('data-selected') === 'true' ||
      /(?:^|\s)(?:selected|checked|active)(?:\s|$)/i.test(el.className)
    );
  }

  function dismiss() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
  }

  function fireMouse(el, type, x, y) {
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
    }));
  }

  // Compact's hover tooltip ("Calendar date height") is a portal and survives
  // the menu closing. Leave the trigger, wiggle onto the weekday header, click
  // off — that row has no records, so the click cannot open a card.
  function dismissHoverChrome() {
    dismiss();
    const heightBtn = buttons.height();
    if (heightBtn) {
      const r = heightBtn.getBoundingClientRect();
      fireMouse(heightBtn, 'mouseout', r.left - 12, r.top - 12);
      fireMouse(heightBtn, 'mouseleave', r.left - 12, r.top - 12);
      heightBtn.blur();
    }
    const root = calendar();
    if (!root) return;
    const off = root.querySelector('.flex.mb2') ||
      root.querySelector('[data-testid="calendar-month-view-dates-container"]') ||
      root;
    const r = off.getBoundingClientRect();
    const pts = [
      [r.left + 16, r.top + 6],
      [r.left + r.width / 2, r.top + 6],
      [r.left + r.width / 2, r.top + Math.min(20, r.height / 2)],
    ];
    pts.forEach(([x, y]) => {
      fireMouse(document, 'mousemove', x, y);
      fireMouse(document.elementFromPoint(x, y) || off, 'mousemove', x, y);
    });
    const [x, y] = pts[pts.length - 1];
    const hit = document.elementFromPoint(x, y) || off;
    ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((type) => fireMouse(hit, type, x, y));
  }

  function setInput(el, value) {
    const proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function pressEnter(el) {
    const target = el || document.activeElement || document;
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keypress', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  async function pickFrom(openBtn, itemRe) {
    if (!openBtn) return false;
    tap(openBtn);
    const item = await waitFor(() => labelled(itemRe));
    if (!item) { dismiss(); return false; }
    if (!chosen(item)) tap(item);
    else dismiss();
    await sleep(STEP_MS);
    return true;
  }

  function timescaleLabel() {
    const btn = buttons.timescale();
    return btn ? (btn.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function isFourWeekTimescale() {
    const t = timescaleLabel();
    return /4\s*week/i.test(t) && !/month/i.test(t);
  }

  async function setTimescaleCustom4() {
    const btn = buttons.timescale();
    if (!btn) return false;
    tap(btn);
    await sleep(STEP_MS);
    const custom = await waitFor(() => labelled(/^custom\b/i) || labelled(/custom/i));
    if (custom) {
      tap(custom);
      say('Custom clicked, waiting 1000ms for the dialog');
      await sleep(1000);
      const input = await waitFor(() =>
        [...document.querySelectorAll('input')].find((i) => {
          if (!visible(i) || i.closest('[' + HIDE_ATTR + ']')) return false;
          return i.type === 'number' || i.inputMode === 'numeric' || /^\d*$/.test(i.value);
        })
      );
      if (input) {
        input.focus();
        if (input.value !== '4') setInput(input, '4');
        const weeks = labelled(/^\s*weeks?\s*$/i) || labelled(/\bweeks?\b/i);
        if (weeks && !chosen(weeks)) tap(weeks);
        pressEnter(input);
      } else {
        pressEnter(document.activeElement);
      }
      await sleep(STEP_MS);
      return true;
    }
    const four = labelled(/^4\s*weeks?$/i) || labelled(/4\s*week/i);
    if (four) {
      tap(four);
      await sleep(STEP_MS);
      return true;
    }
    dismiss();
    return false;
  }

  // Month view only has Previous/Next month. Previous week does not exist
  // until the timescale is a week-based custom range. This must run first.
  async function ensureTimescaleCustom4() {
    if (isFourWeekTimescale() && buttons.prevWeek()) {
      say('timescale already', timescaleLabel());
      return true;
    }
    say('setting Custom 4 weeks; now=', timescaleLabel() || '(none)');
    for (let i = 0; i < 4; i++) {
      await setTimescaleCustom4();
      await sleep(STEP_MS);
      if (isFourWeekTimescale() || buttons.prevWeek()) {
        say('timescale ok', timescaleLabel());
        return true;
      }
    }
    say('timescale still', timescaleLabel() || '(none)', 'prevWeek=' + !!buttons.prevWeek());
    return !!(isFourWeekTimescale() || buttons.prevWeek());
  }

  async function enableHideWeekends() {
    const btn = buttons.timescale();
    if (!btn) return false;
    tap(btn);
    const item = await waitFor(() => labelled(/hide weekends/i));
    if (!item) { dismiss(); return false; }
    if (!chosen(item)) tap(item);
    else dismiss();
    await sleep(STEP_MS);
    return true;
  }

  async function setHeightCompact() {
    return pickFrom(buttons.height(), /^\s*compact\s*$/i);
  }

  async function setupOnce() {
    // Timescale first. Month view has no Previous week; every later
    // click depends on Custom 4 weeks being in place.
    await ensureTimescaleCustom4();
    await sleep(STEP_MS);
    await enableHideWeekends();
    await sleep(STEP_MS);
    await setHeightCompact();
    await sleep(STEP_MS);
    dismissHoverChrome();
    say('setup done', 'timescale=' + timescaleLabel());
  }

  /* ------------------------------------------------------------------ */
  /* Holiday paint                                                      */
  /* ------------------------------------------------------------------ */

  function parseRange(text) {
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    // Month-mode heading is just "August 2026" — not a date range.
    if (/^[A-Za-z]{3,9}\s+\d{4}$/.test(raw)) return null;
    const m = raw.match(
      /([A-Za-z]{3,9})\s+(\d{1,2})(?:\s*,\s*(\d{4}))?\s*[-–—]\s*([A-Za-z]{3,9})?\s*(\d{1,2})(?:\s*,\s*(\d{4}))?/
    );
    if (!m) return null;
    const now = new Date();
    const startMonth = MONTHS[m[1].toLowerCase()];
    if (startMonth == null) return null;
    const y0 = m[3] ? parseInt(m[3], 10) : now.getFullYear();
    const start = new Date(y0, startMonth, parseInt(m[2], 10));
    start.setHours(0, 0, 0, 0);
    const endMonth = m[4] ? MONTHS[m[4].toLowerCase()] : startMonth;
    if (endMonth == null) return { start: start, end: null };
    let y1 = m[6] ? parseInt(m[6], 10) : y0;
    if (!m[6] && endMonth < startMonth) y1 = y0 + 1;
    const end = new Date(y1, endMonth, parseInt(m[5], 10));
    end.setHours(0, 0, 0, 0);
    return { start: start, end: end };
  }

  function parseYmd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function rememberRange(range) {
    const el = titleEl();
    if (!el || !range || !range.start) return;
    setAttr(el, 'data-tm-range', ymd(range.start) + '/' + (range.end ? ymd(range.end) : ''));
  }

  function rangeFromMemo() {
    const el = titleEl();
    const memo = el && el.getAttribute('data-tm-range');
    if (!memo) return null;
    const parts = memo.split('/');
    const start = parseYmd(parts[0]);
    if (!start) return null;
    return { start: start, end: parseYmd(parts[1]) };
  }

  function currentRange() {
    const el = titleEl();
    const fromTitle = el && parseRange(el.getAttribute('title') || '');
    if (fromTitle && fromTitle.start) {
      rememberRange(fromTitle);
      return fromTitle;
    }
    const fromText = el && parseRange(el.textContent || '');
    if (fromText && fromText.start) {
      rememberRange(fromText);
      return fromText;
    }
    return rangeFromMemo();
  }

  function rangeStart() {
    const r = currentRange();
    return r ? r.start : null;
  }

  function weekdayHeaders(root) {
    const row = [...root.querySelectorAll('.flex.mb2')].find((el) =>
      DAY_NAMES.some((n) => el.textContent.indexOf(n) !== -1)
    );
    if (!row) return DAY_NAMES.slice();
    const found = [];
    row.querySelectorAll('div').forEach((d) => {
      if (d.children.length) return;
      const t = (d.textContent || '').trim();
      if (DAY_NAMES.indexOf(t) !== -1) found.push(t);
    });
    return found.length ? found : DAY_NAMES.slice();
  }

  function dateCells(root) {
    const box = root.querySelector('[data-testid="calendar-month-view-dates-container"]');
    return [...(box || root).querySelectorAll('.calendarDate')];
  }

  function datesForCells(start, cells, headers) {
    const out = [];
    const weekend = { Sun: 1, Sat: 1 };
    const d = new Date(start);
    if (headers.length < 7) {
      while (weekend[DAY_NAMES[d.getDay()]]) d.setDate(d.getDate() + 1);
    }
    cells.forEach((cell) => {
      if (headers.length < 7) {
        while (weekend[DAY_NAMES[d.getDay()]]) d.setDate(d.getDate() + 1);
      }
      out.push({ cell: cell, date: new Date(d) });
      d.setDate(d.getDate() + 1);
    });
    return out;
  }

  function holidayLabel(cell) {
    return cell.querySelector('[data-tm-holiday-label]');
  }

  function writeHolidayLabel(cell, name) {
    let label = holidayLabel(cell);
    if (!name) {
      if (label) label.remove();
      return;
    }
    const host = cell.firstElementChild || cell;
    if (!label) {
      label = document.createElement('div');
      setAttr(label, 'data-tm-holiday-label', '1');
      host.appendChild(label);
    } else if (label.parentElement !== host) {
      host.appendChild(label);
    }
    setText(label, name);
    const num = host.querySelector('.right') || host.firstElementChild;
    const size = num && window.getComputedStyle ? window.getComputedStyle(num).fontSize : '';
    if (size && label.style.fontSize !== size) label.style.fontSize = size;
  }

  function paintWeekendFill(cell, gray) {
    if (gray) {
      dropClass(cell, WEEKDAY_BG);
      addClass(cell, WEEKEND_BG);
      setAttr(cell, 'data-tm-weekend-paint', '1');
      return;
    }
    if (cell.getAttribute('data-tm-weekend-paint') !== '1' &&
        cell.getAttribute('data-tm-holiday-paint') !== '1') {
      return;
    }
    dropClass(cell, WEEKEND_BG);
    addClass(cell, WEEKDAY_BG);
    dropAttr(cell, 'data-tm-weekend-paint');
    dropAttr(cell, 'data-tm-holiday-paint');
  }

  function paintHolidays() {
    const root = calendar();
    if (!root) return;
    const start = rangeStart(root);
    const cells = dateCells(root);
    if (!start || !cells.length) return;
    const mapped = datesForCells(start, cells, weekdayHeaders(root));
    mapped.forEach(({ cell, date }) => {
      const name = holidayNameFor(date);
      const friday = date.getDay() === 5;
      paintWeekendFill(cell, !!(name || friday));
      if (name) {
        setAttr(cell, 'data-tm-holiday', '1');
        writeHolidayLabel(cell, name);
      } else {
        dropAttr(cell, 'data-tm-holiday');
        writeHolidayLabel(cell, '');
      }
      if (friday) setAttr(cell, 'data-tm-friday', '1');
      else dropAttr(cell, 'data-tm-friday');
    });
  }

  /* ------------------------------------------------------------------ */
  /* Favorite view: Today, then two weeks back                          */
  /* ------------------------------------------------------------------ */

  function rangeTitle() {
    const el = titleEl();
    if (!el) return '';
    const title = (el.getAttribute('title') || '').trim();
    if (parseRange(title)) return title;
    return (el.textContent || '').trim();
  }

  function rangeKey() {
    const r = currentRange();
    if (r && r.start) return ymd(r.start) + ':' + (r.end ? ymd(r.end) : '');
    return rangeTitle();
  }

  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  function weekStartSunday(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    x.setDate(x.getDate() - x.getDay());
    return x;
  }

  // Today, then Previous week ×2, on a 4-week Sunday-start calendar:
  // two weeks back, this week, one week forward.
  function favoriteRange(from) {
    const start = addDays(weekStartSunday(from || new Date()), -14);
    return { start: start, end: addDays(start, 27) };
  }

  function sameDay(a, b) {
    return !!(a && b && ymd(a) === ymd(b));
  }

  // True when the visible range title is already the favorite window.
  // Hide-weekends titles may start on Monday / end on Friday; those are
  // still the same four weeks.
  function isFavoriteView() {
    const got = currentRange();
    if (!got || !got.start) return false;
    const want = favoriteRange();
    const startOk = sameDay(got.start, want.start) ||
      (got.start.getDay() === 1 && sameDay(got.start, addDays(want.start, 1)));
    if (!startOk) return false;
    if (!got.end) return true;
    return sameDay(got.end, want.end) ||
      (got.end.getDay() === 5 && sameDay(got.end, addDays(want.end, -1)));
  }

  function markFavoriteState() {
    const root = calendar();
    if (root) setAttr(root, 'data-tm-favorite', isFavoriteView() ? '1' : '0');
  }

  // Airtable keeps the last-seen range across reloads, and it cannot be
  // told to open on today. This is the whole reset: land on today first,
  // *then* step back two weeks. The three clicks must not share a turn —
  // if they do, React keeps the last navigation (Previous week) and the
  // calendar walks backwards forever.
  async function navClick(getBtn, label) {
    const before = rangeKey();
    const btn = await waitFor(getBtn, CLICK_WAIT_MS);
    if (!btn) {
      say(label + ' button not found');
      return false;
    }
    tap(btn);
    await waitFor(() => {
      const now = rangeKey();
      return now && now !== before;
    }, CLICK_WAIT_MS);
    await sleep(STEP_MS);
    return true;
  }

  async function favoriteView() {
    markFavoriteState();
    if (isFavoriteView()) {
      log('already on favorite view');
      return true;
    }
    const nav = navControls();
    const wasHidden = !!(nav && nav.getAttribute(HIDE_ATTR) === 'nav');
    if (wasHidden) dropAttr(nav, HIDE_ATTR);
    try {
      if (!buttons.prevWeek() || /month/i.test(timescaleLabel())) {
        say('Month (or no Previous week) — setting Custom 4 weeks first');
        await ensureTimescaleCustom4();
        await sleep(STEP_MS);
      }
      if (!buttons.prevWeek()) {
        say('still no Previous week after timescale; not navigating');
        return false;
      }
      await navClick(() => buttons.today(), 'Today');
      await navClick(() => buttons.prevWeek(), 'Previous week');
      await navClick(() => buttons.prevWeek(), 'Previous week');
    } finally {
      if (wasHidden && nav) setAttr(nav, HIDE_ATTR, 'nav');
      markFavoriteState();
    }
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* API for later scripts                                              */
  /* ------------------------------------------------------------------ */

  function buildApi() {
    return {
      version: VERSION,
      holidays: () => HOLIDAYS_FROZEN
        ? Object.keys(HOLIDAYS_FROZEN).sort().map((k) => ({ name: HOLIDAYS_FROZEN[k], date: k }))
        : [],
      calendar: calendar,
      buttons: buttons,
      click: {
        today: () => tap(buttons.today()),
        prevWeek: () => tap(buttons.prevWeek()),
        nextWeek: () => tap(buttons.nextWeek()),
        prevPeriod: () => tap(buttons.prevPeriod()),
        nextPeriod: () => tap(buttons.nextPeriod()),
        goToDate: () => tap(buttons.goToDate()),
        timescale: () => tap(buttons.timescale()),
        height: () => tap(buttons.height()),
        seeProducts: () => tap(buttons.seeProducts()),
      },
      paint: paintHolidays,
      hide: hideChrome,
      favoriteView: favoriteView,
      isFavoriteView: isFavoriteView,
      favoriteRange: () => {
        const r = favoriteRange();
        return { start: ymd(r.start), end: ymd(r.end) };
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Orchestration                                                      */
  /* ------------------------------------------------------------------ */

  let applying = false;
  let setupState = 'pending'; // pending | running | navigating | done
  let ticking = false;

  // Calendar + Today is enough to start. Do not require Previous week, a
  // parseable range, or date cells — those were never appearing on the
  // meeting-room machine, so the old ready check sat for 60s doing nothing.
  // Also never wait on window "load": Airtable SPAs can miss that event.
  function isCalendarReady() {
    return !!(calendar() && buttons.today());
  }

  async function waitUntilReady() {
    say('waiting', 'readyState=' + document.readyState);
    const t0 = Date.now();
    while (document.readyState !== 'complete' && Date.now() - t0 < 15000) {
      await sleep(200);
    }
    const found = await waitFor(isCalendarReady, 90000);
    const root = calendar();
    say(
      'ready?', !!found,
      'doc=' + document.readyState,
      'today=' + !!buttons.today(),
      'prevWeek=' + !!buttons.prevWeek(),
      'cells=' + (root ? dateCells(root).length : 0),
      'range=' + (rangeTitle() || '(none)')
    );
    await sleep(SETTLE_MS);
    return !!found;
  }

  function apply() {
    if (applying || !calendar()) return;
    // Do not collapse the toolbar until Compact / Custom / Hide weekends
    // have been clicked — those menus anchor to the visible buttons.
    if (setupState !== 'done') return;
    applying = true;
    try {
      tryCommitHolidays();
      hideChrome();
      paintHolidays();
      markFavoriteState();
      window.__TM_CAL__ = buildApi();
    } finally {
      applying = false;
    }
  }

  async function boot() {
    if (setupState !== 'pending') return;
    setupState = 'running';
    try {
      const ready = await waitUntilReady();
      if (!ready) say('starting anyway — calendar not fully seen');
      const holidays = await waitFor(() => tryCommitHolidays(), 20000);
      if (!holidays) say('Visible Holidays table not frozen yet');
      await setupOnce();
      await sleep(STEP_MS);
      await waitFor(() => buttons.prevWeek(), 15000);
      setupState = 'navigating';
      await favoriteView();
      if (!isFavoriteView()) {
        say('favorite view missed, retrying once');
        await sleep(STEP_MS);
        await favoriteView();
      }
      await sleep(STEP_MS);
      hideChrome();
      dismissHoverChrome();
      paintHolidays();
      markFavoriteState();
      window.__TM_CAL__ = buildApi();
      say('boot done', 'favorite=' + isFavoriteView());
    } catch (e) {
      console.warn('[schedule-lock] setup failed:', e);
    }
    setupState = 'done';
    if (!ticking) {
      ticking = true;
      let inFlight = false;
      async function runFavoriteView() {
        if (inFlight) return;
        inFlight = true;
        try {
          await favoriteView();
        } finally {
          inFlight = false;
        }
      }
      setInterval(runFavoriteView, TICK_MS);
    }
  }

  const MIN_GAP = 250;
  let timer = null;
  let last = 0;

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      last = Date.now();
      apply();
      if (setupState === 'pending') boot();
    }, Math.max(80, MIN_GAP - (Date.now() - last)));
  }

  new MutationObserver(() => schedule()).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'title', 'aria-label'],
  });

  let tries = 0;
  const poll = setInterval(() => {
    schedule();
    if (++tries > 120 || setupState !== 'pending') clearInterval(poll);
  }, 500);

  say('script loaded', location.pathname);
  window.addEventListener('load', () => schedule());
  schedule();
})();
