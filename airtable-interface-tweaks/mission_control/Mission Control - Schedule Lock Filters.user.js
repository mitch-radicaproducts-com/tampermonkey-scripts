// ==UserScript==
// @name         Mission Control - Schedule Lock Filters
// @namespace    radicaproducts.com
// @version      1.2
// @description  Keeps the Assembly Log and Defect Reports filters on "this calendar week" from Monday 8:30AM until Sunday midnight, and on their default (past 7 days) otherwise. Checks every 5 minutes without moving the page scroll.
// @match        https://airtable.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(async () => {
    'use strict';

    const NAMES = ['Assembly Log', 'Defect Reports'];
    const MODE = 'this calendar week';
    const DEFAULT_MODE = 'the past number of days';
    //const CHECK_EVERY = 5 * 60 * 1000;   // how often to compare actual vs intended
    const CHECK_EVERY = 1000;   // how often to compare actual vs intended
    const START = { day: 1, hour: 8, minute: 30 };  // Monday 8:30AM -> week mode
    const END = { day: 0 };                          // Sunday 00:00 -> back to default
    const CARD = '[data-testid="page-element:filter"]';

    // Week mode runs Monday 8:30AM through Sunday midnight; Sunday itself and
    // Monday morning sit at the default.
    function wantWeekMode(now = new Date()) {
        const day = now.getDay();                    // 0 = Sunday, local time
        if (day === END.day) return false;
        if (day === START.day) {
            return now.getHours() > START.hour
                || (now.getHours() === START.hour && now.getMinutes() >= START.minute);
        }
        return true;
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function until(fn, timeout = 3000) {
        for (let waited = 0; waited < timeout; waited += 100) {
            if (fn()) return true;
            await sleep(100);
        }
        return false;
    }

    // Airtable scrolls focused controls into view, so during a flip: disable
    // scrollIntoView, make focus() skip scrolling, and snap back anything
    // that moves anyway.
    function pinScroll() {
        const saved = [...document.querySelectorAll('*')]
            .filter((el) => el.scrollTop || el.scrollLeft)
            .map((el) => [el, el.scrollTop, el.scrollLeft]);
        const page = [window.scrollX, window.scrollY];

        const restore = () => {
            for (const [el, top, left] of saved) {
                if (el.scrollTop !== top) el.scrollTop = top;
                if (el.scrollLeft !== left) el.scrollLeft = left;
            }
            window.scrollTo(page[0], page[1]);
        };

        const realScrollIntoView = Element.prototype.scrollIntoView;
        const realFocus = HTMLElement.prototype.focus;
        Element.prototype.scrollIntoView = function () {};
        HTMLElement.prototype.focus = function (opts) {
            realFocus.call(this, { ...opts, preventScroll: true });
        };
        document.addEventListener('scroll', restore, true);

        return () => {
            document.removeEventListener('scroll', restore, true);
            Element.prototype.scrollIntoView = realScrollIntoView;
            HTMLElement.prototype.focus = realFocus;
            restore();
        };
    }

    const cards = () => [...document.querySelectorAll(CARD)].filter((c) =>
        NAMES.includes(c.querySelector('[data-testid="page-element-label"]').textContent.trim()));

    const label = (card) => card.querySelector('.modeSelect .truncate').textContent.trim();

    // Call React's own handler instead of faking a mouse: no coordinates, so
    // the control never has to be on screen.
    function activate(el) {
        for (let node = el; node && node !== document.body; node = node.parentElement) {
            const key = Object.keys(node).find((k) => k.startsWith('__reactProps$'));
            const handler = key && (node[key].onClick || node[key].onMouseDown);
            if (handler) {
                handler({
                    type: 'click', target: el, currentTarget: node,
                    preventDefault() {}, stopPropagation() {}, persist() {},
                    nativeEvent: new MouseEvent('click', { bubbles: true }),
                });
                return true;
            }
        }
        return false;
    }

    // Innermost node in the menu whose text is exactly the option, then climb
    // out only while the text still matches, so we stop at the row and not the
    // wrapper holding week/month/year together.
    function option(text) {
        const want = text.toLowerCase();
        const hits = [...document.querySelectorAll('div,span,li')].filter((el) =>
            !el.closest(CARD) && el.getClientRects().length
            && el.textContent.trim().toLowerCase() === want);
        let el = hits.pop();
        while (el?.parentElement?.textContent.trim().toLowerCase() === want) el = el.parentElement;
        return el;
    }

    async function setWeek(card) {
        if (label(card) === MODE) return;
        activate(card.querySelector('.modeSelect [role="button"]'));
        if (!await until(() => option(MODE))) return console.warn('[filter-alt] no option:', MODE);
        activate(option(MODE));
        await until(() => label(card) === MODE);
    }

    const resetButton = (card) => [...card.querySelectorAll('button')]
        .find((b) => b.textContent.trim() === 'Reset');

    function reset(card) {
        const button = resetButton(card);
        if (button && !button.disabled) activate(button) || button.click();
    }

    // A card is already correct if it shows the intended mode — and for the
    // default that also means Reset is disabled, i.e. nothing drifted.
    function correct(card, week) {
        if (week) return label(card) === MODE;
        const button = resetButton(card);
        return label(card) === DEFAULT_MODE && (!button || button.disabled);
    }

    async function check() {
        const week = wantWeekMode();
        const stale = cards().filter((card) => !correct(card, week));
        if (!stale.length) return;

        const unpin = pinScroll();
        try {
            for (const card of stale) {
                if (week) await setWeek(card);
                else reset(card);
                await sleep(200);
            }
        } finally {
            unpin();
        }
        console.log('[filter-alt]', new Date().toLocaleString(), '->',
            week ? MODE : 'default', `(${stale.length} filter(s) updated)`);
    }

    while (cards().length < NAMES.length) await sleep(500);
    for (;;) {
        await check().catch((e) => console.warn('[filter-alt]', e));
        await sleep(CHECK_EVERY);
    }
})();

