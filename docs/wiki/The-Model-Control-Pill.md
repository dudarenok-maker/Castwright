# The Model Control Pill

Every button-driven engine or model tier in **Admin → Model Manager** — Coqui,
and Qwen's Base and higher-quality tiers — gets the same pill-and-button
control: a status pill on the left (idle / loading / ready / unreachable) and
a Load or Stop action on the right. It's the one place the app tells you
what's actually resident in GPU memory right now, separate from what's
merely installed on disk.

Below, Kokoro's row in a **ready** state: the pill reads a green "Kokoro v1
ready," with **DEFAULT**, **FALLBACK**, and **verified** badges, and the
action is **Stop** — the same control that loaded it now unloads it and
frees the VRAM.

![Model Manager row — Kokoro loaded and ready](images/the-model-control-pill/03-pill-loaded.png)

An engine still loading shows an amber "Loading …" pill with its button
disabled, so a second click can't fire mid-load; one that's installed but not
yet loaded reads "idle" with a **Load model** action instead. An engine
without an installed package yet (e.g. Coqui before its `pip install` step)
or without its weights fetched (e.g. Kokoro before its one-time download)
shows an install/repair action instead of this pill — there's nothing to
load until that step completes. See [Voice Engines](Voice-Engines) for what
each engine's row looks like in those states.

![Model Manager row — llama3.1:8b idle with a Load model action](images/the-model-control-pill/idle-state.png)

Below, `llama3.1:8b`: installed on disk but not resident in GPU memory, so the pill reads a neutral "llama3.1:8b idle" and the action is **Load model** rather than Stop.

> A screenshot of the loading state is tracked as a follow-up — it's a transient state the current capture harness doesn't pose yet.

Next: [Library Management](Library-Management).
