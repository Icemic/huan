import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import { MonitorIcon, MoonIcon, PaletteIcon, SunDimIcon, SunIcon } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { type AppTheme, getTheme, setTheme, subscribeTheme } from '@/lib/theme'

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

/** 顶栏主题选择：只影响当前浏览器的本地显示。 */
export function ThemeSelector() {
  const { i18n } = useLingui()
  const themeLabel = i18n._(msg`主题`)
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme)
  const current = THEME_OPTIONS.find((option) => option.value === theme) ?? THEME_OPTIONS[0]
  const CurrentIcon = current.icon

  return (
    <Select
      value={theme}
      onValueChange={(value) => {
        if (value) setTheme(value)
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={themeLabel}
        data-slot="theme-selector-trigger"
        className="text-muted-foreground hover:text-foreground gap-1.5 px-2"
      >
        <CurrentIcon aria-hidden className="size-3.5" />
        <span className="text-xs">{i18n._(current.label)}</span>
      </SelectTrigger>
      <SelectContent className="min-w-40">
        {THEME_OPTIONS.map((option) => {
          const Icon = option.icon
          return (
            <SelectItem key={option.value} value={option.value}>
              <Icon aria-hidden className="size-3.5" />
              <span>{i18n._(option.label)}</span>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}
