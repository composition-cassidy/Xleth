import React, { useEffect } from 'react';
import { PanelFrame } from '../components/PanelFrame';
import { usePanelRegistry } from '../registry/PanelRegistry';
import MixerPanelBody from '../../components/mixer/MixerPanel.jsx';
import useMixerStore from '../../stores/mixerStore.js';

export default function MixerPanel() {
  const hidden = usePanelRegistry((s) => s.panels.mixer.hidden);
  const setVisible = useMixerStore((s) => s.setVisible);

  useEffect(() => {
    // sync registry hidden -> mixerStore.visible on transitions
    setVisible(!hidden);
    return () => setVisible(false);
  }, [hidden, setVisible]);

  return (
    <PanelFrame id="mixer">
      <MixerPanelBody />
    </PanelFrame>
  );
}
