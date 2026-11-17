import { createServer } from 'node:http';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  TRANSLATIONS,
  books,
  describe,
  inScope,
  indexOfUnit,
  keyOf,
  label,
  parseReference,
  translation,
  units,
  EXPLICIT_MAX,
} from './scripture.js';
import {
  forgetRead,
  hasRead,
  isFavourite,
  lists,
  planPosition,
  readCount,
  recordOpened,
  setFavourite,
  setPlanPosition,
} from './library.js';
import { LENGTHS, TRADITIONS, lengthOf, traditionOf } from './prompt.js';
import { CLAUDE_BIN, EFFORT, MODEL, REVIEW, answerQuestion, reflectionFor } from './reflect.js';
import { SPEED, VOICES, speak, voiceStatus, warm } from './voice.js';
import {
  HAS_KEY,
  isOnline,
  knownTranslations,
  lookupProblem,
  onlineName,
  onlinePassage,
  onlineTranslations,
  reportShown,
  stillLooking,
} from './online.js';
import { OPEN_FILES, PASSWORD_MIN, PASSWORD_TOO_SHORT, PROTECTED, login, signedIn } from './auth.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 4747;
const FLAGS = new Set(process.argv.slice(2));
// --lan lets other devices on your network (a phone, say) open the app.
// HOST is set instead when Selah runs in a container, which has to answer
// on every address for anything outside it to reach it.
const LAN = FLAGS.has('--lan');
const HOST = process.env.HOST || (LAN ? '0.0.0.0' : '127.0.0.1');

if (PASSWORD_TOO_SHORT) {
  console.error(`SELAH_PASSWORD must be at least ${PASSWORD_MIN} characters. Selah has not started.`);
  process.exit(1);
}

/* ---------- choosing a passage ---------- */

const rand = (n) => Math.floor(Math.random() * n);

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const progress = () => ({ read: Math.min(readCount(), units().length), total: units().length });

// Choosing a passage changes nothing by itself. Whatever it would change (the
// place in the reading plan, a round of reading starting again) is handed
// back as commit(), which is called only once the passage has really been
// opened. A passage that fails to open therefore leaves everything as it was.

// A random unit from the scope that has not been read yet. When everything in
// the scope has been read, the round starts again.
function surprise(scope) {
  const pool = units().filter(inScope(scope));
  if (!pool.length) return { error: 'Nothing matches that choice.' };
  const fresh = pool.filter((unit) => !hasRead(keyOf(unit)));
  if (fresh.length) return { coords: fresh[rand(fresh.length)] };
  return { coords: pool[rand(pool.length)], startedAgain: true, commit: () => forgetRead(pool.map(keyOf)) };
}

// text is the translation a typed reference is looked up in.
function choose(body, text) {
  const all = units();
  switch (body.mode) {
    case 'today': {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date ?? '') ? body.date : new Date().toISOString().slice(0, 10);
      return { coords: all[hash(`selah ${date}`) % all.length] };
    }
    case 'order': {
      const startBook = Number.isInteger(body.startBook) ? all.findIndex((unit) => unit.b === body.startBook) : -1;
      const index = (startBook >= 0 ? startBook : planPosition()) % all.length;
      return { coords: all[index], commit: () => setPlanPosition((index + 1) % all.length) };
    }
    case 'reference': {
      const found = parseReference(body.reference, text);
      if (found.error) return found;
      return found.coords ? { coords: found.coords } : surprise(`book:${found.book}`);
    }
    case 'exact': {
      const coords = Object.fromEntries(['b', 'c', 'from', 'to'].map((k) => [k, Number(body[k])]));
      if (Object.values(coords).some((n) => !Number.isInteger(n) || n < 0)) return { error: 'Unknown passage.' };
      return { coords };
    }
    default:
      return surprise(body.scope);
  }
}

// The reading units that lie wholly inside a passage.
const unitsWithin = (passage) =>
  units()
    .filter((u) => u.b === passage.b && u.c === passage.c && u.from >= passage.from && u.to <= passage.to)
    .map(keyOf);

