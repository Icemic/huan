/**
 * 最小标准 SSE 帧解析器（替代 assistant-stream 的 SSEEventDecoder）。
 *
 * 只处理传输所需：增量帧、CR/LF/CRLF、多 data 行、event/id、注释心跳；
 * 保留有界行/事件限制与终止性错误语义，不引入第三方依赖。
 */

export interface SseDecodedFrame {
  data: string
  event?: string
  id?: string
}

export class SSEEventDecoderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SSEEventDecoderError'
  }
}

const DEFAULT_MAX = 16 * 1024 * 1024

const assertLimit = (value: number | undefined, label: string): number => {
  if (value === undefined) return DEFAULT_MAX
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SSEEventDecoderError(`${label} must be a positive safe integer`)
  }
  return value
}

export class SSEEventDecoder {
  private readonly maxLineLength: number
  private readonly maxEventLength: number
  private buffer = ''
  private dataLines: string[] = []
  private eventLength = 0
  private eventName: string | undefined
  private eventId: string | undefined
  private pendingCR = false

  constructor(options?: {
    maxLineLength?: number | undefined
    maxEventLength?: number | undefined
  }) {
    this.maxLineLength = assertLimit(options?.maxLineLength, 'maxLineLength')
    this.maxEventLength = assertLimit(options?.maxEventLength, 'maxEventLength')
  }

  push(chunk: string): SseDecodedFrame[] {
    if (chunk.length === 0) return []
    if (this.pendingCR) {
      if (chunk.startsWith('\n')) chunk = chunk.slice(1)
      this.pendingCR = false
      if (chunk.length === 0) return []
    }
    this.buffer += chunk
    const frames: SseDecodedFrame[] = []
    let lineStart = 0
    let index = 0
    while (index < this.buffer.length) {
      const char = this.buffer[index]
      if (char === '\n') {
        this.consumeLine(this.buffer.slice(lineStart, index), frames)
        index += 1
        lineStart = index
        continue
      }
      if (char === '\r') {
        this.consumeLine(this.buffer.slice(lineStart, index), frames)
        if (index + 1 < this.buffer.length && this.buffer[index + 1] === '\n') {
          index += 2
        } else {
          index += 1
          // 末尾 CR 已作为行结束处理；下一块若以 LF 开头则属于同一 CRLF。
          if (index >= this.buffer.length) this.pendingCR = true
        }
        lineStart = index
        continue
      }
      index += 1
      if (index - lineStart > this.maxLineLength) {
        throw new SSEEventDecoderError(`SSE line exceeds maxLineLength (${this.maxLineLength})`)
      }
    }
    this.buffer = this.buffer.slice(lineStart)
    if (this.buffer.length > this.maxLineLength) {
      throw new SSEEventDecoderError(`SSE line exceeds maxLineLength (${this.maxLineLength})`)
    }
    return frames
  }

  private consumeLine(line: string, frames: SseDecodedFrame[]): void {
    if (line.length > this.maxLineLength) {
      throw new SSEEventDecoderError(`SSE line exceeds maxLineLength (${this.maxLineLength})`)
    }
    if (line.length === 0) {
      this.dispatch(frames)
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') {
      this.dataLines.push(value)
      this.eventLength += value.length + 1
      if (this.eventLength > this.maxEventLength) {
        throw new SSEEventDecoderError(`SSE event exceeds maxEventLength (${this.maxEventLength})`)
      }
      return
    }
    if (field === 'event') this.eventName = value
    else if (field === 'id') this.eventId = value
  }

  private dispatch(frames: SseDecodedFrame[]): void {
    if (this.dataLines.length === 0 && this.eventName === undefined && this.eventId === undefined) {
      return
    }
    frames.push({
      data: this.dataLines.join('\n'),
      ...(this.eventName === undefined ? {} : { event: this.eventName }),
      ...(this.eventId === undefined ? {} : { id: this.eventId }),
    })
    this.dataLines = []
    this.eventLength = 0
    this.eventName = undefined
    this.eventId = undefined
  }
}
