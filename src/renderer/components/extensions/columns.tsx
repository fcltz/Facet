import type { Column, ColumnDef } from '@tanstack/react-table'
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Copy,
  Ellipsis,
  FileArchive,
  FolderOpen,
  ListPlus,
  ListX,
  LoaderCircle,
  RefreshCw,
  Settings2,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Switch } from '@renderer/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { isBuiltinExtension } from '@shared/facet-extension'
import { naturalCompare } from '@renderer/lib/format'
import { toastError } from '@renderer/lib/ipc'
import { cn } from '@renderer/lib/utils'
import { useExtensionsStore, type ExtensionRow } from '@renderer/stores/extensions.store'
import { useUiStore } from '@renderer/stores/ui.store'
import { CriticalPermissionIcon, ExtensionIcon, formatBytes, ManifestBadge } from './ExtensionBadges'

export const EXTENSION_ROW_HEIGHT = 64
/**
 * Colunas da tabela, compartilhadas pelo cabeçalho e por todas as linhas (cada linha é um subgrid).
 * Versão, Origem e Perfis têm a largura do maior conteúdo da coluna, cabeçalho incluído, e só
 * encolhem (com reticências) quando a janela não comporta tudo; Extensão e Autoconfiguração
 * dividem o espaço que sobra. Larguras fixas cortavam versões longas ("2026.1124.1811" + MV3),
 * que invadiam a coluna Origem.
 */
export const EXTENSION_GRID =
  'minmax(200px,1.8fr) minmax(112px,max-content) minmax(96px,max-content) 90px minmax(188px,1.2fr) minmax(92px,max-content) 56px'
/** Soma dos mínimos das colunas: abaixo disso a tabela rola na horizontal. */
export const EXTENSION_TABLE_MIN_WIDTH = 834

type HeaderKey =
  | 'extensionsPage.columns.extension'
  | 'extensionsPage.columns.version'
  | 'extensionsPage.columns.source'
  | 'extensionsPage.columns.default'
  | 'extensionsPage.columns.config'
  | 'extensionsPage.columns.profiles'
  | 'extensionsPage.columns.actions'

function ColumnHeader({ column, labelKey }: { column: Column<ExtensionRow>; labelKey: HeaderKey }) {
  const { t } = useTranslation()
  const label = t(labelKey)
  if (!column.getCanSort()) return <span>{label}</span>
  const sorted = column.getIsSorted()
  const Icon = sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ChevronsUpDown
  return (
    <button
      type="button"
      onClick={column.getToggleSortingHandler()}
      className={cn(
        '-ml-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-accent hover:text-foreground',
        sorted && 'text-foreground',
      )}
    >
      {label}
      <Icon className={cn('size-3.5', !sorted && 'opacity-50')} />
    </button>
  )
}

function NameCell({ row }: { row: ExtensionRow }) {
  const { t } = useTranslation()
  const description = isBuiltinExtension(row) ? t('extensionsPage.builtinDescription') : row.description
  return (
    <div className="flex min-w-0 items-center gap-3">
      <ExtensionIcon icon={row.icon} />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <p className="truncate text-sm font-medium" data-testid="extension-name">
                {row.name}
              </p>
            </TooltipTrigger>
            {description && <TooltipContent className="max-w-sm">{description}</TooltipContent>}
          </Tooltip>
          <CriticalPermissionIcon extension={row} />
        </div>
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {row.id} · {formatBytes(row.sizeBytes)}
        </p>
      </div>
    </div>
  )
}

function VersionCell({ row }: { row: ExtensionRow }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="truncate text-sm tabular-nums" title={row.version} data-testid="extension-version">
        {row.version}
      </span>
      <ManifestBadge manifestVersion={row.manifestVersion} />
    </div>
  )
}

function DefaultCell({ row }: { row: ExtensionRow }) {
  const { t } = useTranslation()
  const setDefault = useExtensionsStore((s) => s.setDefault)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Switch
            checked={row.isDefault}
            onCheckedChange={(checked) => void setDefault(row.id, checked)}
            aria-label={t('extensionsPage.defaultHint')}
            data-testid="extension-default"
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>{t('extensionsPage.defaultHint')}</TooltipContent>
    </Tooltip>
  )
}

function ConfigCell({ row }: { row: ExtensionRow }) {
  const { t } = useTranslation()
  const openExtensionConfig = useUiStore((s) => s.openExtensionConfig)
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1 text-sm" data-testid="extension-config-summary">
        <p className="truncate text-muted-foreground">{t(`extensionsPage.configModes.${row.applyMode}`)}</p>
      </div>
      <Button
        variant="outline"
        size="xs"
        onClick={() => openExtensionConfig(row.id)}
        data-testid="extension-configure"
      >
        <Settings2 />
        {t('extensionsPage.configure')}
      </Button>
    </div>
  )
}

