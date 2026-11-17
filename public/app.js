import { RoseWindow, GENRES, hashString } from './window.js';
import { Ambience, STYLES } from './ambience.js';
import { Narrator, sentences, spokenReference } from './narrator.js';
import { saveRecording } from './recording.js';

const $ = (id) => document.getElementById(id);

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value != null && value !== false) node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((child) => child != null && child !== false));
  return node;
}

const store = {
  get(key, fallback) {
    try {
      return localStorage.getItem(`selah.${key}`) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`selah.${key}`, value);
    } catch {
      /* private browsing: settings just do not persist */
    }
  },
};

const state = {
  ticket: 0, // bumps whenever a new passage is shown, so late answers are dropped
  opening: 0, // bumps whenever a passage is asked for
  passage: null,
  setup: null,
  plan: store.get('plan', 'surprise'), // what "Next passage" does: surprise | order
  scope: store.get('scope', 'all'),
  verseEls: new Map(),
  verseSegment: new Map(),
  narrated: [], // verses lit because the voice is on them
  hovered: null, // verses lit because the pointer or focus is on a lesson
};

// The three choices that decide which reflection is asked for.
const reading = {
  translation: store.get('translation', 'web'),
  length: store.get('length', 'standard'),
  tradition: store.get('tradition', 'common'),
};

const ambience = new Ambience();
const narrator = new Narrator({ output: () => ambience.voiceInput() });
const rose = new RoseWindow($('window'), $('bloom'), {
  levels: () => ambience.levels(),
  voiceLevel: () => ambience.voiceLevel(),
  onHover: (verse) => {
    for (const [n, el] of state.verseEls) el.classList.toggle('peek', n === verse);
    $('window').title = verse == null ? '' : `Read from verse ${verse}`;
  },
  onPick: (verse) => readFrom(verse),
});

/* ---------- small helpers ---------- */

