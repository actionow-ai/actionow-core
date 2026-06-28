/**
 * A form-level error summary for longer forms/drawers: an assertive live region
 * (`role="alert"`) listing the current validation errors, so a screen reader
 * announces them on a failed submit — on top of the per-field inline errors. It
 * renders nothing when there are no errors. Pair it with focusing the first
 * invalid control so keyboard users land on the field to fix.
 */
export function FormErrorSummary({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--s-1)',
        padding: 'var(--s-3)',
        borderRadius: 'var(--r-sm)',
        background: 'color-mix(in srgb, var(--fail) 12%, transparent)',
        border: '1px solid color-mix(in srgb, var(--fail) 40%, transparent)',
        color: 'var(--fail)',
        fontSize: 'var(--fs-caption)',
      }}
    >
      {errors.map((e) => (
        <span key={e}>{e}</span>
      ))}
    </div>
  );
}
