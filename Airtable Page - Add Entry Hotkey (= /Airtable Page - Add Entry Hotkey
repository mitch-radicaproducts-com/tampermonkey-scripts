// ==UserScript==
// @name         Airtable Page - Add Entry Hotkey (= / +)
// @namespace    radicaproducts.com
// @version      1.0.0
// @description  Press = or + anywhere on the Airtable interface page to click the circular "Add Entry" (+) button.
// @author       Mitchell Sanchez
// @match        https://airtable.com/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/YOUR-USERNAME/radica-userscripts/main/airtable-add-entry-hotkey.user.js
// @downloadURL  https://raw.githubusercontent.com/YOUR-USERNAME/radica-userscripts/main/airtable-add-entry-hotkey.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ---- Settings ---------------------------------------------------------
    // Keys that trigger the button. "=" and "+" are the same physical key.
    const TRIGGER_KEYS = ['=', '+'];

    // When false, the hotkey is ignored while the cursor is in a text field,
    // so typing "=" into a form still types "=". Set to true if you want the
    // hotkey to fire no matter where focus is.
    const ALLOW_IN_TEXT_FIELDS = false;
    // ----------------------------------------------------------------------

    let firing = false;   // prevents double-clicks from key repeat

    // Find the circular "+" Add Entry button.
    function findAddButton() {
        // 1) Preferred: Airtable's stable test id on the button wrapper.
        let el = document.querySelector('[data-testid="add-record-button"]');
        if (el) return el;

        // 2) Fallback: accessible label.
        el = document.querySelector('[role="button"][aria-label="Add Entry"]')
            || document.querySelector('[aria-label="Add Entry"]');
        if (el) return el;

        // 3) Last resort: any button-ish element whose tooltip mentions adding.
        const candidates = document.querySelectorAll('[role="button"], button');
        for (const c of candidates) {
            const label = (c.getAttribute('aria-label') || '') + ' ' +
                          (c.getAttribute('aria-description') || '');
            if (/add (entry|record)/i.test(label)) return c;
        }

        return null;
    }

    // Is focus currently sitting in something the user is typing into?
    function inTextField() {
        const el = document.activeElement;
        if (!el) return false;
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (el.isContentEditable) return true;
        if (el.closest && el.closest('[contenteditable="true"]')) return true;
        return false;
    }

    // Airtable's button is a <div role="button">, so fire a full pointer
    // sequence — a bare .click() is not always enough for React handlers.
    function pressButton(el) {
        const target = el.querySelector('.circle') || el;
        const opts = { bubbles: true, cancelable: true, view: window, button: 0 };

        try {
            target.dispatchEvent(new PointerEvent('pointerdown', opts));
        } catch (e) { /* PointerEvent unsupported — ignore */ }

        target.dispatchEvent(new MouseEvent('mousedown', opts));

        try {
            target.dispatchEvent(new PointerEvent('pointerup', opts));
        } catch (e) { /* ignore */ }

        target.dispatchEvent(new MouseEvent('mouseup', opts));
        target.dispatchEvent(new MouseEvent('click', opts));

        // Belt and braces: the native click path, in case the synthetic
        // sequence above was swallowed.
        if (typeof el.click === 'function') el.click();
    }

    function onKeyDown(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.isComposing) return;
        if (e.repeat) return;

        if (!TRIGGER_KEYS.includes(e.key)) return;
        if (!ALLOW_IN_TEXT_FIELDS && inTextField()) return;

        const btn = findAddButton();
        if (!btn) return;   // button not on screen — let the keypress through

        e.preventDefault();
        e.stopPropagation();

        if (firing) return;
        firing = true;

        pressButton(btn);

        setTimeout(() => { firing = false; }, 400);
    }

    // Capture phase so we get the key before Airtable's own shortcut handling.
    document.addEventListener('keydown', onKeyDown, true);
})();
