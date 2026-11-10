#!/usr/bin/env node
/**
 * Survey a media library and report every codec, container and stream property
 * it contains.
 *
 * The output is the input to trimming ffmpeg: a minimal build has to enable
 * exactly the demuxers, decoders, encoders and filters a real library needs,
 * and guessing that list from memory is how you ship something that cannot open
 * one file in fifty.
 *
 * Usage:
 *   node scripts/survey-library.mjs /path/to/Movies [/path/to/TV ...]
 *   node scripts/survey-library.mjs --json survey.json /path/to/Movies
 *   node scripts/survey-library.mjs --all-files /path/to/Movies   (every extension)
 */

import { spawn } from 'node:child_process'
import { open, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpus, platform, arch } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Extensions worth probing by default. */
const MEDIA_EXTENSIONS = new Set([
  '.mkv', '.mp4', '.m4v', '.avi', '.mov', '.wmv', '.ts', '.m2ts', '.mts',
  '.mpg', '.mpeg', '.vob', '.flv', '.webm', '.ogm', '.divx', '.asf', '.3gp', '.rmvb'
])

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2)
const roots = []
let jsonPath = 'plexfixer-survey.json'
let allFiles = false
let verbose = false
let concurrency = Math.max(2, Math.min(8, cpus().length))

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--json') jsonPath = argv[++i]
  else if (arg === '--all-files') allFiles = true
  else if (arg === '--verbose' || arg === '-v') verbose = true
  else if (arg === '--jobs') concurrency = Math.max(1, Number(argv[++i]) || 4)
  else if (arg === '--help' || arg === '-h') {
    console.log('usage: node scripts/survey-library.mjs [--json out.json] [--all-files] [--verbose] [--jobs N] <folder...>')
    process.exit(0)
  } else roots.push(arg)
}

if (roots.length === 0) {
  console.error('error: give me at least one folder to survey.\n')
  console.error('  node scripts/survey-library.mjs "/Volumes/Media/Movies" "/Volumes/Media/TV"')
  process.exit(2)
}

/* ------------------------------------------------------------------ *
 * Locating ffprobe
 * ------------------------------------------------------------------ */

function findFfprobe() {
  if (process.env.FFPROBE && existsSync(process.env.FFPROBE)) return process.env.FFPROBE

  const exe = platform() === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  const bundled = join(HERE, '..', 'resources', 'bin', `${platform()}-${arch()}`, exe)
  if (existsSync(bundled)) return bundled

  // Inside an installed app, resources/bin sits next to the asar.
  for (const candidate of [
    join(HERE, '..', '..', 'bin', `${platform()}-${arch()}`, exe),
    '/opt/homebrew/bin/ffprobe',
    '/usr/local/bin/ffprobe',
    '/usr/bin/ffprobe'
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return exe // fall back to PATH
}

const FFPROBE = findFfprobe()

/* ------------------------------------------------------------------ *
 * Walking
 * ------------------------------------------------------------------ */

let foldersVisited = 0
const unreadable = []

/**
 * What a directory entry actually is.
 *
 * `readdir(withFileTypes)` answers from the directory entry alone, which is
 * fast but incomplete: a symlink to a folder reports neither `isDirectory()`
 * nor `isFile()`, and SMB, NFS and several FUSE filesystems report every entry
 * as unknown. Either case silently prunes whole branches of a library, so
 * anything that is not plainly a file or a folder gets a real `stat()`.
 */
async function kindOf(full, entry) {
  if (entry.isDirectory()) return 'dir'
  if (entry.isFile()) return 'file'
  try {
    const info = await stat(full) // follows symlinks
    if (info.isDirectory()) return 'dir'
    if (info.isFile()) return 'file'
  } catch {
    // Broken symlink or no permission: not worth reporting per entry.
  }
  return 'other'
}

async function collect(root) {
  const found = []
  const stack = [root]
  // Symlinks can point back up the tree; walking the same real folder twice
  // would double every tally and, in a cycle, never finish.
  const seen = new Set()

  while (stack.length > 0) {
    const dir = stack.pop()

    let key = dir
    try {
      key = await realpath(dir)
    } catch {
      // Keep the literal path as the key if it cannot be resolved.
    }
    if (seen.has(key)) continue
    seen.add(key)

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      unreadable.push({ path: dir, error: error.message })
      continue // skip rather than abort the survey
    }
    foldersVisited++
    if (verbose) process.stderr.write(`  ${dir}  (${entries.length} entries)\n`)

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '@eaDir') continue
      const full = join(dir, entry.name)
      const kind = await kindOf(full, entry)
      if (kind === 'dir') stack.push(full)
      else if (kind === 'file') {
        if (allFiles || MEDIA_EXTENSIONS.has(extname(entry.name).toLowerCase())) found.push(full)
      }
    }
  }
  return found
}