// A translation fetched from API.Bible is shown and read aloud, and that is
// all: its licence does not cover copying it or handing it to an AI. So for
// the reflection, the questions and the saved lists, the same verses in the
// World English Bible stand in for it.
const studyTranslation = (id) => (isOnline(id) ? 'web' : id);

function passageAt(body) {
  const t = translation(studyTranslation(body.translation ?? 'web'));
  if (!t) return { error: 'Unknown translation.' };
  const coords = Object.fromEntries(['b', 'c', 'from', 'to'].map((k) => [k, Number(body[k])]));
  if (Object.values(coords).some((n) => !Number.isInteger(n) || n < 0)) return { error: 'Unknown passage.' };
  const passage = describe(t, coords);
  if (!passage || passage.verses.length > EXPLICIT_MAX) return { error: 'Unknown passage.' };
  return { passage };
}

// The translations on offer. The ones in the app are always there; the ones
// from API.Bible are added as soon as it has answered, and the page is not
// kept waiting for that beyond a moment.
async function translationsNow() {
  const moment = new Promise((done) => setTimeout(done, 1200));
  const online = await Promise.race([onlineTranslations(), moment.then(knownTranslations)]);
  return {
    translations: [...TRANSLATIONS, ...online.map(({ id, name }) => ({ id, name }))],
    translationsPending: stillLooking(),
  };
}

const optionsFrom = (body) => ({ length: lengthOf(body.length).id, tradition: traditionOf(body.tradition) });

/* ---------- turning a recording into a smaller file ---------- */

