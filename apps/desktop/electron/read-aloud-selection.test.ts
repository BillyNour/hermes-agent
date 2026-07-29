import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createIpcSelectionSubscription } from './preload-selection'
import {
  buildSelectionActionItems,
  createChatSelectionAuthorizer,
  probeChatMessageSelection,
  shouldOfferSelectionActions
} from './selection-context-menu'

function makeDomSelection(text: string, sameRoot = true) {
  const anchorRoot = {}
  const focusRoot = sameRoot ? anchorRoot : {}
  const anchorNode = { nodeType: 1, closest: () => anchorRoot }
  const focusNode = { nodeType: 1, closest: () => focusRoot }

  return {
    anchorNode,
    focusNode,
    isCollapsed: false,
    rangeCount: 1,
    toString: () => text
  }
}

describe('selected-text native actions', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('authorizes only the exact live selection inside one rendered message', async () => {
    const previousGetSelection = globalThis.getSelection
    const previousNode = globalThis.Node
    let selection = makeDomSelection('selected words only')

    Object.defineProperty(globalThis, 'Node', {
      configurable: true,
      value: { ELEMENT_NODE: 1 }
    })
    Object.defineProperty(globalThis, 'getSelection', {
      configurable: true,
      value: () => selection
    })

    const frame = {
      executeJavaScript: vi.fn(async (script: string) => (0, eval)(script)),
      isDestroyed: () => false
    }

    try {
      await expect(probeChatMessageSelection(frame, 'selected words only')).resolves.toBe(true)
      await expect(probeChatMessageSelection(frame, 'older settings text')).resolves.toBe(false)

      selection = makeDomSelection('selected words only', false)
      await expect(probeChatMessageSelection(frame, 'selected words only')).resolves.toBe(false)
    } finally {
      Object.defineProperty(globalThis, 'Node', { configurable: true, value: previousNode })
      Object.defineProperty(globalThis, 'getSelection', { configurable: true, value: previousGetSelection })
    }
  })

  it('rejects an older same-frame authorization after a newer menu request begins', async () => {
    let resolveFirst!: (allowed: boolean) => void
    let resolveSecond!: (allowed: boolean) => void

    const probe = vi
      .fn()
      .mockImplementationOnce(() => new Promise<boolean>(resolve => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise<boolean>(resolve => (resolveSecond = resolve)))

    const frame = { executeJavaScript: vi.fn(), isDestroyed: () => false }

    const window = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, mainFrame: frame }
    }

    const authorize = createChatSelectionAuthorizer(window, probe)

    const older = authorize(frame, 'older settings text')
    const newer = authorize(frame, 'selected chat text')

    resolveSecond(true)
    await expect(newer).resolves.toEqual({ authorized: true, current: true })
    resolveFirst(true)
    await expect(older).resolves.toEqual({ authorized: false, current: false })
    expect(probe).toHaveBeenNthCalledWith(1, frame, 'older settings text')
    expect(probe).toHaveBeenNthCalledWith(2, frame, 'selected chat text')
  })

  it('rejects a subframe selection even when a stale main-frame selection would authorize', async () => {
    const probe = vi.fn().mockResolvedValue(true)
    const mainFrame = { executeJavaScript: vi.fn(), isDestroyed: () => false }
    const subframe = { executeJavaScript: vi.fn(), isDestroyed: () => false }

    const window = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, mainFrame }
    }

    const authorize = createChatSelectionAuthorizer(window, probe)

    await expect(authorize(subframe, 'iframe selection')).resolves.toEqual({
      authorized: false,
      current: true
    })
    expect(probe).not.toHaveBeenCalled()
  })

  it('keeps editable selections on the ordinary editing path', () => {
    expect(shouldOfferSelectionActions({ isEditable: true, selectionText: 'credential-like text' }, true)).toBe(false)
    expect(shouldOfferSelectionActions({ isEditable: false, selectionText: 'message text' }, true)).toBe(true)
    expect(shouldOfferSelectionActions({ isEditable: false, selectionText: 'message text' }, false)).toBe(false)
  })

  it('sends only captured selectionText and invokes native macOS Look Up', () => {
    const send = vi.fn()
    const showDefinitionForSelection = vi.fn()

    const window = {
      isDestroyed: () => false,
      webContents: { send, showDefinitionForSelection }
    }

    const items = buildSelectionActionItems(window, 'selected words only', true)
    const byLabel = new Map(items.map(item => [item.label, item]))

    byLabel.get('Read Aloud')?.click?.()
    byLabel.get('Look Up')?.click?.()
    byLabel.get('Translate…')?.click?.()

    expect(send).toHaveBeenNthCalledWith(1, 'hermes:selection-speech:read', 'selected words only')
    expect(send).toHaveBeenNthCalledWith(2, 'hermes:selection-translate:open', 'selected words only')
    expect(showDefinitionForSelection).toHaveBeenCalledOnce()
  })

  it('registers removable IPC listeners that forward only the payload text', () => {
    const on = vi.fn()
    const removeListener = vi.fn()
    const subscribe = createIpcSelectionSubscription({ on, removeListener }, 'selection:open')
    const callback = vi.fn()

    const dispose = subscribe(callback)
    const listener = on.mock.calls[0][1]
    listener({}, 'selected words only', 'ignored')

    expect(callback).toHaveBeenCalledWith('selected words only')
    dispose()
    expect(removeListener).toHaveBeenCalledWith('selection:open', listener)
  })
})