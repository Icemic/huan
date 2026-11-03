/**
 * 统一设置容器：顶栏唯一入口、固定标题/关闭、左侧垂直页签与右侧独立滚动。
 *
 * 结构参考官方 base-nova sidebar-13 设置弹层：标题固定、左侧导航列、右侧内容列；
 * 导航由官方 Tabs 垂直方向实现，不引入应用侧栏依赖。导航状态只在
 * settings-ui-store（open/page）；本组件只负责展示与触发导航，页面数据加载由
 * 组合根根据页签统一编排，认证与诊断内容直接复用各自 feature。
 */

import { HARNESS_PROTOCOL_VERSION } from '@huan/protocol'
import { useServiceStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import {
  ActivityIcon,
  FileJsonIcon,
  MessagesSquareIcon,
  PaletteIcon,
  ServerIcon,
  Settings2Icon,
  SparklesIcon,
  WrenchIcon,
} from 'lucide-react'
import { type ReactNode, useId } from 'react'
import { GlobalSettingsContent, SettingsSaveActions } from '@/components/global-settings-content'
import { HostStatusContent } from '@/components/pi-host-status'
import { ContextMcpDialog, GlobalMcpContent } from '@/components/pi-mcp-panel'
import { ProviderAuthContent } from '@/components/pi-provider-auth'
import { ContextSettingsDialog } from '@/components/settings-resources-dialog'
import { ThemeSelector } from '@/components/theme-selector'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { useSettingsUiStore } from '@/state/app-context'
import type { SettingsPage } from '@/state/settings-ui-store'

const SETTINGS_PAGES = [
  { value: 'appearance', label: <Trans>外观</Trans>, icon: PaletteIcon },
  { value: 'models', label: <Trans>模型与服务商</Trans>, icon: SparklesIcon },
  { value: 'conversation', label: <Trans>对话</Trans>, icon: MessagesSquareIcon },
  { value: 'tools', label: <Trans>工具与资源</Trans>, icon: WrenchIcon },
  { value: 'mcp', label: <Trans>MCP</Trans>, icon: ServerIcon },
  { value: 'advanced', label: <Trans>高级</Trans>, icon: FileJsonIcon },
  { value: 'service', label: <Trans>服务与诊断</Trans>, icon: ActivityIcon },
] as const satisfies readonly {
  value: SettingsPage
  label: ReactNode
  icon: typeof PaletteIcon
}[]

/** 顶栏唯一设置入口；服务错误与进行中认证只在入口上做小标记。 */
export function SettingsButton() {
  const page = useSettingsUiStore((state) => state.page)
  const openPage = useSettingsUiStore((state) => state.openPage)
  const host = useServiceStore((state) => state.host)
  const hostError = useServiceStore((state) => state.hostError)
  const workspaceState = useServiceStore((state) => state.workspaceState)
  const activeAuthCount = useServiceStore(
    (state) =>
      (state.providerAuth?.operations ?? []).filter(
        (operation) =>
          operation.phase !== 'succeeded' &&
          operation.phase !== 'failed' &&
          operation.phase !== 'cancelled',
      ).length,
  )
  const protocolMismatch = host !== undefined && host.protocolVersion !== HARNESS_PROTOCOL_VERSION
  const serviceIssue =
    hostError !== undefined ||
    protocolMismatch ||
    (workspaceState !== undefined && workspaceState !== 'ok')

  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label="设置"
      data-slot="huan-settings-trigger"
      onClick={() => openPage(page)}
    >
      <Settings2Icon aria-hidden />
      <Trans>设置</Trans>
      {serviceIssue && (
        <span
          className="bg-destructive size-1.5 rounded-full"
          aria-hidden
          data-slot="huan-settings-service-issue"
        />
      )}
      {activeAuthCount > 0 && (
        <Badge variant="secondary" data-slot="huan-settings-auth-count">
          {activeAuthCount}
        </Badge>
      )}
    </Button>
  )
}

/** 单个设置页：固定页头、独立滚动正文、固定底部动作。 */
function SettingsPanel({
  value,
  title,
  description,
  actions,
  children,
}: {
  value: SettingsPage
  title: ReactNode
  description: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <TabsContent value={value} className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b px-4 py-3">
        <h2 className="font-heading text-base leading-none font-medium">{title}</h2>
        <p className="text-muted-foreground">{description}</p>
      </header>
      <ScrollArea
        className={cn('flex min-h-0 flex-1 flex-col', '*:data-[slot=scroll-area-viewport]:flex-1')}
      >
        <div className="px-4 py-4">{children}</div>
      </ScrollArea>
      {actions ? <div className="shrink-0 border-t px-4 py-3">{actions}</div> : null}
    </TabsContent>
  )
}

