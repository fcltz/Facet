# Arquitetura do Facet Browsers Antidetect

## Processos e fronteiras

| Área                        | Responsabilidade                                                               |
| --------------------------- | ------------------------------------------------------------------------------ |
| `src/main`                  | SQLite, arquivos, segredos, proxies, extensões e ciclo de vida dos navegadores |
| `src/preload`               | Ponte restrita de comunicação; só canais declarados são expostos               |
| `src/renderer`              | React, traduções, formulários, tabela e Zustand                                |
| `src/shared`                | Schemas Zod, tipos, contratos IPC, constantes e dados de fingerprint           |
| `drizzle`                   | Migrations aplicadas antes de abrir a interface                                |
| `native/win-helper`         | Barra de tarefas do Windows e consultas de processos (sem PowerShell)          |
| `resources/facet-extension` | Extensão integrada e recursos de bloqueio de terceiros                         |
| `scripts`                   | Preparação de ícones, binários, navegador e listas de bloqueio                 |
| `tests`                     | Testes unitários, integrações e cenários de interface                          |

O renderer usa `contextIsolation` e sandbox, sem integração Node.js. O preload oferece chamadas e eventos tipados. O processo principal valida origem, canal e entrada; as respostas usam envelopes de sucesso/erro.

## Dados locais

O diretório padrão no Windows é `%APPDATA%\Facet`, preservado nas mudanças da marca. `FACET_USER_DATA_DIR` substitui a raiz para ambientes isolados.

```text
Facet/
├── data/facet.sqlite       # perfis, proxies, grupos, tags, configurações e sessões
├── profiles/<id>/         # dados de navegação de cada perfil
├── extensions/            # biblioteca de extensões por versão
├── identity/              # recursos de identificação dos perfis
├── backups/               # destino padrão dos backups
├── logs/                  # logs locais
└── tmp/                   # montagem/importação de pacotes
```

A raiz dos perfis pode ser movida pelo app. Movimentação e restauração usam registros de progresso para retomar após interrupções. Não mova bancos ou diretórios enquanto o aplicativo estiver aberto.

SQLite usa WAL, chaves estrangeiras e transações. Configurações antigas em JSON são importadas uma vez. Instalações existentes são reconhecidas na migração de boas-vindas, sem perder preferências.

## Navegadores

Cada perfil inicia o navegador escolhido com sua própria pasta. A porta CDP é atribuída pelo sistema; o Facet acompanha início, encerramento, cancelamento e reconexão.

Abertura de um perfil:

1. Com proxy, uma checagem só pelo proxy local do perfil: IP de saída, comparação com o IP real (consultado ao mesmo tempo) e geolocalização, que vem do cache quando o IP é o mesmo da última checagem, inclusive a gravada no banco antes de reiniciar o app.
2. O navegador abre com uma aba em branco. `--test-type` tira dela a barra "flag não suportada" que `--disable-blink-features=AutomationControlled` traria; `navigator.webdriver` continua falso.
3. O Facet aplica o fingerprint nessa aba e a navega para a primeira URL; as demais abrem em abas novas. A URL não vai na linha de comando: a primeira requisição sairia antes do fingerprint, com User-Agent e Client Hints verdadeiros.
4. O perfil conta como aberto assim que a página é pedida, sem esperar o site responder. O log registra a duração de cada fase.

O utilitário nativo (`native/win-helper`, só no Windows) marca a janela na barra de tarefas no instante em que o navegador a cria, antes de aparecer, e responde as consultas de processos de abrir, fechar e recuperar perfis. O PowerShell, usado quando o utilitário falta ou falha, leva segundos por consulta.

O Ungoogled Chromium é baixado de uma versão fixada e verificado por SHA-256. Chrome, Brave e Opera são detectados, com opção de caminho manual. Sondagens usam diretórios temporários.

Cookies entre aberturas: o Ungoogled Chromium bloqueia cookies de terceiros por padrão, e o Chrome só na janela anônima. Sem uma escolha do usuário gravada no perfil, o Facet usa o padrão do Chrome (`profile.cookie_controls_mode = 2`), para logins e widgets em iframes de outro site não perderem a sessão. No Ungoogled, o perfil também abre com `--restore-last-session`, e os cookies de sessão continuam valendo; as abas antigas não voltam porque a sessão nativa é apagada antes. No Chrome e no Brave, os cookies de sessão seguem o padrão de fábrica (apagados ao abrir); o Opera já os mantém.

No Chrome, extensões são carregadas pelo canal de depuração; quando esse canal fecha abruptamente, o Chrome com extensões também fecha. Os demais navegadores usam carregamento por flags quando suportado.

## Proxies e consultas externas

O Chromium não recebe usuário e senha na flag de proxy. Um proxy local em `127.0.0.1` encaminha conexões ao remoto autenticado. HTTP, HTTPS e SOCKS5 são suportados.

- O proxy local registra bytes enviados/recebidos para exibir taxa e consumo da sessão.
- As consultas do IP e da geolocalização do proxy passam pela cadeia do próprio proxy.
- Geo-IP automático usa os provedores implementados com fallback.
- A proteção contra proxy que usa a conexão direta compara o IP de saída com consultas ao IP real da máquina. Essas consultas diretas fazem parte dessa checagem específica.
- Downloads de dependências, navegador incluído e extensões da loja usam rede.

Senhas de proxy e tokens usam `safeStorage` no processo principal. Os dados de navegação são geridos pelo navegador; isso não torna todo o diretório de perfis um arquivo cifrado portável.

## Extensão Facet

A extensão integrada mantém um ID estável. É instalada por padrão e atualizada quando sua versão muda, preservando escolhas do usuário.

- Regras de rede e seletores cosméticos vêm das listas incluídas; fontes e licenças em [NOTICE.txt](../resources/facet-extension/NOTICE.txt).
- O indicador consulta a Cloudflare para IP/latência e uma amostra de download para velocidade.
- O gasto vem do proxy local em `usage.facet.test`; não há consumo de proxy em perfis sem proxy.
- Uma regra de sessão evita que as listas bloqueiem as consultas de diagnóstico do service worker.
- Popup e indicador têm português, inglês e espanhol.

Os controles avançados de geo-IP, abas iniciais de extensões e identificação foram retirados de Configurações. Valores persistidos e serviços permanecem compatíveis com instalações anteriores.

## Fingerprint

Os modos Nativo e Emulação usam capacidades observadas do navegador e configurações via CDP. Perfis emulados podem representar desktop ou celular, com escolhas de tela, hardware, idioma, fuso e localização.

A emulação não troca Chromium por Safari nem instala as fontes de outro sistema. Proteções e ruído nativo variam por navegador; não existe garantia de indetectabilidade.

## Builds e verificação

- `npm ci` usa o lockfile. `.npmrc` impede scripts de instalação automáticos das dependências.
- `dev`, `pack`, `dist`, `start` e `test:e2e` preparam explicitamente os binários necessários.
- `build` compila código e recursos locais, sem baixar o navegador.
- `pack` gera `release/win-unpacked`; `dist` gera o instalador NSIS.
- Testes usam dados fictícios e diretórios isolados; integrações podem abrir navegadores em perfis temporários.
- `docs:images` regenera as capturas do README (`docs/images`, temas claro e escuro) com dados fictícios em `.tmp-docs`, pelo `playwright.docs.config.ts`.

`node_modules`, `vendor`, `out`, `release`, resultados dos testes e o `_metadata` que o Chromium grava ao carregar a extensão descompactada são gerados localmente e não vão para o Git.
