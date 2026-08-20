// ==UserScript==
// @name         Airtable Form - Autofocus Barcode Field
// @namespace    radicaproducts.com
// @version      1.1.0
// @description  Autofocuses the "Scan the barcode on the Build Sheet" textarea on an Airtable form, and makes Enter submit the form directly instead of adding a newline.
// @author       Mitchell Sanchez
// @match        https://airtable.com/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/RADICA-ORG/radica-userscripts/main/airtable-barcode-autofocus.user.js
// @downloadURL  https://raw.githubusercontent.com/RADICA-ORG/radica-userscripts/main/airtable-barcode-autofocus.user.js
// @supportURL   https://github.com/RADICA-ORG/radica-userscripts/issues
// ==/UserScript==

// NOTE: Replace RADICA-ORG/radica-userscripts above with your real GitHub
// org/repo path before distributing. Bump @version on every change or
// installed copies will not update.

(function () {
    'use strict';

    // Text of the field label, lowercased. Partial match, so minor
    // wording/capitalization changes in Airtable won't break it.
    const LABEL_TEXT = 'scan the barcode on the build sheet';

    let lastFocused = null;   // textarea we most recently focused
    let pending = false;      // debounce flag for observer bursts
    let submitting = false;   // guards against double-submits

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

    // Locate the form's submit button ("Create").
    function findSubmitButton(fromEl) {
        const form = fromEl && fromEl.closest ? fromEl.closest('form') : null;
        const scope = form || document;

        return scope.querySelector('button[type="submit"]:not([aria-disabled="true"])')
            || scope.querySelector('button[aria-label="Create"]')
            || scope.querySelector('button[type="submit"]');
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

    // Capture phase so we intercept Enter before Airtable's own handlers.
    document.addEventListener('keydown', handleEnter, true);

    // Initial attempts, in case the field is already on screen.
    schedule();
    setTimeout(tryFocus, 800);
    setTimeout(tryFocus, 2000);
})();
