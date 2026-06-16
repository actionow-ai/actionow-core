export function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="glass" style={{ padding: 'var(--s-5)', borderRadius: 'var(--r-md)' }}>
      <div style={{ fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)' }}>{label}</div>
      <div className="tabular" style={{ fontSize: 26, fontWeight: 700, marginTop: 8, letterSpacing: '-.02em' }}>
        {value}
      </div>
    </div>
  );
}
