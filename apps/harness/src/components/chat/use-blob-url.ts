/**
 * Blob 预览 URL 的分配与释放。
 *
 * URL 的生命周期必须覆盖 React 提交；分配、撤销与清除旧条目都在同一
 * effect 中完成，避免卸载后仍引用已撤销的地址。
 */

import { useEffect, useState } from 'react'

export const useBlobUrl = (blob: Blob | undefined): string | undefined => {
  const [entry, setEntry] = useState<{ blob: Blob; url: string } | undefined>(undefined)

  useEffect(() => {
    if (!blob) {
      setEntry(undefined)
      return
    }
    const url = URL.createObjectURL(blob)
    setEntry({ blob, url })
    return () => {
      URL.revokeObjectURL(url)
    }
  }, [blob])

  return entry && entry.blob === blob ? entry.url : undefined
}
