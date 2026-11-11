/** Time display helpers shared by the UI. */

/** How long ago a timestamp was, e.g. "just now", "5 min ago", "3 h ago", "2 d ago". */
export function formatAgo(timestamp: number | undefined, now: number): string {
  if (timestamp == null || !Number.isFinite(timestamp)) return '—'
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}