// The page mixes voice and music into a WAV, which is large. If ffmpeg or
// macOS's afconvert is on this computer, it is squeezed into an .m4a.
const ENCODER = (() => {
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0) {
    return (from, to) => ['ffmpeg', ['-y', '-loglevel', 'error', '-i', from, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', to]];
  }
  if (existsSync('/usr/bin/afconvert')) {
    return (from, to) => ['/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '128000', from, to]];
  }
  return null;
})();
const UPLOAD_MAX = 700 * 1024 * 1024;

async function encode(req, res) {
  const folder = await mkdtemp(join(tmpdir(), 'selah-'));
  const wav = join(folder, 'session.wav');
  const m4a = join(folder, 'session.m4a');
  try {
    let received = 0;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > UPLOAD_MAX) req.destroy(new Error('That recording is too large.'));
    });
    await pipeline(req, createWriteStream(wav));
    const [command, args] = ENCODER(wav, m4a);
    await new Promise((done, fail) => {
      const child = spawn(command, args, { stdio: 'ignore' });
      child.on('error', fail);
      child.on('close', (code) => (code === 0 ? done() : fail(new Error('The recording could not be converted.'))));
    });
    res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Content-Length': (await stat(m4a)).size, 'Cache-Control': 'no-store' });
    await pipeline(createReadStream(m4a), res);
  } catch (err) {
    console.error(`[encode] ${err.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.destroy();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/* ---------- HTTP ---------- */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};
const SPEAK_MAX_CHARS = 600;

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((done, fail) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 20_000) fail(new Error('Request too large.'));
    });
    req.on('end', () => {
      try {
        done(JSON.parse(body || '{}'));
      } catch {
        fail(new Error('That request could not be read.'));
      }
    });
    req.on('error', fail);
  });
}

async function serveStatic(req, res, pathname) {
  const file = resolve(PUBLIC, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

const routes = {
  // Everything the page needs to draw its choices.
  'GET /api/setup': async (req, res) =>
    sendJson(res, 200, {
      ...(await translationsNow()),
      books: books(),
      lengths: LENGTHS.map(({ id, label }) => ({ id, label })),
      traditions: TRADITIONS.map(({ id, label }) => ({ id, label })),
      pace: SPEED,
      progress: progress(),
      nextInOrder: label(units()[planPosition() % units().length]),
      checked: REVIEW,
      audio: ENCODER ? 'm4a' : 'wav',
    }),

  // For the page to ask again when the first answer came before API.Bible's did.
  'GET /api/translations': async (req, res) => sendJson(res, 200, await translationsNow()),

  // The page reports to API.Bible itself that a passage was shown. When it
  // cannot, because its reporting script was blocked, it asks for that here.
  'POST /api/shown': async (req, res) => {
    const body = await readBody(req);
    const tokens = (Array.isArray(body.tokens) ? body.tokens : []).filter((t) => typeof t === 'string' && /^[\w-]{20,800}$/.test(t)).slice(0, 20);
    const id = (value) => (typeof value === 'string' && /^[\w-]{8,64}$/.test(value) ? value : '');
    if (!tokens.length || !id(body.device) || !id(body.session)) return sendJson(res, 400, { error: 'Nothing to report.' });
    try {
      await reportShown(tokens, id(body.device), id(body.session));
      sendJson(res, 200, { reported: tokens.length });
    } catch (err) {
      console.error(`[API.Bible] ${err.message}`);
      sendJson(res, 502, { error: err.message });
    }
  },

  'GET /api/voices': (req, res) => sendJson(res, 200, voiceStatus()),

  'GET /api/library': (req, res) => sendJson(res, 200, { ...lists(), progress: progress() }),

  // Chooses a passage, notes that it was opened, and returns it.
  'POST /api/open': async (req, res) => {
    const body = await readBody(req);
    const id = body.translation ?? 'web';
    const t = translation(studyTranslation(id));
    if (!t) return sendJson(res, 400, { error: 'Unknown translation.' });
    const chosen = choose(body, t);
    if (chosen.error) return sendJson(res, 400, { error: chosen.error });
    const passage = describe(t, chosen.coords);
    if (!passage || passage.verses.length > EXPLICIT_MAX) {
      // most likely verses that another translation numbers differently
      return sendJson(res, 404, { error: `Those verses are not in the ${t.name} under that numbering. Choose the passage again in this translation.` });
    }

    let notice = '';
    if (isOnline(id)) {
      try {
        const toChapterEnd = passage.to === t.books[passage.b].chapters[passage.c].at(-1)[0];
        const fetched = await onlinePassage(id, chosen.coords, { toChapterEnd });
        passage.translation = { id, name: fetched.name, licensed: true, copyright: fetched.copyright };
        passage.verses = fetched.verses;
        passage.fumsToken = fetched.fumsToken;
      } catch (err) {
        console.error(`[API.Bible] ${passage.reference}: ${err.message}`);
        // Trying again will not help if the translation simply lacks these
        // verses, and would hold up reading in order for good. Show them in
        // the World English Bible and say so.
        if (!err.missing) return sendJson(res, 502, { error: err.message });
        notice = `The ${onlineName(id)} has no text for these verses, so they are shown in the ${t.name}.`;
      }
    }

    chosen.commit?.();
    recordOpened(passage, unitsWithin(passage));
    sendJson(res, 200, {
      ...passage,
      notice,
      favourite: isFavourite(passage.key),
      isUnit: indexOfUnit(passage) >= 0,
      startedAgain: Boolean(chosen.startedAgain),
      progress: progress(),
      nextInOrder: label(units()[planPosition() % units().length]),
    });
  },

  'POST /api/reflect': async (req, res) => {
    const body = await readBody(req);
    const { passage, error } = passageAt(body);
    if (!passage) return sendJson(res, 404, { error });
    try {
      const { reflection, review, questions, fromLibrary } = await reflectionFor(passage, optionsFrom(body));
      sendJson(res, 200, { reflection, review, questions, fromLibrary });
    } catch (err) {
      console.error(`[reflect] ${passage.reference}: ${err.message}`);
      sendJson(res, 502, { error: err.message });
    }
  },

  'POST /api/ask': async (req, res) => {
    const body = await readBody(req);
    const { passage, error } = passageAt(body);
    if (!passage) return sendJson(res, 404, { error });
    try {
      sendJson(res, 200, await answerQuestion(passage, optionsFrom(body), body.question));
    } catch (err) {
      console.error(`[ask] ${passage.reference}: ${err.message}`);
      sendJson(res, 502, { error: err.message });
    }
  },

  'POST /api/favourite': async (req, res) => {
    const body = await readBody(req);
    const { passage, error } = passageAt(body);
    if (!passage) return sendJson(res, 404, { error });
    setFavourite(passage, Boolean(body.favourite));
    sendJson(res, 200, { favourite: isFavourite(passage.key) });
  },

  'POST /api/speak': async (req, res) => {
    const body = await readBody(req);
    const words = typeof body.text === 'string' ? body.text.trim() : '';
    if (!words || words.length > SPEAK_MAX_CHARS || !VOICES.some((v) => v.id === body.voice)) {
      return sendJson(res, 400, { error: 'Nothing to say, or an unknown voice.' });
    }
    // If the page stops waiting (a new passage, a jump), skip this piece.
    const job = { cancelled: false };
    res.on('close', () => (job.cancelled = !res.writableEnded));
    try {
      const wav = await speak(words, body.voice, body.speed, job);
      if (!wav || job.cancelled) return res.end();
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, 'Cache-Control': 'no-store' });
      res.end(wav);
    } catch (err) {
      console.error(`[speak] ${err.message}`);
      sendJson(res, 503, { error: err.message });
    }
  },

  'POST /api/encode': (req, res) => (ENCODER ? encode(req, res) : sendJson(res, 404, { error: 'No converter is installed.' })),
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    // For the container's own check that it is running; it gives nothing away.
    if (url.pathname === '/healthz') return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    if (PROTECTED) {
      res.setHeader('X-Robots-Tag', 'noindex');
      if (url.pathname === '/login') return await login(req, res);
      if (!signedIn(req) && !(OPEN_FILES.has(url.pathname) && (req.method === 'GET' || req.method === 'HEAD'))) {
        if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Sign in again to carry on.' });
        return res.writeHead(303, { Location: '/login' }).end();
      }
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) return await route(req, res);
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, url.pathname);
    res.writeHead(405).end();
  } catch (err) {
    console.error(err.message);
    if (!res.headersSent) sendJson(res, 400, { error: err.message || 'Something went wrong on the server.' });
  }
});

server.listen(PORT, HOST, () => {
  const address = `http://localhost:${PORT}`;
  console.log(`Selah is open at ${address}`);
  if (LAN) {
    const others = Object.values(networkInterfaces())
      .flat()
      .filter((net) => net.family === 'IPv4' && !net.internal)
      .map((net) => `http://${net.address}:${PORT}`);
    console.log(`On your phone, on the same Wi-Fi: ${others.join(' or ') || 'no network address found'}`);
    if (!PROTECTED) console.log('Anyone on this network can open that address and use your Claude subscription through it.');
  }
  console.log(PROTECTED ? 'Password: required to open it' : 'Password: none set');
  if (HAS_KEY) {
    onlineTranslations().then((list) => {
      if (lookupProblem()) console.log('API.Bible: the extra translations are not available yet; it will be asked again in five minutes');
      else console.log(`API.Bible: ${list.length ? list.map((t) => t.name).join(', ') : 'the key reaches none of the extra translations'}`);
    });
  }
  console.log(`Reflections: Claude Code CLI (${CLAUDE_BIN}), model "${MODEL}", effort "${EFFORT}", second check ${REVIEW ? 'on' : 'off'}`);

  const began = Date.now();
  console.log('Voice: loading (the first run downloads it, which can take a few minutes)');
  warm().then(
    () => console.log(`Voice: ready after ${((Date.now() - began) / 1000).toFixed(1)}s`),
    (err) => console.log(`Voice: ${err.message}`),
  );

  if (FLAGS.has('--open')) {
    const [command, args] =
      process.platform === 'darwin' ? ['open', [address]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', address]] : ['xdg-open', [address]];
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
});
