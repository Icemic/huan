import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import { MonitorIcon, MoonIcon, PaletteIcon, SunDimIcon, SunIcon } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import type { AppTheme } from '@/lib/theme'
import { useThemeStore } from '@/state/app-context'

const THEME_OPTIONS = [
  { value: 'system', label: msg`跟随系统`, icon: MonitorIcon },
  { value: 'light', label: msg`浅色`, icon: SunIcon },
  { value: 'dark', label: msg`深色`, icon: MoonIcon },
  { value: 'one-dark', label: msg`One Dark`, icon: PaletteIcon },
  { value: 'solarized-light', label: msg`Solarized Light`, icon: SunDimIcon },
] as const satisfies readonly {
  value: AppTheme
  label: MessageDescriptor
  icon: typeof MonitorIcon
}[]

/** 浏览器外观选择：只影响当前浏览器的本地显示，DOM 资源由 bootstrap 持有。 */
export function ThemeSelector({ id }: { id?: string }) {
  const { i18n } = useLingui()
  const theme = useThemeStore((state) => state.theme)
  const setTheme = useThemeStore((state) => state.setTheme)
  const current = THEME_OPTIONS.find((option) => option.value === theme) ?? THEME_OPTIONS[0]
  const CurrentIcon = current.icon

  return (
    <Select
      value={theme}
      onValueChange={(value) => {
        if (value) setTheme(value)
      }}
    >
      <SelectTrigger id={id} size="sm" data-slot="theme-selector-trigger">
        <CurrentIcon aria-hidden className="text-muted-foreground" />
        <span>{i18n._(current.label)}</span>
      </SelectTrigger>
      <SelectContent className="min-w-44 overflow-hidden" alignItemWithTrigger={false}>
        <ScrollArea className="*:data-[slot=scroll-area-viewport]:max-h-[min(18rem,var(--available-height))]">
          {THEME_OPTIONS.map((option) => {
            const Icon = option.icon
            return (
              <SelectItem key={option.value} value={option.value}>
                <Icon aria-hidden />
                <span>{i18n._(option.label)}</span>
              </SelectItem>
            )
          })}
        </ScrollArea>
      </SelectContent>
    </Select>
  )
}
