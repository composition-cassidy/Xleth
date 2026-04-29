import { useEffect, useRef } from 'react'

const NC_ITEMS = [
  { id: 'bounce',     label: 'Bounce'          },
  { id: 'zoomPanRot', label: 'Zoom/Pan/Rot'    },
  { id: 'pingPong',   label: 'Ping-Pong Loop'  },
]

const C_ITEMS = [
  { typeId: 0, label: 'Desaturation'            },
  { typeId: 1, label: 'Tint'                    },
  { typeId: 2, label: 'Brightness & Contrast'   },
  { typeId: 3, label: 'TV Simulator'            },
  { typeId: 4, label: 'Zoom/Pan/Rot (per-cell)' },
]

export default function VisualFXAddDropdown({
  open, shownList, onAddNonChainable, onAddChainable, onClose,
}) {
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onMouse = (e) => { if (!ref.current?.contains(e.target)) onClose() }
    const onKey   = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onMouse)
    document.addEventListener('keydown',   onKey)
    return () => {
      document.removeEventListener('mousedown', onMouse)
      document.removeEventListener('keydown',   onKey)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div ref={ref} className="fx-dropdown">
      {NC_ITEMS.map(item => {
        const isShown = shownList.includes(item.id)
        return (
          <div
            key={item.id}
            className={`fx-dropdown-item ${isShown ? 'shown' : ''}`}
            onClick={isShown ? undefined : () => onAddNonChainable(item.id)}
          >
            {isShown && <span className="fx-dropdown-check">✓</span>}
            {item.label}
          </div>
        )
      })}
      <div className="fx-dropdown-divider" />
      {C_ITEMS.map(item => (
        <div
          key={item.typeId}
          className="fx-dropdown-item"
          onClick={async () => {
            const added = await onAddChainable(item.typeId)
            if (added !== false) onClose()
          }}
        >
          {item.label}
        </div>
      ))}
    </div>
  )
}
