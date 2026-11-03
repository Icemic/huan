/**
 * 设置表单字段：用户/项目 settings.json 的受控编辑片段。
 *
 * 这里只做字段展示与 JSON 原文局部更新，不持有草稿、保存或加载状态；
 * 草稿与写入统一由 settings feature store 负责。普通表单使用中文字段名，
 * JSON 键名只在高级原文编辑中直接出现。
 */

import type { HarnessSettingsFile } from '@huan/protocol'
import { Trans } from '@lingui/react/macro'
import type { ChangeEvent, ReactNode } from 'react'
import { useEffect, useId, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemHeader,
  ItemTitle,
} from '@/components/ui/item'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const TRANSPORTS = ['auto', 'sse', 'websocket', 'websocket-cached'] as const
export const QUEUE_MODES = ['all', 'one-at-a-time'] as const

const THINKING_LABELS: Record<string, string> = {
  off: '关闭',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
}
const QUEUE_LABELS: Record<string, string> = {
  all: '全部',
  'one-at-a-time': '逐条',
}
const TRANSPORT_LABELS: Record<string, string> = {
  auto: '自动',
  sse: 'SSE',
  websocket: 'WebSocket',
  'websocket-cached': 'WebSocket（缓存）',
}
/** Base UI Select 不接受空字符串值；用哨兵表示“未设置”。 */
const UNSET = '__unset__'

const triStateItems = { [UNSET]: '未设置（Pi 默认）', true: '开', false: '关' }
const enumItems = (values: readonly string[], labels: Record<string, string>) => ({
  [UNSET]: '未设置（Pi 默认）',
  ...Object.fromEntries(values.map((value) => [value, labels[value] ?? value])),
})

export type ParsedSettingsDraft =
  | { value: Record<string, unknown>; error?: undefined }
  | { value?: undefined; error: string }

/** 浏览器侧轻量预检：只判断 JSON/根对象/污染键；schema 由宿主保存时校验。 */
export function parseSettingsDraft(content: string): ParsedSettingsDraft {
  if (content.trim() === '') return { error: '设置文件为空；请写入至少 `{}`。' }
  const source = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return { error: 'JSON 解析失败；请检查括号、引号与逗号是否配对。' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: '设置根必须是 JSON 对象。' }
  }
  const unsafe = findUnsafeKey(parsed)
  if (unsafe) return { error: `不允许的键：${unsafe}（原型污染防护）。` }
  return { value: parsed as Record<string, unknown> }
}

function findUnsafeKey(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findUnsafeKey(item)
      if (hit) return hit
    }
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return key
    const hit = findUnsafeKey(item)
    if (hit) return hit
  }
  return undefined
}

/** 读取嵌套字段（不创建中间对象）。 */
export function fieldOf(
  root: Record<string, unknown> | undefined,
  path: readonly string[],
): unknown {
  let node: unknown = root
  for (const key of path) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

export function stringField(
  root: Record<string, unknown> | undefined,
  path: readonly string[],
): string {
  const value = fieldOf(root, path)
  return typeof value === 'string' ? value : ''
}

export function numberField(
  root: Record<string, unknown> | undefined,
  path: readonly string[],
): string {
  const value = fieldOf(root, path)
  return typeof value === 'number' ? String(value) : ''
}

/** 只修改指定嵌套键，其余键原样保留。 */
export function setField(
  root: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(root)) as Record<string, unknown>
  let node: Record<string, unknown> = copy
  for (const key of path.slice(0, -1)) {
    const child = node[key]
    if (child === null || typeof child !== 'object' || Array.isArray(child)) {
      if (value === undefined) return copy
      node[key] = {}
    }
    node = node[key] as Record<string, unknown>
  }
  const last = path.at(-1) ?? ''
  if (value === undefined) delete node[last]
  else node[last] = value
  return copy
}

/** 三态布尔字段：未设置保持 Pi 默认，不把缺省强制写成 false。 */
export function BooleanField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string
  value: unknown
  onChange: (value: boolean | undefined) => void
  disabled: boolean
}) {
  const id = useId()
  const current = value === true ? 'true' : value === false ? 'false' : UNSET
  return (
    <Field orientation="responsive" data-disabled={disabled}>
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
      </FieldContent>
      <Select
        value={current}
        items={triStateItems}
        onValueChange={(next) => onChange(next === UNSET ? undefined : next === 'true')}
        disabled={disabled}
      >
        <SelectTrigger id={id} size="sm" className="min-w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="min-w-44">
          <SelectItem value={UNSET}>未设置（Pi 默认）</SelectItem>
          <SelectItem value="true">开</SelectItem>
          <SelectItem value="false">关</SelectItem>
        </SelectContent>
      </Select>
    </Field>
  )
}

