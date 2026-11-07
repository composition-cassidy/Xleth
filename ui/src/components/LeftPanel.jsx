import { useState, useCallback } from 'react'
import ProjectMediaTab from './ProjectMediaTab.jsx'
import SampleSelectorTab from './SampleSelectorTab.jsx'
import SearchField from './browser/SearchField.jsx'
import { MediaIcon, SamplerIcon, Tabs } from '../ui-kit'
import useBrowserStore from '../stores/browserStore.js'
import styles from './browser/Browser.module.css'

// Media = the project's imported sources; Samples = the regions marked on them.
export const BROWSER_TABS = [
  {
    id: 'media',
    label: 'Media',
    title: 'Project media',
    glyph: <MediaIcon size={14} />,
    hint: 'Project media: the audio and video sources imported into this project',
    controls: 'browser-pane-media',
  },
  {
    id: 'samples',
    label: 'Samples',
    title: 'Samples',
    glyph: <SamplerIcon size={14} />,
    hint: 'Samples: the regions you marked on your sources, grouped by label',
    controls: 'browser-pane-samples',
  },
]

export default function LeftPanel({ onOpenPicker, activeSampleId, setActiveSampleId, orientation = 'vertical', tab: forcedTab }) {
  // `tab` pins the tab (the Gallery shows both at once); the app leaves it to the store.
  const storeTab = useBrowserStore((s) => s.tab)
  const setStoreTab = useBrowserStore((s) => s.setTab)
  const tab = forcedTab ?? storeTab
  const setTab = forcedTab ? () => {} : setStoreTab
  const [queries, setQueries] = useState({ media: '', samples: '' })

  const setQuery = useCallback((which) => (value) => {
    setQueries((prev) => ({ ...prev, [which]: value }))
  }, [])

  return (
    <div className={styles.browser} data-orientation={orientation}>
      <Tabs label="Browser" tabs={BROWSER_TABS} value={tab} onChange={setTab} />
      <div className={styles.searchRow}>
        <SearchField
          key={tab}
          tab={tab}
          value={queries[tab]}
          onChange={setQuery(tab)}
          placeholder={tab === 'media' ? 'Search media' : 'Search samples'}
          ariaLabel={tab === 'media' ? 'Search media' : 'Search samples'}
        />
      </div>
      <div className={styles.panes}>
        {/* Both tabs stay mounted so their lists, selection and scroll survive a tab switch. */}
        <div
          id="browser-pane-media"
          role="tabpanel"
          aria-labelledby="tab-media"
          className={styles.pane}
          hidden={tab !== 'media'}
        >
          <ProjectMediaTab onOpenPicker={onOpenPicker} query={queries.media} />
        </div>
        <div
          id="browser-pane-samples"
          role="tabpanel"
          aria-labelledby="tab-samples"
          className={styles.pane}
          hidden={tab !== 'samples'}
        >
          <SampleSelectorTab
            onOpenPicker={onOpenPicker}
            activeSampleId={activeSampleId}
            setActiveSampleId={setActiveSampleId}
            query={queries.samples}
          />
        </div>
      </div>
    </div>
  )
}
