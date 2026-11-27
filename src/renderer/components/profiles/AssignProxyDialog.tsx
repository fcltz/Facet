import { LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ProxyPicker } from '@renderer/components/common/pickers'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { useProfilesStore } from '@renderer/stores/profiles.store'
import { useUiStore } from '@renderer/stores/ui.store'

function AssignProxyBody({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const { t } = useTranslation()
  const assignProxy = useProfilesStore((s) => s.assignProxy)
  const current = useProfilesStore((s) =>
    ids.length === 1 && ids[0] ? (s.byId[ids[0]]?.proxyId ?? null) : null,
  )
  const [value, setValue] = useState<string | null>(current)
  const [saving, setSaving] = useState(false)

  const apply = async (): Promise<void> => {
    setSaving(true)
    await assignProxy(ids, value)
    setSaving(false)
    onDone()
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('assignProxy.title')}</DialogTitle>
        <DialogDescription>{t('assignProxy.description', { count: ids.length })}</DialogDescription>
      </DialogHeader>
      <ProxyPicker value={value} onChange={setValue} autoFocus />
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button onClick={() => void apply()} disabled={saving} data-testid="assign-proxy-apply">
          {saving && <LoaderCircle className="animate-spin" />}
          {t('common.apply')}
        </Button>
      </DialogFooter>
    </>
  )
}

export function AssignProxyDialog() {
  const state = useUiStore((s) => s.assignProxy)
  const close = useUiStore((s) => s.closeAssignProxy)
  return (
    <Dialog open={state.open} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-lg">
        {state.open && <AssignProxyBody ids={state.ids} onDone={close} />}
      </DialogContent>
    </Dialog>
  )
}
