import { useSyncExternalStore } from 'react';

export interface ResizePointerMeta {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface EdgeResizeMachineConfig<Key, Bounds, Preview> {
  computePreview: (start: Bounds, dx: number, dy: number, meta: ResizePointerMeta) => Preview;
  commit: (key: Key, preview: Preview) => void;
  arePreviewsEqual: (a: Preview, b: Preview) => boolean;
  name: string;
}

interface IdleMachineState {
  state: 'idle';
}

interface ResizingMachineState<Key, Bounds> {
  state: 'resizing';
  key: Key;
  startBounds: Bounds;
  startMouseX: number;
  startMouseY: number;
  currentMouseX: number;
  currentMouseY: number;
  currentMeta: ResizePointerMeta;
}

type MachineState<Key, Bounds> = IdleMachineState | ResizingMachineState<Key, Bounds>;

export interface EdgeResizeMachine<Key, Bounds, Preview> {
  begin(key: Key, mouseX: number, mouseY: number, start: Bounds, meta?: Partial<ResizePointerMeta>): void;
  update(mouseX: number, mouseY: number, meta?: Partial<ResizePointerMeta>): void;
  end(): void;
  cancel(): void;
  isActive(): boolean;
  cancelIfActive(): boolean;
  subscribe(listener: () => void): () => void;
  usePreview(key: Key): Preview | null;
}

const DEFAULT_POINTER_META: ResizePointerMeta = {
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};

function normalizePointerMeta(meta?: Partial<ResizePointerMeta>): ResizePointerMeta {
  return { ...DEFAULT_POINTER_META, ...meta };
}

function pointerMetaFromEvent(event: MouseEvent): ResizePointerMeta {
  return {
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  };
}

export function createEdgeResizeMachine<Key, Bounds, Preview>(
  config: EdgeResizeMachineConfig<Key, Bounds, Preview>,
): EdgeResizeMachine<Key, Bounds, Preview> {
  let state: MachineState<Key, Bounds> = { state: 'idle' };
  const listeners = new Set<() => void>();
  const previewCache = new Map<Key, Preview>();
  let windowListenersBound = false;

  function emit(): void {
    for (const listener of [...listeners]) listener();
  }

  function computeCurrentPreview(active: ResizingMachineState<Key, Bounds>): Preview {
    const dx = active.currentMouseX - active.startMouseX;
    const dy = active.currentMouseY - active.startMouseY;
    return config.computePreview(active.startBounds, dx, dy, active.currentMeta);
  }

  function getPreviewSnapshot(key: Key): Preview | null {
    if (state.state !== 'resizing' || state.key !== key) return null;
    const next = computeCurrentPreview(state);
    const cached = previewCache.get(key);
    if (cached !== undefined && config.arePreviewsEqual(cached, next)) return cached;
    previewCache.set(key, next);
    return next;
  }

  function update(mouseX: number, mouseY: number, meta?: Partial<ResizePointerMeta>): void {
    if (state.state !== 'resizing') return;
    state = {
      ...state,
      currentMouseX: mouseX,
      currentMouseY: mouseY,
      currentMeta: normalizePointerMeta(meta),
    };
    previewCache.clear();
    emit();
  }

  function end(): void {
    if (state.state !== 'resizing') return;
    const active = state;
    const finalPreview = computeCurrentPreview(active);
    unbindListeners();
    state = { state: 'idle' };
    previewCache.clear();
    config.commit(active.key, finalPreview);
    emit();
  }

  function onMouseMove(event: MouseEvent): void {
    update(event.clientX, event.clientY, pointerMetaFromEvent(event));
  }

  function onMouseUp(): void {
    end();
  }

  function bindListeners(): void {
    if (windowListenersBound || typeof window === 'undefined') return;
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    windowListenersBound = true;
  }

  function unbindListeners(): void {
    if (!windowListenersBound || typeof window === 'undefined') return;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    windowListenersBound = false;
  }

  function begin(
    key: Key,
    mouseX: number,
    mouseY: number,
    start: Bounds,
    meta?: Partial<ResizePointerMeta>,
  ): void {
    unbindListeners();
    state = {
      state: 'resizing',
      key,
      startBounds: start,
      startMouseX: mouseX,
      startMouseY: mouseY,
      currentMouseX: mouseX,
      currentMouseY: mouseY,
      currentMeta: normalizePointerMeta(meta),
    };
    previewCache.clear();
    bindListeners();
    emit();
  }

  function cancel(): void {
    if (state.state !== 'resizing') return;
    unbindListeners();
    state = { state: 'idle' };
    previewCache.clear();
    emit();
  }

  function isActive(): boolean {
    return state.state === 'resizing';
  }

  function cancelIfActive(): boolean {
    if (state.state !== 'resizing') return false;
    cancel();
    return true;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function usePreview(key: Key): Preview | null {
    return useSyncExternalStore(
      subscribe,
      () => getPreviewSnapshot(key),
      () => getPreviewSnapshot(key),
    );
  }

  return { begin, update, end, cancel, isActive, cancelIfActive, subscribe, usePreview };
}
