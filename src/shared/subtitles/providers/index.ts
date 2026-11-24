/**
 * Every subtitle service, and what is known about each of them.
 *
 * One at the moment, which wants saying plainly rather than hidden behind a
 * plural. The interface in `types.ts` exists so that adding another is a file
 * beside this one and a line in the list, and the reason there is not a second
 * already is not architecture: it is that a provider written against a guessed
 * wire format is worse than no provider. OpenSubtitles' is documented and was
 * checked. Two others were looked at and are not here — Podnapisi, whose
 * remaining interface is an XML endpoint its own users report as unreliable
 * for downloads, and SubDL, whose documentation refuses to be read by anything
 * that is not a browser. Either would take about an hour with an account and a
 * network log, and neither should be guessed at.
 *
 * `local` is not a service. It is here because "what subtitles does this film
 * already have" is the same question asked of the disk instead of the network,
 * and the answer belongs in the same list.
 */

import { openSubtitles, OPENSUBTITLES_ID } from './opensubtitles.js'
import type { SubtitleProvider } from './types.js'

export const PROVIDERS: readonly SubtitleProvider[] = [openSubtitles]

export function providerById(id: string): SubtitleProvider | undefined {
  return PROVIDERS.find((provider) => provider.id === id)
}

export { OPENSUBTITLES_ID, openSubtitles }
export * from './types.js'
