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
