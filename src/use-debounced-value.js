import { useEffect, useState } from 'react';

/** Keep typing immediate while waiting for a brief pause before requesting an onchain quote. */
export function useDebouncedValue(value, delay = 300) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
