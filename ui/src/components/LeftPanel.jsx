import { useState, useCallback } from 'react'
import { FolderOpen, Music } from 'lucide-react'
import ProjectMediaTab from './ProjectMediaTab.jsx'
import SampleSelectorTab from './SampleSelectorTab.jsx'
import { XlethButton } from './common/XlethButton.jsx'

const TABS = [
  { id: 'media',   label: 'MEDIA',   title: 'Project Media',    icon: FolderOpen },
  { id: 'samples', label: 'SAMPLES', title: 'Sample Selector',   icon: Music },
]

export default function LeftPanel({ onOpenPicker, activeSampleId, setActiveSampleId }) {
  const [activeTab, setActiveTab] = useState('media')

  const handleTabSwitch = useCallback((id) => {
    setActiveTab(id)
    console.log(`[UI] Left panel tab → ${id}`)
  }, [])

  return (
    <div className="left-panel">
      <div className="left-panel-tabs">
        {TABS.map(({ id, label, title, icon: Icon }) => (
          <XlethButton
            key={id}
            className={`left-panel-tab ${activeTab === id ? 'active' : ''}`}
            active={activeTab === id}
            onClick={() => handleTabSwitch(id)}
            title={title}
            aria-label={title}
          >
            <Icon size={14} />
            <span>{label}</span>
          </XlethButton>
        ))}
      </div>
      <div className="left-panel-content">
        <div style={{ display: activeTab === 'media' ? 'contents' : 'none' }}>
          <ProjectMediaTab onOpenPicker={onOpenPicker} />
        </div>
        <div style={{ display: activeTab === 'samples' ? 'contents' : 'none' }}>
          <SampleSelectorTab onOpenPicker={onOpenPicker} activeSampleId={activeSampleId} setActiveSampleId={setActiveSampleId} />
        </div>
      </div>
    </div>
  )
}
