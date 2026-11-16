// Saves a whole reading, voice over music, as one audio file.
//
// The page already has every spoken piece as audio. Here they are laid end to
// end with their pauses, the same kind of music is scored underneath, and the
// two are mixed faster than real time. The result is a WAV; if the server has
// a converter, it is squeezed into an .m4a a tenth of the size.

import { scoreMusic } from './ambience.js';

const RATE = 32000;
const LEAD_IN = 3; // seconds of music before the voice begins
const TAIL = 7; // seconds of music after it ends
const DUCKED = 0.42; // how far the music steps back under the voice

async function mix(clips, music) {
  let length = LEAD_IN;
  const starts = clips.map(({ buffer, pauseAfter }) => {
    const at = length;
    length += buffer.duration + pauseAfter / 1000;
    return at;
  });
  const voiceEnds = length;
  length += TAIL;

  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Offline(2, Math.ceil(length * RATE), RATE);

  clips.forEach(({ buffer }, i) => {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(starts[i]);
  });

  const level = music.volume ** 1.6;
  if (level > 0) {
    const master = scoreMusic(ctx, music, length);
    master.gain.setValueAtTime(0, 0);
    master.gain.linearRampToValueAtTime(level, 2);
    master.gain.setTargetAtTime(level * DUCKED, LEAD_IN - 0.4, 0.35);
    master.gain.setTargetAtTime(level, voiceEnds + 0.3, 0.8);
    master.gain.setTargetAtTime(0, length - 4.5, 1.1);
  }
  return ctx.startRendering();
}

function toWav(buffer) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytes = frames * channels * 2;
  const view = new DataView(new ArrayBuffer(44 + bytes));
  const text = (at, string) => [...string].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, bytes, true);

  const data = Array.from({ length: channels }, (_, ch) => buffer.getChannelData(ch));
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const sample = Math.max(-1, Math.min(1, data[ch][i]));
      view.setInt16(at, Math.round(sample * 32767), true);
      at += 2;
    }
  }
  return new Blob([view], { type: 'audio/wav' });
}

function download(blob, filename) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

// clips: [{ buffer, pauseAfter }]; music: Ambience.recipe; format: "m4a" or "wav"
export async function saveRecording({ clips, music, format, name }) {
  if (!clips.length) throw new Error('There is nothing to save yet.');
  const wav = toWav(await mix(clips, music));
  if (format !== 'm4a') return download(wav, `${name}.wav`);

  const response = await fetch('/api/encode', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
  // If the converter fails, the larger file is still worth having.
  if (!response.ok) return download(wav, `${name}.wav`);
  download(await response.blob(), `${name}.m4a`);
}
