/** What a resolved model can do; drives the normalization gate. */
export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  audio: boolean;
  json: boolean;
  /** File/document input (e.g. PDFs). Optional for back-compat; absent → false. */
  file?: boolean;
  /**
   * Reasoning/thinking model (o-series, GPT-5.x, Opus 4.7/4.8, etc.). Optional for
   * back-compat; absent → false. When true, {@link normalizeRequest} DOWNGRADES
   * (drops) the sampling params these models reject (temperature/top_p/penalties/
   * logprobs/stop) instead of forwarding them and provoking an upstream 400.
   */
  reasoning?: boolean;
}

/** Read a capabilities bag from a model's `capabilities` jsonb (booleans only). */
export function readCapabilities(raw: Record<string, unknown>): ModelCapabilities {
  const flag = (k: string): boolean => raw[k] === true;
  return {
    tools: flag('tools'),
    vision: flag('vision'),
    audio: flag('audio'),
    json: flag('json'),
    file: flag('file'),
    reasoning: flag('reasoning'),
  };
}
