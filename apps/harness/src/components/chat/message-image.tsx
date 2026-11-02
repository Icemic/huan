/**
 * 消息/工具图片：内容按原始 data URL 或 URL 渲染，可打开原图预览。
 *
 * 预览使用官方 Dialog；图片尺寸完全由容器约束，迟到加载只改变高度，
 * 由聊天滚动容器保持阅读位置。
 */

import { useState } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

export function MessageImage({
  src,
  alt,
  className,
  preview = true,
}: {
  src: string
  alt: string
  className?: string
  preview?: boolean
}) {
  const [loaded, setLoaded] = useState(false)
  const image = (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onLoad={() => setLoaded(true)}
      className={cn(
        'max-h-64 max-w-full rounded-md border object-contain transition-opacity duration-200',
        loaded ? 'opacity-100' : 'opacity-70',
        className,
      )}
    />
  )
  if (!preview) return image
  return (
    <Dialog>
      <DialogTrigger
        type="button"
        aria-label={`预览图片：${alt}`}
        className="group/image relative w-fit max-w-full cursor-zoom-in rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {image}
      </DialogTrigger>
      <DialogContent className="max-w-[min(96vw,72rem)] p-2" showCloseButton>
        <DialogTitle className="sr-only">图片预览</DialogTitle>
        <div className="flex max-h-[86dvh] w-full items-center justify-center overflow-auto">
          <img src={src} alt={alt} className="max-h-[84dvh] max-w-full object-contain" />
        </div>
      </DialogContent>
    </Dialog>
  )
}
