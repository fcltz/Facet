import { zodResolver } from '@hookform/resolvers/zod'
import { CircleCheck, CircleX, Eye, EyeOff, LoaderCircle, PlugZap, ShieldAlert } from 'lucide-react'
import { useEffect, useState, type ClipboardEvent } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { z } from 'zod'
import { AppError, isValidationIssueList } from '@shared/ipc/result'
import { parsePastedProxy } from '@shared/proxy/parser'
import {
  PROXY_TYPES,
  proxyCreateSchema,
  type PasswordChange,
  type ProxyCheckOutcome,
  type ProxySummary,
  type ProxyType,
  type ProxyUpdateInput,
} from '@shared/schemas/proxy'
import { Field } from '@renderer/components/common/Field'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { Textarea } from '@renderer/components/ui/textarea'
import { countryName } from '@renderer/lib/format'
import { describeError, invoke, toastError } from '@renderer/lib/ipc'
import { cn } from '@renderer/lib/utils'
import { useCatalogStore } from '@renderer/stores/catalog.store'
import { useProfilesStore } from '@renderer/stores/profiles.store'
import { useProxiesStore } from '@renderer/stores/proxies.store'
import { useUiStore } from '@renderer/stores/ui.store'

type FormInput = z.input<typeof proxyCreateSchema>
type FormOutput = z.output<typeof proxyCreateSchema>
type FormField = keyof FormInput

const FORM_FIELDS: readonly FormField[] = [
  'name',
  'type',
  'host',
  'port',
  'username',
  'password',
  'changeIpUrl',
  'notes',
]

