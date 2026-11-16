// Builds data/sections.json: for every chapter, two lists of verse numbers.
// The first is where a new section begins (a story, a parable, a psalm, a step
// in an argument); the second is where a smaller part within a section begins,
// which is where a very long section is divided.
// The breaks come from the section headings of the Berean Standard Bible,
// which is in the public domain. Only the positions are kept, not the text.
//   node scripts/build-sections.mjs <folder of BSB .usfm files> data/sections.json
// Source: https://ebible.org/Scriptures/engbsb_usfm.zip
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [folder, output] = process.argv.slice(2);
if (!folder || !output) {
  console.error('usage: node scripts/build-sections.mjs <usfm-folder> <output.json>');
  process.exit(1);
}

const BOOKS = `GEN EXO LEV NUM DEU JOS JDG RUT 1SA 2SA 1KI 2KI 1CH 2CH EZR NEH EST JOB PSA PRO ECC SNG ISA JER LAM
EZK DAN HOS JOL AMO OBA JON MIC NAM HAB ZEP HAG ZEC MAL MAT MRK LUK JHN ACT ROM 1CO 2CO GAL EPH PHP COL 1TH 2TH
1TI 2TI TIT PHM HEB JAS 1PE 2PE 1JN 2JN 3JN JUD REV`.split(/\s+/);

const files = readdirSync(folder);
const sections = BOOKS.map((code) => {
  const file = files.find((name) => name.includes(code) && name.endsWith('.usfm'));
  if (!file) throw new Error(`No file for ${code}`);
  const chapters = [];
  let current = null;
  let heading = 0; // 1 after a section heading, 2 after a smaller one
  for (const line of readFileSync(join(folder, file), 'utf8').split('\n')) {
    const chapter = line.match(/^\\c\s+(\d+)/);
    if (chapter) {
      current = chapters[Number(chapter[1]) - 1] = [[], []];
      continue;
    }
    if (/^\\s1?\s/.test(line)) heading = 1;
    else if (/^\\s2\s/.test(line) && heading !== 1) heading = 2;
    const verse = line.match(/^\\v\s+(\d+)/);
    if (verse && current) {
      const n = Number(verse[1]);
      if (heading === 1 || current[0].length === 0) current[0].push(n);
      else if (heading === 2) current[1].push(n);
      heading = 0;
    }
  }
  return chapters.map((lists) => lists ?? [[], []]);
});

writeFileSync(output, JSON.stringify(sections));
const total = sections.reduce((n, book) => n + book.reduce((m, ch) => m + ch[0].length, 0), 0);
console.log(`${total} sections across ${sections.reduce((n, b) => n + b.length, 0)} chapters -> ${output}`);
