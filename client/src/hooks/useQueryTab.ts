import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Tab state in the URL, so "the Documents tab of this purchase order" is a link
 * someone can send — and so a refresh does not drop the user back on Overview
 * (plan 17 §8: filters live in the query string, not in component state).
 */
export function useQueryTab(defaultTab: string, key = 'tab'): [string, (tab: string) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const active = searchParams.get(key) ?? defaultTab;

  const setTab = useCallback(
    (tab: string) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (tab === defaultTab) next.delete(key);
          else next.set(key, tab);
          return next;
        },
        // Replace, so flicking through four tabs does not need four back presses
        // to leave the screen.
        { replace: true },
      );
    },
    [setSearchParams, key, defaultTab],
  );

  return [active, setTab];
}
