// The music. Nothing is downloaded or looped: a few slow chords in a mode
// chosen for the kind of writing being read, all made by the browser's own
// oscillators. The style decides what plays them: a soft pad with bells, the
// pad alone, an organ, or a harp.

const MODES = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
};

// root is a MIDI note; progression is chord roots as steps of the mode.
const MOODS = {
  law: { root: 38, mode: 'dorian', progression: [0, 3, 0, 6], minor: true },
  history: { root: 43, mode: 'mixolydian', progression: [0, 6, 3, 0], minor: false },
  wisdom: { root: 41, mode: 'lydian', progression: [0, 1, 0, 4], minor: false },
  prophets: { root: 40, mode: 'aeolian', progression: [0, 5, 3, 4], minor: true },
  gospels: { root: 38, mode: 'ionian', progression: [0, 3, 5, 4], minor: false },
  letters: { root: 45, mode: 'ionian', progression: [0, 5, 3, 4], minor: false },
  apocalyptic: { root: 37, mode: 'aeolian', progression: [0, 5, 6, 0], minor: true },
};

// Chord tones as steps above the chord root, with relative loudness.
const OPEN = [[4, 0.8], [7, 0.75], [9, 0.7], [11, 0.5], [8, 0.32], [14, 0.28]];
const CLOSE = [[4, 0.8], [7, 0.8], [9, 0.7], [11, 0.4]];
// One sounding note is several oscillators: [waveform, detune in cents, loudness, multiple of the pitch].
const PAD = [['triangle', 0, 1, 1], ['sine', 7, 0.7, 1], ['sawtooth', -6, 0.2, 1]];
const PIPES = [['sine', 0, 1, 1], ['sine', 3, 0.5, 2], ['sine', 0, 0.26, 3], ['sine', -3, 0.16, 4]];

const STYLE = {
  bells: { layers: PAD, tones: OPEN, peak: 0.045, attack: 5.5, release: 2.6, hold: [14, 19], cutoff: 950, extra: 'bells' },
  still: { layers: PAD, tones: OPEN, peak: 0.048, attack: 7, release: 3.2, hold: [18, 26], cutoff: 780, extra: null },
  organ: { layers: PIPES, tones: CLOSE, peak: 0.03, attack: 0.9, release: 0.6, hold: [9, 13], cutoff: 2400, extra: null },
  harp: { layers: PAD, tones: OPEN, peak: 0.02, attack: 6, release: 2.8, hold: [12, 16], cutoff: 850, extra: 'harp' },
};

export const STYLES = [
  { id: 'bells', label: 'Soft pad and bells' },
  { id: 'still', label: 'Soft pad alone' },
  { id: 'organ', label: 'Organ' },
  { id: 'harp', label: 'Harp' },
];

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const between = ([low, high]) => low + Math.random() * (high - low);

function impulse(ctx, seconds) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let smooth = 0;
    for (let i = 0; i < length; i++) {
      smooth += (Math.random() * 2 - 1 - smooth) * 0.35; // darken the tail
      data[i] = smooth * (1 - i / length) ** 2.6;
    }
  }
  return buffer;
}

/* ---------- the instrument: the same wiring live and when saving a recording ---------- */

function buildInstrument(ctx) {
  const sum = ctx.createGain();

  const reverb = ctx.createConvolver();
  reverb.buffer = impulse(ctx, 5.5);
  const wet = ctx.createGain();
  wet.gain.value = 0.9;
  reverb.connect(wet).connect(sum);

  const pad = ctx.createBiquadFilter();
  pad.type = 'lowpass';
  pad.frequency.value = 950;
  pad.Q.value = 0.4;
  const drift = ctx.createOscillator();
  drift.frequency.value = 0.04;
  const depth = ctx.createGain();
  depth.gain.value = 0.34 * 950;
  drift.connect(depth).connect(pad.frequency);
  drift.start();
  const dry = ctx.createGain();
  dry.gain.value = 0.55;
  pad.connect(dry).connect(sum);
  pad.connect(reverb);

  const bells = ctx.createGain();
  const echo = ctx.createDelay(2);
  echo.delayTime.value = 0.54;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.36;
  const echoLevel = ctx.createGain();
  echoLevel.gain.value = 0.5;
  bells.connect(sum);
  bells.connect(reverb);
  bells.connect(echo);
  echo.connect(feedback).connect(echo);
  echo.connect(echoLevel).connect(sum);
  echo.connect(reverb);

  return { ctx, sum, pad, depth, bells, reverb };
}

