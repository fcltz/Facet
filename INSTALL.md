# Instalar o Facet Browsers Antidetect

Guia para pessoas e **agentes de IA** instalarem ou atualizarem o aplicativo no computador de alguém. Repositório: **https://github.com/fcltz/Facet**.

## Resumo para agentes

Windows 10/11 x64, PowerShell, **um comando por linha**, parando no primeiro erro:

```powershell
git --version
node --version
git clone https://github.com/fcltz/Facet.git
cd Facet
npm ci
npm run typecheck
npm run dist
Get-ChildItem .\release\Facet-Setup-*.exe
Get-FileHash .\release\Facet-Setup-*.exe -Algorithm SHA256
```

Depois, com a autorização do usuário, rode o instalador gerado (passo 5) e valide (passo 6).

**Pronto significa:** o instalador existe em `release\`, o Facet abre pelo atalho **Facet Browsers Antidetect**, mostra as boas-vindas numa instalação nova (ou os perfis antigos numa atualização) e um perfil de teste abre e fecha.

## 1. Regras para o agente

**Faça**

- Confirme com o usuário antes de instalar, fechar o Facet ou fechar perfis abertos.
- Preserve **`%APPDATA%\Facet`** e qualquer pasta de perfis escolhida pelo usuário. É lá que ficam perfis, cookies, proxies e configurações; o nome do app mudou, a pasta continua `Facet`.
- Use o backup do próprio Facet (Configurações → Backup) antes de atualizar quando houver dados importantes.
- Trabalhe numa pasta escolhida para o projeto e informe no fim o que foi feito, os caminhos e o que ficou pendente.

**Não faça**

- Não apague nem mova perfis, cookies, senhas, extensões, backups ou o banco para "resolver" um erro.
- Não feche os navegadores pessoais do usuário, não instale outro Chrome, Brave ou Opera e não mexa no registro do Windows. O Facet traz o próprio navegador.
- Não rode instaladores de terceiros para testar e não desative proteções do sistema (SmartScreen, antivírus, validação TLS).
- Não troque versões do lockfile, não rode `npm audit fix --force` e não altere o hash esperado do navegador para aceitar um download.
- Não grave tokens ou senhas em URLs do Git, arquivos ou histórico de comandos. Se o GitHub pedir login, use o acesso normal do usuário.
- Não diga que instalou se apenas compilou o pacote.

## 2. Escolha o caminho

| Objetivo                                        | Caminho                                           |
| ----------------------------------------------- | ------------------------------------------------- |
| Há um instalador confiável em Releases          | Baixe-o, confira o hash publicado e vá ao passo 5 |
| Instalar a partir do código (o caso mais comum) | Passos 3, 4, 5 e 6                                |
| Só testar ou desenvolver, sem instalar          | Passos 3 e 4, depois `npm run dev`                |

Não presuma que existe uma release só porque o repositório existe.

## 3. Pré-requisitos

```powershell
[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
git --version
node --version
npm --version
```

- Arquitetura **X64**, Windows 10 ou 11, com sessão gráfica.
- **Node.js 24.x** com npm. O `package.json` também aceita 22.13+ e 26+.
- **Git**. Se faltar Git ou Node, instale pelo instalador oficial ou pelo gerenciador que o usuário já usa e abra outro terminal.
- Internet na primeira preparação e pelo menos **3 GB livres**.
- O utilitário da barra de tarefas é compilado com o `csc.exe` do .NET Framework 4, que já vem no Windows. O projeto procura em `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe` e `%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe`.
- Não é preciso Visual Studio: o SQLite usa binários N-API prontos.

## 4. Baixe e prepare o código

```powershell
git clone https://github.com/fcltz/Facet.git
cd Facet
npm ci
npm run typecheck
```

**Mantenha o `.npmrc`.** Ele tem `ignore-scripts=true` para o npm não tentar recompilar dependências nativas; os scripts do projeto baixam o que precisam. Para preparar o Electron e o navegador separadamente:

```powershell
npm run ensure-electron
npm run fetch-browser
```

O Ungoogled Chromium é baixado de uma versão fixa e conferido por SHA-256. Se a conferência falhar, pare e avise o usuário.

### Gerar o instalador

```powershell
npm run dist
Get-ChildItem .\release\Facet-Setup-*.exe
Get-FileHash .\release\Facet-Setup-*.exe -Algorithm SHA256
```

O nome segue a versão do `package.json` (hoje `Facet-Setup-0.1.0.exe`). Use o nome que foi gerado.

### Rodar sem instalar

```powershell
npm run pack
.\release\win-unpacked\Facet.exe
```

Mantenha a pasta `win-unpacked` inteira. Ela não é portátil quanto aos dados: também usa `%APPDATA%\Facet`.

## 5. Instale

Com a autorização do usuário, abra o instalador pelo Explorador ou:

```powershell
Start-Process -FilePath (Get-ChildItem .\release\Facet-Setup-*.exe | Select-Object -First 1).FullName -Wait
```

O instalador é por usuário (sem administrador), deixa escolher a pasta, oferece português, inglês e espanhol, cria atalhos e inclui desinstalador. Ele não é assinado digitalmente: o SmartScreen pode avisar, e só o usuário decide seguir.

## 6. Valide

1. Abra **Facet Browsers Antidetect** pelo atalho.
2. Numa instalação nova, as boas-vindas pedem idioma (português, inglês ou espanhol), tema e navegador padrão.
3. Confira que o Ungoogled Chromium aparece disponível; Chrome, Brave e Opera aparecem se estiverem instalados.
4. Crie um perfil de teste, sem contas pessoais, e abra-o. Perfis sem página própria abrem na página inicial das Configurações.
5. Feche o perfil, reinicie o Facet e confira que o perfil e as preferências continuam lá.
6. Numa atualização, confira os perfis anteriores. Se não aparecerem, verifique `%APPDATA%\Facet` antes de criar ou apagar qualquer coisa.

As boas-vindas não reaparecem depois de concluídas. As Configurações não têm mais as seções de API de geo-IP, abas de extensões e identificação dos perfis; isso é esperado.

## 7. Atualize

Com o checkout limpo e apontando para o repositório oficial:

```powershell
git status --short
git pull --ff-only
npm ci
npm run dist
```

Se houver alterações locais, preserve-as; não use `git reset --hard` nem `git clean`. Feche o Facet e instale a versão nova por cima. O identificador `app.facet.desktop`, o executável `Facet.exe` e a pasta `%APPDATA%\Facet` não mudam entre versões. Reabra os perfis para carregarem a extensão Facet atualizada.

## 8. Diagnóstico

| Sintoma                                | O que verificar                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `git`, `node` ou `npm` não encontrados | Instale pelo canal oficial e abra outro terminal.                                             |
| Download bloqueado                     | Conexão, proxy corporativo e acesso ao GitHub e ao npm. Não desative a validação TLS.         |
| Electron ausente                       | `npm run ensure-electron`.                                                                    |
| Ungoogled Chromium ausente             | `npm run fetch-browser`. Para outro navegador, veja Configurações → Navegadores.              |
| `csc.exe` não encontrado               | Verifique o .NET Framework 4 do Windows. Não copie executáveis de fontes desconhecidas.       |
| A segunda janela não abre              | Já há um Facet aberto com os mesmos dados: volte para ele ou feche-o normalmente.             |
| Perfis antigos não aparecem            | Confira `%APPDATA%\Facet` e se `FACET_USER_DATA_DIR` ficou definida. Não sobrescreva o banco. |
| Erro do SQLite no `npm ci`             | Confirme a versão do Node e o `.npmrc`; rode `npm ci` de novo.                                |
| Proxy não conecta                      | Revise os dados do proxy no app. Nunca publique senhas ou cookies num issue.                  |

Os logs ficam em `%APPDATA%\Facet\logs`. Leia só o necessário e remova dados pessoais antes de compartilhar trechos.

## 9. Testes e limpeza

```powershell
npm run typecheck
npm run lint
npm run test -- tests/unit
```

`npm test` inclui integrações com navegadores reais e `npm run test:e2e` abre o Electron com dados separados; as duas suítes levam vários minutos. `FACET_USER_DATA_DIR` isola os dados nos testes: use uma pasta criada para isso e não deixe a variável definida na sessão normal do usuário.

Depois de encerrar os testes, só **dentro do checkout** podem ser apagadas as pastas geradas `.tmp-tests`, `.tmp-e2e`, `.tmp-docs`, `test-results*` e `playwright-report`. Confira o caminho absoluto antes de apagar e nunca confunda essas pastas com `%APPDATA%\Facet` ou com a pasta de perfis do usuário.
