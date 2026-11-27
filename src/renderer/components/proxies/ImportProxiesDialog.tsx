import { useVirtualizer } from '@tanstack/react-virtual'
import { CircleAlert, CircleCheck, Copy, FileUp, LoaderCircle, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LIMITS } from '@shared/constants'
import {
  PROXY_TYPES,
  type ProxyImportLine,
  type ProxyImportPreview,
  type ProxyType,
} from '@shared/schemas/proxy'
import { Field, Notice } from '@renderer/components/common/Field'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Label } from '@renderer/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { Textarea } from '@renderer/components/ui/textarea'
import { tr } from '@renderer/i18n'
import { formatNumber } from '@renderer/lib/format'
import { invoke, toastError } from '@renderer/lib/ipc'
import { cn } from '@renderer/lib/utils'
import { useProxiesStore } from '@renderer/stores/proxies.store'
import { useUiStore } from '@renderer/stores/ui.store'

const TYPE_LABELS: Record<ProxyType, string> = { http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5' }
const FORMATS = [
  'host:port',
  'host:port:user:pass',
  'user:pass@host:port',
  'user:pass:host:port',
  'socks5://user:pass@host:port',
  '[2001:db8::1]:8080:user:pass',
]
const LINE_HEIGHT = 34
const PARSE_DELAY_MS = 300

function LineStatus({ line }: { line: ProxyImportLine }) {
  const { t } = useTranslation()
  if (line.status === 'ok') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-success">
        <CircleCheck className="size-3.5" />
        {line.type ? TYPE_LABELS[line.type] : t('proxyImport.ok')}
      </span>
    )
  }
  const message = tr(`proxyImport.errors.${line.error ?? 'invalidFormat'}`, line.error ?? '')
  if (line.status === 'duplicate') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-warning">
        <Copy className="size-3.5" />
        {message}
      </span>
    )
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-destructive">
      <CircleAlert className="size-3.5" />
      {message}
    </span>
  )
}