/** 统一设置对话框：标题固定、导航列不被长内容拉伸，右侧内容独立滚动。 */
export function SettingsDialog() {
  const open = useSettingsUiStore((state) => state.open)
  const page = useSettingsUiStore((state) => state.page)
  const openPage = useSettingsUiStore((state) => state.openPage)
  const close = useSettingsUiStore((state) => state.close)
  const finishClose = useSettingsUiStore((state) => state.finishClose)
  const themeId = useId()

  // 保持受控 Root 常驻：关闭时交给 Base UI 播放退出动画并卸载 popup，
  // 页面内容在退出完成前保持可见；清理由 finishClose 在之后触发。
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
      onOpenChangeComplete={(next) => {
        if (!next) finishClose()
      }}
    >
      <DialogContent
        data-slot="huan-settings-dialog"
        aria-label="设置"
        className="flex h-[min(80dvh,44rem)] w-[min(60rem,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <DialogHeader className="shrink-0 border-b px-4 py-3 pe-12">
          <DialogTitle>
            <Trans>设置</Trans>
          </DialogTitle>
        </DialogHeader>

        <Tabs
          value={page}
          orientation="vertical"
          onValueChange={(value) => openPage(value as SettingsPage)}
          className="min-h-0 flex-1 gap-0"
        >
          <ScrollArea
            data-slot="huan-settings-nav"
            className={cn(
              'flex min-h-0 w-36 shrink-0 flex-col border-e sm:w-44',
              '*:data-[slot=scroll-area-viewport]:flex-1',
            )}
          >
            <div className="p-2">
              <TabsList
                variant="line"
                aria-label="设置分类"
                className="w-full flex-col items-stretch"
              >
                {SETTINGS_PAGES.map((item) => {
                  const Icon = item.icon
                  return (
                    <TabsTrigger key={item.value} value={item.value}>
                      <Icon aria-hidden />
                      <span className="truncate">{item.label}</span>
                    </TabsTrigger>
                  )
                })}
              </TabsList>
            </div>
          </ScrollArea>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <SettingsPanel
              value="appearance"
              title={<Trans>外观</Trans>}
              description={<Trans>仅影响此浏览器。</Trans>}
            >
              <FieldGroup>
                <Field orientation="responsive">
                  <FieldContent>
                    <FieldLabel htmlFor={themeId}>
                      <Trans>主题</Trans>
                    </FieldLabel>
                    <FieldDescription>
                      <Trans>选择后立即生效，保存在此浏览器。</Trans>
                    </FieldDescription>
                  </FieldContent>
                  <ThemeSelector id={themeId} />
                </Field>
              </FieldGroup>
            </SettingsPanel>

            <SettingsPanel
              value="models"
              title={<Trans>模型与服务商</Trans>}
              description={<Trans>默认模型、模型范围与服务商登录。</Trans>}
              actions={<SettingsSaveActions />}
            >
              <div className="flex flex-col gap-6">
                <GlobalSettingsContent page="models" />
                <Separator />
                <ProviderAuthContent />
              </div>
            </SettingsPanel>

            <SettingsPanel
              value="conversation"
              title={<Trans>对话</Trans>}
              description={<Trans>队列、重试与自动压缩。</Trans>}
              actions={<SettingsSaveActions />}
            >
              <GlobalSettingsContent page="conversation" />
            </SettingsPanel>

            <SettingsPanel
              value="tools"
              title={<Trans>工具与资源</Trans>}
              description={<Trans>默认工具、Skill 命令与图片处理。</Trans>}
              actions={<SettingsSaveActions />}
            >
              <GlobalSettingsContent page="tools" />
            </SettingsPanel>

            <SettingsPanel
              value="mcp"
              title={<Trans>MCP</Trans>}
              description={<Trans>全局服务器配置；连接与工具从会话查看。</Trans>}
            >
              <GlobalMcpContent />
            </SettingsPanel>

            <SettingsPanel
              value="advanced"
              title={<Trans>高级</Trans>}
              description={<Trans>用户设置原文与传输模式。</Trans>}
              actions={<SettingsSaveActions />}
            >
              <GlobalSettingsContent page="advanced" />
            </SettingsPanel>

            <SettingsPanel
              value="service"
              title={<Trans>服务与诊断</Trans>}
              description={<Trans>服务连接与用户空间。</Trans>}
            >
              <HostStatusContent />
            </SettingsPanel>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

/** 上下文资源与 MCP 弹层：由会话/项目入口显式打开，不占用统一设置导航。 */
export function ContextDialogs() {
  return (
    <>
      <ContextSettingsDialog />
      <ContextMcpDialog />
    </>
  )
}
