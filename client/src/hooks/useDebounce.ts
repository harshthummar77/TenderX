import { useEffect, useState } from 'react';

/**
 * Hold a value still until the user stops typing. A search box wired straight to
 * a query key fires a request per keystroke; at 300 ms it fires one.
 *
 *   const [q, setQ] = useState('');
 *   const debounced = useDebounce(q);
 *   const { data } = useQuery({ queryKey: qk.tenders.list({ q: debounced }), … });
 */
export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
