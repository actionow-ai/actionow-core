import { describe, expect, it } from 'vitest';

import { httpTone, prettyBody } from './TraceViewer';

describe('TraceViewer httpTone', () => {
  it('maps an HTTP status to a pill tone by class', () => {
    expect(httpTone(200)).toBe('ok');
    expect(httpTone(204)).toBe('ok');
    expect(httpTone(404)).toBe('wait'); // 4xx = client error → caution
    expect(httpTone(500)).toBe('fail'); // 5xx = upstream failure
    expect(httpTone(null)).toBe('idle'); // no response captured
  });
});

describe('TraceViewer prettyBody', () => {
  it('pretty-prints valid JSON', () => {
    expect(prettyBody('{"a":1,"b":[2]}')).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
  });
  it('passes non-JSON through unchanged and maps empty/null to an empty string', () => {
    expect(prettyBody('plain text')).toBe('plain text');
    expect(prettyBody('')).toBe('');
    expect(prettyBody(null)).toBe('');
  });
});
