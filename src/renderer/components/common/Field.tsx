import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Label } from '@renderer/components/ui/label'
import { tr } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'

/** As mensagens dos schemas Zod são chaves de tradução ("required", "tooLong"…). */
export function validationMessage(message: string | undefined): string | undefined {
  if (!message) return undefined
  return tr(`validation.${message}`, message)
}

interface FieldProps {
  label: ReactNode
  htmlFor?: string
  hint?: ReactNode
  error?: string
  optional?: boolean
  action?: ReactNode
  className?: string
  children: ReactNode
}

export function Field({ label, htmlFor, hint, error, optional, action, className, children }: FieldProps) {
  const { t } = useTranslation()
  const message = validationMessage(error)
  return (
    // content-start: numa grade de várias colunas, o campo ao lado de um mais alto (com mensagem
    // de erro) não estica as próprias linhas, então rótulos e entradas continuam alinhados.
    <div className={cn('grid content-start gap-2', className)}>
      <div className="flex min-h-5 items-center justify-between gap-2">
        <Label htmlFor={htmlFor} className="text-[13px]">
          {label}
          {optional && <span className="font-normal text-muted-foreground">({t('common.optional')})</span>}
        </Label>
        {action}
      </div>
      {children}
      {message ? (
        <p role="alert" className="text-xs font-medium text-destructive">
          {message}
        </p>
      ) : hint ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}

/** Bloco de informação discreto (avisos de etapa, notas de honestidade do fingerprint). */
export function Notice({
  icon,
  title,
  children,
  tone = 'info',
  className,
}: {
  icon?: ReactNode
  title?: ReactNode
  children: ReactNode
  tone?: 'info' | 'warning'
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex gap-3 rounded-lg border p-3 text-sm',
        tone === 'info' ? 'border-primary/20 bg-primary/5' : 'border-warning/30 bg-warning/10',
        className,
      )}
    >
      {icon && (
        <div className={cn('mt-0.5 shrink-0', tone === 'info' ? 'text-primary' : 'text-warning')}>{icon}</div>
      )}
      <div className="min-w-0 space-y-1">
        {title && <p className="font-medium text-foreground">{title}</p>}
        <div className="leading-relaxed text-muted-foreground">{children}</div>
      </div>
    </div>
  )
}
