/**
 * Idiomas plausíveis para um navegador no país do IP. A base vem dos "likely
 * subtags" do CLDR embutidos no ICU (`Intl.Locale#maximize`): BR → pt-BR,
 * DE → de-DE, JP → ja-JP. Algumas exceções corrigem casos em que o idioma
 * dominante nos navegadores difere do idioma mais provável do país.
 */
const BROWSER_LOCALE_OVERRIDES: Record<string, string> = {
  IN: 'en-IN',
  PH: 'en-PH',
  PK: 'en-PK',
  KE: 'en-KE',
}

/** `[pt-BR, pt, en-US, en]`; para países de língua inglesa, `[en-GB, en]`. `null` se o código for inválido. */
export function languagesForCountry(countryCode: string | null | undefined): string[] | null {
  const code = countryCode?.toUpperCase()
  if (!code || !/^[A-Z]{2}$/.test(code)) return null
  let locale = BROWSER_LOCALE_OVERRIDES[code]
  if (!locale) {
    try {
      const likely = new Intl.Locale('und', { region: code }).maximize()
      if (!likely.language || likely.language === 'und') return null
      locale = `${likely.language}-${code}`
    } catch {
      return null
    }
  }
  const language = locale.split('-')[0] ?? 'en'
  const list = language === 'en' ? [locale, 'en'] : [locale, language, 'en-US', 'en']
  return [...new Set(list)]
}

/**
 * Lista de idiomas no formato do navegador a partir das preferências do sistema:
 * `['pt-BR', 'en-US']` → `['pt-BR', 'pt', 'en-US', 'en']`. Etiquetas inválidas
 * são ignoradas; sem nenhuma válida, `['en-US', 'en']`.
 */
export function acceptLanguagesFrom(tags: readonly string[]): string[] {
  const list: string[] = []
  for (const tag of tags) {
    let locale: Intl.Locale
    try {
      locale = new Intl.Locale(tag.replace(/_/g, '-'))
    } catch {
      continue
    }
    const full = locale.region ? `${locale.language}-${locale.region}` : locale.language
    if (!/^[a-z]{2,3}(-[A-Z]{2}|-\d{3})?$/.test(full)) continue
    list.push(full, locale.language)
  }
  const unique = [...new Set(list)]
  return unique.length > 0 ? unique : ['en-US', 'en']
}