function tune(instrument, style) {
  instrument.pad.frequency.value = style.cutoff;
  instrument.depth.gain.value = 0.34 * style.cutoff;
}

// A function from a step of the scale to a MIDI note, for a mood and transposition.
const scaleOf = (mood, transpose) => (step) =>
  mood.root + transpose + 12 * Math.floor(step / 7) + MODES[mood.mode][((step % 7) + 7) % 7];

function sustain(instrument, style, frequency, peak, when, hold) {
  const { ctx } = instrument;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(peak, when + style.attack);
  env.gain.setTargetAtTime(0, when + hold, style.release);
  env.connect(instrument.pad);
  const end = when + hold + style.release * 5;
  style.layers.forEach(([type, cents, level, multiple], i) => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = frequency * multiple;
    osc.detune.value = cents;
    const gain = ctx.createGain();
    gain.gain.value = level;
    osc.connect(gain).connect(env);
    osc.start(when);
    osc.stop(end);
    if (i === 0) osc.onended = () => env.disconnect();
  });
  return env;
}

function chord(instrument, style, note, degree, when, hold) {
  const bass = degree >= 4 ? degree - 7 : degree;
  const envs = [sustain(instrument, style, hz(note(bass)), style.peak * 1.1, when, hold)];
  for (const [above, level] of style.tones) {
    envs.push(sustain(instrument, style, hz(note(degree + above)), style.peak * level, when, hold));
  }
  return envs;
}

// A struck note: partials are [multiple of the pitch, loudness].
function strike(instrument, frequency, when, { peak, decay, partials, type = 'sine' }) {
  const { ctx } = instrument;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, when);
  env.gain.exponentialRampToValueAtTime(peak, when + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, when + decay);
  env.connect(instrument.bells);
  partials.forEach(([ratio, level], i) => {
    const osc = ctx.createOscillator();
    osc.type = i === 0 ? type : 'sine';
    osc.frequency.value = frequency * ratio;
    const gain = ctx.createGain();
    gain.gain.value = level;
    osc.connect(gain).connect(env);
    osc.start(when);
    osc.stop(when + decay + 0.1);
    if (i === 0) osc.onended = () => env.disconnect();
  });
}

const BELL = { peak: 0.055, decay: 4.5, partials: [[1, 1], [2.01, 0.22], [3, 0.07]] };
const STRING = { peak: 0.06, decay: 2.2, partials: [[1, 1], [2, 0.3], [3, 0.1]], type: 'triangle' };

function bell(instrument, mood, note, when) {
  const pentatonic = mood.minor ? [0, 2, 3, 4, 6] : [0, 1, 2, 4, 5];
  strike(instrument, hz(note(pick(pentatonic) + 7 * pick([3, 3, 4]))), when, BELL);
}

// One rising or falling run across the notes of the chord.
function harpRun(instrument, note, degree, when) {
  const steps = [0, 2, 4, 7, 9, 11, 14].map((s) => degree + s + 14);
  const run = Math.random() < 0.5 ? steps : [...steps].reverse();
  const count = 3 + Math.floor(Math.random() * 4);
  const gap = 0.28 + Math.random() * 0.2;
  const first = Math.floor(Math.random() * (run.length - count + 1));
  for (let i = 0; i < count; i++) strike(instrument, hz(note(run[first + i])), when + i * gap, STRING);
}

/* ---------- live ---------- */

