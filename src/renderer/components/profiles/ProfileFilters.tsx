import { Activity, Check, Folder, Globe, Tag as TagIcon, X, type LucideIcon } from 'lucide-react'
import { useMemo, type ComponentProps, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CountryFlag } from '@renderer/components/common/CountryFlag'
import { Button } from '@renderer/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@renderer/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { countryName } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import { useCatalogStore } from '@renderer/stores/catalog.store'
import {
  hasActiveFilters,
  NO_GROUP,
  useProfilesStore,
  type ProfileRow,
  type ProxyFilterMode,
  type StatusFilter,
} from '@renderer/stores/profiles.store'

export interface FilterOption {
  value: string
  label: string
  swatch?: string
  icon?: ReactNode
  count?: number
}

const STATUS_FILTERS: StatusFilter[] = ['running', 'stopped', 'busy', 'error']

function CheckBox({ checked, round }: { checked: boolean; round?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-4 shrink-0 items-center justify-center border',
        round ? 'rounded-full' : 'rounded-[4px]',
        checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
      )}
    >
      {checked && <Check className="size-3" strokeWidth={3} />}
    </span>
  )
}

function OptionRow({ option, checked, round }: { option: FilterOption; checked: boolean; round?: boolean }) {
  return (
    <>
      <CheckBox checked={checked} round={round} />
      {option.swatch && (
        <span aria-hidden className="size-2.5 rounded-[3px]" style={{ backgroundColor: option.swatch }} />
      )}
      {option.icon}
      <span className="flex-1 truncate">{option.label}</span>
      {option.count !== undefined && (
        <span className="text-xs text-muted-foreground tabular-nums">{option.count}</span>
      )}
    </>
  )
}

function FilterTrigger({
  icon: Icon,
  label,
  count,
  className,
  ...props
}: { icon: LucideIcon; label: string; count: number } & ComponentProps<typeof Button>) {
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        'h-9 gap-2 border-dashed font-normal',
        count > 0 &&
          'border-solid border-primary/40 bg-primary/5 text-primary hover:bg-primary/10 hover:text-primary',
        className,
      )}
      {...props}
    >
      <Icon className="size-4" />
      {label}
      {count > 0 && (
        <span className="rounded-full bg-primary px-1.5 text-[11px] leading-[18px] font-semibold text-primary-foreground tabular-nums">
          {count}
        </span>
      )}
    </Button>
  )
}

