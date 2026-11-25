/**
 * Reading a failed command's output down to one line.
 *
 * ffmpeg and ffprobe narrate as they work. Every decoder they instantiate can
 * complain on the way past, and the sentence saying why the file was actually
 * refused is printed last, after all of it. So the first line of stderr is
 * routinely the least useful line there is: a repair that ran for thirteen
 * minutes was once reported as
 *
 *     [aac @ 000001bbc3e450c0] skip_data_stream_element: Input buffer
 *     exhausted before END element found
 *
 * — a decoder's grumble — while the line below it named the real fault and was
 * thrown away. What a report needs is that line, with the rest kept beside it.
 */

/**
 * A component's running commentary, as opposed to a verdict.
 *
 * ffmpeg prefixes anything logged by a decoder, muxer or filter with the
 * component that said it: `[aac @ 0x7f...]`, `[mov,mp4,m4a @ ...]`. Its own
 * judgement on a file carries no such prefix — it reads `<file>: <reason>`.
 */
function isComponentChatter(line: string): boolean {
  return /^\[[^\]]*@[^\]]*\]/.test(line)
}

/**
 * A line introducing what comes after it rather than saying anything itself,
 * such as `…/ffprobe.exe exited with an error (exit 1):`.
 */
function isHeading(line: string): boolean {
  return line.endsWith(':')
}

/**
 * The one line worth putting in front of someone, out of everything printed.
 *
 * The last verdict, when there is one, because a tool reaches its conclusion
 * after it has finished complaining. Failing that, the last line that is not
 * merely introducing the others — still nearer the end of the story than the
 * first line is.
 */
export function summarizeToolFailure(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  if (lines.length === 0) return 'it printed nothing'

  // The heading is the caller's own framing, so it only stands in when there
  // is nothing underneath it to quote.
  const body = lines.filter((line) => !isHeading(line))
  const candidates = body.length > 0 ? body : lines

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (!isComponentChatter(candidates[index])) return candidates[index]
  }
  return candidates[candidates.length - 1]
}
