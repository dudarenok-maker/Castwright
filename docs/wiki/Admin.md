# Admin

**Admin** (`#/admin`) is a live watch console for the generation pipeline —
health checks and throughput at a glance, no logs required. It's reached
from the **Admin** pill in the top bar.

![Admin overview](images/admin/01-admin-overview.png)

The top of the page is three link-out cards — **About Castwright** (brand
story, tagline, app version), **Model Manager** (see
[Model Manager](Model-Manager)), and **Advanced configuration** (see
[Advanced Settings](Advanced-Settings)) — followed by the **LAN access**
card for pairing phones/tablets (see
[Mobile, Tablet & Companion App](Mobile-Tablet-and-Companion-App)).

Below that sits the actual console, three stacked sections:

- **Health** — one glanceable board covering GPU & VRAM, the voice engine,
  the analyzer, ASR, ffmpeg, and free disk, each as a green/amber/red dot
  with a plain-language label and a technical detail line. Re-checked every
  30 seconds; a failed refresh just leaves the last good board in place
  rather than blanking out.
- **Generation throughput** — per-chapter RTF (real-time factor: synth-wall
  time ÷ audio duration; under 1.0 means faster than real-time) for the
  current session, newest first, with an up/down arrow flagging whether a
  chapter ran slower or faster than the one before it.
- **Resource trends** — the same per-chapter history plotted as VRAM and
  wall-time alongside RTF, grouped by book, with a small inline sparkline —
  useful for spotting a slow VRAM climb before it turns into a spill or an
  out-of-memory recycle.

> Running the dev build (`npm run dev`) adds a fourth, dev-only
> **Worktrees** section listing every git worktree and a live port probe —
> it doesn't appear in a production build.

Next: [Model Manager](Model-Manager).
