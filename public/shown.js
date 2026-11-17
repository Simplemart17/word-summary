// Telling API.Bible that one of its passages was shown, which its licence
// asks for every time.
//
// API.Bible provides a small script for this. If that script cannot be used
// (an ad blocker stopped it, the connection dropped, or the browser will not
// let it keep its own records), the report goes through the Selah server
// instead, so a passage is never shown without one. The script is tried again
// later rather than given up on.

const SCRIPT = 'https://pkg.api.bible/fumsV3.min.js';
const RETRY_MS = 5 * 60_000;

let state = 'none'; // none | loading | ready | failed
let failedAt = 0;
let waiting = []; // tokens handed over while the script was still loading

// The script's own stand-in: calls made before it arrives are queued for it.
function queue() {
  window.fumsData.push(arguments);
}

// A random name for this browser and for this visit, which the report needs.
// It says nothing about who is reading.
function nameFor(storage, key) {
  const fresh = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
  try {
    let name = window[storage].getItem(key); // even naming the storage can be refused
    if (!name) window[storage].setItem(key, (name = fresh()));
    return name;
  } catch {
    return (nameFor[key] ??= fresh()); // storage is closed to us: keep it for this page only
  }
}

function throughServer(tokens) {
  if (!tokens.length) return;
  fetch('/api/shown', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tokens,
      device: nameFor('localStorage', 'selah.device'),
      session: nameFor('sessionStorage', 'selah.session'),
    }),
  }).catch(() => {});
}

function failed(script) {
  script.remove();
  state = 'failed';
  failedAt = Date.now();
  window.fumsData = []; // or a later, successful load would report these a second time
  window.fums = queue;
  throughServer(waiting);
  waiting = [];
}

function load() {
  state = 'loading';
  window.fumsData = window.fumsData || [];
  window.fums = window.fums || queue;
  const script = document.createElement('script');
  script.async = true;
  script.src = SCRIPT;
  script.onerror = () => failed(script);
  script.onload = () => {
    // Once running, the script replaces the stand-in with itself. If the
    // stand-in is still there, the script stopped partway.
    if (window.fums === queue) return failed(script);
    state = 'ready';
    waiting = [];
  };
  document.head.append(script);
}

export function reportShown(token) {
  if (!token) return;
  if (state === 'none' || (state === 'failed' && Date.now() - failedAt > RETRY_MS)) load();

  if (state === 'failed') return throughServer([token]);
  if (state === 'loading') waiting.push(token);
  window.fums('trackView', token);
}
