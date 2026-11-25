/**
 * Row action icons. Inline SVG drawn on a 16px grid with `currentColor`, so
 * they follow the button's text colour, including its disabled state.
 */

type IconProps = { className?: string }

function Svg(props: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      className={props.className}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {props.children}
    </svg>
  )
}

/** Re-scan. */
export function RefreshIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5v3h-3" />
    </Svg>
  )
}

/** Safe remux: a lossless fix. */
export function WrenchIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M10.2 2.3a3.5 3.5 0 0 0-4.4 4.4L2.3 10.2a1.5 1.5 0 0 0 2.1 2.1l3.5-3.5a3.5 3.5 0 0 0 4.4-4.4l-2 2-1.9-.4-.4-1.9 2.2-1.8z" />
    </Svg>
  )
}

/** Force transcode: re-encode. */
export function BoltIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M9 1.5 3 9h4.5L7 14.5 13 7H8.5L9 1.5z" />
    </Svg>
  )
}

/** Search. */
export function SearchIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </Svg>
  )
}

/** The filter menu: a funnel. */
export function FilterIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M2 3h12l-4.5 5.5v4.2L6.5 14V8.5L2 3z" />
    </Svg>
  )
}

/** Show the file where it lives. */
export function FolderIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M1.75 12.5v-9h4l1.5 2h7v7a.5.5 0 0 1-.5.5h-12a.5.5 0 0 1-.5-.5z" />
    </Svg>
  )
}

/** Copy the report. */
export function CopyIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.3" />
      <path d="M10.5 3.5v-.8a.7.7 0 0 0-.7-.7H3.2a.7.7 0 0 0-.7.7v6.6c0 .4.3.7.7.7h.8" />
    </Svg>
  )
}

/** Edit the metadata. */
export function PencilIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M11.3 2.2a1.3 1.3 0 0 1 1.9 0l.6.6a1.3 1.3 0 0 1 0 1.9L5.5 12.9 2.5 13.5l.6-3 8.2-8.3z" />
    </Svg>
  )
}

/** Technical details, on hover. */
export function InfoIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.2v4" />
      <path d="M8 4.9v.1" />
    </Svg>
  )
}

/** Add a subtitle track. */
export function PlusIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </Svg>
  )
}

/** Put a subtitle back in time with the audio. */
export function SyncIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M2.6 6.6A5.5 5.5 0 0 1 12 4.4" />
      <path d="M13.4 9.4A5.5 5.5 0 0 1 4 11.6" />
      <path d="M12.2 1.9v2.6H9.6M3.8 14.1v-2.6h2.6" />
    </Svg>
  )
}

/** Translate a track. */
export function TranslateIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M1.9 3.6h6.2M5 2.2v1.4M6.6 3.6c0 2.7-2 4.9-4.7 5.4" />
      <path d="M3.3 6.3c.8 1.5 2.2 2.6 3.9 3" />
      <path d="M8.2 13.8l2.9-7 2.9 7M9.4 11.5h3.4" />
    </Svg>
  )
}

/** The default track. */
export function CheckIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3 8.4l3.2 3.2L13 4.8" />
    </Svg>
  )
}

/** Look this film or episode up, and fill in what it says about itself. */
export function TagIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M2.2 7.4V2.6a.4.4 0 0 1 .4-.4h4.8L13.4 8 8 13.4 2.2 7.4z" />
      <path d="M4.9 4.9v.01" />
    </Svg>
  )
}

/** Stop a repair that is queued or running. */
export function StopIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.6" />
    </Svg>
  )
}

/**
 * Drag this waiting repair to another place in the queue.
 *
 * Dots rather than lines: the conventional grip, and the one thing on a row
 * that reads as "take hold of this" without a label.
 */
export function GripIcon(props: IconProps): React.JSX.Element {
  return (
    <svg
      className={props.className}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="6" cy="4" r="1.3" />
      <circle cx="10" cy="4" r="1.3" />
      <circle cx="6" cy="8" r="1.3" />
      <circle cx="10" cy="8" r="1.3" />
      <circle cx="6" cy="12" r="1.3" />
      <circle cx="10" cy="12" r="1.3" />
    </svg>
  )
}
