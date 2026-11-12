import { useCallback, useEffect, useState } from 'react'
import { Button, IconButton, Menu, MenuCustom, MenuItem, MenuSeparator } from '../ui-kit'
import { usePanelRegistry } from '../windowing/registry/PanelRegistry'
import { detailDockKey } from '../windowing/components/DetailDock'
import { toggleDetailDock } from '../windowing/layout/dockFocus'
import { formatCombo } from '../windowing/managers/shortcutCatalog'
import { resolveCombo } from '../windowing/managers/shortcutOverrides'
import { PANEL_CATALOG } from '../windowing/registry/panelCatalog'
import { useRegistryValue } from '../windowing/registry/usePanelValue'
import { useQuickLaunchersStore } from '../stores/quickLaunchersStore.js'
import styles from './TitleBarRegions.module.css'
import { iconComponent } from '../ui-kit/icons'

const IcCaretDown = iconComponent('caret-down')
const IcSquareHalfBottom = iconComponent('square-half-bottom')

/** Region toggles, in the order they sit in the bar. Every one is a region of the shell. */
export const REGION_TOGGLES = ['sampleSelector', 'preview', 'inspector']

/** The floating tools behind the Tools menu. */
export const TOOL_PANELS = ['sampleSandbox', 'quickNotation', 'splitSyllables']

/** Shortcut text for a panel: its F-key, or nothing when it has none. */
export function panelShortcut(id) {
  return PANEL_CATALOG[id].fKey || ''
}

/** The shell's name for a region (the catalog calls the Browser the Sample Selector). */
const REGION_NAMES = { sampleSelector: 'Browser', preview: 'Preview', inspector: 'Inspector' }

const REGION_HINTS = {
  sampleSelector: 'Browser: show or hide the media and sample lists',
  preview: 'Preview: show or hide the picture',
  inspector: 'Inspector: show or hide the properties of the selection',
}

function RegionToggle({ id }) {
  const entry = PANEL_CATALOG[id]
  const Icon = entry.icon
  const hidden = useRegistryValue((state) => state.panels[id].hidden)
  const shortcut = panelShortcut(id)
  return (
    <IconButton
      size="sm"
      label={`Toggle ${REGION_NAMES[id]}`}
      pressed={!hidden}
      tone="quiet"
      hint={REGION_HINTS[id]}
      hintMods={shortcut || 'No shortcut'}
      onClick={() => usePanelRegistry.getState().togglePanel(id)}
    >
      <Icon aria-hidden="true" />
    </IconButton>
  )
}

function DetailDockToggle() {
  const open = useRegistryValue((state) => detailDockKey(state.panels).includes(':open'))
  return (
    <IconButton
      size="sm"
      label="Toggle Detail dock"
      pressed={open}
      tone="quiet"
      hint="Detail dock: show or hide Devices, Mixer, Piano Roll, Sampler and FX Graph"
      hintMods={`${formatCombo(resolveCombo('view.dockFocus'))} gives it the whole centre column`}
      onClick={toggleDetailDock}
    >
      <IcSquareHalfBottom aria-hidden="true" />
    </IconButton>
  )
}

function ToolItem({ id }) {
  const entry = PANEL_CATALOG[id]
  const hidden = useRegistryValue((state) => state.panels[id].hidden)
  const shortcut = panelShortcut(id)
  return (
    <MenuItem checked={!hidden} onSelect={() => usePanelRegistry.getState().togglePanel(id)}>
      <span className={styles.itemRow}>
        <span>{entry.title}</span>
        {shortcut ? <span className={styles.shortcut}>{shortcut}</span> : null}
      </span>
    </MenuItem>
  )
}

function LauncherItem({ launcher }) {
  const iconUrl = window.xleth?.launcher?.buildIconUrl?.(launcher.iconPngPath || '')
  const glyph = iconUrl
    ? <img src={iconUrl} alt="" aria-hidden="true" className={styles.launcherIcon} />
    : <span className={styles.launcherLetter} aria-hidden="true">{(launcher.label || '?').charAt(0).toUpperCase()}</span>
  return (
    <MenuItem icon={glyph} onSelect={() => window.xleth?.launcher?.spawnDetached?.(launcher.exePath)}>
      {launcher.label}
    </MenuItem>
  )
}

/**
 * The top bar's panel controls: four region toggles (Browser, Preview, Inspector,
 * Detail dock) and one Tools menu for the floating tools and the user's own
 * launchers. Everything the detail dock's tabs already open (Piano Roll, Mixer,
 * FX Graph, Sampler) is not repeated here; its F-keys are unchanged.
 */
export default function TitleBarRegions({ className = '' }) {
  const launchers = useQuickLaunchersStore((state) => state.launchers)
  const hydrate = useQuickLaunchersStore((state) => state.hydrate)
  const [menu, setMenu] = useState(null)
  const closeMenu = useCallback(() => setMenu(null), [])

  useEffect(() => { hydrate() }, [hydrate])

  const openMenu = (event) => {
    if (menu) { setMenu(null); return }
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ x: rect.left, y: rect.bottom + 2 })
  }

  return (
    <div className={`${styles.regions}${className ? ` ${className}` : ''}`} role="toolbar" aria-label="Panels" data-testid="titlebar-regions">
      {REGION_TOGGLES.map((id) => <RegionToggle key={id} id={id} />)}
      <DetailDockToggle />
      <span className={styles.divider} aria-hidden="true" />
      <Button
        size="sm"
        variant="ghost"
        glyph={<IcCaretDown />}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        hint="Tools: Sample Sandbox, Quick Notation, Split Syllables and your own launchers"
        hintMods="F10 opens the Sample Sandbox"
        onClick={openMenu}
      >
        Tools
      </Button>
      {menu ? (
        <Menu x={menu.x} y={menu.y} onClose={closeMenu} label="Tools">
          {TOOL_PANELS.map((id) => <ToolItem key={id} id={id} />)}
          {launchers.length > 0 ? (
            <>
              <MenuSeparator />
              <MenuCustom><div className={styles.menuHead}>Launchers</div></MenuCustom>
              {launchers.map((launcher) => <LauncherItem key={launcher.id} launcher={launcher} />)}
            </>
          ) : null}
        </Menu>
      ) : null}
    </div>
  )
}
