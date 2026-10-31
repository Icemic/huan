/**
 * 项目信任接入（G1.2a 最小核心）。
 *
 * 只使用 Pi SDK 根入口公开能力：
 * - `DefaultResourceLoader.reload({ resolveProjectTrust })` 先加载用户扩展再决定项目资源；
 * - 公开的 `Extension.handlers` 中 `project_trust` 处理器完成小型顺序派发；
 * - `ProjectTrustStore` / `hasTrustRequiringProjectResources` 与 `SettingsManager`。
 *
 * 优先级与 CLI 一致：本次显式决定 > 用户扩展首个 yes/no > 最近父目录保存决定 >
 * 全局 defaultProjectTrust。`ask` 没有回答时停在 needs-trust，不装载项目资源。
 */
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  type DefaultProjectTrust,
  DefaultResourceLoader,
  hasTrustRequiringProjectResources,
  type LoadExtensionsResult,
  type ProjectTrustContext,
  type ProjectTrustEventResult,
  ProjectTrustStore,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'

/** 本轮信任结论。`needs-trust` 表示尚未回答，不能据此执行项目资源。 */
export type ProjectTrustStatus = 'trusted' | 'untrusted' | 'needs-trust'

/** 结论来源，用于页面展示“为什么加载/未加载”。 */
export type ProjectTrustSource =
  | 'explicit'
  | 'extension'
  | 'saved'
  | 'default'
  | 'ask'
  | 'no-resources'

/** 面向宿主和页面的最小项目信任状态。 */
export interface ProjectTrustState {
  /** 规范化后的项目路径（realpath；路径不存在时退回绝对路径）。 */
  cwd: string
  status: ProjectTrustStatus
  source: ProjectTrustSource
  /** 是否存在需要信任门控的项目资源。 */
  requiresTrust: boolean
  /** 当前全局默认策略（ask 时前端需要展示）。 */
  defaultProjectTrust: DefaultProjectTrust
  /**
   * 保存决定所在路径。
   *
   * `saved` 来源是命中的最近父路径；扩展或询问选择 remember 时为当前路径。
   * 仅本次决定或未保存时不提供。
   */
  savedPath?: string
  /** 用户扩展 `project_trust` 处理错误（已跳过并继续评估）。 */
  extensionErrors: readonly string[]
}

/** 宿主询问用户时的最小上下文。 */
export interface ProjectTrustAsk {
  cwd: string
  defaultProjectTrust: DefaultProjectTrust
}

/** 宿主询问结果。`remember` 为 true 时把当前路径决定写入 trust.json。 */
export interface ProjectTrustAnswer {
  trusted: boolean
  remember?: boolean
}

/** 复用 `DefaultResourceLoader` 的公开构造选项，但禁止覆盖身份字段。 */
export type ProjectTrustResourceLoaderOptions = Omit<
  ConstructorParameters<typeof DefaultResourceLoader>[0],
  'cwd' | 'agentDir' | 'settingsManager'
>

/** 准备项目信任与资源的输入。 */
export interface PrepareProjectTrustOptions {
  /** 项目路径（可以是相对路径或带 `..` 的形式）。 */
  cwd: string
  /** 用户空间目录（Pi agentDir）。 */
  agentDir: string
  /** 本次显式决定；优先级最高且不写入 trust.json。 */
  override?: boolean
  /** 需要用户回答时调用；返回 undefined 表示暂不回答。 */
  ask?: (
    request: ProjectTrustAsk,
  ) => Promise<ProjectTrustAnswer | undefined> | ProjectTrustAnswer | undefined
  /** 用户扩展可用的信任上下文；缺省为无 UI 的最小上下文。 */
  projectTrustContext?: ProjectTrustContext
  /** 调用方已有的 trust store；缺省使用 agentDir/trust.json。 */
  trustStore?: ProjectTrustStore
  /** 创建 resource loader 时的隔离/附加资源选项。 */
  resourceLoaderOptions?: ProjectTrustResourceLoaderOptions
}

/** 准备结果：loader 只有在 trusted 时才包含项目资源。 */
export interface ProjectTrustResult {
  state: ProjectTrustState
  settingsManager: SettingsManager
  /** 已完整装配的 loader；未决定或拒绝时仅包含用户级资源。 */
  resourceLoader: DefaultResourceLoader
  trustStore: ProjectTrustStore
  /** 当前 loader 的扩展加载错误（不含 project_trust 处理错误）。 */
  loadErrors: readonly string[]
}

