import {
  Globe,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Puzzle,
  Settings,
  Sun,
  Tags,
  Trash2,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { APP_NAME } from '@shared/constants'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import type { EffectiveTheme } from '@renderer/hooks/use-theme'
import { cn } from '@renderer/lib/utils'
import { useProfilesStore } from '@renderer/stores/profiles.store'
import { useSettingsStore } from '@renderer/stores/settings.store'
import { useUiStore, type Page } from '@renderer/stores/ui.store'

interface NavItem {
  page: Page
  icon: LucideIcon
  labelKey: 'nav.profiles' | 'nav.proxies' | 'nav.extensions' | 'nav.groups' | 'nav.trash' | 'nav.settings'
}

const MAIN_ITEMS: NavItem[] = [
  { page: 'profiles', icon: Users, labelKey: 'nav.profiles' },
  { page: 'proxies', icon: Globe, labelKey: 'nav.proxies' },
  { page: 'extensions', icon: Puzzle, labelKey: 'nav.extensions' },
  { page: 'groups', icon: Tags, labelKey: 'nav.groups' },
  { page: 'trash', icon: Trash2, labelKey: 'nav.trash' },
]

const SETTINGS_ITEM: NavItem = { page: 'settings', icon: Settings, labelKey: 'nav.settings' }

export function FacetLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <defs>
        <linearGradient id="facet-logo-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7C7CFB" />
          <stop offset="1" stopColor="#4646E6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#facet-logo-bg)" />
      <path d="M16 6.5 24.5 12.5 16 25.5 7.5 12.5Z" fill="#fff" fillOpacity="0.96" />
      <path d="M7.5 12.5h17L16 25.5Z" fill="#fff" fillOpacity="0.62" />
      <path d="M12.2 12.5 16 6.5l3.8 6L16 25.5Z" fill="#4646E6" fillOpacity="0.18" />
    </svg>
  )
}

function NavButton({
  item,
  active,
  collapsed,
  count,
  onSelect,
}: {
  item: NavItem
  active: boolean
  collapsed: boolean
  count?: number
  onSelect: (page: Page) => void
}) {
  const { t } = useTranslation()
  const Icon = item.icon
  const label = t(item.labelKey)
  const button = (
    <button
      type="button"
      onClick={() => onSelect(item.page)}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? label : undefined}
      data-testid="nav-item"
      data-page={item.page}
      className={cn(
        'group flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-sm font-medium transition-colors',
        active
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'text-sidebar-foreground hover:bg-accent hover:text-accent-foreground',
        collapsed && 'justify-center px-0',
      )}
    >
      <Icon
        className={cn(
          'size-[18px] shrink-0',
          active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground',
        )}
      />
      {!collapsed && <span className="flex-1 truncate text-left">{label}</span>}
      {!collapsed && count !== undefined && count > 0 && (
        <span
          className={cn(
            'min-w-6 rounded-full px-1.5 text-center text-[11px] leading-5 font-semibold tabular-nums',
            active ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
          )}
        >
          {count > 999 ? '999+' : count}
        </span>
      )}
    </button>
  )
  if (!collapsed) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{count ? `${label} (${count})` : label}</TooltipContent>
    </Tooltip>
  )
}

export function Sidebar({ theme }: { theme: EffectiveTheme }) {
  const { t } = useTranslation()
  const page = useUiStore((s) => s.page)
  const setPage = useUiStore((s) => s.setPage)
  const collapsed = useSettingsStore((s) => s.settings.sidebarCollapsed)
  const appInfo = useSettingsStore((s) => s.appInfo)
  const updateSettings = useSettingsStore((s) => s.update)
  const byId = useProfilesStore((s) => s.byId)

  const counts = useMemo(() => {
    let active = 0
    let trashed = 0
    for (const profile of Object.values(byId)) {
      if (profile.deletedAt === null) active++
      else trashed++
    }
    return { active, trashed }
  }, [byId])

  const nextTheme = theme === 'dark' ? 'light' : 'dark'
  const themeLabel = nextTheme === 'light' ? t('nav.themeLight') : t('nav.themeDark')
  const collapseLabel = collapsed ? t('nav.expand') : t('nav.collapse')

  return (
    <aside
      data-testid="sidebar"
      aria-label={t('nav.main')}
      className={cn(
        'flex h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200',
        collapsed ? 'w-[68px]' : 'w-[232px]',
      )}
    >
      <div className={cn('flex h-16 items-center gap-2.5 px-4', collapsed && 'justify-center px-0')}>
        <FacetLogo className="size-8 shrink-0" />
        {!collapsed && (
          <div className="min-w-0" aria-label={APP_NAME}>
            <div className="text-[15px] leading-tight font-semibold tracking-tight">Facet</div>
            <div className="text-[11px] text-muted-foreground">Browsers Antidetect</div>
          </div>
        )}
      </div>

      <nav className={cn('flex flex-1 flex-col gap-1 px-3 pt-2', collapsed && 'px-2')}>
        {MAIN_ITEMS.map((item) => (
          <NavButton
            key={item.page}
            item={item}
            active={page === item.page}
            collapsed={collapsed}
            onSelect={setPage}
            count={
              item.page === 'profiles' ? counts.active : item.page === 'trash' ? counts.trashed : undefined
            }
          />
        ))}
      </nav>

      <div className={cn('flex flex-col gap-1 border-t border-sidebar-border p-3', collapsed && 'px-2')}>
        <NavButton
          item={SETTINGS_ITEM}
          active={page === 'settings'}
          collapsed={collapsed}
          onSelect={setPage}
        />
        <div className={cn('mt-1 flex items-center gap-1', collapsed ? 'flex-col' : 'justify-between')}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={themeLabel}
                data-testid="theme-toggle"
                onClick={() => void updateSettings({ theme: nextTheme })}
                className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {theme === 'dark' ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side={collapsed ? 'right' : 'top'}>{themeLabel}</TooltipContent>
          </Tooltip>
          {!collapsed && appInfo && (
            <span className="text-[11px] text-muted-foreground tabular-nums">v{appInfo.version}</span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={collapseLabel}
                onClick={() => void updateSettings({ sidebarCollapsed: !collapsed })}
                className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {collapsed ? (
                  <PanelLeftOpen className="size-[18px]" />
                ) : (
                  <PanelLeftClose className="size-[18px]" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side={collapsed ? 'right' : 'top'}>{collapseLabel}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </aside>
  )
}