function UsageCell({ row }: { row: ExtensionRow }) {
  const { t } = useTranslation()
  if (row.usage === 0)
    return <span className="truncate text-sm text-muted-foreground">{t('common.none')}</span>
  return (
    <span className="truncate text-sm tabular-nums" data-testid="extension-usage">
      {t('extensionsPage.profilesCount', { count: row.usage })}
    </span>
  )
}

function ActionsCell({ row }: { row: ExtensionRow }) {
  const { t } = useTranslation()
  const busy = useExtensionsStore((s) => Boolean(s.busy[row.id]))
  const refresh = useExtensionsStore((s) => s.refresh)
  const replace = useExtensionsStore((s) => s.replace)
  const assignAll = useExtensionsStore((s) => s.assignAll)
  const remove = useExtensionsStore((s) => s.remove)
  const openExtensionConfig = useUiStore((s) => s.openExtensionConfig)
  const builtin = isBuiltinExtension(row)

  const copyId = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(row.id)
      toast.success(t('extensionToasts.idCopied'), { description: row.id })
    } catch (error) {
      toastError(error)
    }
  }

  if (busy) return <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('extensionsPage.columns.menu')}
          data-testid="extension-menu"
        >
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem onSelect={() => openExtensionConfig(row.id)}>
          <Settings2 />
          {t('extensionsPage.configure')}
        </DropdownMenuItem>
        {row.source === 'webstore' ? (
          <DropdownMenuItem onSelect={() => void refresh(row.id)} data-testid="extension-menu-refresh">
            <RefreshCw />
            {t('extensionsPage.refresh')}
          </DropdownMenuItem>
        ) : !builtin ? (
          <>
            <DropdownMenuItem onSelect={() => void replace(row.id, 'archive')}>
              <FileArchive />
              {t('extensionsPage.replaceArchive')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void replace(row.id, 'folder')}>
              <FolderOpen />
              {t('extensionsPage.replaceFolder')}
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void assignAll(row.id, true)} data-testid="extension-menu-add-all">
          <ListPlus />
          {t('extensionsPage.addToAll')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => void assignAll(row.id, false)}
          data-testid="extension-menu-remove-all"
        >
          <ListX />
          {t('extensionsPage.removeFromAll')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copyId()}>
          <Copy />
          {t('extensionsPage.copyId')}
        </DropdownMenuItem>
        {/* A Facet vem com o app: desliga-se por perfil ou como padrão, não se exclui. */}
        {!builtin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => void remove(row.id)}
              data-testid="extension-menu-delete"
            >
              <Trash2 />
              {t('common.delete')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SourceCell({ row }: { row: ExtensionRow }) {
  const { t } = useTranslation()
  const label = t(`extensionsPage.sources.${row.source}`)
  return (
    <span className="truncate text-sm text-muted-foreground" title={label} data-testid="extension-source">
      {label}
    </span>
  )
}

export const extensionColumns: ColumnDef<ExtensionRow>[] = [
  {
    id: 'extension',
    accessorFn: (row) => row.name,
    sortingFn: (a, b) => naturalCompare(a.original.name, b.original.name),
    header: ({ column }) => <ColumnHeader column={column} labelKey="extensionsPage.columns.extension" />,
    cell: ({ row }) => <NameCell row={row.original} />,
  },
  {
    id: 'version',
    accessorFn: (row) => row.version,
    sortingFn: (a, b) => naturalCompare(a.original.version, b.original.version),
    header: ({ column }) => <ColumnHeader column={column} labelKey="extensionsPage.columns.version" />,
    cell: ({ row }) => <VersionCell row={row.original} />,
  },
  {
    id: 'source',
    accessorFn: (row) => row.source,
    header: ({ column }) => <ColumnHeader column={column} labelKey="extensionsPage.columns.source" />,
    cell: ({ row }) => <SourceCell row={row.original} />,
  },
  {
    id: 'default',
    accessorFn: (row) => (row.isDefault ? 0 : 1),
    header: ({ column }) => <ColumnHeader column={column} labelKey="extensionsPage.columns.default" />,
    cell: ({ row }) => <DefaultCell row={row.original} />,
  },
  {
    id: 'config',
    enableSorting: false,
    header: ({ column }) => <ColumnHeader column={column} labelKey="extensionsPage.columns.config" />,
    cell: ({ row }) => <ConfigCell row={row.original} />,
  },
  {
    id: 'profiles',
    accessorFn: (row) => row.usage,
    header: ({ column }) => <ColumnHeader column={column} labelKey="extensionsPage.columns.profiles" />,
    cell: ({ row }) => <UsageCell row={row.original} />,
  },
  {
    id: 'actions',
    enableSorting: false,
    header: () => null,
    cell: ({ row }) => <ActionsCell row={row.original} />,
  },
]
