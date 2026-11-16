// The Bible text, the sections it is read in, and finding a passage: at
// random, for today, next in order, or by a typed reference.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = join(dirname(fileURLToPath(import.meta.url)), 'data');

export const TRANSLATIONS = [
  { id: 'web', name: 'World English Bible' },
  { id: 'kjv', name: 'King James Version' },
];

const loaded = new Map();
export function translation(id) {
  if (!TRANSLATIONS.some((t) => t.id === id)) return null;
  if (!loaded.has(id)) loaded.set(id, JSON.parse(readFileSync(join(DATA, `${id}.json`), 'utf8')));
  return loaded.get(id);
}

const PSALMS = 18;
const FIRST_NT_BOOK = 39;
const UNIT_MIN = 5; // shorter sections are joined to a neighbour
const UNIT_MAX = 30; // longer ones are divided
export const EXPLICIT_MAX = 60; // the most verses a typed reference may ask for

const GENRES = [
  { upTo: 4, id: 'law', kind: 'Law' },
  { upTo: 16, id: 'history', kind: 'Historical narrative' },
  { upTo: 21, id: 'wisdom', kind: 'Wisdom and poetry' },
  { upTo: 38, id: 'prophets', kind: 'Prophecy' },
  { upTo: 42, id: 'gospels', kind: 'Gospel' },
  { upTo: 43, id: 'history', kind: 'Historical narrative' },
  { upTo: 64, id: 'letters', kind: 'Letter' },
  { upTo: 65, id: 'apocalyptic', kind: 'Apocalyptic vision' },
];
const genreOf = (b) => GENRES.find((g) => b <= g.upTo);

