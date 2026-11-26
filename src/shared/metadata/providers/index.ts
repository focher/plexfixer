/**
 * Every metadata service, and what is known about each of them.
 *
 * Three, and they are not alternatives so much as answers to different
 * questions. TMDB is a database: it will tell anybody about any film, and it
 * has to be asked about a title guessed out of a file name. Radarr and Sonarr
 * are the thing that put the file where it is: they are only useful to
 * somebody who runs them, and to that person they are *right*, because they
 * are not guessing.
 *
 * So the order here is not a preference between services. It is the order of
 * how much each one knows about the file in front of it, and `preferred` reads
 * it that way: a provider that matches by path is asked first, and the
 * database is what answers when none of them has heard of the file.
 *
 * The bar for adding a fourth is the one the subtitle list already sets: a
 * provider written against a guessed wire format is worse than no provider.
 * These three are written against TMDB's documentation and against Radarr's
 * and Sonarr's own OpenAPI documents, which are published in their
 * repositories.
 */

import { radarr, RADARR_ID } from './radarr.js'
import { sonarr, SONARR_ID } from './sonarr.js'
import { tmdb, TMDB_ID } from './tmdb.js'
import type { MetadataKind, MetadataProvider } from './types.js'

export const METADATA_PROVIDERS: readonly MetadataProvider[] = [radarr, sonarr, tmdb]

export function metadataProviderById(id: string): MetadataProvider | undefined {
  return METADATA_PROVIDERS.find((provider) => provider.id === id)
}

/**
 * Which providers could answer about this kind of thing, best first.
 *
 * "Best" means knowing rather than guessing: a provider that identifies a file
 * by where it is comes before one that identifies it by what it is called.
 * Ties keep the order of the list, so this is stable.
 */
export function preferred(kind: MetadataKind, enabled: readonly string[]): MetadataProvider[] {
  return METADATA_PROVIDERS.filter(
    (provider) => provider.kinds.includes(kind) && enabled.includes(provider.id)
  ).sort((a, b) => Number(b.matchesByPath) - Number(a.matchesByPath))
}

export { radarr, RADARR_ID, sonarr, SONARR_ID, tmdb, TMDB_ID }
export * from './types.js'
