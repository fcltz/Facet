import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/utils'

interface PageHeaderProps {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
}

export function PageHeader({ title, description, actions, children, className }: PageHeaderProps) {
  return (
    <header className={cn('flex shrink-0 flex-col gap-4 px-6 pt-6 pb-4', className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
          {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  )
}
