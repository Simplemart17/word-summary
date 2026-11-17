// Verses that the getbible.net copy of a translation lacks, so that a rebuilt
// data file comes out whole.
//   node scripts/supplement.mjs data/web.json     adds them to an existing file
//
// The World English Bible prints the doxology that most translations number
// Romans 16:25-27 at the end of chapter 14, as verses 24 to 26. getbible.net
// drops them. The text below is the World English Bible's own, checked against
// two other copies (API.Bible and bible-api.com).
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROMANS = 44;

const MISSING = {
  web: [
    [ROMANS, 14, 24, 'Now to him who is able to establish you according to my Good News and the preaching of Jesus Christ, according to the revelation of the mystery which has been kept secret through long ages,'],
    [ROMANS, 14, 25, 'but now is revealed, and by the Scriptures of the prophets, according to the commandment of the eternal God, is made known for obedience of faith to all the nations;'],
    [ROMANS, 14, 26, 'to the only wise God, through Jesus Christ, to whom be the glory forever! Amen.'],
  ],
};

// Adds any missing verses to a translation in the app's own format. Returns how many were added.
export function supplement(translation) {
  let added = 0;
  for (const [book, chapter, verse, text] of MISSING[translation.id] ?? []) {
    const verses = translation.books[book].chapters[chapter - 1];
    if (verses.some(([n]) => n === verse)) continue;
    verses.push([verse, text]);
    verses.sort((a, b) => a[0] - b[0]);
    added++;
  }
  return added;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/supplement.mjs <data file>');
    process.exit(1);
  }
  const translation = JSON.parse(readFileSync(file, 'utf8'));
  const added = supplement(translation);
  if (added) writeFileSync(file, JSON.stringify(translation));
  console.log(`${translation.name}: ${added} missing verse${added === 1 ? '' : 's'} added`);
}
