/**
 * 上游内部工具的本地副本（anti-corruption layer）。
 *
 * 出处：`@assistant-ui/core@0.3.27` 的内部子路径模块
 * （`utils/json/is-json`、`utils/invoke-user-callback`、`utils/data-url`、
 * `utils/image-media-type`、`utils/wire-media`、`utils/run-lease`）。
 * 许可：MIT（@assistant-ui/core）。
 *
 * 为什么复制而不是导入：这些工具只经 `@assistant-ui/core/internal` 暴露，
 * 该子路径是上游明示的内部 API，可能在不递增主版本的情况下增删导出。
 * 实证：`RunLeases` 在 0.3.21 中完全不存在，0.3.27 才加入——一个补丁级
 * 版本漂移即可让导入崩溃。本包在 `node_modules` 布局变化时不随之破裂。
 *
 * 改动：仅调整格式以符合本项目风格；逻辑与上游保持逐行等价，便于后续
 * 与上游 diff 对照。`useLatestRef` / `useReplaySafeEffect` 因涉及 React
 * shim，单独放在 hooks.ts。
 */

/** 对象且非 null 且非数组。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 调用用户回调并吞掉其抛错（只记录到 console），返回 Promise 时同样兜底。
 *
 * 用户回调（`onError` 等）由外部代码提供，其抛错不应中断运行时流程。
 */
export function invokeUserCallback<TArgs extends readonly unknown[]>(
  tag: string,
  name: string,
  callback: ((...args: TArgs) => unknown) | undefined,
  ...args: TArgs
): void | Promise<void> {
  if (!callback) return
  const reportError = (error: unknown) => {
    try {
      console.error(`[${tag}] ${name} callback threw an error`, error)
    } catch {
      // console 本身不可用时静默
    }
  }
  try {
    const result = callback(...args)
    if (
      result !== null &&
      (typeof result === 'object' || typeof result === 'function') &&
      'then' in result &&
      typeof result.then === 'function'
    ) {
      return Promise.resolve(result).then(
        () => void 0,
        (error) => reportError(error),
      )
    }
  } catch (error) {
    reportError(error)
  }
}

/** `http(s)://` 前缀判定。 */
export const httpUrlPattern = /^https?:\/\//i

const DEFAULT_DATA_URL_MEDIA_TYPE = 'text/plain'
const DEFAULT_BINARY_DATA_URL_MEDIA_TYPE = 'application/octet-stream'

/**
 * 提取 base64 载荷与不带参数的 media type。
 *
 * 省略类型时用 `fallbackMimeType`（默认 `application/octet-stream`，
 * 因为本函数只接受 base64 载荷）。非 data URL 返回 null。
 */
export function parseDataUrl(
  value: string,
  fallbackMimeType: string = DEFAULT_BINARY_DATA_URL_MEDIA_TYPE,
): { mimeType: string; data: string } | null {
  const match = value.match(/^data:([^;,]*)(?:;[^;,]+)*;base64,(.*)$/i)
  if (!match) return null
  // 正则的两个捕获组必然存在；默认值只为满足 noUncheckedIndexedAccess
  const [, rawMimeType = '', data = ''] = match
  return {
    mimeType: rawMimeType ? rawMimeType.toLowerCase() : fallbackMimeType,
    data,
  }
}

/**
 * `new URL()` 能否接受该载荷。
 *
 * 把 `FileMessagePart` 载荷放进 url 类型字段的适配器用它判断是否需要先包
 * 一层 data URL；base64 不含冒号，因此真实载荷不会被误判为 url。
 */
