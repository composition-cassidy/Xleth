import React from 'react';
import {
  buildEffectPickerGroups,
  filterEffectPickerGroups,
  countEffectPickerOptions,
} from '../../../components/mixer/effectCatalog.js';
import './fxGraphEffectPicker.css';

// FXG.3-e — the FX Graph add-effect picker.
//
// Reuses the SAME catalog source as the Mixer Chain (effectCatalog.js: the
// stock EFFECT_CATEGORIES plus the scanned vstPlugins list). It only chooses
// WHAT to add; the panel turns the selection into a graph-owned effect node via
// effectChainStore.addGraphEffectNodeForTrack. It never touches chain slots,
// effectChains, or chain runtime routing.

export interface FxEffectPickerOption {
  pluginId: string;
  label: string;
  displayName: string;
  kind: 'stock' | 'vst';
}

export interface FxEffectPickerGroup {
  id: string;
  label: string;
  kind: 'stock' | 'vst';
  emptyLabel?: string;
  options: FxEffectPickerOption[];
}

export interface FxEffectPickerSelection {
  pluginId: string;
  displayName: string;
}

export interface VstPluginMeta {
  id: string;
  name?: string;
  vendor?: string;
}

interface FxGraphEffectPickerProps {
  vstPlugins?: VstPluginMeta[];
  onSelect: (selection: FxEffectPickerSelection) => void;
  onCancel: () => void;
  title?: string;
}

export default function FxGraphEffectPicker({
  vstPlugins = [],
  onSelect,
  onCancel,
  title = 'Add Effect Node',
}: FxGraphEffectPickerProps) {
  const [query, setQuery] = React.useState('');

  const allGroups = React.useMemo(
    () => buildEffectPickerGroups({ vstPlugins }) as FxEffectPickerGroup[],
    [vstPlugins],
  );
  const groups = React.useMemo(
    () => filterEffectPickerGroups(allGroups, query) as FxEffectPickerGroup[],
    [allGroups, query],
  );
  const hasMatches = countEffectPickerOptions(groups) > 0;

  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  return (
    <div className="xleth-fx-graph-effect-picker" role="presentation">
      <div
        className="xleth-fx-graph-effect-picker__backdrop"
        aria-hidden="true"
        onClick={onCancel}
      />
      <div
        className="xleth-fx-graph-effect-picker__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="xleth-fx-graph-effect-picker__header">
          <h3 className="xleth-fx-graph-effect-picker__title">{title}</h3>
          <button
            className="xleth-fx-graph-effect-picker__close"
            type="button"
            aria-label="Cancel adding an effect"
            onClick={onCancel}
          >
            {'×'}
          </button>
        </header>

        <div className="xleth-fx-graph-effect-picker__search">
          <input
            className="xleth-fx-graph-effect-picker__search-input"
            type="search"
            value={query}
            placeholder="Search effects…"
            aria-label="Search effects"
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div
          className="xleth-fx-graph-effect-picker__list"
          role="listbox"
          aria-label="Available effects"
        >
          {!hasMatches ? (
            <p className="xleth-fx-graph-effect-picker__empty">
              No effects match this search.
            </p>
          ) : (
            groups.map((group) => (
              <section className="xleth-fx-graph-effect-picker__group" key={group.id}>
                <div className="xleth-fx-graph-effect-picker__group-label">
                  {`${group.label} (${group.options.length})`}
                </div>
                {group.options.length === 0 ? (
                  <p className="xleth-fx-graph-effect-picker__group-empty">
                    {group.emptyLabel ?? 'Nothing available.'}
                  </p>
                ) : (
                  <div className="xleth-fx-graph-effect-picker__options">
                    {group.options.map((option) => (
                      <button
                        key={`${group.id}:${option.pluginId}`}
                        className="xleth-fx-graph-effect-picker__option"
                        type="button"
                        role="option"
                        aria-selected="false"
                        data-plugin-id={option.pluginId}
                        data-kind={option.kind}
                        onClick={() =>
                          onSelect({ pluginId: option.pluginId, displayName: option.displayName })
                        }
                      >
                        <span className="xleth-fx-graph-effect-picker__option-label">
                          {option.label}
                        </span>
                        {option.kind === 'vst' && (
                          <span className="xleth-fx-graph-effect-picker__option-tag">VST3</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </section>
            ))
          )}
        </div>

        <footer className="xleth-fx-graph-effect-picker__footer">
          <button
            className="xleth-fx-graph-effect-picker__cancel"
            type="button"
            onClick={onCancel}
          >
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}
