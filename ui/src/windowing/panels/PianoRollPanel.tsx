import React, { useCallback } from 'react';
import { PanelFrame } from '../components/PanelFrame';
import { usePanelRegistry } from '../registry/PanelRegistry';
import PianoRoll from '../../components/pianoRoll/PianoRoll.jsx';
import usePianoRollStore from '../../stores/usePianoRollStore.js';

const EMPTY_PATTERN_MAP = {};
const NOOP = () => {};

export default function PianoRollPanel() {
  const patternId = usePianoRollStore((s) => s.patternId);
  const mode = usePanelRegistry((s) => s.panels.pianoRoll.mode);
  const isFloating = mode === 'floating';

  // During the parallel-path period, drive both the windowing registry
  // and the legacy piano-roll store. Phase 6c removes the legacy half.
  const handleClose = useCallback(() => {
    const reg = usePanelRegistry.getState();
    const store = usePianoRollStore.getState();
    reg.closePanel('pianoRoll');
    store.setPatternId(null);
    store.setDetached(false);
    store.setActiveCenterTab('timeline');
  }, []);

  const handleDetach = useCallback(() => {
    const reg = usePanelRegistry.getState();
    const store = usePianoRollStore.getState();
    const { x, y } = reg.panels.pianoRoll.floating;
    reg.undockPanel('pianoRoll', x, y);
    store.setDetached(true);
    store.setActiveCenterTab('timeline');
  }, []);

  const handleDock = useCallback(() => {
    const reg = usePanelRegistry.getState();
    const store = usePianoRollStore.getState();
    reg.dockPanel('pianoRoll', 'bottom');
    store.setDetached(false);
    store.setActiveCenterTab('piano-roll');
  }, []);

  return (
    <PanelFrame id="pianoRoll">
      <PianoRoll
        patternId={patternId}
        onClose={handleClose}
        onDetach={handleDetach}
        onDock={handleDock}
        floating={isFloating}
        onTitleMouseDown={NOOP}
        onTitleDoubleClick={handleDock}
        availablePatterns={EMPTY_PATTERN_MAP}
        currentPatternId={patternId}
        onSwitchPattern={(id) => usePianoRollStore.getState().setPatternId(id)}
        onNewPattern={NOOP}
      />
    </PanelFrame>
  );
}
