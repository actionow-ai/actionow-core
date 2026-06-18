import { Button } from './Button';
import { Modal } from './Modal';

/**
 * A destructive-action confirmation built on `Modal` (so it inherits the focus
 * trap + Escape-to-close + exit animation). The footer is `[Cancel, Confirm]`;
 * `danger` styles the confirm button with the `danger` variant and `loading`
 * disables it + shows the spinner while the action is in flight.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger,
  loading,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger === true ? 'danger' : 'cta'}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div
        style={{
          fontSize: 'var(--fs-sm)',
          color: 'var(--text)',
          lineHeight: 1.6,
          background: 'var(--demo-bg)',
          border: '1px solid var(--demo-bd)',
          borderRadius: 'var(--r-sm)',
          padding: 'var(--s-4)',
        }}
      >
        {message}
      </div>
    </Modal>
  );
}
