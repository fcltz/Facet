# Facet Browsers Antidetect — orientação para agentes

## Instalação

Para instalar ou atualizar o app no computador de alguém, siga [INSTALL.md](INSTALL.md).

## Alterações de código

- Stack: Electron, React, TypeScript, Vite e SQLite/Drizzle. Consulte [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- Preserve contratos e validação IPC. Não exponha Node.js nem canais arbitrários ao renderer.
- Mantenha os textos da interface em português, inglês e espanhol.
- A marca é **Facet Browsers Antidetect**. `app.facet.desktop`, `Facet.exe` e a pasta de dados `Facet` são identificadores estáveis de compatibilidade.
- Use dados sintéticos e diretórios isolados nos testes, nunca perfis pessoais do navegador.
- Não publique bancos, cookies, credenciais, perfis reais, logs, relatórios temporários, dependências, navegadores baixados ou builds no Git.
- Preserve listas e avisos de licença de terceiros. As chaves TLS em `tests/fixtures/tls` são fixtures públicas, não credenciais de produção.
- Rode `npm run typecheck`, `npm run lint` e testes relevantes. `npm test` inclui navegador real; testes rápidos: `npm run test -- tests/unit`.
- O README existe em português, inglês e espanhol (`README.md`, `README.en.md`, `README.es.md`): mantenha os três iguais. Se mudar uma tela mostrada nele, rode `npm run docs:images`.
- Antes de publicar, confira o conteúdo preparado para commit. Não substitua trabalho remoto com force push.
