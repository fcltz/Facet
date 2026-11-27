import { ChevronDown, Layers, Plus, Search, Upload, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Input } from '@renderer/components/ui/input'
import { Kbd, KbdGroup } from '@renderer/components/ui/kbd'
import { comboKeys } from '@renderer/hooks/use-hotkeys'
import { useProfilesStore, type ProfileRow } from '@renderer/stores/profiles.store'
import { useUiStore } from '@renderer/stores/ui.store'
import { ActiveFilterChips, ProfileFilters } from './ProfileFilters'
import { ProfileViewMenu } from './ProfileViewMenu'

/** Botão "+ Novo perfil" com menu para criação em massa. */
export function NewProfileButton() {
  const { t } = useTranslation()
  const openCreateDrawer = useUiStore((s) => s.openCreateDrawer)
  const setBulkCreateOpen = useUiStore((s) => s.setBulkCreateOpen)
  return (
    <div className="flex items-center">
      <Button
        variant="outline"
        className="mr-2"
        onClick={() => useUiStore.getState().setImportProfilesOpen(true)}
        data-testid="import-profiles"
      >
        <Upload />
        {t('transfer.importAction')}
      </Button>
      <Button onClick={openCreateDrawer} className="rounded-r-none" data-testid="new-profile">
        <Plus />
        {t('profiles.newProfile')}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            className="rounded-l-none border-l border-primary-foreground/20"
            aria-label={t('profiles.moreCreateOptions')}
            data-testid="new-profile-more"
          >
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onSelect={openCreateDrawer}>
            <Plus />
            {t('profiles.newProfile')}
            <DropdownMenuShortcut>{comboKeys('mod+n').join('+')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setBulkCreateOpen(true)} data-testid="bulk-create">
            <Layers />
            {t('profiles.bulkCreate')}
            <DropdownMenuShortcut>{comboKeys('mod+shift+n').join('+')}</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function ProfilesToolbar({ rows }: { rows: ProfileRow[] }) {
  const { t } = useTranslation()
  const search = useProfilesStore((s) => s.filters.search)
  const setFilters = useProfilesStore((s) => s.setFilters)
  const focusSignal = useUiStore((s) => s.searchFocusSignal)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (focusSignal === 0) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusSignal])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={search}
            onChange={(event) => setFilters({ search: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && search) {
                event.stopPropagation()
                setFilters({ search: '' })
              }
            }}
            placeholder={t('profiles.searchPlaceholder')}
            className="h-9 bg-card pr-20 pl-9"
            data-testid="profiles-search"
            spellCheck={false}
          />
          {search ? (
            <button
              type="button"
              onClick={() => setFilters({ search: '' })}
              aria-label={t('common.clear')}
              className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          ) : (
            <KbdGroup className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">
              {comboKeys('mod+f').map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </KbdGroup>
          )}
        </div>
        <ProfileFilters rows={rows} />
        <ProfileViewMenu />
      </div>
      <ActiveFilterChips />
    </div>
  )
}
