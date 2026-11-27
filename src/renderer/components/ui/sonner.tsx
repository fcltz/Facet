import type { CSSProperties } from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

/**
 * Toaster com as cores do tema do app. Substitui a versão do shadcn, que
 * depende de `next-themes` (não usado aqui): o tema vem por prop.
 */
function Toaster({ theme = 'light', ...props }: ToasterProps) {
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
        } as CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
