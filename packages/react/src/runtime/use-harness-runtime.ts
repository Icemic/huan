/**
 * React 接线：把 Controller 与 assistant-ui 的 `useExternalStoreRuntime` 连接。
 *
 * 出处：移植自 `@assistant-ui/react-pi@0.0.29` 的
 * `src/runtime/usePiRuntime.ts`（MIT 许可，见包内 THIRD-PARTY-NOTICES.md）。
 * 改动：类型改用 `@huan/protocol`，命名 `Pi*` → `Harness*`，
 * 删除 Assistant Cloud 分支（本项目不使用云端会话列表），
 * 上游内部工具改从 `../vendor/` 引入，注释译为中文。
 *
 * 本模块负责：
 * - Controller 注册表（跨 StrictMode 重挂载缓存，见 `createRegistry`）；
 * - 把 Controller 的快照/投影投影为 `ExternalStoreAdapter` 的各种钩子；
 * - 线程列表适配器（list / create / rename / archive / delete）；
 * - 组装 `useRemoteThreadListRuntime` 的运行时。
 */
// biome-ignore-all lint/correctness/useHookAtTopLevel: 本文件把 store 构造函数（内部使用 hook）作为
// `useRemoteThreadListRuntime` 的 `runtimeHook` 传入；该回调由 assistant-ui 在正确的 hook 位置调用，
// 静态分析无法跨包识别这一点。上游 react-pi 以同等理由抑制了同一规则。
'use client'

import type {
  AssistantRuntime,
  ExternalStoreAdapter,
  ExternalThreadQueueAdapter,
  ThreadMessage,
  ThreadMessageLike,
} from '@assistant-ui/react'
import {
  ExportedMessageRepository,
  isMessageNotSentError,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
  useRemoteThreadListRuntime,
} from '@assistant-ui/react'
import type { HarnessClient, HarnessThreadMetadata } from '@huan/protocol'
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { harnessQueueItemId } from '../queue-ids.js'
import { invokeUserCallback } from '../vendor/anti-corruption.js'
import { useLatestRef, useReplaySafeEffect } from '../vendor/hooks.js'
import { disposeControllers } from './dispose-controllers.js'
import { harnessExtras } from './extras.js'
import {
  type HarnessInterruptAnswer,
  responseForToolApproval,
  splitHostUiRequests,
} from './host-ui.js'
import type { HarnessRuntimeExtrasInternal, HarnessRuntimeOptions } from './runtime-types.js'
import {
  appendMessageParts,
  HarnessThreadController,
  type HarnessThreadControllerLike,
} from './thread-controller.js'
import { createHarnessThreadState, type HarnessThreadState } from './thread-state.js'

const EMPTY_THREAD_STATE = createHarnessThreadState('__pending__')
const EMPTY_PROJECTED_MESSAGES: readonly ThreadMessageLike[] = []
const EMPTY_MESSAGE_REPOSITORY = ExportedMessageRepository.fromArray([])

// ---------------------------------------------------------------------------
// Controller 注册表（跨 StrictMode 重挂载缓存）。
// ---------------------------------------------------------------------------

type HarnessControllerRegistry = {
  /** 这些 Controller 所绑定的 client（client 改变时创建新的注册表）。 */
  client: HarnessClient
  controllers: Map<string, HarnessThreadController>
  readonly disposed: boolean
  activate(): void
  dispose(): void
}

const createRegistry = (client: HarnessClient): HarnessControllerRegistry => {
  const controllers = new Map<string, HarnessThreadController>()
  let disposed = false
  return {
    client,
    controllers,
    get disposed() {
      return disposed
    },
    activate() {
      disposed = false
    },
    dispose() {
      disposed = true
      disposeControllers(controllers.values())
      // 保留 Controller 缓存，以便 StrictMode 清理后重挂载时复用；
      // 真正卸载时则会丢弃整个注册表。
    },
  }
}

const getController = (registry: HarnessControllerRegistry, threadId: string) => {
  const existing = registry.controllers.get(threadId)
  if (existing) return existing
  const controller = new HarnessThreadController(registry.client, threadId)
  registry.controllers.set(threadId, controller)
  return controller
}

