// A password in front of the whole app, for when it can be reached from
// outside your home: set SELAH_PASSWORD and nothing is served without it.
// Signing in sets a cookie that lasts thirty days.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const PASSWORD = process.env.SELAH_PASSWORD ?? '';
export const PROTECTED = PASSWORD.length > 0;
export const PASSWORD_MIN = 10;
export const PASSWORD_TOO_SHORT = PROTECTED && PASSWORD.length < PASSWORD_MIN;

// The few files the sign-in page itself is made of. They hold no one's data,
// so they are served before signing in; everything else waits for the password.
export const OPEN_FILES = new Set(['/styles.css', '/window.js', '/login.js']);

const COOKIE = 'selah';
const DAYS = 30;
const hashOf = (text) => createHash('sha256').update(text).digest();
// Changing the password signs everyone out, because the cookies were signed with the old one.
const KEY = hashOf(`selah session ${PASSWORD}`);
const signature = (expiry) => createHmac('sha256', KEY).update(String(expiry)).digest('base64url');

function cookieOf(req) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE) return value.join('=');
  }
  return '';
}

export function signedIn(req) {
  if (!PROTECTED) return true;
  const [expiry, given] = cookieOf(req).split('.');
  if (!expiry || !given || Number(expiry) < Date.now()) return false;
  const expected = Buffer.from(signature(expiry));
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/* ---------- wrong guesses ---------- */

const WINDOW_MS = 15 * 60_000;
const PER_VISITOR = 8; // wrong guesses from one address before it is shut out
const ALTOGETHER = 40; // and from everyone together, in case the address is faked
const misses = new Map(); // address -> times of wrong guesses

// Behind a Cloudflare tunnel the visitor's own address arrives in a header.
const visitor = (req) =>
  req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '';

function recent(list = []) {
  const since = Date.now() - WINDOW_MS;
  return list.filter((at) => at > since);
}

function shutOut(req) {
  let all = 0;
  for (const [address, list] of misses) {
    const kept = recent(list);
    if (kept.length) misses.set(address, kept);
    else misses.delete(address);
    all += kept.length;
  }
  return all >= ALTOGETHER || (misses.get(visitor(req))?.length ?? 0) >= PER_VISITOR;
}

/* ---------- the sign-in page ---------- */

// The same room as the app's opening screen, with the window unlit. It works
// as a plain form; login.js adds the window and signs in without a page load.
function page(message) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <meta name="color-scheme" content="dark" />
    <title>Selah</title>
    <link
      rel="icon"
      href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='14' fill='%230c0f22' stroke='%2304050c' stroke-width='3'/%3E%3Ccircle cx='16' cy='16' r='9' fill='none' stroke='%234d86ea' stroke-width='4'/%3E%3Ccircle cx='16' cy='16' r='3.5' fill='%23f1d384'/%3E%3C/svg%3E"
    />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Gentium+Book+Plus:ital,wght@0,400;0,700;1,400&family=IM+Fell+English:ital@0;1&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/styles.css" />
    <script type="module" src="/login.js"></script>
  </head>
  <body data-view="welcome" class="door">
    <main class="nave">
      <section class="window-side" aria-hidden="true">
        <div class="window-frame">
          <canvas id="bloom"></canvas>
          <canvas id="window"></canvas>
        </div>
        <p id="caption" class="caption">A pane lights for each character you type.</p>
      </section>

      <article class="reading">
        <div class="welcome">
          <h1 class="wordmark">Selah</h1>
          <p class="lede">This copy of Selah is private. Enter its password and the window lights.</p>

          <form id="signin" class="signin" method="post" action="/login">
            <label class="field" for="password"><span>Password</span></label>
            <div class="signin-row">
              <input id="password" name="password" type="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" required autofocus />
              <button id="show" class="link" type="button" aria-pressed="false" hidden>Show</button>
            </div>
            <p id="problem" class="problem" role="alert">${message}</p>
            <button id="enter" class="btn btn-primary btn-large" type="submit">Open Selah</button>
          </form>

          <p class="fineprint">You stay signed in on this device for thirty days.</p>
        </div>
      </article>
    </main>
  </body>
</html>`;
}

// The page for a browser, or a short answer for login.js.
function reply(req, res, status, message, headers = {}) {
  if ((req.headers.accept ?? '').includes('application/json')) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    return res.end(JSON.stringify(status === 200 ? { ok: true } : { error: message }));
  }
  if (status === 200) return res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store', ...headers }).end();
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(page(message));
}

function readForm(req) {
  return new Promise((done, fail) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4000) fail(new Error('Too long.'));
    });
    req.on('end', () => done(new URLSearchParams(body)));
    req.on('error', fail);
  });
}

// Answers GET and POST /login.
export async function login(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (signedIn(req)) return res.writeHead(303, { Location: '/' }).end();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(page(''));
  }
  if (req.method !== 'POST') return res.writeHead(405).end();
  if (shutOut(req)) return reply(req, res, 429, 'Too many wrong passwords. Wait a quarter of an hour and try again.');

  let given = '';
  try {
    given = (await readForm(req)).get('password') ?? '';
  } catch {
    return reply(req, res, 400, 'That could not be read. Try again.');
  }
  if (!timingSafeEqual(hashOf(given), hashOf(PASSWORD))) {
    const address = visitor(req);
    misses.set(address, [...recent(misses.get(address)), Date.now()]);
    await new Promise((wait) => setTimeout(wait, 700)); // slow down guessing
    return reply(req, res, 401, 'That is not the password.');
  }

  const expiry = Date.now() + DAYS * 86_400_000;
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  reply(req, res, 200, '', {
    'Set-Cookie': `${COOKIE}=${expiry}.${signature(expiry)}; Path=/; Max-Age=${DAYS * 86_400}; HttpOnly; SameSite=Lax${secure}`,
  });
}
