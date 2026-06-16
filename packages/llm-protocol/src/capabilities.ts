/** What a resolved model can do; drives the normalization gate. */
export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  audio: boolean;
  json: boolean;
}

/** Read a capabilities bag from a model's `capabilities` jsonb (booleans only). */
export function readCapabilities(raw: Record<string, unknown>): ModelCapabilities {
  const flag = (k: string): boolean => raw[k] === true;
  return {
    tools: flag('tools'),
    vision: flag('vision'),
    audio: flag('audio'),
    json: flag('json'),
  };
}
