import type { ReactNode } from 'react';
import { createContext, useContext, useEffect } from 'react';

/** Setter the console shell provides so a page can publish its top-bar action. */
export type SetConsoleAction = (node: ReactNode) => void;
export const ConsoleActionContext = createContext<SetConsoleAction>(() => undefined);

/** Setter for the top-bar filter slot (selects / dropdowns that scope the view). */
export const ConsoleFiltersContext = createContext<SetConsoleAction>(() => undefined);

/** A back target rendered at the far-left of the TopBar (e.g. on a detail view). */
export interface ConsoleBack {
  to: string;
  label: string;
}
export type SetConsoleBack = (back: ConsoleBack | null) => void;
export const ConsoleBackContext = createContext<SetConsoleBack>(() => undefined);

/**
 * A console page publishes its section action (e.g. a "New …" button) into the
 * shell's TopBar. `node` MUST be memoized (e.g. `useMemo`) so the effect only
 * re-runs when the action actually changes — otherwise it loops.
 */
export function useSetConsoleAction(node: ReactNode): void {
  const set = useContext(ConsoleActionContext);
  useEffect(() => {
    set(node);
    return () => {
      set(null);
    };
  }, [set, node]);
}

/**
 * A console page publishes its filter controls (selects/dropdowns) into the
 * TopBar. `node` MUST be memoized; include any filter value in its deps so the
 * control reflects the current selection.
 */
export function useSetConsoleFilters(node: ReactNode): void {
  const set = useContext(ConsoleFiltersContext);
  useEffect(() => {
    set(node);
    return () => {
      set(null);
    };
  }, [set, node]);
}

/** A console page publishes a back target into the TopBar's far-left slot. */
export function useSetConsoleBack(back: ConsoleBack | null): void {
  const set = useContext(ConsoleBackContext);
  const to = back?.to;
  const label = back?.label;
  useEffect(() => {
    set(to !== undefined && label !== undefined ? { to, label } : null);
    return () => {
      set(null);
    };
  }, [set, to, label]);
}