// 无可用线程时使用的空操作 Controller。
export const NOOP_CONTROLLER: HarnessThreadControllerLike = {
  getState: () => EMPTY_THREAD_STATE,
  getProjectedMessages: () => EMPTY_PROJECTED_MESSAGES,
  getMessageRepository: () => EMPTY_MESSAGE_REPOSITORY,
  getVersion: () => 0,
  subscribe: () => () => {},
  subscribeMetadata: () => () => {},
  subscribeMessages: () => () => {},
  connect: () => () => {},
  load: async () => {},
  refresh: async () => {},
  sendMessage: async () => {},
  cancel: async () => {},
  clearQueue: async () => ({ steering: [], followUp: [] }),
  setModel: async () => {},
  setThinkingLevel: async () => {},
  respondToToolApproval: async () => {},
  resumeToolCall: async () => {},
  respondToHostUiRequest: async () => {},
  dispose: () => {},
}

const invokeHarnessErrorCallback = (onError: HarnessRuntimeOptions['onError'], error: unknown) => {
  void invokeUserCallback('huan-react', 'onError', onError, error)
}

const buildExtras = (
  controller: HarnessThreadControllerLike,
  state: HarnessThreadState,
): HarnessRuntimeExtrasInternal => {
  const { freeStanding } = splitHostUiRequests(state.hostUiRequests)
  return harnessExtras.provide({
    controller,
    state,
    metadata: state.metadata,
    status: state.runStatus === 'failed' ? 'failed' : state.runStatus,
    readiness: state.readiness,
    contextUsage: state.contextUsage,
    hostUiRequests: freeStanding,
    allHostUiRequests: state.hostUiRequests,
    queue: state.queue,
    compaction: state.compaction,
    retry: state.retry,
    lastError: state.lastError,
    connect: () => controller.connect(),
    cancel: () => controller.cancel(),
    refresh: () => controller.refresh(),
    clearQueue: () => controller.clearQueue(),
    setModel: (input) => controller.setModel(input),
    setThinkingLevel: (level) => controller.setThinkingLevel(level),
    respondToHostUiRequest: (response) => controller.respondToHostUiRequest(response),
    respondToToolApproval: (id, approved) => controller.respondToToolApproval(id, approved),
    resumeToolCall: (toolCallId, payload) => controller.resumeToolCall(toolCallId, payload),
  })
}

export const EMPTY_RUNTIME_EXTRAS = buildExtras(NOOP_CONTROLLER, EMPTY_THREAD_STATE)

// ---------------------------------------------------------------------------
// 每线程运行时。
// ---------------------------------------------------------------------------

const stateSnapshotOf = (controller: HarnessThreadControllerLike): HarnessThreadState =>
  controller.getStateSnapshot?.() ?? controller.getState()

const useHarnessControllerState = (controller: HarnessThreadControllerLike): HarnessThreadState => {
  const getSnapshot = useCallback(() => stateSnapshotOf(controller), [controller])
  return useSyncExternalStore(
    useCallback((listener: () => void) => controller.subscribe(listener), [controller]),
    getSnapshot,
    getSnapshot,
  )
}

const useHarnessControllerMessageRepository = (
  controller: HarnessThreadControllerLike,
): ExportedMessageRepository => {
  const getSnapshot = useCallback(() => controller.getMessageRepository(), [controller])
  return useSyncExternalStore(
    useCallback((listener: () => void) => controller.subscribeMessages(listener), [controller]),
    getSnapshot,
    getSnapshot,
  )
}

export const useHarnessControllerStateSelector = <T>(
  controller: HarnessThreadControllerLike,
  selector: (state: HarnessThreadState) => T,
): T => {
  // `useSyncExternalStore` 使用 `Object.is` 比较快照，因此在 `getSnapshot` 内选择，
  // 才能让 store 观察选中的状态片段，而非整个状态。以源状态为依据进行记忆化，
  // 可确保重复读取同一状态对象时引用保持稳定；将记忆化依 selector 重新分键，
  // 则会在闭包变化时重新执行选择器，而不是重放上一次的结果。
  const getSelection = useMemo(() => {
    let memo: { state: HarnessThreadState; selection: T } | undefined
    return () => {
      const state = stateSnapshotOf(controller)
      if (!memo || memo.state !== state) memo = { state, selection: selector(state) }
      return memo.selection
    }
  }, [controller, selector])

  return useSyncExternalStore(
    useCallback((listener: () => void) => controller.subscribe(listener), [controller]),
    getSelection,
    getSelection,
  )
}

