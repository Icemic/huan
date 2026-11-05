/**
 * read / write / edit / bash 的专门展开内容。
 *
 * 标题由工具行统一生成；这里按固定顺序输出参数内容、执行结果、图片、
 * 子调用摘要与其他未知字段。主要字段不可读时调用方仍使用通用工具展示；
 * 可选元数据不可用只影响自身展示，原始值保留在其他参数。
 */

import type { HarnessToolViewPart } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { Fragment } from 'react'
import { useChatStore } from '@/state/app-context'
import { partOpenOf } from '@/state/chat-store'
import { languageOfPath } from './code-syntax'
import {
  BlockScroll,
  CodeText,
  CommandBlock,
  ContentBlockFrame,
  CopyIconButton,
  JsonDetails,
  OutputBlock,
  ShellOutputInfo,
} from './content-block'
import { HighlightedCodeContent } from './highlighted-code'
import { NestedCallsSummary, ToolImages } from './tool-attachments'
import {
  type BashDetails,
  type BashToolInput,
  bashDetailsOf,
  bashToolInputOf,
  commandSummaryOf,
  type EditDetails,
  type EditToolInput,
  editDetailsOf,
  editToolInputOf,
  lineCountOf,
  otherArgumentsOf,
  type ReadDetails,
  type ReadToolInput,
  readDetailsOf,
  readRangeDetailOf,
  readRangeSummaryOf,
  readToolInputOf,
  type WriteToolInput,
  writeToolInputOf,
} from './tool-presentation'

export type SpecializedToolView =
  | { kind: 'read'; input: ReadToolInput; details: ReadDetails }
  | { kind: 'write'; input: WriteToolInput }
  | { kind: 'edit'; input: EditToolInput; details: EditDetails }
  | { kind: 'bash'; input: BashToolInput; details: BashDetails }

/** 解析只需要调用名、参数、详情与状态，避免输出增量触发无谓重算。 */
export type SpecializedToolSource = Pick<
  HarnessToolViewPart,
  'toolName' | 'arguments' | 'details' | 'status'
>

/** 解析内置工具；不是这四种工具或参数形状不符时返回 undefined。 */
export const specializedToolViewOf = (
  part: SpecializedToolSource,
): SpecializedToolView | undefined => {
  switch (part.toolName) {
    case 'read': {
      const input = readToolInputOf(part.arguments)
      return input ? { kind: 'read', input, details: readDetailsOf(part.details) } : undefined
    }
    case 'write': {
      const input = writeToolInputOf(part.arguments)
      return input ? { kind: 'write', input } : undefined
    }
    case 'edit': {
      const input = editToolInputOf(part.arguments)
      const showDiff = part.status === 'complete'
      return input
        ? { kind: 'edit', input, details: editDetailsOf(part.details, { showDiff }) }
        : undefined
    }
    case 'bash': {
      const input = bashToolInputOf(part.arguments)
      return input ? { kind: 'bash', input, details: bashDetailsOf(part.details) } : undefined
    }
    default:
      return undefined
  }
}

/** 标题中的对象与元数据；动作和状态由工具行按状态生成。 */
export const specializedToolTitleOf = (
  view: SpecializedToolView,
): { object: string; meta?: string } => {
  switch (view.kind) {
    case 'read': {
      const meta = readRangeSummaryOf(view.input)
      return { object: view.input.path, ...(meta === undefined ? {} : { meta }) }
    }
    case 'write':
      return { object: view.input.path, meta: `${lineCountOf(view.input.content)} 行` }
    case 'edit':
      return { object: view.input.path, meta: `${view.input.segments.length} 处` }
    case 'bash':
      return { object: commandSummaryOf(view.input.command) }
  }
}

/** 只看展开时需要渲染图片或嵌套等附加内容；不解析大段文本。 */
export const specializedHasAttachments = (part: HarnessToolViewPart): boolean =>
  (part.outputImages?.length ?? 0) > 0 || (part.nestedCalls?.calls.length ?? 0) > 0

function OtherFields({
  part,
  kind,
  otherDetails,
}: {
  part: HarnessToolViewPart
  kind: SpecializedToolView['kind']
  otherDetails: unknown
}) {
  const otherArguments = otherArgumentsOf(part.arguments, kind)
  return (
    <>
      {otherArguments === undefined ? null : (
        <JsonDetails label={<Trans>其他参数</Trans>} value={otherArguments} />
      )}
      {otherDetails === undefined ? null : (
        <JsonDetails label={<Trans>其他详情</Trans>} value={otherDetails} />
      )}
    </>
  )
}