const TYPE_LABELS: Record<ProxyType, string> = { http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5' }

/**
 * Senha na edição: `loading` enquanto a senha salva é buscada; `ready` = ela está no campo
 * (mascarada) e o campo vazio remove a senha; `unavailable` = não foi possível exibi-la (vazio
 * mantém a salva); `none` = proxy novo ou sem senha salva.
 */
type PasswordState = 'none' | 'loading' | 'ready' | 'unavailable'

function defaults(proxy: ProxySummary | null): FormInput {
  return {
    name: proxy?.name ?? '',
    type: proxy?.type ?? 'http',
    host: proxy?.host ?? '',
    port: proxy?.port ?? Number.NaN,
    username: proxy?.username ?? '',
    password: '',
    changeIpUrl: '',
    notes: proxy?.notes ?? '',
  }
}

function TestResult({ outcome, error }: { outcome: ProxyCheckOutcome | null; error: string | null }) {
  const { t } = useTranslation()
  if (error) {
    return (
      <div
        className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
        role="status"
      >
        <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" />
        <span>{error}</span>
      </div>
    )
  }
  if (!outcome) return null
  if (outcome.status === 'offline' && outcome.error?.code === 'PROXY_REAL_IP') {
    const location = [outcome.city, countryName(outcome.countryCode)].filter(Boolean).join(', ')
    return (
      <div
        className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"
        role="status"
        data-testid="proxy-test-result"
        data-status="offline"
        data-reason="real-ip"
      >
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0">
          <p className="font-medium text-destructive">
            {t('proxyForm.testRealIp', { ip: outcome.exitIp ?? '?' })}
          </p>
          <p className="text-muted-foreground">{describeError(AppError.fromPayload(outcome.error))}</p>
          {location && <p className="text-xs text-muted-foreground">{location}</p>}
        </div>
      </div>
    )
  }
  if (outcome.status === 'offline') {
    return (
      <div
        className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
        role="status"
        data-testid="proxy-test-result"
        data-status="offline"
      >
        <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div>
          <p className="font-medium">{t('proxyForm.testOffline')}</p>
          {outcome.error && (
            <p className="text-muted-foreground">{describeError(AppError.fromPayload(outcome.error))}</p>
          )}
        </div>
      </div>
    )
  }
  const location = [outcome.city, countryName(outcome.countryCode)].filter(Boolean).join(', ')
  return (
    <div
      className="flex gap-2 rounded-lg border border-success/30 bg-success/5 p-3 text-sm"
      role="status"
      data-testid="proxy-test-result"
      data-status="online"
    >
      <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
      <div className="min-w-0">
        <p className="font-medium">
          {t('proxyForm.testOnline', { ip: outcome.exitIp ?? '?' })}
          {outcome.latencyMs !== null && ` · ${t('profiles.latency', { ms: outcome.latencyMs })}`}
        </p>
        <p className="text-muted-foreground">
          {[location, outcome.timezone].filter(Boolean).join(' · ') || t('proxyForm.testNoGeo')}
        </p>
      </div>
    </div>
  )
}

function ProxyForm({ proxy, onDone }: { proxy: ProxySummary | null; onDone: () => void }) {
  const { t } = useTranslation()
  const create = useProxiesStore((s) => s.create)
  const update = useProxiesStore((s) => s.update)
  const testDraft = useProxiesStore((s) => s.testDraft)
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(proxyCreateSchema),
    defaultValues: defaults(proxy),
    mode: 'onTouched',
  })
  const { errors, isSubmitting } = form.formState
  const [showPassword, setShowPassword] = useState(false)
  const [passwordState, setPasswordState] = useState<PasswordState>(proxy?.hasPassword ? 'loading' : 'none')
  const [savedPassword, setSavedPassword] = useState<string | null>(null)
  /** Edição de proxy rotativo: manter, substituir ou remover a URL de troca de IP. */
  const [urlMode, setUrlMode] = useState<'keep' | 'replace' | 'clear'>(proxy?.rotating ? 'keep' : 'replace')
  const [testing, setTesting] = useState(false)
  const [outcome, setOutcome] = useState<ProxyCheckOutcome | null>(null)
  const [testError, setTestError] = useState<string | null>(null)

  // A senha salva vem do processo principal só para este formulário e fica mascarada no campo.
  const proxyId = proxy?.id
  const hasPassword = proxy?.hasPassword ?? false
  useEffect(() => {
    if (!proxyId || !hasPassword) return
    let alive = true
    invoke('proxies.getPassword', { id: proxyId })
      .then(({ password }) => {
        if (!alive) return
        setSavedPassword(password)
        // um proxy colado enquanto carregava já trouxe a senha nova
        if (!form.getFieldState('password').isDirty) form.setValue('password', password ?? '')
        setPasswordState('ready')
      })
      .catch(() => {
        if (alive) setPasswordState('unavailable')
      })
    return () => {
      alive = false
    }
  }, [proxyId, hasPassword, form])

  const passwordChange = (value: string): PasswordChange => {
    if (passwordState === 'ready') {
      if (value === (savedPassword ?? '')) return { mode: 'keep' }
      return value ? { mode: 'set', value } : { mode: 'clear' }
    }
    // proxy novo, sem senha salva ou senha salva ilegível: vazio mantém, texto troca
    return value ? { mode: 'set', value } : { mode: 'keep' }
  }

  /** Proxy completo colado num campo de conexão: separa e preenche tudo de uma vez. */
  const pasteProxy =
    (field: 'address' | 'credential') =>
    (event: ClipboardEvent<HTMLInputElement>): void => {
      const pasted = parsePastedProxy(event.clipboardData.getData('text'), form.getValues('type'), field)
      if (!pasted) return
      event.preventDefault()
      const options = { shouldDirty: true, shouldTouch: true, shouldValidate: true }
      const { proxy: parsed } = pasted
      if (pasted.typed) form.setValue('type', parsed.type, options)
      form.setValue('host', parsed.host, options)
      form.setValue('port', parsed.port, options)
      // "host:porta" sozinho não apaga usuário e senha já digitados
      if (parsed.username || parsed.password) {
        form.setValue('username', parsed.username, options)
        form.setValue('password', parsed.password, options)
      }
      toast.success(t(pasted.typed ? 'proxyForm.pastedTyped' : 'proxyForm.pasted'))
    }

  const applyServerError = (error: unknown): void => {
    const reason =
      error instanceof AppError ? (error.details as { reason?: string } | undefined)?.reason : undefined
    if (error instanceof AppError && error.code === 'CONFLICT' && reason === 'duplicateEndpoint') {
      form.setError('host', { message: 'duplicateEndpoint' })
      return
    }
    if (
      error instanceof AppError &&
      error.code === 'VALIDATION_ERROR' &&
      isValidationIssueList(error.details)
    ) {
      let placed = false
      for (const issue of error.details) {
        const field = issue.path.split('.').pop() as FormField | undefined
        if (field && FORM_FIELDS.includes(field)) {
          form.setError(field, { message: issue.message })
          placed = true
        }
      }
      if (placed) return
    }
    toastError(error)
  }

  const test = async (): Promise<void> => {
    if (!(await form.trigger(['type', 'host', 'port', 'username', 'password']))) return
    const values = form.getValues()
    setTesting(true)
    setOutcome(null)
    setTestError(null)
    try {
      setOutcome(
        await testDraft({
          id: proxy?.id ?? null,
          type: values.type,
          host: values.host,
          port: values.port,
          username: values.username,
          password: passwordChange(values.password),
        }),
      )
    } catch (error) {
      setTestError(describeError(error))
    } finally {
      setTesting(false)
    }
  }

  const submit = form.handleSubmit(async (values) => {
    try {
      if (!proxy) {
        await create(values)
        onDone()
        return
      }
      const patch: ProxyUpdateInput['patch'] = {}
      if ((values.name || null) !== proxy.name) patch.name = values.name
      if (values.type !== proxy.type) patch.type = values.type
      if (values.host.toLowerCase() !== proxy.host) patch.host = values.host
      if (values.port !== proxy.port) patch.port = values.port
      if (values.username !== proxy.username) patch.username = values.username
      if (values.notes !== proxy.notes) patch.notes = values.notes
      const password = passwordChange(values.password)
      if (password.mode !== 'keep') patch.password = password
      if (urlMode === 'clear') patch.changeIpUrl = { mode: 'clear' }
      else if (urlMode === 'replace' && values.changeIpUrl) {
        patch.changeIpUrl = { mode: 'set', value: values.changeIpUrl }
      }
      await update(proxy.id, patch)
      onDone()
      // o perfil aberto continua no destino antigo até reiniciar (o destino é fixado na abertura)
      const connectionChanged =
        patch.type !== undefined ||
        patch.host !== undefined ||
        patch.port !== undefined ||
        patch.username !== undefined ||
        patch.password !== undefined
      if (connectionChanged) {
        const { byId, statuses } = useProfilesStore.getState()
        const running = Object.values(byId)
          .filter((profile) => profile.proxyId === proxy.id)
          .filter((profile) => {
            const status = statuses[profile.id]
            return status !== undefined && status !== 'error'
          })
          .map((profile) => profile.id)
        if (running.length > 0) useUiStore.getState().openRestartPrompt(running)
      }
    } catch (error) {
      applyServerError(error)
    }
  })

  const passwordValue = form.watch('password')
  const passwordPlaceholder =
    passwordState === 'loading'
      ? t('common.loading')
      : passwordState === 'unavailable'
        ? t('proxyForm.passwordUnavailable')
        : t('proxyForm.passwordPlaceholder')
  const passwordWillClear = passwordState === 'ready' && Boolean(savedPassword) && !passwordValue

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-5" noValidate>
      <DialogHeader>
        <DialogTitle>{proxy ? t('proxyForm.editTitle') : t('proxyForm.createTitle')}</DialogTitle>
        <DialogDescription>{t('proxyForm.description')}</DialogDescription>
      </DialogHeader>

      <div className="grid grid-cols-[132px_minmax(0,1fr)_112px] gap-3">
        <Field label={t('proxyForm.type')} htmlFor="proxy-type">
          <Controller
            control={form.control}
            name="type"
            render={({ field }) => (
              <Select value={field.value} onValueChange={(value) => field.onChange(value as ProxyType)}>
                <SelectTrigger id="proxy-type" className="w-full" data-testid="proxy-form-type">
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
            )}
          />
        </Field>
        <Field label={t('proxyForm.host')} htmlFor="proxy-host" error={errors.host?.message}>
          <Input
            id="proxy-host"
            autoFocus={!proxy}
            autoComplete="off"
            spellCheck={false}
            placeholder="proxy.exemplo.com"
            className="font-mono"
            {...form.register('host')}
            onPaste={pasteProxy('address')}
            data-testid="proxy-form-host"
          />
        </Field>
        <Field label={t('proxyForm.port')} htmlFor="proxy-port" error={errors.port?.message}>
          <Input
            id="proxy-port"
            type="number"
            inputMode="numeric"
            min={1}
            max={65535}
            placeholder="8080"
            className="font-mono"
            {...form.register('port', { valueAsNumber: true })}
            onPaste={pasteProxy('address')}
            data-testid="proxy-form-port"
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field
          label={t('proxyForm.username')}
          htmlFor="proxy-username"
          optional
          error={errors.username?.message}
        >
          <Input
            id="proxy-username"
            autoComplete="off"
            spellCheck={false}
            {...form.register('username')}
            onPaste={pasteProxy('credential')}
            data-testid="proxy-form-username"
          />
        </Field>
        <Field
          label={t('proxyForm.password')}
          htmlFor="proxy-password"
          optional
          error={errors.password?.message}
          hint={passwordWillClear ? t('proxyForm.passwordWillClear') : undefined}
        >
          <div className="relative">
            <Input
              id="proxy-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              spellCheck={false}
              disabled={passwordState === 'loading'}
              placeholder={passwordPlaceholder}
              className="pr-9"
              {...form.register('password')}
              onPaste={pasteProxy('credential')}
              data-testid="proxy-form-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={showPassword ? t('proxyForm.hidePassword') : t('proxyForm.showPassword')}
              className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {showPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </div>
        </Field>
      </div>

      <Field label={t('proxyForm.name')} htmlFor="proxy-name" optional error={errors.name?.message}>
        <Input
          id="proxy-name"
          autoComplete="off"
          placeholder={t('proxyForm.namePlaceholder')}
          {...form.register('name')}
          data-testid="proxy-form-name"
        />
      </Field>

      <Field
        label={t('proxyForm.changeIpUrl')}
        htmlFor="proxy-change-url"
        optional
        error={errors.changeIpUrl?.message}
        hint={t('proxyForm.changeIpUrlHint')}
        action={
          proxy?.rotating && urlMode !== 'keep' ? (
            <button
              type="button"
              className="text-xs font-medium text-primary hover:underline"
              onClick={() => {
                setUrlMode('keep')
                form.setValue('changeIpUrl', '')
              }}
            >
              {t('common.undo')}
            </button>
          ) : undefined
        }
      >
        {proxy?.rotating && urlMode !== 'replace' ? (
          <div className="flex h-9 items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 text-sm">
            <span className={cn('truncate', urlMode === 'clear' && 'text-muted-foreground line-through')}>
              {t('proxyForm.changeIpUrlSaved', { host: proxy.changeIpHost ?? '?' })}
            </span>
            {urlMode === 'keep' && (
              <span className="flex shrink-0 gap-3">
                <button
                  type="button"
                  className="text-xs font-medium text-primary hover:underline"
                  onClick={() => setUrlMode('replace')}
                >
                  {t('proxyForm.replace')}
                </button>
                <button
                  type="button"
                  className="text-xs font-medium text-destructive hover:underline"
                  onClick={() => setUrlMode('clear')}
                >
                  {t('common.remove')}
                </button>
              </span>
            )}
          </div>
        ) : (
          <Input
            id="proxy-change-url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://api.provedor.com/troca?key=…"
            className="font-mono text-[13px]"
            {...form.register('changeIpUrl')}
            data-testid="proxy-form-change-url"
          />
        )}
      </Field>

      <Field label={t('proxyForm.notes')} htmlFor="proxy-notes" optional error={errors.notes?.message}>
        <Textarea id="proxy-notes" rows={2} {...form.register('notes')} />
      </Field>

      <TestResult outcome={outcome} error={testError} />

      <DialogFooter className="sm:justify-between">
        <Button
          type="button"
          variant="outline"
          onClick={() => void test()}
          disabled={testing || isSubmitting}
          data-testid="proxy-form-test"
        >
          {testing ? <LoaderCircle className="animate-spin" /> : <PlugZap />}
          {testing ? t('proxyForm.testing') : t('proxyForm.test')}
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={isSubmitting} data-testid="proxy-form-submit">
            {isSubmitting && <LoaderCircle className="animate-spin" />}
            {proxy ? t('common.save') : t('proxyForm.create')}
          </Button>
        </div>
      </DialogFooter>
    </form>
  )
}

/** Cadastro e edição de um proxy (aberto pela página Proxies). */
export function ProxyFormDialog() {
  const state = useUiStore((s) => s.proxyEditor)
  const close = useUiStore((s) => s.closeProxyEditor)
  const proxy = useCatalogStore((s) => (state.proxyId ? (s.proxiesById[state.proxyId] ?? null) : null))
  const missing = state.proxyId !== null && proxy === null
  // proxy excluído (em outra tela ou pela importação) enquanto o editor estava aberto
  useEffect(() => {
    if (state.open && missing) close()
  }, [state.open, missing, close])
  return (
    <Dialog open={state.open && !missing} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-xl" data-testid="proxy-form">
        {state.open && !missing && <ProxyForm key={state.proxyId ?? 'new'} proxy={proxy} onDone={close} />}
      </DialogContent>
    </Dialog>
  )
}
