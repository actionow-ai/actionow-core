import { siAnthropic, siCloudflare, siGooglegemini } from 'simple-icons';

interface Brand {
  title: string;
  path: string;
}

/** Brands present in Simple Icons → real logos in currentColor (theme-adaptive). */
const BRANDS: Brand[] = [siAnthropic, siGooglegemini, siCloudflare];

/** Brands without a Simple Icon (trademark-removed or none) → a clean monogram. */
const MONOGRAMS = [
  { letter: 'O', name: 'OpenAI' },
  { letter: 'D', name: 'Dify' },
];

function Item({ children, name }: { children: React.ReactNode; name: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, fontSize: 14, fontWeight: 500 }}>
      {children}
      {name}
    </span>
  );
}

export function ProviderLogos() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--s-8)', color: 'var(--muted)', opacity: 0.9 }}>
      {MONOGRAMS.slice(0, 1).map((m) => (
        <Item key={m.name} name={m.name}>
          <Monogram letter={m.letter} />
        </Item>
      ))}
      {BRANDS.map((b) => (
        <Item key={b.title} name={b.title}>
          <svg role="img" viewBox="0 0 24 24" width={22} height={22} fill="currentColor" aria-label={b.title} style={{ flexShrink: 0 }}>
            <title>{b.title}</title>
            <path d={b.path} />
          </svg>
        </Item>
      ))}
      {MONOGRAMS.slice(1).map((m) => (
        <Item key={m.name} name={m.name}>
          <Monogram letter={m.letter} />
        </Item>
      ))}
    </div>
  );
}

function Monogram({ letter }: { letter: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 22,
        height: 22,
        borderRadius: 6,
        border: '1.5px solid currentColor',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {letter}
    </span>
  );
}
