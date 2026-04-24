// REMOVE AFTER PHASE 0 CLOSE — temporary baseline capture UI
// Opened by Ctrl+Shift+F12 in App.jsx.
// Captures Playwright-compatible element screenshots via Electron's
// webContents.capturePage() IPC bridge (Chromium-native, no html2canvas).

import { useState } from 'react';

const FREEZE_CSS_ID = '__xleth_freeze__';
const FREEZE_CSS = [
  '*, *::before, *::after {',
  '  animation-play-state: paused !important;',
  '  animation-duration: 0s !important;',
  '  transition-duration: 0s !important;',
  '  transition-delay: 0s !important;',
  '}',
].join('\n');

// Maps each skipped Playwright test to the selectors Playwright uses.
const CAPTURES = [
  {
    id: '11-piano-roll',
    label: 'Capture Piano Roll',
    selectors: ['.center-area-body'],
    hint: 'Open Piano Roll first (double-click a pattern block)',
  },
  {
    id: '12-sampler-panel',
    label: 'Capture Sampler',
    selectors: ['.sampler-panel'],
    hint: "Open Sampler (click a track's instrument icon)",
  },
  {
    id: '17-distortion-panel',
    label: 'Capture Distortion Panel',
    selectors: ['.distortion-panel'],
    hint: 'Add Distortion effect to master chain and click its name',
  },
  {
    id: '18-modulation-panel',
    label: 'Capture Modulation Panel',
    selectors: ['.flanger-panel', '.chorus-panel', '.phaser-panel'],
    hint: 'Add UniFlange / Chorus / Phaser and click its name',
  },
  {
    id: '20-sample-picker',
    label: 'Capture Sample Picker',
    selectors: ['.sample-picker'],
    hint: 'Open Sample Picker (double-click a source in Sample Selector)',
    subCaptures: [
      { id: '26-waveform-scrubber', selectors: ['.waveform-scrubber'] },
      { id: '25-syllable-splitter', selectors: ['.syllable-splitter'] },
    ],
  },
  {
    id: '24-toast',
    label: 'Capture Toast Notification',
    selectors: ['.toast'],
    hint: 'Trigger a toast first (Ctrl+S after any edit)',
  },
];

function injectFreezeCSS() {
  if (document.getElementById(FREEZE_CSS_ID)) return;
  const s = document.createElement('style');
  s.id = FREEZE_CSS_ID;
  s.textContent = FREEZE_CSS;
  document.head.appendChild(s);
}

function findElement(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

async function captureElement(snapshotId, selectors) {
  const el = findElement(selectors);
  if (!el) return { success: false, error: `element not found (${selectors.join(', ')})` };
  const { x, y, width, height } = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return window.xleth.debug.capturePage({
    snapshotName: snapshotId,
    rect: {
      x: Math.round(x * dpr),
      y: Math.round(y * dpr),
      width: Math.round(width * dpr),
      height: Math.round(height * dpr),
    },
  });
}

export default function DebugCapturePanel({ onClose }) {
  const [statuses, setStatuses] = useState({});
  const [activeCap, setActiveCap] = useState(null);

  const handleCapture = async (cap) => {
    if (activeCap !== null) return;
    setActiveCap(cap.id);
    const panelEl = document.getElementById('__xleth_debug_capture_panel__');
    try {
      // Hide the debug panel so it doesn't appear in the screenshot.
      if (panelEl) panelEl.style.visibility = 'hidden';
      // Wait 2 animation frames so Chromium composites the frame without the panel.
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      // Freeze animations — same technique as the Playwright spec.
      injectFreezeCSS();

      // Primary capture
      const result = await captureElement(cap.id, cap.selectors);
      const updates = { [cap.id]: result.success ? 'ok' : `error: ${result.error}` };

      // Optional sub-captures (waveform scrubber, syllable splitter)
      if (result.success && cap.subCaptures) {
        for (const sub of cap.subCaptures) {
          const subResult = await captureElement(sub.id, sub.selectors);
          if (subResult.success) updates[sub.id] = 'ok';
        }
      }

      setStatuses(prev => ({ ...prev, ...updates }));
    } catch (e) {
      setStatuses(prev => ({ ...prev, [cap.id]: `error: ${e.message}` }));
    } finally {
      if (panelEl) panelEl.style.visibility = 'visible';
      setActiveCap(null);
    }
  };

  return (
    <div
      id="__xleth_debug_capture_panel__"
      style={{
        position: 'fixed', top: 44, right: 16, zIndex: 99999,
        background: '#12122a', border: '2px solid #ff6b35',
        borderRadius: 8, padding: '12px 16px', minWidth: 340,
        fontFamily: 'monospace', fontSize: 12, color: '#e0e0e0',
        boxShadow: '0 4px 32px rgba(0,0,0,0.7)',
        userSelect: 'none',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ color: '#ff6b35', fontWeight: 'bold', fontSize: 11, letterSpacing: 1 }}>
          ⚠ PHASE 0 BASELINE CAPTURE
        </span>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 15, lineHeight: 1 }}
        >✕</button>
      </div>
      <div style={{ color: '#666', fontSize: 10, marginBottom: 12 }}>
        Navigate to the panel state, then click. Ctrl+Shift+F12 to close.
      </div>

      {/* Capture buttons */}
      {CAPTURES.map(cap => (
        <div key={cap.id} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button
              onClick={() => handleCapture(cap)}
              disabled={activeCap !== null}
              style={{
                background: activeCap === cap.id ? '#3a3a5a' : '#1e1e3a',
                border: '1px solid #4040aa',
                borderRadius: 4, color: '#b0b0ff',
                padding: '4px 10px', cursor: activeCap !== null ? 'not-allowed' : 'pointer',
                fontSize: 11, opacity: activeCap !== null && activeCap !== cap.id ? 0.45 : 1,
                transition: 'none',
              }}
            >
              {activeCap === cap.id ? '⏳' : '📷'} {cap.label}
            </button>
            {statuses[cap.id] && (
              <span style={{
                color: statuses[cap.id] === 'ok' ? '#4caf50' : '#ff5252',
                fontSize: 10,
              }}>
                {statuses[cap.id] === 'ok' ? '✓ saved' : statuses[cap.id]}
              </span>
            )}
          </div>
          <div style={{ color: '#555', fontSize: 10, marginTop: 2, paddingLeft: 4 }}>
            {cap.hint}
          </div>
          {/* Sub-capture results (waveform scrubber, syllable splitter) */}
          {cap.subCaptures?.map(sub => statuses[sub.id] && (
            <div key={sub.id} style={{ color: '#4caf50', fontSize: 10, paddingLeft: 4 }}>
              {sub.id}: ✓ saved
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
