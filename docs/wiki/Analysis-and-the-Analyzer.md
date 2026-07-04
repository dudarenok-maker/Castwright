# Analysis & the Analyzer

Once a book is saved, Castwright reads it chapter by chapter, detects every
speaking character, and tags each line with who's speaking it. The
Analysing screen streams live progress — phase, percentage, ETA, and the
cast roster as it's discovered.

![Analysing](images/analysis-and-the-analyzer/01-analysing-progress.png)

## Choosing an analyzer

The model picker on the upload screen groups two kinds of analyzer:

- **Local Ollama (on-device)** — free, private, runs on your own GPU/CPU.
  Whatever tags you've pulled with Ollama show up here automatically.
- **Gemini / Gemma (cloud)** — Google's free-tier API. Useful on a
  low-VRAM machine, or when you'd rather not tie up local compute.

![Analyzer choice](images/analysis-and-the-analyzer/02-analyzer-choice.png)

See [Installing Castwright](Installing-Castwright) for setting up either
path (pulling an Ollama model vs. adding a Gemini API key).

A cloud analyzer also unlocks a **pipelined two-model split** on the
Analysing screen itself — a cheaper/faster model for Phase 0 (detecting
characters) and a different Gemini model for Phase 1 (parsing and
attribution), configured independently per phase. Leave both on
"(use server default)" for the ordinary single-model path.

Next: [Reviewing Low-Confidence Speaker Tags](Reviewing-Low-Confidence-Speaker-Tags).