function ReadToolBody({
  part,
  view,
}: {
  part: HarnessToolViewPart
  view: Extract<SpecializedToolView, { kind: 'read' }>
}) {
  const { input, details } = view
  const range = readRangeDetailOf(input)
  const output = part.output
  const error = part.status === 'error'
  const hasImages = (part.outputImages?.length ?? 0) > 0
  const language = languageOfPath(input.path)
  const pathLine = (
    <div className="text-muted-foreground flex min-w-0 items-start gap-2 text-xs leading-[18px]">
      <span className="min-w-0 flex-1 break-all font-mono">
        {input.path}
        {range ? ` · ${range}` : ''}
      </span>
      <CopyIconButton value={input.path} label="复制路径" />
    </div>
  )

  return (
    <>
      {error ? (
        <>
          {pathLine}
          <p className="text-destructive min-w-0 text-sm leading-[22px] whitespace-pre-wrap break-words">
            {output && output.length > 0 ? output : <Trans>无输出</Trans>}
          </p>
        </>
      ) : output !== undefined ? (
        <ContentBlockFrame
          title={input.path}
          titleClassName="whitespace-normal! break-all font-mono"
          dataSlot="huan-read-content"
          actions={
            <>
              <CopyIconButton value={input.path} label="复制路径" />
              <CopyIconButton value={output} label="复制读取内容" />
            </>
          }
        >
          {range ? (
            <p className="text-muted-foreground px-2 pb-1.5 text-xs leading-[18px]">{range}</p>
          ) : null}
          <BlockScroll>
            <CodeText
              value={output}
              language={language}
              emptyText={<Trans>空内容</Trans>}
              className={range ? 'pt-1' : undefined}
            />
          </BlockScroll>
        </ContentBlockFrame>
      ) : hasImages ? (
        pathLine
      ) : part.status === 'running' ? null : (
        <>
          {pathLine}
          <p className="text-muted-foreground text-sm">
            <Trans>无输出</Trans>
          </p>
        </>
      )}
      {details.truncation ? (
        <p className="text-muted-foreground text-xs leading-[18px]">{details.truncation}</p>
      ) : null}
      <ToolImages part={part} />
      <NestedCallsSummary part={part} />
      <OtherFields part={part} kind="read" otherDetails={details.other} />
    </>
  )
}

function WriteToolBody({
  part,
  view,
}: {
  part: HarnessToolViewPart
  view: Extract<SpecializedToolView, { kind: 'write' }>
}) {
  const { input } = view
  const output = part.output
  const error = part.status === 'error'
  const language = languageOfPath(input.path)
  return (
    <>
      {error && output && output.length > 0 ? (
        <p className="text-destructive min-w-0 text-sm leading-[22px] whitespace-pre-wrap break-words">
          {output}
        </p>
      ) : null}
      <ContentBlockFrame
        title={input.path}
        titleClassName="whitespace-normal! break-all font-mono"
        dataSlot="huan-write-content"
        meta={`${lineCountOf(input.content)} 行`}
        actions={
          <>
            <CopyIconButton value={input.path} label="复制路径" />
            <CopyIconButton value={input.content} label="复制写入内容" />
          </>
        }
      >
        <BlockScroll>
          <CodeText
            value={input.content}
            language={language}
            lineNumbers
            emptyText={<Trans>空内容 · 0 行</Trans>}
          />
        </BlockScroll>
      </ContentBlockFrame>
      {!error && output && output.length > 0 ? (
        <div className="text-muted-foreground max-h-[108px] overflow-auto text-xs leading-[18px] break-words whitespace-pre-wrap">
          {output}
        </div>
      ) : null}
      <ToolImages part={part} />
      <NestedCallsSummary part={part} />
      <OtherFields part={part} kind="write" otherDetails={part.details} />
    </>
  )
}

function EditSegments({
  input,
  running,
  defaultOpen,
  storeKey,
}: {
  input: EditToolInput
  running: boolean
  defaultOpen: boolean
  storeKey: string
}) {
  const expanded = useChatStore((state) => partOpenOf(state, storeKey, defaultOpen))
  const setOpen = useChatStore((state) => state.setPartOpen)
  const language = languageOfPath(input.path)
  return (
    <>
      {running ? (
        <p className="text-muted-foreground text-xs leading-[18px]">
          <Trans>待应用</Trans>
        </p>
      ) : null}
      <details className="text-xs" open={expanded}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: summary 是原生交互元素，只记录显式选择 */}
        <summary
          className="text-muted-foreground cursor-pointer"
          onClick={(event) => {
            const details = event.currentTarget.parentElement
            // 只把用户点击记为显式选择；默认值变化（运行中→成功）不能偷偷覆盖。
            if (details instanceof HTMLDetailsElement) {
              event.preventDefault()
              setOpen(storeKey, !details.open)
            }
          }}
        >
          <Trans>替换内容 · {input.segments.length} 处</Trans>
        </summary>
        {expanded ? (
          <div className="mt-2 flex min-w-0 flex-col gap-2">
            {input.segments.map((segment, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 替换段没有独立 ID，顺序来自执行请求
              <Fragment key={`${index}:${segment.oldText.length}`}>
                <ContentBlockFrame
                  title={<Trans>替换前 · {index + 1}</Trans>}
                  dataSlot="huan-edit-before"
                  actions={<CopyIconButton value={segment.oldText} label="复制替换前内容" />}
                >
                  <BlockScroll>
                    <CodeText
                      value={segment.oldText}
                      language={language}
                      emptyText={<Trans>空内容</Trans>}
                    />
                  </BlockScroll>
                </ContentBlockFrame>
                <ContentBlockFrame
                  title={<Trans>替换后 · {index + 1}</Trans>}
                  dataSlot="huan-edit-after"
                  actions={<CopyIconButton value={segment.newText} label="复制替换后内容" />}
                >
                  <BlockScroll>
                    <CodeText
                      value={segment.newText}
                      language={language}
                      emptyText={<Trans>空内容</Trans>}
                    />
                  </BlockScroll>
                </ContentBlockFrame>
              </Fragment>
            ))}
          </div>
        ) : null}
      </details>
    </>
  )
}