/** 与 SDK 相同的 realpath 口径；目标不存在时保留绝对路径。 */
function canonicalPath(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

/** 无 UI 上下文：扩展仍可依据 cwd 作答，但不能通过 ui 阻塞启动。 */
function createHeadlessContext(cwd: string): ProjectTrustContext {
  return {
    cwd,
    mode: 'rpc',
    hasUI: false,
    ui: {
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      notify: () => undefined,
    },
  }
}

/**
 * 顺序派发用户级扩展的 `project_trust`。
 *
 * 与 SDK 的 emitProjectTrustEvent 同语义：同一扩展可注册多个处理器，
 * 首个 yes/no 生效，undecided 继续，异常记录后继续。
 */
async function resolveFromExtensions(
  extensionsResult: LoadExtensionsResult,
  cwd: string,
  context: ProjectTrustContext,
  errors: string[],
): Promise<ProjectTrustEventResult | undefined> {
  for (const extension of [...extensionsResult.extensions]) {
    const handlers = extension.handlers.get('project_trust')?.slice()
    if (!handlers) continue
    for (const handler of handlers) {
      try {
        const result = (await handler({ type: 'project_trust', cwd }, context)) as
          | ProjectTrustEventResult
          | undefined
        if (!result || result.trusted === 'undecided') continue
        if (result.trusted !== 'yes' && result.trusted !== 'no') {
          errors.push(`扩展 "${extension.path}" 的 project_trust 返回值无效`)
          continue
        }
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        errors.push(`扩展 "${extension.path}" 的 project_trust 处理失败：${message}`)
      }
    }
  }
  return undefined
}

/** 保存 remember 决定并返回写入路径。 */
function rememberDecision(trustStore: ProjectTrustStore, cwd: string, trusted: boolean): string {
  trustStore.set(cwd, trusted)
  return cwd
}

/**
 * 解析项目信任，并在允许时装载项目资源。
 *
 * 单次 reload 内先加载用户扩展并解析信任，再装配允许的资源；未决定和拒绝
 * 都以 projectTrusted=false 完成用户级资源装配，不重复初始化扩展工厂。
 */
export async function prepareProjectTrust(
  options: PrepareProjectTrustOptions,
): Promise<ProjectTrustResult> {
  const cwd = canonicalPath(options.cwd)
  const settingsManager = SettingsManager.create(cwd, options.agentDir, {
    projectTrusted: false,
  })
  const resourceLoader = new DefaultResourceLoader({
    ...(options.resourceLoaderOptions ?? {}),
    cwd,
    agentDir: options.agentDir,
    settingsManager,
  })
  const trustStore = options.trustStore ?? new ProjectTrustStore(options.agentDir)
  const defaultProjectTrust = settingsManager.getDefaultProjectTrust()
  const requiresTrust = hasTrustRequiringProjectResources(cwd)
  const extensionErrors: string[] = []

  let status: ProjectTrustStatus = 'needs-trust'
  let source: ProjectTrustSource = 'ask'
  let savedPath: string | undefined

  await resourceLoader.reload({
    resolveProjectTrust: async ({ extensionsResult }) => {
      if (options.override !== undefined) {
        status = options.override ? 'trusted' : 'untrusted'
        source = 'explicit'
      } else if (!requiresTrust) {
        status = 'trusted'
        source = 'no-resources'
      } else {
        const context = options.projectTrustContext
          ? { ...options.projectTrustContext, cwd }
          : createHeadlessContext(cwd)
        const extensionResult = await resolveFromExtensions(
          extensionsResult,
          cwd,
          context,
          extensionErrors,
        )

        if (extensionResult) {
          status = extensionResult.trusted === 'yes' ? 'trusted' : 'untrusted'
          source = 'extension'
          if (extensionResult.remember === true) {
            savedPath = rememberDecision(trustStore, cwd, status === 'trusted')
          }
        } else {
          const saved = trustStore.getEntry(cwd)
          if (saved) {
            status = saved.decision ? 'trusted' : 'untrusted'
            source = 'saved'
            savedPath = saved.path
          } else {
            switch (defaultProjectTrust) {
              case 'always':
                status = 'trusted'
                source = 'default'
                break
              case 'never':
                status = 'untrusted'
                source = 'default'
                break
              case 'ask': {
                const answer = await options.ask?.({ cwd, defaultProjectTrust })
                if (!answer) {
                  status = 'needs-trust'
                  source = 'ask'
                  break
                }
                status = answer.trusted ? 'trusted' : 'untrusted'
                source = 'ask'
                if (answer.remember === true) {
                  savedPath = rememberDecision(trustStore, cwd, answer.trusted)
                }
                break
              }
            }
          }
        }
      }
      return status === 'trusted'
    },
  })

  const state: ProjectTrustState = {
    cwd,
    status,
    source,
    requiresTrust,
    defaultProjectTrust,
    ...(savedPath ? { savedPath } : {}),
    extensionErrors,
  }

  return {
    state,
    settingsManager,
    resourceLoader,
    trustStore,
    loadErrors: resourceLoader
      .getExtensions()
      .errors.map(({ path, error }) => `扩展加载（${path}）：${error}`),
  }
}
