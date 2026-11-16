// What Selah remembers between runs, kept as plain files in library/:
//   state.json           what has been read, the place in the reading plan,
//                        the history of opened passages, and favourites
//   reflections/*.json   every reflection written, so it is only paid for once

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// SELAH_LIBRARY points this at another folder, which is how tests keep away from your own data.
const ROOT = process.env.SELAH_LIBRARY || join(dirname(fileURLToPath(import.meta.url)), 'library');
const STATE = join(ROOT, 'state.json');
const REFLECTIONS = join(ROOT, 'reflections');
const HISTORY_MAX = 500;

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Written to a temporary file first so a crash cannot leave half a file behind.
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 1));
  renameSync(temporary, file);
}

const state = { read: {}, plan: { next: 0 }, history: [], favourites: [], ...readJson(STATE, {}) };
const save = () => writeJson(STATE, state);

/* ---------- reading plan ---------- */

export const hasRead = (key) => key in state.read;
export const readCount = () => Object.keys(state.read).length;
export const planPosition = () => state.plan.next;

export function setPlanPosition(index) {
  state.plan.next = index;
  save();
}

export function forgetRead(keys) {
  for (const key of keys) delete state.read[key];
  save();
}

/* ---------- history and favourites ---------- */

// Called whenever a passage is opened. unitKeys are the reading units it covers.
export function recordOpened(passage, unitKeys = []) {
  const at = new Date().toISOString();
  for (const key of unitKeys) state.read[key] ??= at;
  const entry = {
    key: passage.key,
    b: passage.b,
    c: passage.c,
    from: passage.from,
    to: passage.to,
    reference: passage.reference,
    title: state.history.find((h) => h.key === passage.key)?.title ?? '',
    at,
  };
  state.history = [entry, ...state.history.filter((h) => h.key !== passage.key)].slice(0, HISTORY_MAX);
  save();
}

// Once a reflection exists, its heading is shown beside the reference in the lists.
export function recordTitle(key, title) {
  let changed = false;
  for (const list of [state.history, state.favourites]) {
    for (const entry of list) {
      if (entry.key === key && entry.title !== title) {
        entry.title = title;
        changed = true;
      }
    }
  }
  if (changed) save();
}

export const isFavourite = (key) => state.favourites.some((f) => f.key === key);

export function setFavourite(passage, favourite) {
  state.favourites = state.favourites.filter((f) => f.key !== passage.key);
  if (favourite) {
    state.favourites.unshift({
      key: passage.key,
      b: passage.b,
      c: passage.c,
      from: passage.from,
      to: passage.to,
      reference: passage.reference,
      title: state.history.find((h) => h.key === passage.key)?.title ?? '',
      at: new Date().toISOString(),
    });
  }
  save();
}

export const lists = () => ({
  history: state.history.map((h) => ({ ...h, favourite: isFavourite(h.key) })),
  favourites: state.favourites.map((f) => ({ ...f, favourite: true })),
});

/* ---------- reflections ---------- */

const recordFile = (id) => join(REFLECTIONS, `${id.replace(/[^a-z0-9-]/gi, '_')}.json`);

// id names one reflection: translation, passage, length and tradition.
export const reflectionId = (passage, { length, tradition }) =>
  [passage.translation.id, passage.b, passage.c, passage.from, passage.to, length, tradition].join('-');

export const loadReflection = (id) => (existsSync(recordFile(id)) ? readJson(recordFile(id), null) : null);
export const saveReflection = (id, record) => writeJson(recordFile(id), record);
