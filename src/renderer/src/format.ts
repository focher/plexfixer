/** Display helpers shared across the UI. */

export function formatDuration(seconds: number | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—'
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

export function formatBitrate(bitsPerSecond: number | undefined): string {
  if (bitsPerSecond == null || !Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return '—'
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`
  return `${Math.round(bitsPerSecond / 1000)} kbps`
}

/** Shorten a long path for display, keeping the filename intact. */
export function shortenPath(path: string, maxSegments = 3): string {
  const separator = path.includes('\\') ? '\\' : '/'
  const segments = path.split(separator).filter(Boolean)
  if (segments.length <= maxSegments) return path
  return `…${separator}${segments.slice(-maxSegments).join(separator)}`
}

export function parentDirectory(path: string): string {
  const separator = path.includes('\\') ? '\\' : '/'
  const index = path.lastIndexOf(separator)
  return index > 0 ? path.slice(0, index) : path
}

export { formatAgo } from '@shared/time.js'
export { formatAudioCodec, formatBytes, formatVideoCodec } from '@shared/display.js'
