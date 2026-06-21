import { useState, useEffect } from 'react';

// Increments whenever CSS theme variables are rewritten, so canvas components
// can use the epoch as a useEffect/useMemo dep to re-read computed colors.
let _epoch = 0;
const _listeners = new Set();

export function bumpThemeEpoch() {
  _epoch += 1;
  _listeners.forEach(cb => cb(_epoch));
}

export function useThemeEpoch() {
  const [epoch, setEpoch] = useState(_epoch);
  useEffect(() => {
    _listeners.add(setEpoch);
    return () => _listeners.delete(setEpoch);
  }, []);
  return epoch;
}
