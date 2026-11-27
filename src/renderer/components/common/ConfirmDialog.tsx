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
import { buttonVariants } from '@renderer/components/ui/button'
import { useUiStore } from '@renderer/stores/ui.store'

/** Diálogo de confirmação único do app, aberto via `useUiStore.getState().requestConfirm()`. */
export function ConfirmDialog() {
  const { t } = useTranslation()
  const confirm = useUiStore((s) => s.confirm)
  const resolveConfirm = useUiStore((s) => s.resolveConfirm)

  return (
    <AlertDialog open={confirm.open} onOpenChange={(open) => !open && resolveConfirm(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
          {confirm.description && <AlertDialogDescription>{confirm.description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => resolveConfirm(false)}>
            {confirm.cancelLabel ?? t('common.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            className={confirm.destructive ? buttonVariants({ variant: 'destructive' }) : undefined}
            onClick={() => resolveConfirm(true)}
            data-testid="confirm-action"
          >
            {confirm.confirmLabel ?? t('common.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
