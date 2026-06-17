import type { RefObject } from 'react';
import { useEffect } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true',
  );
}

/**
 * Trap keyboard focus inside `ref` while `active`. On activation it remembers
 * the previously focused element and moves focus to the first focusable inside
 * (or the container itself if there is none). Tab / Shift+Tab cycle within the
 * trap. On deactivation/unmount it restores focus to the remembered element.
 * Backs `Modal` (and is reusable by future Drawer/ConfirmDialog).
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (container === null) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const items = focusables(container);
    if (items.length > 0) {
      items[0].focus();
    } else {
      container.setAttribute('tabindex', '-1');
      container.focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const list = focusables(container);
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey) {
        if (activeEl === first || !container.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else if (activeEl === last || !container.contains(activeEl)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (previouslyFocused !== null && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [ref, active]);
}
