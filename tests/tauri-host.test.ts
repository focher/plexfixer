import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Tauri host adapter, with the two Tauri entry points replaced.
 *
 * What is worth testing here is not that `invoke` works — that is Tauri's job —
 * but the translation either side of it: that commands are called with the
 * arguments Rust declares, and that a running process's output reaches the
 * right listener. The second one has a race in it that a webview would show
 * only intermittently.
 */

const invoked: { command: string; args: Record<string, unknown> }[] = []
let invokeResult: unknown = null
let invokeError: Error | undefined

const listeners = new Map<string, (message: { payload: unknown }) => void>()
let listenDelay = 0

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    invoked.push({ command, args })
    if (invokeError) throw invokeError
    return invokeResult
  })
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: (message: { payload: unknown }) => void) => {
    // Subscribing is asynchronous in Tauri, which is the whole reason the
    // adapter subscribes once up front instead of per process.
    if (listenDelay > 0) await new Promise((resolve) => setTimeout(resolve, listenDelay))
    listeners.set(event, handler)
    return () => listeners.delete(event)
  })
}))

const { tauriHost } = await import('../src/renderer/src/bridge/host.js')

function emit(event: string, payload: unknown): void {
  listeners.get(event)?.({ payload })
}

/**
 * Let the adapter's own awaits run.
 *
 * Starting a process waits for the shared subscription before it invokes, so
 * the id does not exist until a couple of turns of the event loop have passed.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  invoked.length = 0
  invokeResult = null
  invokeError = undefined
  listenDelay = 0
})

describe('reading through Rust', () => {
  it('asks for a byte range and hands back bytes, not numbers', async () => {
    invokeResult = [0, 0, 0, 24, 109, 111, 111, 118]
    const bytes = await tauriHost('darwin').readRange('/m/Alien.mp4', 0, 8)

    expect(invoked[0]).toEqual({
      command: 'host_read_range',
      args: { path: '/m/Alien.mp4', offset: 0, length: 8 }
    })
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect([...bytes]).toEqual([0, 0, 0, 24, 109, 111, 111, 118])
  })

  it('turns a missing file into undefined rather than null', async () => {
    invokeResult = null
    expect(await tauriHost('darwin').stat('/m/gone.mkv')).toBeUndefined()
  })

  it('passes the paths from Settings, so a chosen ffmpeg is allowed to run', async () => {
    invokeResult = ''
    const host = tauriHost('darwin', { ffmpeg: '/opt/ffmpeg', ffprobe: '/opt/ffprobe' })
    await host.exec('/opt/ffprobe', ['-version'])

    expect(invoked[0].args).toMatchObject({
      command: '/opt/ffprobe',
      settingsFfmpeg: '/opt/ffmpeg',
      settingsFfprobe: '/opt/ffprobe'
    })
  })

  it('parses what the volume command reports into the shape the runner reads', async () => {
    invokeResult = {
      device: 16777232,
      df: 'Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk3s5 1 1 1 1% /Volumes/Media\n',
      fsType: 'apfs'
    }
    const info = await tauriHost('darwin').volume('/Volumes/Media/Alien.mkv')

    expect(info.device).toBe(16777232)
    expect(info.mount).toBe('/Volumes/Media')
    expect(info.kind).toBe('local')
    expect(info.type).toBe('apfs')
  })
})

describe('writing through Rust', () => {
  it('sends a patch as a plain array, which is what the command takes', async () => {
    await tauriHost('darwin').writeRange('/m/Alien.mp4', 1024, Uint8Array.from([0x0f, 0x45]))
    expect(invoked[0]).toEqual({
      command: 'host_write_range',
      args: { path: '/m/Alien.mp4', offset: 1024, bytes: [15, 69] }
    })
  })
})

describe('a running process', () => {
  it('routes output to the process it belongs to, and nothing else', async () => {
    const host = tauriHost('darwin')
    const first = host.spawnProcess('/bin/ffmpeg', ['-i', 'a.mkv'])
    const second = host.spawnProcess('/bin/ffmpeg', ['-i', 'b.mkv'])

    const mine: string[] = []
    const theirs: string[] = []
    first.onStdout((chunk) => mine.push(chunk))
    second.onStdout((chunk) => theirs.push(chunk))

    // Let the one-off subscription settle, then speak for each process by id.
    await settle()
    const ids = invoked.filter((call) => call.command === 'process_start').map((call) => call.args.id as string)
    expect(ids).toHaveLength(2)

    emit('plexfixer://process-output', { id: ids[0], stream: 'stdout', text: 'progress=continue\n' })
    emit('plexfixer://process-output', { id: ids[1], stream: 'stdout', text: 'frame=12\n' })

    expect(mine).toEqual(['progress=continue\n'])
    expect(theirs).toEqual(['frame=12\n'])
  })

  it('keeps stdout and stderr apart', async () => {
    const host = tauriHost('darwin')
    const child = host.spawnProcess('/bin/ffmpeg', [])
    const out: string[] = []
    const err: string[] = []
    child.onStdout((chunk) => out.push(chunk))
    child.onStderr((chunk) => err.push(chunk))

    await settle()
    const id = invoked.find((call) => call.command === 'process_start')?.args.id as string

    emit('plexfixer://process-output', { id, stream: 'stderr', text: 'Invalid data\n' })
    emit('plexfixer://process-output', { id, stream: 'stdout', text: 'progress=end\n' })

    expect(out).toEqual(['progress=end\n'])
    expect(err).toEqual(['Invalid data\n'])
  })

  it('resolves when the process ends, carrying the exit code', async () => {
    const host = tauriHost('darwin')
    const child = host.spawnProcess('/bin/ffmpeg', [])
    await settle()
    const id = invoked.find((call) => call.command === 'process_start')?.args.id as string

    emit('plexfixer://process-ended', { id, code: 0 })
    await expect(child.closed).resolves.toEqual({ code: 0, signalName: undefined })
  })

  it('reports a signal, so a cancelled repair is not read as a crash', async () => {
    const host = tauriHost('darwin')
    const child = host.spawnProcess('/bin/ffmpeg', [])
    await settle()
    const id = invoked.find((call) => call.command === 'process_start')?.args.id as string

    emit('plexfixer://process-ended', { id, code: null, signalName: 'SIGTERM' })
    await expect(child.closed).resolves.toEqual({ code: null, signalName: 'SIGTERM' })
  })

  it('rejects when the binary will not start, rather than waiting forever', async () => {
    invokeError = new Error('/bin/ffmpeg is not one of the binaries PlexFixer runs.')
    const child = tauriHost('darwin').spawnProcess('/bin/ffmpeg', [])
    await expect(child.closed).rejects.toThrow(/not one of the binaries/)
  })

  it('asks Rust to stop it by id', async () => {
    const host = tauriHost('darwin')
    const child = host.spawnProcess('/bin/ffmpeg', [])
    await settle()
    const id = invoked.find((call) => call.command === 'process_start')?.args.id as string

    child.terminate()
    expect(invoked.some((call) => call.command === 'process_terminate' && call.args.id === id)).toBe(true)
  })
})
