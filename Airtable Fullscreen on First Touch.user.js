// ==UserScript==
// @name         Airtable Fullscreen on First Touch
// @namespace    radicaproducts.com
// @version      2.0
// @description  Fullscreens an Airtable tab once, on the first interaction after it opens. Fires once per page load; if the user leaves fullscreen it stays left.
// @author       Radica
// @match        https://airtable.com/*
// @match        https://*.airtable.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // The Fullscreen API only honors a request made inside a real user gesture,
  // so we wait for the operator's first touch instead of firing on load.
  const events = ['pointerdown', 'keydown', 'wheel', 'touchend'];

  function go() {
    events.forEach((t) => window.removeEventListener(t, go, true));
    if (document.fullscreenElement) return;
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) req.call(el, { navigationUI: 'hide' });
  }

  // capture:true so Airtable can't stop the event before we see it.
  // No preventDefault: the tap still reaches Airtable as a normal click.
  events.forEach((t) => window.addEventListener(t, go, { capture: true, once: true, passive: true }));
})();
