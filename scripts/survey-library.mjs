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
import { readdir, stat, writeFile } from 'node:fs/promises'
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
let concurrency = Math.max(2, Math.min(8, cpus().length))

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--json') jsonPath = argv[++i]
  else if (arg === '--all-files') allFiles = true
  else if (arg === '--jobs') concurrency = Math.max(1, Number(argv[++i]) || 4)
  else if (arg === '--help' || arg === '-h') {
    console.log('usage: node scripts/survey-library.mjs [--json out.json] [--all-files] [--jobs N] <folder...>')
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

async function collect(root) {
  const found = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // unreadable directory: skip rather than abort the survey
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.name.startsWith('.') || entry.name === '@eaDir') continue
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
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

const notes = { dolbyVision: 0, hdr10: 0, interlaced: 0, anamorphic: 0, coverArt: 0, multiVideo: 0 }
const errors = []
let filesProbed = 0

function record(path, data) {
  const format = data.format ?? {}
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
          if (String(side.side_data_type ?? '').toLowerCase().includes('dolby vision')) notes.dolbyVision++
        }
        break
      }
      case 'audio':
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
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

const started = Date.now()
process.stderr.write(`ffprobe: ${FFPROBE}\nscanning…\n`)

const files = []
for (const root of roots) {
  const absolute = resolve(root)
  try {
    const info = await stat(absolute)
    if (info.isDirectory()) files.push(...(await collect(absolute)))
    else files.push(absolute)
  } catch {
    console.error(`cannot read ${absolute}`)
  }
}

process.stderr.write(`${files.length} media files found\n`)
if (files.length === 0) process.exit(1)

let cursor = 0
async function worker() {
  for (;;) {
    const index = cursor++
    if (index >= files.length) return
    const path = files[index]
    const { data, error } = await probe(path)
    if (error) errors.push({ path, error })
    else record(path, data)
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

const payload = {
  generated: new Date().toISOString(),
  host: `${platform()}-${arch()}`,
  roots,
  fileCount: files.length,
  errorCount: errors.length,
  notes,
  tallies: Object.fromEntries(Object.entries(tally).map(([key, map]) => [key, Object.fromEntries(sorted(map))])),
  errors: errors.slice(0, 200)
}
await writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8')
console.log(`Full detail written to ${resolve(jsonPath)}`)
console.log('Share that file (or the text above) and the ffmpeg build can be cut to fit.')