/** 列表字段：本地文本在失焦时提交，避免每次按键重排。 */
export function ListField({
  label,
  description,
  value,
  onChange,
  disabled,
}: {
  label: string
  description?: ReactNode
  value: readonly string[] | undefined
  onChange: (value: string[] | undefined) => void
  disabled: boolean
}) {
  const id = useId()
  const [text, setText] = useState(() => (value ?? []).join('\n'))
  const committed = (value ?? []).join('\n')
  useEffect(() => {
    setText(committed)
  }, [committed])
  return (
    <Field data-disabled={disabled}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <Textarea
        id={id}
        rows={3}
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          const lines = text
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
          onChange(lines.length > 0 ? lines : undefined)
        }}
      />
    </Field>
  )
}

type FieldUpdate = (path: readonly string[], next: unknown) => void

function EnumField({
  label,
  value,
  values,
  labels,
  onChange,
  disabled,
}: {
  label: string
  value: string
  values: readonly string[]
  labels: Record<string, string>
  onChange: (value: string | undefined) => void
  disabled: boolean
}) {
  const id = useId()
  return (
    <Field orientation="responsive" data-disabled={disabled}>
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
      </FieldContent>
      <Select
        value={value || UNSET}
        items={enumItems(values, labels)}
        onValueChange={(nextValue) => {
          const next = nextValue ?? UNSET
          onChange(next === UNSET ? undefined : next)
        }}
        disabled={disabled}
      >
        <SelectTrigger id={id} size="sm" className="min-w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="min-w-48">
          <SelectItem value={UNSET}>未设置（Pi 默认）</SelectItem>
          {values.map((item) => (
            <SelectItem key={item} value={item}>
              {labels[item] ?? item}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

/** 默认模型与 Thinking；适用于用户设置和工作区项目设置。 */
export function DefaultModelFields({
  value,
  onChange,
  disabled,
}: {
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  disabled: boolean
}) {
  const update: FieldUpdate = (path, next) => onChange(setField(value, path, next))
  const providerId = useId()
  const modelId = useId()
  return (
    <FieldSet>
      <FieldLegend>
        <Trans>默认模型</Trans>
      </FieldLegend>
      <FieldDescription>
        <Trans>用于新会话；当前会话的模型仍由输入区选择。</Trans>
      </FieldDescription>
      <FieldGroup>
        <div className="grid gap-4 @md/field-group:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={providerId}>
              <Trans>默认服务商</Trans>
            </FieldLabel>
            <Input
              id={providerId}
              value={stringField(value, ['defaultProvider'])}
              disabled={disabled}
              onChange={(event) => update(['defaultProvider'], event.target.value || undefined)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={modelId}>
              <Trans>默认模型 ID</Trans>
            </FieldLabel>
            <Input
              id={modelId}
              value={stringField(value, ['defaultModel'])}
              disabled={disabled}
              onChange={(event) => update(['defaultModel'], event.target.value || undefined)}
            />
          </Field>
        </div>
        <EnumField
          label="默认 Thinking 级别"
          value={stringField(value, ['defaultThinkingLevel'])}
          values={THINKING_LEVELS}
          labels={THINKING_LABELS}
          onChange={(next) => update(['defaultThinkingLevel'], next)}
          disabled={disabled}
        />
      </FieldGroup>
    </FieldSet>
  )
}

/** 队列、重试与自动压缩。 */
export function ConversationFields({
  value,
  onChange,
  disabled,
}: {
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  disabled: boolean
}) {
  const update: FieldUpdate = (path, next) => onChange(setField(value, path, next))
  const applyNumber = (path: readonly string[]) => (event: ChangeEvent<HTMLInputElement>) => {
    const raw = event.target.value.trim()
    const parsed = raw === '' ? undefined : Number(raw)
    update(path, parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined)
  }
  const reserveId = useId()
  const recentId = useId()
  return (
    <FieldSet>
      <FieldLegend>
        <Trans>队列与压缩</Trans>
      </FieldLegend>
      <FieldGroup>
        <EnumField
          label="转向队列"
          value={stringField(value, ['steeringMode'])}
          values={QUEUE_MODES}
          labels={QUEUE_LABELS}
          onChange={(next) => update(['steeringMode'], next)}
          disabled={disabled}
        />
        <EnumField
          label="后续队列"
          value={stringField(value, ['followUpMode'])}
          values={QUEUE_MODES}
          labels={QUEUE_LABELS}
          onChange={(next) => update(['followUpMode'], next)}
          disabled={disabled}
        />
        <BooleanField
          label="自动重试"
          value={fieldOf(value, ['retry', 'enabled'])}
          disabled={disabled}
          onChange={(next) => update(['retry', 'enabled'], next)}
        />
        <BooleanField
          label="启用自动压缩"
          value={fieldOf(value, ['compaction', 'enabled'])}
          disabled={disabled}
          onChange={(next) => update(['compaction', 'enabled'], next)}
        />
        <FieldDescription>
          <Trans>保存后同步到已打开的会话；项目设置覆盖仍然有效。</Trans>
        </FieldDescription>
        <div className="grid gap-4 @md/field-group:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={reserveId}>
              <Trans>压缩预留 tokens</Trans>
            </FieldLabel>
            <Input
              id={reserveId}
              type="number"
              min={0}
              value={numberField(value, ['compaction', 'reserveTokens'])}
              disabled={disabled}
              onChange={applyNumber(['compaction', 'reserveTokens'])}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={recentId}>
              <Trans>压缩保留最近 tokens</Trans>
            </FieldLabel>
            <Input
              id={recentId}
              type="number"
              min={0}
              value={numberField(value, ['compaction', 'keepRecentTokens'])}
              disabled={disabled}
              onChange={applyNumber(['compaction', 'keepRecentTokens'])}
            />
          </Field>
        </div>
      </FieldGroup>
    </FieldSet>
  )
}

/** 默认工具、Skill 命令与图片处理。 */
export function ToolsFields({
  value,
  onChange,
  disabled,
}: {
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  disabled: boolean
}) {
  const update: FieldUpdate = (path, next) => onChange(setField(value, path, next))
  return (
    <FieldSet>
      <FieldLegend>
        <Trans>工具与图片</Trans>
      </FieldLegend>
      <FieldGroup>
        <ListField
          label="默认工具"
          description={<Trans>每行一个工具名；可用 +name / -name 调整。</Trans>}
          value={
            Array.isArray(fieldOf(value, ['defaultTools']))
              ? (fieldOf(value, ['defaultTools']) as unknown[]).filter(
                  (item): item is string => typeof item === 'string',
                )
              : undefined
          }
          disabled={disabled}
          onChange={(next) => update(['defaultTools'], next)}
        />
        <BooleanField
          label="启用 Skill 命令"
          value={fieldOf(value, ['enableSkillCommands'])}
          disabled={disabled}
          onChange={(next) => update(['enableSkillCommands'], next)}
        />
        <BooleanField
          label="自动缩放图片"
          value={fieldOf(value, ['images', 'autoResize'])}
          disabled={disabled}
          onChange={(next) => update(['images', 'autoResize'], next)}
        />
        <BooleanField
          label="屏蔽图片"
          value={fieldOf(value, ['images', 'blockImages'])}
          disabled={disabled}
          onChange={(next) => update(['images', 'blockImages'], next)}
        />
      </FieldGroup>
    </FieldSet>
  )
}

/** 高级设置中的传输模式；普通页面不再重复展示。 */
export function TransportField({
  value,
  onChange,
  disabled,
}: {
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  disabled: boolean
}) {
  const update: FieldUpdate = (path, next) => onChange(setField(value, path, next))
  return (
    <FieldGroup>
      <EnumField
        label="传输模式"
        value={stringField(value, ['transport'])}
        values={TRANSPORTS}
        labels={TRANSPORT_LABELS}
        onChange={(next) => update(['transport'], next)}
        disabled={disabled}
      />
    </FieldGroup>
  )
}

/** 项目/会话设置中的完整常用项；全局设置按页拆分复用同一批字段。 */
export function CommonSettingsForm({
  value,
  onChange,
  disabled,
}: {
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  disabled: boolean
}) {
  return (
    <FieldGroup data-slot="huan-settings-common">
      <DefaultModelFields value={value} onChange={onChange} disabled={disabled} />
      <FieldSeparator />
      <ConversationFields value={value} onChange={onChange} disabled={disabled} />
      <FieldSeparator />
      <ToolsFields value={value} onChange={onChange} disabled={disabled} />
      <FieldSeparator />
      <TransportField value={value} onChange={onChange} disabled={disabled} />
    </FieldGroup>
  )
}

/** 单个设置文件的磁盘状态摘要；保留 revision 作为冲突诊断信息。 */
export function SettingsFileSummary({ file }: { file: HarnessSettingsFile }) {
  return (
    <Item
      data-slot="huan-settings-file"
      variant="outline"
      size="sm"
      className="flex-col items-stretch"
    >
      <ItemHeader>
        <ItemTitle>
          {file.scope === 'user' ? <Trans>用户设置</Trans> : <Trans>项目设置</Trans>}
        </ItemTitle>
        <Badge variant="secondary">
          {file.exists ? (
            <Trans>已存在</Trans>
          ) : file.readable ? (
            <Trans>尚未创建</Trans>
          ) : (
            <Trans>未读取</Trans>
          )}
        </Badge>
      </ItemHeader>
      <ItemDescription className="font-mono break-all">{file.path || '—'}</ItemDescription>
      <ItemFooter className="text-muted-foreground">
        <span>{file.bytes} B</span>
        <span className="font-mono">
          revision {file.revision ? file.revision.slice(0, 12) : 'null'}
        </span>
      </ItemFooter>
      {file.tooLarge && (
        <ItemContent className="text-destructive">
          <Trans>超过读取上限</Trans>
        </ItemContent>
      )}
      {file.readError && <ItemContent className="text-destructive">{file.readError}</ItemContent>}
      {file.issues.length > 0 && (
        <ul
          data-slot="huan-settings-issues"
          className="text-destructive flex list-disc flex-col gap-1 ps-4"
        >
          {file.issues.map((issue) => (
            <li key={`${issue.kind}:${issue.path}:${issue.message}`}>
              <span className="font-mono">{issue.path}</span> {issue.message}
            </li>
          ))}
        </ul>
      )}
    </Item>
  )
}