export class Ambience {
  constructor() {
    this.ctx = null;
    this.running = false;
    this.volume = 0.55;
    this.ducked = false;
    this.mood = MOODS.wisdom;
    this.style = STYLE.bells;
    this.transpose = 0;
    this.step = 0;
    this.degree = 0;
    this.sounding = [];
    this.bands = [0, 0, 0];
    this.peaks = [0.02, 0.02, 0.02];
    this.voiceSmooth = 0;
  }

  get available() {
    return Boolean(window.AudioContext || window.webkitAudioContext);
  }

  // Must be called from a click or key press: browsers will not start audio otherwise.
  start() {
    if (!this.available) return;
    if (!this.ctx) this.#build();
    clearTimeout(this.sleepTimer);
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (!this.running) {
      this.running = true;
      this.#applyVolume(3);
      this.#chord();
      this.#extras();
    } else {
      this.#applyVolume(1.5);
    }
  }

  // Fade the music away over the given time and then stop it.
  sleep(seconds) {
    if (!this.running) return;
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, seconds / 4);
    clearTimeout(this.sleepTimer);
    this.sleepTimer = setTimeout(() => {
      this.running = false;
      clearTimeout(this.chordTimer);
      clearTimeout(this.extraTimer);
      this.sounding = [];
      this.ctx.suspend();
    }, seconds * 1000);
  }

  setMood(genre, seed = 0) {
    this.mood = MOODS[genre] ?? MOODS.wisdom;
    this.transpose = (seed % 5) - 2;
    this.step = 0;
    this.#restart();
  }

  setStyle(id) {
    this.style = STYLE[id] ?? STYLE.bells;
    if (this.instrument) tune(this.instrument, this.style);
    this.#restart();
  }

  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
    this.#applyVolume(0.15);
  }

  // Step back while the voice is speaking.
  duck(ducked) {
    if (ducked === this.ducked) return;
    this.ducked = ducked;
    this.#applyVolume(ducked ? 0.35 : 1.2);
  }

  // Where the reading voice is played. It bypasses the music volume.
  voiceInput() {
    if (!this.ctx) this.#build();
    return this.voice;
  }

  // How loud the reading voice is right now, 0 to 1.
  voiceLevel() {
    if (!this.voiceAnalyser) return 0;
    this.voiceAnalyser.getByteTimeDomainData(this.voiceWave);
    let sum = 0;
    for (const sample of this.voiceWave) sum += ((sample - 128) / 128) ** 2;
    const level = Math.min(1, Math.sqrt(sum / this.voiceWave.length) * 4);
    this.voiceSmooth += (level - this.voiceSmooth) * (level > this.voiceSmooth ? 0.5 : 0.15);
    return this.voiceSmooth;
  }

  // Loudness in three bands, each 0 to 1 against its own recent peak.
  levels() {
    if (!this.running) return this.bands;
    this.analyser.getByteFrequencyData(this.bins);
    const perBin = this.ctx.sampleRate / this.analyser.fftSize;
    [[60, 260], [260, 1300], [1300, 6000]].forEach(([lo, hi], i) => {
      const from = Math.max(1, Math.floor(lo / perBin));
      const to = Math.min(this.bins.length - 1, Math.ceil(hi / perBin));
      let sum = 0;
      for (let bin = from; bin <= to; bin++) sum += this.bins[bin];
      const level = sum / (to - from + 1) / 255;
      this.peaks[i] = Math.max(level, this.peaks[i] * 0.9995, 0.02);
      this.bands[i] = (level / this.peaks[i]) ** 2;
    });
    return this.bands;
  }

  // What a recording needs in order to play the same music.
  get recipe() {
    return { mood: this.mood, transpose: this.transpose, style: this.style, volume: this.volume };
  }

  #build() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = (this.ctx = new Ctx());
    this.instrument = buildInstrument(ctx);
    tune(this.instrument, this.style);

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.ratio.value = 3;
    comp.attack.value = 0.05;
    comp.release.value = 0.5;
    this.instrument.sum.connect(this.master).connect(comp).connect(ctx.destination);

    // The window listens before the volume control, so it keeps moving when muted.
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.86;
    this.instrument.sum.connect(this.analyser);
    this.bins = new Uint8Array(this.analyser.frequencyBinCount);

    this.voice = ctx.createGain();
    this.voice.connect(ctx.destination);
    this.voiceAnalyser = ctx.createAnalyser();
    this.voiceAnalyser.fftSize = 512;
    this.voice.connect(this.voiceAnalyser);
    this.voiceWave = new Uint8Array(this.voiceAnalyser.fftSize);
  }

  #applyVolume(timeConstant) {
    if (!this.ctx) return;
    const target = this.volume ** 1.6 * (this.ducked ? 0.42 : 1);
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, timeConstant);
  }

  // Let what is sounding die away and begin again in the new mood or style.
  #restart() {
    if (!this.running) return;
    const now = this.ctx.currentTime;
    for (const env of this.sounding) {
      if (env.gain.cancelAndHoldAtTime) env.gain.cancelAndHoldAtTime(now);
      else env.gain.cancelScheduledValues(now);
      env.gain.setTargetAtTime(0, now, 0.9);
    }
    this.sounding = [];
    clearTimeout(this.chordTimer);
    clearTimeout(this.extraTimer);
    this.chordTimer = setTimeout(() => {
      this.#chord();
      this.#extras();
    }, 1400);
  }

  #chord() {
    if (!this.running) return;
    const { progression } = this.mood;
    this.degree = progression[this.step++ % progression.length];
    const hold = between(this.style.hold);
    const note = scaleOf(this.mood, this.transpose);
    const envs = chord(this.instrument, this.style, note, this.degree, this.ctx.currentTime + 0.05, hold);
    this.sounding = [...this.sounding.slice(-24), ...envs];
    this.chordTimer = setTimeout(() => this.#chord(), hold * 1000);
  }

  #extras() {
    clearTimeout(this.extraTimer);
    const { extra } = this.style;
    if (!extra) return;
    const wait = extra === 'harp' ? 2600 + Math.random() * 3200 : 2800 + Math.random() * 5200;
    this.extraTimer = setTimeout(() => {
      if (!this.running) return;
      if (this.ctx.state === 'running') {
        const note = scaleOf(this.mood, this.transpose);
        const when = this.ctx.currentTime + 0.05;
        if (extra === 'harp') {
          harpRun(this.instrument, note, this.degree, when);
        } else {
          bell(this.instrument, this.mood, note, when);
          if (Math.random() < 0.35) bell(this.instrument, this.mood, note, when + 0.35 + Math.random() * 0.5);
        }
      }
      this.#extras();
    }, wait);
  }
}

/* ---------- for a saved recording ---------- */

// Schedules the same kind of music across the whole of an offline recording
// and returns the gain node that sets its loudness.
export function scoreMusic(ctx, { mood, transpose, style }, seconds) {
  const instrument = buildInstrument(ctx);
  tune(instrument, style);
  const master = ctx.createGain();
  instrument.sum.connect(master).connect(ctx.destination);

  const note = scaleOf(mood, transpose);
  const chords = [];
  for (let when = 0.05, step = 0; when < seconds; step++) {
    const degree = mood.progression[step % mood.progression.length];
    const hold = between(style.hold);
    chord(instrument, style, note, degree, when, hold);
    chords.push({ when, degree });
    when += hold;
  }
  if (style.extra) {
    for (let when = 3; when < seconds - 3; ) {
      if (style.extra === 'harp') {
        const current = chords.findLast((c) => c.when <= when) ?? chords[0];
        harpRun(instrument, note, current.degree, when);
        when += 2.6 + Math.random() * 3.2;
      } else {
        bell(instrument, mood, note, when);
        when += 2.8 + Math.random() * 5.2;
      }
    }
  }
  return master;
}
