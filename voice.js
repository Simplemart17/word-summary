// The reading voice: Kokoro, an open-weight neural text-to-speech model that
// runs on this machine. Nothing is sent to a speech service. The model itself
// lives in voice-worker.js; this file queues the work and keeps what was made.

import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

// "full" is the best-sounding and, on Apple silicon, also the fastest (about
// 325 MB, downloaded once). "small" is about 90 MB.
const DTYPE = process.env.SELAH_VOICE === 'small' ? 'q8' : 'fp32';
const CACHE_MAX = 160;
export const SPEED = { min: 0.7, max: 1.3, normal: 0.95 };

export const VOICES = [
  { id: 'af_heart', name: 'Heart (American, female)' },
  { id: 'af_bella', name: 'Bella (American, female)' },
  { id: 'am_michael', name: 'Michael (American, male)' },
  { id: 'am_fenrir', name: 'Fenrir (American, male)' },
  { id: 'bf_emma', name: 'Emma (British, female)' },
  { id: 'bm_george', name: 'George (British, male)' },
];

let worker;
let ready; // Promise that settles once the model has loaded
let status = 'loading'; // loading | ready | unavailable
let problem = '';
let lastId = 0;
const waiting = new Map(); // id -> { resolve, reject }

function ask(message) {
  return new Promise((resolve, reject) => {
    const id = ++lastId;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, ...message });
  });
}

function fail(err) {
  status = 'unavailable';
  problem =
    err.code === 'ERR_MODULE_NOT_FOUND'
      ? 'The reading voice is not installed. Run "npm install" in the project folder.'
      : `The reading voice could not be loaded: ${err.message}`;
  return new Error(problem);
}

// Starts loading the model. The first time, this downloads it.
export function warm() {
  if (ready) return ready;
  worker = new Worker(new URL('./voice-worker.js', import.meta.url));
  worker.on('message', ({ id, error, code, bytes }) => {
    const job = waiting.get(id);
    waiting.delete(id);
    if (error) job?.reject(Object.assign(new Error(error), { code }));
    else job?.resolve(bytes ? Buffer.from(bytes) : undefined);
  });
  worker.on('error', (err) => {
    fail(err);
    for (const job of waiting.values()) job.reject(new Error(problem));
    waiting.clear();
  });
  ready = ask({ type: 'load', dtype: DTYPE, voice: VOICES[0].id }).then(
    () => {
      status = 'ready';
    },
    (err) => {
      throw fail(err);
    },
  );
  return ready;
}

export const voiceStatus = () => ({ status, problem, voices: status === 'unavailable' ? [] : VOICES });

// Names the voice gets wrong are respelled before it reads them. The list is
// pronunciations.json, which you can add to; restart the server afterwards.
const respell = (() => {
  let entries = {};
  try {
    entries = JSON.parse(readFileSync(new URL('./pronunciations.json', import.meta.url), 'utf8'));
  } catch (err) {
    console.error(`pronunciations.json could not be read (${err.message}); names will be read as written.`);
  }
  const names = Object.keys(entries).sort((a, b) => b.length - a.length);
  if (!names.length) return (words) => words;
  const pattern = new RegExp(`\\b(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g');
  return (words) => words.replace(pattern, (name) => entries[name]);
})();

// Audio already made, so a second listen is instant. It is held in memory
// only and dropped after fourteen days, the same as fetched Bible text,
// because the words that were spoken are part of what is held.
const CACHE_MS = 14 * 86_400_000;
const cache = new Map(); // "voice|speed|text" -> { at, wav }
const cached = (key) => {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.at < CACHE_MS) return entry.wav;
  cache.delete(key);
  return null;
};
setInterval(() => {
  for (const [key, entry] of cache) if (Date.now() - entry.at >= CACHE_MS) cache.delete(key);
}, 3_600_000).unref();
let tail = Promise.resolve(); // one piece at a time, in the order asked for

// Returns a WAV buffer, or null if the job was cancelled before its turn came.
export function speak(text, voice, speed = SPEED.normal, job = {}) {
  const pace = Math.round(Math.min(SPEED.max, Math.max(SPEED.min, Number(speed) || SPEED.normal)) * 100) / 100;
  const words = respell(text);
  const key = `${voice}|${pace}|${words}`;
  const ready = cached(key);
  if (ready) return Promise.resolve(ready);

  const run = tail.then(async () => {
    if (job.cancelled) return null;
    const made = cached(key); // by an earlier request for the same words
    if (made) return made;
    await warm();
    const wav = await ask({ type: 'speak', text: words, voice, speed: pace });
    cache.set(key, { at: Date.now(), wav });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return wav;
  });
  tail = run.catch(() => {});
  return run;
}
