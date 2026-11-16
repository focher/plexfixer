/**
 * Which GitHub repository the release scripts talk to.
 *
 * The `origin` remote is the answer nearly always. An explicit name and
 * `$GH_REPO` come first for the cases where it is not: a checkout whose origin
 * is a fork, or a CI job that knows its repository without having a remote
 * configured the way a developer's clone does.
 */

import { execFileSync } from 'node:child_process'

export function repository({ root, given } = {}) {
  const named = given ?? process.env.GH_REPO
  if (named) return named

  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: root,
      encoding: 'utf8',
    })
    const match = /github\.com[:/]+([^/]+\/[^/.\s]+)/.exec(url)
    if (match) return match[1]
  } catch {
    // No git, or no remote. The thrown error below says what to do about it.
  }

  throw new Error('Cannot tell which repository to use. Pass --repo owner/name.')
}
