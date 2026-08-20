// ==UserScript==
// @name         Airtable Form - Autofocus Barcode Field
// @namespace    radicaproducts.com
// @version      1.0
// @description  Waits for the "Scan the barcode on the Build Sheet" textarea to appear on an Airtable form and automatically focuses it, including after each submission.
// @author       Mitchell Sanchez
// @match        https://airtable.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // Text of the field label, lowercased. Partial match, so minor
    // wording/capitalization changes in Airtable won't break it.
    const LABEL_TEXT = 'scan the barcode on the build sheet';

    let lastFocused = null; // textarea we most recently focused
    let pending = false; // debounce flag for observer bursts

    function normalize(s) {
        return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

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

        // 3) Last resort: walk any label-ish node, then look for a textarea nearby.
        const candidates = document.querySelectorAll('[data-testid="page-element-label"], label, span');
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

    function isVisible(el) {
        if (!el.isConnected) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function tryFocus() {
        const ta = findBarcodeTextarea();
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

    // Watch for the form appearing, re-rendering, or clearing after submit.
    const observer = new MutationObserver(() => {
        const ta = findBarcodeTextarea();
        // The textarea gets torn down and rebuilt after a submit — reset our
        // claim so the fresh one gets focused.
        if (lastFocused && lastFocused !== ta) lastFocused = null;
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

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            lastFocused = null;
            schedule();
        }
    });

    // Initial attempts, in case the field is already on screen.
    schedule();
    setTimeout(tryFocus, 800);
    setTimeout(tryFocus, 2000);
})();