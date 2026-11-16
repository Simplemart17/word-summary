// Runs the voice model on its own thread. Turning text into speech keeps a
// processor busy for a second or two at a time, and on the server's main
// thread that would hold up every other request, including sending back the
// audio that was just made.

import { parentPort } from 'node:worker_threads';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let tts;

function wav16(samples, rate) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return out;
}

parentPort.on('message', async ({ id, type, text, voice, speed, dtype }) => {
  try {
    if (type === 'load') {
      const { KokoroTTS } = await import('kokoro-js');
      tts = await KokoroTTS.from_pretrained(MODEL, { dtype, device: 'cpu' });
      await tts.generate('Selah.', { voice }); // the first sentence is slow; get it out of the way
      parentPort.postMessage({ id });
      return;
    }
    const audio = await tts.generate(text, { voice, speed });
    const wav = wav16(audio.audio, audio.sampling_rate);
    const bytes = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
    parentPort.postMessage({ id, bytes }, [bytes]);
  } catch (err) {
    parentPort.postMessage({ id, error: err.message, code: err.code });
  }
});
