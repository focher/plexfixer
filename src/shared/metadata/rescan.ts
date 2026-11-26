/**
 * Telling a library manager that a file it owns has been replaced.
 *
 * This is the integration that matters most and is least visible. PlexFixer
 * repairs `Dune (2021).mkv` into `Dune (2021).mp4` and moves the original into
 * the backup folder. Radarr's database still says the film is the `.mkv`: it
 * reports the film as missing, or as having a file that is not there, and on
 * its next search it will happily download a replacement for a film that is
 * sitting right where it left it.
 *
 * One command fixes that. `RescanMovie` makes Radarr look at the folder again
 * and record what is actually in it; `RescanSeries` does the same for Sonarr.
 * Neither downloads anything, neither renames anything, and both are what the
 * "Manual Import" button in their own interfaces runs.
 *
 * Pure, like the providers: these describe the request and read the reply, and
 * perform nothing. The command names and the `/api/v3/command` shape come from
 * Radarr's and Sonarr's own OpenAPI documents.
 */

import type { HttpReply, HttpRequest, ProviderProblem, ServiceCredential } from './providers/types.js'
import { asNumber, asRecord, asText, baseUrl, isProblem, readJson } from './providers/types.js'

export type RescanService = 'radarr' | 'sonarr'

const COMMAND: Record<RescanService, { name: string; idField: string; label: string }> = {
  radarr: { name: 'RescanMovie', idField: 'movieId', label: 'Radarr' },
  sonarr: { name: 'RescanSeries', idField: 'seriesId', label: 'Sonarr' }
}

/**
 * Ask the service to look at the folder again.
 *
 * `id` is the service's own id for the film or series — what the matching
 * provider returned, not a TMDB or TVDB id.
 */
export function rescanRequest(
  service: RescanService,
  credential: ServiceCredential,
  id: number
): HttpRequest | ProviderProblem {
  const command = COMMAND[service]
  const base = baseUrl(credential.url)
  if (!base) return { problem: `No ${command.label} address.`, needsLogin: true }
  if (!credential.apiKey) return { problem: `No ${command.label} API key.`, needsLogin: true }
  if (!Number.isInteger(id) || id <= 0) return { problem: `Not a ${command.label} id: ${id}` }

  return {
    url: `${base}/api/v3/command`,
    method: 'POST',
    headers: {
      'X-Api-Key': credential.apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ name: command.name, [command.idField]: id })
  }
}

/** What the service said about the command it was given. */
export interface RescanStarted {
  /** The command's own id, which could be polled; nothing here polls it. */
  id?: number
  /** `queued`, `started`, `completed` — whatever it reported at the time. */
  status?: string
}

export function readRescan(reply: HttpReply, service: RescanService): RescanStarted | ProviderProblem {
  const label = COMMAND[service].label
  if (reply.status === 401) {
    return { problem: `${label} rejected the API key.`, needsLogin: true }
  }
  /*
   * A command is accepted, not performed, so the useful answers are 201 and
   * 202. Anything else is worth reporting rather than swallowing: a 404 here
   * means the film was removed from the library while the repair ran, which
   * somebody would want to know about.
   */
  if (reply.status >= 400) return { problem: `${label} answered ${reply.status} to a rescan.` }

  const body = readJson(reply, label)
  // A command endpoint that answers with an empty body has still accepted it.
  if (isProblem(body)) return {}
  const record = asRecord(body)
  return { id: asNumber(record?.id), status: asText(record?.status) }
}
