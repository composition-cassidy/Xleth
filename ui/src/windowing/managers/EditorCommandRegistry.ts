import { PANEL_IDS, type PanelId } from '../registry/panelCatalog';
import { usePanelRegistry } from '../registry/PanelRegistry';

export type EditorCommandId = 'deleteSelected';
export type EditorCommandHandler = () => void | boolean | Promise<void | boolean>;

const editorCommands = new Map<EditorCommandId, Map<PanelId, EditorCommandHandler>>();

function resolveFocusedEditorPanel(): PanelId | null {
  const { panels } = usePanelRegistry.getState();
  return PANEL_IDS.find((id) => panels[id].focused && !panels[id].hidden) ?? null;
}

export function registerEditorCommand(
  panelId: PanelId,
  commandId: EditorCommandId,
  handler: EditorCommandHandler,
): () => void {
  let panelHandlers = editorCommands.get(commandId);
  if (!panelHandlers) {
    panelHandlers = new Map();
    editorCommands.set(commandId, panelHandlers);
  }
  panelHandlers.set(panelId, handler);

  return () => {
    const currentHandlers = editorCommands.get(commandId);
    if (!currentHandlers || currentHandlers.get(panelId) !== handler) return;
    currentHandlers.delete(panelId);
    if (currentHandlers.size === 0) editorCommands.delete(commandId);
  };
}

export async function runEditorCommand(
  commandId: EditorCommandId,
  panelId: PanelId | null = resolveFocusedEditorPanel(),
): Promise<boolean> {
  if (!panelId) return false;
  const handler = editorCommands.get(commandId)?.get(panelId);
  if (!handler) return false;
  const result = await handler();
  return result !== false;
}

export function clearEditorCommandsForTest(): void {
  editorCommands.clear();
}
