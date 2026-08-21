// ==UserScript==
// @name         Airtable Mission Control - Monday Meeting Patch
// @version      1.1
// @description  Alternates the "Assembly Log" and "Defect Reports" date filters on an Airtable interface page between the page's default mode (past N days) and "this calendar week".
// @author       Mitch
// @match        https://airtable.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /* ------------------------------------------------------------------ *
     * CONFIG
     * ------------------------------------------------------------------ */
    const CONFIG = {
        // Labels of the filter page elements to drive, exactly as shown in
        // their header. Case-insensitive, trimmed.
        filterLabels: ['Assembly Log', 'Defect Reports'],

        // Milliseconds between mode flips.
        intervalMs: 5000,

        // The option text to pick for mode B, as it appears in the dropdown.
        modeBLabel: 'this calendar week',

        // Start alternating as soon as the filters are found?
        autoStart: true,

        // Console chatter.
        debug: true,
    };

    const log = (...a) => CONFIG.debug && console.log('%c[filter-alt]', 'color:#2d7ff9', ...a);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    /* ------------------------------------------------------------------ *
     * DOM HELPERS
     * ------------------------------------------------------------------ */
    const FILTER_CARD = '[data-testid="page-element:filter"]';

    function filterCards() {
        return Array.from(document.querySelectorAll(FILTER_CARD));
    }

    function cardLabel(card) {
        const el = card.querySelector('[data-testid="page-element-label"]');
        return el ? el.textContent.trim() : '';
    }

    function findCard(label) {
        const want = label.trim().toLowerCase();
        return filterCards().find((c) => cardLabel(c).toLowerCase() === want) || null;
    }

    // The "the past number of days" / "this calendar week" dropdown trigger.
    function modeButton(card) {
        return card.querySelector('.modeSelect [role="button"][aria-haspopup="true"]')
            || card.querySelector('.modeSelect [role="button"]');
    }

    function modeLabel(card) {
        const btn = modeButton(card);
        if (!btn) return '';
        const t = btn.querySelector('.truncate');
        return (t ? t.textContent : btn.textContent).trim();
    }

    function daysInput(card) {
        return card.querySelector('.numberOfDaysInput input');
    }

    function visible(el) {
        if (!el || !el.isConnected) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    // React listens on the whole pointer/mouse sequence, not just `click`.
    function realClick(el) {
        if (!el) return;
        const r = el.getBoundingClientRect();
        const base = {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
            button: 0,
        };
        el.dispatchEvent(new PointerEvent('pointerover', base));
        el.dispatchEvent(new MouseEvent('mouseover', base));
        el.dispatchEvent(new PointerEvent('pointerdown', { ...base, isPrimary: true }));
        el.dispatchEvent(new MouseEvent('mousedown', base));
        el.focus && el.focus();
        el.dispatchEvent(new PointerEvent('pointerup', { ...base, isPrimary: true }));
        el.dispatchEvent(new MouseEvent('mouseup', base));
        el.dispatchEvent(new MouseEvent('click', base));
    }

    // Write to a React-controlled text input so the app sees the change.
    function setInputValue(input, value) {
        const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
        ).set;
        setter.call(input, String(value));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function waitFor(fn, timeout = 4000, step = 60) {
        const deadline = Date.now() + timeout;
        for (;;) {
            const v = fn();
            if (v) return v;
            if (Date.now() > deadline) return null;
            await sleep(step);
        }
    }

    /* ------------------------------------------------------------------ *
     * DROPDOWN OPTION PICKER
     * The select menu renders in a portal on <body>, so search the whole
     * document for the smallest visible node whose text matches, ignoring
     * anything inside a filter card (the trigger itself has the same text).
     * ------------------------------------------------------------------ */
    function findOption(text) {
        const want = text.trim().toLowerCase();
        const candidates = Array.from(
            document.querySelectorAll('[role="menuitem"],[role="option"],li,div,span,button')
        ).filter((el) => {
            if (el.closest(FILTER_CARD)) return false;
            if (!visible(el)) return false;
            return el.textContent.trim().toLowerCase() === want;
        });
        if (!candidates.length) return null;
        // Smallest subtree = the leaf-most node holding the label.
        candidates.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
        const leaf = candidates[0];
        return leaf.closest('[role="menuitem"],[role="option"],li,button,[tabindex]') || leaf;
    }

    async function chooseMode(card, targetLabel) {
        if (modeLabel(card).toLowerCase() === targetLabel.toLowerCase()) return true;

        const btn = modeButton(card);
        if (!btn) { log('no mode button on', cardLabel(card)); return false; }

        realClick(btn);
        const option = await waitFor(() => findOption(targetLabel), 3000);
        if (!option) {
            log(`option "${targetLabel}" not found — closing menu`);
            document.body.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
            );
            return false;
        }
        realClick(option);

        const ok = await waitFor(
            () => modeLabel(card).toLowerCase() === targetLabel.toLowerCase(), 3000
        );
        return Boolean(ok);
    }

    /* ------------------------------------------------------------------ *
     * MODES
     * Mode A is captured from the page on first run, so "standard" is
     * whatever the filters were set to when the script started.
     * ------------------------------------------------------------------ */
    const baseline = new Map(); // label -> { mode, days }

    function captureBaseline() {
        for (const label of CONFIG.filterLabels) {
            const card = findCard(label);
            if (!card) continue;
            const input = daysInput(card);
            baseline.set(label, {
                mode: modeLabel(card),
                days: input ? input.value : null,
            });
        }
        log('baseline (mode A):', Object.fromEntries(baseline));
    }

    async function applyModeA(card, label) {
        const base = baseline.get(label);
        if (!base) return;
        await chooseMode(card, base.mode);
        if (base.days !== null && base.days !== '') {
            const input = await waitFor(() => daysInput(card), 2000);
            if (input && input.value !== base.days) setInputValue(input, base.days);
        }
    }

    async function applyModeB(card) {
        await chooseMode(card, CONFIG.modeBLabel);
    }

    let currentMode = 'A';

    async function flip() {
        const next = currentMode === 'A' ? 'B' : 'A';
        for (const label of CONFIG.filterLabels) {
            const card = findCard(label);
            if (!card) { log('filter not on page:', label); continue; }
            if (next === 'B') await applyModeB(card);
            else await applyModeA(card, label);
            await sleep(150); // don't have two popovers racing
        }
        currentMode = next;
        paint();
        log('now in mode', currentMode);
    }

    /* ------------------------------------------------------------------ *
     * CONTROL PANEL
     * ------------------------------------------------------------------ */
    let timer = null;
    let panel, statusEl, toggleBtn, intervalInput;

    function running() { return timer !== null; }

    function start() {
        if (running()) return;
        timer = setInterval(() => { flip().catch((e) => log('flip failed', e)); },
            CONFIG.intervalMs);
        paint();
        log('started, every', CONFIG.intervalMs, 'ms');
    }

    function stop() {
        if (!running()) return;
        clearInterval(timer);
        timer = null;
        paint();
        log('stopped');
    }

    function buildPanel() {
        panel = document.createElement('div');
        panel.style.cssText = [
            'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
            'font:12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif',
            'background:#fff', 'color:#1d1f25', 'border:1px solid #d0d3d9',
            'border-radius:8px', 'box-shadow:0 4px 14px rgba(0,0,0,.16)',
            'padding:10px 12px', 'min-width:190px', 'user-select:none',
        ].join(';');

        const title = document.createElement('div');
        title.textContent = 'Filter alternator';
        title.style.cssText = 'font-weight:600;margin-bottom:6px';

        statusEl = document.createElement('div');
        statusEl.style.cssText = 'margin-bottom:8px;color:#4c5561';

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:6px;align-items:center';

        toggleBtn = document.createElement('button');
        toggleBtn.style.cssText =
            'flex:1;padding:5px 8px;border:1px solid #c3c7cf;border-radius:6px;' +
            'background:#f6f7f9;cursor:pointer;font:inherit';
        toggleBtn.onclick = () => (running() ? stop() : start());

        const flipBtn = document.createElement('button');
        flipBtn.textContent = 'Flip';
        flipBtn.style.cssText = toggleBtn.style.cssText;
        flipBtn.onclick = () => flip().catch((e) => log(e));

        intervalInput = document.createElement('input');
        intervalInput.type = 'number';
        intervalInput.min = '1';
        intervalInput.step = '1';
        intervalInput.value = String(CONFIG.intervalMs / 1000);
        intervalInput.title = 'Seconds between flips';
        intervalInput.style.cssText =
            'width:46px;padding:4px;border:1px solid #c3c7cf;border-radius:6px;font:inherit';
        intervalInput.onchange = () => {
            const secs = Math.max(1, Number(intervalInput.value) || 5);
            CONFIG.intervalMs = secs * 1000;
            intervalInput.value = String(secs);
            if (running()) { stop(); start(); }
        };

        const secs = document.createElement('span');
        secs.textContent = 's';
        secs.style.color = '#7b8494';

        row.append(toggleBtn, flipBtn, intervalInput, secs);
        panel.append(title, statusEl, row);
        document.body.appendChild(panel);
        paint();
    }

    function paint() {
        if (!statusEl) return;
        const base = baseline.get(CONFIG.filterLabels[0]);
        const aName = base ? base.mode : 'default';
        statusEl.innerHTML =
            `Mode: <b>${currentMode === 'A' ? aName : CONFIG.modeBLabel}</b><br>` +
            `${running() ? 'Running' : 'Paused'} · Alt+T toggles`;
        toggleBtn.textContent = running() ? 'Stop' : 'Start';
    }

    window.addEventListener('keydown', (e) => {
        if (e.altKey && (e.key === 't' || e.key === 'T')) {
            e.preventDefault();
            running() ? stop() : start();
        }
    });

    /* ------------------------------------------------------------------ *
     * BOOT — the interface is a SPA, so wait for the filters to render.
     * ------------------------------------------------------------------ */
    (async function boot() {
        const found = await waitFor(() => {
            const hits = CONFIG.filterLabels.filter((l) => findCard(l));
            return hits.length === CONFIG.filterLabels.length ? hits : null;
        }, 60000, 500);

        if (!found) {
            log('filters never appeared; labels on this page:',
                filterCards().map(cardLabel));
            return;
        }

        captureBaseline();
        buildPanel();
        if (CONFIG.autoStart) start();

        // Expose for console tinkering.
        window.__filterAlt = { start, stop, flip, CONFIG, baseline };
    })();
})();
