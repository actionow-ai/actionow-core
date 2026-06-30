import { CopyField } from '../data/CopyField';
import { Button } from './Button';
import { Modal } from './Modal';

/** One-time "copy your new secret now" modal — wraps Modal + a caution line + CopyField.
 *  `value` may be an array (joined with newlines, e.g. redemption codes). */
export function SecretRevealModal({
  open,
  title,
  onClose,
  value,
  warn,
  copyLabel,
  copiedLabel,
  failedLabel,
  doneLabel,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  value: string | string[];
  warn: string;
  copyLabel: string;
  copiedLabel: string;
  failedLabel?: string;
  doneLabel: string;
}) {
  const text = Array.isArray(value) ? value.join('\n') : value;
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <Button variant="cta" onClick={onClose}>
          {doneLabel}
        </Button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <span style={{ color: 'var(--warn)', fontSize: 'var(--fs-sm)' }}>{warn}</span>
        <CopyField
          value={text}
          copyLabel={copyLabel}
          copiedLabel={copiedLabel}
          failedLabel={failedLabel}
        />
      </div>
    </Modal>
  );
}
