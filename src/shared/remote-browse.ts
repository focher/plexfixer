/**
 * Where the remote file browser opens.
 *
 * With nothing set it opens in the account's home directory, which is almost
 * never where a library is: media usually sits several levels down a mount
 * point, and walking there from home every time is most of the browsing. A
 * default folder makes the browser open where the files actually are.
 *
 * The home directory is only known after asking the far end, so "nothing
 * chosen" is returned as an empty string rather than guessed at here.
 */

/**
 * The folder to list: the one asked for, else the default folder, else blank
 * for the account's home.
 */
export function startDirectory(requested?: string | null, preferred?: string | null): string {
  const asked = typeof requested === 'string' ? requested.trim() : ''
  if (asked) return asked
  const fallback = typeof preferred === 'string' ? preferred.trim() : ''
  return fallback
}
