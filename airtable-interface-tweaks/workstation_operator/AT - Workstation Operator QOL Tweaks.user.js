// ==UserScript==
// @name         AT - Workstation Operator QOL Tweaks
// @namespace    radicaproducts.com
// @version      1.1.0
// @description  Workstation operator shortcuts for Airtable: = or + opens Add Entry, the build-sheet barcode field is focused and submitted with Enter, and the Omni button is a clock.
// @author       Mitchell Sanchez
// @match        https://airtable.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

// Publish this file to GitHub and install the raw .user.js URL.
// Tampermonkey updates from that URL. Raise @version on each publish.
//
// Replaces "Airtable Form - Autofocus Barcode Field" and
// "Airtable Page - Add Entry Hotkey". Disable those if they are still
// installed — leaving them on will open two forms and submit twice.

(function () {
    'use strict';

    // ---- Settings ---------------------------------------------------------
    // Text of the barcode field label, lowercased. Partial match, so minor
    // wording or capitalization changes in Airtable won't break it.
    const LABEL_TEXT = 'scan the barcode on the build sheet';

    // Keys that open Add Entry. "=" and "+" are the same physical key
    // on a US keyboard (unshifted and shifted).
    const TRIGGER_KEYS = ['=', '+'];

    // When false, "=" and "+" typed into a field are left alone. That
    // includes a barcode which itself contains those characters. Set to
    // true to fire the hotkey no matter where focus is.
    const ALLOW_IN_TEXT_FIELDS = false;
    // ----------------------------------------------------------------------

    let lastFocused = null;   // textarea we most recently focused
    let pending = false;      // debounce flag for observer bursts
    let submitting = false;   // guards against double-submits
    let firing = false;       // prevents double-clicks from key repeat

    function normalize(s) {
        return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    // ---- Barcode field ----------------------------------------------------

    // Find the textarea that belongs to the barcode label.
    function findBarcodeTextarea() {
        // 1) Preferred: a <label for="..."> whose text matches.
        const labels = document.querySelectorAll('label[for]');
        for (const label of labels) {
            if (normalize(label.textContent).includes(LABEL_TEXT)) {
                const el = document.getElementById(label.getAttribute('for'));
                if (el && el.tagName === 'TEXTAREA') return el;
            }
        }

        // 2) Fallback: Airtable's data-tutorial-selector-id on the label/field wrapper.
        const wrappers = document.querySelectorAll('[data-tutorial-selector-id]');
        for (const w of wrappers) {
            const id = normalize(w.getAttribute('data-tutorial-selector-id'));
            if (id.includes('scanthebarcodeonthebuildsheet')) {
                const ta = w.querySelector('textarea');
                if (ta) return ta;
            }
        }

        // 3) Last resort: a field label, then a textarea in a nearby ancestor.
        const candidates = document.querySelectorAll('[data-testid="page-element-label"], label');
        for (const c of candidates) {
            if (!normalize(c.textContent).includes(LABEL_TEXT)) continue;
            let node = c;
            for (let i = 0; i < 6 && node; i++) {
                const ta = node.querySelector && node.querySelector('textarea');
                if (ta) return ta;
                node = node.parentElement;
            }
        }

        return null;
    }

    // Locate the form's submit button ("Create").
    function findSubmitButton(fromEl) {
        const form = fromEl && fromEl.closest ? fromEl.closest('form') : null;
        const scope = form || document;

        return scope.querySelector('button[type="submit"]:not([aria-disabled="true"])')
            || scope.querySelector('button[aria-label="Create"]')
            || scope.querySelector('button[type="submit"]');
    }

    function isVisible(el) {
        if (!el.isConnected) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function tryFocus() {
        if (!document || !document.documentElement) return;
        const ta = findBarcodeTextarea();
        // A submit rebuilds the textarea. Drop the old claim so the new one
        // can be focused. Done here so the observer does not scan twice.
        if (lastFocused && lastFocused !== ta) lastFocused = null;
        if (!ta || !isVisible(ta) || ta.disabled || ta.readOnly) return;

        // If it's already the active element, nothing to do.
        if (document.activeElement === ta) {
            lastFocused = ta;
            return;
        }

        // Only claim focus if we haven't already handed it to this exact element,
        // so we don't fight the user when they click another field.
        if (lastFocused === ta) return;

        ta.focus({ preventScroll: false });
        // Put the caret at the end in case anything is prefilled.
        try {
            const len = ta.value.length;
            ta.setSelectionRange(len, len);
        } catch (e) { /* ignore */ }

        if (document.activeElement === ta) {
            lastFocused = ta;
        }
    }

    function schedule() {
        if (pending) return;
        pending = true;
        // Let Airtable's React render settle before grabbing focus.
        setTimeout(() => {
            pending = false;
            tryFocus();
        }, 120);
    }

    // Enter in the barcode textarea submits the form instead of inserting a newline.
    function handleEnter(e) {
        if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.isComposing) return;

        const ta = e.target;
        if (!ta || ta.tagName !== 'TEXTAREA') return;
        if (ta !== findBarcodeTextarea()) return;   // only our field

        // Never let the newline reach the textarea.
        e.preventDefault();
        e.stopPropagation();

        if (submitting) return;
        if (!ta.value.trim()) return;   // don't submit an empty scan

        submitting = true;

        // Brief pause so Airtable's React state registers the scanned value
        // before the click lands.
        setTimeout(() => {
            const btn = findSubmitButton(ta);
            if (btn) {
                btn.click();
            } else {
                const form = ta.closest('form');
                if (form && form.requestSubmit) form.requestSubmit();
            }

            // Allow the next scan, and re-focus the fresh field.
            setTimeout(() => {
                submitting = false;
                lastFocused = null;
                tryFocus();
            }, 600);
        }, 60);
    }

    // ---- Add Entry hotkey -------------------------------------------------

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

    function handleAddEntryHotkey(e) {
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

        // Opening a fresh entry should claim the barcode field again, even
        // when Airtable reused the same textarea node as the previous one.
        lastFocused = null;
        pressButton(btn);
        schedule();
        setTimeout(tryFocus, 400);
        setTimeout(tryFocus, 1000);

        setTimeout(() => { firing = false; }, 700);
    }

    // ---- Omni clock -------------------------------------------------------
    // Airtable's corner Omni button (data-testid="collab-mole-trigger").
    // Swap the icon for the local time and drop every way to activate it.
    // Airtable re-renders the control, so this is reapplied whenever it
    // comes back.

    function formatClock(date) {
        const month = date.getMonth() + 1;
        const day = date.getDate();
        let hours = date.getHours();
        const minutes = date.getMinutes();
        const suffix = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12 || 12;
        const mm = minutes < 10 ? '0' + minutes : String(minutes);
        const md = (month < 10 ? '0' + month : String(month)) + '/' +
            (day < 10 ? '0' + day : String(day));
        return md + ' ' + hours + ':' + mm + suffix;
    }

    function omniTriggerFrom(node) {
        if (!node || !node.closest) return null;
        return node.closest('[data-testid="collab-mole-trigger"]');
    }

    function ensureClock() {
        if (!document || !document.documentElement) return;
        const trigger = document.querySelector('[data-testid="collab-mole-trigger"]');
        if (!trigger) return;

        const root = trigger.closest('[aria-label="Omni"]');
        if (root) root.setAttribute('aria-label', 'Clock');

        trigger.style.setProperty('width', 'auto', 'important');
        trigger.style.setProperty('height', '40px', 'important');
        trigger.style.setProperty('min-width', '0', 'important');
        trigger.style.setProperty('padding', '0 14px', 'important');
        trigger.style.setProperty('border-radius', '999px', 'important');
        trigger.style.setProperty('display', 'flex', 'important');
        trigger.style.setProperty('align-items', 'center', 'important');
        trigger.style.setProperty('justify-content', 'center', 'important');
        trigger.style.setProperty('pointer-events', 'none', 'important');
        trigger.style.setProperty('cursor', 'default', 'important');
        trigger.style.setProperty('user-select', 'none', 'important');
        trigger.removeAttribute('role');
        trigger.removeAttribute('tabindex');
        if ('inert' in trigger) trigger.inert = true;

        const openButton = trigger.querySelector('[aria-label="Open Omni"], [role="button"]');
        let clock = trigger.querySelector('time[data-at-clock]');
        if (openButton || !clock) {
            trigger.textContent = '';
            clock = document.createElement('time');
            clock.setAttribute('data-at-clock', '');
            clock.setAttribute('aria-hidden', 'true');
            clock.style.fontVariantNumeric = 'tabular-nums';
            clock.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
            // 14px plus 2pt.
            clock.style.fontSize = 'calc(14px + 2pt)';
            clock.style.fontWeight = '600';
            clock.style.lineHeight = '1';
            clock.style.whiteSpace = 'nowrap';
            clock.style.color = 'var(--colors-foreground-default)';
            trigger.appendChild(clock);
        }

        const text = formatClock(new Date());
        if (clock.textContent !== text) {
            clock.textContent = text;
            clock.dateTime = new Date().toISOString();
        }
    }

    // Clicks and Enter/Space still reach Airtable for a moment when it
    // rebuilds the button. Swallow them before that handler runs.
    function blockOmniActivation(e) {
        if (!omniTriggerFrom(e.target)) return false;
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return false;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return true;
    }

    function tickClock() {
        ensureClock();
        // The face is minutes only, so wait until the next minute.
        const now = new Date();
        const wait = ((60 - now.getSeconds()) * 1000) - now.getMilliseconds();
        setTimeout(tickClock, wait > 0 ? wait : 60000);
    }

    // ---- Wiring -----------------------------------------------------------

    // Watch for the form appearing, re-rendering, or clearing after submit.
    const observer = new MutationObserver(() => {
        if (!document || !document.documentElement) return;
        ensureClock();
        schedule();
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });

    // Re-focus after a submit, and when returning to the tab.
    document.addEventListener('submit', () => {
        lastFocused = null;
        setTimeout(tryFocus, 400);
        setTimeout(tryFocus, 1200);
    }, true);

    window.addEventListener('pagehide', () => observer.disconnect());

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            lastFocused = null;
            schedule();
        }
    });

    // Capture phase so we intercept the key before Airtable's own handlers.
    // Enter-to-submit runs first; "=" / "+" is independent of that path.
    document.addEventListener('keydown', (e) => {
        if (blockOmniActivation(e)) return;
        handleEnter(e);
        handleAddEntryHotkey(e);
    }, true);

    ['click', 'contextmenu', 'mousedown', 'pointerdown'].forEach((type) => {
        document.addEventListener(type, blockOmniActivation, true);
    });

    // Initial attempts, in case the field is already on screen.
    tickClock();
    schedule();
    setTimeout(tryFocus, 800);
    setTimeout(tryFocus, 2000);
})();
