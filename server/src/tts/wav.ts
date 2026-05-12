/* Wrap raw 16-bit signed little-endian mono PCM in a RIFF/WAVE container so
   browsers can play the file directly via <audio src>. Gemini TTS returns
   24 kHz PCM; the sample rate is encoded in the response mime type and
   passed through. */

const BYTES_PER_SAMPLE = 2; // 16-bit
const CHANNELS = 1;          // mono

export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const byteRate = sampleRate * CHANNELS * BYTES_PER_SAMPLE;
  const blockAlign = CHANNELS * BYTES_PER_SAMPLE;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');

  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);            // fmt chunk size
  header.writeUInt16LE(1, 20);             // PCM format
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(8 * BYTES_PER_SAMPLE, 34);

  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

export function wavDurationSec(pcmBytes: number, sampleRate: number): number {
  return pcmBytes / (sampleRate * CHANNELS * BYTES_PER_SAMPLE);
}
