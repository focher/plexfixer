import { describe, expect, it } from 'vitest'
import {
  cleanCueText,
  cuesDurationMs,
  decodeSubtitleBytes,
  formatSrt,
  formatTimecode,
  parseCues,
  parseTimecode,
  scaleCues,
  shiftCues
} from '@shared/subtitles/cues.js'

describe('timecodes', () => {
  it('reads the forms the three formats use', () => {
    expect(parseTimecode('00:01:02,500')).toBe(62_500)
    expect(parseTimecode('00:01:02.500')).toBe(62_500)
    // WebVTT may leave the hours off.
    expect(parseTimecode('01:02.500')).toBe(62_500)
    // ASS writes one digit of hours and two of hundredths.
    expect(parseTimecode('0:01:02.50')).toBe(62_500)
    expect(parseTimecode('1:00:00,000')).toBe(3_600_000)
  })

  it('reads the fraction as a fraction, not as milliseconds', () => {
    expect(parseTimecode('00:00:00.5')).toBe(500)
    expect(parseTimecode('00:00:00.05')).toBe(50)
    expect(parseTimecode('00:00:00.005')).toBe(5)
  })

  it('refuses what is not a timecode', () => {
    expect(parseTimecode('tomorrow')).toBeUndefined()
    expect(parseTimecode('')).toBeUndefined()
  })

  it('round trips', () => {
    for (const ms of [0, 1, 999, 62_500, 3_723_456]) {
      expect(parseTimecode(formatTimecode(ms))).toBe(ms)
    }
  })

  it('writes the form SRT is reliably read in', () => {
    expect(formatTimecode(3_723_456)).toBe('01:02:03,456')
  })
})

describe('parsing', () => {
  it('reads SRT, ignoring the sequence numbers', () => {
    const parsed = parseCues(
      ['7', '00:00:01,000 --> 00:00:03,000', 'First line', '', '3', '00:00:04,000 --> 00:00:05,500', 'Second', 'and third'].join('\n')
    )
    expect(parsed.format).toBe('srt')
    expect(parsed.cues).toEqual([
      { startMs: 1000, endMs: 3000, text: 'First line' },
      { startMs: 4000, endMs: 5500, text: 'Second\nand third' }
    ])
  })

  it('reads WebVTT, header and cue settings and all', () => {
    const parsed = parseCues(
      [
        'WEBVTT',
        '',
        'NOTE this is not a cue',
        '',
        'intro',
        '00:00:01.000 --> 00:00:03.000 line:90% align:middle',
        'Hello'
      ].join('\n')
    )
    expect(parsed.format).toBe('vtt')
    expect(parsed.cues).toEqual([{ startMs: 1000, endMs: 3000, text: 'Hello' }])
  })

  it('reads ASS dialogue in whatever field order the file declares', () => {
    const parsed = parseCues(
      [
        '[Script Info]',
        'Title: something',
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8}Up here, with a comma',
        'Comment: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,Not a cue'
      ].join('\n')
    )
    expect(parsed.format).toBe('ass')
    // The override block is gone and the comma inside the text survived.
    expect(parsed.cues).toEqual([{ startMs: 1000, endMs: 3000, text: 'Up here, with a comma' }])
  })

  it('believes the content over the file extension', () => {
    // Services hand out ASS files named .srt all the time.
    expect(parseCues('[Script Info]\n[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,,,0,0,0,,Hi').format).toBe('ass')
  })

  it('skips an unusable block rather than losing the file', () => {
    const parsed = parseCues(
      ['1', 'not a timecode at all', 'orphan', '', '2', '00:00:04,000 --> 00:00:05,000', 'Good'].join('\n')
    )
    expect(parsed.skipped).toBe(1)
    expect(parsed.cues).toHaveLength(1)
  })

  it('puts cues in time order whatever order the file had them in', () => {
    const parsed = parseCues(
      ['1', '00:00:09,000 --> 00:00:10,000', 'Later', '', '2', '00:00:01,000 --> 00:00:02,000', 'Earlier'].join('\n')
    )
    expect(parsed.cues.map((cue) => cue.text)).toEqual(['Earlier', 'Later'])
  })

  it('says so when it is not a subtitle at all', () => {
    expect(parseCues('<html><body>404 not found</body></html>').format).toBe('unknown')
    expect(parseCues('').cues).toEqual([])
  })
})

