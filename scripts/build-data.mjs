// Converts a getbible.net v2 translation dump into the compact format the app reads.
//   node scripts/build-data.mjs <input.json> <output.json>
// Sources (both public domain):
//   https://api.getbible.net/v2/web.json   World English Bible
//   https://api.getbible.net/v2/kjv.json   King James Version
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node scripts/build-data.mjs <input.json> <output.json>');
  process.exit(1);
}

const RENAME = { 'Revelation of John': 'Revelation' };
const clean = (text) =>
  text
    .replace(/\s+/g, ' ')
    .replace(/(\w)–(\w)/g, '$1-$2') // en dash used as a hyphen inside names
    .trim();

const src = JSON.parse(readFileSync(input, 'utf8'));
const out = {
  id: src.abbreviation,
  name: src.translation,
  books: src.books.map((book) => ({
    name: RENAME[book.name] ?? book.name,
    chapters: book.chapters.map((chapter) =>
      chapter.verses.map((v) => [v.verse, clean(v.text)]).filter(([, text]) => text),
    ),
  })),
};

writeFileSync(output, JSON.stringify(out));
const verses = out.books.reduce((n, b) => n + b.chapters.reduce((m, c) => m + c.length, 0), 0);
console.log(`${out.name}: ${out.books.length} books, ${verses} verses -> ${output}`);
