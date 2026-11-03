/**
 * 设置诊断展示：合并后的文件配置预览。
 *
 * 只读取 settings snapshot 的已知字段；项目未信任等不可读情况不在这里补造内容。
 */

import type { HarnessSettingsSnapshot } from '@huan/protocol'
import { Trans } from '@lingui/react/macro'
import { FieldDescription } from '@/components/ui/field'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'

/** 折叠展示文件配置预览与顶层来源；按需展开，不自动请求正文。 */
export function SettingsEffectivePreview({ snapshot }: { snapshot: HarnessSettingsSnapshot }) {
  return (
    <details data-slot="huan-settings-effective">
      <summary className="cursor-pointer">
        <Trans>文件配置预览</Trans>
      </summary>
      <div className="flex flex-col gap-2 pt-2">
        <FieldDescription>
          <Trans>来源按顶层键：</Trans>
          {Object.entries(snapshot.effective.origins)
            .slice(0, 40)
            .map(([name, origin]) => `${name}=${origin}`)
            .join('、')}
        </FieldDescription>
        <ScrollArea className="bg-muted/50 rounded-md *:data-[slot=scroll-area-viewport]:max-h-48">
          <div className="p-2">
            <pre className="min-w-0 font-mono whitespace-pre-wrap">
              {JSON.stringify(snapshot.effective.values, null, 2).slice(0, 20_000)}
            </pre>
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
        {snapshot.live && snapshot.reloadRequired && (
          <FieldDescription>
            <Trans>与当前会话使用的设置不同</Trans>
          </FieldDescription>
        )}
      </div>
    </details>
  )
}
