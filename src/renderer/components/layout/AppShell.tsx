import type { ReactNode } from 'react'
import type { EffectiveTheme } from '@renderer/hooks/use-theme'
import { Sidebar } from './Sidebar'

export function AppShell({ theme, children }: { theme: EffectiveTheme; children: ReactNode }) {
  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      <Sidebar theme={theme} />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
    </div>
  )
}
