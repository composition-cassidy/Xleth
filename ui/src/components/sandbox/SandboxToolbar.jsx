import { MousePointer2, Scissors, Crop, Blend } from 'lucide-react'
import useSandboxStore from '../../stores/sandboxStore.js'

const TOOLS = [
  { id: 'select', label: 'Select', icon: MousePointer2 },
  { id: 'chop', label: 'Chop', icon: Scissors },
  { id: 'trim', label: 'Trim', icon: Crop },
  { id: 'fade', label: 'Fade', icon: Blend },
]

export default function SandboxToolbar() {
  const activeTool = useSandboxStore((s) => s.activeTool)
  const setActiveTool = useSandboxStore((s) => s.setActiveTool)

  return (
    <div className="sandbox-toolbar">
      {TOOLS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          className={`sandbox-tool-btn${activeTool === id ? ' active' : ''}`}
          onClick={() => setActiveTool(id)}
          title={label}
        >
          <Icon size={14} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  )
}
