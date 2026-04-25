import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';

interface PanelVisibilityContextValue {
  isVisible: boolean;
  useOnVisibilityChange: (callback: (isVisible: boolean) => void) => void;
}

const PanelVisibilityContext = createContext<PanelVisibilityContextValue>({
  isVisible: true,
  useOnVisibilityChange: () => {},
});

export function PanelVisibilityProvider({
  isVisible,
  children,
}: {
  isVisible: boolean;
  children: ReactNode;
}) {
  const callbacksRef = useRef<Set<(v: boolean) => void>>(new Set());
  const prevVisibleRef = useRef(isVisible);

  useEffect(() => {
    if (prevVisibleRef.current !== isVisible) {
      prevVisibleRef.current = isVisible;
      callbacksRef.current.forEach((cb) => cb(isVisible));
    }
  }, [isVisible]);

  function useOnVisibilityChange(callback: (isVisible: boolean) => void) {
    const callbackRef = useRef(callback);
    callbackRef.current = callback;

    useEffect(() => {
      const cb = (v: boolean) => callbackRef.current(v);
      callbacksRef.current.add(cb);
      return () => {
        callbacksRef.current.delete(cb);
      };
    }, []);
  }

  return (
    <PanelVisibilityContext.Provider value={{ isVisible, useOnVisibilityChange }}>
      {children}
    </PanelVisibilityContext.Provider>
  );
}

export function usePanelVisibility(): PanelVisibilityContextValue {
  return useContext(PanelVisibilityContext);
}

export default PanelVisibilityContext;
