import { LoaderCircle, RefreshCcwDot } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProxySummary } from '@shared/schemas/proxy'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useProxiesStore } from '@renderer/stores/proxies.store'

/**
 * "Trocar IP" de um proxy rotativo: chama a URL do provedor, verifica o IP novo
 * e derruba as conexões abertas dos perfis que usam o proxy (sem reiniciá-los).
 */
export function RotateIpButton({
  proxy,
  iconOnly = false,
  variant = 'outline',
}: {
  proxy: Pick<ProxySummary, 'id' | 'rotating' | 'changeIpHost'>
  iconOnly?: boolean
  variant?: 'outline' | 'ghost'
}) {
  const { t } = useTranslation()
  const busy = useProxiesStore((s) => Boolean(s.rotating[proxy.id]))
  const rotate = useProxiesStore((s) => s.rotate)
  if (!proxy.rotating) return null
  const hint = t('proxies.rotateHint', { host: proxy.changeIpHost ?? '?' })
  const icon = busy ? <LoaderCircle className="animate-spin" /> : <RefreshCcwDot />
  const button = (
    <Button
      type="button"
      variant={variant}
      size={iconOnly ? 'icon-sm' : 'sm'}
      disabled={busy}
      onClick={() => void rotate(proxy.id)}
      aria-label={iconOnly ? t('proxies.rotate') : undefined}
      data-testid="rotate-ip"
    >
      {icon}
      {!iconOnly && (busy ? t('proxies.rotating') : t('proxies.rotate'))}
    </Button>
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {iconOnly ? `${t('proxies.rotate')}: ${hint}` : hint}
      </TooltipContent>
    </Tooltip>
  )
}
