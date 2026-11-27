import { Download, Info, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { parseWebStoreInput } from '@shared/schemas/extension'
import { Field, Notice } from '@renderer/components/common/Field'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { describeError } from '@renderer/lib/ipc'
import { useExtensionsStore } from '@renderer/stores/extensions.store'
import { useUiStore } from '@renderer/stores/ui.store'

function WebStoreForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const importing = useExtensionsStore((s) => s.importing)
  const importWebStore = useExtensionsStore((s) => s.importWebStore)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const id = parseWebStoreInput(input)

  const submit = async (): Promise<void> => {
    if (!id) {
      setError(t('extensionWebStore.invalid'))
      return
    }
    setError(null)
    try {
      await importWebStore(input)
      onDone()
    } catch (caught) {
      setError(describeError(caught))
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
      noValidate
    >
      <DialogHeader>
        <DialogTitle>{t('extensionWebStore.title')}</DialogTitle>
        <DialogDescription>{t('extensionWebStore.description')}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 py-5">
        <Field
          label={t('extensionWebStore.label')}
          htmlFor="webstore-input"
          error={error ?? (input.trim() && !id ? t('extensionWebStore.invalid') : undefined)}
          hint={id ? t('extensionWebStore.detectedId', { id }) : undefined}
        >
          <Input
            id="webstore-input"
            value={input}
            onChange={(event) => {
              setInput(event.target.value)
              setError(null)
            }}
            placeholder={t('extensionWebStore.placeholder')}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            data-testid="webstore-input"
          />
        </Field>
        <Notice icon={<Info className="size-4" />}>{t('extensionWebStore.privacy')}</Notice>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={!id || importing} data-testid="webstore-submit">
          {importing ? <LoaderCircle className="animate-spin" /> : <Download />}
          {importing ? t('extensionWebStore.downloading') : t('extensionWebStore.submit')}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** Baixa uma extensão pelo link ou ID da Chrome Web Store (CRX conferido pela assinatura). */
export function AddFromWebStoreDialog() {
  const open = useUiStore((s) => s.webStoreOpen)
  const setOpen = useUiStore((s) => s.setWebStoreOpen)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg" data-testid="webstore-dialog">
        {open && <WebStoreForm onDone={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  )
}
