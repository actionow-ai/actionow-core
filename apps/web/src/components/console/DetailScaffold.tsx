import { ArrowLeftIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { ErrorState } from '../data/ErrorState';
import { RoseLoader } from '../ui/RoseLoader';

/**
 * The shared scaffold for the routed console detail pages
 * (`TenantDetailPage` / `ApiKeyDetailPage` / `ServiceTokenDetailPage`). These
 * pages resolve their entity from a list query by `:id` and then render the same
 * chrome: a centered loader while the list loads, an `ErrorState` on failure, a
 * not-found panel when the id misses, and — once resolved — an in-page back link
 * + title above the body. Each page still owns its `useSetConsoleBack` (the
 * TopBar back slot) and its data resolution; this module only removes the
 * verbatim-duplicated presentation.
 */

/** The page's top-of-content back link (mirrors the TopBar back slot for an in-page affordance). */
export function DetailBackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--s-1)',
        fontSize: 'var(--fs-sm)',
        color: 'var(--muted)',
        textDecoration: 'none',
        width: 'fit-content',
      }}
    >
      <ArrowLeftIcon size={14} weight="bold" aria-hidden="true" />
      {label}
    </Link>
  );
}

/** One label / value row in a detail header. */
export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-1)' }}>
      <span
        style={{
          fontSize: 'var(--fs-caption)',
          textTransform: 'uppercase',
          letterSpacing: '.06em',
          color: 'var(--faint)',
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 'var(--fs-sm)' }}>{children}</span>
    </div>
  );
}

/** The "no such entity" panel shown when an `:id` resolves to nothing. */
function NotFound({ message }: { message: string }) {
  return (
    <div
      className="panel"
      style={{
        borderRadius: 'var(--r-md)',
        padding: 'var(--s-5)',
        color: 'var(--muted)',
        fontSize: 'var(--fs-sm)',
        textAlign: 'center',
      }}
    >
      {message}
    </div>
  );
}

/**
 * Drives a detail page's load/error/not-found/resolved states with the back-link
 * chrome shared by all three pages. Pass the resolving query's `loading` /
 * `error` flags and a `notFound` flag (true once loading settles and the id
 * misses); when all are false the `children` (the resolved body — starting with
 * the page's own `<h1>`) render under the back link inside the standard
 * column layout. The not-found branch shows the back link so the user can escape.
 * The heading itself stays in each page (the three differ: size / monospace /
 * word-break), so it is passed as the first child rather than a prop — keeping
 * each page's markup byte-for-byte identical to before.
 */
export function DetailPage({
  backTo,
  backLabel,
  loading = false,
  error = false,
  onRetry,
  notFound = false,
  notFoundMessage,
  children,
}: {
  backTo: string;
  backLabel: string;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  notFound?: boolean;
  notFoundMessage: string;
  children?: ReactNode;
}) {
  if (loading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', padding: 'var(--s-6)' }}>
        <RoseLoader size={56} />
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: 'var(--s-5)' }}>
        <ErrorState onRetry={onRetry} />
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
      <DetailBackLink to={backTo} label={backLabel} />
      <div style={{ maxWidth: 'var(--content-detail)', width: '100%' }}>
        {notFound ? <NotFound message={notFoundMessage} /> : children}
      </div>
    </div>
  );
}
