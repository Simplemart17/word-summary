// Reads a queue of segments aloud.
// A segment is { text, el?, kind?, verse?, verses?, pauseAfter? }.
//
// The voice is a neural one running on this computer: each piece of text is
// sent to the Selah server, which sends back audio to play.

const ORDINAL = { 1: 'First', 2: 'Second', 3: 'Third' };

// "1 Corinthians 13:4-7" -> "First Corinthians 13, verses 4 to 7"
export function spokenReference(reference) {
  return reference
    .replace(/^([123])\s+/, (_, d) => `${ORDINAL[d]} `)
    .replace(/(\d+):(\d+)\s*[-–]\s*(\d+)/, '$1, verses $2 to $3')
    .replace(/(\d+):(\d+)/, '$1, verse $2')
    .replace(/(\d+)\s*[-–]\s*(\d+)/, '$1 to $2');
}

export function sentences(text) {
  return text.match(/[^.!?]+[.!?]+["'’”)]*\s*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
}

// Long text is spoken in pieces that end at a natural pause.
const PIECE_MAX = 320;
function pieces(text) {
  const clean = text.replace(/\s*—\s*/g, ', ').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= PIECE_MAX) return [clean];
  const clauses = (clean.match(/[^.!?;:]+[.!?;:]+["'’”)]*\s*|[^.!?;:]+$/g) ?? [clean]).flatMap((clause) =>
    clause.length > PIECE_MAX ? clause.match(/[^,]+,?\s*/g) ?? [clause] : [clause],
  );
  const out = [];
  let current = '';
  for (const clause of clauses) {
    if (current && (current + clause).length > PIECE_MAX) {
      out.push(current.trim());
      current = '';
    }
    current += clause;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

const AHEAD = 3; // pieces prepared before they are needed
const prepare = (segment) => ({ ...segment, pieces: pieces(segment.text) });

export class Narrator extends EventTarget {
  // output: () => AudioNode that the speech is played into
  constructor({ output }) {
    super();
    this.output = output;
    this.segments = [];
    this.index = 0;
    this.piece = 0;
    this.offset = 0; // seconds into the current clip, kept across a pause
    this.state = 'idle'; // idle | speaking | paused | waiting | done
    this.expectMore = false;
    this.voice = null; // id of one of the server's voices
    this.speed = 0.95;
    this.token = 0;
    this.clips = new Map();
  }

  setVoice(id) {
    if (id === this.voice) return;
    const speaking = this.state === 'speaking';
    this.#halt();
    this.#dropClips();
    this.voice = id;
    this.piece = 0;
    this.offset = 0;
    if (speaking) this.#speak(); // say the current segment again in the new voice
  }

  setSpeed(speed) {
    if (speed === this.speed) return;
    const speaking = this.state === 'speaking';
    this.#halt();
    this.#dropClips();
    this.speed = speed;
    this.offset = 0;
    if (speaking) this.#speak(); // say the current piece again at the new pace
  }

  // Every piece of the reading as audio, in order, for saving as a file.
  // progress(done, total) is called as the pieces arrive.
  async recording(progress = () => {}) {
    const wanted = this.segments.flatMap((segment) =>
      segment.pieces.map((words, i) => ({ words, pauseAfter: i === segment.pieces.length - 1 ? segment.pauseAfter ?? 160 : 30 })),
    );
    const clips = [];
    for (const [i, { words, pauseAfter }] of wanted.entries()) {
      clips.push({ buffer: await this.#clip(words), pauseAfter });
      progress(i + 1, wanted.length);
    }
    return clips;
  }

  load(segments, { expectMore = false } = {}) {
    this.#halt();
    this.#dropClips();
    this.segments = segments.map(prepare);
    this.index = 0;
    this.piece = 0;
    this.offset = 0;
    this.expectMore = expectMore;
    this.#set('paused');
  }

  append(segments, { expectMore = false } = {}) {
    this.segments.push(...segments.map(prepare));
    this.expectMore = expectMore;
    if (this.state === 'waiting') this.#speak();
    else if (this.state === 'done') this.#set('paused');
    else if (this.state === 'speaking') this.#prefetch();
  }

  // Nothing more is coming (or, with true, something is after all).
  expect(more) {
    this.expectMore = more;
    if (!more && this.state === 'waiting') this.#set('done');
  }

  play() {
    if (!this.voice || !this.segments.length) return;
    if (this.index >= this.segments.length && !this.expectMore) {
      this.index = 0;
      this.piece = 0;
      this.offset = 0;
    }
    this.#speak();
  }

  pause() {
    if (this.source) this.offset = this.source.context.currentTime - this.startedAt;
    this.#halt();
    this.#set('paused');
  }

  stop() {
    this.#halt();
    this.#dropClips();
    this.segments = [];
    this.index = 0;
    this.piece = 0;
    this.offset = 0;
    this.expectMore = false;
    this.#emit('segment', null);
    this.#set('idle');
  }

  jump(index) {
    if (index < 0 || index >= this.segments.length) return;
    this.#halt();
    this.#dropClips({ keepFinished: true });
    this.index = index;
    this.piece = 0;
    this.offset = 0;
    this.play();
  }

  #halt() {
    this.token++;
    clearTimeout(this.gap);
    clearTimeout(this.slow);
    this.#emit('preparing', false);
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        /* it had not started yet */
      }
      this.source = null;
    }
  }

  async #speak() {
    this.#halt();
    const mine = this.token;

    if (this.index >= this.segments.length) {
      this.#emit('segment', null);
      this.#set(this.expectMore ? 'waiting' : 'done');
      return;
    }
    if (!this.voice) return this.#set('paused');

    const segment = this.segments[this.index];
    this.piece = Math.min(this.piece, segment.pieces.length - 1);
    this.#set('speaking');
    if (this.piece === 0 && this.offset === 0) this.#emit('segment', segment);

    this.#prefetch();
    // The very first piece can be slow while the server loads the voice.
    this.slow = setTimeout(() => mine === this.token && this.#emit('preparing', true), 3500);

    let buffer;
    try {
      buffer = await this.#clip(segment.pieces[this.piece]);
    } catch (err) {
      if (mine !== this.token) return;
      this.pause();
      this.#emit('problem', err.message);
      return;
    }
    if (mine !== this.token) return;
    clearTimeout(this.slow);
    this.#emit('preparing', false);

    const out = this.output();
    const source = out.context.createBufferSource();
    source.buffer = buffer;
    source.connect(out);
    const offset = Math.min(this.offset, Math.max(0, buffer.duration - 0.05));
    this.startedAt = out.context.currentTime - offset;
    source.onended = () => {
      if (mine !== this.token) return;
      this.source = null;
      this.offset = 0;
      let wait = 30;
      if (++this.piece >= segment.pieces.length) {
        this.piece = 0;
        this.index++;
        wait = segment.pauseAfter ?? 160;
      }
      this.gap = setTimeout(() => mine === this.token && this.#speak(), wait);
    };
    source.start(0, offset);
    this.source = source;
  }

  #clip(words) {
    const key = `${this.voice}|${this.speed}|${words}`;
    let clip = this.clips.get(key);
    if (!clip) {
      const controller = new AbortController();
      const promise = fetch('/api/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: words, voice: this.voice, speed: this.speed }),
        signal: controller.signal,
      })
        .then(
          async (response) => {
            if (!response.ok) {
              const body = await response.json().catch(() => ({}));
              throw new Error(body.error || 'The voice did not answer.');
            }
            return response.arrayBuffer();
          },
          (err) => {
            if (err.name === 'AbortError') throw err;
            throw new Error('The Selah server is not answering. Start it again with "npm start".');
          },
        )
        .then((bytes) => this.output().context.decodeAudioData(bytes));
      clip = { promise, controller, finished: false };
      promise.then(
        () => (clip.finished = true),
        () => this.clips.get(key) === clip && this.clips.delete(key),
      );
      this.clips.set(key, clip);
    }
    return clip.promise;
  }

  // Ask for the next few pieces now so there is no gap when they are due.
  #prefetch() {
    let wanted = AHEAD;
    for (let i = this.index, p = this.piece + 1; i < this.segments.length && wanted > 0; i++, p = 0) {
      const list = this.segments[i].pieces;
      for (; p < list.length && wanted > 0; p++, wanted--) this.#clip(list[p]).catch(() => {});
    }
  }

  #dropClips({ keepFinished = false } = {}) {
    for (const [key, clip] of this.clips) {
      if (clip.finished && keepFinished) continue;
      if (!clip.finished) clip.controller.abort();
      this.clips.delete(key);
    }
  }

  #set(state) {
    if (state === this.state) return;
    this.state = state;
    this.#emit('state', state);
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