/* ------------------------------------------------------------------ *
 * Probing
 * ------------------------------------------------------------------ */

function probe(path) {
  return new Promise((resolveProbe) => {
    const child = spawn(
      FFPROBE,
      ['-hide_banner', '-loglevel', 'error', '-print_format', 'json',
       '-show_format', '-show_streams', path],
      { windowsHide: true }
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('error', (error) => resolveProbe({ error: error.message }))
    child.on('close', (code) => {
      if (code !== 0) return resolveProbe({ error: err.trim().split('\n')[0] || `ffprobe exited ${code}` })
      try {
        resolveProbe({ data: JSON.parse(out) })
      } catch (error) {
        resolveProbe({ error: `unparseable ffprobe output: ${error.message}` })
      }
    })
  })
}

/* ------------------------------------------------------------------ *
 * Faststart
 * ------------------------------------------------------------------ */

/**
 * Whether an MP4's `moov` atom precedes `mdat`.
 *
 * ffprobe does not report this, and in an all-MP4 library it is usually the
 * single biggest reason a remote client stalls, so the top-level box chain is
 * walked directly. Mirrors `hasFaststart` in src/main/ffmpeg/probe.ts.
 */
async function hasFaststart(filePath) {
  let handle
  try {
    handle = await open(filePath, 'r')
    const header = Buffer.alloc(16)
    let offset = 0
    const { size } = await handle.stat()

    for (let box = 0; box < 64 && offset + 8 <= size; box++) {
      const { bytesRead } = await handle.read(header, 0, 16, offset)
      if (bytesRead < 8) return undefined

      let boxSize = header.readUInt32BE(0)
      const type = header.toString('latin1', 4, 8)
      if (!/^[\x20-\x7e]{4}$/.test(type)) return undefined

      let headerSize = 8
      if (boxSize === 1) {
        if (bytesRead < 16) return undefined
        boxSize = header.readUInt32BE(8) * 2 ** 32 + header.readUInt32BE(12)
        headerSize = 16
      } else if (boxSize === 0) {
        return type === 'moov' ? true : type === 'mdat' ? false : undefined
      }

      if (type === 'moov') return true
      if (type === 'mdat') return false
      if (boxSize < headerSize) return undefined
      offset += boxSize
    }
    return undefined
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

/* ------------------------------------------------------------------ *
 * Tallies
 * ------------------------------------------------------------------ */

const tally = {
  containers: new Map(),
  extensions: new Map(),
  video: new Map(),
  videoProfiles: new Map(),
  pixFmts: new Map(),
  videoTags: new Map(),
  videoLevels: new Map(),
  resolutions: new Map(),
  fieldOrders: new Map(),
  colorTransfers: new Map(),
  audio: new Map(),
  audioProfiles: new Map(),
  channelLayouts: new Map(),
  sampleRates: new Map(),
  subtitles: new Map(),
  attachments: new Map(),
  dataCodecs: new Map(),
  languages: new Map()
}

const bump = (map, key) => {
  if (key == null || key === '') return
  map.set(String(key), (map.get(String(key)) ?? 0) + 1)
}

const notes = {
  dolbyVision: 0,
  hdr10: 0,
  interlaced: 0,
  anamorphic: 0,
  coverArt: 0,
  multiVideo: 0,
  // Per-file counts: these decide how much work a library actually needs,
  // which stream-level tallies cannot show.
  faststart: 0,
  notFaststart: 0,
  faststartUnknown: 0,
  hevcNeedingRetag: 0,
  noAacTrack: 0,
  noAudioAtAll: 0
}
const errors = []
let filesProbed = 0

function record(path, data, faststart) {
  const format = data.format ?? {}
  if (faststart === true) notes.faststart++
  else if (faststart === false) notes.notFaststart++
  else notes.faststartUnknown++

  let audioTracks = 0
  let aacTracks = 0
  let wrongHevcTag = false
  bump(tally.containers, format.format_name)
  bump(tally.extensions, extname(path).toLowerCase())

  let realVideo = 0
  for (const stream of data.streams ?? []) {
    const lang = stream.tags?.language
    if (lang) bump(tally.languages, lang)

    switch (stream.codec_type) {
      case 'video': {
        const isArt =
          stream.disposition?.attached_pic === 1 ||
          ['mjpeg', 'png', 'bmp', 'gif', 'webp'].includes(stream.codec_name)
        if (isArt) {
          notes.coverArt++
          bump(tally.attachments, `${stream.codec_name} (cover art)`)
          break
        }
        realVideo++
        // Dolby Vision is signalled either by side data or by the codec tag;
        // the tag is what Apple clients actually read.
        const tag = (stream.codec_tag_string ?? '').toLowerCase()
        if (['dvh1', 'dvhe'].includes(tag)) notes.dolbyVision++
        if (stream.codec_name === 'hevc' && tag && tag !== 'hvc1') wrongHevcTag = true
        bump(tally.video, stream.codec_name)
        bump(tally.videoProfiles, `${stream.codec_name} / ${stream.profile ?? 'n/a'}`)
        bump(tally.pixFmts, stream.pix_fmt)
        if (stream.codec_tag_string && !/^\[0\]/.test(stream.codec_tag_string)) {
          bump(tally.videoTags, `${stream.codec_name} / ${stream.codec_tag_string}`)
        }
        if (stream.level != null && stream.level > 0) bump(tally.videoLevels, `${stream.codec_name} / ${stream.level}`)
        if (stream.width && stream.height) bump(tally.resolutions, `${stream.width}x${stream.height}`)
        if (stream.field_order && stream.field_order !== 'progressive') {
          bump(tally.fieldOrders, stream.field_order)
          notes.interlaced++
        }
        if (stream.color_transfer) bump(tally.colorTransfers, stream.color_transfer)
        if (['smpte2084', 'arib-std-b67'].includes(stream.color_transfer)) notes.hdr10++
        if (stream.sample_aspect_ratio && !['1:1', '0:1', ''].includes(stream.sample_aspect_ratio)) notes.anamorphic++
        for (const side of stream.side_data_list ?? []) {
          // ffprobe writes "DOVI configuration record", not "Dolby Vision".
          if (/dovi|dolby vision/i.test(String(side.side_data_type ?? ''))) {
            if (!['dvh1', 'dvhe'].includes(tag)) notes.dolbyVision++
          }
        }
        break
      }
      case 'audio':
        audioTracks++
        if (stream.codec_name === 'aac') aacTracks++
        bump(tally.audio, stream.codec_name)
        bump(tally.audioProfiles, `${stream.codec_name} / ${stream.profile ?? 'n/a'}`)
        bump(tally.channelLayouts, stream.channel_layout ?? `${stream.channels}ch`)
        bump(tally.sampleRates, stream.sample_rate)
        break
      case 'subtitle':
        bump(tally.subtitles, stream.codec_name)
        break
      case 'attachment':
        bump(tally.attachments, stream.codec_name ?? 'attachment')
        break
      case 'data':
        bump(tally.dataCodecs, stream.codec_name ?? 'data')
        break
      default:
        break
    }
  }
  if (realVideo > 1) notes.multiVideo++
  if (wrongHevcTag) notes.hevcNeedingRetag++
  if (audioTracks === 0) notes.noAudioAtAll++
  else if (aacTracks === 0) notes.noAacTrack++
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

const started = Date.now()
process.stderr.write(`ffprobe: ${FFPROBE}\nscanning…\n`)

const files = []
const perRoot = []
for (const root of roots) {
  const absolute = resolve(root)
  const before = files.length
  try {
    const info = await stat(absolute)
    if (info.isDirectory()) files.push(...(await collect(absolute)))
    else files.push(absolute)
  } catch (error) {
    console.error(`cannot read ${absolute}: ${error.message}`)
    console.error('  (quote the path if it contains spaces, and drop any trailing slash or backslash)')
  }
  perRoot.push({ root: absolute, files: files.length - before })
}

// Say what each root contributed: a root that returns nothing is the signal
// that the path is wrong or the folder holds no media, not that the walk failed.
for (const entry of perRoot) {
  process.stderr.write(`  ${entry.root}  →  ${entry.files} media file${entry.files === 1 ? '' : 's'}\n`)
}
process.stderr.write(`${files.length} media files found in ${foldersVisited} folder${foldersVisited === 1 ? '' : 's'}\n`)
if (unreadable.length > 0) {
  process.stderr.write(`${unreadable.length} folder${unreadable.length === 1 ? '' : 's'} could not be read (listed at the end)\n`)
}
if (files.length === 0) {
  console.error('\nNothing to probe. Re-run with --verbose to see which folders were walked,')
  console.error('or with --all-files if your media uses an extension outside the known set.')
  process.exit(1)
}

let cursor = 0
async function worker() {
  for (;;) {
    const index = cursor++
    if (index >= files.length) return
    const path = files[index]
    const { data, error } = await probe(path)
    if (error) errors.push({ path, error })
    else record(path, data, await hasFaststart(path))
    filesProbed++
    if (filesProbed % 25 === 0 || filesProbed === files.length) {
      process.stderr.write(`\r  probed ${filesProbed}/${files.length}`)
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker))
process.stderr.write('\n\n')

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

const sorted = (map) => [...map.entries()].sort((a, b) => b[1] - a[1])

function printSection(title, map) {
  const rows = sorted(map)
  console.log(`## ${title} (${rows.length})`)
  if (rows.length === 0) console.log('  (none)')
  for (const [key, count] of rows) console.log(`  ${String(count).padStart(6)}  ${key}`)
  console.log('')
}

console.log('# PlexFixer library survey')
console.log('')
console.log(`generated    ${new Date().toISOString()}`)
console.log(`host         ${platform()}-${arch()}`)
console.log(`roots        ${roots.join(', ')}`)
console.log(`folders      ${foldersVisited} walked, ${unreadable.length} unreadable`)
console.log(`files        ${files.length} probed, ${errors.length} failed`)
console.log(`elapsed      ${((Date.now() - started) / 1000).toFixed(1)}s`)
console.log('')

printSection('Containers (format_name)', tally.containers)
printSection('File extensions', tally.extensions)
printSection('Video codecs', tally.video)
printSection('Video codec / profile', tally.videoProfiles)
printSection('Video codec tags', tally.videoTags)
printSection('Video codec / level', tally.videoLevels)
printSection('Pixel formats', tally.pixFmts)
printSection('Resolutions', tally.resolutions)
printSection('Colour transfer (HDR detection)', tally.colorTransfers)
printSection('Interlaced field orders', tally.fieldOrders)
printSection('Audio codecs', tally.audio)
printSection('Audio codec / profile', tally.audioProfiles)
printSection('Channel layouts', tally.channelLayouts)
printSection('Sample rates', tally.sampleRates)
printSection('Subtitle codecs', tally.subtitles)
printSection('Attachments and cover art', tally.attachments)
printSection('Data streams', tally.dataCodecs)
printSection('Track languages', tally.languages)

console.log('## Per-file counts (what a repair run would actually touch)')
console.log(`  MP4 index already at the front         ${notes.faststart}`)
console.log(`  MP4 index at the end (needs faststart) ${notes.notFaststart}`)
console.log(`  index position undetermined            ${notes.faststartUnknown}`)
console.log(`  HEVC carrying a tag other than hvc1    ${notes.hevcNeedingRetag}`)
console.log(`  files with no AAC audio track          ${notes.noAacTrack}`)
console.log(`  files with no audio at all             ${notes.noAudioAtAll}`)
console.log('')

console.log('## Notable')
console.log(`  files with Dolby Vision side data   ${notes.dolbyVision}`)
console.log(`  files with HDR10/HLG transfer       ${notes.hdr10}`)
console.log(`  interlaced video streams            ${notes.interlaced}`)
console.log(`  anamorphic video streams            ${notes.anamorphic}`)
console.log(`  embedded cover-art streams          ${notes.coverArt}`)
console.log(`  files with >1 real video stream     ${notes.multiVideo}`)
console.log('')

if (errors.length > 0) {
  console.log(`## Files ffprobe could not read (${errors.length})`)
  for (const entry of errors.slice(0, 40)) console.log(`  ${entry.path}\n      ${entry.error}`)
  if (errors.length > 40) console.log(`  … and ${errors.length - 40} more`)
  console.log('')
}

if (unreadable.length > 0) {
  console.log(`## Folders that could not be read (${unreadable.length})`)
  for (const entry of unreadable.slice(0, 40)) console.log(`  ${entry.path}\n      ${entry.error}`)
  if (unreadable.length > 40) console.log(`  … and ${unreadable.length - 40} more`)
  console.log('')
}

const payload = {
  generated: new Date().toISOString(),
  host: `${platform()}-${arch()}`,
  roots,
  fileCount: files.length,
  folderCount: foldersVisited,
  perRoot,
  errorCount: errors.length,
  unreadableFolders: unreadable.slice(0, 200),
  notes,
  tallies: Object.fromEntries(Object.entries(tally).map(([key, map]) => [key, Object.fromEntries(sorted(map))])),
  errors: errors.slice(0, 200)
}
await writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8')
console.log(`Full detail written to ${resolve(jsonPath)}`)
console.log('Share that file (or the text above) and the ffmpeg build can be cut to fit.')
