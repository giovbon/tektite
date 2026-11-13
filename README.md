# Tektite (PKM Notes)

Aplicação local de notas Markdown com backend Go, SQLite/FTS5 e interface responsiva. As pastas são caminhos virtuais armazenados no SQLite; o app não cria arquivos `.md` no disco.

## Requisitos

- Go 1.27 ou superior.
- Um compilador C disponível para o `cgo` (o driver SQLite compila o SQLite junto ao binário).

## Executar

Na raiz do projeto:

```sh
./run.sh
```

O script compila o backend com FTS5 e inicia o servidor em `http://localhost:8000`. É possível configurar:

```sh
./run.sh --data-dir ./meus-dados --port 8080
```

`PORT` e `NOTES_DIR` também podem fornecer os valores padrão. O banco fica em `notes.db` dentro do diretório de dados. Na primeira inicialização, o app cria o índice FTS5 e o índice de vínculos entre notas, indexando as notas existentes sem substituir os registros.

Para exigir senha, defina `AUTHENTICATION_PASSWORD` antes de iniciar:

```sh
AUTHENTICATION_PASSWORD='uma-senha-forte' ./run.sh
```

O login protege a interface principal e os endpoints da API, exceto `GET /api/health` e as rotas de login/status/logout. A sessão usa cookie HttpOnly/SameSite Strict, expira em 12 horas e é invalidada quando o servidor reinicia. Após cinco senhas incorretas do mesmo endereço IP, novas tentativas são limitadas por 15 minutos. Sem `AUTHENTICATION_PASSWORD`, o app permanece sem autenticação.

Use uma senha forte e HTTPS quando o app estiver acessível pela rede. Se HTTPS terminar em um proxy reverso, force o atributo Secure do cookie:

```sh
AUTHENTICATION_PASSWORD='uma-senha-forte' AUTHENTICATION_COOKIE_SECURE=true ./run.sh
```

`AUTHENTICATION_COOKIE_SECURE=true` deve ser usado somente quando o navegador acessa o app por HTTPS; caso contrário, o navegador não enviará o cookie.

Antes de iniciar, o script verifica a porta escolhida e encerra uma instância anterior do PKM Notes que esteja escutando nela. Processos de outros aplicativos não são encerrados; nesse caso, escolha outra porta ou encerre o processo manualmente. A verificação requer `lsof` ou `fuser`.

Para ARM64, compile nativamente no dispositivo ou configure um compilador C cruzado para o alvo. Como SQLite usa `cgo`, `GOARCH=arm64` isoladamente não produz um binário executável com o driver.

## Recursos

