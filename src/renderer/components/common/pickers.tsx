import { Ban, Check, ChevronsUpDown, Plus, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { COLOR_PALETTE, LIMITS } from '@shared/constants'
import { proxyEndpoint, proxyTitle, type ProxySummary } from '@shared/schemas/proxy'
import { Button } from '@renderer/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@renderer/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { countryName } from '@renderer/lib/format'
import { toastError } from '@renderer/lib/ipc'
import { cn } from '@renderer/lib/utils'
import { useCatalogStore } from '@renderer/stores/catalog.store'
import { CountryFlag } from './CountryFlag'
import { GroupBadge } from './GroupBadge'
import { TagBadge } from './TagBadge'

const NONE = '__none__'

export function GroupSelect({
  value,
  onChange,
  id,
  compact = false,
  disabled = false,
  label,
}: {
  value: string | null
  onChange: (groupId: string | null) => void
  id?: string
  compact?: boolean
  disabled?: boolean
  label?: string
}) {
  const { t } = useTranslation()
  const groups = useCatalogStore((s) => s.groups)
  const selected = groups.find((group) => group.id === value)
  return (
    <Select
      disabled={disabled}
      value={value ?? NONE}
      onValueChange={(next) => onChange(next === NONE ? null : next)}
    >
      <SelectTrigger
        id={id}
        aria-label={label}
        title={selected?.name ?? t('common.noGroup')}
        data-testid={compact ? 'inline-group' : undefined}
        className={cn(
          'w-full min-w-0',
          compact &&
            'h-8 border-transparent bg-transparent px-1 shadow-none hover:bg-accent dark:bg-transparent',
        )}
      >
        <SelectValue>
          {selected ? (
            <GroupBadge group={selected} className="max-w-full" />
          ) : (
            <span className="truncate text-muted-foreground">{t('common.noGroup')}</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent position="popper" align="start" className="max-w-[calc(100vw-2rem)]">
        <SelectItem value={NONE}>
          <span className="text-muted-foreground">{t('common.noGroup')}</span>
        </SelectItem>
        {groups.map((group) => (
          <SelectItem key={group.id} value={group.id}>
            <GroupBadge group={group} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function TagPicker({
  value,
  onChange,
  id,
  compact = false,
  disabled = false,
  label,
}: {
  value: string[]
  onChange: (tagIds: string[]) => void
  id?: string
  compact?: boolean
  disabled?: boolean
  label?: string
}) {
  const { t } = useTranslation()
  const tags = useCatalogStore((s) => s.tags)
  const tagsById = useCatalogStore((s) => s.tagsById)
  const createTag = useCatalogStore((s) => s.createTag)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)

  const selected = value.map((tagId) => tagsById[tagId]).filter((tag) => tag !== undefined)
  const trimmed = query.trim()
  const exists = tags.some(
    (tag) => tag.name.localeCompare(trimmed, undefined, { sensitivity: 'accent' }) === 0,
  )
  const full = value.length >= LIMITS.tagsPerProfileMax

  const toggle = (tagId: string): void => {
    if (disabled) return
    if (value.includes(tagId)) onChange(value.filter((v) => v !== tagId))
    else if (!full) onChange([...value, tagId])
  }

  const create = async (): Promise<void> => {
    if (!trimmed || creating || full || disabled) return
    setCreating(true)
    try {
      const color = COLOR_PALETTE[tags.length % COLOR_PALETTE.length] ?? COLOR_PALETTE[0]
      const tag = await createTag({ name: trimmed, color })
      onChange([...value, tag.id])
      setQuery('')
    } catch (error) {
      toastError(error)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="grid min-w-0 w-full gap-2">
      {!compact && selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((tag) => (
            <TagBadge key={tag.id} tag={tag} onRemove={() => toggle(tag.id)} />
          ))}
        </div>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant={compact ? 'ghost' : 'outline'}
            disabled={disabled}
            aria-label={label}
            data-testid={compact ? 'inline-tags' : undefined}
            title={compact ? selected.map((tag) => tag.name).join(', ') : undefined}
            className={cn(
              'min-w-0 w-full justify-between font-normal text-muted-foreground',
              compact && 'h-8 gap-1 px-1 shadow-none has-[>svg]:px-1',
            )}
          >
            {compact && selected.length ? (
              <span className="flex min-w-0 gap-1 overflow-hidden">
                {selected.slice(0, 1).map((tag) => (
                  <TagBadge key={tag.id} tag={tag} className="min-w-0" />
                ))}
                {selected.length > 1 && <span className="shrink-0 text-xs">+{selected.length - 1}</span>}
              </span>
            ) : (
              <span className="truncate">{t('tagPicker.placeholder')}</span>
            )}
            <ChevronsUpDown className="shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className={cn(
            'max-w-[calc(100vw-2rem)] p-0',
            compact ? 'w-72' : 'w-(--radix-popover-trigger-width)',
          )}
          align="start"
        >
          <Command>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={t('tagPicker.search')}
              disabled={disabled || creating}
            />
            <CommandList>
              <CommandEmpty>{t('tagPicker.empty')}</CommandEmpty>
              <CommandGroup>
                {tags.map((tag) => {
                  const checked = value.includes(tag.id)
                  return (
                    <CommandItem
                      key={tag.id}
                      value={`${tag.name} ${tag.id}`}
                      disabled={disabled || creating || (!checked && full)}
                      onSelect={() => toggle(tag.id)}
                    >
                      <Check className={cn('size-4', checked ? 'text-primary opacity-100' : 'opacity-0')} />
                      <span
                        aria-hidden
                        className="size-2 rounded-full"
                        style={{ backgroundColor: tag.color }}
                      />
                      <span className="truncate">{tag.name}</span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
              {trimmed && !exists && (
                <CommandGroup forceMount>
                  <CommandItem
                    forceMount
                    value={`__create__ ${trimmed}`}
                    disabled={full || creating || disabled}
                    onSelect={() => void create()}
                  >
                    <Plus className="size-4 text-primary" />
                    {t('tagPicker.create', { name: trimmed })}
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}

/** O proxy sai pelo IP real desta conexão (verificação recusada com PROXY_REAL_IP). */
export function exposesRealIp(proxy: Pick<ProxySummary, 'checkStatus' | 'lastErrorCode'>): boolean {
  return proxy.checkStatus === 'offline' && proxy.lastErrorCode === 'PROXY_REAL_IP'
}

export function ProxyStatusPill({ proxy, className }: { proxy: ProxySummary; className?: string }) {
  const { t } = useTranslation()
  if (exposesRealIp(proxy)) {
    return (
      <span
        className={cn('inline-flex items-center gap-1 text-xs font-semibold text-destructive', className)}
        data-real-ip="true"
      >
        <ShieldAlert className="size-3.5" />
        {t('proxies.realIp')}
      </span>
    )
  }
  if (proxy.checkStatus === 'online') {
    return (
      <span className={cn('inline-flex items-center gap-1 text-xs font-medium text-success', className)}>
        <span className="size-1.5 rounded-full bg-success" />
        {proxy.latencyMs !== null
          ? t('profiles.latency', { ms: proxy.latencyMs })
          : t('profiles.proxyOnline')}
      </span>
    )
  }
  if (proxy.checkStatus === 'offline') {
    return (
      <span className={cn('inline-flex items-center gap-1 text-xs font-medium text-destructive', className)}>
        <span className="size-1.5 rounded-full bg-destructive" />
        offline
      </span>
    )
  }
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs text-muted-foreground', className)}>
      <span className="size-1.5 rounded-full bg-muted-foreground/50" />
      {t('proxyPicker.unchecked')}
    </span>
  )
}

export function proxyLocation(proxy: ProxySummary): string {
  const country = countryName(proxy.countryCode)
  return [proxy.city, country].filter(Boolean).join(', ')
}

/** Seletor compacto de proxy (criação em massa). */
export function ProxySelect({
  value,
  onChange,
  id,
}: {
  value: string | null
  onChange: (proxyId: string | null) => void
  id?: string
}) {
  const { t } = useTranslation()
  const proxies = useCatalogStore((s) => s.proxies)
  const selected = proxies.find((proxy) => proxy.id === value)
  const selectedText = selected
    ? [
        proxyTitle(selected),
        selected.name ? (selected.exitIp ?? proxyEndpoint(selected)) : null,
        proxyLocation(selected),
      ]
        .filter(Boolean)
        .join(' · ')
    : t('proxyPicker.none')
  return (
    <Select value={value ?? NONE} onValueChange={(next) => onChange(next === NONE ? null : next)}>
      <SelectTrigger id={id} className="w-full min-w-0" title={selectedText}>
        <SelectValue>
          <span className="flex min-w-0 items-center gap-2">
            {selected && <CountryFlag code={selected.countryCode} />}
            <span className="truncate">{selectedText}</span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        position="popper"
        align="start"
        className="w-[min(32rem,calc(100vw-2rem))] min-w-0"
        data-testid="bulk-proxy-options"
      >
        <SelectItem value={NONE}>
          <span className="text-muted-foreground">{t('proxyPicker.none')}</span>
        </SelectItem>
        {proxies.map((proxy) => (
          <SelectItem key={proxy.id} value={proxy.id}>
            <CountryFlag code={proxy.countryCode} />
            <span className={cn('text-[13px]', !proxy.name && 'font-mono')}>{proxyTitle(proxy)}</span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {[proxy.name ? (proxy.exitIp ?? proxyEndpoint(proxy)) : null, proxyLocation(proxy)]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Lista pesquisável de proxies (aba Proxy do drawer e diálogo de atribuição em massa). */
export function ProxyPicker({
  value,
  onChange,
  autoFocus,
  className,
}: {
  value: string | null
  onChange: (proxyId: string | null) => void
  autoFocus?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const proxies = useCatalogStore((s) => s.proxies)

  return (
    <Command className={cn('rounded-lg border', className)} data-testid="proxy-picker">
      <CommandInput placeholder={t('proxyPicker.search')} autoFocus={autoFocus} />
      <CommandList className="max-h-[320px]">
        <CommandEmpty>{t('proxyPicker.empty')}</CommandEmpty>
        <CommandGroup>
          <CommandItem value={`${NONE} ${t('proxyPicker.none')}`} onSelect={() => onChange(null)}>
            <Check className={cn('size-4', value === null ? 'text-primary opacity-100' : 'opacity-0')} />
            <Ban className="size-4 text-muted-foreground" />
            <span>{t('proxyPicker.none')}</span>
          </CommandItem>
          {proxies.map((proxy) => {
            const location = proxyLocation(proxy)
            const searchable = [
              proxy.id,
              proxy.countryCode,
              countryName(proxy.countryCode),
              proxy.city,
              proxy.exitIp,
              proxy.host,
              proxy.name,
              proxy.type,
            ]
              .filter(Boolean)
              .join(' ')
            return (
              <CommandItem
                key={proxy.id}
                value={searchable}
                onSelect={() => onChange(proxy.id)}
                className="gap-3 py-2"
              >
                <Check
                  className={cn('size-4', value === proxy.id ? 'text-primary opacity-100' : 'opacity-0')}
                />
                <CountryFlag code={proxy.countryCode} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{proxyTitle(proxy)}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {[
                      proxy.name ? (proxy.exitIp ?? proxyEndpoint(proxy)) : null,
                      location,
                      proxy.type.toUpperCase(),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <ProxyStatusPill proxy={proxy} />
              </CommandItem>
            )
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}
