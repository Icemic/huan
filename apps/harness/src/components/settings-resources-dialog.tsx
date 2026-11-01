/**
 * G1.4a：设置与资源清单面板。
 *
 * 设计要点（迭代文档）：
 * - 与 `/settings` 共用同一面板（意图桥打开），也是顶栏可发现入口；
 * - 用户/项目作用域切换；项目未信任时不读取/写入项目设置；
 * - 常用项只改原对象对应键，JSON 编辑器保留未知字段与完整文件语义；
 * - 保存带乐观 revision，冲突明确提示；保存 ≠ 应用，需重载/重启的说明如实展示；
 * - 弹层仅在打开时查询，响应带代次防串页；切换作用域保留未保存草稿；
 * - 指令/system prompt 文本需显式请求，普通快照不含配置文本。
 */
import type {
  HarnessResourceSnapshot,
  HarnessSettingsFile,
  HarnessSettingsIssue,
  HarnessSettingsSaveResult,
  HarnessSettingsScope,
  HarnessSettingsSnapshot,
} from '@huan/protocol'
import { HarnessHttpError, useHarnessThreadState } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { Loader2Icon, RefreshCwIcon, Settings2Icon } from 'lucide-react'
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { clearPiIntent, usePiIntent } from './pi-command-intents'
import { harnessHttpClient } from './pi-http-client'
import { useWorkspace } from './workspace-context'

const PENDING_THREAD_ID = '__pending__'
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const TRANSPORTS = ['auto', 'sse', 'websocket', 'websocket-cached'] as const
const QUEUE_MODES = ['all', 'one-at-a-time'] as const
/** Base UI Select 不接受空字符串值；用哨兵表示“未设置”。 */
const UNSET = '__unset__'
const triStateItems = { [UNSET]: '未设置（Pi 默认）', true: '开', false: '关' }
const enumItems = (values: readonly string[]) => ({
  [UNSET]: '未设置（Pi 默认）',
  ...Object.fromEntries(values.map((value) => [value, value])),
})

const errorText = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

/** 单个作用域的编辑草稿（原文、基线 revision 与最近一次宿主校验问题）。 */
type Draft = {
  content: string
  baseContent: string
  revision: string | null
  issues: readonly HarnessSettingsIssue[]
}

type DraftMap = Record<string, Draft>

const draftKey = (targetKey: string, scope: HarnessSettingsScope) => `${targetKey}|${scope}`

type ParsedDraft =
  | { value: Record<string, unknown>; error?: undefined }
  | { value?: undefined; error: string }

