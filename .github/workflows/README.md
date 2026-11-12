# GitHub Actions Workflows for PKM Notes

Este diretório contém configurações de workflows do GitHub Actions para CI/CD do PKM Notes.

## Workflows

### 1. docker-publish.yml
Um workflow completo que:

- **Executa testes CI** antes de qualquer build
  - Verifica código Go (`go vet`, `go test`)
  - Executa testes de frontend (unitários e E2E)
  - Valida artefatos frontend gerados

- **Constrói binários multi-arquitetura**
  - `amd64` (x86_64) - para clouds comuns e desktop
  - `arm64` (ARM64) - para Apple Silicon, Raspberry Pi, etc.
  - Valida ELF (Executable and Linkable Format) para cada binário

- **Faz push para Docker Hub**
  - Usa Docker Buildx para multi-plataforma
  - Constrói imagem Docker para ambas arquiteturas
  - Faz push para `giovoni/pkm-notes` no Docker Hub
  - Usa tags semver, latest, e hash SHA

- **Cache de builds** para速度更快的 construções subsequentes

## Configuração

### Secrets Requeridos

Adicione estes secrets à sua conta GitHub:

1. **DOCKERHUB_USERNAME** - Seu username do Docker Hub
2. **DOCKERHUB_TOKEN** - Token de acesso com permissão para push/push (recomendado)

### Gatilhos de Workflow

- **Push para branches main/master**
- **Tags que seguem semver** (`v1.2.3`, etc.)
- **Pull requests** (apenas para testes)
- **Execução manual** via interface do GitHub Actions

### Outputs de Imagem

O workflow produz as seguintes tags de imagem:

- `giovoni/pkm-notes:latest` (apenas para main/master)
- `giovoni/pkm-notes:v1.2.3` (para tags semanticas)
- `giovoni/pkm-notes:1.2` (para tags major.minor)
- `giovoni/pkm-notes:<sha>` (hash curto)

## Como Configurar

### 1. Adicione Secrets

```bash
# No GitHub UI:
# Settings > Secrets and variables > Actions
# Adicione:
DOCKERHUB_USERNAME=giovoni
DOCKERHUB_TOKEN=seu_token_aqui
```

### 2. Configure Repositório

```bash
# Certifique-se de que seu repository tem:
- Arquivo .gitignore
- Arquivo README.md
- Arquivo Dockerfile
- Arquivo docker-compose.yml
```

### 3. Workflow Dispatch (Opcional)

Você pode executar manualmente:
1. Vá para Actions tab
2. Encontre "CI and Docker publish"
3. Clique em "Run workflow"
4. Escolha o branch/tag

## Hospedar no Docker Hub

### Configuração do GitHub Container Registry (Alternativa)

Se preferir o GitHub Container Registry:

```yaml
# Modifique o step de login
- name: Log in to GitHub Container Registry
  uses: docker/login-action@v3
  with:
    registry: ghcr.io
    username: ${{ github.actor }}
    password: ${{ secrets.GITHUB_TOKEN }}

# Modifique os tags de destino
images: ghcr.io/${{ github.repository }}/pkm-notes
```

## Fluxo de Trabalho Completo

1. **Push para main**:
   - Executa toda a suíte de testes
   - Constrói binários multi-arquitetura
   - Faz push para `giovoni/pkm-notes:latest`

2. **Push para tag semver** (`v1.2.3`):
   - Executa testes
   - Faz push para `giovoni/pkm-notes:v1.2.3`
   - Faz push para `giovoni/pkm-notes:1.2`

3. **Pull requests**:
   - Apenas testes, sem push de Docker

## Manutenção

### Atualizar Versão Go

```yaml
# Em docker-publish.yml
- name: Set up Go
  uses: actions/setup-go@v7
  with:
    go-version: '1.22'  # Atualize conforme necessário
    cache: true
```

### Adicionar Mais Arquiteturas

```yaml
# No step "Build Multi-Arch Binaries"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build ...
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build ...
CGO_ENABLED=0 GOOS=linux GOARCH=s390x go build ...  # Exemplo adicional
```

### Otimizações de Cache

- Cache go.mod, go.sum, node_modules
- Cache Docker layers usando GitHub Actions cache
- Cache de binários compilados

## Testes Locais vs GitHub Actions

### Executar Testes Localmente

```bash
# Clone repository
# Execute testes Go

go test ./backend/...

# Execute testes frontend (requer Node.js)
npm ci --prefix web/frontend
npm test --prefix web/frontend

# Execute testes E2E (requer Playwright)
npx playwright install
npm run test:e2e --prefix web/frontend
```

### Executar Build de Docker Localmente

```bash
# Para simular GitHub Actions
mkdir -p bin
go mod download

# Build de binários multi-arquitetura
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o bin/pkm-notes-backend-amd64 ./backend
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o bin/pkm-notes-backend-arm64 ./backend

# Build de Docker
DOCKER_BUILDKIT=1 docker buildx build --platform linux/amd64,linux/arm64 .
```

## Problemas e Soluções

### "Failed to resolve platform"

```bash
# Instale QEMU para construção multi-arquitetura
docker run --privileged --rm tonistiigi/binfmt --install all
```

### "Push para Docker Hub falhou"

```bash
# Verifique secrets e permissions
docker login
docker push giovoni/pkm-notes:latest
```

### "Timeouts de build"

```yaml
# Adicione timeout no job de build-and-push
- name: Build and push Docker image
  uses: docker/build-push-action@v5
  with:
    timeout: 60m  # Adicione se necessário
```

## Resources

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Docker Buildx Documentation](https://docs.docker.com/buildx/working-with-buildx/)
- [Docker Hub Best Practices](https://docs.docker.com/engine/reference/commandline/hub/)
- [Multi-Arch Docker Images](https://docs.docker.com/docker-hub/architecture/