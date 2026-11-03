/**
 * 共享模型目录刷新：唯一持有刷新代数与在途刷新。
 *
 * 该服务不持有会话；刷新完成通过组合根注入的通知回调广播快照。
 */

import type { HarnessModelInfo, HarnessModelRefreshResult } from '@huan/protocol'
import { type createSharedModelRuntime, listModelCatalog } from '../model-catalog.js'
import { withTimeout } from './shared.js'

export type SharedModelRuntime = Awaited<ReturnType<typeof createSharedModelRuntime>>

export type ModelServiceDeps = {
  modelRuntime: SharedModelRuntime
  refreshCatalogOnStart: boolean
  refreshTimeoutMs: number
  diagnose: (message: string) => void
  addSafeDiagnostic: (
    code: 'catalog-refresh-failed' | 'assembly-warning' | 'model-fallback',
  ) => void
  /** 目录代数变化后广播权威快照（组合根接入 live records）。 */
  onChanged: () => void
}

export class ModelCatalogService {
  private revision = 0
  private refreshInFlight: Promise<HarnessModelRefreshResult> | undefined

  constructor(private readonly deps: ModelServiceDeps) {}

  get modelCatalogRevision(): number {
    return this.revision
  }

  /** 启动期受控刷新：失败只记诊断，不阻断启动或信任决定。 */
  async refreshOnStart(): Promise<void> {
    if (!this.deps.refreshCatalogOnStart) return
    try {
      await withTimeout(
        this.deps.modelRuntime.refresh({ allowNetwork: true }),
        this.deps.refreshTimeoutMs,
        '模型目录刷新',
      ).then(
        ({ errors }) => {
          for (const message of errors.values()) {
            this.deps.diagnose(`模型目录刷新：${message.message}`)
          }
          if (errors.size) this.deps.addSafeDiagnostic('catalog-refresh-failed')
        },
        (error: unknown) => {
          this.deps.diagnose(`模型目录刷新失败：${String(error)}`)
          this.deps.addSafeDiagnostic('catalog-refresh-failed')
        },
      )
    } catch (error) {
      this.deps.diagnose(`模型目录刷新失败：${String(error)}`)
      this.deps.addSafeDiagnostic('catalog-refresh-failed')
    }
  }

  /** 本地物化（认证变化/装配后）：不联网，只广播当前目录。 */
  async refreshLocal(providers?: readonly string[]): Promise<void> {
    try {
      await withTimeout(
        this.deps.modelRuntime.refresh({
          allowNetwork: false,
          ...(providers?.length ? { providers: [...providers] } : {}),
        }),
        this.deps.refreshTimeoutMs,
        '本地模型目录刷新',
      )
    } catch {
      // 认证后刷新失败只保留受控代码，不把原始错误暴露给 UI。
      this.deps.addSafeDiagnostic('catalog-refresh-failed')
      throw new Error('本地模型目录刷新失败')
    }
    this.bump()
  }

  /** 显式联网刷新：同一时刻只跑一次，避免重复请求 provider 目录。 */
  async refreshExplicit(): Promise<HarnessModelRefreshResult> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = (async () => {
        let failedProviders: string[] = []
        try {
          const result = await withTimeout(
            this.deps.modelRuntime.refresh({ allowNetwork: true }),
            this.deps.refreshTimeoutMs,
            '模型目录刷新',
          )
          failedProviders = [...result.errors.keys()]
          for (const [provider, error] of result.errors) {
            this.deps.diagnose(`模型目录刷新（${provider}）：${error.message}`)
          }
          if (failedProviders.length) this.deps.addSafeDiagnostic('catalog-refresh-failed')
        } catch (error) {
          this.deps.diagnose(`模型目录刷新失败：${String(error)}`)
          this.deps.addSafeDiagnostic('catalog-refresh-failed')
          // 超时/异常时无法区分 provider：整体标记失败（UI 显示为刷新未完成）。
          failedProviders = ['*']
        }
        this.bump()
        return { models: this.list(), failedProviders }
      })().finally(() => {
        this.refreshInFlight = undefined
      })
    }
    return this.refreshInFlight
  }

  list(): readonly HarnessModelInfo[] {
    return listModelCatalog(this.deps.modelRuntime)
  }

  /**
   * 模型范围（用户启用/工作区覆盖）变化：目录内容未变，但候选已变。
   * 推进既有目录代数并复用快照广播，不新建订阅通道。
   */
  notifyScopeChanged(): void {
    this.bump()
  }

  private bump(): void {
    this.revision += 1
    this.deps.onChanged()
  }
}
