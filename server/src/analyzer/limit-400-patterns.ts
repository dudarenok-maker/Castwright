/* #3084 P7 / P24 — provider messages that name a context, token or length limit.
   A 400 carrying one is about the request's SIZE: the taxonomy points it at the
   endpoint's max-output field (P24), and the Test action treats it as
   inconclusive rather than `rejected` (P7). Each `example` is a provider message
   quoted in the cited source; the test replays every row. Add a row only with a
   quoted message and its source. */
export const LIMIT_400_PATTERNS: ReadonlyArray<{ provider: string; pattern: RegExp; example: string; source: string }> = [
  {
    provider: 'llama.cpp server (message)',
    pattern: /exceeds the available context size/i,
    example: 'request (33056 tokens) exceeds the available context size (32768 tokens), try increasing it',
    source: 'llama-server 400 body quoted in https://github.com/NousResearch/hermes-agent/issues/89502',
  },
  {
    provider: 'llama.cpp server (error type)',
    pattern: /\bexceed_context_size_error\b/,
    example:
      '{"error":{"code":400,"message":"request (33056 tokens) exceeds the available context size (32768 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":33056,"n_ctx":32768}}',
    source: 'https://github.com/NousResearch/hermes-agent/issues/89502',
  },
  {
    provider: 'vLLM (vllm/renderers/params.py:418 _token_len_check)',
    pattern: /maximum context length is \d+ tokens/i,
    example:
      "This model's maximum context length is 128000 tokens. However, you requested 65535 output tokens and your prompt contains at least 62466 input tokens, for a total of at least 128001 tokens.",
    source: 'https://github.com/vllm-project/vllm/issues/42474',
  },
  {
    provider: 'vLLM (older releases)',
    pattern: /maximum context length is \d+ tokens/i,
    example:
      "This model's maximum context length is 16384 tokens. However, you requested 122946 tokens (112946 in the messages, 10000 in the completion). Please reduce the length of the messages or completion.",
    source: 'https://github.com/vllm-project/vllm/issues/20409',
  },
  {
    provider: 'OpenAI (context, error code)',
    pattern: /\bcontext_length_exceeded\b/,
    example:
      '{"error":{"message":"This model\'s maximum context length is 16385 tokens. However, your messages resulted in 44366 tokens","code":"context_length_exceeded"}}',
    source: 'message and code as reported in https://community.openai.com/t/gpt-4o-context-length-issue-input-tokens-within-limit-but-exceeds-maximum/1109543',
  },
  {
    provider: 'OpenAI (output cap)',
    pattern: /\bmax_(?:completion_)?tokens? is too large\b/i,
    example: 'max_token is too large: 32768. This model supports at most 4096 completion tokens.',
    source: 'https://community.zapier.com/troubleshooting-99/chatgpt-error-400-max-token-is-too-large-32768-this-model-supports-at-most-4096-completion-tokens-39804',
  },
  {
    provider: 'Gemini API (input)',
    pattern: /input token count \(\d+\) exceeds the maximum number of tokens allowed/i,
    example: 'The input token count (1236488) exceeds the maximum number of tokens allowed for this model. Please reduce the input token count or use a model with a larger context window.',
    source: 'https://github.com/google-gemini/gemini-cli/issues/12493',
  },
  {
    provider: 'Gemini API (output cap)',
    pattern: /has a maxOutputTokens value of \d+/i,
    example: 'Unable to submit request because it has a maxOutputTokens value of 828858',
    source: 'https://discuss.ai.google.dev/t/unable-to-submit-request-because-it-has-a-maxoutputtokens-value-of-828858/101543',
  },
];

export function namesContextOrTokenLimit(text: string): boolean {
  return LIMIT_400_PATTERNS.some((row) => row.pattern.test(text));
}
