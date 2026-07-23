import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $voicePlayback } from '@/store/voice-playback'

import { startSpeechStream, stopVoicePlayback } from './voice-playback'

interface TestConnection {
  authMode: 'none'
  profile: null
  wsUrl: string
}

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })

  return { promise, resolve }
}

function connection(name: string): TestConnection {
  return {
    authMode: 'none',
    profile: null,
    wsUrl: `ws://${name}.example/api/ws`
  }
}

function installDesktop(getConnection: () => Promise<TestConnection>) {
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { getConnection }
  })
}

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  static instances: FakeWebSocket[] = []

  binaryType = ''
  closed = false
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onopen: ((event: Event) => void) | null = null
  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  close() {
    if (this.closed) {
      return
    }

    this.closed = true
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }

  send(data: string) {
    this.sent.push(data)
  }
}

function requireSession<T>(session: T | null): T {
  expect(session).not.toBeNull()

  if (!session) {
    throw new Error('Expected a speech stream session')
  }

  return session
}

describe('streaming voice playback ownership', () => {
  beforeEach(() => {
    stopVoicePlayback()
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    stopVoicePlayback()
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: undefined
    })
    vi.unstubAllGlobals()
  })

  it('does not resurrect a stream whose connection probe resolved after stop', async () => {
    const probe = deferred<TestConnection>()
    installDesktop(vi.fn(() => probe.promise))

    const pending = startSpeechStream({ messageId: 'stream-a', source: 'read-aloud' })

    stopVoicePlayback()
    const stoppedState = $voicePlayback.get()
    probe.resolve(connection('stream-a'))

    await expect(pending).resolves.toBeNull()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect($voicePlayback.get()).toEqual(stoppedState)
  })

  it('does not let a delayed older probe replace a newer stream', async () => {
    const probeA = deferred<TestConnection>()
    const probeB = deferred<TestConnection>()

    const getConnection = vi
      .fn<() => Promise<TestConnection>>()
      .mockReturnValueOnce(probeA.promise)
      .mockReturnValueOnce(probeB.promise)

    installDesktop(getConnection)

    const pendingA = startSpeechStream({ messageId: 'stream-a', source: 'read-aloud' })
    const pendingB = startSpeechStream({ messageId: 'stream-b', source: 'voice-conversation' })

    probeB.resolve(connection('stream-b'))
    const sessionB = requireSession(await pendingB)
    const stateB = $voicePlayback.get()

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0].url).toContain('stream-b.example')
    expect(stateB).toMatchObject({
      messageId: 'stream-b',
      source: 'voice-conversation',
      status: 'preparing'
    })

    probeA.resolve(connection('stream-a'))

    await expect(pendingA).resolves.toBeNull()
    await Promise.resolve()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0].closed).toBe(false)
    expect($voicePlayback.get()).toEqual(stateB)

    stopVoicePlayback()
    await expect(sessionB.done).resolves.toBe('done')
  })

  it('keeps a replacement stream visible and cancellable after the old completion flushes', async () => {
    installDesktop(
      vi
        .fn<() => Promise<TestConnection>>()
        .mockResolvedValueOnce(connection('stream-a'))
        .mockResolvedValueOnce(connection('stream-b'))
    )

    const sessionA = requireSession(
      await startSpeechStream({ messageId: 'stream-a', source: 'read-aloud' })
    )

    const sessionB = requireSession(
      await startSpeechStream({ messageId: 'stream-b', source: 'voice-conversation' })
    )

    await expect(sessionA.done).resolves.toBe('done')
    await Promise.resolve()

    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[0].closed).toBe(true)
    expect(FakeWebSocket.instances[1].closed).toBe(false)
    expect($voicePlayback.get()).toMatchObject({
      messageId: 'stream-b',
      source: 'voice-conversation',
      status: 'preparing'
    })

    stopVoicePlayback()

    expect(FakeWebSocket.instances[1].closed).toBe(true)
    expect($voicePlayback.get().status).toBe('idle')
    await expect(sessionB.done).resolves.toBe('done')
  })
})
