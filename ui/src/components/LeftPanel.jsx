import { useState, useCallback } from 'react'
import { FolderOpen, Music, Grid3x3 } from 'lucide-react'
import ProjectMediaTab from './ProjectMediaTab.jsx'
import SampleSelectorTab from './SampleSelectorTab.jsx'
import GridLayoutTab from './GridLayoutTab.jsx'

const TABS = [
  { id: 'media',   label: 'Project Media',   icon: FolderOpen },
  { id: 'samples', label: 'Sample Selector',  icon: Music },
  { id: 'grid',    label: 'Grid Settings',    icon: Grid3x3 },
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
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`left-panel-tab ${activeTab === id ? 'active' : ''}`}
            onClick={() => handleTabSwitch(id)}
            title={label}
          >
            <Icon size={14} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div className="left-panel-content">
        {activeTab === 'media'   && <ProjectMediaTab onOpenPicker={onOpenPicker} />}
        {activeTab === 'samples' && <SampleSelectorTab onOpenPicker={onOpenPicker} activeSampleId={activeSampleId} setActiveSampleId={setActiveSampleId} />}
        {activeTab === 'grid'    && <GridLayoutTab />}
      </div>
    </div>
  )
}
