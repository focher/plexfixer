/**
 * Which machine this is, for the line at the top of a pasted report.
 *
 * The real answer lives in the main process, which knows rather than guesses;
 * this is the renderer's best effort for a report built on the spot, and it
 * only has to be good enough to tell a Windows path problem from a macOS one.
 * It was written out three times before it was worth a file of its own.
 */
export function thisPlatform(): string {
  const agent = navigator.userAgent
  if (agent.includes('Mac')) return 'macOS'
  if (agent.includes('Win')) return 'Windows'
  return 'Linux'
}