export function isParsableUrl(value: string): boolean {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

/**
 * data URL 的 media type（不含参数）。
 *
 * base64 载荷省略类型时用 `application/octet-stream`，其他载荷省略时用
 * `text/plain`。与 `parseDataUrl` 不同，本函数也接受非 base64 的 data URL。
 * 无 data URL 头时返回 undefined。
 */
export function dataUrlMediaType(value: string): string | undefined {
  if (value.slice(0, 5).toLowerCase() !== 'data:') return undefined
  const commaIndex = value.indexOf(',', 5)
  if (commaIndex === -1) return undefined
  const header = value.slice(5, commaIndex)
  const parameterIndex = header.indexOf(';')
  const mediaType = parameterIndex === -1 ? header : header.slice(0, parameterIndex)
  if (mediaType) return mediaType.toLowerCase()
  return header.toLowerCase().endsWith(';base64')
    ? DEFAULT_BINARY_DATA_URL_MEDIA_TYPE
    : DEFAULT_DATA_URL_MEDIA_TYPE
}

/**
 * 浏览器或附件适配器现实会产出的图片格式的前导字节签名。
 *
 * `null` 表示匹配任意字节：WebP 需要它，因为四个尺寸字节夹在两个标记之间；
 * AVIF / HEIC 也需要，因为前导 `ftyp` box 尺寸随编码器变化。这些是文件格式
 * 常量而非演进中的 API，因此表内容镜像 AI SDK 在多个适配器另一侧使用的表，
 * 而不为此引入依赖。
 */
const IMAGE_SIGNATURES: readonly {
  mediaType: string
  prefix: readonly (number | null)[]
}[] = [
  { mediaType: 'image/gif', prefix: [71, 73, 70] },
  { mediaType: 'image/png', prefix: [137, 80, 78, 71] },
  { mediaType: 'image/jpeg', prefix: [255, 216] },
  { mediaType: 'image/webp', prefix: [82, 73, 70, 70, null, null, null, null, 87, 69, 66, 80] },
  { mediaType: 'image/bmp', prefix: [66, 77] },
  { mediaType: 'image/tiff', prefix: [73, 73, 42, 0] },
  { mediaType: 'image/tiff', prefix: [77, 77, 0, 42] },
  {
    mediaType: 'image/avif',
    prefix: [null, null, null, null, 102, 116, 121, 112, 97, 118, 105, 102],
  },
  {
    mediaType: 'image/heic',
    prefix: [null, null, null, null, 102, 116, 121, 112, 104, 101, 105, 99],
  },
]

/** 16 个 base64 字符解码为最长签名所需的 12 字节。 */
const PREFIX_CHARS = 16

const decodePrefix = (base64: string): Uint8Array | undefined => {
  const prefix = base64.slice(0, PREFIX_CHARS)
  const aligned = prefix.slice(0, prefix.length - (prefix.length % 4))
  if (aligned.length === 0) return undefined
  const nodeBuffer = (globalThis as { Buffer?: typeof globalThis.Buffer }).Buffer as
    | { from(input: string, encoding: string): Uint8Array }
    | undefined
  if (nodeBuffer) return new Uint8Array(nodeBuffer.from(aligned, 'base64'))
  try {
    const binary = atob(aligned)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return undefined
  }
}

/**
 * base64 载荷前导字节所标识的图片 media type；无匹配签名或输入不是 base64
 * 时返回 undefined。不抛错（输入是调用方放的任意值）。
 */
export function detectImageMediaType(base64: string): string | undefined {
  const bytes = decodePrefix(base64)
  if (!bytes) return undefined
  return IMAGE_SIGNATURES.find(
    ({ prefix }) =>
      bytes.length >= prefix.length &&
      prefix.every((byte, index) => byte === null || bytes[index] === byte),
  )?.mediaType
}

/**
 * `ImageMessagePart` 应声明的 media type（该类消息自身不带）：
 * 附件 contentType → 载荷 data URL 声明 → 载荷前导字节 → `image/png`。
 *
 * 兜底不能是通配符：AI SDK 对 url source 直接拒绝 `image/*`，
 * 字节嗅探失败时同理，恰好在需要兜底处失效。
 */
export function resolveImageMediaType(image: string, contentType?: string): string {
  if (contentType?.startsWith('image/') && !contentType.includes('*')) return contentType
  const declared = dataUrlMediaType(image)
  if (declared?.startsWith('image/') && !declared.includes('*')) return declared
  const payload = parseDataUrl(image)?.data ?? (isParsableUrl(image) ? undefined : image)
  if (payload !== undefined) {
    const sniffed = detectImageMediaType(payload)
    if (sniffed) return sniffed
  }
  return 'image/png'
}

/**
 * 把字节数组编码为 base64。
 *
 * Node 环境走 Buffer（快路径）；浏览器分块走 btoa，避免超大附件触发
 * `String.fromCharCode` 的参数数量上限。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const nodeBuffer = (globalThis as { Buffer?: typeof globalThis.Buffer }).Buffer as
    | { from(input: Uint8Array): { toString(encoding: string): string } }
    | undefined
  if (nodeBuffer) return nodeBuffer.from(bytes).toString('base64')
  let binary = ''
  const chunkSize = 32768
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

/** 一次运行的租约；`isCurrent()` 在下一代运行开始前保持 true。 */
export type RunLease = {
  isCurrent(): boolean
}

/**
 * 迟到异步工作的代号栅栏（generation fence）。
 *
 * `begin()` 推进代号并为新运行返回租约；`current()` 按现状捕获代号；
 * `invalidate()` 只推进代号，不启动运行。租约在下一次 `begin()` 或
 * `invalidate()` 之前保持 current。
 */
export class RunLeases {
  private generation = 0

  begin(): RunLease {
    this.generation++
    return this.current()
  }

  current(): RunLease {
    const generation = this.generation
    return { isCurrent: () => generation === this.generation }
  }

  invalidate(): void {
    this.generation++
  }
}
