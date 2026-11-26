/**
 * Every subtitle service, and what is known about each of them.
 *
 * Two, and they answer different questions. OpenSubtitles is a place subtitles
 * come from: it will tell anybody about any film, and it matches on the file's
 * own hash, which is the best identification there is. Bazarr is not a place
 * subtitles come from at all — it is the thing that already has an account at
 * every such place, with your providers, your languages and your scoring set
 * up once. Asking it is asking all of them under rules you already decided on,
 * and it is only useful to somebody who runs it.
 *
 * The bar for a third is the one this list has always set: a provider written
 * against a guessed wire format is worse than no provider. OpenSubtitles'
 * format is documented; Bazarr's was read out of its own source, and it
 * publishes the same thing at `/api/swaggerui` on any running instance. Two
 * others were looked at and are not here — Podnapisi, whose remaining
 * interface is an XML endpoint its own users report as unreliable for
 * downloads, and SubDL, whose documentation refuses to be read by anything
 * that is not a browser. Either would take about an hour with an account and a
 * network log, and neither should be guessed at.
 *
 * `local` is not a service. It is here because "what subtitles does this film
 * already have" is the same question asked of the disk instead of the network,
 * and the answer belongs in the same list.
 */

import { bazarr, BAZARR_ID } from './bazarr.js'
import { openSubtitles, OPENSUBTITLES_ID } from './opensubtitles.js'
import type { SubtitleProvider } from './types.js'

export const PROVIDERS: readonly SubtitleProvider[] = [openSubtitles, bazarr]

export function providerById(id: string): SubtitleProvider | undefined {
  return PROVIDERS.find((provider) => provider.id === id)
}

export { BAZARR_ID, bazarr, OPENSUBTITLES_ID, openSubtitles }
export * from './types.js'