export function MultiFilter({
  icon,
  label,
  options,
  selected,
  onChange,
  testId,
}: {
  icon: LucideIcon
  label: string
  options: FilterOption[]
  selected: string[]
  onChange: (values: string[]) => void
  testId: string
}) {
  const { t } = useTranslation()
  const toggle = (value: string): void =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])
  return (
    <Popover>
      <PopoverTrigger asChild>
        <FilterTrigger data-testid={testId} icon={icon} label={label} count={selected.length} />
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          {options.length > 7 && <CommandInput placeholder={t('filters.searchOptions')} />}
          <CommandList>
            <CommandEmpty>{t('filters.noOptions')}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={`${option.label} ${option.value}`}
                  onSelect={() => toggle(option.value)}
                >
                  <OptionRow option={option} checked={selected.includes(option.value)} />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {selected.length > 0 && (
            <div className="border-t p-1">
              <Button variant="ghost" size="sm" className="w-full" onClick={() => onChange([])}>
                {t('common.clear')}
              </Button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function ProxyFilter({ rows }: { rows: ProfileRow[] }) {
  const { t } = useTranslation()
  const filters = useProfilesStore((s) => s.filters)
  const setFilters = useProfilesStore((s) => s.setFilters)
  const proxies = useCatalogStore((s) => s.proxies)

  const countries = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of rows) {
      const code = row.proxy?.countryCode
      if (code) counts.set(code, (counts.get(code) ?? 0) + 1)
    }
    for (const proxy of proxies)
      if (proxy.countryCode && !counts.has(proxy.countryCode)) counts.set(proxy.countryCode, 0)
    return [...counts.entries()]
      .map(([code, count]) => ({ code, count, name: countryName(code) ?? code }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [rows, proxies])

  const modes: { value: ProxyFilterMode; label: string }[] = [
    { value: 'any', label: t('filters.any') },
    { value: 'with', label: t('filters.withProxy') },
    { value: 'without', label: t('filters.withoutProxy') },
  ]
  const activeCount = (filters.proxyMode !== 'any' ? 1 : 0) + filters.countries.length
  const toggleCountry = (code: string): void =>
    setFilters({
      countries: filters.countries.includes(code)
        ? filters.countries.filter((c) => c !== code)
        : [...filters.countries, code],
    })

  return (
    <Popover>
      <PopoverTrigger asChild>
        <FilterTrigger
          data-testid="filter-proxy"
          icon={Globe}
          label={t('filters.proxy')}
          count={activeCount}
        />
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandList className="max-h-[360px]">
            <CommandGroup heading={t('filters.connection')}>
              {modes.map((mode) => (
                <CommandItem
                  key={mode.value}
                  value={`mode ${mode.value}`}
                  onSelect={() => setFilters({ proxyMode: mode.value })}
                >
                  <OptionRow
                    option={{ value: mode.value, label: mode.label }}
                    checked={filters.proxyMode === mode.value}
                    round
                  />
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading={t('filters.country')}>
              {countries.map((country) => (
                <CommandItem
                  key={country.code}
                  value={`country ${country.code} ${country.name}`}
                  onSelect={() => toggleCountry(country.code)}
                >
                  <OptionRow
                    option={{
                      value: country.code,
                      label: country.name,
                      icon: <CountryFlag code={country.code} />,
                      count: country.count,
                    }}
                    checked={filters.countries.includes(country.code)}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {activeCount > 0 && (
            <div className="border-t p-1">
              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={() => setFilters({ proxyMode: 'any', countries: [] })}
              >
                {t('common.clear')}
              </Button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function Chip({ label, icon, onRemove }: { label: string; icon?: ReactNode; onRemove: () => void }) {
  const { t } = useTranslation()
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-full border bg-card pr-1 pl-2.5 text-xs font-medium shadow-soft">
      {icon}
      <span className="max-w-[160px] truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('filters.removeFilter', { name: label })}
        className="flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

/** Botões de filtro (grupo, tag, status, proxy) com contagem por opção. */
export function ProfileFilters({ rows }: { rows: ProfileRow[] }) {
  const { t } = useTranslation()
  const filters = useProfilesStore((s) => s.filters)
  const setFilters = useProfilesStore((s) => s.setFilters)
  const groups = useCatalogStore((s) => s.groups)
  const tags = useCatalogStore((s) => s.tags)

  const groupOptions = useMemo<FilterOption[]>(() => {
    const counts = new Map<string, number>()
    for (const row of rows)
      counts.set(row.groupId ?? NO_GROUP, (counts.get(row.groupId ?? NO_GROUP) ?? 0) + 1)
    return [
      ...groups.map((g) => ({ value: g.id, label: g.name, swatch: g.color, count: counts.get(g.id) ?? 0 })),
      { value: NO_GROUP, label: t('filters.noGroup'), count: counts.get(NO_GROUP) ?? 0 },
    ]
  }, [rows, groups, t])

  const tagOptions = useMemo<FilterOption[]>(() => {
    const counts = new Map<string, number>()
    for (const row of rows) for (const id of row.tagIds) counts.set(id, (counts.get(id) ?? 0) + 1)
    return tags.map((tag) => ({
      value: tag.id,
      label: tag.name,
      swatch: tag.color,
      count: counts.get(tag.id) ?? 0,
    }))
  }, [rows, tags])

  const statusOptions = useMemo<FilterOption[]>(() => {
    const counts: Record<StatusFilter, number> = { running: 0, stopped: 0, busy: 0, error: 0 }
    for (const row of rows) {
      if (row.status === 'starting' || row.status === 'stopping') counts.busy++
      else if (row.status === 'disconnected') counts.error++
      else counts[row.status]++
    }
    return STATUS_FILTERS.map((status) => ({
      value: status,
      label: t(`statusFilter.${status}`),
      count: counts[status],
    }))
  }, [rows, t])

  return (
    <div className="flex flex-wrap items-center gap-2">
      <MultiFilter
        testId="filter-group"
        icon={Folder}
        label={t('filters.group')}
        options={groupOptions}
        selected={filters.groupIds}
        onChange={(groupIds) => setFilters({ groupIds })}
      />
      <MultiFilter
        testId="filter-tag"
        icon={TagIcon}
        label={t('filters.tag')}
        options={tagOptions}
        selected={filters.tagIds}
        onChange={(tagIds) => setFilters({ tagIds })}
      />
      <MultiFilter
        testId="filter-status"
        icon={Activity}
        label={t('filters.status')}
        options={statusOptions}
        selected={filters.statuses}
        onChange={(statuses) => setFilters({ statuses: statuses as StatusFilter[] })}
      />
      <ProxyFilter rows={rows} />
    </div>
  )
}

/** Etiquetas dos filtros ativos, cada uma removível. */
export function ActiveFilterChips() {
  const { t } = useTranslation()
  const filters = useProfilesStore((s) => s.filters)
  const setFilters = useProfilesStore((s) => s.setFilters)
  const clearFilters = useProfilesStore((s) => s.clearFilters)
  const groupsById = useCatalogStore((s) => s.groupsById)
  const tagsById = useCatalogStore((s) => s.tagsById)

  if (!hasActiveFilters(filters)) return null

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="active-filters">
      {filters.groupIds.map((id) => {
        const group = groupsById[id]
        const label = id === NO_GROUP ? t('filters.noGroup') : (group?.name ?? id)
        return (
          <Chip
            key={`g-${id}`}
            label={label}
            icon={
              group ? (
                <span className="size-2 rounded-[3px]" style={{ backgroundColor: group.color }} />
              ) : (
                <Folder className="size-3" />
              )
            }
            onRemove={() => setFilters({ groupIds: filters.groupIds.filter((g) => g !== id) })}
          />
        )
      })}
      {filters.tagIds.map((id) => {
        const tag = tagsById[id]
        return (
          <Chip
            key={`t-${id}`}
            label={tag?.name ?? id}
            icon={
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: tag?.color ?? 'currentColor' }}
              />
            }
            onRemove={() => setFilters({ tagIds: filters.tagIds.filter((tagId) => tagId !== id) })}
          />
        )
      })}
      {filters.statuses.map((status) => (
        <Chip
          key={`s-${status}`}
          label={t(`statusFilter.${status}`)}
          icon={<Activity className="size-3" />}
          onRemove={() => setFilters({ statuses: filters.statuses.filter((s) => s !== status) })}
        />
      ))}
      {filters.proxyMode !== 'any' && (
        <Chip
          label={filters.proxyMode === 'with' ? t('filters.withProxy') : t('filters.withoutProxy')}
          icon={<Globe className="size-3" />}
          onRemove={() => setFilters({ proxyMode: 'any' })}
        />
      )}
      {filters.countries.map((code) => (
        <Chip
          key={`c-${code}`}
          label={countryName(code) ?? code}
          icon={<CountryFlag code={code} className="h-3 w-[18px]" />}
          onRemove={() => setFilters({ countries: filters.countries.filter((c) => c !== code) })}
        />
      ))}
      <Button variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={clearFilters}>
        <X />
        {t('filters.clearAll')}
      </Button>
    </div>
  )
}
