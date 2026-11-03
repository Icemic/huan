/**
 * 消息/工具图片：内容按原始 data URL 或 URL 渲染，可打开原图预览。
 *
 * 预览使用官方 Dialog；图片尺寸完全由容器约束，迟到加载只改变高度，
 * 由聊天滚动容器保持阅读位置。加载失败时显示中文可访问回退并保留原
 * 替代文本与来源，不提供只含空图片框的预览入口。
 */

import { useState } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

type ImageLoadState = {
  src: string
  status: 'loading' | 'loaded' | 'error'
}

/** 来源可能是一整段 data URL：界面只展示可读前缀，完整值留在 title 中。 */
const sourceLabelOf = (src: string): string => (src.length > 160 ? `${src.slice(0, 157)}…` : src)

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
  // 加载/失败状态必须与 src 绑定：换图时旧状态不能残留到新图。
  const [loadState, setLoadState] = useState<ImageLoadState>(() => ({ src, status: 'loading' }))
  if (loadState.src !== src) setLoadState({ src, status: 'loading' })
  const status = loadState.src === src ? loadState.status : 'loading'
  const loaded = status === 'loaded'

  // 失败时不渲染预览触发器：避免打开只含空图片框的 Dialog。
  if (status === 'error') {
    return (
      <div
        data-slot="huan-image-error"
        role="alert"
        className={cn(
          'border-destructive/40 bg-destructive/5 max-w-full rounded-md border px-3 py-2 text-xs',
          className,
        )}
      >
        <p className="text-destructive font-medium">图片加载失败</p>
        <p className="text-muted-foreground mt-1 break-all">原替代文本：{alt}</p>
        <p className="text-muted-foreground break-all" title={src}>
          来源：{sourceLabelOf(src)}
        </p>
      </div>
    )
  }

  const image = (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onLoad={() => setLoadState({ src, status: 'loaded' })}
      onError={() => setLoadState({ src, status: 'error' })}
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
          <img
            src={src}
            alt={alt}
            onError={() => setLoadState({ src, status: 'error' })}
            className="max-h-[84dvh] max-w-full object-contain"
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
