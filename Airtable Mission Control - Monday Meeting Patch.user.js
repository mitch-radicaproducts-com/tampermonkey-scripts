// ==UserScript==
// @name         Airtable Mission Control - Monday Meeting Patch
// @namespace    https://radicaproducts.com/
// @version      1.0
// @description  Mission Control only shows the current week; redirects to a last-week version for Monday morning meetings.
// @match        https://airtable.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ─── CONFIG ────────────────────────────────────────────────────────────────
  const DEFAULT_URL =
    'https://airtable.com/apptmE8EpK6ku4mjM/pagZI94ZrXWjYHW7m';

  // Day: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat.
  // Local "HH:MM", 24h. Start inclusive, end exclusive. May wrap the week.
  // First overlapping window wins.
  const WINDOWS = [
    {
      url: 'https://airtable.com/apptmE8EpK6ku4mjM/pagAlXHGeDOUzND5y',
      from: [0, '00:00'],
      to: [1, '09:00'],
    },
    {
      url: 'https://airtable.com/apptmE8EpK6ku4mjM/pagAlXHGeDOUzND5y',
      from: [4, '16:23'],
      to: [4, '16:30'],
    },
    {
      url: 'https://airtable.com/apptmE8EpK6ku4mjM/pagAlXHGeDOUzND5y',
      from: [4, '17:00'],
      to: [4, '17:30'],
    },
  ];

  const POLL_MS = 10000;
  // ───────────────────────────────────────────────────────────────────────────

  if (window.top !== window.self) return;

  const idOf = (url) => {
    try {
      const u = new URL(url, location.href);
      return {
        host: u.hostname.replace(/^www\./, ''),
        path: u.pathname.replace(/\/+$/, ''),
      };
    } catch {
      return null;
    }
  };

  const HERE = idOf(location.href);
  if (!HERE) return;

  // Host must match, and the config path must be a prefix of the current path
  // so Airtable's own appended view/segment suffixes still count as "here".
  const isAt = (url) => {
    const t = idOf(url);
    if (!t) return false;
    if (HERE.host !== t.host && !HERE.host.endsWith('.' + t.host)) return false;
    if (t.path === '') return true;
    return HERE.path === t.path || HERE.path.startsWith(t.path + '/');
  };

  // Only these two pages are touched; every other Airtable page loads normally.
  const MANAGED = [DEFAULT_URL, ...WINDOWS.map((w) => w.url)];
  if (!MANAGED.some(isAt)) return;

  const minutesOfWeek = ([day, hhmm]) => {
    const [h, m] = hhmm.split(':').map(Number);
    return day * 1440 + h * 60 + m;
  };

  const nowMinutes = (d) =>
    d.getDay() * 1440 + d.getHours() * 60 + d.getMinutes();

  const active = (win, t) => {
    const a = minutesOfWeek(win.from);
    const b = minutesOfWeek(win.to);
    return a <= b ? t >= a && t < b : t >= a || t < b;
  };

  function apply() {
    const t = nowMinutes(new Date());
    const target = WINDOWS.find((w) => active(w, t))?.url ?? DEFAULT_URL;
    if (!isAt(target)) location.replace(target);
  }

  apply();
  setInterval(apply, POLL_MS);
})();
