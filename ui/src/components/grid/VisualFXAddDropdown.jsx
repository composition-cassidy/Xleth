import { useEffect, useRef } from 'react'

const NC_ITEMS = [
  { id: 'bounce',     label: 'Bounce'          },
  { id: 'zoomPanRot', label: 'Zoom/Pan/Rot'    },
  { id: 'pingPong',   label: 'Ping-Pong Loop'  },
]

export default function VisualFXAddDropdown({
  open, shownList, onAddNonChainable, onClose,
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
    </div>
  )
}
