import { useTranslation } from 'react-i18next'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { useProfilesStore } from '@renderer/stores/profiles.store'
import { useUiStore } from '@renderer/stores/ui.store'

/** Aviso exibido quando o proxy ou as extensões de um perfil aberto mudam: oferece reiniciar na hora. */
export function RestartPromptDialog() {
  const { t } = useTranslation()
  const state = useUiStore((s) => s.restartPrompt)
  const close = useUiStore((s) => s.closeRestartPrompt)
  const restart = useProfilesStore((s) => s.restart)
  const count = state.ids.length

  return (
    <AlertDialog open={state.open} onOpenChange={(open) => !open && close()}>
      <AlertDialogContent data-testid="restart-prompt">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('restartPrompt.title', { count })}</AlertDialogTitle>
          <AlertDialogDescription>
            {state.reason === 'browser'
              ? t('restartPrompt.browserDescription', { count })
              : state.reason === 'fingerprint'
                ? t('restartPrompt.fingerprintDescription', { count })
                : state.reason === 'country'
                  ? t('restartPrompt.countryDescription', { count })
                  : state.reason === 'extensions'
                    ? t('restartPrompt.extensionsDescription', { count })
                    : t('restartPrompt.description', { count })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={close}>{t('common.later')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              const ids = state.ids
              close()
              void restart(ids)
            }}
          >
            {t('common.restartNow')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