const endsSentence = (text) => /[.!?]["'’”)\]]*$/.test(text);
const ORDINAL = { 1: 'First', 2: 'Second', 3: 'Third' };
const spokenBook = (name) => name.replace(/^([123]) /, (_, d) => `${ORDINAL[d]} `);

export const keyOf = ({ b, c, from, to }) => `${b}:${c}:${from}-${to}`;

/* ---------- sections ---------- */

// The units the Bible is read in. Each is a whole section (a story, a psalm,
// a step in an argument) taken from data/sections.json, with very short ones
// joined to a neighbour and very long ones divided at the end of a sentence.
// They are worked out once, from the World English Bible, so that a unit means
// the same verses whichever translation is being read.
let unitList;
let unitIndex;

function buildUnits() {
  const text = translation('web');
  const sections = JSON.parse(readFileSync(join(DATA, 'sections.json'), 'utf8'));
  const units = [];

  text.books.forEach((book, b) => {
    book.chapters.forEach((verses, c) => {
      const numbers = verses.map((v) => v[0]);
      const push = (s, e) => units.push({ b, c, from: numbers[s], to: numbers[e] });

      const at = (list) => (list ?? []).map((n) => numbers.findIndex((x) => x >= n)).filter((i) => i > 0);
      const [hard, soft] = sections[b]?.[c] ?? [[], []];
      const parts = at(soft); // where a smaller part of a section begins

      let ranges;
      if (b === PSALMS && numbers.length === 176) {
        ranges = Array.from({ length: 22 }, (_, i) => [i * 8, i * 8 + 7]); // Psalm 119's stanzas
      } else {
        const sorted = [...new Set([0, ...at(hard)])].sort((x, y) => x - y);
        ranges = sorted.map((s, i) => [s, (sorted[i + 1] ?? numbers.length) - 1]);
      }
      const size = (range) => range[1] - range[0] + 1;

      // A very short section joins whichever neighbour is the shorter.
      for (;;) {
        const i = ranges.findIndex((range) => size(range) < UNIT_MIN);
        if (i < 0 || ranges.length === 1) break;
        const before = ranges[i - 1];
        const after = ranges[i + 1];
        if (before && (!after || size(before) <= size(after))) {
          before[1] = ranges[i][1];
        } else {
          after[0] = ranges[i][0];
        }
        ranges.splice(i, 1);
      }

      // A very long one is divided, at a smaller heading if it has any and
      // otherwise at the end of a sentence, into parts of about twenty verses.
      for (const [s, e] of ranges) {
        let start = s;
        while (e - start + 1 > UNIT_MAX) {
          const breaks = parts.filter((i) => i - start >= UNIT_MIN && i - start <= UNIT_MAX && e - i + 1 >= UNIT_MIN);
          let next;
          if (breaks.length) {
            next = breaks.reduce((best, i) => (Math.abs(i - start - 20) < Math.abs(best - start - 20) ? i : best));
          } else {
            const left = e - start + 1;
            let end = start + Math.round(left / Math.ceil(left / 20)) - 1;
            let forward = end;
            while (forward < e - UNIT_MIN && forward - end < 4 && !endsSentence(verses[forward][1])) forward++;
            if (endsSentence(verses[forward][1])) end = forward;
            else while (end > start + UNIT_MIN && !endsSentence(verses[end][1])) end--;
            next = end + 1;
          }
          push(start, next - 1);
          start = next;
        }
        push(start, e);
      }
    });
  });
  return units;
}

export function units() {
  if (!unitList) {
    unitList = buildUnits();
    unitIndex = new Map(unitList.map((unit, i) => [keyOf(unit), i]));
  }
  return unitList;
}

export const indexOfUnit = (coords) => (units(), unitIndex.get(keyOf(coords)) ?? -1);

// "all", "ot", "nt" or "book:17"
export function inScope(scope) {
  if (scope === 'ot') return (u) => u.b < FIRST_NT_BOOK;
  if (scope === 'nt') return (u) => u.b >= FIRST_NT_BOOK;
  const book = /^book:(\d+)$/.exec(scope ?? '');
  if (book) return (u) => u.b === Number(book[1]);
  return () => true;
}

export function books() {
  return translation('web').books.map((book, index) => ({
    index,
    name: book.name,
    testament: index < FIRST_NT_BOOK ? 'ot' : 'nt',
    chapters: book.chapters.length,
  }));
}

/* ---------- describing a passage ---------- */

export function describe(t, { b, c, from, to }) {
  const book = t.books[b];
  const chapter = book?.chapters[c];
  if (!chapter) return null;
  const verses = chapter.filter(([n]) => n >= from && n <= to).map(([n, text]) => ({ n, text }));
  if (!verses.length) return null;
  from = verses[0].n;
  to = verses.at(-1).n;

  const whole = verses.length === chapter.length;
  const singleChapter = book.chapters.length === 1;
  const psalm = b === PSALMS;
  const title = psalm ? `Psalm ${c + 1}` : singleChapter ? book.name : `${book.name} ${c + 1}`;
  const spokenTitle = psalm
    ? `Psalm ${c + 1}`
    : singleChapter
      ? spokenBook(book.name)
      : `${spokenBook(book.name)}, chapter ${c + 1}`;
  const span = from === to ? `${from}` : `${from}–${to}`;
  const spokenSpan = from === to ? `verse ${from}` : `verses ${from} to ${to}`;
  const genre = genreOf(b);

  return {
    translation: { id: t.id, name: t.name },
    b,
    c,
    from,
    to,
    key: keyOf({ b, c, from, to }),
    whole,
    unit: psalm ? 'psalm' : singleChapter ? 'book' : 'chapter',
    chapterVerses: chapter.length,
    title,
    reference: whole ? title : singleChapter ? `${title} ${span}` : `${title}:${span}`,
    spoken: whole ? spokenTitle : `${spokenTitle}, ${spokenSpan}`,
    genre: genre.id,
    kind: genre.kind,
    verses,
  };
}

// A short label for a unit, without loading its text: "Luke 15:11–32"
export function label(coords) {
  return describe(translation('web'), coords)?.reference ?? '';
}

/* ---------- typed references ---------- */

const ALIASES = {
  gen: 0, ex: 1, exod: 1, lev: 2, num: 3, deut: 4, dt: 4, josh: 5, judg: 6, jdg: 6, ruth: 7,
  '1sam': 8, '2sam': 9, '1kgs': 10, '2kgs': 11, '1ki': 10, '2ki': 11, '1chr': 12, '2chr': 13, '1ch': 12, '2ch': 13,
  ezra: 14, neh: 15, esth: 16, est: 16, job: 17, ps: 18, psa: 18, psalm: 18, psalms: 18, prov: 19, pr: 19,
  eccl: 20, ecc: 20, qoheleth: 20, song: 21, sos: 21, songofsongs: 21, canticles: 21, isa: 22, jer: 23, lam: 24,
  ezek: 25, eze: 25, dan: 26, hos: 27, joel: 28, amos: 29, obad: 30, jonah: 31, mic: 32, nah: 33, hab: 34,
  zeph: 35, hag: 36, zech: 37, mal: 38, matt: 39, mt: 39, mark: 40, mk: 40, luke: 41, lk: 41, john: 42, jn: 42,
  acts: 43, rom: 44, '1cor': 45, '2cor': 46, gal: 47, eph: 48, phil: 49, php: 49, col: 50, '1thess': 51,
  '2thess': 52, '1th': 51, '2th': 52, '1tim': 53, '2tim': 54, titus: 55, tit: 55, phlm: 56, philem: 56, heb: 57,
  jas: 58, jam: 58, '1pet': 59, '2pet': 60, '1pe': 59, '2pe': 60, '1jn': 61, '2jn': 62, '3jn': 63, '1john': 61,
  '2john': 62, '3john': 63, jude: 64, rev: 65, revelations: 65, apocalypse: 65,
};

function findBook(words) {
  const tidy = words
    .toLowerCase()
    .replace(/^(first|1st|i)\s+(?=[a-z])/, '1')
    .replace(/^(second|2nd|ii)\s+(?=[a-z])/, '2')
    .replace(/^(third|3rd|iii)\s+(?=[a-z])/, '3')
    .replace(/[^a-z0-9]/g, '');
  if (!tidy) return -1;
  if (tidy in ALIASES) return ALIASES[tidy];
  const names = translation('web').books.map((book) => book.name.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const exact = names.indexOf(tidy);
  if (exact >= 0) return exact;
  const starting = names.map((name, i) => (name.startsWith(tidy) ? i : -1)).filter((i) => i >= 0);
  return tidy.length >= 3 && starting.length === 1 ? starting[0] : -1;
}

// Turns "John 3:16-21", "ps 23", "Jude 5-9" or "Romans" into coordinates.
// Returns { coords }, { book } (a whole multi-chapter book), or { error }.
export function parseReference(input) {
  const match = /^\s*((?:[1-3](?:st|nd|rd)?|i{1,3}|first|second|third)?\s*[a-z][a-z .]*?)\s*(?:(\d+)(?:\s*[:.]\s*(\d+))?(?:\s*[-–—]\s*(\d+))?)?\s*$/i.exec(
    input ?? '',
  );
  if (!match) return { error: 'That does not look like a reference. Try something like "John 3:16-21" or "Psalm 23".' };
  const [, bookWords, first, verse, last] = match;
  const b = findBook(bookWords);
  if (b < 0) return { error: `No book of the Bible matches "${bookWords.trim()}".` };

  const book = translation('web').books[b];
  const single = book.chapters.length === 1;
  if (first === undefined) return single ? whole(b, 0) : { book: b };

  let c;
  let from;
  let to;
  if (verse !== undefined) {
    c = Number(first) - 1;
    from = Number(verse);
    to = last === undefined ? from : Number(last);
  } else if (single) {
    c = 0;
    from = Number(first);
    to = last === undefined ? from : Number(last);
  } else if (last !== undefined) {
    return { error: 'Choose one chapter at a time, such as "Romans 8" or "Romans 8:28-39".' };
  } else {
    return whole(b, Number(first) - 1);
  }

  const chapter = book.chapters[c];
  if (!chapter) return { error: `${book.name} has ${book.chapters.length} chapters.` };
  if (to < from) [from, to] = [to, from];
  const found = chapter.filter(([n]) => n >= from && n <= to);
  if (!found.length) return { error: `${label({ b, c, from: 1, to: 999 })} has ${chapter.length} verses.` };
  if (found.length > EXPLICIT_MAX) return tooLong(found.length);
  return { coords: { b, c, from: found[0][0], to: found.at(-1)[0] } };
}

function whole(b, c) {
  const book = translation('web').books[b];
  const chapter = book.chapters[c];
  if (!chapter) return { error: `${book.name} has ${book.chapters.length} chapters.` };
  if (chapter.length > EXPLICIT_MAX) return tooLong(chapter.length);
  return { coords: { b, c, from: chapter[0][0], to: chapter.at(-1)[0] } };
}

const tooLong = (count) => ({
  error: `That is ${count} verses. Choose ${EXPLICIT_MAX} or fewer, by adding a verse range such as "1-20".`,
});
