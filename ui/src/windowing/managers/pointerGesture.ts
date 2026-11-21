// One place that owns "a drag is in flight" for the whole windowing system.
//
// Drags used to listen for mousemove/mouseup on `window`. That loses the
// gesture whenever the pointer leaves the window before the button comes back
// up — fling a panel at a screen edge, release outside the frame, and no
// mouseup ever arrives, so the panel keeps following the cursor until the next
// click. Pointer capture routes every subsequent event of that pointer to the
// element that captured it, including events outside the window, which is the
// actual fix rather than a wider net of listeners.
//
// Everything here is pointer-based: pointer events are the superset that also
// covers pen and touch, and Chromium fires them for mouse input too.

export interface GesturePointerMeta {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface PointerGestureSource {
  /** Element to capture the pointer on — normally the handle being dragged. */
  target?: Element | null;
  pointerId?: number | null;
}

export interface PointerGestureHandlers {
  onMove: (x: number, y: number, meta: GesturePointerMeta) => void;
  /** Pointer released, or the window took the pointer away. Commit. */
  onEnd: () => void;
  /** Gesture was aborted (pointercancel). Discard. */
  onCancel: () => void;
}

export const DEFAULT_POINTER_META: GesturePointerMeta = {
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};

export function pointerMetaFrom(
  event: Pick<MouseEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
): GesturePointerMeta {
  return {
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  };
}

export function normalizePointerMeta(meta?: Partial<GesturePointerMeta>): GesturePointerMeta {
  return { ...DEFAULT_POINTER_META, ...meta };
}

type Detach = () => void;

const NOOP_DETACH: Detach = () => {};

/**
 * Attach listeners for one in-flight pointer gesture. Returns a detach function
 * that is safe to call repeatedly; the gesture also detaches itself before
 * invoking onEnd/onCancel, so a handler can never fire twice for one gesture.
 */
export function beginPointerGesture(
  source: PointerGestureSource | null | undefined,
  handlers: PointerGestureHandlers,
): Detach {
  if (typeof window === 'undefined') return NOOP_DETACH;

  const pointerId = source?.pointerId ?? null;
  const target = source?.target ?? null;

  let captured = false;
  if (
    target
    && pointerId !== null
    && typeof (target as Element & { setPointerCapture?: unknown }).setPointerCapture === 'function'
  ) {
    try {
      target.setPointerCapture(pointerId);
      captured = true;
    } catch {
      // A pointer that is already gone cannot be captured. Fall back to window
      // listeners rather than dropping the gesture.
      captured = false;
    }
  }

  // With capture the element receives every later event for this pointer;
  // without it, window is the widest net available.
  const host: EventTarget = captured && target ? target : window;

  let detached = false;

  const matchesPointer = (event: Event): boolean => {
    if (pointerId === null) return true;
    const id = (event as PointerEvent).pointerId;
    return id === undefined || id === pointerId;
  };

  const detach: Detach = () => {
    if (detached) return;
    detached = true;
    host.removeEventListener('pointermove', onPointerMove);
    host.removeEventListener('pointerup', onPointerUp);
    host.removeEventListener('pointercancel', onPointerCancel);
    host.removeEventListener('lostpointercapture', onLostCapture);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('blur', onWindowBlur);
    if (captured && target && pointerId !== null) {
      try {
        target.releasePointerCapture(pointerId);
      } catch {
        // Already released (the pointer ended, or the element left the DOM).
      }
    }
  };

  function onPointerMove(event: Event): void {
    if (!matchesPointer(event)) return;
    const pointer = event as PointerEvent;
    handlers.onMove(pointer.clientX, pointer.clientY, pointerMetaFrom(pointer));
  }

  function onPointerUp(event: Event): void {
    if (!matchesPointer(event)) return;
    detach();
    handlers.onEnd();
  }

  function onPointerCancel(event: Event): void {
    if (!matchesPointer(event)) return;
    detach();
    handlers.onCancel();
  }

  function onLostCapture(event: Event): void {
    if (!matchesPointer(event)) return;
    // The browser took the pointer back (window deactivated, element removed).
    // Committing at the last known position beats stranding the gesture.
    detach();
    handlers.onEnd();
  }

  function onWindowBlur(): void {
    detach();
    handlers.onEnd();
  }

  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerup', onPointerUp);
  host.addEventListener('pointercancel', onPointerCancel);
  host.addEventListener('lostpointercapture', onLostCapture);
  // Backstop. If the capture target is torn out of the DOM mid-gesture, every
  // event routed to it — pointerup included — is lost and the gesture would run
  // forever. A release still reaches `window` by bubbling from wherever the
  // pointer actually is, so the gesture always has a way to finish. Harmless
  // when host IS window: the DOM ignores a duplicate identical listener, and
  // detach() runs before any handler, so nothing can fire twice.
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('blur', onWindowBlur);

  return detach;
}