const isHarnessStateRunning = (state: HarnessThreadState): boolean =>
  state.runStatus === 'running' || state.compaction.active || state.retry.active

const useHarnessThreadStore = (
  controller: HarnessThreadControllerLike,
  options: HarnessRuntimeOptions,
): ExternalStoreAdapter<ThreadMessage> => {
  const state = useHarnessControllerState(controller)
  const messageRepository = useHarnessControllerMessageRepository(controller)

  const { adapters, isDisabled, isSendDisabled, onError, suggestions, unstable_capabilities } =
    options
  const isLoading = state.loadState === 'loading'
  const isRunning = isHarnessStateRunning(state)

  const onLoadError = useLatestRef((error: unknown) => {
    invokeHarnessErrorCallback(onError, error)
  })

  useReplaySafeEffect(() => {
    if (controller === NOOP_CONTROLLER) return undefined
    void controller.load().catch((error) => onLoadError.current(error))
    return undefined
  }, [controller, onLoadError])

  // 运行中的线程必须持续接收实时事件，即使此 client 从未调用过 `sendMessage`——
  // 例如，新线程的首条消息会在服务端的 `createThread` 中启动运行。supervisor 已为
  // 运行中的线程持有实时记录，因此订阅时会直接接入；空闲线程不会建立连接，
  // 冷读取路径仍然开销很低。
  useReplaySafeEffect(() => {
    if (controller === NOOP_CONTROLLER) return
    if (!isRunning) return
    return controller.connect()
  }, [controller, isRunning])

  const extras = useMemo<HarnessRuntimeExtrasInternal>(
    () => buildExtras(controller, state),
    [controller, state],
  )

  // Pi 原生支持 queue（`prompt()` 可在运行中 steer 或 followUp），因此 queue
  // adapter 会将每次发送直接转发给 Controller，而不在客户端缓冲。暴露该 adapter
  // 会启用 `capabilities.queue`，使 composer 能在运行期间继续接收输入
  //（运行中发送默认 steer；`send({ steer: false })` 会排入 followUp）。
  const queue = useMemo<ExternalThreadQueueAdapter>(
    () => ({
      items: state.queue.followUp.map((content, index) => ({
        id: harnessQueueItemId('followUp', index),
        prompt: content,
        parts: [{ type: 'text' as const, text: content }],
      })),
      steerItems: state.queue.steering.map((content, index) => ({
        id: harnessQueueItemId('steer', index),
        prompt: content,
        parts: [{ type: 'text' as const, text: content }],
      })),
      enqueue: (message) => {
        void controller.sendMessage(message).catch((error: unknown) => {
          if (!isMessageNotSentError(error)) {
            invokeHarnessErrorCallback(onError, error)
          }
        })
      },
      steer: (message) => {
        void controller
          .sendMessage(message, { streamingBehavior: 'steer' })
          .catch((error: unknown) => {
            if (!isMessageNotSentError(error)) {
              invokeHarnessErrorCallback(onError, error)
            }
          })
      },
      // 服务端 queue 不提供逐项操作；通用 queue UI 无法通过 feature detection 判断，
      // 因此这里刻意设为空操作，避免未设保护的点击路径导致崩溃。
      move: () => {},
      edit: () => {},
      remove: () => {},
    }),
    [controller, state.queue, onError],
  )

  const store = useMemo<ExternalStoreAdapter<ThreadMessage>>(
    () => ({
      isDisabled,
      isSendDisabled,
      unstable_capabilities,
      suggestions,
      isLoading,
      isRunning,
      messageRepository,
      extras,
      queue,
      ...(adapters ? { adapters } : {}),
      onNew: async (message) => {
        try {
          await controller.sendMessage(message)
        } catch (error) {
          if (!isMessageNotSentError(error)) {
            invokeHarnessErrorCallback(onError, error)
          }
          throw error
        }
      },
      onCancel: async () => {
        try {
          const cancel =
            controller instanceof HarnessThreadController
              ? controller.captureCancel()
              : () => controller.cancel()
          // 先清空再取消，避免服务端在两者之间将排队的 prompt 提升为新一轮运行。
          try {
            await controller.clearQueue()
          } finally {
            await cancel()
          }
        } catch (error) {
          invokeHarnessErrorCallback(onError, error)
          throw error
        }
      },
      onRespondToToolApproval: async (response) => {
        try {
          const request = controller
            .getState()
            .hostUiRequests.find((r) => r.id === response.approvalId)
          if (!request) {
            throw new Error(`No pending host-UI request "${response.approvalId}"`)
          }
          await controller.respondToHostUiRequest(responseForToolApproval(request, response))
        } catch (error) {
          invokeHarnessErrorCallback(onError, error)
          throw error
        }
      },
      onResumeToolCall: ({ toolCallId, payload }) => {
        void controller
          .resumeToolCall(toolCallId, payload as HarnessInterruptAnswer)
          .catch((error) => invokeHarnessErrorCallback(onError, error))
      },
    }),
    [
      controller,
      extras,
      messageRepository,
      queue,
      adapters,
      isDisabled,
      isLoading,
      isRunning,
      isSendDisabled,
      onError,
      suggestions,
      unstable_capabilities,
    ],
  )

  return store
}

