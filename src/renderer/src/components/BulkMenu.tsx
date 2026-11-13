import { usePopover } from '../usePopover.js'

export interface BulkMenuItem {
  key: string
  label: string
  /** A second, muted line: what the action does. */
  hint: string
  disabled?: boolean
  onSelect: () => void
}

export interface BulkMenuProps {
  /** Nothing selected: the button stays where it is, greyed out. */
  disabled: boolean
  items: BulkMenuItem[]
}

/**
 * The actions for the selected files, behind one button that never moves.
 * A row of buttons that appeared with a selection shifted the toolbar every
 * time a box was ticked.
 */
export default function BulkMenu(props: BulkMenuProps): React.JSX.Element {
  const { open, setOpen, toggle, rootRef } = usePopover()
  const isOpen = open && !props.disabled

  return (
    <div className="bulk-menu" ref={rootRef}>
      <button
        onClick={toggle}
        disabled={props.disabled}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title={props.disabled ? 'Select files to act on them' : 'Actions for the selected files'}
      >
        Bulk
        <span className="caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {isOpen ? (
        <div className="popover bulk-menu-popover" role="menu">
          {props.items.map((item) => (
            <button
              key={item.key}
              role="menuitem"
              className="bulk-item"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
            >
              <span className="bulk-label">{item.label}</span>
              <span className="bulk-hint">{item.hint}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