async function request(url, body) {
  let response;
  try {
    response = await fetch(
      url,
      body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
  } catch {
    throw new Error('The Selah server is not answering. Start it again with "npm start".');
  }
  const answer = await response.json().catch(() => ({}));
  if (response.status === 401) location.assign('/login'); // the sign-in has lapsed
  if (!response.ok) throw new Error(answer.error || `The server answered ${response.status}.`);
  return answer;
}

// One line under the controls. A message about the voice outranks the rest,
// and the sleep timer's standing reminder shows whenever nothing else does.
const notes = { voice: '', status: '', sleep: '' };
let statusTimer = 0;
function setNote(kind, message) {
  notes[kind] = message ?? '';
  const shown = notes.voice || notes.status || notes.sleep;
  $('note').textContent = shown;
  $('note').hidden = !shown;
}

// News that is worth a few seconds but should not sit there for good.
function announce(message) {
  clearTimeout(statusTimer);
  setNote('status', message);
  statusTimer = setTimeout(() => notes.status === message && setNote('status', null), 9000);
}

const coordsOf = (p) => ({ translation: p.translation.id, b: p.b, c: p.c, from: p.from, to: p.to });
const number = (n) => n.toLocaleString();

function localDate() {
  const now = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

function closeDialogs() {
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
}

/* ---------- opening a passage ---------- */

// choice is what the server is asked for: { mode, scope, date, reference, ... }
async function openPassage(choice) {
  const opening = ++state.opening;
  ambience.start(); // has to happen inside the click
  clearTimeout(advanceTimer);

  let passage;
  try {
    await ready;
    passage = await request('/api/open', { translation: reading.translation, ...choice });
  } catch (err) {
    if (opening !== state.opening) return;
    if (choice.mode === 'reference') showReferenceError(err.message);
    else showPassageError(err.message, choice);
    return;
  }
  if (opening !== state.opening) return;

  const ticket = ++state.ticket;
  narrator.stop();
  closeDialogs();
  state.passage = passage;
  setNote('status', null);
  if (passage.startedAgain) announce('You have now been given every passage in that part of the Bible, so the round begins again.');
  showProgress(passage);

  const segments = renderPassage(passage);
  rose.setPassage(passage);
  ambience.setMood(passage.genre, hashString(passage.reference));
  narrator.load(segments, { expectMore: true });
  narrator.play();
  requestReflection(ticket);
}

function nextPassage() {
  openPassage(state.plan === 'order' ? { mode: 'order' } : { mode: 'surprise', scope: state.scope });
}

function showPassageError(message, choice) {
  state.ticket++;
  narrator.stop();
  closeDialogs();
  document.body.dataset.view = 'reading';
  $('welcome').hidden = true;
  $('passage').hidden = true;
  $('questions').hidden = true;
  const section = $('reflection');
  section.hidden = false;
  section.replaceChildren(
    h('p', { class: 'problem' }, `The passage could not be opened. ${message}`),
    h('button', { class: 'btn', type: 'button', onclick: () => openPassage(choice) }, 'Try again'),
  );
}

function renderPassage(p) {
  document.body.dataset.view = 'reading';
  document.title = `${p.reference} | Selah`;
  showOnLockScreen(p);
  $('welcome').hidden = true;
  $('passage').hidden = false;
  $('questions').hidden = true;
  $('thread').replaceChildren();
  $('save-audio').disabled = true;
  showFavourite(p.favourite);

  const genre = GENRES[p.genre];
  document.documentElement.style.setProperty('--glass', genre.glass[0]);

  $('ref-title').textContent = p.title;
  const extent = p.whole ? `The whole ${p.unit}` : p.from === p.to ? `Verse ${p.from}` : `Verses ${p.from} to ${p.to}`;
  $('ref-range').textContent = `${extent}, in the ${p.translation.name}`;

  const count = p.verses.length;
  $('caption').textContent =
    count === 1
      ? `The outer ring is the verse being read. The glass is coloured for ${genre.place}.`
      : `One outer pane for each of the ${count} verses, lit as it is read. The glass is coloured for ${genre.place}.`;
  $('window').setAttribute('aria-label', `Rose window for ${p.reference}, with one outer pane for each verse`);

  const segments = [{ kind: 'reference', text: `${p.spoken}.`, el: $('ref'), pauseAfter: 600 }];
  state.verseEls.clear();
  state.verseSegment.clear();
  const verses = $('verses');
  verses.className = `verses ${p.genre === 'wisdom' ? 'lines' : 'prose'}`;
  verses.replaceChildren(
    ...p.verses.map((v, i) => {
      const label = h('button', { class: 'vn', type: 'button', 'aria-label': `Read from verse ${v.n}`, onclick: () => readFrom(v.n) }, String(v.n));
      const el = h('span', { class: 'verse' }, label, v.text, ' ');
      state.verseEls.set(v.n, el);
      state.verseSegment.set(v.n, segments.length);
      segments.push({ kind: 'verse', text: v.text, el, verse: v.n, pauseAfter: i === count - 1 ? 1100 : 220 });
      return el;
    }),
  );

  window.scrollTo({ top: 0 });
  return segments;
}

function readFrom(verse) {
  const index = state.verseSegment.get(verse);
  if (index == null) return;
  ambience.start();
  narrator.jump(index);
}

/* ---------- the reflection ---------- */

async function requestReflection(ticket) {
  const p = state.passage;
  const section = $('reflection');
  section.hidden = false;
  section.replaceChildren(
    h(
      'p',
      { class: 'pending' },
      state.setup?.checked
        ? 'The reflection is being written, then read a second time before you see it. It usually takes under a minute.'
        : 'The reflection is being written. It usually takes about twenty seconds.',
    ),
  );
  rose.setWaiting(true);
  narrator.expect(true);

  try {
    const { reflection, review, questions } = await request('/api/reflect', {
      ...coordsOf(p),
      length: reading.length,
      tradition: reading.tradition,
    });
    if (ticket !== state.ticket) return;
    const segments = renderReflection(reflection, review);
    $('thread').replaceChildren(...questions.map((entry) => renderExchange(entry).el));
    $('questions').hidden = false;
    $('save-audio').disabled = false;
    rose.reveal();
    narrator.append(segments, { expectMore: false });
  } catch (err) {
    if (ticket !== state.ticket) return;
    rose.setWaiting(false);
    narrator.expect(false);
    section.replaceChildren(
      h('p', { class: 'problem' }, `The reflection could not be written. ${err.message}`),
      /signed in/.test(err.message) ? null : h('p', { class: 'hint' }, 'Check that Claude Code is signed in by running "claude" in a terminal, then try again.'),
      h('button', { class: 'btn', type: 'button', onclick: () => requestReflection(state.ticket) }, 'Try again'),
    );
  }
}

// [3, 4, 5, 9] -> "Verses 3–5 and 9"
function citeLabel(verses) {
  const runs = [];
  for (const n of verses) {
    const last = runs.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  const parts = runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`));
  const joined = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  return `${verses.length > 1 ? 'Verses' : 'Verse'} ${joined}`;
}

// What the second reading found, said plainly at the foot of the reflection.
function checkedNote(review) {
  if (!review?.checked) {
    return h('p', { class: 'fineprint' }, 'Written by Claude from the passage above. The second check is switched off, so test it against the text with care.');
  }
  if (!review.corrections.length) {
    return h('p', { class: 'fineprint' }, 'Written by Claude from the passage above, then read a second time against the text and the creeds. Nothing needed correcting. Test it against the passage yourself.');
  }
  const count = review.corrections.length;
  return h(
    'details',
    { class: 'fineprint checked' },
    h('summary', {}, `Written by Claude, then read a second time, which corrected ${count === 1 ? 'one point' : `${count} points`} before you saw it. See what was changed.`),
    h('ul', {}, review.corrections.map((issue) => h('li', {}, issue.where ? h('b', {}, `${issue.where}: `) : null, issue.problem))),
  );
}

function renderReflection(r, review) {
  const segments = [];
  const nodes = [];
  const say = (text, el, extra = {}) => segments.push({ kind: 'reflection', text, el, ...extra });

  const title = h('h2', { class: 'r-title' }, r.title);
  nodes.push(title);
  say(`${r.title}.`, title, { pauseAfter: 400 });

  if (r.setting) {
    const setting = h('p', { class: 'setting' }, r.setting);
    nodes.push(setting);
    say(r.setting, setting, { pauseAfter: 500 });
  }

  nodes.push(h('h3', {}, 'Summary'));
  r.summary.forEach((paragraph, i) => {
    const spans = sentences(paragraph).map((sentence, j, all) => {
      const span = h('span', { class: 'sentence' }, sentence, ' ');
      const lastOfAll = i === r.summary.length - 1 && j === all.length - 1;
      say(sentence, span, { pauseAfter: lastOfAll ? 700 : j === all.length - 1 ? 450 : 160 });
      return span;
    });
    nodes.push(h('p', {}, spans));
  });

  const lessonsHead = h('h3', {}, 'Key lessons');
  nodes.push(lessonsHead);
  say('Key lessons.', lessonsHead, { pauseAfter: 350 });
  for (const lesson of r.lessons) {
    const light = () => setHovered(lesson.verses);
    const dim = () => setHovered(null);
    const cite = lesson.verses.length
      ? h('button', { class: 'cite', type: 'button', onclick: () => showVerses(lesson.verses) }, citeLabel(lesson.verses))
      : null;
    const el = h(
      'div',
      { class: 'lesson', onmouseenter: light, onmouseleave: dim, onfocusin: light, onfocusout: dim },
      h('h4', {}, lesson.heading),
      h('p', {}, lesson.text),
      cite,
    );
    nodes.push(el);
    say(`${lesson.heading}. ${lesson.text}`, el, { verses: lesson.verses, pauseAfter: 550 });
  }

  if (r.crossReferences.length) {
    const head = h('h3', {}, 'Read alongside');
    nodes.push(head);
    say('Read alongside.', head, { pauseAfter: 350 });
    for (const ref of r.crossReferences) {
      const el = h('p', { class: 'alongside' }, h('b', {}, ref.reference), ' ', ref.connection);
      nodes.push(el);
      say(`${spokenReference(ref.reference)}. ${ref.connection}`, el, { pauseAfter: 450 });
    }
  }

  if (r.differences) {
    const head = h('h3', {}, 'Where Christians differ');
    const el = h('p', {}, r.differences);
    nodes.push(head, el);
    say('Where Christians differ.', head, { pauseAfter: 350 });
    say(r.differences, el, { pauseAfter: 600 });
  }

  if (r.prayer) {
    const el = h('p', { class: 'prayer' }, r.prayer);
    nodes.push(h('h3', {}, 'A prayer'), el);
    say(r.prayer, el, { pauseAfter: 900 });
  }

  nodes.push(checkedNote(review));

  const section = $('reflection');
  section.replaceChildren(...nodes);
  section.classList.remove('arrive');
  void section.offsetWidth; // restart the arrival animation
  section.classList.add('arrive');
  return segments;
}

/* ---------- questions ---------- */

// One question and its answer. Returns the element and the pieces to read aloud.
function renderExchange({ question, answer, verses = [] }) {
  const segments = [];
  const paragraphs = answer.map((paragraph) =>
    h(
      'p',
      {},
      sentences(paragraph).map((sentence, i, all) => {
        const span = h('span', { class: 'sentence' }, sentence, ' ');
        segments.push({ kind: 'answer', text: sentence, el: span, verses, pauseAfter: i === all.length - 1 ? 450 : 160 });
        return span;
      }),
    ),
  );
  const cite = verses.length
    ? h('button', { class: 'cite', type: 'button', onclick: () => showVerses(verses) }, citeLabel(verses))
    : null;
  return { el: h('div', { class: 'exchange' }, h('p', { class: 'asked' }, question), paragraphs, cite), segments };
}

$('ask').addEventListener('submit', async (event) => {
  event.preventDefault();
  const field = $('question');
  const question = field.value.trim();
  const p = state.passage;
  if (!question || !p) return;
  const ticket = state.ticket;
  ambience.start();

  const waiting = h('div', { class: 'exchange' }, h('p', { class: 'asked' }, question), h('p', { class: 'pending' }, 'Looking at the passage again.'));
  $('thread').append(waiting);
  field.value = '';
  field.disabled = true;
  try {
    const entry = await request('/api/ask', { ...coordsOf(p), length: reading.length, tradition: reading.tradition, question });
    if (ticket !== state.ticket) return;
    const { el, segments } = renderExchange(entry);
    waiting.replaceWith(el);
    const finished = narrator.state === 'done';
    narrator.append(segments, { expectMore: false });
    if (finished) narrator.play(); // read the answer straight away if nothing else is being read
  } catch (err) {
    if (ticket !== state.ticket) return;
    waiting.replaceWith(
      h('div', { class: 'exchange' }, h('p', { class: 'asked' }, question), h('p', { class: 'problem' }, `That could not be answered. ${err.message}`)),
    );
    field.value = question;
  } finally {
    field.disabled = false;
  }
});

/* ---------- favourites and history ---------- */

function showFavourite(favourite) {
  $('favourite').setAttribute('aria-pressed', String(favourite));
  $('favourite').textContent = favourite ? 'Remove from favourites' : 'Add to favourites';
}

$('favourite').addEventListener('click', async () => {
  const p = state.passage;
  if (!p) return;
  const wanted = $('favourite').getAttribute('aria-pressed') !== 'true';
  try {
    const { favourite } = await request('/api/favourite', { ...coordsOf(p), favourite: wanted });
    if (state.passage === p) showFavourite(favourite);
  } catch (err) {
    setNote('status', err.message);
  }
});

let showing = 'history';
let library = { history: [], favourites: [] };

function renderEntries() {
  const entries = library[showing];
  $('show-all').setAttribute('aria-pressed', String(showing === 'history'));
  $('show-favourites').setAttribute('aria-pressed', String(showing === 'favourites'));
  $('entries-empty').hidden = entries.length > 0;
  $('entries-empty').textContent =
    showing === 'history'
      ? 'Nothing here yet. Every passage you open is listed here, and its reflection is kept so it never has to be written twice.'
      : 'No favourites yet. Use "Add to favourites" on a passage to keep it here.';
  $('entries').replaceChildren(
    ...entries.map((entry) => {
      const when = new Date(entry.at).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
      const open = h(
        'button',
        { class: 'entry-open', type: 'button', onclick: () => openPassage({ mode: 'exact', b: entry.b, c: entry.c, from: entry.from, to: entry.to }) },
        h('b', {}, entry.reference),
        entry.title ? h('span', {}, entry.title) : null,
        h('small', {}, when),
      );
      const keep = h(
        'button',
        {
          class: 'link',
          type: 'button',
          'aria-pressed': String(entry.favourite),
          onclick: async () => {
            await request('/api/favourite', { translation: reading.translation, b: entry.b, c: entry.c, from: entry.from, to: entry.to, favourite: !entry.favourite });
            if (state.passage?.key === entry.key) showFavourite(!entry.favourite);
            loadLibrary();
          },
        },
        entry.favourite ? 'Remove from favourites' : 'Add to favourites',
      );
      return h('li', {}, open, keep);
    }),
  );
}

async function loadLibrary() {
  try {
    library = await request('/api/library');
    showProgress(library);
  } catch (err) {
    library = { history: [], favourites: [] };
    setNote('status', err.message);
  }
  renderEntries();
}

$('show-all').addEventListener('click', () => ((showing = 'history'), renderEntries()));
$('show-favourites').addEventListener('click', () => ((showing = 'favourites'), renderEntries()));

/* ---------- lighting verses ---------- */

function applyFlare() {
  const lit = state.hovered ?? state.narrated;
  rose.setFlare(lit);
  for (const [n, el] of state.verseEls) el.classList.toggle('cited', lit.includes(n));
}

function setHovered(verses) {
  state.hovered = verses?.length ? verses : null;
  applyFlare();
}

function showVerses(verses) {
  setHovered(verses);
  state.verseEls.get(verses[0])?.scrollIntoView({ block: 'center', behavior: motion() });
}

/* ---------- following the voice ---------- */

const still = matchMedia('(prefers-reduced-motion: reduce)');
const motion = () => (still.matches ? 'auto' : 'smooth');
let lastScrolledByHand = 0;
for (const type of ['wheel', 'touchmove']) {
  addEventListener(type, () => (lastScrolledByHand = performance.now()), { passive: true });
}

function follow(el) {
  if (performance.now() - lastScrolledByHand < 6000) return;
  const box = el.getBoundingClientRect();
  if (box.top < innerHeight * 0.14 || box.bottom > innerHeight * 0.78) {
    el.scrollIntoView({ block: 'center', behavior: motion() });
  }
}

let nowEl = null;
narrator.addEventListener('segment', ({ detail: segment }) => {
  nowEl?.classList.remove('now');
  nowEl = segment?.el ?? null;
  nowEl?.classList.add('now');
  rose.setCurrent(segment?.kind === 'verse' ? segment.verse : null);
  state.narrated = segment?.verses ?? [];
  applyFlare();
  if (nowEl) follow(nowEl);
});

narrator.addEventListener('state', ({ detail: s }) => {
  const speaking = s === 'speaking';
  $('toggle').textContent = speaking || s === 'waiting' ? 'Pause' : s === 'done' ? 'Listen again' : 'Listen';
  if (media) media.playbackState = speaking || s === 'waiting' ? 'playing' : 'paused';
  ambience.duck(speaking);
  if (s === 'done') afterPassage();
});

narrator.addEventListener('preparing', ({ detail: preparing }) => {
  setNote('voice', preparing ? 'Preparing the voice. The first time, it has to be downloaded, which can take a few minutes.' : null);
});

// Reading has stopped because a piece of speech could not be fetched.
narrator.addEventListener('problem', ({ detail: reason }) => {
  setNote('status', `The reading stopped. ${reason} Press Listen to try again.`);
});

function listen() {
  ambience.start(); // also wakes the music after the sleep timer
  setNote('status', null);
  narrator.play();
}

function toggle() {
  if (narrator.state === 'speaking' || narrator.state === 'waiting') narrator.pause();
  else listen();
}

/* ---------- lock screen, headphones and media keys ---------- */

// With the screen off, the phone's own play, pause and next controls work the reading.
const media = 'mediaSession' in navigator ? navigator.mediaSession : null;
if (media) {
  const on = (action, handler) => {
    try {
      media.setActionHandler(action, handler);
    } catch {
      /* this browser does not offer that control */
    }
  };
  on('play', listen);
  on('pause', () => {
    narrator.pause();
    ambience.sleep(1.5); // from a lock screen, pause means silence, music included
  });
  on('nexttrack', nextPassage);
}

function showOnLockScreen(p) {
  if (!media || !window.MediaMetadata) return;
  media.metadata = new MediaMetadata({ title: p.reference, artist: 'Selah', album: p.translation.name });
}

/* ---------- sleep timer ---------- */

const sleep = { mode: 'off', until: 0, timer: 0 };
let advanceTimer = 0;

function setSleep(mode) {
  clearTimeout(sleep.timer);
  clearTimeout(advanceTimer);
  sleep.mode = mode;
  sleep.until = 0;
  $('sleep').value = mode;
  setNote('status', null);
  if (mode === 'off') return setNote('sleep', null);
  if (mode === 'after') return setNote('sleep', 'Sleep timer: the reading and the music stop when this passage ends.');
  const minutes = Number(mode);
  sleep.until = Date.now() + minutes * 60_000;
  sleep.timer = setTimeout(() => fallAsleep('The sleep timer has stopped the reading. Press Listen to carry on.'), minutes * 60_000);
  const at = new Date(sleep.until).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  setNote('sleep', `Sleep timer: passages keep coming until ${at}, then everything stops.`);
}

function fallAsleep(message) {
  clearTimeout(advanceTimer);
  if (narrator.state === 'speaking' || narrator.state === 'waiting') narrator.pause();
  ambience.sleep(14);
  setSleep('off');
  setNote('status', message);
}

// Called when the reading of a passage and its reflection has finished.
function afterPassage() {
  if (sleep.mode === 'after') return fallAsleep('The sleep timer stopped the music at the end of the passage.');
  // With a timed sleep timer running, go on to another passage after a pause.
  if (sleep.until && Date.now() < sleep.until - 20_000) advanceTimer = setTimeout(nextPassage, 6000);
}

/* ---------- saving as audio ---------- */

$('save-audio').addEventListener('click', async () => {
  const p = state.passage;
  const button = $('save-audio');
  if (!p || button.disabled) return;
  button.disabled = true;
  const ticket = state.ticket;
  try {
    setNote('status', 'Saving as audio: preparing the reading.');
    const clips = await narrator.recording((done, total) => {
      if (ticket === state.ticket) setNote('status', `Saving as audio: ${done} of ${total} pieces of the reading are ready.`);
    });
    if (ticket !== state.ticket) return;
    setNote('status', 'Saving as audio: mixing the voice and the music. This can take a minute.');
    await saveRecording({
      clips,
      music: ambience.recipe,
      format: state.setup?.audio ?? 'wav',
      name: `Selah - ${p.reference.replace(/:/g, '.')}`,
    });
    announce('Saved. Look in your Downloads folder.');
  } catch (err) {
    if (ticket === state.ticket) setNote('status', `The audio could not be saved. ${err.name === 'AbortError' ? 'The reading changed while it was being prepared.' : err.message}`);
  } finally {
    if (ticket === state.ticket) button.disabled = false;
  }
});

/* ---------- choosing ---------- */

function showProgress({ progress, nextInOrder }) {
  if (progress) $('progress').textContent = `So far: ${number(progress.read)} of ${number(progress.total)}.`;
  if (nextInOrder) $('start-book').options[0].textContent = `Where I left off (${nextInOrder})`;
}

function showReferenceError(message) {
  $('reference-error').textContent = message;
  $('reference-error').hidden = false;
  if (!$('chooser').open) $('chooser').showModal();
  $('reference').focus();
}

function setPlan(plan) {
  state.plan = plan;
  store.set('plan', plan);
}

$('open').addEventListener('click', nextPassage);
$('next').addEventListener('click', nextPassage);
$('today').addEventListener('click', () => openPassage({ mode: 'today', date: localDate() }));
$('go-today').addEventListener('click', () => openPassage({ mode: 'today', date: localDate() }));
$('toggle').addEventListener('click', toggle);

$('go-surprise').addEventListener('click', () => {
  state.scope = $('scope').value;
  store.set('scope', state.scope);
  setPlan('surprise');
  nextPassage();
});

$('go-order').addEventListener('click', () => {
  const from = $('start-book').value;
  setPlan('order');
  openPassage({ mode: 'order', ...(from === '' ? {} : { startBook: Number(from) }) });
  $('start-book').value = '';
});

$('go-reference').addEventListener('submit', (event) => {
  event.preventDefault();
  $('reference-error').hidden = true;
  openPassage({ mode: 'reference', reference: $('reference').value });
});

for (const button of document.querySelectorAll('[data-open]')) {
  button.addEventListener('click', () => {
    const dialog = $(button.dataset.open);
    if (dialog.id === 'history') loadLibrary();
    if (dialog.id === 'chooser') $('reference-error').hidden = true;
    dialog.showModal();
  });
}
for (const dialog of document.querySelectorAll('dialog')) {
  // a click on the dimmed surround, outside the panel itself, closes it
  dialog.addEventListener('click', (event) => event.target === dialog && dialog.close());
}

addEventListener('keydown', (event) => {
  const busy = event.target.closest?.('input, textarea, select, button, dialog');
  if (event.code !== 'Space' || busy || !state.passage) return;
  event.preventDefault();
  toggle();
});

/* ---------- settings ---------- */

function fill(select, options, value) {
  select.replaceChildren(...options.map((o) => h('option', { value: o.id }, o.label ?? o.name)));
  select.value = options.some((o) => String(o.id) === String(value)) ? value : options[0].id;
  return select.value;
}

// Changing the translation, length or tradition asks for a different
// reflection, so the passage on screen is opened again.
function readingChoice(id, key) {
  $(id).addEventListener('change', () => {
    reading[key] = $(id).value;
    store.set(key, reading[key]);
    const p = state.passage;
    if (p) openPassage({ mode: 'exact', b: p.b, c: p.c, from: p.from, to: p.to });
  });
}
readingChoice('translation', 'translation');
readingChoice('length', 'length');
readingChoice('tradition', 'tradition');

const volume = $('volume');
volume.value = store.get('volume', '55');
ambience.setVolume(volume.value / 100);
volume.addEventListener('input', () => {
  ambience.setVolume(volume.value / 100);
  store.set('volume', volume.value);
});

ambience.setStyle(fill($('style'), STYLES, store.get('style', 'bells')));
$('style').addEventListener('change', () => {
  ambience.setStyle($('style').value);
  store.set('style', $('style').value);
});

const pace = $('pace');
function showPace() {
  const value = Number(pace.value);
  $('pace-value').textContent = Math.abs(value - 0.95) < 0.01 ? '(usual)' : value < 0.95 ? '(slower)' : '(faster)';
}
pace.value = store.get('pace', '0.95');
narrator.setSpeed(Number(pace.value));
showPace();
pace.addEventListener('input', showPace);
pace.addEventListener('change', () => {
  narrator.setSpeed(Number(pace.value));
  store.set('pace', pace.value);
});

$('sleep').addEventListener('change', () => setSleep($('sleep').value));

const voiceSelect = $('voice');
voiceSelect.addEventListener('change', () => {
  store.set('voice', voiceSelect.value);
  narrator.setVoice(voiceSelect.value);
});

function noVoice(problem) {
  $('toggle').hidden = true;
  voiceSelect.closest('.field').hidden = true;
  setNote('status', `${problem} Until that is fixed, the passage and reflection are shown as text only.`);
}

const voicesReady = request('/api/voices').then(
  ({ voices, problem }) => {
    if (!voices.length) return noVoice(problem || 'The reading voice is not available.');
    narrator.setVoice(fill(voiceSelect, voices, store.get('voice', '')));
  },
  (err) => noVoice(err.message),
);

const setupReady = request('/api/setup').then((setup) => {
  state.setup = setup;
  reading.translation = fill($('translation'), setup.translations, reading.translation);
  reading.length = fill($('length'), setup.lengths, reading.length);
  reading.tradition = fill($('tradition'), setup.traditions, reading.tradition);
  pace.min = setup.pace.min;
  pace.max = setup.pace.max;

  const group = (label, testament, value) =>
    h('optgroup', { label }, setup.books.filter((b) => b.testament === testament).map((b) => h('option', { value: value(b) }, b.name)));
  $('scope').replaceChildren(
    h('option', { value: 'all' }, 'Anywhere in the Bible'),
    h('option', { value: 'ot' }, 'The Old Testament'),
    h('option', { value: 'nt' }, 'The New Testament'),
    group('One book of the Old Testament', 'ot', (b) => `book:${b.index}`),
    group('One book of the New Testament', 'nt', (b) => `book:${b.index}`),
  );
  $('scope').value = state.scope;
  if (!$('scope').value) $('scope').value = state.scope = 'all';
  $('start-book').replaceChildren(
    h('option', { value: '' }, 'Where I left off'),
    group('Old Testament', 'ot', (b) => b.index),
    group('New Testament', 'nt', (b) => b.index),
  );
  showProgress(setup);
});

// Passages are not opened until the page knows its choices and its voice.
const ready = Promise.all([setupReady, voicesReady]);
