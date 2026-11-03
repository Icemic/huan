/**
 * 当前会话/项目的资源清单：实际加载来源、扩展、Skills、模板与诊断。
 *
 * 正文只在显式请求时加载；本组件只展示传入快照，不读取 store 或宿主。
 * 列表行与分组使用官方 Item/Field 组合，页面只负责布局。
 */

import type { HarnessResourceSnapshot } from '@huan/protocol'
import { Trans } from '@lingui/react/macro'
import { Loader2Icon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item'

function ResourceSection({
  title,
  empty,
  children,
}: {
  title: string
  empty: boolean
  children: ReactNode
}) {
  return (
    <FieldSet>
      <FieldLegend variant="label">{title}</FieldLegend>
      {empty ? (
        <FieldDescription>
          <Trans>无</Trans>
        </FieldDescription>
      ) : (
        children
      )}
    </FieldSet>
  )
}

const sourceLabel = (info: { source: string; scope: string; origin: string }): string =>
  `${info.source} · ${info.scope} · ${info.origin}`

/** 正文预览：只在显式加载后出现，保留换行与滚动上限。 */
function ResourceText({ text }: { text: string }) {
  return (
    <pre className="bg-muted/50 max-h-40 overflow-auto rounded-md p-2 whitespace-pre-wrap">
      {text}
    </pre>
  )
}

/** 资源清单正文区；文本只在显式请求时加载。 */
export function SettingsResourcePane({
  resources,
  showText,
  busy,
  onToggleText,
}: {
  resources: HarnessResourceSnapshot
  showText: boolean
  busy: boolean
  onToggleText: () => void
}) {
  return (
    <div data-slot="huan-resources" className="flex flex-col gap-4">
      <FieldGroup>
        <Field orientation="responsive">
          <FieldContent>
            <FieldDescription>
              {resources.loadedFrom === 'session' ? (
                <Trans>当前会话正在使用的 loader</Trans>
              ) : (
                <Trans>受信装配缓存（未重新执行扩展）</Trans>
              )}
              {' · '}
              {resources.projectResourcesLoaded ? (
                <Trans>项目资源已加载</Trans>
              ) : (
                <Trans>项目资源未加载</Trans>
              )}
            </FieldDescription>
            <FieldDescription className="font-mono break-all">
              {resources.agentDir}
            </FieldDescription>
          </FieldContent>
          <Button
            size="sm"
            variant="outline"
            aria-label={showText ? '隐藏指令/系统提示文本' : '显示指令/系统提示文本'}
            disabled={busy}
            onClick={onToggleText}
          >
            {busy && <Loader2Icon aria-hidden className="animate-spin" />}
            {showText ? <Trans>隐藏指令/系统提示文本</Trans> : <Trans>显示指令/系统提示文本</Trans>}
          </Button>
        </Field>
        {resources.trustNote && (
          <Alert variant="destructive">
            <AlertDescription>{resources.trustNote}</AlertDescription>
          </Alert>
        )}
      </FieldGroup>

      <ResourceSection title="指令文件" empty={resources.instructions.length === 0}>
        <ItemGroup className="gap-1">
          {resources.instructions.map((item) => (
            <Item key={item.path} size="xs" variant="muted" className="flex-col items-stretch">
              <ItemContent>
                <ItemTitle className="line-clamp-none font-mono break-all">{item.path}</ItemTitle>
                <ItemDescription>
                  {item.bytes} B{item.textTruncated ? '（已截断）' : ''}
                </ItemDescription>
              </ItemContent>
              {item.text !== undefined && <ResourceText text={item.text} />}
            </Item>
          ))}
        </ItemGroup>
      </ResourceSection>

      <ResourceSection title="System prompt" empty={!resources.systemPrompt}>
        {resources.systemPrompt && (
          <ItemGroup className="gap-1">
            <Item size="xs" variant="muted" className="flex-col items-stretch">
              <ItemContent>
                <ItemTitle>{resources.systemPrompt.source ?? '（内置/默认）'}</ItemTitle>
                <ItemDescription>
                  {resources.systemPrompt.bytes} B
                  {resources.systemPrompt.textTruncated ? '（已截断）' : ''}
                </ItemDescription>
              </ItemContent>
              {resources.systemPrompt.text !== undefined && (
                <ResourceText text={resources.systemPrompt.text} />
              )}
            </Item>
            {resources.systemPrompt.append.map((item, index) => (
              <Item
                key={`${item.source ?? 'append'}:${item.bytes}`}
                size="xs"
                variant="muted"
                className="flex-col items-stretch"
              >
                <ItemContent>
                  <ItemTitle>追加片段 {item.source ?? `#${index + 1}`}</ItemTitle>
                  <ItemDescription>{item.bytes} B</ItemDescription>
                </ItemContent>
                {item.text !== undefined && <ResourceText text={item.text} />}
              </Item>
            ))}
          </ItemGroup>
        )}
      </ResourceSection>

      <ResourceSection title="扩展" empty={resources.extensions.length === 0}>
        <ItemGroup className="gap-1">
          {resources.extensions.map((item) => (
            <Item key={item.path} size="xs" variant="muted">
              <ItemContent>
                <ItemTitle className="line-clamp-none font-mono break-all">
                  {item.path}
                  {item.hidden && '（隐藏）'}
                </ItemTitle>
                <ItemDescription>
                  {sourceLabel(item.sourceInfo)}；命令 {item.commands.length}，工具{' '}
                  {item.tools.length}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </ResourceSection>

      <ResourceSection title="Skills" empty={resources.skills.length === 0}>
        <ItemGroup className="gap-1">
          {resources.skills.map((item) => (
            <Item key={`${item.sourceInfo.path}:${item.name}`} size="xs" variant="muted">
              <ItemContent>
                <ItemTitle>{item.name}</ItemTitle>
                <ItemDescription>
                  {item.description}；{sourceLabel(item.sourceInfo)}
                  {item.disableModelInvocation ? '；仅 /skill 显式调用' : ''}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </ResourceSection>

      <ResourceSection title="模板命令" empty={resources.prompts.length === 0}>
        <ItemGroup className="gap-1">
          {resources.prompts.map((item) => (
            <Item key={`${item.sourceInfo.path}:${item.name}`} size="xs" variant="muted">
              <ItemContent>
                <ItemTitle>/{item.name}</ItemTitle>
                <ItemDescription>
                  {item.description}；{sourceLabel(item.sourceInfo)}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </ResourceSection>

      <ResourceSection title="终端主题" empty={resources.themes.length === 0}>
        <ItemGroup className="gap-1">
          {resources.themes.map((item) => (
            <Item key={item.path ?? item.name} size="xs" variant="muted">
              <ItemContent>
                <ItemTitle>{item.name}</ItemTitle>
                {item.sourceInfo && (
                  <ItemDescription>{sourceLabel(item.sourceInfo)}</ItemDescription>
                )}
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </ResourceSection>

      <ResourceSection title="声明 packages" empty={resources.packages.length === 0}>
        <ItemGroup className="gap-1">
          {resources.packages.map((item) => (
            <Item key={item.source} size="xs" variant="muted">
              <ItemContent>
                <ItemTitle className="line-clamp-none font-mono break-all">{item.source}</ItemTitle>
                {item.autoload === false && <ItemDescription>autoload=false</ItemDescription>}
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </ResourceSection>

      <ResourceSection title="实际加载来源" empty={resources.loaded.length === 0}>
        <ItemGroup className="gap-1">
          {resources.loaded.map((item) => (
            <Item key={`${item.kind}:${item.path}:${item.name}`} size="xs" variant="muted">
              <ItemContent>
                <ItemTitle>
                  [{item.kind}] {item.name}
                </ItemTitle>
                <ItemDescription>
                  {item.source} · {item.scope}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </ResourceSection>

      <ResourceSection title="资源诊断" empty={resources.diagnostics.length === 0}>
        <Alert variant="destructive">
          <AlertDescription>
            <ul className="flex list-disc flex-col gap-1 ps-4">
              {resources.diagnostics.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      </ResourceSection>
    </div>
  )
}