function EditToolBody({
  part,
  view,
  storeKey,
}: {
  part: HarnessToolViewPart
  view: Extract<SpecializedToolView, { kind: 'edit' }>
  storeKey: string
}) {
  const { input, details } = view
  const output = part.output
  const error = part.status === 'error'
  const running = part.status === 'running'
  const defaultSegmentsOpen = running || error || details.diff === undefined

  return (
    <>
      {error ? (
        <p className="text-destructive min-w-0 text-sm leading-[22px] whitespace-pre-wrap break-words">
          {output && output.length > 0 ? output : <Trans>无输出</Trans>}
        </p>
      ) : details.diff ? (
        <ContentBlockFrame
          title={input.path}
          titleClassName="whitespace-normal! break-all font-mono"
          meta={
            <span className="flex flex-wrap gap-x-2">
              <span>{input.segments.length} 处</span>
              {details.firstChangedLine === undefined ? null : (
                <span>首处第{details.firstChangedLine}行</span>
              )}
            </span>
          }
          dataSlot="huan-edit-diff"
          actions={
            <>
              <CopyIconButton value={input.path} label="复制路径" />
              <CopyIconButton value={details.diff} label="复制补丁" />
            </>
          }
        >
          <BlockScroll>
            <HighlightedCodeContent
              value={details.diff}
              language="diff"
              diff
              className="px-3 pt-2 pb-3 leading-[22px]"
            />
          </BlockScroll>
        </ContentBlockFrame>
      ) : null}
      {!error && output && output.length > 0 ? (
        <div className="text-muted-foreground max-h-[108px] overflow-auto text-xs leading-[18px] break-words whitespace-pre-wrap">
          {output}
        </div>
      ) : null}
      {!details.diff || error ? (
        <div className="flex min-w-0 items-start gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 break-all font-mono">{input.path}</span>
          <CopyIconButton value={input.path} label="复制路径" />
        </div>
      ) : null}
      <EditSegments
        input={input}
        running={running}
        defaultOpen={defaultSegmentsOpen}
        storeKey={`${storeKey}:segments`}
      />
      <ToolImages part={part} />
      <NestedCallsSummary part={part} />
      <OtherFields part={part} kind="edit" otherDetails={details.other} />
    </>
  )
}

function BashToolBody({
  part,
  view,
}: {
  part: HarnessToolViewPart
  view: Extract<SpecializedToolView, { kind: 'bash' }>
}) {
  const { input, details } = view
  const output = part.output
  const error = part.status === 'error'
  const running = part.status === 'running'
  // 运行中尚未收到输出时不显示空框；结束后保留“无输出”提示。
  const showOutput = running ? output !== undefined && output.length > 0 : true
  return (
    <>
      <CommandBlock command={input.command} timeout={input.timeout} />
      {showOutput ? (
        <OutputBlock
          output={output ?? ''}
          partial={running || part.isPreliminary === true}
          destructive={error}
          emptyText={<Trans>无输出</Trans>}
        />
      ) : null}
      {details.truncation ? (
        <p className="text-xs text-muted-foreground leading-[18px]">{details.truncation}</p>
      ) : null}
      {details.fullOutputPath ? <ShellOutputInfo fullOutputPath={details.fullOutputPath} /> : null}
      <ToolImages part={part} />
      <NestedCallsSummary part={part} />
      <OtherFields part={part} kind="bash" otherDetails={details.other} />
    </>
  )
}

/** 专门工具的展开内容；调用方只在展开时渲染。 */
export function SpecializedToolBody({
  part,
  view,
  storeKey,
}: {
  part: HarnessToolViewPart
  view: SpecializedToolView
  storeKey: string
}) {
  switch (view.kind) {
    case 'read':
      return <ReadToolBody part={part} view={view} />
    case 'write':
      return <WriteToolBody part={part} view={view} />
    case 'edit':
      return <EditToolBody part={part} view={view} storeKey={storeKey} />
    case 'bash':
      return <BashToolBody part={part} view={view} />
  }
}
