// Throwaway on-box measurement script for D3 (not shipped code). Calls the
// REAL, live TTS sidecar at 127.0.0.1:9120 (owned by another lane's server —
// read/synthesize calls only, never touched its process) to render the
// clips needed for the three D3 proxies, and writes WAV files + raw
// measurement JSON into this results directory.
import { writeFileSync } from 'node:fs';

const SIDECAR = 'http://127.0.0.1:9120';
const OUT = 'C:/Claude/Projects/wt-human-checkpoint-batch/docs/testing/onbox-human-checkpoint-results';

function wavHeader(dataLen, sampleRate, channels = 1, bitsPerSample = 16) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

async function synth(name, { voice, text, language = 'zh' }) {
  const res = await fetch(`${SIDECAR}/synthesize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ engine: 'coqui', model: 'xtts_v2', voice, text, language }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`synthesize ${name} failed: ${res.status} ${t}`);
  }
  const sampleRate = Number(res.headers.get('x-sample-rate'));
  const pcm = Buffer.from(await res.arrayBuffer());
  const wav = Buffer.concat([wavHeader(pcm.length, sampleRate), pcm]);
  writeFileSync(`${OUT}/${name}.wav`, wav);
  writeFileSync(`${OUT}/${name}.pcm`, pcm);
  const durSec = pcm.length / 2 / sampleRate;
  console.log(`[synth] ${name}: voice=${voice} sampleRate=${sampleRate} bytes=${pcm.length} durSec=${durSec.toFixed(3)}`);
  return { name, voice, text, sampleRate, pcm, durSec };
}

async function main() {
  const clips = {};
  // Outer run: the tag-bearing speech attributed to 桓侯 (Huan Hou), ending
  // right at the point the recovered inner turn begins. Real corpus text,
  // Gutenberg #51828 (聊齋志異), offsets 442-476 per step3-d3-probe.mts.
  clips.outer = await synth('outer-huanhou', {
    voice: 'Craig Gutsy',
    text: '明日造市，請於馬羣中任意擇其良者，不必與之論價，吾自給之。又告衆曰：',
  });
  // Recovered inner turn: attributed to 衆 (the attendants/crowd), offsets
  // 477-489. This is the span the fix recovers as its own run instead of
  // merging it into `outer`.
  clips.inner = await synth('inner-zhong-recovered', {
    voice: 'Nova Hogarth',
    text: '遠客歸家，可少助以資斧。',
  });
  // Same-character reference clip (a different real 衆-attributed line
  // elsewhere in the same Gutenberg book, story of 長清僧) — proves voice
  // consistency for the SAME character/voice, per the A18 methodology shape.
  clips.innerRef = await synth('inner-zhong-reference', {
    voice: 'Nova Hogarth',
    text: '新瘳，未應遠涉。',
  });
  // Different-speaker floor: a real narration line from the SAME paragraph,
  // rendered in a third, distinct voice.
  clips.floor = await synth('narrator-floor', {
    voice: 'Damien Black',
    text: '彭至下馬，相向拱敬。',
  });
  // Contrast case: the OLD (pre-fix) merged behaviour — outer text + inner
  // text synthesised as ONE call in ONE voice (what the paragraph would have
  // sounded like before the primary-pair-straddle recovery).
  clips.merged = await synth('merged-old-behavior', {
    voice: 'Craig Gutsy',
    text: '明日造市，請於馬羣中任意擇其良者，不必與之論價，吾自給之。又告衆曰：遠客歸家，可少助以資斧。',
  });

  writeFileSync(
    `${OUT}/step3-d3-render-manifest.json`,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(clips).map(([k, v]) => [k, { voice: v.voice, text: v.text, sampleRate: v.sampleRate, durSec: v.durSec }]),
      ),
      null,
      2,
    ),
  );
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
