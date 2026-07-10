/* fs-52 — pure SRT/VTT formatters. No I/O; every caption cue is fully
   resolved (timing + text + optional speaker) before it reaches here. See
   docs/superpowers/specs/2026-07-10-fs52-caption-srt-export-design.md §4. */

export interface CaptionCue {
  startSec: number;
  endSec: number;
  text: string;
  speaker?: string;
}

function cueText(cue: CaptionCue): string {
  return cue.speaker ? `${cue.speaker}: ${cue.text}` : cue.text;
}

function pad(n: number, width: number): string {
  return String(Math.floor(n)).padStart(width, '0');
}

function formatTimestamp(totalSec: number, msSeparator: ',' | '.'): string {
  const totalMs = Math.round(totalSec * 1000);
  const ms = totalMs % 1000;
  const totalSecondsInt = Math.floor(totalMs / 1000);
  const s = totalSecondsInt % 60;
  const m = Math.floor(totalSecondsInt / 60) % 60;
  const h = Math.floor(totalSecondsInt / 3600);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${msSeparator}${pad(ms, 3)}`;
}

export function writeSrt(cues: CaptionCue[]): string {
  return cues
    .map((cue, i) => {
      const start = formatTimestamp(cue.startSec, ',');
      const end = formatTimestamp(cue.endSec, ',');
      return `${i + 1}\n${start} --> ${end}\n${cueText(cue)}\n\n`;
    })
    .join('');
}

export function writeVtt(cues: CaptionCue[]): string {
  const body = cues
    .map((cue) => {
      const start = formatTimestamp(cue.startSec, '.');
      const end = formatTimestamp(cue.endSec, '.');
      return `${start} --> ${end}\n${cueText(cue)}\n\n`;
    })
    .join('');
  return `WEBVTT\n\n${body}`;
}