- Busca paginada por título ou conteúdo, com FTS5.
- Árvore de pastas virtual com notas clicáveis dentro de cada pasta; crie notas e pastas pelos ícones ao lado de “Todas as notas”. Os itens são carregados sob demanda em lotes e podem ser movidos por arrastar e soltar.
- Abrir notas pela árvore ou pelos cards de busca no painel principal, sem janela modal.
- Criar, editar e excluir notas com salvamento automático no SQLite e restauração da pesquisa ao voltar; notas e pastas podem ser reorganizadas pelo explorador lateral.
- Anexos enviados pelo editor ficam em `attachments/<id-da-nota>/` no diretório de dados, sem depender do caminho virtual da nota. O editor oferece upload, download e exclusão, insere links Markdown no conteúdo e pode mostrar imagens raster compatíveis no preview. O limite é 25 MiB por arquivo.
- A API calcula backlinks e relações a partir de links Markdown e wikilinks resolvidos pelo título/caminho virtual das notas. A interface inclui um grafo interativo com filtro por título/pasta, destaque de conexões, zoom, movimento e abertura de notas.
- Ao renomear uma nota, os links de entrada são atualizados: wikilinks (`[[Título]]`, `[[Título|alias]]`, `[[Pasta/Título]]`, `[[Título.md]]`, `[[Título#seção]]`), links Markdown e definições de referência passam a apontar para o novo título, preservando aliases, âncoras e trechos de código. Backlinks e grafo continuam apontando para a nota renomeada.
- O autocomplete de wikilinks sugere notas pelo título e, depois de `#`, os cabeçalhos da nota de destino (`[[Página#`). Também aceita `[[#` para cabeçalhos da própria nota, e os links com âncora abrem a nota já posicionada na seção correspondente.
- Mover uma nota ou uma pasta preserva os links baseados em caminho: destinos relativos são recalculados a partir da nova localização e caminhos absolutos (`/Pasta/Nota`) acompanham a pasta movida, tanto nos links de entrada quanto nos de saída. Links por título e trechos de código permanecem inalterados.
- Editor Markdown próprio, inspirado no fluxo do Basalt, com barra de formatação, atalhos (`Ctrl/Cmd+B`, `I`, `K` e `Ctrl/Cmd+Alt+T` para inserir tabela; `Ctrl/Cmd+Alt+1/2/3` para escolher o modo e `Ctrl/Cmd+Alt+V` para alternar), desfazer/refazer, divisor redimensionável e modos dividido, edição e leitura. O modo edição destaca a sintaxe Markdown e blocos cercados usam Highlight.js (distribuição local, sem dependência de CDN); a leitura também colore o código e mostra o idioma informado na cerca, como ` ```js `.
- Tags são lidas do frontmatter Markdown (`tags: sei-la`, lista YAML ou lista inline); tags legadas são migradas para o frontmatter quando a nota é aberta para edição. As tags aparecem no topo da lista e nos cards, podem ser clicadas para filtrar as notas e a API expõe a contagem de cada tag.
- Duas abas do navegador não sobrescrevem mais uma à outra silenciosamente: o editor envia a versão da nota junto com o salvamento e o servidor responde `409 Conflict` quando outra sessão já alterou o registro.
- Exportação e restauração de backup completo em um único arquivo `.zip`, com notas, pastas, tags, vínculos e anexos.
- Interface adaptada para desktop e mobile; tema claro/escuro.
- Design system em CSS puro, sem etapa de build: tokens em `web/frontend/styles/tokens.css`, base em `base.css`, componentes reutilizáveis em `components.css` e layouts de tela em `views.css`. Os temas claro e escuro, foco, movimento reduzido, tipografia e cores de sintaxe são derivados dos mesmos tokens.
- Paleta de comandos com `Ctrl/Cmd+K` para criar notas, navegar entre telas, alternar o tema, exportar/importar backups e abrir notas por busca instantânea. A paleta também pode ser aberta pelo botão de busca na barra superior.

O preview usa Goldmark no backend. HTML bruto é mantido inativo e destinos com esquemas inseguros em links/imagens são neutralizados.

Títulos de notas não são únicos. Um wikilink por título (`[[Relatório]]`) resolve para a nota de menor ID quando houver mais de uma; para desambiguar, use o caminho virtual (`[[Pasta/Relatório]]`). Renomear uma nota reescreve apenas os links que resolviam para ela.

O servidor envia cabeçalhos de segurança (`Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options` e `Referrer-Policy`), limita o corpo das requisições e registra mutações da API, falhas e requisições lentas no log.

## Dados, anexos e backup

- As notas, pastas vazias e metadados ficam em `notes.db` no diretório de dados. Os caminhos das pastas associadas às notas também são mantidos nas próprias notas. O índice de busca FTS5 e o índice de vínculos (`note_links`) são mantidos no mesmo banco. O grafo e os backlinks são resolvidos a partir desse índice, sem reler o conteúdo de todas as notas a cada consulta.
- Anexos são gravados em `attachments/<id-da-nota>/` no mesmo diretório de dados. O nome físico é aleatório; o nome original e o tipo de mídia ficam nos metadados SQLite. Assim, mover a nota para outra pasta virtual não move nem quebra o arquivo.
- Ao excluir uma nota, seus metadados de anexos são removidos pelo SQLite e os arquivos daquela nota são apagados do disco.
- Use **Configurações → Backup e restauração** para exportar ou importar um `.zip`. A exportação inclui `manifest.json`, cada nota como um arquivo Markdown legível em `notes/` e todos os anexos em `attachments/`. A importação valida o arquivo e substitui notas, pastas, tags e anexos atuais; IDs de notas e anexos são preservados para que os links dentro do conteúdo continuem funcionando. A importação é tudo ou nada: um arquivo inválido não altera os dados existentes.
- Para backup manual, ainda é possível parar o servidor e copiar **o arquivo `notes.db` e a pasta `attachments/` juntos**. Restaurar somente o banco preserva as referências, mas não recupera o conteúdo dos arquivos; restaurar somente os anexos não recupera as notas nem os metadados.
- As pastas exibidas na árvore são virtuais: não são criadas como diretórios no disco. Apenas os anexos usam armazenamento em arquivos.

Ao anexar um arquivo pelo editor, uma imagem raster compatível é inserida como `![nome](URL)` e outros arquivos como `[nome](URL)`. A URL usa o ID da nota e do anexo; com autenticação ativada, o download também requer uma sessão válida.

## API principal

- `GET /api/notes?limit=30&offset=0&folder=...&tag=...`
- `POST /api/notes`
- `GET`, `PUT` e `DELETE /api/notes/{id}` (`PUT` aceita `version`; uma versão desatualizada retorna `409` com `{ "error", "note" }`)
- `GET /api/search?q=...&mode=title|content&limit=30&offset=0&folder=...&tag=...` (`mode` assume `title` quando omitido)
- `GET /api/tags` (nome e contagem de cada tag, sem diferenciar maiúsculas)
- `GET /api/folders`
- `POST /api/folders` com `{ "path": "Projetos/Ideias" }`
- `POST /api/folders/move` com `{ "source": "Antiga", "target": "Arquivo" }`
- `POST /api/folders/rename` com `{ "source": "Projetos/Antiga", "name": "Nova" }`
- `PATCH /api/notes/{id}/folder` com `{ "folder": "Projetos" }`
- `GET /api/folder-notes?folder=Projetos&limit=100&offset=0` (inclua `folder=` para listar somente notas sem pasta)
- `GET /api/notes/{id}/backlinks` e `GET /api/graph`
- `GET /api/backup` (download `.zip`) e `POST /api/backup` (corpo binário do `.zip`)
- `GET` e `POST /api/notes/{id}/attachments`; `GET` e `DELETE /api/notes/{id}/attachments/{attachment_id}` (upload multipart no campo `file`)
- `GET /api/auth/status`, `POST /api/auth/login` e `POST /api/auth/logout`
- `POST /api/preview` com o corpo Markdown em texto simples
- `GET /api/health`

Listagens aceitam limites de 1 a 100 registros e filtram por tag exata, sem diferenciar maiúsculas de minúsculas. Títulos aceitam até 256 caracteres, conteúdo até 5 MiB e caminhos de pasta devem ser relativos. Uploads aceitam um arquivo de até 25 MiB; são enviados como `multipart/form-data` usando o campo `file`. Links para anexos são servidos como download; imagens raster podem ser exibidas inline com `?inline=1`.

O endpoint do grafo retorna `{ "nodes": [{ "id", "title", "folder" }], "edges": [{ "source", "target", "type" }] }`. Os tipos de aresta são `markdown` e `wikilink`. Wikilinks aceitam `[[Título]]` e `[[Título|alias]]`; links Markdown locais resolvem caminhos de nota com ou sem extensão `.md`. URLs externas não viram relações entre notas.

Com autenticação habilitada, `POST /api/auth/login` recebe `{ "password": "..." }` em JSON e define o cookie de sessão; o navegador deve manter esse cookie nas chamadas seguintes. `GET /api/auth/status` informa se a autenticação está habilitada e se a sessão atual está autenticada.

As pastas continuam virtuais: são valores no SQLite, não diretórios físicos. O editor é uma implementação própria; nenhum código-fonte do Basalt foi copiado.

## Testes

```sh
cd backend
go test -tags sqlite_fts5 ./...
go vet -tags sqlite_fts5 ./...
go test -tags sqlite_fts5 -race ./...
go test -tags sqlite_fts5 -run '^$' -bench BenchmarkNoteGraph ./...
cd ../web/frontend
npm test
npm run lint
npx playwright install chromium   # uma vez por máquina
npm run test:e2e
```

Os testes E2E sobem um backend isolado em `127.0.0.1:18080` com autenticação habilitada e um diretório de dados temporário; eles não tocam nos seus dados. Use `E2E_PORT` para escolher outra porta.

## Limitações conhecidas

- O banco usa uma única conexão (`SetMaxOpenConns(1)`), adequada para uso pessoal. Muitos usuários simultâneos vão serializar as operações.
- O rate limit de login é por endereço IP direto (`RemoteAddr`). Atrás de um proxy reverso, todos os clientes compartilham o IP do proxy.
- A sessão é assinada com uma chave aleatória por processo: reiniciar o servidor exige novo login.
- Backup manual com o servidor em execução deve usar a exportação pela interface; copiar apenas `notes.db` sem o WAL pode perder as últimas alterações.
