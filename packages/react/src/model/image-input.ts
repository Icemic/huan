/**
 * 图片附件准备：把草稿中的 Blob 转成 Pi `HarnessImageContent`。
 *
 * 纯浏览器安全算法，来源为旧 Controller 的图片加载路径（`9bcf157`）与
 * `vendor/anti-corruption` 的 data URL / media type 工具。新的附件模型只
 * 接收 Blob；URL 抓取不再由提交流程承担，避免 HTTP 层偷偷补读窗口状态。
 */

import type { HarnessImageContent } from '@huan/protocol'
import {
  bytesToBase64,
  detectImageMediaType,
  resolveImageMediaType,
} from '../vendor/anti-corruption.js'

/** 图片准备输入；只携带 Blob 与声明类型，不依赖窗口 store。 */
export interface HarnessImageSource {
  blob: Blob
  mimeType: string
}

const normalizeMimeType = (value: string): string =>
  value.split(';', 1)[0]?.trim().toLowerCase() ?? ''

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw signal.reason ?? new Error('图片准备已取消')
}

/**
 * 读取 Blob 并生成图片内容。
 *
 * 声明的非图片类型直接拒绝；通用/缺失类型按前导字节嗅探，避免把二进制
 * 误报成 `image/png`。取消只阻止后续步骤，不伪造失败内容。
 */
export const prepareImageContent = async (
  source: HarnessImageSource,
  signal?: AbortSignal,
): Promise<HarnessImageContent> => {
  throwIfAborted(signal)
  const declared = normalizeMimeType(source.mimeType)
  if (declared && !declared.startsWith('image/')) {
    throw new Error(`图片附件返回了不支持的内容类型：${declared}`)
  }

  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await source.blob.arrayBuffer())
  } catch (error) {
    throw error instanceof Error ? error : new Error('无法读取图片附件')
  }
  throwIfAborted(signal)
  if (bytes.length === 0) throw new Error('图片附件为空')

  const data = bytesToBase64(bytes)
  const detected = detectImageMediaType(data)
  if (!detected) throw new Error('图片附件内容不是可识别的图片字节')
  if (declared.startsWith('image/') && declared !== detected) {
    // 声明与字节不一致时以字节为准，避免向模型发送错误媒体类型。
    return { type: 'image', mimeType: detected, data }
  }
  return {
    type: 'image',
    mimeType: resolveImageMediaType(data, declared || detected),
    data,
  }
}
