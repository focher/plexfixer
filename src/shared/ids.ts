/**
 * Identifiers for jobs and scans.
 *
 * `crypto.randomUUID` is there in Node and in a secure-context webview, which
 * covers both shells — but a webview served over a scheme the browser decides
 * is not secure hides it, and a job that cannot be given an id is a repair
 * that cannot be started. The fallback is not a real UUID and does not need to
 * be: these ids are unique within one run of the app, not across the world.
 */
export function newId(): string {
  const api = globalThis.crypto
  if (api && typeof api.randomUUID === 'function') return api.randomUUID()
  const random = (): string => Math.random().toString(16).slice(2, 10)
  return `${Date.now().toString(16)}-${random()}-${random()}`
}
