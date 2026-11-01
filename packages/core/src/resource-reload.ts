/**
 * 资源重载的受控部分（G1.4b）。
 *
 * 背景：SDK 的 `AgentSession.reload()` 先 `session_shutdown` → `invalidate`，
 * 再 `settingsManager.reload()` → `resourceLoader.reload()`（**不带**
 * `resolveProjectTrust`）→ `session_start`。不传信任回调时 loader 会沿用上次
 * 的 `projectTrusted` 标志，于是「装配时没有项目资源、之后新增扩展/技能」
 * 会绕过信任门控直接执行代码。
 *
 * 因此宿主在创建 loader 时给公开 `ResourceLoader.reload` 套一层信任检查：
 * 每次重载前用与首次装配相同的解析函数重查受保护资源是否存在，并结合
 * 显式/保存/扩展/默认策略给出结论；未取得明确授权时抛出
 * `ResourceReloadTrustError`（SDK 的 `session.reload()` 随之失败，旧运行时已
 * 被关闭，可修复后重试）。已拒绝的项目仍可重载用户级资源。
 *
 * 这里不导入 Pi 私有字段，也不另建第二套信任权威。
 */
import type {
  ProjectTrustContext,
  ProjectTrustStore,
  ResourceLoader,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { type ProjectTrustState, resolveProjectTrustDecision } from './project-trust.js'

/** 请求重载的项目资源需要信任，但当前没有明确授权。 */
export class ResourceReloadTrustError extends Error {
  readonly code = 'resource-reload-trust-required'
  readonly state: ProjectTrustState
  constructor(state: ProjectTrustState) {
    super('项目新增了需要信任的资源，本次资源重载已拒绝；请先在项目信任面板完成允许/拒绝，再重试。')
    this.name = 'ResourceReloadTrustError'
    this.state = state
  }
}

/** 绑定信任检查所需的宿主上下文（每次装配一份，跟随 loader 生命周期）。 */
export type BindResourceLoaderTrustOptions = {
  /** 规范化后的项目 cwd。 */
  cwd: string
  settingsManager: SettingsManager
  trustStore: ProjectTrustStore
  /** 当前装配的信任状态；每次重载解析后就地更新（项目摘要据此展示）。 */
  state: ProjectTrustState
  /**
   * 本宿主内的显式信任决定（`decideProjectTrust` 未保存时也生效）。
   * 每次重载前重新读取，使「先完成信任再重载」能真正生效。
   */
  explicitDecision?: () => boolean | undefined
  /** 用户扩展 `project_trust` 可用的上下文（重载期间仍可经宿主交互通道应答）。 */
  projectTrustContext?: () => ProjectTrustContext | undefined
  /** 扩展处理错误的诊断出口。 */
  onExtensionErrors?: (errors: readonly string[]) => void
}

/** 绑定结果：`state` 为最近一次解析后的权威信任状态。 */
export type BoundResourceLoaderTrust = {
  state: () => ProjectTrustState
}

/** 可写的 loader 形状（公开 reload 方法，不触碰任何私有字段）。 */
type ReloadableLoader = ResourceLoader & {
  reload: ResourceLoader['reload']
}

/**
 * 已绑定的 loader 表。
 *
 * 用 WeakMap 避免为泄漏的 loader 保活；值只是宿主侧的信任状态读取器。
 */
const boundLoaders = new WeakMap<object, BoundResourceLoaderTrust>()

/**
 * 给公开 `ResourceLoader.reload` 加宿主信任检查。
 *
 * 幂等绑定：同一 loader 只包一次，重复调用返回既有绑定。
 */
export function bindResourceLoaderTrust(
  loader: ResourceLoader,
  options: BindResourceLoaderTrustOptions,
): BoundResourceLoaderTrust {
  const target = loader as ReloadableLoader
  const existing = boundLoaders.get(target)
  if (existing) return existing

  const original = target.reload.bind(loader)
  const binding: BoundResourceLoaderTrust = {
    state: () => options.state,
  }

  target.reload = async () => {
    // 必须使用本次 bootstrap 新加载的用户扩展，不能把旧 loader 中已信任的
    // 项目扩展当作 project_trust 裁决者，也不能执行旧版用户处理器。
    await original({
      resolveProjectTrust: async ({ extensionsResult }) => {
        const extensionErrors: string[] = []
        const override = options.explicitDecision?.()
        const decision = await resolveProjectTrustDecision({
          cwd: options.cwd,
          settingsManager: options.settingsManager,
          trustStore: options.trustStore,
          extensionsResult,
          extensionErrors,
          ...(override !== undefined ? { override } : {}),
          ...(options.projectTrustContext
            ? { projectTrustContext: options.projectTrustContext() }
            : {}),
        })
        if (extensionErrors.length > 0) options.onExtensionErrors?.(extensionErrors)
        Object.assign(options.state, decision, { extensionErrors })
        if (!decision.savedPath) delete options.state.savedPath
        if (decision.status === 'needs-trust') throw new ResourceReloadTrustError(options.state)
        return decision.status === 'trusted'
      },
    })
  }

  boundLoaders.set(target, binding)
  return binding
}
