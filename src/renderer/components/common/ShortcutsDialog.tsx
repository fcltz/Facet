import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Kbd, KbdGroup } from '@renderer/components/ui/kbd'
import { comboKeys } from '@renderer/hooks/use-hotkeys'
import { useUiStore } from '@renderer/stores/ui.store'

export const SHORTCUTS = [
  { combo: 'mod+n', labelKey: 'shortcuts.newProfile' },
  { combo: 'mod+shift+n', labelKey: 'shortcuts.bulkCreate' },
  { combo: 'mod+f', labelKey: 'shortcuts.search' },
  { combo: 'mod+a', labelKey: 'shortcuts.selectAll' },
  { combo: 'delete', labelKey: 'shortcuts.trash' },
  { combo: 'escape', labelKey: 'shortcuts.escape' },
  { combo: 'mod+1', labelKey: 'shortcuts.navigate' },
  { combo: 'mod+,', labelKey: 'shortcuts.settings' },
  { combo: '?', labelKey: 'shortcuts.help' },
] as const

export function ShortcutsDialog() {
  const { t } = useTranslation()
  const open = useUiStore((s) => s.shortcutsOpen)
  const setOpen = useUiStore((s) => s.setShortcutsOpen)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('shortcuts.title')}</DialogTitle>
          <DialogDescription>{t('shortcuts.description')}</DialogDescription>
        </DialogHeader>
        <ul className="divide-y rounded-lg border">
          {SHORTCUTS.map(({ combo, labelKey }) => (
            <li key={combo} className="flex items-center justify-between gap-4 px-3 py-2.5 text-sm">
              <span>{t(labelKey)}</span>
              <KbdGroup>
                {comboKeys(combo === 'mod+1' ? 'mod+1…6' : combo).map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </KbdGroup>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
