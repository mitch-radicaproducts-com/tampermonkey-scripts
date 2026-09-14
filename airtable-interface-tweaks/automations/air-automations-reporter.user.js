// ==UserScript==
// @name         Airtable Automations Reporter - Crawler
// @namespace    air-automations-reporter
// @version      1.5.0
// @description  Crawl Airtable Automations tabs and POST monthly run counts to Google Apps Script.
// @match        https://airtable.com/apptmE8EpK6ku4mjM/*
// @match        https://airtable.com/appyNKedN0QzytZkd/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @noframes
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // --- config --------------------------------------------------------------
  // Leave one Automations tab open. Tampermonkey does not run if Chrome is closed.
  const BASES = [
    { id: "apptmE8EpK6ku4mjM", url: "https://airtable.com/apptmE8EpK6ku4mjM/automations" },
    { id: "appyNKedN0QzytZkd", url: "https://airtable.com/appyNKedN0QzytZkd/automations" },
  ];
  const INTERVAL_MS = 30 * 60 * 1000;
  const WEBHOOK_URL = "";
  const WEBHOOK_TOKEN = "airtable-runs-demo";
  const AUTO_START = true;
  // -------------------------------------------------------------------------

  const STORAGE_KEY = "air-automations-reporter:v1";
  const CRAWL_KEY = "air-automations-reporter:crawl:v1";
  const WEBHOOK_SETTINGS_KEY = "air-automations-reporter:webhook:v1";
  const WEBHOOK_LOG_KEY = "air-automations-reporter:webhook-log:v1";
  const RUNS_RE = /^([\d,]+)\s+runs?\s+this\s+month$/i;
  const PANEL_ID = "air-automations-reporter-panel";
  const PANEL_STYLE_ID = "air-automations-reporter-panel-style";
  const AUTOMATIONS_TAB_SELECTOR = 'a[data-tutorial-selector-id="automations"]';

  let waitTimer = 0;
  let scanning = false;
  let timerReady = false;
  let crawlStarted = false;
  let syncTimer = 0;

  function gmGet(key, fallback) {
    try {
      if (typeof GM_getValue === "function") return GM_getValue(key, fallback);
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : raw;
    } catch {
      return fallback;
    }
  }

  function gmSet(key, value) {
    if (typeof GM_setValue === "function") GM_setValue(key, value);
    else localStorage.setItem(key, value);
  }

  function gmReadJson(key, fallback) {
    try {
      const raw = gmGet(key, "");
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function gmWriteJson(key, value) {
    gmSet(key, JSON.stringify(value));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitUntil(predicate, { timeout = 25000, interval = 200 } = {}) {
    const started = Date.now();
    let value = predicate();
    while (!value && Date.now() - started < timeout) {
      await sleep(interval);
      value = predicate();
    }
    return value;
  }

  function automationsTabLink(doc) {
    return (doc || document).querySelector(AUTOMATIONS_TAB_SELECTOR);
  }

  function isAutomationsTab(doc) {
    return automationsTabLink(doc || document)?.getAttribute("aria-current") === "page";
  }

  function parseBaseContext(doc) {
    const path =
      (doc || document).querySelector(AUTOMATIONS_TAB_SELECTOR)?.getAttribute("href") ||
      location.pathname;
    const baseId = (path.match(/\/(app[A-Za-z0-9]+)/) || [])[1] || "";
    const menu = (doc || document).querySelector('[data-tutorial-selector-id="openBaseMenuButton"]');
    const baseName = (menu?.textContent || "").replace(/\s+/g, " ").trim();
    return { baseId, baseName };
  }

  function parseAutomationsList(doc) {
    const list = (doc || document).querySelector('[aria-label="Automations list"]');
    if (!list) return [];
    const rows = [];
    for (const item of list.querySelectorAll('li[data-rfd-draggable-id^="wfl"]')) {
      const id = item.getAttribute("data-rfd-draggable-id") || "";
      const button = item.querySelector('[role="button"][aria-label]');
      const name = (button?.getAttribute("aria-label") || "").trim();
      if (!id || !name) continue;
      const section = (item.closest("li[aria-label]")?.getAttribute("aria-label") || "").trim();
      const paras = item.querySelectorAll(".flex-column p");
      const description = (paras[1]?.textContent || "").replace(/\s+/g, " ").trim();
      let status = "";
      for (const badge of item.querySelectorAll(".stronger")) {
        const text = (badge.textContent || "").trim();
        if (text === "ON" || text === "OFF") {
          status = text;
          break;
        }
      }
      rows.push({
        id,
        name,
        section,
        description,
        status,
        selected: Boolean(button?.classList.contains("colors-background-selected")),
      });
    }
    return rows;
  }

  function parseSelectedHeader(doc) {
    const name = ((doc || document).querySelector('[data-testid="workflowName"]')?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!name) return null;
    let enabled = null;
    for (const box of (doc || document).querySelectorAll('[role="checkbox"]')) {
      const labelId = box.getAttribute("aria-labelledby");
      const label = labelId ? (doc || document).getElementById(labelId) : null;
      if (/^Automation is (on|off)$/i.test((label?.textContent || "").trim())) {
        enabled = box.getAttribute("aria-checked") === "true";
        break;
      }
    }
    let runsThisMonth = null;
    for (const p of (doc || document).querySelectorAll("p")) {
      const match = (p.textContent || "").replace(/\s+/g, " ").trim().match(RUNS_RE);
      if (match) {
        runsThisMonth = Number.parseInt(match[1].replace(/,/g, ""), 10);
        break;
      }
    }
    return { name, enabled, runsThisMonth };
  }

  async function waitForSelectedAutomation(doc, expectedName, { timeout = 6000, interval = 80 } = {}) {
    const started = Date.now();
    let lastMatch = null;
    let stableCount = 0;
    while (Date.now() - started < timeout) {
      const header = parseSelectedHeader(doc);
      const nameMatches = header && header.name === expectedName;
      const hasRuns = nameMatches && header.runsThisMonth != null;
      if (hasRuns) {
        if (
          lastMatch &&
          lastMatch.runsThisMonth === header.runsThisMonth &&
          lastMatch.enabled === header.enabled
        ) {
          stableCount += 1;
          if (stableCount >= 2) return header;
        } else {
          lastMatch = header;
          stableCount = 1;
        }
      } else if (nameMatches) {
        lastMatch = header;
        stableCount = 0;
      } else {
        lastMatch = null;
        stableCount = 0;
      }
      await sleep(interval);
    }
    return lastMatch;
  }

  function mergeRow(base, listItem, header, capturedAt = new Date()) {
    return {
      capturedAt: capturedAt.toISOString(),
      month: `${capturedAt.getFullYear()}-${String(capturedAt.getMonth() + 1).padStart(2, "0")}`,
      baseId: base.baseId,
      baseName: base.baseName,
      section: listItem.section,
      automationId: listItem.id,
      automationName: header?.name || listItem.name,
      description: listItem.description,
      status: listItem.status,
      enabled: header?.enabled ?? (listItem.status === "ON" ? true : listItem.status === "OFF" ? false : null),
      runsThisMonth: header?.runsThisMonth ?? null,
    };
  }

  function workspaceTotal(rows) {
    return rows.reduce((sum, row) => sum + (Number(row.runsThisMonth) || 0), 0);
  }

  function storedMap() {
    return gmReadJson(STORAGE_KEY, {}) || {};
  }

  function allRows() {
    return Object.values(storedMap());
  }

  function remember(rows) {
    const map = storedMap();
    for (const row of rows) {
      if (row.automationId) map[row.automationId] = row;
    }
    gmWriteJson(STORAGE_KEY, map);
  }

  function defaultCrawl() {
    return {
      autoEnabled: AUTO_START,
      phase: "idle",
      scannedBaseIds: [],
      nextScanAt: 0,
      continueUntil: 0,
      lastDownloadAt: 0,
      lastError: "",
    };
  }

  function loadCrawl() {
    return { ...defaultCrawl(), ...gmReadJson(CRAWL_KEY, {}) };
  }

  function saveCrawl(state) {
    gmWriteJson(CRAWL_KEY, state);
  }

  function loadWebhook() {
    const saved = gmReadJson(WEBHOOK_SETTINGS_KEY, {}) || {};
    return {
      url: (saved.url || WEBHOOK_URL || "").trim(),
      token: (saved.token || WEBHOOK_TOKEN || "").trim(),
    };
  }

  function saveWebhook(settings) {
    gmWriteJson(WEBHOOK_SETTINGS_KEY, {
      url: (settings.url || "").trim(),
      token: (settings.token || "").trim(),
    });
  }

  function loadWebhookLog() {
    return gmReadJson(WEBHOOK_LOG_KEY, null);
  }

  function saveWebhookLog(log) {
    gmWriteJson(WEBHOOK_LOG_KEY, log);
  }

  function currentBaseSpec() {
    const id = parseBaseContext(document).baseId;
    return BASES.find((base) => base.id === id) || null;
  }

  function nextUnscanned(state) {
    return BASES.find((base) => !state.scannedBaseIds.includes(base.id)) || null;
  }

  function formatClock(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  // Keep in sync with lib/schedule.js.
  function planResume(crawl, now, intervalMs) {
    if (!crawl.autoEnabled) {
      return {
        action: "idle",
        phase: crawl.phase === "scanning" ? "idle" : crawl.phase || "idle",
        nextScanAt: crawl.nextScanAt || 0,
        continueUntil: 0,
      };
    }
    if (crawl.phase === "scanning" && (crawl.continueUntil || 0) > now) {
      return {
        action: "continue-scan",
        phase: "scanning",
        nextScanAt: crawl.nextScanAt || 0,
        continueUntil: crawl.continueUntil,
      };
    }
    return {
      action: "wait",
      phase: "waiting",
      nextScanAt: crawl.nextScanAt > now ? crawl.nextScanAt : now + intervalMs,
      continueUntil: 0,
    };
  }

  function planAfterFinish(now, intervalMs) {
    return { phase: "waiting", nextScanAt: now + intervalMs, continueUntil: 0 };
  }

  function planCycleStart(now, crawlWindowMs) {
    return { phase: "scanning", scannedBaseIds: [], continueUntil: now + crawlWindowMs };
  }

  function summarizeByBase(rows) {
    const byId = new Map();
    for (const row of rows) {
      const id = row.baseId || "unknown";
      const current = byId.get(id) || {
        baseId: id,
        baseName: row.baseName || id,
        automations: 0,
        runsThisMonth: 0,
      };
      current.automations += 1;
      current.runsThisMonth += Number(row.runsThisMonth) || 0;
      if (row.baseName) current.baseName = row.baseName;
      byId.set(id, current);
    }
    return [...byId.values()].sort((a, b) => b.runsThisMonth - a.runsThisMonth);
  }

  function persistWebhookFromPanel() {
    const panel = document.getElementById(PANEL_ID);
    const url = (panel?.querySelector('[data-role="webhook-url"]')?.value || "").trim();
    const token = (panel?.querySelector('[data-role="webhook-token"]')?.value || "").trim();
    if (url) saveWebhook({ url: normalizeWebhookUrl(url), token: token || WEBHOOK_TOKEN });
    return loadWebhook();
  }

  function normalizeWebhookUrl(url) {
    return String(url || "").trim().replace(/\/+$/, "");
  }

  function webhookUrlProblem(url) {
    if (!url) return "no webhook URL";
    if (/\/dev$/i.test(url)) return "That is the /dev URL. Use the /exec Web app URL.";
    if (/console\.cloud\.google\.com/i.test(url) || /cloudfunctions\.net/i.test(url) || /\.run\.app/i.test(url)) {
      return "That looks like a Google Cloud URL. Use the Apps Script Web app URL ending in /exec.";
    }
    return "";
  }

  function explainWebhookFailure(status, extra) {
    if (status === 404) {
      return (
        "Google returned 404. Deploy as Web app, Execute as: Me, Who has access: Anyone " +
        "(not “Anyone with a Google account”)." +
        (extra ? ` ${extra}` : "")
      );
    }
    return extra || "";
  }

  function postWebhook(url, payload, { anonymous = true } = {}) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "POST",
        url,
        anonymous,
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        data: JSON.stringify(payload),
        timeout: 30000,
        onload: (response) => {
          let parsed = null;
          try {
            parsed = JSON.parse(response.responseText);
          } catch {
            parsed = null;
          }
          resolve({
            ok: response.status >= 200 && response.status < 400 && parsed?.ok !== false,
            status: response.status,
            body: (response.responseText || "").slice(0, 500),
            spreadsheetUrl: parsed?.spreadsheetUrl || "",
            fileUrl: parsed?.fileUrl || "",
            fileName: parsed?.fileName || "",
            slack: parsed?.slack || null,
            error: parsed?.error || "",
            at: Date.now(),
          });
        },
        onerror: (response) => {
          resolve({
            ok: false,
            status: response.status || 0,
            body: response.responseText || "",
            error: "network error",
            at: Date.now(),
          });
        },
        ontimeout: () => resolve({ ok: false, status: 0, error: "timeout", at: Date.now() }),
      });
    });
  }

  async function transmit(rows, { test = false } = {}) {
    const hook = persistWebhookFromPanel();
    const url = normalizeWebhookUrl(hook.url);
    const problem = webhookUrlProblem(url);
    if (problem) {
      const result = { ok: false, status: 0, error: problem, at: Date.now() };
      saveWebhookLog(result);
      return result;
    }
    if (typeof GM_xmlhttpRequest !== "function") {
      return { ok: false, error: "GM_xmlhttpRequest unavailable" };
    }

    const payload = {
      token: hook.token,
      scannedAt: new Date().toISOString(),
      rows,
      totalRuns: workspaceTotal(rows),
      test,
    };

    let result = await postWebhook(url, payload, { anonymous: true });
    if (!result.ok && (result.status === 404 || result.status === 401)) {
      result = await postWebhook(url, payload, { anonymous: false });
    }
    if (!result.ok) result.error = explainWebhookFailure(result.status, result.error);
    saveWebhookLog(result);
    return result;
  }

  function testPingRows() {
    const now = new Date();
    return [
      {
        capturedAt: now.toISOString(),
        month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
        baseId: "apptmE8EpK6ku4mjM",
        baseName: "TEST PING",
        section: "Webhook test",
        automationId: "wflTESTPING",
        automationName: "Tampermonkey test ping",
        description: "Confirms Apps Script received a POST. Does not replace Latest.",
        status: "ON",
        enabled: true,
        runsThisMonth: 0,
      },
    ];
  }

  async function sendTestPing() {
    const hook = persistWebhookFromPanel();
    if (!hook.url) {
      setStatus("Paste your Apps Script /exec URL first, then Save webhook.");
      return;
    }
    setStatus("Sending test ping…");
    const result = await transmit(testPingRows(), { test: true });
    setStatus(
      result.ok
        ? `Webhook OK (${result.status}).${result.slack?.ok === false ? ` Slack: ${result.slack.error}` : ""}`
        : `Webhook failed (${result.status || "no HTTP"}): ${result.error || result.body || "unknown error"}`
    );
    renderPanel();
  }

  async function publishReport() {
    const rows = allRows();
    if (!rows.length) return { ok: false, reason: "no rows" };
    const sent = await transmit(rows);
    const crawl = loadCrawl();
    crawl.lastDownloadAt = Date.now();
    crawl.lastError = sent.ok || !loadWebhook().url ? "" : sent.error || "webhook failed";
    saveCrawl(crawl);
    return { ok: true, sent: sent.ok };
  }

  function realClick(el) {
    if (!el) return;
    if (typeof el.focus === "function") el.focus();
    if (typeof el.click === "function") el.click();
  }

  function escapeHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function setStatus(text) {
    const el = document.querySelector(`#${PANEL_ID} [data-role="status"]`);
    if (el) el.textContent = text;
  }

  function removePanel() {
    document.getElementById(PANEL_ID)?.remove();
    document.getElementById(PANEL_STYLE_ID)?.remove();
  }

  function ensurePanel() {
    if (!isAutomationsTab(document)) {
      removePanel();
      return null;
    }
    const existing = document.getElementById(PANEL_ID);
    if (existing) return existing;

    const style = document.createElement("style");
    style.id = PANEL_STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
        width: min(440px, calc(100vw - 24px)); max-height: calc(100vh - 24px);
        overflow: auto; background: #17181c; color: #f4f4f5;
        font: 13px/1.4 "IBM Plex Sans", "Segoe UI", sans-serif;
        border-radius: 16px; box-shadow: 0 16px 48px rgba(0,0,0,.35); padding: 14px 14px 12px;
      }
      #${PANEL_ID} h1 { font-size: 14px; margin: 0 0 4px; }
      #${PANEL_ID} .sub { color: #b4b8c2; margin: 0 0 10px; font-size: 12px; }
      #${PANEL_ID} .row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
      #${PANEL_ID} button {
        border: 0; border-radius: 8px; padding: 7px 10px; font-weight: 700; cursor: pointer;
      }
      #${PANEL_ID} button[disabled] { opacity: .55; cursor: wait; }
      #${PANEL_ID} .primary { background: #2d7ff9; color: #fff; }
      #${PANEL_ID} .ghost { background: #2a2d34; color: #fff; }
      #${PANEL_ID} .on { background: #11b05a; color: #fff; }
      #${PANEL_ID} label { display: block; font-size: 11px; color: #8b909b; margin: 8px 0 3px; }
      #${PANEL_ID} input {
        width: 100%; box-sizing: border-box; border: 0; border-radius: 8px;
        padding: 7px 8px; background: #2a2d34; color: #fff;
      }
      #${PANEL_ID} .status { color: #c6cad3; min-height: 16px; margin: 8px 0; white-space: pre-wrap; }
      #${PANEL_ID} table { width: 100%; border-collapse: collapse; font-size: 12px; }
      #${PANEL_ID} th, #${PANEL_ID} td { text-align: left; padding: 5px 4px; border-bottom: 1px solid #2e3138; }
      #${PANEL_ID} td.num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 700; }
      #${PANEL_ID} tr.hot td { color: #ffb020; }
      #${PANEL_ID} .min { color: #8b909b; }
    `;
    document.documentElement.appendChild(style);

    const panel = document.createElement("aside");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <h1>air-automations-reporter</h1>
      <p class="sub">Auto waits 30 minutes after this Automations tab is ready, then after each finished crawl. Crawl both now is immediate.</p>
      <div class="row">
        <button class="primary" type="button" data-action="crawl">Crawl both now</button>
        <button class="ghost" type="button" data-action="auto">Auto: …</button>
        <button class="ghost" type="button" data-action="scan">Scan this base</button>
        <button class="ghost" type="button" data-action="clear">Clear</button>
      </div>
      <label for="airtable-webhook-url">Google Apps Script URL</label>
      <input id="airtable-webhook-url" data-role="webhook-url" type="url" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off">
      <label for="airtable-webhook-token">Webhook token</label>
      <input id="airtable-webhook-token" data-role="webhook-token" type="text" placeholder="airtable-runs-demo" autocomplete="off">
      <div class="row">
        <button class="ghost" type="button" data-action="save-webhook">Save webhook</button>
        <button class="primary" type="button" data-action="test-webhook">Send test ping</button>
      </div>
      <div class="status" data-role="status"></div>
      <div data-role="table"></div>
    `;
    document.documentElement.appendChild(panel);

    const hook = loadWebhook();
    panel.querySelector('[data-role="webhook-url"]').value = hook.url;
    panel.querySelector('[data-role="webhook-token"]').value = hook.token;
    panel.addEventListener("click", (event) => {
      const action = event.target?.getAttribute?.("data-action");
      if (action === "scan") scanCurrentBase();
      if (action === "crawl") startCycle({ force: true });
      if (action === "auto") toggleAuto();
      if (action === "save-webhook") {
        persistWebhookFromPanel();
        setStatus("Webhook saved. Click Send test ping.");
      }
      if (action === "test-webhook") sendTestPing();
      if (action === "clear") {
        gmWriteJson(STORAGE_KEY, {});
        renderPanel();
      }
    });
    return panel;
  }

  function renderPanel() {
    if (!isAutomationsTab(document)) {
      removePanel();
      return;
    }
    const panel = ensurePanel();
    if (!panel) return;

    const rows = allRows();
    const bases = summarizeByBase(rows);
    const list = parseAutomationsList(document);
    const base = parseBaseContext(document);
    const crawl = loadCrawl();
    const hook = loadWebhook();
    const log = loadWebhookLog();
    const autoBtn = panel.querySelector('[data-action="auto"]');
    autoBtn.textContent = crawl.autoEnabled ? "Auto: ON" : "Auto: OFF";
    autoBtn.classList.toggle("on", crawl.autoEnabled);

    const lines = [
      `${base.baseName || base.baseId || "This base"}: ${list.length} automations in the list.`,
    ];
    if (rows.length) {
      lines.push(`${bases.length} bases · ${workspaceTotal(rows).toLocaleString("en-US")} runs this month`);
    }
    if (crawl.autoEnabled) {
      if (scanning) lines.push("Crawling now — don't use this tab until it finishes.");
      else if (crawl.nextScanAt > Date.now()) lines.push(`Next crawl at ${formatClock(crawl.nextScanAt)}.`);
      else if (crawl.phase === "scanning") lines.push(`Crawling ${crawl.scannedBaseIds.length + 1} / ${BASES.length} bases.`);
      else lines.push("Auto is on. Waiting a full interval before the next crawl.");
    }
    if (crawl.lastDownloadAt) lines.push(`Last send: ${formatClock(crawl.lastDownloadAt)}`);
    if (crawl.lastError) lines.push(`Last error: ${crawl.lastError}`);
    if (!hook.url) {
      lines.push("Paste the /exec URL, Save webhook, then Send test ping.");
    } else if (log) {
      lines.push(
        `Last webhook: ${log.ok ? "OK" : "FAILED"} ${log.status || ""} ${formatClock(log.at)}` +
          (log.slack?.ok === false ? `\nSlack: ${log.slack.error}` : "") +
          (log.error ? `\n${log.error}` : "")
      );
    } else {
      lines.push("Webhook URL saved. Click Send test ping.");
    }
    panel.querySelector('[data-role="status"]').textContent = lines.join("\n");

    const urlEl = panel.querySelector('[data-role="webhook-url"]');
    const tokenEl = panel.querySelector('[data-role="webhook-token"]');
    if (urlEl && document.activeElement !== urlEl) urlEl.value = hook.url;
    if (tokenEl && document.activeElement !== tokenEl) tokenEl.value = hook.token;

    const table = panel.querySelector('[data-role="table"]');
    if (!bases.length) {
      table.innerHTML = `<p class="min">Nothing saved yet.</p>`;
      return;
    }
    table.innerHTML = `
      <table>
        <thead><tr><th>Base</th><th>Automations</th><th>Runs this month</th></tr></thead>
        <tbody>
          ${bases
            .map((item, index) => {
              const hot = index === 0 && item.runsThisMonth > 0;
              return `<tr class="${hot ? "hot" : ""}">
                <td>${escapeHtml(item.baseName)}</td>
                <td class="num">${item.automations}</td>
                <td class="num">${item.runsThisMonth.toLocaleString("en-US")}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    `;
  }

  async function scanCurrentBase() {
    if (!isAutomationsTab(document)) return { ok: false, error: "not on automations tab" };
    const panel = ensurePanel();
    if (!panel) return { ok: false, error: "not on automations tab" };
    const scanBtn = panel.querySelector('[data-action="scan"]');

    let list = parseAutomationsList(document);
    if (!list.length) {
      await waitUntil(() => isAutomationsTab(document) && parseAutomationsList(document).length);
      await sleep(400);
      list = parseAutomationsList(document);
    }
    if (!list.length) {
      const error = "Could not find the automations list after waiting.";
      setStatus(error);
      return { ok: false, error };
    }

    const base = parseBaseContext(document);
    scanBtn.disabled = true;
    scanning = true;
    const collected = [];
    try {
      const toScan = list.filter((item) => item.status !== "OFF");
      const skippedOff = list.length - toScan.length;
      for (let index = 0; index < toScan.length; index += 1) {
        const item = toScan[index];
        setStatus(
          `Scanning ${base.baseName || base.baseId}: ${index + 1} / ${toScan.length}` +
            (skippedOff ? ` (${skippedOff} off skipped)` : "") +
            `: ${item.name}`
        );
        const button = document.querySelector(
          `li[data-rfd-draggable-id="${item.id}"] [role="button"][aria-label]`
        );
        realClick(button);
        const header = await waitForSelectedAutomation(document, item.name);
        const fresh = parseAutomationsList(document).find((row) => row.id === item.id) || item;
        collected.push(mergeRow(base, fresh, header || parseSelectedHeader(document)));
        await sleep(280);
      }
      remember(collected);
      renderPanel();
      return { ok: true, rows: collected, baseId: base.baseId };
    } catch (error) {
      const message = error.message || String(error);
      setStatus(`Scan failed: ${message}`);
      return { ok: false, error: message };
    } finally {
      scanning = false;
      scanBtn.disabled = false;
    }
  }

  function goTo(url) {
    location.assign(url);
  }

  async function scanAndAdvance() {
    const spec = currentBaseSpec();
    const crawl = loadCrawl();
    if (!spec) {
      goTo((nextUnscanned(crawl) || BASES[0]).url);
      return;
    }
    if (!isAutomationsTab(document)) {
      const tab = automationsTabLink(document);
      if (tab && tab.getAttribute("aria-current") !== "page") {
        goTo(tab.getAttribute("href") || spec.url);
        return;
      }
      const ready = await waitUntil(() => isAutomationsTab(document));
      if (!ready) {
        goTo(tab?.getAttribute("href") || spec.url);
        return;
      }
    }
    const result = await scanCurrentBase();
    const nextState = loadCrawl();
    if (!result.ok) {
      nextState.lastError = result.error || "scan failed";
      nextState.phase = "waiting";
      nextState.nextScanAt = Date.now() + 2 * 60 * 1000;
      saveCrawl(nextState);
      scheduleWait();
      renderPanel();
      return;
    }
    if (!nextState.scannedBaseIds.includes(spec.id)) nextState.scannedBaseIds.push(spec.id);
    nextState.lastError = "";
    saveCrawl(nextState);
    const remaining = nextUnscanned(nextState);
    if (remaining) {
      setStatus(`Finished ${spec.id}. Opening ${remaining.id}…`);
      goTo(remaining.url);
      return;
    }
    await finishCycle();
  }

  async function finishCycle() {
    const published = await publishReport();
    const crawl = loadCrawl();
    Object.assign(crawl, planAfterFinish(Date.now(), INTERVAL_MS));
    if (!published.ok) crawl.lastError = published.reason || "webhook failed";
    saveCrawl(crawl);
    const log = loadWebhookLog();
    const webhookLine = loadWebhook().url
      ? log?.ok
        ? `Webhook OK.${log?.slack?.ok === false ? ` Slack: ${log.slack.error}` : ""}`
        : `Webhook failed: ${log?.error || log?.body || "see panel"}.`
      : "No webhook URL saved.";
    setStatus(`Crawl finished.\n${webhookLine} Next crawl at ${formatClock(crawl.nextScanAt)}.`);
    scheduleWait();
    renderPanel();
  }

  async function startCycle({ force = false } = {}) {
    if (scanning) return;
    const crawl = loadCrawl();
    if (!force && !crawl.autoEnabled) return;
    Object.assign(crawl, planCycleStart(Date.now(), INTERVAL_MS), { lastError: "" });
    saveCrawl(crawl);
    renderPanel();
    await scanAndAdvance();
  }

  function toggleAuto() {
    const crawl = loadCrawl();
    crawl.autoEnabled = !crawl.autoEnabled;
    if (!crawl.autoEnabled) {
      crawl.phase = "idle";
      crawl.continueUntil = 0;
      saveCrawl(crawl);
      clearTimeout(waitTimer);
      renderPanel();
      return;
    }
    crawl.phase = "waiting";
    crawl.nextScanAt = Date.now() + INTERVAL_MS;
    saveCrawl(crawl);
    scheduleWait();
    renderPanel();
  }

  function scheduleWait() {
    clearTimeout(waitTimer);
    const crawl = loadCrawl();
    if (!crawl.autoEnabled || !crawl.nextScanAt) return;
    waitTimer = setTimeout(() => {
      if (loadCrawl().autoEnabled) startCycle();
    }, Math.max(1000, crawl.nextScanAt - Date.now()));
  }

  async function resumeCrawl() {
    const crawl = loadCrawl();
    const plan = planResume(crawl, Date.now(), INTERVAL_MS);

    if (plan.action === "idle") {
      if (crawl.phase === "scanning" || crawl.continueUntil) {
        crawl.phase = plan.phase;
        crawl.continueUntil = 0;
        saveCrawl(crawl);
      }
      timerReady = true;
      return;
    }

    if (plan.action === "continue-scan") {
      await scanAndAdvance();
      timerReady = true;
      return;
    }

    crawl.phase = plan.phase;
    crawl.nextScanAt = plan.nextScanAt;
    crawl.continueUntil = plan.continueUntil;
    saveCrawl(crawl);
    setStatus(`Auto is on. Next crawl at ${formatClock(crawl.nextScanAt)}. Turn Auto off if you need this tab.`);
    scheduleWait();
    renderPanel();
    timerReady = true;
  }

  function syncToAutomationsTab() {
    if (!isAutomationsTab(document)) {
      removePanel();
      return;
    }
    ensurePanel();
    if (!crawlStarted) {
      crawlStarted = true;
      resumeCrawl();
    }
  }

  function boot() {
    const observer = new MutationObserver(() => {
      if (scanning) return;
      clearTimeout(syncTimer);
      syncTimer = setTimeout(syncToAutomationsTab, 120);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-current"],
    });
    setInterval(() => {
      if (scanning) return;
      syncToAutomationsTab();
      if (!crawlStarted) return;
      if (isAutomationsTab(document)) renderPanel();
      if (!timerReady) return;
      const crawl = loadCrawl();
      if (crawl.autoEnabled && crawl.phase !== "scanning" && crawl.nextScanAt && Date.now() >= crawl.nextScanAt) {
        startCycle();
      }
    }, 4000);
    syncToAutomationsTab();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
