import type { ConfigGroup, ConfigKnob } from './types.js';

export const GROUPS: ConfigGroup[] = [
  { id: 'analyzer-sampling', label: 'LLM sampling parameters', help: 'Temperature and token limits for the analysis model.', risk: 'medium', collapsedByDefault: false },
  { id: 'analyzer-chunking', label: 'Analyzer chunking & truncation guards', help: 'How chapters are split and how truncation/loops are detected.', risk: 'medium', collapsedByDefault: false },
  { id: 'analyzer-prompts', label: 'Analyzer prompts & skills', help: 'The instructions sent to the analysis model. Editing forks a local copy.', risk: 'high', collapsedByDefault: true },
  { id: 'analyzer-models', label: 'Analyzer models & endpoints', help: 'Which model/endpoint runs the analysis.', risk: 'medium', collapsedByDefault: false },
  { id: 'tts-engine', label: 'Voice engine & device', help: 'Voice engine device, language, and preload behaviour.', risk: 'high', collapsedByDefault: true },
  { id: 'tts-batching', label: 'Voice batching & throughput', help: 'Batch sizing and generation concurrency.', risk: 'medium', collapsedByDefault: false },
  { id: 'qa-gates', label: 'Per-sentence QA gates', help: 'Acoustic and ASR checks applied before assembly.', risk: 'low', collapsedByDefault: false },
  { id: 'audio-loudness', label: 'Audio loudness targets', help: 'EBU R128 normalization targets.', risk: 'low', collapsedByDefault: false },
  { id: 'gpu-lifecycle', label: 'GPU arbitration, memory & lifecycle', help: 'GPU concurrency, VRAM budgets, and sidecar recycling. Footguns live here.', risk: 'high', collapsedByDefault: true },
  { id: 'rate-limits', label: 'Gemini rate limits', help: 'Per-model request/token/day caps for the Gemini API.', risk: 'low', collapsedByDefault: false },
];

