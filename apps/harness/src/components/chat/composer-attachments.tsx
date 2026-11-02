/**
 * 输入区附件：Blob 预览、状态、移除与原图预览。
 *
 * 预览 URL 由 useBlobUrl 按 Blob 生命周期分配/释放；附件状态与草稿引用仍在
 * windowStore，组件不复制文件数组。
 */

import type { HarnessAttachment } from '@huan/react'
import { useWindowStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { FileImageIcon, Loader2Icon, XIcon } from 'lucide-react'
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from '@/components/ui/attachment'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useBlobUrl } from './use-blob-url'

const EMPTY_IDS: readonly string[] = []

const stateOf = (attachment: HarnessAttachment) =>
  attachment.status === 'failed'
    ? 'error'
    : attachment.status === 'preparing'
      ? 'uploading'
      : 'done'

function AttachmentItem({
  attachment,
  onRemove,
}: {
  attachment: HarnessAttachment
  onRemove: () => void
}) {
  const url = useBlobUrl(attachment.blob)
  const isImage = attachment.mimeType.startsWith('image/')
  const state = stateOf(attachment)
  const description =
    state === 'error'
      ? (attachment.error ?? '图片不可用')
      : state === 'uploading'
        ? '准备中'
        : isImage
          ? '图片'
          : attachment.mimeType

  return (
    <Attachment
      size="xs"
      orientation="horizontal"
      state={state}
      data-slot="huan-composer-attachment"
      className="min-w-0 max-w-64"
    >
      <AttachmentMedia variant={isImage && url ? 'image' : 'icon'}>
        {isImage && url ? (
          <img src={url} alt={attachment.fileName} />
        ) : state === 'uploading' ? (
          <Loader2Icon className="animate-spin" />
        ) : (
          <FileImageIcon />
        )}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle title={attachment.fileName}>{attachment.fileName}</AttachmentTitle>
        <AttachmentDescription>{description}</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction
          type="button"
          aria-label={`移除附件 ${attachment.fileName}`}
          onClick={(event) => {
            event.stopPropagation()
            onRemove()
          }}
        >
          <XIcon aria-hidden />
        </AttachmentAction>
      </AttachmentActions>
      {isImage && url ? (
        <Dialog>
          <DialogTrigger
            render={
              <AttachmentTrigger
                aria-label={`预览附件 ${attachment.fileName}`}
                onClick={(event) => event.stopPropagation()}
              />
            }
          />
          <DialogContent className="max-w-[min(96vw,72rem)] p-2">
            <DialogTitle className="sr-only">
              <Trans>附件预览</Trans>
            </DialogTitle>
            <div className="flex max-h-[86dvh] w-full items-center justify-center overflow-auto">
              <img
                src={url}
                alt={attachment.fileName}
                className="max-h-[84dvh] max-w-full object-contain"
              />
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </Attachment>
  )
}

/** 输入区附件行；没有附件时不占位。 */
export function ComposerAttachments({ draftId }: { draftId: string | undefined }) {
  const attachmentIds = useWindowStore((state) =>
    draftId ? (state.draftsById[draftId]?.attachmentIds ?? EMPTY_IDS) : EMPTY_IDS,
  )
  const attachmentsById = useWindowStore((state) => state.attachmentsById)
  const removeAttachment = useWindowStore((state) => state.removeAttachment)
  if (!draftId || attachmentIds.length === 0) return null
  return (
    <AttachmentGroup data-slot="huan-composer-attachments" className="w-full py-0">
      {attachmentIds.map((id) => {
        const attachment = attachmentsById[id]
        if (!attachment) return null
        return (
          <AttachmentItem
            key={id}
            attachment={attachment}
            onRemove={() => removeAttachment(draftId, id)}
          />
        )
      })}
    </AttachmentGroup>
  )
}
