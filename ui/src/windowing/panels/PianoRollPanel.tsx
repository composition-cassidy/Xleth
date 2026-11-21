import React, { useCallback, useEffect } from 'react';
import { PanelFrame } from '../components/PanelFrame';
import { useXlethRootContext } from '../contexts/XlethRootContext.jsx';
import { usePanelRegistry } from '../registry/PanelRegistry';
import PianoRoll from '../../components/pianoRoll/PianoRoll.jsx';
import usePianoRollStore from '../../stores/usePianoRollStore.js';
import { fallbackPatternId, type PatternMap } from './dockTabFallback';

export default function PianoRollPanel() {
  const patternId = usePianoRollStore((s) => s.patternId);
  const lastPatternId = usePianoRollStore((s) => s.lastPatternId);
  const hidden = usePanelRegistry((s) => s.panels.pianoRoll.hidden);
  const mode = usePanelRegistry((s) => s.panels.pianoRoll.mode);
  const isFloating = mode === 'floating';
  const {
    availablePatterns,
    allPatterns,
    onSwitchPattern,
    onNewPattern,
  } = useXlethRootContext() as ReturnType<typeof useXlethRootContext> & { allPatterns?: PatternMap };

  // A dock tab never dead-ends (ui/DESIGN.md 15): shown with no pattern open (or with one that
  // no longer exists), the Piano Roll opens the pattern last open in it, else the first. It only
  // sets the id in the renderer store: no event, so no tab is switched and no focus moves, and
  // it does nothing while the panel is hidden, so closing the Piano Roll still closes it.
  const projectHasPatterns = Object.keys(allPatterns ?? {}).length > 0;
  const openIsValid = patternId != null && !!allPatterns?.[patternId];
  useEffect(() => {
    if (hidden || openIsValid) return;
    const next = fallbackPatternId(allPatterns, lastPatternId);
    if (next != null && next !== patternId) usePianoRollStore.getState().setPatternId(next);
  }, [hidden, openIsValid, allPatterns, lastPatternId, patternId]);

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

  const handleSwitchPattern = useCallback((id) => {
    if (onSwitchPattern) onSwitchPattern(id);
    else usePianoRollStore.getState().setPatternId(id);
  }, [onSwitchPattern]);

  return (
    <PanelFrame id="pianoRoll">
      <PianoRoll
        patternId={patternId}
        onClose={handleClose}
        onDetach={handleDetach}
        onDock={handleDock}
        floating={isFloating}
        availablePatterns={availablePatterns}
        currentPatternId={patternId}
        onSwitchPattern={handleSwitchPattern}
        onNewPattern={onNewPattern}
        projectHasPatterns={projectHasPatterns}
      />
    </PanelFrame>
  );
}
