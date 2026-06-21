import { Pill, type PillTone } from '../ui/Pill';

export type Tone = PillTone;

const STATUS_TONE: Record<string, Tone> = {
  succeeded: 'ok',
  active: 'ok',
  ready: 'ok',
  running: 'run',
  queued: 'wait',
  pending: 'wait',
  failed: 'fail',
  disabled: 'fail',
  inactive: 'fail',
  canceled: 'idle',
};

/** Map a backend status string to a palette tone. Unknown statuses fall back to `idle`. */
export function statusTone(status: string): Tone {
  return STATUS_TONE[status] ?? 'idle';
}

/**
 * A status pill: a leading tone dot + a `label` already translated by the page
 * (`t('status.'+s, s)`) — it no longer renders raw English enums. Composes the
 * shared `Pill` primitive (the design's dotted `.pill`).
 */
export function StatusBadge({ tone, label }: { tone: Tone; label: string }) {
  return (
    <Pill tone={tone} dot>
      {label}
    </Pill>
  );
}
