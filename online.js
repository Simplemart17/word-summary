// Translations that are still in copyright (NKJV, NIV, AMP and the like)
// cannot be kept in this folder. With your own API.Bible key they are fetched
// a passage at a time instead, under API.Bible's licence, which this file
// keeps to:
//   - the text is held in memory only, never written to disk, and thrown
//     away after fourteen days (the licence allows thirty);
//   - the publisher's copyright line travels with every passage, to be shown;
//   - each passage carries a token that is reported back when it is displayed.
// The text is never sent to Claude: see studyTranslation in server.js.
//
// Put the key in .env as API_BIBLE_KEY. Without one, only the translations in
// data/ are offered.

import { readFileSync } from 'node:fs';
import { isBookName } from './scripture.js';

const BASE = process.env.API_BIBLE_URL || 'https://rest.api.bible/v1'; // the override is for tests
export const KEEP_MS = 14 * 86_400_000; // how long fetched text may be held
const KEEP_MAX = 80;
const RECHECK_MS = 24 * 3_600_000; // how often to ask again which translations the key reaches
const RETRY_MS = 5 * 60_000; // and how soon after that question failed
const LIST_TIMEOUT_MS = 10_000;
const PASSAGE_TIMEOUT_MS = 15_000;

// What to look for in the list of Bibles a key can reach. Which of these
// appear depends on the plan the key is on.
const WANTED = [
  { id: 'nkjv', name: 'New King James Version', matches: (b) => /^NKJV/i.test(b.abbreviation ?? '') },
  { id: 'niv', name: 'New International Version', matches: (b) => /^NIV/i.test(b.abbreviation ?? '') },
  { id: 'amp', name: 'Amplified Bible', matches: (b) => /^AMP$/i.test(b.abbreviation ?? '') },
  { id: 'msg', name: 'The Message', matches: (b) => /^MSG/i.test(b.abbreviation ?? '') || /^The Message/i.test(b.name ?? '') },
];
export const isOnline = (id) => WANTED.some((w) => w.id === id);
export const onlineName = (id) => WANTED.find((w) => w.id === id)?.name ?? '';

const BOOKS = `GEN EXO LEV NUM DEU JOS JDG RUT 1SA 2SA 1KI 2KI 1CH 2CH EZR NEH EST JOB PSA PRO ECC SNG ISA JER LAM
EZK DAN HOS JOL AMO OBA JON MIC NAM HAB ZEP HAG ZEC MAL MAT MRK LUK JHN ACT ROM 1CO 2CO GAL EPH PHP COL 1TH 2TH
1TI 2TI TIT PHM HEB JAS 1PE 2PE 1JN 2JN 3JN JUD REV`.split(/\s+/);

