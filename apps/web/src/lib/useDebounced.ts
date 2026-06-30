import { useEffect, useState } from 'react';

/** Local-mirror + debounced-commit for filter inputs: type freely, commit after `delay`.
 *  Returns [localValue, setLocalValue]; re-syncs local when the committed `value` changes. */
export function useDebounced(
  value: string,
  commit: (v: string) => void,
  delay = 350,
): [string, (v: string) => void] {
  const [local, setLocal] = useState(value);
  useEffect(() => {
    setLocal(value);
  }, [value]);
  useEffect(() => {
    if (local === value) return;
    const id = setTimeout(() => commit(local), delay);
    return () => clearTimeout(id);
  }, [local, value, commit, delay]);
  return [local, setLocal];
}
