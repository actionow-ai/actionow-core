import { CopyButton } from '../../../components/ui/CopyButton';

/**
 * Minimal assistant-content renderer (v1): splits triple-backtick fenced code
 * blocks out as monospace `<pre>` blocks (with a copy affordance) and renders the
 * prose between them with whitespace preserved. Full markdown (lists, bold,
 * inline code, links) is a deferred enhancement — no markdown dependency ships in
 * the browser bundle for v1.
 */
export function ChatContent({ text }: { text: string }) {
  const segments = splitFences(text);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
      {segments.map((seg, i) =>
        seg.kind === 'code' ? (
          <CodeBlock key={i} lang={seg.lang} code={seg.body} />
        ) : (
          <p
            key={i}
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              lineHeight: 1.6,
              color: 'var(--text)',
            }}
          >
            {seg.body}
          </p>
        ),
      )}
    </div>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  return (
    <div
      style={{
        border: '1px solid var(--panel-bd)',
        borderRadius: 'var(--r-md)',
        overflow: 'hidden',
        background: 'var(--glass-bg)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'var(--s-1) var(--s-2)',
          borderBottom: '1px solid var(--hairline)',
        }}
      >
        <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--faint)' }}>
          {lang || 'code'}
        </span>
        <CopyButton value={code} />
      </div>
      <pre
        className="mono"
        style={{
          margin: 0,
          padding: 'var(--s-2)',
          fontSize: 'var(--fs-sm)',
          overflowX: 'auto',
          whiteSpace: 'pre',
          color: 'var(--text)',
        }}
      >
        {code}
      </pre>
    </div>
  );
}

interface Segment {
  kind: 'text' | 'code';
  body: string;
  lang: string;
}

/** Split text into alternating prose + fenced-code segments. Tolerates an unclosed fence. */
function splitFences(text: string): Segment[] {
  const out: Segment[] = [];
  const fence = /```([^\n]*)\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    if (m.index > last) {
      const body = text.slice(last, m.index);
      if (body.trim() !== '')
        out.push({ kind: 'text', body: body.replace(/^\n+|\n+$/g, ''), lang: '' });
    }
    out.push({ kind: 'code', body: m[2] ?? '', lang: (m[1] ?? '').trim() });
    last = fence.lastIndex;
  }
  if (last < text.length) {
    const body = text.slice(last);
    if (body.trim() !== '') out.push({ kind: 'text', body, lang: '' });
  }
  // An all-empty input still renders one (empty) prose segment so the bubble has height.
  return out.length > 0 ? out : [{ kind: 'text', body: text, lang: '' }];
}
