// ==UserScript==
// @name         Airtable Page - Add Entry Hotkey (= / +)
// @namespace    radicaproducts.com
// @version      1.1.0
// @description  Press = or + anywhere on the Airtable interface page to click the circular "Add Entry" (+) button. Does nothing if the entry form is already open.
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

    // Is the new-entry form already on screen? If so, the hotkey must do
    // nothing — otherwise a second form stacks on top of the first.
    function formIsOpen() {
        // 1) Airtable's expanded-record / form dialog wrapper.
        if (document.querySelector('[data-testid="page-element-expansion-stack-renderer-dialog"]')) {
            return true;
        }

        // 2) Any modal dialog currently rendered.
        const dialogs = document.querySelectorAll('[role="dialog"]');
        for (const d of dialogs) {
            if (d.getAttribute('aria-modal') === 'true') return true;
            // A dialog holding a submit button is a form, open or animating in.
            if (d.querySelector('button[type="submit"], [aria-label="Create"]')) return true;
        }

        // 3) Fallback: the form's own Create button visible anywhere.
        const create = document.querySelector('button[aria-label="Create"], button[type="submit"]');
        if (create) {
            const rect = create.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) return true;
        }

        return false;
    }

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

    // Airtable's button is a <div role="button">. Try the plain native click
    // FIRST and only escalate to a synthetic pointer sequence if the form did
    // not appear — doing both at once opens two forms.
    function pressButton(el) {
        if (typeof el.click === 'function') {
            el.click();
        } else {
            dispatchPointerSequence(el);
            return;
        }

        // Give React a moment; escalate only if nothing opened.
        setTimeout(() => {
            if (!formIsOpen()) dispatchPointerSequence(el);
        }, 250);
    }

    function dispatchPointerSequence(el) {
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
    }

    function onKeyDown(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.isComposing) return;
        if (e.repeat) return;

        if (!TRIGGER_KEYS.includes(e.key)) return;
        if (!ALLOW_IN_TEXT_FIELDS && inTextField()) return;

        // Form already up — swallow the key and do nothing.
        if (formIsOpen()) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        const btn = findAddButton();
        if (!btn) return;   // button not on screen — let the keypress through

        e.preventDefault();
        e.stopPropagation();

        if (firing) return;
        firing = true;

        pressButton(btn);

        setTimeout(() => { firing = false; }, 700);
    }

    // Capture phase so we get the key before Airtable's own shortcut handling.
    document.addEventListener('keydown', onKeyDown, true);
})();
