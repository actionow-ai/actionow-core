import { render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, test } from 'vitest';

import { Floating } from './Floating';

function Harness({ open, keepMounted }: { open: boolean; keepMounted?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref}>anchor</button>
      <Floating open={open} triggerRef={ref} keepMounted={keepMounted} role="tooltip" id="tip">
        floating content
      </Floating>
    </>
  );
}

describe('Floating', () => {
  test('renders nothing when closed (and not keepMounted)', () => {
    render(<Harness open={false} />);
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
  });

  test('portals its content directly to the document body when open', () => {
    render(<Harness open />);
    const node = screen.getByRole('tooltip');
    expect(node).toHaveTextContent('floating content');
    // Portaled to <body> — this is what lets it escape an overflow:hidden ancestor.
    expect(node.parentElement).toBe(document.body);
    expect(node).toHaveStyle({ position: 'fixed' });
  });

  test('keepMounted keeps the node in the DOM (hidden) while closed for aria links', () => {
    render(<Harness open={false} keepMounted />);
    const node = screen.getByRole('tooltip', { hidden: true });
    expect(node).toHaveAttribute('data-open', 'false');
  });
});
