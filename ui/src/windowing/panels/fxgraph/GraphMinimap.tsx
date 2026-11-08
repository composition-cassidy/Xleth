import React from 'react';
import { useThemeEpoch } from '../../../theming/useThemeEpoch.js';
import styles from './GraphCanvas.module.css';

// The FX Graph minimap: every node as a rectangle, every cable as a line in its signal hue,
// and the visible window as a --ui-select outline. Click or drag to move the view. It is a
// canvas, redrawn on a model, view, size, theme or pixel-ratio change only (never per frame),
// and reads its colours from its own computed style at draw time. The parent shows it only
// when some node lies outside the view.

export interface MinimapNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MinimapEdge {
  sourceNodeId: string;
  targetNodeId: string;
  type: string;
}

interface GraphMinimapProps {
  nodes: MinimapNode[];
  edges: MinimapEdge[];
  viewport: { x: number; y: number; zoom: number };
  viewSize: { width: number; height: number };
  onViewportChange: (viewport: { x: number; y: number; zoom: number }) => void;
}

const WORLD_PAD = 16;
const CSS_W = 176;
const CSS_H = 112;

interface Mapping {
  scale: number;
  left: number;
  top: number;
  minX: number;
  minY: number;
}

// The world the minimap shows: all nodes plus the visible window, so the outline never
// leaves the frame.
export function minimapMapping(
  nodes: MinimapNode[],
  viewport: { x: number; y: number; zoom: number },
  viewSize: { width: number; height: number },
  width = CSS_W,
  height = CSS_H,
): Mapping {
  const z = viewport.zoom || 1;
  let minX = -viewport.x / z;
  let minY = -viewport.y / z;
  let maxX = (viewSize.width - viewport.x) / z;
  let maxY = (viewSize.height - viewport.y) / z;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }
  minX -= WORLD_PAD;
  minY -= WORLD_PAD;
  maxX += WORLD_PAD;
  maxY += WORLD_PAD;
  const worldW = Math.max(1, maxX - minX);
  const worldH = Math.max(1, maxY - minY);
  const scale = Math.min(width / worldW, height / worldH);
  return {
    scale,
    minX,
    minY,
    left: (width - worldW * scale) / 2,
    top: (height - worldH * scale) / 2,
  };
}

// The viewport that centres the window on a point of the minimap.
export function viewportForMinimapPoint(
  mapping: Mapping,
  point: { x: number; y: number },
  viewport: { zoom: number },
  viewSize: { width: number; height: number },
) {
  const worldX = mapping.minX + (point.x - mapping.left) / mapping.scale;
  const worldY = mapping.minY + (point.y - mapping.top) / mapping.scale;
  return {
    x: Math.round(viewSize.width / 2 - worldX * viewport.zoom),
    y: Math.round(viewSize.height / 2 - worldY * viewport.zoom),
    zoom: viewport.zoom,
  };
}

export default function GraphMinimap({ nodes, edges, viewport, viewSize, onViewportChange }: GraphMinimapProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const draggingRef = React.useRef<number | null>(null);
  const themeEpoch = useThemeEpoch();
  const mapping = React.useMemo(
    () => minimapMapping(nodes, viewport, viewSize),
    [nodes, viewport, viewSize],
  );

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.round(CSS_W * dpr);
    const h = Math.round(CSS_H * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cs = getComputedStyle(canvas);
    const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    const ground = get('--ui-g1', '#1B1B1B');
    const nodeFill = get('--ui-g3', '#2B2B2B');
    const nodeStroke = get('--ui-boundary', '#747474');
    const select = get('--ui-select', '#33CED6');
    const signal: Record<string, string> = {
      audio: get('--ui-signal-audio', '#6FA7EE'),
      parameter: get('--ui-signal-parameter', '#AA95E8'),
      sidechain: get('--ui-signal-audio', '#6FA7EE'),
    };
    const fallbackLine = get('--ui-ink-3', '#929292');

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = ground;
    ctx.fillRect(0, 0, CSS_W, CSS_H);

    const toX = (x: number) => mapping.left + (x - mapping.minX) * mapping.scale;
    const toY = (y: number) => mapping.top + (y - mapping.minY) * mapping.scale;
    const byId = new Map(nodes.map((node) => [node.id, node]));

    ctx.lineWidth = 1;
    for (const edge of edges) {
      const a = byId.get(edge.sourceNodeId);
      const b = byId.get(edge.targetNodeId);
      if (!a || !b) continue;
      ctx.strokeStyle = signal[edge.type] ?? fallbackLine;
      ctx.globalAlpha = edge.type === 'sidechain' ? 0.6 : 1;
      ctx.setLineDash(edge.type === 'parameter' ? [3, 2] : edge.type === 'sidechain' ? [1, 3] : []);
      ctx.beginPath();
      ctx.moveTo(toX(a.x + a.width), toY(a.y + a.height / 2));
      ctx.lineTo(toX(b.x), toY(b.y + b.height / 2));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    ctx.fillStyle = nodeFill;
    ctx.strokeStyle = nodeStroke;
    for (const node of nodes) {
      const x = Math.round(toX(node.x)) + 0.5;
      const y = Math.round(toY(node.y)) + 0.5;
      const nw = Math.max(3, node.width * mapping.scale);
      const nh = Math.max(3, node.height * mapping.scale);
      ctx.fillRect(x, y, nw, nh);
      ctx.strokeRect(x, y, nw, nh);
    }

    const z = viewport.zoom || 1;
    ctx.strokeStyle = select;
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.round(toX(-viewport.x / z)) + 0.5,
      Math.round(toY(-viewport.y / z)) + 0.5,
      Math.max(2, (viewSize.width / z) * mapping.scale),
      Math.max(2, (viewSize.height / z) * mapping.scale),
    );
  }, [edges, mapping, nodes, themeEpoch, viewSize.height, viewSize.width, viewport.x, viewport.y, viewport.zoom]);

  const moveTo = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onViewportChange(viewportForMinimapPoint(
      mapping,
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      viewport,
      viewSize,
    ));
  };

  return (
    <canvas
      ref={canvasRef}
      className={styles.minimap}
      data-testid="fx-graph-minimap"
      role="img"
      aria-label="Graph overview. Click or drag to move the view."
      width={CSS_W}
      height={CSS_H}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        draggingRef.current = event.pointerId;
        moveTo(event);
      }}
      onPointerMove={(event) => {
        if (draggingRef.current !== event.pointerId) return;
        event.stopPropagation();
        moveTo(event);
      }}
      onPointerUp={(event) => {
        if (draggingRef.current !== event.pointerId) return;
        event.stopPropagation();
        draggingRef.current = null;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }}
      onPointerCancel={() => { draggingRef.current = null; }}
      onWheel={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
    />
  );
}
