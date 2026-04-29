export default function VisualFXSectionHeader({ shownCount, onClearAll, dropdownOpen, onToggleDropdown }) {
  return (
    <div className="fx-section-header">
      <span className="fx-section-title">Visual FX</span>
      <span className="fx-section-count">({shownCount})</span>
      {shownCount > 0 && (
        <button className="fx-clear-all" onClick={onClearAll}>clear all</button>
      )}
      <button className="fx-add-btn" onClick={onToggleDropdown}>
        + add effect {dropdownOpen ? '▲' : '▾'}
      </button>
    </div>
  )
}
