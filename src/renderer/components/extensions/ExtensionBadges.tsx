import { Puzzle, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  CRITICAL_EXTENSION_WARNINGS,
  permissionWarnings,
  type ExtensionSummary,
} from '@shared/schemas/extension'
import { Badge } from '@renderer/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'

/** Ícone da extensão (data URL do manifest) ou um quebra-cabeça. */
export function ExtensionIcon({ icon, className }: { icon: string | null; className?: string }) {
  return (
    <div
      className={cn(
        'flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted/50',
        className,
      )}
    >
      {icon ? (
        <img src={icon} alt="" className="size-6 object-contain" draggable={false} />
      ) : (
        <Puzzle className="size-4 text-muted-foreground" />
      )}
    </div>
  )
}

/** MV3 discreto; MV2 em destaque (o Brave ainda carrega, mas pode deixar de carregar). */
export function ManifestBadge({ manifestVersion }: { manifestVersion: number }) {
  const { t } = useTranslation()
  if (manifestVersion !== 2) {
    return (
      <Badge variant="outline" className="px-1.5 text-[10px] text-muted-foreground">
        MV{manifestVersion}
      </Badge>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="border-warning/50 bg-warning/10 px-1.5 text-[10px] text-warning">
          MV2
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{t('extensionsPage.mv2Hint')}</TooltipContent>
    </Tooltip>
  )
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

/**
 * Na biblioteca (sem coluna de permissões): só o alerta das permissões que desfazem garantias
 * do Facet ("proxy" e "privacy"), ao lado do nome. As demais aparecem na aba Extensões do perfil.
 */
export function CriticalPermissionIcon({
  extension,
}: {
  extension: Pick<ExtensionSummary, 'permissions' | 'source'>
}) {
  const { t } = useTranslation()
  const critical = permissionWarnings(extension).filter((warning) =>
    CRITICAL_EXTENSION_WARNINGS.includes(warning),
  )
  if (critical.length === 0) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex shrink-0 text-warning"
          role="img"
          aria-label={critical.map((warning) => t(`extensionWarnings.${warning}`)).join(', ')}
          data-testid="extension-critical-warning"
          data-warnings={critical.join(' ')}
        >
          <ShieldAlert className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {critical.map((warning) => (
          <p key={warning}>{t(`extensionWarningHints.${warning}`)}</p>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Avisos de permissão. "proxy" e "privacy" ficam em destaque: podem desfazer o proxy
 * do perfil e a proteção de WebRTC. As demais aparecem como informação.
 */
export function PermissionBadges({
  extension,
}: {
  extension: Pick<ExtensionSummary, 'permissions' | 'source'>
}) {
  const { t } = useTranslation()
  const warnings = permissionWarnings(extension)
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {warnings.map((warning) => {
        const critical = CRITICAL_EXTENSION_WARNINGS.includes(warning)
        return (
          <Tooltip key={warning}>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                data-testid={`extension-warning-${warning}`}
                className={cn(
                  'gap-1 px-1.5 text-[11px]',
                  critical
                    ? 'border-warning/50 bg-warning/10 text-warning'
                    : 'border-border text-muted-foreground',
                )}
              >
                {critical && <ShieldAlert className="size-3" />}
                {t(`extensionWarnings.${warning}`)}
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{t(`extensionWarningHints.${warning}`)}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
