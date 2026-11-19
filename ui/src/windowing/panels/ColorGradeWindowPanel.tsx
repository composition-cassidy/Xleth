import React, { useCallback } from 'react';
import { PanelFrame } from '../components/PanelFrame';
import { usePanelRegistry } from '../registry/PanelRegistry';
import { usePanelProps } from '../registry/usePanelValue';
import ColorGradePanel from '../../components/colorGrade/ColorGradePanel.jsx';
import GradeStack from '../../components/colorGrade/GradeStack.jsx';

// The Color Grade window: one floating panel that edits one grade at a time.
// Whoever opens it says which level and whose grade
// (colorGrade/gradeActions.js, openColorGrade):
//
//   openPanel('colorGrade', { target: { level, id }, name, stack })
//
// `stack`, when the opener knows it, is the whole picture's chain of owners
// (source, clip or sample, layer). The window then shows the stack view above
// the controls: every level in the order it is applied, which are on, and a
// click to jump to any of them, so it is always clear where a look comes from.
// Opened with nothing (the Tools menu), it edits the Master grade.

interface GradeTarget {
  level: 'source' | 'clip' | 'region' | 'layer' | 'master';
  id?: number;
}

interface StackOwner {
  id: number;
  name?: string;
  level?: 'clip' | 'region';
}

interface ColorGradeWindowProps {
  target?: GradeTarget;
  name?: string;
  stack?: { source?: StackOwner; clip?: StackOwner; layer?: StackOwner } | null;
}

const MASTER: GradeTarget = { level: 'master' };

function ColorGradeWindowBody() {
  const props = usePanelProps<ColorGradeWindowProps>('colorGrade');
  const target = (props?.target ?? MASTER) as GradeTarget;
  const stack = props?.stack ?? null;
  const name = props?.name ?? (target.level === 'master' ? 'Whole picture' : '');

  // Jumping to another level of the same picture keeps the stack on show.
  const openLevel = useCallback((next: GradeTarget, nextName: string) => {
    usePanelRegistry.getState().setPanelProps('colorGrade', { target: next, name: nextName, stack });
  }, [stack]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <GradeStack stack={stack} current={target} onOpen={openLevel} openLabel="Edit" />
      <div style={{ flex: '1 1 auto', minHeight: 0 }}>
        <ColorGradePanel target={target} name={name} />
      </div>
    </div>
  );
}

export default function ColorGradeWindowPanel() {
  return (
    <PanelFrame id="colorGrade">
      <ColorGradeWindowBody />
    </PanelFrame>
  );
}
