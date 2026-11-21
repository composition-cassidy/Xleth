import { useState, useEffect } from 'react';
import { subscribeDpr } from '../ui-kit/dpr';

// Increments whenever CSS theme variables are rewritten, so canvas components
// can use the epoch as a useEffect/useMemo dep to re-read computed colors.
//
// Phase 7: it ALSO increments when the device pixel ratio changes (the UI scale is
// window zoom, which changes it), because a canvas redraws for exactly the same
// reason in both cases: its inputs from the display changed. Every canvas that already
// keys its draw effect on this epoch is therefore re-sized by devicePixelRatio and
// redrawn crisp at the new scale with no further change.
let _epoch = 0;
const _listeners = new Set();

export function bumpThemeEpoch() {
  _epoch += 1;
  _listeners.forEach(cb => cb(_epoch));
}

let _dprUnsubscribe = null;

export function useThemeEpoch() {
  const [epoch, setEpoch] = useState(_epoch);
  useEffect(() => {
    _listeners.add(setEpoch);
    if (_listeners.size === 1) _dprUnsubscribe = subscribeDpr(() => bumpThemeEpoch());
    return () => {
      _listeners.delete(setEpoch);
      if (_listeners.size === 0 && _dprUnsubscribe) { _dprUnsubscribe(); _dprUnsubscribe = null; }
    };
  }, []);
  return epoch;
}