// The key comes from the environment, or, when Selah is started with plain
// "npm start", from the same .env file Docker reads.
const KEY = (() => {
  if (process.env.API_BIBLE_KEY) return process.env.API_BIBLE_KEY.trim();
  try {
    const line = readFileSync(new URL('./.env', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => /^\s*API_BIBLE_KEY\s*=/.test(l));
    return (line ?? '').split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
  } catch {
    return '';
  }
})();
export const HAS_KEY = KEY.length > 0;

// An error with a plain message for the reader. missing is true when
// API.Bible answered but has no such text, so trying again will not help.
function problem(message, missing = false) {
  return Object.assign(new Error(message), { missing });
}

async function ask(path, timeout) {
  let response;
  let body;
  try {
    response = await fetch(`${BASE}${path}`, { headers: { 'api-key': KEY }, signal: AbortSignal.timeout(timeout) });
    body = await response.text(); // inside the try: the timeout can also fire while the answer is arriving
  } catch (err) {
    throw problem(
      err.name === 'TimeoutError' || err.name === 'AbortError'
        ? 'API.Bible took too long to answer. Try again in a moment.'
        : 'API.Bible could not be reached. Check the internet connection and try again.',
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw problem('API.Bible turned the key down. Check API_BIBLE_KEY in .env, and that your plan includes this translation.');
  }
  if (response.status === 404) throw problem('API.Bible has no such passage in this translation.', true);
  if (response.status === 429) throw problem('API.Bible says the day’s allowance for this key is used up. Try again tomorrow.');
  if (!response.ok) throw problem(`API.Bible is having trouble (it answered ${response.status}). Try again in a moment.`);
  try {
    return JSON.parse(body);
  } catch {
    throw problem('API.Bible sent an answer that could not be read. Try again in a moment.');
  }
}

/* ---------- which translations this key can reach ---------- */

let lookup = null; // the last answer: { at, list, error }
let looking = null; // the question, while it is in flight

// Asks at most once at a time, remembers the answer for a day, and after a
// failure keeps the last good list and asks again in five minutes.
export function onlineTranslations() {
  if (!HAS_KEY) return Promise.resolve([]);
  if (lookup && Date.now() - lookup.at < (lookup.error ? RETRY_MS : RECHECK_MS)) return Promise.resolve(lookup.list);
  looking ??= ask('/bibles?language=eng', LIST_TIMEOUT_MS)
    .then(
      ({ data }) => {
        const list = WANTED.flatMap((wanted) => {
          const bible = (data ?? []).find(wanted.matches);
          return bible ? [{ id: wanted.id, name: wanted.name, bibleId: bible.id, copyright: clean(bible.copyright) }] : [];
        });
        lookup = { at: Date.now(), list, error: null };
      },
      (error) => {
        console.error(`[API.Bible] ${error.message}`);
        lookup = { at: Date.now(), list: lookup?.list ?? [], error };
      },
    )
    .then(() => {
      looking = null;
      return lookup.list;
    });
  return looking;
}

// What is known right now, without waiting for API.Bible.
export const knownTranslations = () => lookup?.list ?? [];
export const stillLooking = () => HAS_KEY && !lookup;
export const lookupProblem = () => lookup?.error?.message ?? '';

/* ---------- reading the text out of what API.Bible sends ---------- */

const clean = (text) => (text ?? '').replace(/\s+/g, ' ').trim();

// Some translations print cross-references inside the verse, such as
// "[Rev 7:17]" or "[See Ps 23:1; 27:4]". They are shown as printed but not
// read aloud. Anything else in brackets is part of the text and is kept.
function isCrossReference(inside) {
  const parts = inside
    .replace(/^\s*(see also|see|cf\.?|compare)\s+/i, '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return false;
  return parts.every((part, i) => {
    const named = /^((?:[1-3] ?)?[A-Za-z][A-Za-z .]*?)\.?\s*(\d+(?::\d+)?(?:\s*[-–,]\s*\d+(?::\d+)?)*)$/.exec(part);
    if (named) return isBookName(named[1]);
    // after the first, a part may leave the book out: "Ps 23:1; 27:4"
    return i > 0 && /^\d+(?::\d+)?(?:\s*[-–,]\s*\d+(?::\d+)?)*$/.test(part);
  });
}

export const withoutCrossReferences = (text) =>
  clean(text.replace(/\[([^[\]]{3,80})\]/g, (whole, inside) => (isCrossReference(inside) ? ' ' : whole))).replace(/\s+([,.;:!?])/g, '$1');

// The text arrives as a tree of paragraphs and character styles. Every piece
// of Scripture in it is labelled with its verse; headings and chapter labels
// are not, and are left out. Where a translation prints several verses as one
// block, the block is kept whole and marked with the last verse it covers.
export function versesFrom(content, book, chapter) {
  const blocks = new Map(); // first verse number -> { n, through, text }
  let newParagraph = false;
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node) return;
    if (node.type === 'text' && node.attrs?.verseId) {
      const ids = [...node.attrs.verseId.split('-'), ...(node.attrs.verseOrgIds ?? [])];
      const numbers = ids
        .map((id) => id.split('.'))
        .filter(([b, c]) => b === book && Number(c) === chapter)
        .map(([, , v]) => Number(v))
        .filter(Number.isInteger);
      if (!numbers.length) return;
      const n = Math.min(...numbers);
      const block = blocks.get(n) ?? { n, through: n, text: '' };
      block.through = Math.max(block.through, ...numbers);
      block.text += (newParagraph && block.text ? ' ' : '') + node.text;
      blocks.set(n, block);
      newParagraph = false;
    }
    walk(node.items);
    if (node.name === 'para') newParagraph = true;
  };
  walk(content);
  return [...blocks.values()]
    .map(({ n, through, text }) => {
      const verse = { n, text: clean(text) };
      if (through > n) verse.through = through;
      const spoken = withoutCrossReferences(verse.text);
      if (spoken !== verse.text) verse.spoken = spoken;
      return verse;
    })
    .filter((verse) => verse.text)
    .sort((a, b) => a.n - b.n);
}

/* ---------- what is held, and for how long ---------- */

const kept = new Map(); // "niv:42:2:16-21" -> { at, value }

function hold(key, value) {
  kept.delete(key);
  kept.set(key, { at: Date.now(), value });
  if (kept.size > KEEP_MAX) kept.delete(kept.keys().next().value);
  return value;
}

function held(key) {
  const entry = kept.get(key);
  if (entry && Date.now() - entry.at < KEEP_MS) return entry.value;
  kept.delete(key);
  return null;
}

// Nothing is kept past its time merely because nobody asked for it again.
function sweep() {
  for (const [key, entry] of kept) if (Date.now() - entry.at >= KEEP_MS) kept.delete(key);
}
setInterval(sweep, 3_600_000).unref();

/* ---------- a passage ---------- */

// The number of the last verse of a chapter in one translation.
async function lastVerse(translation, book, chapter) {
  const key = `${translation.id}:${book}.${chapter}:end`;
  const known = held(key);
  if (known) return known;
  const { data } = await ask(`/bibles/${translation.bibleId}/chapters/${book}.${chapter}/verses`, PASSAGE_TIMEOUT_MS);
  const numbers = (data ?? []).map((verse) => Number(String(verse.id).split('-').pop().split('.').pop())).filter(Number.isInteger);
  if (!numbers.length) throw problem('API.Bible has no such passage in this translation.', true);
  return hold(key, Math.max(...numbers));
}

// Returns { name, verses, copyright, fumsToken } for one translation and one
// passage. The passage is given in the World English Bible's verse numbers;
// toChapterEnd says it runs to the end of its chapter there, in which case it
// is read to the end of the chapter in this translation too, which may number
// its closing verses differently.
export async function onlinePassage(id, { b, c, from, to }, { toChapterEnd = false } = {}) {
  const translation = (await onlineTranslations()).find((t) => t.id === id);
  if (!translation) {
    if (!HAS_KEY) throw problem('That translation needs an API.Bible key. Put one in .env as API_BIBLE_KEY.');
    if (lookup?.error) throw lookup.error; // the list itself could not be fetched; say why
    throw problem('Your API.Bible key does not include that translation.');
  }

  const key = `${id}:${b}:${c}:${from}-${to}${toChapterEnd ? ':end' : ''}`;
  const known = held(key);
  if (known) return known;

  const book = BOOKS[b];
  const chapter = c + 1;
  let last = to;
  if (toChapterEnd) {
    last = await lastVerse(translation, book, chapter);
    if (from > last) throw problem('API.Bible has no such passage in this translation.', true);
  }
  const start = `${book}.${chapter}.${from}`;
  const span = from === last ? start : `${start}-${book}.${chapter}.${last}`;
  const query = 'content-type=json&include-notes=false&include-titles=false&include-chapter-numbers=false&include-verse-numbers=false&include-verse-spans=false';
  const { data, meta } = await ask(`/bibles/${translation.bibleId}/passages/${span}?${query}`, PASSAGE_TIMEOUT_MS);

  const verses = versesFrom(data?.content, book, chapter);
  if (!verses.length) throw problem('API.Bible has no such passage in this translation.', true);
  return hold(key, {
    name: translation.name,
    verses,
    copyright: clean(data.copyright) || translation.copyright,
    fumsToken: meta?.fumsToken ?? '',
  });
}

/* ---------- telling API.Bible a passage was shown ---------- */

// The page normally reports this itself. When it cannot (its reporting script
// was blocked, say), it asks the server to, and this is how.
export async function reportShown(tokens, device, session) {
  const query = new URLSearchParams([...tokens.map((token) => ['t', token]), ['dId', device], ['sId', session]]);
  const response = await fetch(`https://fums.api.bible/f3?${query}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`API.Bible's usage report answered ${response.status}.`);
}
