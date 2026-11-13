# GitHub Actions: CI e publicação no Docker Hub

O workflow fica em `.github/workflows/docker-publish.yml` e tem dois jobs:
`test` e `build-and-push`.

## Job `test`

Roda em todo push e pull request:

- `go vet` e `go test` com as tags `sqlite_fts5 sqlite_omit_load_extension`;
- `go test -race` e um piso mínimo de cobertura do backend;
- `govulncheck` para vulnerabilidades conhecidas nas dependências Go;
- `npm ci`, `npm test`, `npm run lint` e `npm run test:e2e` em `web/frontend`;
- `npm run build --if-present` (no-op enquanto não houver script `build`).

Os testes E2E instalam o Chromium do Playwright e sobem um backend isolado com
autenticação habilitada; não usam dados reais.

O Go é instalado a partir da versão declarada em `go.mod` (`go-version-file`).

## Job `build-and-push`

Roda só em push para `main`/`master`, tags `v*.*.*` ou execução manual
(`workflow_dispatch`). Pull requests não publicam imagem.

Passos principais:

1. Valida os secrets do Docker Hub e confere se o token realmente tem
   permissão de `push` (um token Read-only gera `insufficient_scope`).
2. Configura QEMU + Buildx.
3. Faz login no Docker Hub.
4. Gera as tags com `docker/metadata-action`.
5. Compila e publica `linux/amd64` e `linux/arm64` com `docker/build-push-action`.

O Dockerfile compila o backend com cgo (`go-sqlite3` não funciona com
`CGO_ENABLED=0`). Em builds multi-arquitetura o arm64 é emulado via QEMU, por
isso o QEMU é configurado antes do build.

## Secrets necessários

Em **Settings → Secrets and variables → Actions**:

| Secret | Valor |
| --- | --- |
| `DOCKERHUB_USERNAME` | usuário do Docker Hub (ex.: `giovbon`) |
| `DOCKERHUB_TOKEN` | Access Token com permissão **Read & Write** |

Crie o token em <https://hub.docker.com/settings/security>. Tokens do tipo
Read-only fazem o login funcionar, mas o push falha com
`insufficient_scope: authorization failed`.

O namespace da imagem é montado como
`${{ secrets.DOCKERHUB_USERNAME }}/tektite`, então ele sempre coincide com a
conta dona do token. Se você trocar de conta, basta atualizar o secret — não é
preciso editar o workflow.

## Tags publicadas

- `latest` — apenas no branch padrão (`main`);
- `v1.2.3` — em tags semver;
- `1.2` — major.minor em tags semver;
- `<sha-curto>` — em todo build publicado.

## Rodando o build localmente

O Dockerfile é autossuficiente:

```bash
docker build -t tektite:local .

# Multi-arquitetura (requer QEMU/binfmt no host)
docker run --privileged --rm tonistiigi/binfmt --install all
docker buildx build --platform linux/amd64,linux/arm64 -t tektite:local .
```

Ou use o script, que já publica o manifesto:

```bash
docker login
DOCKERHUB_USERNAME=giovbon ./build-and-push.sh
```

## Problemas comuns

### `insufficient_scope: authorization failed`

1. Confirme que `DOCKERHUB_USERNAME` é a conta dona do token.
2. Gere um novo Access Token com **Read & Write** e atualize `DOCKERHUB_TOKEN`.
3. Rode o workflow de novo: o passo "Validate Docker Hub credentials" mostra o
   erro antes de perder tempo compilando.

### `exec format error` no build arm64

Registre os emuladores no host:

```bash
docker run --privileged --rm tonistiigi/binfmt --install arm64
```

### `go-sqlite3 requires cgo`

O backend precisa ser compilado com `CGO_ENABLED=1`. Não compile com
`CGO_ENABLED=0`: o binário gera erro em runtime ao abrir o SQLite.
