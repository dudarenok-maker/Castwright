#!/usr/bin/env node
// Monitor a live full-book generation run: queue progress + per-chapter RTF + GPU state.
//
// RTF = wall seconds / produced audio seconds (<1 = faster than realtime).
// With a single generation worker the queue is serial, so each chapter's wall
// time is the gap between consecutive completed-MP3 mtimes; the first chapter of
// the run is measured from --since (the run start). Audio seconds come from
// ffprobe on the produced MP3 (ground truth, per docs/tts-performance.md).
//
// Usage:
//   node scripts/monitor-generation.mjs --audio "<book audio dir>" --since <ISO> [--server http://localhost:8080]
//
// Dry-read only: hits the queue endpoint and ffprobes finished files. Writes nothing.

import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}

const SERVER = arg('server', 'http://localhost:8080')
const AUDIO = arg('audio', null)
const SINCE = arg('since', null)
if (!AUDIO || !SINCE) {
  console.error('Required: --audio "<dir>" --since <ISO timestamp>')
  process.exit(2)
}
const sinceMs = Date.parse(SINCE)

function ffprobeSeconds(file) {
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', file],
      { encoding: 'utf8' },
    )
    return parseFloat(out.trim())
  } catch {
    return null
  }
}

function gpu() {
  try {
    const out = execFileSync(
      'nvidia-smi',
      ['--query-gpu=utilization.gpu,clocks.sm,power.draw,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { encoding: 'utf8' },
    )
    const [util, clk, pwr, used, total] = out.trim().split(',').map((s) => s.trim())
    return `util ${util}% | sm ${clk}MHz | ${pwr}W | VRAM ${used}/${total}MiB`
  } catch {
    return 'nvidia-smi unavailable'
  }
}

async function queueSummary() {
  try {
    const r = await fetch(`${SERVER}/api/queue`)
    const d = await r.json()
    const e = d.entries || []
    const by = (s) => e.filter((x) => x.status === s)
    const ip = by('in_progress')[0]
    return {
      total: e.length,
      queued: by('queued').length,
      inProgress: ip ? ip.chapterId : null,
      done: by('done').length,
      failed: by('failed').length,
    }
  } catch (err) {
    return { error: String(err) }
  }
}

// Completed MP3s produced during this run, ordered by mtime.
const finished = readdirSync(AUDIO)
  .filter((f) => f.endsWith('.mp3') && !f.includes('.previous.'))
  .map((f) => {
    const full = path.join(AUDIO, f)
    return { f, mtime: statSync(full).mtimeMs, full }
  })
  .filter((x) => x.mtime >= sinceMs)
  .sort((a, b) => a.mtime - b.mtime)

const q = await queueSummary()

console.log(`\n=== generation monitor @ ${new Date().toISOString()} ===`)
console.log(
  `queue: ${q.total} total | done ${q.done ?? '?'} | in_progress ch ${q.inProgress ?? '-'} | queued ${q.queued ?? '?'} | failed ${q.failed ?? 0}`,
)
console.log(`gpu: ${gpu()}`)

if (finished.length === 0) {
  console.log(`\nno chapters completed yet this run (since ${SINCE})`)
} else {
  console.log(`\n${finished.length} chapter(s) completed this run:\n`)
  console.log('  file                                   audio_s   wall_s    RTF')
  let prev = sinceMs
  const rtfs = []
  for (const item of finished) {
    const audio = ffprobeSeconds(item.full)
    const wall = (item.mtime - prev) / 1000
    prev = item.mtime
    const rtf = audio ? wall / audio : null
    if (rtf != null) rtfs.push(rtf)
    const name = item.f.slice(0, 36).padEnd(38)
    console.log(
      `  ${name} ${String(audio?.toFixed(1) ?? '?').padStart(7)} ${wall.toFixed(1).padStart(8)} ${(rtf?.toFixed(2) ?? '?').padStart(6)}`,
    )
  }
  if (rtfs.length) {
    const mean = rtfs.reduce((a, b) => a + b, 0) / rtfs.length
    console.log(`\n  mean RTF (this run): ${mean.toFixed(2)}  [reference: 32/3600 target ~2; prose can dip <1]`)
  }
}