function PreviewList({ preview }: { preview: ProxyImportPreview }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: preview.lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 10,
  })
  return (
    <div ref={scrollRef} className="h-56 overflow-auto rounded-lg border" data-testid="import-preview">
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const line = preview.lines[item.index]
          if (!line) return null
          return (
            <div
              key={line.line}
              data-testid="import-line"
              data-status={line.status}
              className={cn(
                'absolute inset-x-0 flex items-center gap-3 border-b border-border/60 px-3 text-sm',
                line.status === 'invalid' && 'bg-destructive/[0.04]',
              )}
              style={{ height: LINE_HEIGHT, transform: `translateY(${item.start}px)` }}
            >
              <span className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                {line.line}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={line.display}>
                {line.display}
              </span>
              <LineStatus line={line} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ImportBody({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const importText = useProxiesStore((s) => s.importText)
  const [text, setText] = useState('')
  const [defaultType, setDefaultType] = useState<ProxyType>('http')
  const [checkAfter, setCheckAfter] = useState(true)
  const [preview, setPreview] = useState<ProxyImportPreview | null>(null)
  const [parsing, setParsing] = useState(false)
  const [importing, setImporting] = useState(false)
  const requestRef = useRef(0)
  const fileRef = useRef<HTMLInputElement>(null)

  // prévia calculada no processo principal (mesmo parser da importação), com atraso curto
  useEffect(() => {
    const request = ++requestRef.current
    if (!text.trim()) {
      setPreview(null)
      setParsing(false)
      return
    }
    setParsing(true)
    const timer = setTimeout(() => {
      invoke('proxies.parseImport', { text, defaultType })
        .then((result) => {
          if (requestRef.current === request) setPreview(result)
        })
        .catch((error: unknown) => {
          if (requestRef.current === request) toastError(error)
        })
        .finally(() => {
          if (requestRef.current === request) setParsing(false)
        })
    }, PARSE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [text, defaultType])

  const loadFile = async (file: File): Promise<void> => {
    if (file.size > LIMITS.proxyImportMaxChars * 4) {
      toastError(new Error(t('proxyImport.fileTooLarge')))
      return
    }
    try {
      const content = await file.text()
      if (content.length > LIMITS.proxyImportMaxChars) {
        toastError(new Error(t('proxyImport.fileTooLarge')))
        return
      }
      setText(content)
    } catch (error) {
      toastError(error)
    }
  }

  const submit = async (): Promise<void> => {
    setImporting(true)
    try {
      await importText(text, defaultType, checkAfter)
      onDone()
    } catch (error) {
      toastError(error)
    } finally {
      setImporting(false)
    }
  }

  const valid = preview?.valid ?? 0
  const ready = !parsing && preview !== null && valid > 0

  return (
    <div className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{t('proxyImport.title')}</DialogTitle>
        <DialogDescription>{t('proxyImport.description')}</DialogDescription>
      </DialogHeader>

      <Field
        label={t('proxyImport.list')}
        htmlFor="proxy-import-text"
        action={
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.csv,.list,text/plain"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void loadFile(file)
              }}
            />
            <Button type="button" variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>
              <FileUp />
              {t('proxyImport.loadFile')}
            </Button>
          </>
        }
      >
        <Textarea
          id="proxy-import-text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={7}
          spellCheck={false}
          autoFocus
          placeholder={FORMATS.join('\n')}
          className="max-h-48 font-mono text-[13px]"
          data-testid="import-text"
        />
      </Field>

      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field label={t('proxyImport.defaultType')} htmlFor="proxy-import-type" className="w-48">
          <Select value={defaultType} onValueChange={(value) => setDefaultType(value as ProxyType)}>
            <SelectTrigger id="proxy-import-type" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROXY_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {TYPE_LABELS[type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="flex h-9 items-center gap-2">
          <Checkbox
            id="proxy-import-check"
            checked={checkAfter}
            onCheckedChange={(value) => setCheckAfter(value === true)}
          />
          <Label htmlFor="proxy-import-check" className="text-sm font-normal">
            {t('proxyImport.checkAfter')}
          </Label>
        </div>
      </div>

      {preview && preview.lines.length > 0 ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" data-testid="import-summary">
            <span className="font-medium text-success">
              {t('proxyImport.valid', { count: preview.valid, value: formatNumber(preview.valid) })}
            </span>
            <span className="text-warning">{t('proxyImport.duplicates', { count: preview.duplicates })}</span>
            <span className="text-destructive">{t('proxyImport.invalid', { count: preview.invalid })}</span>
            {parsing && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />}
          </div>
          <PreviewList preview={preview} />
          {preview.truncated && (
            <Notice tone="warning" icon={<TriangleAlert className="size-4" />}>
              {t('proxyImport.truncated', { max: formatNumber(LIMITS.proxyImportMaxLines) })}
            </Notice>
          )}
        </div>
      ) : (
        <Notice>
          <p>{t('proxyImport.formatsTitle')}</p>
          <ul className="mt-1 grid gap-0.5 font-mono text-xs">
            {FORMATS.map((format) => (
              <li key={format}>{format}</li>
            ))}
          </ul>
          <p className="mt-2">{t('proxyImport.formatsHint')}</p>
        </Notice>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button
          type="button"
          onClick={() => void submit()}
          disabled={!ready || importing}
          data-testid="import-submit"
        >
          {importing && <LoaderCircle className="animate-spin" />}
          {t('proxyImport.submit', { count: valid, value: formatNumber(valid) })}
        </Button>
      </DialogFooter>
    </div>
  )
}

/** Importação em massa: cola uma lista (ou carrega um .txt), confere linha por linha e importa. */
export function ImportProxiesDialog() {
  const open = useUiStore((s) => s.proxyImportOpen)
  const setOpen = useUiStore((s) => s.setProxyImportOpen)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-2xl" data-testid="import-dialog">
        {open && <ImportBody onDone={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  )
}
