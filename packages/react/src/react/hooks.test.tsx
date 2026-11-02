// @vitest-environment jsdom

import type { HarnessClient, HarnessClientEvent, HarnessHostInfo } from '@huan/protocol'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHarnessBrowser } from '../browser/create-browser.js'
import { HarnessBrowserProvider } from './context.js'
import { useThreadLease, useWindowStore } from './hooks.js'

const hostInfo: HarnessHostInfo = {
  workspacePath: '/workspace',
  agentDir: '/agent',
  agentDirSource: 'settings',
  sessionStorage: {
    mode: 'grouped',
    root: '/sessions',
    directory: '/sessions',
    source: 'settings',
  },
  defaultModel: {
    provider: 'provider',
    modelId: 'model',
    providerSource: 'env',
    modelIdSource: 'env',
    readiness: {
      state: 'ready',
      selection: { provider: 'provider', modelId: 'model' },
      source: 'env',
    },
  },
  diagnostics: [],
}

const createFakeClient = () => {
  const unsubscribe = vi.fn()
  const client = {
    getHostInfo: vi.fn(async () => hostInfo),
    subscribe: vi.fn(
      (_threadId: string, _listener: (event: HarnessClientEvent) => void) => unsubscribe,
    ),
    subscribeProviderAuth: vi.fn(() => () => {}),
    subscribeHostInteractions: vi.fn(() => () => {}),
  } as unknown as HarnessClient
  return { client, unsubscribe }
}

const render = (node: React.ReactNode) => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(node))
  return { container, root }
}

let roots: Root[] = []
afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  roots = []
  document.body.innerHTML = ''
})

describe('React selector 绑定', () => {
  it('Provider 只传实例；窗口选择器随 Zustand 更新', () => {
    const fake = createFakeClient()
    const browser = createHarnessBrowser({
      client: fake.client,
      connectionKey: 'test',
      windowId: 'window-a',
      storage: null,
    })
    const DraftText = () => {
      const text = useWindowStore((state) =>
        state.selection?.kind === 'thread'
          ? (state.draftsById[`thread:${state.selection.threadId}`]?.text ?? '')
          : '',
      )
      return createElement('span', { id: 'draft' }, text)
    }
    const { container, root } = render(
      createElement(HarnessBrowserProvider, { browser }, createElement(DraftText)),
    )
    roots.push(root)
    expect(container.querySelector('#draft')?.textContent).toBe('')

    act(() => {
      browser.windowStore.getState().selectTarget({ kind: 'thread', threadId: 't1' })
      browser.windowStore.getState().editDraftText('thread:t1', '草稿文字')
    })
    expect(container.querySelector('#draft')?.textContent).toBe('草稿文字')
    browser.dispose()
  })

  it('useThreadLease 在挂载/卸载时取得并释放订阅', async () => {
    const fake = createFakeClient()
    const browser = createHarnessBrowser({
      client: fake.client,
      connectionKey: 'test',
      windowId: 'window-a',
      storage: null,
    })
    const Live = () => {
      useThreadLease('t1')
      return null
    }
    const { root } = render(createElement(HarnessBrowserProvider, { browser }, createElement(Live)))
    expect(fake.client.subscribe).toHaveBeenCalledTimes(1)

    act(() => root.unmount())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1)
    browser.dispose()
  })
})
