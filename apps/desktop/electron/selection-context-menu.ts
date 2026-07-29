const CHAT_MESSAGE_SELECTION_SELECTOR =
  '[data-slot="aui_assistant-message-root"], [data-slot="aui_user-message-root"]'

export interface SelectionFrame {
  executeJavaScript: (script: string) => Promise<unknown>
  isDestroyed: () => boolean
}

interface SelectionWindow {
  isDestroyed: () => boolean
  webContents: {
    isDestroyed: () => boolean
    mainFrame: SelectionFrame
  }
}

interface SelectionActionWindow {
  isDestroyed: () => boolean
  webContents: {
    send: (channel: string, text: string) => void
    showDefinitionForSelection: () => void
  }
}

export interface SelectionActionItem {
  click?: () => void
  label: string
}

interface SelectionParams {
  isEditable: boolean
  selectionText: string
}

export interface SelectionAuthorization {
  authorized: boolean
  current: boolean
}

export type SelectionProbe = (frame: SelectionFrame, expectedText: string) => Promise<boolean>

export async function probeChatMessageSelection(frame: SelectionFrame, expectedText: string): Promise<boolean> {
  if (!frame || frame.isDestroyed() || !expectedText) {
    return false
  }

  try {
    return (
      (await frame.executeJavaScript(`
        (() => {
          const expectedText = ${JSON.stringify(expectedText)}
          const selection = globalThis.getSelection?.()

          if (
            !selection ||
            selection.rangeCount === 0 ||
            selection.isCollapsed ||
            selection.toString() !== expectedText
          ) {
            return false
          }

          const messageRootFor = node => {
            const element =
              node?.nodeType === globalThis.Node?.ELEMENT_NODE ? node : (node?.parentElement ?? null)

            return element?.closest(${JSON.stringify(CHAT_MESSAGE_SELECTION_SELECTOR)}) ?? null
          }
          const anchorRoot = messageRootFor(selection.anchorNode)
          const focusRoot = messageRootFor(selection.focusNode)

          return Boolean(anchorRoot && anchorRoot === focusRoot)
        })()
      `)) === true
    )
  } catch {
    return false
  }
}

export function createChatSelectionAuthorizer(
  window: SelectionWindow,
  probe: SelectionProbe = probeChatMessageSelection
) {
  let generation = 0

  return async (
    frame: SelectionFrame | null | undefined,
    expectedText: string,
    enabled = true
  ): Promise<SelectionAuthorization> => {
    const ownGeneration = ++generation

    if (
      !enabled ||
      !frame ||
      frame.isDestroyed() ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      frame !== window.webContents.mainFrame
    ) {
      return { authorized: false, current: ownGeneration === generation }
    }

    const authorized = await probe(frame, expectedText)

    const current =
      ownGeneration === generation &&
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      !frame.isDestroyed() &&
      frame === window.webContents.mainFrame

    return { authorized: current && authorized, current }
  }
}

export function shouldOfferSelectionActions(params: SelectionParams, authorized: boolean): boolean {
  return Boolean(params.selectionText?.trim()) && !params.isEditable && authorized
}

export function buildSelectionActionItems(
  window: SelectionActionWindow,
  selectionText: string,
  isMac: boolean
): SelectionActionItem[] {
  const items: SelectionActionItem[] = [
    {
      label: 'Read Aloud',
      click: () => {
        if (!window.isDestroyed()) {
          window.webContents.send('hermes:selection-speech:read', selectionText)
        }
      }
    }
  ]

  if (isMac) {
    items.push({
      label: 'Look Up',
      click: () => {
        if (!window.isDestroyed()) {
          window.webContents.showDefinitionForSelection()
        }
      }
    })
  }

  items.push({
    label: 'Translate…',
    click: () => {
      if (!window.isDestroyed()) {
        window.webContents.send('hermes:selection-translate:open', selectionText)
      }
    }
  })

  return items
}
