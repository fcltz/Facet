import { LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { ExtensionConfigMode, ExtensionSummary } from '@shared/schemas/extension'
import { Field } from '@renderer/components/common/Field'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { invoke, toastError } from '@renderer/lib/ipc'
import { useExtensionsStore } from '@renderer/stores/extensions.store'
import { useUiStore } from '@renderer/stores/ui.store'
import { ExtensionIcon } from './ExtensionBadges'

function PreferencesForm({ extension, onDone }: { extension: ExtensionSummary; onDone: () => void }) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<ExtensionConfigMode>(extension.applyMode)
  const [isDefault, setDefault] = useState(extension.isDefault)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      const updated = await invoke('extensions.setPreferences', { id: extension.id, mode, isDefault })
      useExtensionsStore.getState().apply({ upserted: [updated], removedIds: [] })
      toast.success(t('extensionConfig.saved'))
      onDone()
    } catch (error) {
      toastError(error)
    } finally {
      setSaving(false)
    }
  }
  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-3">
          <ExtensionIcon icon={extension.icon} />
          <div className="min-w-0">
            <DialogTitle>{t('extensionConfig.title')}</DialogTitle>
            <DialogDescription className="mt-1">{extension.name}</DialogDescription>
          </div>
        </div>
      </DialogHeader>
      <div className="grid gap-6 py-5">
        <Field label={t('extensionConfig.mode')} htmlFor="config-mode">
          <Select
            value={mode}
            onValueChange={(value) => setMode(value as ExtensionConfigMode)}
            disabled={saving}
          >
            <SelectTrigger id="config-mode" className="w-full" data-testid="config-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {(['always', 'once'] as const).map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`extensionConfig.modes.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
          <Label htmlFor="config-default" className="leading-relaxed">
            {t('extensionConfig.default')}
          </Label>
          <Switch
            id="config-default"
            checked={isDefault}
            onCheckedChange={setDefault}
            disabled={saving}
            data-testid="config-default"
          />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={saving}>
          {t('common.cancel')}
        </Button>
        <Button onClick={() => void save()} disabled={saving} data-testid="config-save">
          {saving && <LoaderCircle className="animate-spin" />}
          {t('common.save')}
        </Button>
      </DialogFooter>
    </>
  )
}

export function ExtensionConfigDialog() {
  const state = useUiStore((s) => s.extensionConfig)
  const close = useUiStore((s) => s.closeExtensionConfig)
  const extension = useExtensionsStore((s) => s.list.find((item) => item.id === state.extensionId) ?? null)
  useEffect(() => {
    if (state.open && !extension) close()
  }, [state.open, extension, close])
  return (
    <Dialog open={state.open && extension !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-md" data-testid="extension-config-dialog">
        {state.open && extension && (
          <PreferencesForm key={extension.id} extension={extension} onDone={close} />
        )}
      </DialogContent>
    </Dialog>
  )
}
