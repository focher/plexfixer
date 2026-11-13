import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Open/closed state for a dropdown, closing on a click outside it or Escape.
 * Put `rootRef` on the element that holds both the trigger and the popover.
 */
export function usePopover<T extends HTMLElement = HTMLDivElement>(): {
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
  rootRef: React.RefObject<T | null>
} {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<T>(null)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const toggle = useCallback(() => setOpen((previous) => !previous), [])
  return { open, setOpen, toggle, rootRef }
}