/** 浏览器侧轻量预检：只判断 JSON/根对象/污染键；schema 由宿主保存时校验。 */
function parseDraft(content: string): ParsedDraft {
  if (content.trim() === '') return { error: '设置文件为空；请写入至少 `{}`。' }
  // 与宿主/SDK 一致：允许 UTF-8 BOM；JSON 编辑器仍保留原始字节。
  const source = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    // 不展示解析器原文（可能包含输入片段）；用户可在本地自行检查。
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
function fieldOf(root: Record<string, unknown> | undefined, path: readonly string[]): unknown {
  let node: unknown = root
  for (const key of path) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

function stringField(root: Record<string, unknown> | undefined, path: readonly string[]): string {
  const value = fieldOf(root, path)
  return typeof value === 'string' ? value : ''
}

function numberField(root: Record<string, unknown> | undefined, path: readonly string[]): string {
  const value = fieldOf(root, path)
  return typeof value === 'number' ? String(value) : ''
}

/**
 * 只修改指定嵌套键，其余键（含未知字段）原样保留。
 * value 为 undefined 时删除该键。
 */
function setField(
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

/** 布尔三态（未设置/开/关），保留 Pi 的默认值语义。 */
function BooleanField({
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
  const current = value === true ? 'true' : value === false ? 'false' : UNSET
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <Select
        value={current}
        items={triStateItems}
        onValueChange={(next) => onChange(next === UNSET ? undefined : next === 'true')}
        disabled={disabled}
      >
        <SelectTrigger size="sm" aria-label={label} className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET}>未设置（Pi 默认）</SelectItem>
          <SelectItem value="true">开</SelectItem>
          <SelectItem value="false">关</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

/** 列表字段：本地文本在失焦时提交，避免每次按键重排。 */
function ListField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string
  value: readonly string[] | undefined
  onChange: (value: string[] | undefined) => void
  disabled: boolean
}) {
  const [text, setText] = useState(() => (value ?? []).join('\n'))
  // 仅在提交值真正变化时同步（避免父组件重渲染打断本地输入）。
  const committed = (value ?? []).join('\n')
  useEffect(() => {
    setText(committed)
  }, [committed])
  return (
    <Textarea
      aria-label={label}
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
  )
}

/** 设置文件摘要与问题列表。 */
function FileSummary({ file }: { file: HarnessSettingsFile }) {
  return (
    <div
      data-slot="huan-settings-file"
      className="flex flex-col gap-1 rounded-md border p-2 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {file.scope === 'user' ? <Trans>用户设置</Trans> : <Trans>项目设置</Trans>}
        </span>
        <span className="text-muted-foreground break-all">{file.path}</span>
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-2">
        <span>
          {file.exists ? (
            <Trans>已存在</Trans>
          ) : file.readable ? (
            <Trans>尚未创建（保存时写入）</Trans>
          ) : (
            <Trans>未读取（项目未信任）</Trans>
          )}
        </span>
        <span>{file.bytes} B</span>
        <span className="font-mono">
          revision {file.revision ? file.revision.slice(0, 12) : 'null'}
        </span>
        {file.tooLarge && (
          <span className="text-destructive">
            <Trans>超过读取上限</Trans>
          </span>
        )}
      </div>
      {file.readError && <p className="text-destructive">{file.readError}</p>}
      {file.issues.length > 0 && (
        <ul data-slot="huan-settings-issues" className="text-destructive list-disc ps-4">
          {file.issues.map((issue) => (
            <li key={`${issue.kind}:${issue.path}:${issue.message}`}>
              <span className="font-mono">{issue.path}</span> {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 常用项表单：只写入对应键，不重建配置对象。 */
function CommonSettingsForm({
  value,
  onChange,
  disabled,
}: {
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  disabled: boolean
}) {
  const update = (path: readonly string[], next: unknown) => onChange(setField(value, path, next))
  const applyNumber = (path: readonly string[]) => (event: ChangeEvent<HTMLInputElement>) => {
    const raw = event.target.value.trim()
    const parsed = raw === '' ? undefined : Number(raw)
    update(path, parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined)
  }
  return (
    <div data-slot="huan-settings-common" className="flex flex-col gap-3 text-sm">
      <section className="flex flex-col gap-2">
        <h3 className="font-medium">
          <Trans>默认模型与 Thinking</Trans>
        </h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">defaultProvider</span>
            <Input
              aria-label="默认 provider"
              value={stringField(value, ['defaultProvider'])}
              disabled={disabled}
              onChange={(event) => update(['defaultProvider'], event.target.value || undefined)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">defaultModel</span>
            <Input
              aria-label="默认模型 ID"
              value={stringField(value, ['defaultModel'])}
              disabled={disabled}
              onChange={(event) => update(['defaultModel'], event.target.value || undefined)}
            />
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">defaultThinkingLevel</span>
          <Select
            value={stringField(value, ['defaultThinkingLevel']) || UNSET}
            items={enumItems(THINKING_LEVELS)}
            onValueChange={(next) =>
              update(['defaultThinkingLevel'], next === UNSET ? undefined : next)
            }
            disabled={disabled}
          >
            <SelectTrigger size="sm" aria-label="默认 Thinking 级别" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>未设置（Pi 默认）</SelectItem>
              {THINKING_LEVELS.map((level) => (
                <SelectItem key={level} value={level}>
                  {level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-muted-foreground text-xs">
          <Trans>这里的默认模型只影响未来启动/新会话；当前会话的模型切换仍由模型选择器管理。</Trans>
        </p>
      </section>

      <section className="flex flex-col gap-2 border-t pt-3">
        <h3 className="font-medium">
          <Trans>队列与重试</Trans>
        </h3>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">steeringMode</span>
          <Select
            value={stringField(value, ['steeringMode']) || UNSET}
            items={enumItems(QUEUE_MODES)}
            onValueChange={(next) => update(['steeringMode'], next === UNSET ? undefined : next)}
            disabled={disabled}
          >
            <SelectTrigger size="sm" aria-label="转向队列模式" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>未设置（Pi 默认）</SelectItem>
              {QUEUE_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {mode}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">followUpMode</span>
          <Select
            value={stringField(value, ['followUpMode']) || UNSET}
            items={enumItems(QUEUE_MODES)}
            onValueChange={(next) => update(['followUpMode'], next === UNSET ? undefined : next)}
            disabled={disabled}
          >
            <SelectTrigger size="sm" aria-label="后续队列模式" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>未设置（Pi 默认）</SelectItem>
              {QUEUE_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {mode}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <BooleanField
          label="retry.enabled"
          value={fieldOf(value, ['retry', 'enabled'])}
          disabled={disabled}
          onChange={(next) => update(['retry', 'enabled'], next)}
        />
      </section>

      <section className="flex flex-col gap-2 border-t pt-3">
        <h3 className="font-medium">
          <Trans>上下文压缩</Trans>
        </h3>
        <BooleanField
          label="compaction.enabled"
          value={fieldOf(value, ['compaction', 'enabled'])}
          disabled={disabled}
          onChange={(next) => update(['compaction', 'enabled'], next)}
        />
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">compaction.reserveTokens</span>
            <Input
              aria-label="压缩预留 tokens"
              type="number"
              min={0}
              value={numberField(value, ['compaction', 'reserveTokens'])}
              disabled={disabled}
              onChange={applyNumber(['compaction', 'reserveTokens'])}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">compaction.keepRecentTokens</span>
            <Input
              aria-label="压缩保留 tokens"
              type="number"
              min={0}
              value={numberField(value, ['compaction', 'keepRecentTokens'])}
              disabled={disabled}
              onChange={applyNumber(['compaction', 'keepRecentTokens'])}
            />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2 border-t pt-3">
        <h3 className="font-medium">
          <Trans>工具、Skill 与传输</Trans>
        </h3>
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">
            defaultTools（每行一个；`+name`/`-name` 修饰）
          </span>
          <ListField
            label="默认工具"
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
        </div>
        <BooleanField
          label="enableSkillCommands"
          value={fieldOf(value, ['enableSkillCommands'])}
          disabled={disabled}
          onChange={(next) => update(['enableSkillCommands'], next)}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">transport</span>
          <Select
            value={stringField(value, ['transport']) || UNSET}
            items={enumItems(TRANSPORTS)}
            onValueChange={(next) => update(['transport'], next === UNSET ? undefined : next)}
            disabled={disabled}
          >
            <SelectTrigger size="sm" aria-label="传输模式" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>未设置（Pi 默认）</SelectItem>
              {TRANSPORTS.map((item) => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <BooleanField
          label="images.autoResize"
          value={fieldOf(value, ['images', 'autoResize'])}
          disabled={disabled}
          onChange={(next) => update(['images', 'autoResize'], next)}
        />
        <BooleanField
          label="images.blockImages"
          value={fieldOf(value, ['images', 'blockImages'])}
          disabled={disabled}
          onChange={(next) => update(['images', 'blockImages'], next)}
        />
      </section>

      <p className="text-muted-foreground border-t pt-2 text-xs">
        <Trans>
          顶栏主题只影响本浏览器；此处 `theme`、`tuiMode` 等属于 Pi 终端参数，不影响本页面外观。
          终端专属项可通过 JSON 编辑，但不会在 GUI 生效。
        </Trans>
      </p>
    </div>
  )
}

/** 资源清单片段。 */
function ResourceList({
  title,
  empty,
  children,
}: {
  title: string
  empty: boolean
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-1">
      <h4 className="font-medium">{title}</h4>
      {empty ? <p className="text-muted-foreground text-xs">（无）</p> : children}
    </section>
  )
}

const sourceLabel = (info: { source: string; scope: string; origin: string }): string =>
  `${info.source} · ${info.scope} · ${info.origin}`

export function SettingsResourcesDialog() {
  const metadata = useHarnessThreadState((state) => state.metadata)
  const { workspaces, activeWorkspaceId, startProjectFor } = useWorkspace()
  const intent = usePiIntent()
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState<HarnessSettingsScope>('user')
  const [tab, setTab] = useState<'common' | 'json' | 'resources'>('common')
  const [snapshot, setSnapshot] = useState<HarnessSettingsSnapshot>()
  const [resources, setResources] = useState<HarnessResourceSnapshot>()
  const [drafts, setDrafts] = useState<DraftMap>({})
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [resourceBusy, setResourceBusy] = useState(false)
  const [showText, setShowText] = useState(false)
  const loadGeneration = useRef(0)
  const saveGeneration = useRef(0)
  const resourceGeneration = useRef(0)

  const pending = !metadata.id || metadata.id === PENDING_THREAD_ID
  const workspace = metadata.workspaceId
    ? workspaces.find((item) => item.id === metadata.workspaceId)
    : workspaces.find((item) => item.id === activeWorkspaceId)
  const cwd = metadata.workspacePath ?? (workspace ? startProjectFor(workspace) : undefined)
  const target = useMemo(
    () => (pending ? (cwd ? { workspacePath: cwd } : undefined) : { threadId: metadata.id }),
    [pending, cwd, metadata.id],
  )
  const targetKey = target
    ? 'threadId' in target && target.threadId
      ? `t:${target.threadId}`
      : `w:${target.workspacePath ?? ''}`
    : 'none'
  const key = draftKey(targetKey, scope)
  const draft = drafts[key]
  const parsed = useMemo(() => (draft ? parseDraft(draft.content) : undefined), [draft])
  const dirty = draft ? draft.content !== draft.baseContent : false
  const file = snapshot
    ? scope === 'user'
      ? snapshot.files.user
      : snapshot.files.project
    : undefined
  const snapshotTargetKey = snapshot
    ? snapshot.target.kind === 'session'
      ? `t:${snapshot.target.threadId}`
      : `w:${snapshot.target.workspacePath}`
    : undefined
  const ready = snapshotTargetKey === targetKey
  const scopeBlocked = scope === 'project' && (!ready || !snapshot?.projectTrusted)
  const formDisabled =
    !ready ||
    !draft ||
    parsed?.error !== undefined ||
    scopeBlocked ||
    file?.tooLarge === true ||
    busy === 'save'

  useEffect(() => {
    if (intent?.kind !== 'settings') return
    setOpen(true)
    clearPiIntent(intent.id)
  }, [intent])

  const fetchSettings = useCallback(
    async (options?: { resetScope?: HarnessSettingsScope }) => {
      if (!target) return
      const generation = ++loadGeneration.current
      setBusy('settings')
      try {
        const next = await harnessHttpClient.getSettings(target)
        if (generation !== loadGeneration.current) return
        setSnapshot(next)
        setDrafts((current) => {
          const updated = { ...current }
          for (const nextScope of ['user', 'project'] as const) {
            const nextKey = draftKey(targetKey, nextScope)
            const nextFile = nextScope === 'user' ? next.files.user : next.files.project
            if (options?.resetScope === nextScope) delete updated[nextKey]
            if (!updated[nextKey] && nextFile.readable && !nextFile.tooLarge) {
              // 文件不存在时从合法空对象开始，避免常用项表单被空原文卡住。
              const content = nextFile.exists ? nextFile.content : `${JSON.stringify({})}\n`
              updated[nextKey] = {
                content,
                baseContent: content,
                revision: nextFile.revision,
                issues: [],
              }
            }
          }
          return updated
        })
      } catch (error) {
        if (generation === loadGeneration.current) setNotice(errorText(error))
      } finally {
        if (generation === loadGeneration.current) setBusy(undefined)
      }
    },
    [target, targetKey],
  )

  const fetchResources = useCallback(
    async (withText: boolean) => {
      if (!target) return
      const generation = ++resourceGeneration.current
      setResourceBusy(true)
      try {
        const next = await harnessHttpClient.getResources({
          ...target,
          ...(withText ? { includeText: true } : {}),
        })
        if (generation !== resourceGeneration.current) return
        setResources(next)
        setShowText(withText)
      } catch (error) {
        if (generation === resourceGeneration.current) setNotice(errorText(error))
      } finally {
        if (generation === resourceGeneration.current) setResourceBusy(false)
      }
    },
    [target],
  )

  // 目标切到未信任项目时，避免停留在不可编辑的项目作用域。
  useEffect(() => {
    if (snapshot && !snapshot.projectTrusted && scope === 'project') setScope('user')
  }, [snapshot, scope])

  useEffect(() => {
    if (!open) return
    setNotice(undefined)
    setSnapshot(undefined)
    setResources(undefined)
    setShowText(false)
    void fetchSettings()
    void fetchResources(false)
    return () => {
      // 关闭或目标变化：使在途读取与保存结果失效，避免串到新页面。
      loadGeneration.current += 1
      resourceGeneration.current += 1
      saveGeneration.current += 1
    }
  }, [open, fetchSettings, fetchResources])

  const updateDraft = (content: string) => {
    setDrafts((current) => {
      const existing = current[key]
      if (!existing) return current
      return { ...current, [key]: { ...existing, content, issues: [] } }
    })
  }

  const updateObject = (next: Record<string, unknown>) => {
    updateDraft(`${JSON.stringify(next, null, 2)}\n`)
  }

  const resetDraft = () => {
    if (!draft) return
    setDrafts((current) => ({
      ...current,
      [key]: { ...draft, content: draft.baseContent, issues: [] },
    }))
    setNotice(undefined)
  }

  const reload = () => {
    setNotice(undefined)
    void fetchSettings({ resetScope: scope })
    void fetchResources(false)
  }

  const save = async () => {
    if (!draft || !target || !ready || busy) return
    const version = ++saveGeneration.current
    setBusy('save')
    setNotice(undefined)
    try {
      const result: HarnessSettingsSaveResult = await harnessHttpClient.saveSettings({
        target,
        scope,
        content: draft.content,
        expectedRevision: draft.revision,
      })
      if (version !== saveGeneration.current) return
      if (result.status === 'saved') {
        setSnapshot(result.snapshot)
        setDrafts((current) => ({
          ...current,
          [key]: {
            content: draft.content,
            baseContent: draft.content,
            revision: result.revision,
            issues: [],
          },
        }))
        setNotice(
          `${result.apply.message}${
            result.apply.reloadRequired ? '（已保存，待重载；G1.4b 提供重载入口）' : ''
          }`,
        )
        return
      }
      if (result.status === 'invalid') {
        setDrafts((current) => ({
          ...current,
          [key]: { ...draft, issues: result.issues },
        }))
        setNotice(result.message)
        return
      }
      setNotice(result.message)
    } catch (error) {
      if (version !== saveGeneration.current) return
      setNotice(
        error instanceof HarnessHttpError && error.code === 'settings-conflict'
          ? '保存冲突：设置文件已在其他窗口或进程被修改。请先“重新加载”再合并改动。'
          : errorText(error),
      )
    } finally {
      if (version === saveGeneration.current) setBusy(undefined)
    }
  }

  const commonIssues = draft?.issues ?? []
  const localError = parsed?.error

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-1.5 text-xs"
        aria-label="设置与资源"
        onClick={() => setOpen(true)}
      >
        <Settings2Icon aria-hidden className="size-3.5" />
        <Trans>设置与资源</Trans>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          data-slot="huan-settings-dialog"
          aria-label="设置与资源"
          className="flex max-h-[85dvh] max-w-3xl flex-col"
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>设置与资源</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                编辑用户/项目 settings.json（完整文件语义），并查看实际加载的资源清单。
                保存只写磁盘；常用运行设置与资源需要重载宿主后才会应用。
              </Trans>
            </DialogDescription>
          </DialogHeader>

          {!target && (
            <p role="status" className="text-sm">
              <Trans>当前没有可用的会话或起始目录；请先选择工作区/项目。</Trans>
            </p>
          )}

          {target && (
            <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pe-1">
              {notice && (
                <div
                  role="status"
                  data-slot="huan-settings-notice"
                  className="rounded-md border bg-muted/50 px-2 py-1.5 text-xs whitespace-pre-wrap"
                >
                  {notice}
                </div>
              )}

              {snapshot && (
                <div
                  data-slot="huan-settings-target"
                  className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs"
                >
                  <span className="font-mono break-all">{snapshot.target.workspacePath}</span>
                  <span>
                    {snapshot.target.kind === 'session' ? (
                      <Trans>当前会话固定 cwd</Trans>
                    ) : (
                      <Trans>空白页起始目录</Trans>
                    )}
                  </span>
                  <span>
                    {snapshot.projectTrusted ? (
                      <Trans>项目已信任</Trans>
                    ) : snapshot.trust.decision === 'needs-trust' ? (
                      <Trans>项目待信任决定</Trans>
                    ) : (
                      <Trans>项目未信任</Trans>
                    )}
                  </span>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <div role="tablist" aria-label="设置作用域" className="flex gap-1">
                  <Button
                    size="sm"
                    variant={scope === 'user' ? 'secondary' : 'outline'}
                    role="tab"
                    aria-selected={scope === 'user'}
                    aria-label="编辑用户设置"
                    onClick={() => setScope('user')}
                  >
                    <Trans>用户设置</Trans>
                    {drafts[draftKey(targetKey, 'user')]?.content !==
                      drafts[draftKey(targetKey, 'user')]?.baseContent && (
                      <span
                        data-slot="huan-settings-dirty"
                        className="ms-1 rounded bg-muted px-1 text-xs"
                      >
                        <Trans>未保存</Trans>
                      </span>
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant={scope === 'project' ? 'secondary' : 'outline'}
                    role="tab"
                    aria-selected={scope === 'project'}
                    aria-label="编辑项目设置"
                    onClick={() => setScope('project')}
                    disabled={snapshot !== undefined && !snapshot.projectTrusted}
                  >
                    <Trans>项目设置</Trans>
                    {drafts[draftKey(targetKey, 'project')]?.content !==
                      drafts[draftKey(targetKey, 'project')]?.baseContent && (
                      <span
                        data-slot="huan-settings-dirty"
                        className="ms-1 rounded bg-muted px-1 text-xs"
                      >
                        <Trans>未保存</Trans>
                      </span>
                    )}
                  </Button>
                </div>
                <div className="ms-auto flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label="重新加载设置与资源"
                    disabled={!ready || busy === 'save'}
                    onClick={reload}
                  >
                    {busy === 'settings' ? (
                      <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCwIcon aria-hidden className="size-3.5" />
                    )}
                    <Trans>重新加载</Trans>
                  </Button>
                </div>
              </div>

              {snapshot && !snapshot.projectTrusted && (
                <p role="status" className="text-destructive text-xs">
                  <Trans>
                    项目未信任：不读取也不写入项目设置。请先在项目信任面板允许；用户设置仍可编辑。
                  </Trans>
                </p>
              )}
              {dirty && (
                <p role="status" data-slot="huan-settings-unsaved" className="text-xs">
                  <Trans>
                    当前作用域有未保存改动；切换到另一作用域会保留草稿，
                    重新加载会丢弃该作用域的未保存改动。
                  </Trans>
                </p>
              )}

              {file && <FileSummary file={file} />}

              <div role="tablist" aria-label="设置视图" className="flex gap-1">
                <Button
                  size="sm"
                  variant={tab === 'common' ? 'secondary' : 'ghost'}
                  role="tab"
                  aria-selected={tab === 'common'}
                  onClick={() => setTab('common')}
                >
                  <Trans>常用项</Trans>
                </Button>
                <Button
                  size="sm"
                  variant={tab === 'json' ? 'secondary' : 'ghost'}
                  role="tab"
                  aria-selected={tab === 'json'}
                  onClick={() => setTab('json')}
                >
                  <Trans>JSON 原文</Trans>
                </Button>
                <Button
                  size="sm"
                  variant={tab === 'resources' ? 'secondary' : 'ghost'}
                  role="tab"
                  aria-selected={tab === 'resources'}
                  onClick={() => setTab('resources')}
                >
                  <Trans>资源清单</Trans>
                </Button>
              </div>

              {tab !== 'resources' && !draft && (
                <p className="text-sm">
                  <Trans>该作用域没有可编辑的原文（未信任、读取失败或文件过大）。</Trans>
                </p>
              )}

              {tab !== 'resources' && draft && (
                <div className="flex flex-col gap-2">
                  {localError && (
                    <p data-slot="huan-settings-local-error" className="text-destructive text-xs">
                      {localError}
                    </p>
                  )}
                  {commonIssues.length > 0 && (
                    <ul
                      data-slot="huan-settings-issues"
                      className="text-destructive list-disc ps-4 text-xs"
                    >
                      {commonIssues.map((issue) => (
                        <li key={`${issue.kind}:${issue.path}:${issue.message}`}>
                          <span className="font-mono">{issue.path}</span> {issue.message}
                        </li>
                      ))}
                    </ul>
                  )}
                  {tab === 'common' &&
                    (parsed?.value ? (
                      <CommonSettingsForm
                        value={parsed.value}
                        onChange={updateObject}
                        disabled={formDisabled}
                      />
                    ) : (
                      <p className="text-muted-foreground text-xs">
                        <Trans>先修复 JSON 解析错误，常用项表单才可用。</Trans>
                      </p>
                    ))}
                  {tab === 'json' && (
                    <div className="flex flex-col gap-1">
                      <Textarea
                        aria-label="设置 JSON"
                        className="min-h-72 font-mono text-xs"
                        spellCheck={false}
                        value={draft.content}
                        disabled={!ready || scopeBlocked || busy === 'save'}
                        onChange={(event) => updateDraft(event.target.value)}
                      />
                      <p className="text-muted-foreground text-xs">
                        <Trans>
                          这是完整文件内容：保存会整体替换该文件。未知字段会原样保留；
                          宿主保存时按随包 settings schema 校验已知字段。
                        </Trans>
                      </p>
                    </div>
                  )}
                </div>
              )}

              {tab === 'resources' && (
                <div data-slot="huan-resources" className="flex flex-col gap-3 text-sm">
                  {!resources ? (
                    <p className="text-muted-foreground flex items-center gap-2 text-xs">
                      <Loader2Icon aria-hidden className="size-3 animate-spin" />
                      <Trans>正在读取资源清单…</Trans>
                    </p>
                  ) : (
                    <>
                      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                        <span>
                          {resources.loadedFrom === 'session' ? (
                            <Trans>live 会话正在使用的 loader</Trans>
                          ) : (
                            <Trans>受信装配缓存（未重新执行扩展）</Trans>
                          )}
                        </span>
                        <span>
                          {resources.projectResourcesLoaded ? (
                            <Trans>项目资源已加载</Trans>
                          ) : (
                            <Trans>项目资源未加载</Trans>
                          )}
                        </span>
                        <span className="font-mono break-all">{resources.agentDir}</span>
                      </div>
                      {resources.trustNote && (
                        <p className="text-destructive text-xs">{resources.trustNote}</p>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={
                            showText ? '隐藏指令与系统提示文本' : '显示指令与系统提示文本'
                          }
                          disabled={resourceBusy}
                          onClick={() => void fetchResources(!showText)}
                        >
                          {resourceBusy && (
                            <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
                          )}
                          {showText ? (
                            <Trans>隐藏指令/系统提示文本</Trans>
                          ) : (
                            <Trans>显示指令/系统提示文本</Trans>
                          )}
                        </Button>
                        <span className="text-muted-foreground text-xs">
                          <Trans>文本只在显式请求时加载，且有长度上限。</Trans>
                        </span>
                      </div>

                      <ResourceList title="指令文件" empty={resources.instructions.length === 0}>
                        <ul className="flex flex-col gap-1 text-xs">
                          {resources.instructions.map((item) => (
                            <li key={item.path}>
                              <span className="font-mono break-all">{item.path}</span>{' '}
                              <span className="text-muted-foreground">
                                {item.bytes} B{item.textTruncated ? '（已截断）' : ''}
                              </span>
                              {item.text !== undefined && (
                                <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/60 p-2 whitespace-pre-wrap">
                                  {item.text}
                                </pre>
                              )}
                            </li>
                          ))}
                        </ul>
                      </ResourceList>

                      <ResourceList title="System prompt" empty={!resources.systemPrompt}>
                        {resources.systemPrompt && (
                          <div className="flex flex-col gap-1 text-xs">
                            <span className="text-muted-foreground">
                              {resources.systemPrompt.source ?? '（内置/默认）'} ·{' '}
                              {resources.systemPrompt.bytes} B
                              {resources.systemPrompt.textTruncated ? '（已截断）' : ''}
                            </span>
                            {resources.systemPrompt.text !== undefined && (
                              <pre className="max-h-40 overflow-auto rounded bg-muted/60 p-2 whitespace-pre-wrap">
                                {resources.systemPrompt.text}
                              </pre>
                            )}
                            {resources.systemPrompt.append.map((item, index) => (
                              <div key={`${item.source ?? 'append'}:${item.bytes}`}>
                                <span className="text-muted-foreground">
                                  追加片段 {item.source ?? `#${index + 1}`} · {item.bytes} B
                                </span>
                                {item.text !== undefined && (
                                  <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted/60 p-2 whitespace-pre-wrap">
                                    {item.text}
                                  </pre>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </ResourceList>

                      <ResourceList title="扩展" empty={resources.extensions.length === 0}>
                        <ul className="flex flex-col gap-1 text-xs">
                          {resources.extensions.map((item) => (
                            <li key={item.path} className="break-all">
                              <span className="font-mono">{item.path}</span>
                              {item.hidden && '（隐藏）'}
                              <span className="text-muted-foreground">
                                {' '}
                                — {sourceLabel(item.sourceInfo)}；命令 {item.commands.length}，工具{' '}
                                {item.tools.length}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </ResourceList>

                      <ResourceList title="Skills" empty={resources.skills.length === 0}>
                        <ul className="flex flex-col gap-1 text-xs">
                          {resources.skills.map((item) => (
                            <li key={`${item.sourceInfo.path}:${item.name}`}>
                              <span className="font-medium">{item.name}</span>
                              <span className="text-muted-foreground">
                                {' '}
                                — {item.description}；{sourceLabel(item.sourceInfo)}
                                {item.disableModelInvocation ? '；仅 /skill 显式调用' : ''}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </ResourceList>

                      <ResourceList title="模板命令" empty={resources.prompts.length === 0}>
                        <ul className="flex flex-col gap-1 text-xs">
                          {resources.prompts.map((item) => (
                            <li key={`${item.sourceInfo.path}:${item.name}`}>
                              <span className="font-medium">/{item.name}</span>
                              <span className="text-muted-foreground">
                                {' '}
                                — {item.description}；{sourceLabel(item.sourceInfo)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </ResourceList>

                      <ResourceList title="终端主题" empty={resources.themes.length === 0}>
                        <ul className="flex flex-col gap-1 text-xs">
                          {resources.themes.map((item) => (
                            <li key={`${item.path ?? item.name}`}>
                              <span className="font-medium">{item.name}</span>
                              {item.sourceInfo && (
                                <span className="text-muted-foreground">
                                  {' '}
                                  — {sourceLabel(item.sourceInfo)}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </ResourceList>

                      <ResourceList title="声明 packages" empty={resources.packages.length === 0}>
                        <ul className="flex flex-col gap-1 text-xs">
                          {resources.packages.map((item) => (
                            <li key={item.source} className="font-mono break-all">
                              {item.source}
                              {item.autoload === false ? '（autoload=false）' : ''}
                            </li>
                          ))}
                        </ul>
                      </ResourceList>

                      <ResourceList title="实际加载来源" empty={resources.loaded.length === 0}>
                        <ul className="flex flex-col gap-1 text-xs">
                          {resources.loaded.map((item) => (
                            <li
                              key={`${item.kind}:${item.path}:${item.name}`}
                              className="break-all"
                            >
                              <span className="text-muted-foreground">[{item.kind}]</span>{' '}
                              {item.name} — {item.source} · {item.scope}
                            </li>
                          ))}
                        </ul>
                      </ResourceList>

                      {resources.diagnostics.length > 0 && (
                        <ResourceList title="资源诊断" empty={false}>
                          <ul className="text-destructive list-disc ps-4 text-xs">
                            {resources.diagnostics.map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                        </ResourceList>
                      )}
                    </>
                  )}
                </div>
              )}

              {snapshot && (
                <details data-slot="huan-settings-effective" className="text-xs">
                  <summary className="cursor-pointer">
                    <Trans>磁盘合并预览（未应用到当前会话）</Trans>
                  </summary>
                  <div className="text-muted-foreground mt-1 flex flex-col gap-1">
                    <span>
                      <Trans>来源按顶层键：</Trans>
                      {Object.entries(snapshot.effective.origins)
                        .slice(0, 40)
                        .map(([name, origin]) => `${name}=${origin}`)
                        .join('、')}
                    </span>
                    <pre className="max-h-48 overflow-auto rounded bg-muted/60 p-2 whitespace-pre-wrap">
                      {JSON.stringify(snapshot.effective.values, null, 2).slice(0, 20_000)}
                    </pre>
                    {snapshot.live && (
                      <span>
                        <Trans>当前会话已加载值来自会话装配；磁盘变化需重载才会被使用。</Trans>
                        {snapshot.reloadRequired ? '（检测到磁盘值与会话值不同）' : ''}
                      </span>
                    )}
                  </div>
                </details>
              )}
            </div>
          )}

          <DialogFooter>
            {tab !== 'resources' && (
              <Button
                variant="outline"
                aria-label="重置改动"
                disabled={!dirty || busy === 'save'}
                onClick={resetDraft}
              >
                <Trans>重置改动</Trans>
              </Button>
            )}
            {tab !== 'resources' && (
              <Button
                aria-label="保存设置"
                disabled={
                  !ready ||
                  !draft ||
                  !dirty ||
                  busy !== undefined ||
                  scopeBlocked ||
                  !!file?.readError ||
                  !!file?.tooLarge
                }
                onClick={() => void save()}
              >
                {busy === 'save' ? (
                  <Loader2Icon aria-hidden className="size-4 animate-spin" />
                ) : null}
                <Trans>保存设置</Trans>
              </Button>
            )}
            <Button variant="ghost" onClick={() => setOpen(false)}>
              <Trans>关闭</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