export const KNOBS: ConfigKnob[] = [
  // ── analyzer-sampling ────────────────────────────────────────────────────
  {
    key: 'analyzer.ollama.temperature',
    env: 'OLLAMA_TEMPERATURE',
    group: 'analyzer-sampling',
    label: 'Ollama temperature',
    help: 'Sampling temperature for the first analysis attempt; lower values stay closer to the schema.',
    type: 'number', min: 0, max: 2, step: 0.1,
    default: 0.2, // ← DEFAULT_TEMPERATURE in analyzer/ollama.ts
    apply: 'live', risk: 'medium',
  },
  {
    key: 'analyzer.ollama.retryTemperature',
    env: 'OLLAMA_RETRY_TEMPERATURE',
    group: 'analyzer-sampling',
    label: 'Ollama retry temperature',
    help: 'Temperature used on invalid-JSON retries to escape the failure path.',
    type: 'number', min: 0, max: 2, step: 0.1,
    default: 0.6, // ← INVALID_JSON_RETRY_TEMPERATURE in analyzer/ollama.ts
    apply: 'live', risk: 'medium',
  },
  {
    key: 'analyzer.ollama.numPredict',
    env: 'ANALYZER_NUM_PREDICT',
    group: 'analyzer-sampling',
    label: 'Ollama num_predict',
    help: 'Output-token cap for Ollama; -1 means predict until context window fills.',
    type: 'integer', min: -1, step: 1,
    default: -1, // ← resolveNumPredict() default in analyzer/ollama.ts
    apply: 'live', risk: 'medium',
  },
  {
    key: 'analyzer.gemini.maxOutputTokens',
    env: 'ANALYZER_MAX_OUTPUT_TOKENS',
    group: 'analyzer-sampling',
    label: 'Gemini max output tokens',
    help: 'Per-request output-token cap for Gemini; set to match the free-tier ceiling.',
    type: 'integer', min: 256, max: 32768,
    default: 8192, // ← DEFAULT_MAX_OUTPUT_TOKENS in analyzer/gemini.ts
    apply: 'live', risk: 'medium',
  },

  // ── analyzer-chunking ─────────────────────────────────────────────────────
  {
    key: 'analyzer.stage2.chunkCharBudget',
    env: 'STAGE2_CHUNK_CHAR_BUDGET',
    group: 'analyzer-chunking',
    label: 'Stage-2 chunk char budget',
    help: 'Maximum characters per stage-2 attribution chunk before the chapter is pre-emptively split.',
    type: 'integer',
    default: 9000, // ← DEFAULT_STAGE2_CHUNK_CHAR_BUDGET in analyzer/stage2-chunk.ts
    apply: 'live', risk: 'medium',
  },
  {
    key: 'analyzer.stage1.chunkCharBudget',
    env: 'STAGE1_CHUNK_CHAR_BUDGET',
    group: 'analyzer-chunking',
    label: 'Stage-1 chunk char budget',
    help: 'Maximum characters per stage-1 cast-detection chunk before the chapter is split. For local engines the effective budget is derived (lowered) from Ollama num_ctx so a large or non-Latin chapter can never overflow the context window.',
    type: 'integer',
    default: 24000, // ← DEFAULT_STAGE1_CHUNK_CHAR_BUDGET in analyzer/stage1-chunk.ts
    apply: 'live', risk: 'medium',
  },
  {
    key: 'analyzer.stage2.minCoverage',
    env: 'STAGE2_MIN_COVERAGE',
    group: 'analyzer-chunking',
    label: 'Coverage min ratio',
    help: 'Attributed/source word-ratio floor below which a chapter is treated as truncated.',
    type: 'number', min: 0, max: 1, step: 0.05,
    default: 0.6, // ← DEFAULT_STAGE2_COVERAGE_THRESHOLDS.minCoverageRatio in analyzer/stage2-coverage.ts
    apply: 'live', risk: 'medium',
  },
  {
    key: 'analyzer.stage2.maxCoverage',
    env: 'STAGE2_MAX_COVERAGE',
    group: 'analyzer-chunking',
    label: 'Coverage max ratio',
    help: 'Attributed/source word-ratio ceiling above which a chapter is treated as a repeat-loop.',
    type: 'number', min: 1, max: 5, step: 0.1,
    default: 1.6, // ← DEFAULT_STAGE2_COVERAGE_THRESHOLDS.maxCoverageRatio in analyzer/stage2-coverage.ts
    apply: 'live', risk: 'medium',
  },
  {
    key: 'analyzer.stage2.endingTailWords',
    env: 'STAGE2_ENDING_TAIL_WORDS',
    group: 'analyzer-chunking',
    label: 'Ending tail words',
    help: 'How many trailing source words must appear in the output for the chapter ending to be considered present.',
    type: 'integer',
    default: 8, // ← DEFAULT_STAGE2_COVERAGE_THRESHOLDS.endingTailWords in analyzer/stage2-coverage.ts
    apply: 'live', risk: 'medium',
  },
  {
    key: 'analyzer.stage2.minDupRun',
    env: 'STAGE2_MIN_DUP_RUN',
    group: 'analyzer-chunking',
    label: 'Min duplicated-sentence run',
    help: 'Smallest contiguous run of duplicated sentences (constant offset) flagged as a repeat-loop.',
    type: 'integer',
    default: 4, // ← DEFAULT_STAGE2_COVERAGE_THRESHOLDS.minDupRun in analyzer/stage2-coverage.ts
    apply: 'live', risk: 'medium',
  },
  {
    key: 'analyzer.stage2.coverageRetries',
    env: 'STAGE2_COVERAGE_RETRIES',
    group: 'analyzer-chunking',
    label: 'Coverage-guard retries',
    help: 'Number of re-runs when stage-2 coverage fails; 0 disables the guard.',
    type: 'integer',
    default: 2, // ← resolveStage2CoverageRetries() default in routes/analysis.ts
    apply: 'live', risk: 'medium',
  },

  // ── qa-gates ─────────────────────────────────────────────────────────────
  {
    key: 'qa.seg.maxRerecords',
    env: 'SEG_QA_MAX_RERECORDS',
    group: 'qa-gates',
    label: 'Signal QA max re-records',
    help: 'How many times a suspect sentence is re-recorded before keeping the best take; 0 disables the gate.',
    type: 'integer',
    default: 2, // ← resolveSegmentQaRerecords() default in routes/generation.ts
    apply: 'live', risk: 'low',
  },
  {
    key: 'qa.seg.silenceRms',
    env: 'SEG_QA_SILENCE_RMS',
    group: 'qa-gates',
    label: 'Silence RMS threshold',
    help: 'Mean RMS at or below this value marks a segment as dead/near-silent.',
    type: 'number', min: 0, max: 0.1, step: 0.001,
    default: 0.003, // ← DEFAULT_SEGMENT_QA_THRESHOLDS.silenceRms in tts/segment-qa.ts
    apply: 'live', risk: 'low',
  },
  {
    key: 'qa.seg.noiseFloor',
    env: 'SEG_QA_NOISE_FLOOR',
    group: 'qa-gates',
    label: 'Noise floor',
    help: 'Normalised sample amplitude below which a sample is counted as silent for the internal-silence-run scan.',
    type: 'number', min: 0, max: 0.1, step: 0.001,
    default: 0.01, // ← DEFAULT_SEGMENT_QA_THRESHOLDS.noiseFloor in tts/segment-qa.ts
    apply: 'live', risk: 'low',
  },
  {
    key: 'qa.seg.maxInternalSilenceSec',
    env: 'SEG_QA_MAX_INTERNAL_SILENCE_SEC',
    group: 'qa-gates',
    label: 'Max internal silence (s)',
    help: 'Longest contiguous near-silent run above this (seconds) marks a segment as suspect.',
    type: 'number', min: 0.1, max: 10, step: 0.1,
    default: 1.5, // ← DEFAULT_SEGMENT_QA_THRESHOLDS.maxInternalSilenceSec in tts/segment-qa.ts
    apply: 'live', risk: 'low',
  },
  {
    key: 'qa.seg.minRatio',
    env: 'SEG_QA_MIN_RATIO',
    group: 'qa-gates',
    label: 'Duration min ratio',
    help: 'Duration/expected ratio below this marks a segment as truncated.',
    type: 'number', min: 0, max: 5, step: 0.1,
    default: 0.4, // ← DEFAULT_SEGMENT_QA_THRESHOLDS.minDurationRatio in tts/segment-qa.ts
    apply: 'live', risk: 'low',
  },
  {
    key: 'qa.seg.maxRatio',
    env: 'SEG_QA_MAX_RATIO',
    group: 'qa-gates',
    label: 'Duration max ratio',
    help: 'Duration/expected ratio above this marks a segment as runaway/garbled.',
    type: 'number', min: 0, max: 5, step: 0.1,
    default: 2.5, // ← DEFAULT_SEGMENT_QA_THRESHOLDS.maxDurationRatio in tts/segment-qa.ts
    apply: 'live', risk: 'low',
  },
  {
    key: 'qa.asr.enabled',
    env: 'SEG_ASR_ENABLED',
    group: 'qa-gates',
    label: 'ASR QA enabled',
    help: 'Enable Whisper-based content verification; requires the sidecar venv with faster-whisper installed.',
    type: 'boolean',
    default: false, // ← asrEnabled() default (env not set → false) in tts/segment-asr-qa.ts
    apply: 'live', risk: 'low',
  },
  {
    key: 'qa.asr.maxRerecords',
    env: 'SEG_ASR_MAX_RERECORDS',
    group: 'qa-gates',
    label: 'ASR max re-records',
    help: 'Re-record budget for ASR drift; 0 = detect and flag only.',
    type: 'integer',
    default: 2, // ← resolveAsrRerecords() default in tts/segment-asr-qa.ts
    apply: 'live', risk: 'low',
  },
  {
    key: 'qa.asr.sampleEvery',
    env: 'SEG_ASR_SAMPLE_EVERY',
    group: 'qa-gates',
    label: 'ASR sample rate',
    help: 'Transcribe 1-in-N sentences; 1 = every sentence.',
    type: 'integer',
    default: 1, // ← resolveAsrSampleEvery() default in tts/segment-asr-qa.ts
    apply: 'live', risk: 'low',
  },
  {
    key: 'qa.asr.maxWer',
    env: 'SEG_ASR_MAX_WER',
    group: 'qa-gates',
    label: 'ASR max WER',
    help: 'Word-error-rate above this threshold is flagged as content drift.',
    type: 'number', min: 0, max: 1, step: 0.05,
    default: 0.4, // ← DEFAULT_ASR_THRESHOLDS.maxWer in tts/segment-asr-qa.ts
    apply: 'live', risk: 'low',
  },
  {
    key: 'qa.asr.maxDeletionRun',
    env: 'SEG_ASR_MAX_DELETION_RUN',
    group: 'qa-gates',
    label: 'ASR max deletion run',
    help: 'Longest contiguous deletion run above this signals truncation/drop drift.',
    type: 'integer',
    default: 4, // ← DEFAULT_ASR_THRESHOLDS.maxDeletionRun in tts/segment-asr-qa.ts
    apply: 'live', risk: 'low',
  },
  {
    key: 'qa.asr.minChars',
    env: 'SEG_ASR_MIN_CHARS',
    group: 'qa-gates',
    label: 'ASR min chars',
    help: 'Sentences shorter than this (trimmed chars) are not scored — too short for reliable WER.',
    type: 'integer',
    default: 12, // ← DEFAULT_ASR_THRESHOLDS.minChars in tts/segment-asr-qa.ts
    apply: 'live', risk: 'low',
  },
  {
    key: 'qa.asr.maxCompression',
    env: 'SEG_ASR_MAX_COMPRESSION',
    group: 'qa-gates',
    label: 'ASR max compression ratio',
    help: "Whisper compression_ratio above this indicates a loop/repeat hallucination regardless of WER.",
    type: 'number', min: 1, max: 10, step: 0.1,
    default: 2.4, // ← DEFAULT_ASR_THRESHOLDS.maxCompressionRatio in tts/segment-asr-qa.ts
    apply: 'live', risk: 'low',
  },
  {
    key: 'qa.asr.minAvgLogprob',
    env: 'SEG_ASR_MIN_AVG_LOGPROB',
    group: 'qa-gates',
    label: 'ASR min avg log-prob',
    help: 'Whisper avg_logprob below this makes the transcript untrustworthy (inconclusive, not a re-record).',
    type: 'number', min: -5, max: 0, step: 0.1,
    default: -1.0, // ← DEFAULT_ASR_THRESHOLDS.minAvgLogprob in tts/segment-asr-qa.ts
    apply: 'live', risk: 'low',
  },
  {
    key: 'qa.asr.maxNoSpeech',
    env: 'SEG_ASR_MAX_NO_SPEECH',
    group: 'qa-gates',
    label: 'ASR max no-speech prob',
    help: 'Whisper no_speech_prob above this makes the transcript untrustworthy (inconclusive).',
    type: 'number', min: 0, max: 1, step: 0.05,
    default: 0.6, // ← DEFAULT_ASR_THRESHOLDS.maxNoSpeechProb in tts/segment-asr-qa.ts
    apply: 'live', risk: 'low',
  },

  // ── tts-batching ─────────────────────────────────────────────────────────
  {
    key: 'tts.batch.size',
    env: 'QWEN_BATCH_SIZE',
    group: 'tts-batching',
    label: 'Qwen batch size',
    help: 'Hard width cap: max sentences packed into one batched Qwen forward. Set to 1 to disable batching entirely (every Qwen sentence becomes its own call). Only affects Qwen — Coqui/Kokoro/Gemini always synth one-per-call.',
    type: 'integer', min: 1,
    default: 32, // ← QWEN_BATCH_SIZE default in tts/synthesise-chapter.ts (line 41)
    apply: 'restart-server', risk: 'medium', // read once at Node module-load (module-level constant), not sidecar
  },
  {
    key: 'tts.batch.tokenBudget',
    env: 'QWEN_BATCH_TOKEN_BUDGET',
    group: 'tts-batching',
    label: 'Qwen batch token budget',
    help: 'Variable-width packing budget (normalised chars): keep adding sentences to a batch while (count+1) × maxLen ≤ budget. Short/dialogue batches pack wider; long batches stay narrow. Set to 0 for exact fixed-width slicing (QWEN_BATCH_SIZE only, kill-switch).',
    type: 'integer', min: 0,
    default: 3600, // ← DEFAULT_QWEN_BATCH_TOKEN_BUDGET in tts/synthesise-chapter.ts (line 72)
    apply: 'restart-server', risk: 'medium', // read once at Node module-load (module-level constant), not sidecar
  },
  {
    key: 'tts.batch.bucket',
    env: 'QWEN_BATCH_BUCKET',
    group: 'tts-batching',
    label: 'Qwen batch length bucketing',
    help: 'Sort batchable Qwen groups by normalised text length before slicing into batches, so similar-length sentences share a batch (less padding waste). Output is byte-identical regardless of batch composition. Set to false to revert to index order.',
    type: 'boolean',
    default: true, // ← QWEN_BATCH_BUCKET default (env not '0'/'false') in tts/synthesise-chapter.ts (line 53-54)
    apply: 'restart-server', risk: 'medium', // read once at Node module-load (module-level constant), not sidecar
  },
  {
    key: 'tts.gen.workers',
    env: 'GEN_WORKERS',
    group: 'tts-batching',
    label: 'Generation workers',
    help: 'Number of chapters the generation queue synthesises concurrently. Queue/synthesis concurrency only — the GPU semaphore is the VRAM guard. Default 1: the Qwen forward is serialised, so a 2nd same-book worker just contends on the lock, doubles per-chapter RTF, and accelerates the host-memory leak toward a recycle. Raise only on a multi-GPU / non-Qwen setup.',
    type: 'integer', min: 1, max: 4,
    default: 1, // ← getResolvedGenerationWorkers() default in workspace/user-settings.ts
    apply: 'restart-server', risk: 'medium', // GEN_WORKERS is a Node-server knob, not sidecar — needs an app restart
  },

  // ── tts-engine ────────────────────────────────────────────────────────────
  {
    key: 'tts.accelerator',
    env: 'ACCELERATOR',
    group: 'tts-engine',
    label: 'Accelerator profile',
    help: 'Which GPU stack the voice engines install + run on. "auto" (default) detects your hardware (NVIDIA → CUDA, AMD → ROCm/DirectML, Apple → Metal, else CPU). Pin "nvidia", "amd", or "cpu" to override. Changing this is NOT instant: it REBUILDS the Python environment (a different torch / ONNX-runtime install) and restarts the sidecar — your books and voices are untouched. AMD (ROCm/DirectML) is an experimental preview.',
    type: 'enum', options: ['auto', 'nvidia', 'amd', 'cpu'],
    default: 'auto', // 'auto' → no ACCELERATOR env → resolveInstallProfile detects hardware
    apply: 'rebuild', risk: 'high',
  },
  {
    key: 'tts.coqui.device',
    env: 'COQUI_DEVICE',
    group: 'tts-engine',
    label: 'Coqui device',
    help: 'Device for Coqui XTTS v2. "auto" lets the sidecar pick based on CUDA availability. Changing this requires a sidecar restart.',
    type: 'enum', options: ['auto', 'cpu', 'cuda'],
    default: 'auto', // ← COQUI_DEVICE default in tts-sidecar/main.py (line 415)
    apply: 'restart-sidecar', risk: 'high',
  },
  {
    key: 'tts.qwen.device',
    env: 'QWEN_DEVICE',
    group: 'tts-engine',
    label: 'Qwen device',
    help: 'PyTorch device for Qwen3-TTS. "auto" (default) picks cuda:0 → mps (Apple Silicon) → cpu. Pin a specific GPU with "cuda:1", or force "cpu" / "mps". Changing this requires a sidecar restart.',
    type: 'string',
    default: 'auto', // ← QWEN_DEVICE resolver in tts-sidecar/main.py (_resolve_torch_device)
    apply: 'restart-sidecar', risk: 'high',
  },
  {
    key: 'tts.qwen.attnImpl',
    env: 'QWEN_ATTN_IMPL',
    group: 'tts-engine',
    label: 'Qwen attention impl',
    help: '"sdpa" is the PyTorch-native default and requires no extra deps. "flash_attention_2" needs the flash-attn wheel and benchmarks ≈ SDPA on the 4070 (TTS is decode-bound, not prefill-bound). Changing this requires a sidecar restart.',
    type: 'enum', options: ['sdpa', 'flash_attention_2'],
    default: 'sdpa', // ← QWEN_ATTN_IMPL default in tts-sidecar/main.py (line 1022)
    apply: 'restart-sidecar', risk: 'high',
  },
  {
    key: 'tts.preload.coqui',
    env: 'PRELOAD_COQUI',
    group: 'tts-engine',
    label: 'Preload Coqui at startup',
    help: 'When true, the sidecar eagerly loads Coqui XTTS v2 at startup (~30-60 s, ~3 GB VRAM). When false (default), Coqui loads on demand via the in-app Load button. Changing this requires a sidecar restart.',
    type: 'boolean',
    default: false, // ← PRELOAD_COQUI default in tts-sidecar/main.py (line 2289, "0")
    apply: 'restart-sidecar', risk: 'high',
  },
  {
    key: 'tts.preload.kokoro',
    env: 'PRELOAD_KOKORO',
    group: 'tts-engine',
    label: 'Preload Kokoro at startup',
    help: 'When true (default), the sidecar eagerly loads Kokoro v1 at startup (~1 s, ~1 GB VRAM). When false, Kokoro warms on demand on the first synth that needs it. Turn off if Qwen is your main engine and you want the ~1 GB VRAM back. Changing this requires a sidecar restart.',
    type: 'boolean',
    default: true, // ← PRELOAD_KOKORO default in tts-sidecar/main.py (line 2304, _parse_bool default=True)
    apply: 'restart-sidecar', risk: 'high',
  },
  {
    key: 'tts.preload.qwen',
    env: 'PRELOAD_QWEN',
    group: 'tts-engine',
    label: 'Preload Qwen at startup',
    help: 'When true, the sidecar eagerly loads the Qwen Base synth model (~1.2 GB VRAM) at startup. When false (default), Qwen warms on demand via the in-app Load button. Only the Base model is eagerly warmed — the VoiceDesign model stays transient. Changing this requires a sidecar restart.',
    type: 'boolean',
    default: false, // ← PRELOAD_QWEN default in tts-sidecar/main.py (line 2325, _parse_bool default=False)
    apply: 'restart-sidecar', risk: 'high',
  },

  // ── gpu-lifecycle ─────────────────────────────────────────────────────────
  {
    key: 'gpu.concurrency',
    env: 'GPU_CONCURRENCY',
    group: 'gpu-lifecycle',
    label: 'GPU concurrency',
    help: 'Max concurrent GPU ops (analyzer + all TTS engines combined) when GPU_VRAM_BUDGET is not set. When GPU_VRAM_BUDGET IS set, this becomes the fallback budget. Bump only after measuring VRAM headroom.',
    type: 'integer', min: 1,
    default: 1, // ← RAW_CONCURRENCY default in gpu/semaphore.ts (line 142, '1')
    apply: 'restart-server', risk: 'high', // GpuSemaphore singleton created at Node module-load; changing needs a server restart
  },
  {
    key: 'gpu.vramBudget',
    env: 'GPU_VRAM_BUDGET',
    group: 'gpu-lifecycle',
    label: 'GPU VRAM token budget',
    help: 'Total VRAM token budget for the weighted semaphore. Each GPU op costs tokens equal to its engine weight (kokoro 1, qwen 1, coqui 3, analyzer 4, asr 1). The semaphore admits combinations only when their summed cost fits this budget. Set to 0 (default) to disable the VRAM budget and fall back to GPU_CONCURRENCY. On an 8 GB box, 4 lets Kokoro+Qwen (1+1) run together while Coqui (3) or the analyzer (4) serialise.',
    type: 'integer', min: 0,
    default: 0, // ← GPU_VRAM_BUDGET unset by default (semaphore.ts falls back to GPU_CONCURRENCY); 0 = "disabled/fall back to GPU_CONCURRENCY"
    apply: 'restart-server', risk: 'high', // GpuSemaphore singleton created at Node module-load; changing needs a server restart
  },
  {
    key: 'gpu.weight.kokoro',
    env: 'GPU_WEIGHT_KOKORO',
    group: 'gpu-lifecycle',
    label: 'GPU weight: Kokoro',
    help: 'VRAM token cost for a Kokoro synthesis op. Lower values let Kokoro share the budget alongside other engines. Read live per-op via costForEngine(); changes take effect on the next synthesis without a restart.',
    type: 'integer', min: 0,
    default: 1, // ← ENGINE_VRAM_COST.kokoro in tts/engine-vram-cost.ts (line 16)
    apply: 'live', risk: 'high', // read per-op via costForEngine() in tts/engine-vram-cost.ts
  },
  {
    key: 'gpu.weight.qwen',
    env: 'GPU_WEIGHT_QWEN',
    group: 'gpu-lifecycle',
    label: 'GPU weight: Qwen',
    help: 'VRAM token cost for a Qwen synthesis op. Read live per-op via costForEngine(); changes take effect on the next synthesis without a restart.',
    type: 'integer', min: 0,
    default: 1, // ← ENGINE_VRAM_COST.qwen in tts/engine-vram-cost.ts (line 17)
    apply: 'live', risk: 'high', // read per-op via costForEngine() in tts/engine-vram-cost.ts
  },
  {
    key: 'gpu.weight.coqui',
    env: 'GPU_WEIGHT_COQUI',
    group: 'gpu-lifecycle',
    label: 'GPU weight: Coqui',
    help: 'VRAM token cost for a Coqui XTTS v2 synthesis op. Read live per-op via costForEngine(); changes take effect on the next synthesis without a restart.',
    type: 'integer', min: 0,
    default: 3, // ← ENGINE_VRAM_COST.coqui in tts/engine-vram-cost.ts (line 18)
    apply: 'live', risk: 'high', // read per-op via costForEngine() in tts/engine-vram-cost.ts
  },
  {
    key: 'gpu.weight.analyzer',
    env: 'GPU_WEIGHT_ANALYZER',
    group: 'gpu-lifecycle',
    label: 'GPU weight: Analyzer',
    help: 'VRAM token cost for an Ollama analyzer op. At the default budget of 4 the analyzer consumes the whole budget, serialising it against any TTS op. Read live per-op via costForEngine(); changes take effect on the next synthesis without a restart.',
    type: 'integer', min: 0,
    default: 4, // ← ENGINE_VRAM_COST.analyzer in tts/engine-vram-cost.ts (line 20)
    apply: 'live', risk: 'high', // read per-op via costForEngine() in tts/engine-vram-cost.ts
  },
  {
    key: 'gpu.weight.asr',
    env: 'GPU_WEIGHT_ASR',
    group: 'gpu-lifecycle',
    label: 'GPU weight: ASR (Whisper)',
    help: 'VRAM token cost for a Whisper ASR op. Only charged when ASR_DEVICE=cuda; the CPU-default path takes no token. Read live per-op via costForEngine(); changes take effect on the next transcription without a restart.',
    type: 'integer', min: 0,
    default: 1, // ← ENGINE_VRAM_COST.asr in tts/engine-vram-cost.ts (line 26)
    apply: 'live', risk: 'high', // read per-op via costForEngine() in tts/engine-vram-cost.ts
  },
  {
    key: 'sidecar.qwenDesignIdleTtl',
    env: 'QWEN_DESIGN_IDLE_TTL',
    group: 'gpu-lifecycle',
    label: 'Qwen VoiceDesign idle TTL (s)',
    help: 'Seconds of voice-design inactivity before the watchdog frees the transient Qwen VoiceDesign 1.7B model (reclaiming ~4–5 GB VRAM). Values below 5 fall back to the default (120) to avoid reload thrash. A real /synthesize also frees it immediately.',
    type: 'integer', min: 0,
    default: 120, // ← _DESIGN_IDLE_TTL_DEFAULT in tts-sidecar/main.py (line 1714)
    apply: 'restart-sidecar', risk: 'high',
  },
  {
    key: 'sidecar.asrIdleTtl',
    env: 'ASR_IDLE_TTL',
    group: 'gpu-lifecycle',
    label: 'ASR (Whisper) idle TTL (s)',
    help: 'Seconds of ASR inactivity before the sidecar frees the Whisper model. Mainly reclaims VRAM on ASR_DEVICE=cuda; on cpu it frees host RAM. Values below 5 fall back to the default (120) to avoid reload thrash.',
    type: 'integer', min: 0,
    default: 120, // ← _ASR_IDLE_TTL_DEFAULT in tts-sidecar/main.py (line 1775)
    apply: 'restart-sidecar', risk: 'high',
  },
  {
    key: 'sidecar.disableMkldnn',
    env: 'SIDECAR_DISABLE_MKLDNN',
    group: 'gpu-lifecycle',
    label: 'Disable torch MKLDNN',
    help: 'When true, sets torch.backends.mkldnn.enabled = False at model load to curb the variable-shape CPU host-RAM leak (pytorch#32596). CPU-only flag — a no-op if the leak is on the CUDA allocator side. Default off (opt-in until a live A/B proves the committed slope flattens).',
    type: 'boolean',
    default: false, // ← _disable_mkldnn() default in tts-sidecar/main.py (line 1882, returns raw in {"1","true","yes","on"} → default false)
    apply: 'restart-sidecar', risk: 'high',
  },
  {
    key: 'sidecar.recycleSoftMb',
    env: 'SIDECAR_RECYCLE_SOFT_MB',
    group: 'gpu-lifecycle',
    label: 'Soft recycle threshold (MB committed RAM)',
    help: 'Committed-private RAM (MB) at which the sidecar sets recycle_pending in /health, triggering a clean chapter-boundary recycle rather than a mid-chapter hard exit. 0 = disabled (default). Set a few GB below SIDECAR_RESTART_MB.',
    type: 'integer', min: 0,
    default: 0, // ← _mem_recycle_soft_threshold_mb() default in tts-sidecar/main.py (line 2009, "0")
    apply: 'restart-sidecar', risk: 'high',
  },
  {
    key: 'sidecar.restartMb',
    env: 'SIDECAR_RESTART_MB',
    group: 'gpu-lifecycle',
    label: 'Hard restart threshold (MB committed RAM)',
    help: 'Committed-private RAM (MB) at which the sidecar self-exits so the supervisor respawns a fresh process (process recycling). 0 = auto (default): uses 70% of total physical RAM when psutil can read it, or disabled when it cannot. Override with an absolute MB value.',
    type: 'integer', min: 0,
    default: 0, // ← _mem_restart_threshold_mb() default in tts-sidecar/main.py (line 1985–1996, env unset → auto-calculated; 0 = "auto/unset" sentinel)
    apply: 'restart-sidecar', risk: 'high',
  },
  {
    key: 'sidecar.vramRecycleSoftMb',
    env: 'SIDECAR_VRAM_RECYCLE_SOFT_MB',
    group: 'gpu-lifecycle',
    label: 'Soft VRAM recycle threshold (MB reserved)',
    help: 'Reserved VRAM (MB) at which the sidecar sets recycle_pending in /health. 0 = auto (default): uses 90% of device total VRAM when readable. Override with an absolute MB value to tune for your card.',
    type: 'integer', min: 0,
    default: 0, // ← _vram_recycle_soft_threshold_mb() default in tts-sidecar/main.py (line 1949–1957, env unset → _VRAM_SOFT_FRACTION×total; 0 = "auto/unset" sentinel)
    apply: 'restart-sidecar', risk: 'high',
  },
  {
    key: 'sidecar.vramRestartMb',
    env: 'SIDECAR_VRAM_RESTART_MB',
    group: 'gpu-lifecycle',
    label: 'Hard VRAM restart threshold (MB reserved)',
    help: 'Reserved VRAM (MB) at which the sidecar self-exits so the supervisor respawns a fresh CUDA context (the only thing that resets a spilled/fragmented VRAM pool). 0 = auto (default): uses 98% of device total VRAM when readable. Override with an absolute MB value.',
    type: 'integer', min: 0,
    default: 0, // ← _vram_restart_threshold_mb() default in tts-sidecar/main.py (line 1966–1974, env unset → _VRAM_HARD_FRACTION×total; 0 = "auto/unset" sentinel)
    apply: 'restart-sidecar', risk: 'high',
  },

  // ── analyzer-sampling (additions) ─────────────────────────────────────────
  {
    key: 'analyzer.ollama.numCtx',
    env: 'ANALYZER_NUM_CTX',
    group: 'analyzer-sampling',
    label: 'Ollama num_ctx',
    help: 'Context-window size handed to Ollama on every /api/chat call. Ollama keys the KV cache by (model, num_ctx), so warming with default 32768 and then changing it forces a re-load. Larger = more KV-cache VRAM; 32768 gives large/non-Latin chapters headroom (the stage-1/2 chunkers handle anything still over budget). Lower it if a bigger analyzer model strains the GPU.',
    type: 'integer', min: 0,
    default: 32768, // ← ANALYZER_NUM_CTX constant in analyzer/ollama.ts
    apply: 'live', risk: 'medium',
  },
  {
    key: 'analyzer.ollama.numGpu',
    env: 'ANALYZER_NUM_GPU',
    group: 'analyzer-sampling',
    label: 'Ollama num_gpu',
    help: 'Number of GPU layers for Ollama (999 = all layers). Ollama treats this as part of its load-time cache key alongside num_ctx, so mismatching values between /load and /api/chat can force redundant model swaps. Hardcoded today; registering this env name lifts it to a runtime knob.',
    type: 'integer', min: 0,
    default: 999, // ← ANALYZER_NUM_GPU constant in analyzer/ollama.ts (line 150)
    apply: 'live', risk: 'medium',
  },

  // ── rate-limits ───────────────────────────────────────────────────────────
  {
    key: 'rate.rpm.gemma',
    env: 'GEMINI_RPM_GEMMA_4_31B_IT',
    group: 'rate-limits',
    label: 'Gemma 4 31B RPM',
    help: 'Requests-per-minute cap for gemma-4-31b-it. Override to adjust the free-tier limit (default 15 RPM from AI Studio 2026-05-16). The limiter waits proactively so no 429s are issued.',
    type: 'integer', min: 1,
    default: 15, // ← BUILTIN_LIMITS['gemma-4-31b-it'].rpm in analyzer/rate-limit.ts (line 41)
    apply: 'restart-server', risk: 'low',
  },
  {
    key: 'rate.tpm.gemma',
    env: 'GEMINI_TPM_GEMMA_4_31B_IT',
    group: 'rate-limits',
    label: 'Gemma 4 31B TPM',
    help: 'Input-tokens-per-minute cap for gemma-4-31b-it. Set to 0 here to represent the free-tier "Unlimited" TPM — the limiter treats 0 as Infinity (no TPM gate). Override with a positive number to impose a local cap.',
    type: 'integer', min: 0,
    default: 0, // ← BUILTIN_LIMITS['gemma-4-31b-it'].tpm = Infinity in analyzer/rate-limit.ts (line 41); 0 = "unlimited" sentinel
    apply: 'restart-server', risk: 'low',
  },
  {
    key: 'rate.rpd.gemma',
    env: 'GEMINI_RPD_GEMMA_4_31B_IT',
    group: 'rate-limits',
    label: 'Gemma 4 31B RPD',
    help: 'Requests-per-day cap for gemma-4-31b-it. Default 1500 (free-tier from AI Studio 2026-05-16). The limiter raises DailyQuotaExhaustedError rather than firing a 429.',
    type: 'integer', min: 1,
    default: 1500, // ← BUILTIN_LIMITS['gemma-4-31b-it'].rpd in analyzer/rate-limit.ts (line 41)
    apply: 'restart-server', risk: 'low',
  },

  // ── audio-loudness ────────────────────────────────────────────────────────
  {
    key: 'audio.loudnorm.enabled',
    env: 'AUDIO_LOUDNORM_ENABLED',
    group: 'audio-loudness',
    label: 'Loudnorm enabled',
    help: 'Enable EBU R128 two-pass loudness normalisation; disable to skip normalisation entirely.',
    type: 'boolean',
    default: true, // ← finalize-chapter-write.ts: enabled unless env === 'false'
    apply: 'live', risk: 'low',
  },
  {
    key: 'audio.loudnorm.targetLufs',
    env: 'AUDIO_LOUDNORM_TARGET',
    group: 'audio-loudness',
    label: 'Target LUFS',
    help: 'Integrated loudness target in LUFS; -16 matches the Audible/ACX audiobook spec.',
    type: 'number',
    default: -16, // ← DEFAULT_LOUDNORM_OPTIONS.target in tts/loudnorm.ts
    apply: 'live', risk: 'low',
  },
  {
    key: 'audio.loudnorm.lra',
    env: 'AUDIO_LOUDNORM_LRA',
    group: 'audio-loudness',
    label: 'Loudness range (LRA)',
    help: 'Target loudness range in LU; 11 is the audiobook community standard.',
    type: 'number',
    default: 11, // ← DEFAULT_LOUDNORM_OPTIONS.lra in tts/loudnorm.ts
    apply: 'live', risk: 'low',
  },
  {
    key: 'audio.loudnorm.truePeak',
    env: 'AUDIO_LOUDNORM_TP',
    group: 'audio-loudness',
    label: 'True-peak ceiling (dBTP)',
    help: 'True-peak ceiling; -1.5 leaves headroom for codec inter-sample peaks.',
    type: 'number',
    default: -1.5, // ← DEFAULT_LOUDNORM_OPTIONS.tp in tts/loudnorm.ts
    apply: 'live', risk: 'low',
  },

  // ── analyzer-models ───────────────────────────────────────────────────────
  {
    key: 'analyzer.engine',
    env: 'ANALYZER',
    group: 'analyzer-models',
    label: 'Analyzer engine',
    help: '"local" routes through the Ollama daemon (auto-falls back to Gemini when Ollama is unreachable and GEMINI_API_KEY is set). "gemini" always goes direct to the Gemini API.',
    type: 'enum', options: ['local', 'gemini'],
    default: 'local', // ← ANALYZER default in server/.env.example (line 14)
    apply: 'live', risk: 'medium',
  },
  {
    key: 'analyzer.ollama.url',
    env: 'OLLAMA_URL',
    group: 'analyzer-models',
    label: 'Ollama URL',
    help: 'Base URL of the local Ollama daemon.',
    type: 'string',
    default: 'http://localhost:11434', // ← OLLAMA_URL default in server/.env.example (line 22)
    apply: 'live', risk: 'medium',
  },
  {
    key: 'analyzer.ollama.model',
    env: 'OLLAMA_MODEL',
    group: 'analyzer-models',
    label: 'Ollama model',
    help: 'Ollama model tag passed to /api/chat as the last-resort fallback. The Account-tab model picker takes precedence when it has Ollama tag shape (contains ":")',
    type: 'string',
    default: 'qwen3.5:4b', // ← OLLAMA_MODEL default in server/.env.example (line 23) + DEFAULT_OLLAMA_MODEL in user-settings.ts
    apply: 'live', risk: 'medium',
  },
  {
    key: 'analyzer.gemini.model',
    env: 'GEMINI_MODEL',
    group: 'analyzer-models',
    label: 'Gemini analyzer model',
    help: 'Gemini model used directly (ANALYZER=gemini) or as the Ollama-unreachable fallback (ANALYZER=local). Separate free-tier bucket from gemini-* models; lower daily-hit risk for per-chapter stage-2 analysis.',
    type: 'string',
    default: 'gemma-4-31b-it', // ← GEMINI_MODEL default in server/.env.example (line 40)
    apply: 'live', risk: 'medium',
  },
  {
    key: 'analyzer.gemini.voiceStyleModel',
    env: 'VOICE_STYLE_MODEL',
    group: 'analyzer-models',
    label: 'Voice-style model',
    help: 'Gemini model used to design each cast member\'s natural-language voice persona (one call per character). Pinned to gemini-3.1-flash-lite (its own free-tier RPD bucket). Routes through the same per-model rate limiter as the main analyzer.',
    type: 'string',
    default: 'gemini-3.1-flash-lite', // ← VOICE_STYLE_MODEL default in server/.env.example (line 47, commented default)
    apply: 'live', risk: 'medium',
  },
  {
    key: 'analyzer.phase0.model',
    env: 'ANALYZER_PHASE0_MODEL',
    group: 'analyzer-models',
    label: 'Phase-0 model override',
    help: 'When set, drives Phase 0 (cast detection) with this specific model while Phase 1 uses ANALYZER_PHASE1_MODEL. Leave empty to use the legacy single-model ANALYZER path for both phases. The two analyzers hit independent rate-limit buckets, so quota is effectively doubled.',
    type: 'string',
    default: '', // ← ANALYZER_PHASE0_MODEL unset by default in server/.env.example (line 60)
    apply: 'live', risk: 'medium',
  },
  {
    key: 'analyzer.phase1.model',
    env: 'ANALYZER_PHASE1_MODEL',
    group: 'analyzer-models',
    label: 'Phase-1 model override',
    help: 'When set, drives Phase 1 (sentence attribution) with this specific model while Phase 0 uses ANALYZER_PHASE0_MODEL. Leave empty to use the legacy single-model ANALYZER path.',
    type: 'string',
    default: '', // ← ANALYZER_PHASE1_MODEL unset by default in server/.env.example (line 61)
    apply: 'live', risk: 'medium',
  },
  {
    key: 'analyzer.phase1.minLagChapters',
    env: 'ANALYZER_PHASE1_MIN_LAG_CHAPTERS',
    group: 'analyzer-models',
    label: 'Phase-1 minimum lag (chapters)',
    help: 'Minimum number of Phase-0 chapters that must complete ahead of any Phase-1 dispatch. Ensures the roster is populated before attribution starts. Set to 0 to release the lag entirely. Only active when the per-phase model split is configured.',
    type: 'integer', min: 0,
    default: 10, // ← DEFAULT_PHASE1_MIN_LAG_CHAPTERS in analyzer/select-analyzer.ts (line 111)
    apply: 'live', risk: 'medium',
  },

  // ── analyzer-prompts ──────────────────────────────────────────────────────
  {
    key: 'prompt.castDetection',
    env: '',
    group: 'analyzer-prompts',
    label: 'Cast detection prompt',
    help: 'The skill file sent to the analysis model for Phase-0 cast detection. Editing forks a local copy at the path below; the server reads the file on every analysis call so changes take effect without a restart.',
    type: 'string', isPrompt: true,
    default: 'skills/audiobook-character-detection-per-chapter.md', // ← confirmed exists at skills/audiobook-character-detection-per-chapter.md
    apply: 'live', risk: 'high',
  },
  {
    key: 'prompt.sentenceAttribution',
    env: '',
    group: 'analyzer-prompts',
    label: 'Sentence attribution prompt',
    help: 'The skill file sent to the analysis model for Phase-1 sentence attribution. Editing forks a local copy; changes take effect without a restart.',
    type: 'string', isPrompt: true,
    default: 'skills/audiobook-sentence-attribution.md', // ← confirmed exists at skills/audiobook-sentence-attribution.md
    apply: 'live', risk: 'high',
  },
  {
    key: 'prompt.emotionAnnotation',
    env: '',
    group: 'analyzer-prompts',
    label: 'Emotion annotation prompt',
    help: 'The skill file sent to the analysis model for per-quote emotion annotation. Editing forks a local copy; changes take effect without a restart.',
    type: 'string', isPrompt: true,
    default: 'skills/audiobook-emotion-annotation.md', // ← confirmed exists at skills/audiobook-emotion-annotation.md
    apply: 'live', risk: 'high',
  },
  {
    key: 'prompt.voiceStyle',
    env: '',
    group: 'analyzer-prompts',
    label: 'Voice-style prompt',
    help: 'The skill file sent to the model for voice-persona generation (one call per cast member). Editing forks a local copy; revert restores the shipped prompt.',
    type: 'string', isPrompt: true,
    default: 'skills/audiobook-voice-style.md', // ← shipped skill file (extracted from voice-style.ts)
    apply: 'live', risk: 'high',
  },
];

export function allKnobs(): ConfigKnob[] {
  return KNOBS;
}
export function getKnob(key: string): ConfigKnob | undefined {
  return KNOBS.find((k) => k.key === key);
}
export function knobByEnv(env: string): ConfigKnob | undefined {
  return KNOBS.find((k) => k.env === env);
}
export function knobsInGroup(groupId: string): ConfigKnob[] {
  return KNOBS.filter((k) => k.group === groupId);
}