const toOptimisticThreadMessage = (
  message: Parameters<ExternalStoreAdapter<ThreadMessageLike>['onNew']>[0],
  index: number,
): ThreadMessageLike => ({
  id: `harness-new-user:${index}`,
  role: 'user',
  createdAt: new Date(),
  content: appendMessageParts(message),
})

const useNewHarnessThreadStore = (
  registry: HarnessControllerRegistry,
  options: HarnessRuntimeOptions,
): ExternalStoreAdapter<ThreadMessage> => {
  const aui = useAui()
  const { adapters, isDisabled, isSendDisabled, onError, suggestions, unstable_capabilities } =
    options
  const [optimisticMessages, setOptimisticMessages] = useState<readonly ThreadMessageLike[]>([])
  const optimisticMessageIndexRef = useRef(0)
  const optimisticRepository = useMemo(
    () => ExportedMessageRepository.fromArray(optimisticMessages),
    [optimisticMessages],
  )

  const store = useMemo<ExternalStoreAdapter<ThreadMessage>>(
    () => ({
      isDisabled: isDisabled ?? false,
      isSendDisabled,
      unstable_capabilities,
      suggestions,
      isLoading: false,
      isRunning: false,
      messageRepository: optimisticRepository,
      extras: EMPTY_RUNTIME_EXTRAS,
      ...(adapters ? { adapters } : {}),
      onNew: async (message) => {
        const optimistic = toOptimisticThreadMessage(message, optimisticMessageIndexRef.current++)
        setOptimisticMessages((messages) => [...messages, optimistic])
        const removeOptimisticMessage = () => {
          setOptimisticMessages((messages) =>
            messages.filter((candidate) => candidate !== optimistic),
          )
        }
        try {
          // core 会在分发 onNew 前启动线程初始化，因此 adapter.initialize 已创建好空线程；
          // 将消息发送到这个实时线程。
          const { remoteId, externalId } = await aui.threadListItem.initialize()
          if (registry.disposed) {
            removeOptimisticMessage()
            return
          }
          const harnessThreadId = externalId ?? remoteId
          if (!harnessThreadId) {
            throw new Error('This thread has no Pi thread to send to.')
          }
          await getController(registry, harnessThreadId).sendMessage(message)
          removeOptimisticMessage()
        } catch (error) {
          removeOptimisticMessage()
          if (!isMessageNotSentError(error)) {
            invokeHarnessErrorCallback(onError, error)
          }
          throw error
        }
      },
    }),
    [
      aui,
      optimisticRepository,
      registry,
      adapters,
      isDisabled,
      isSendDisabled,
      onError,
      suggestions,
      unstable_capabilities,
    ],
  )

  return store
}

const useHarnessRuntimeHook = (
  registry: HarnessControllerRegistry,
  options: HarnessRuntimeOptions,
) => {
  const threadListItem = useAuiState((state) => state.threadListItem)
  const isMainThread = useAuiState(
    (state) => state.threads.mainThreadId === state.threadListItem.id,
  )
  const threadId = threadListItem.externalId ?? threadListItem.remoteId

  // 不额外添加 render 局部缓存：`getController` 已是幂等的 registry 查询，
  // 第二层缓存可能在 registry 重建后仍继续存活。
  const controller = threadId ? getController(registry, threadId) : NOOP_CONTROLLER

  const threadStore = useHarnessThreadStore(isMainThread ? controller : NOOP_CONTROLLER, options)
  const newThreadStore = useNewHarnessThreadStore(registry, options)
  // 使用一个 runtime，其 store 内容在新线程与实时线程分支之间切换。交替返回两个
  // runtime 实例会破坏 remote-thread-list 的 main 绑定：它可能固定使用切换时的
  // runtime，从而错过另一个 runtime 后续的更新。
  return useExternalStoreRuntime<ThreadMessage>(threadId ? threadStore : newThreadStore)
}