describe('cue text', () => {
  it('keeps the markup SRT renders and drops the rest', () => {
    expect(cleanCueText('<i>Hello</i> <font color="#fff">there</font>')).toBe('<i>Hello</i> <font color="#fff">there</font>')
    expect(cleanCueText('<v Narrator>Hello</v>')).toBe('Hello')
  })

  it('turns ASS line breaks into real ones', () => {
    expect(cleanCueText('First\\NSecond')).toBe('First\nSecond')
  })
})

describe('writing', () => {
  it('numbers from one and uses commas', () => {
    expect(formatSrt([{ startMs: 1000, endMs: 2000, text: 'Hi' }])).toBe('1\n00:00:01,000 --> 00:00:02,000\nHi\n')
  })

  it('leaves an empty cue out rather than writing a blank block', () => {
    const srt = formatSrt([
      { startMs: 1000, endMs: 2000, text: 'Hi' },
      { startMs: 3000, endMs: 4000, text: '   ' },
      { startMs: 5000, endMs: 6000, text: 'Bye' }
    ])
    expect(srt).toContain('2\n00:00:05,000')
    expect(srt).not.toContain('00:00:03,000')
  })

  it('round trips through the parser', () => {
    const cues = [
      { startMs: 1000, endMs: 3000, text: 'One' },
      { startMs: 4000, endMs: 5500, text: 'Two\nlines' }
    ]
    expect(parseCues(formatSrt(cues)).cues).toEqual(cues)
  })
})

describe('transforms', () => {
  const cues = [
    { startMs: 1000, endMs: 2000, text: 'A' },
    { startMs: 10_000, endMs: 11_000, text: 'B' }
  ]

  it('shifts every cue by the same amount', () => {
    expect(shiftCues(cues, 500)).toEqual([
      { startMs: 1500, endMs: 2500, text: 'A' },
      { startMs: 10_500, endMs: 11_500, text: 'B' }
    ])
  })

  it('clamps a cue pushed before zero rather than losing its words', () => {
    expect(shiftCues(cues, -1500)[0]).toEqual({ startMs: 0, endMs: 500, text: 'A' })
  })

  it('drops a cue with nothing left of it', () => {
    expect(shiftCues(cues, -2500).map((cue) => cue.text)).toEqual(['B'])
  })

  it('stretches about the anchor', () => {
    const scaled = scaleCues(cues, 2, 0)
    expect(scaled[0]).toEqual({ startMs: 2000, endMs: 4000, text: 'A' })
    expect(scaled[1]).toEqual({ startMs: 20_000, endMs: 22_000, text: 'B' })
  })

  it('refuses a factor that is not one', () => {
    expect(scaleCues(cues, 0)).toEqual(cues)
    expect(scaleCues(cues, Number.NaN)).toEqual(cues)
  })

  it('reports how much of the film it covers', () => {
    expect(cuesDurationMs(cues)).toBe(11_000)
    expect(cuesDurationMs([])).toBe(0)
  })
})

describe('decoding', () => {
  it('honours a UTF-8 byte order mark', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Привет')])
    expect(decodeSubtitleBytes(bytes)).toBe('Привет')
  })

  it('reads UTF-8 without one', () => {
    expect(decodeSubtitleBytes(new TextEncoder().encode('Привет'), 'rus')).toBe('Привет')
  })

  it('falls back to the codepage that goes with the language', () => {
    // "Привет" in windows-1251, which is not valid UTF-8 at all.
    const cp1251 = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2])
    expect(decodeSubtitleBytes(cp1251, 'rus')).toBe('Привет')
  })

  it('still returns text when nothing said what the bytes were', () => {
    const cp1251 = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2])
    // Mojibake, but text: the alternative is losing the file entirely.
    expect(decodeSubtitleBytes(cp1251)).toHaveLength(6)
  })
})
