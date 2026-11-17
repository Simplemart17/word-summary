// A password in front of the whole app, for when it can be reached from
// outside your home: set SELAH_PASSWORD and nothing is served without it.
// Signing in sets a cookie that lasts thirty days.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const PASSWORD = process.env.SELAH_PASSWORD ?? '';
export const PROTECTED = PASSWORD.length > 0;
export const PASSWORD_MIN = 10;
export const PASSWORD_TOO_SHORT = PROTECTED && PASSWORD.length < PASSWORD_MIN;

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

function page(message) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <meta name="color-scheme" content="dark" />
    <title>Selah</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Gentium+Book+Plus:ital,wght@0,400;0,700;1,400&family=IM+Fell+English:ital@0;1&display=swap" rel="stylesheet" />
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 1.5rem;
        background: #0c0f22; color: #ede4d0;
        font: 1.25rem/1.6 'Gentium Book Plus', 'Iowan Old Style', Palatino, Georgia, serif;
      }
      main { width: min(100%, 24rem); }
      h1 { margin: 0; font: italic 400 clamp(4.5rem, 22vw, 7rem)/0.9 'IM Fell English', Palatino, Georgia, serif; letter-spacing: -0.015em; }
      p { margin: 1.5rem 0 0; color: rgb(237 228 208 / 0.74); }
      form { display: grid; gap: 1rem; margin-top: 2rem; }
      label { display: grid; gap: 0.2rem; font-size: 0.9375rem; font-style: italic; color: rgb(237 228 208 / 0.6); }
      input {
        font: inherit; font-style: normal; color: #ede4d0; background: transparent; width: 100%;
        border: 0; border-bottom: 1px solid rgb(237 228 208 / 0.3); border-radius: 0; padding: 0.4rem 0;
      }
      button {
        font: inherit; font-weight: 700; color: #04050c; background: #a5c0f4; cursor: pointer;
        border: 0; border-radius: 3px; padding: 0.8rem 1.5rem; justify-self: start;
      }
      :focus-visible { outline: 2px solid #ede4d0; outline-offset: 3px; }
      .problem { color: #ede4d0; }
    </style>
  </head>
  <body>
    <main>
      <h1>Selah</h1>
      <p>This copy of Selah is private. Enter its password to open it.</p>
      ${message ? `<p class="problem" role="alert">${message}</p>` : ''}
      <form method="post" action="/login">
        <label>Password <input type="password" name="password" autocomplete="current-password" required autofocus /></label>
        <button type="submit">Open Selah</button>
      </form>
    </main>
  </body>
</html>`;
}

function send(res, status, message, headers = {}) {
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
    return send(res, 200, '');
  }
  if (req.method !== 'POST') return res.writeHead(405).end();
  if (shutOut(req)) return send(res, 429, 'Too many wrong passwords. Wait a quarter of an hour and try again.');

  let given = '';
  try {
    given = (await readForm(req)).get('password') ?? '';
  } catch {
    return send(res, 400, 'That could not be read. Try again.');
  }
  if (!timingSafeEqual(hashOf(given), hashOf(PASSWORD))) {
    const address = visitor(req);
    misses.set(address, [...recent(misses.get(address)), Date.now()]);
    await new Promise((wait) => setTimeout(wait, 700)); // slow down guessing
    return send(res, 401, 'That is not the password.');
  }

  const expiry = Date.now() + DAYS * 86_400_000;
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.writeHead(303, {
    Location: '/',
    'Set-Cookie': `${COOKIE}=${expiry}.${signature(expiry)}; Path=/; Max-Age=${DAYS * 86_400}; HttpOnly; SameSite=Lax${secure}`,
    'Cache-Control': 'no-store',
  });
  res.end();
}