// ---------------------------------------------------------------------------
// 线程列表元数据映射。
// ---------------------------------------------------------------------------

const mapThreadMetadata = (metadata: HarnessThreadMetadata) => ({
  status: metadata.archived ? ('archived' as const) : ('regular' as const),
  remoteId: metadata.id,
  externalId: metadata.id,
  ...(metadata.title !== undefined ? { title: metadata.title } : {}),
  custom: {
    status: metadata.status,
    ...(metadata.workspacePath !== undefined ? { workspacePath: metadata.workspacePath } : {}),
    ...(metadata.sessionFile !== undefined ? { sessionFile: metadata.sessionFile } : {}),
    ...(metadata.parentSessionPath !== undefined
      ? { parentSessionPath: metadata.parentSessionPath }
      : {}),
  },
})

// ---------------------------------------------------------------------------
// 公共 hook。
// ---------------------------------------------------------------------------

export const useHarnessRuntime = (options: HarnessRuntimeOptions): AssistantRuntime => {
  const { client } = options
  const [pinnedRegistry, setPinnedRegistry] = useState(() => ({
    client,
    registry: createRegistry(client),
  }))
  let currentRegistry = pinnedRegistry
  if (pinnedRegistry.client !== client) {
    currentRegistry = { client, registry: createRegistry(client) }
    setPinnedRegistry(currentRegistry)
  }
  const { registry } = currentRegistry

  useReplaySafeEffect(() => {
    registry.activate()
    return () => registry.dispose()
  }, [registry])

  const { workspacePath, includeArchived } = options
  const createAdapter = () => ({
    list: async () => {
      const threads = await client.listThreads({
        ...(workspacePath !== undefined ? { workspacePath } : {}),
        ...(includeArchived !== undefined ? { includeArchived } : {}),
      })
      return { threads: threads.map(mapThreadMetadata) }
    },
    rename: async (remoteId: string, newTitle: string) => {
      await client.renameThread(remoteId, newTitle)
    },
    archive: async (remoteId: string) => {
      await client.archiveThread?.(remoteId)
    },
    unarchive: async (remoteId: string) => {
      await client.unarchiveThread?.(remoteId)
    },
    delete: async (remoteId: string) => {
      await client.deleteThread?.(remoteId)
    },
    initialize: async () => {
      const snapshot = await client.createThread({
        ...(workspacePath !== undefined ? { workspacePath } : {}),
      })
      return {
        remoteId: snapshot.metadata.id,
        externalId: snapshot.metadata.id,
      }
    },
    generateTitle: async () =>
      // Pi 不提供服务端标题摘要；标题来自 `session_info_changed`。使用空 stream 满足契约。
      new ReadableStream({
        start(streamController) {
          streamController.close()
        },
      }) as never,
    fetch: async (threadId: string) => {
      const snapshot = await client.getThread(threadId)
      return mapThreadMetadata(snapshot.metadata)
    },
  })
  const [pinnedAdapter, setPinnedAdapter] = useState(() => ({
    client,
    workspacePath,
    includeArchived,
    adapter: createAdapter(),
  }))
  let currentAdapter = pinnedAdapter
  if (
    pinnedAdapter.client !== client ||
    pinnedAdapter.workspacePath !== workspacePath ||
    pinnedAdapter.includeArchived !== includeArchived
  ) {
    currentAdapter = {
      client,
      workspacePath,
      includeArchived,
      adapter: createAdapter(),
    }
    setPinnedAdapter(currentAdapter)
  }
  const adapter = currentAdapter.adapter

  return useRemoteThreadListRuntime({
    runtimeHook: () => {
      return useHarnessRuntimeHook(registry, options)
    },
    adapter,
    allowNesting: true,
    ...(options.initialThreadId !== undefined ? { initialThreadId: options.initialThreadId } : {}),
    ...(options.threadId !== undefined ? { threadId: options.threadId } : {}),
    ...(options.onThreadIdChange !== undefined
      ? { onThreadIdChange: options.onThreadIdChange }
      : {}),
  })
}
