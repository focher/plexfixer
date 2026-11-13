/**
 * Notarizing the macOS build.
 *
 * Signing and notarizing are different things, and only the second one stops
 * macOS refusing to open the app: a Developer ID signature says who built it,
 * notarization is Apple having scanned it and issued a ticket. Without the
 * ticket, every download is met with "Apple could not verify PlexFixer is free
 * of malware", and since Sequoia there is no Control-click way around it —
 * the user has to go into System Settings, or run `xattr` by hand.
 *
 * This runs after electron-builder signs each macOS app, and only then. It is
 * deliberately a no-op when no credentials are configured, so a local build
 * still works: the alternative is a build that fails on a machine that was
 * never going to notarize anything. When credentials *are* configured and
 * notarization fails, the build fails with it — a half-notarized release is
 * worse than an obviously unnotarized one.
 *
 * Credentials, in the gitignored `plexfixer.env`, either:
 *
 *   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
 *
 * (an app-specific password from appleid.apple.com, not the account password),
 * or an App Store Connect API key, which does not expire with the password:
 *
 *   APPLE_API_KEY (path to the .p8), APPLE_API_KEY_ID, APPLE_API_ISSUER
 *
 * Set PLEXFIXER_SKIP_NOTARIZE=1 to skip it for one build.
 */

import { notarize } from '@electron/notarize'

export default async function notarizeApp(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = `${context.appOutDir}/${appName}.app`

  if (process.env.PLEXFIXER_SKIP_NOTARIZE === '1') {
    console.log('  • notarization skipped       PLEXFIXER_SKIP_NOTARIZE=1')
    return
  }

  const {
    APPLE_ID,
    APPLE_APP_SPECIFIC_PASSWORD,
    APPLE_TEAM_ID,
    APPLE_API_KEY,
    APPLE_API_KEY_ID,
    APPLE_API_ISSUER
  } = process.env

  const withApiKey = APPLE_API_KEY && APPLE_API_KEY_ID && APPLE_API_ISSUER
  const withAppleId = APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID

  if (!withApiKey && !withAppleId) {
    console.log(
      '  • notarization skipped       no credentials in the environment; this build will warn on first launch'
    )
    return
  }

  // Apple's service takes minutes, not seconds, and says nothing meanwhile.
  console.log(`  • notarizing                 ${appName}.app (this takes a few minutes)`)
  const started = Date.now()

  await notarize(
    withApiKey
      ? {
          appPath,
          appleApiKey: APPLE_API_KEY,
          appleApiKeyId: APPLE_API_KEY_ID,
          appleApiIssuer: APPLE_API_ISSUER
        }
      : {
          appPath,
          appleId: APPLE_ID,
          appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
          teamId: APPLE_TEAM_ID
        }
  )

  console.log(`  • notarized                  in ${Math.round((Date.now() - started) / 1000)}s, ticket stapled`)
}
