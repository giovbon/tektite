# Docker Setup for PKM Notes

Este documento explica como construir, rodar e distribuir a aplicação PKM Notes usando Docker.

## Arquivos Criados

### 1. Dockerfile
**Localização:** `/mnt/c/Users/Giovani/Desktop/projeto-pkm-main/Dockerfile`

Um Dockerfile multi-estágio que compila o binário Go e roda em Alpine:

- **Suporta arm64** como solicitado
- **Multi-arquitetura**: Constrói para amd64 e arm64
- **Segurança**: Executa como usuário `appuser` dedicado
- **Otimizado**: Usa `trimpath` e ldflags para binários menores

### 2. docker-compose.yml
**Localização:** `/mnt/c/Users/Giovani/Desktop/projeto-pkm-main/docker-compose.yml`

Configuração para rodar localmente:

- **Build**: Constrói usando o Dockerfile; a plataforma é escolhida pelo Docker/buildx (sem `platforms` fixo)
- **Porta**: 8000 (padrão API)
- **Dados**: Persistência via volume `./data:/app/data`
- **Environment**: `PORT`, `NOTES_DIR` e variáveis opcionais de autenticação (`AUTHENTICATION_PASSWORD`, `AUTHENTICATION_COOKIE_SECURE`); o tema é escolhido na interface e salvo no navegador

### 3. build-and-push.sh
**Localização:** `/mnt/c/Users/Giovani/Desktop/projeto-pkm-main/build-and-push.sh`

Script de automação para Docker Hub:

```bash
#!/bin/bash

# Script de automação para construir e pushar a imagem PKM Notes para Docker Hub
# Suporta múltiplas arquiteturas, especialmente arm64 (ARM 64-bit)

# Construir para amd64 e arm64, push para Docker Hub
# Requer login no Docker Hub
# Usa Docker Buildx para multi-arquitetura
```

### 4. .github/workflows/docker-publish.yml
**Localização:** `/mnt/c/Users/Giovani/Desktop/projeto-pkm-main/.github/workflows/docker-publish.yml`

GitHub Actions para CI/CD:

- **Testes**: Valida Go, frontend, e artefatos gerados
- **Build multi-arquitetura**: Constrói para amd64 + arm64
- **Push para Docker Hub**: Usa secrets `DOCKERHUB_USERNAME` e `DOCKERHUB_TOKEN`
- **Tags**: latest, semver, e hash SHA

## Como Usar

### Rodar Localmente

```bash
# Usando Docker Compose (recomendado)
docker compose up -d

# Status
docker compose ps

# Logs
docker compose logs -f

# Parar
docker compose down
```

### Construir e Pushar para Docker Hub

```bash
# Execute o script de automação
./build-and-push.sh

# Requer:
# 1. Docker Hub login
# 2. Secrets do GitHub Actions (opcional para script manual)
```

### Testar Localmente Antes de Push

```bash
# O go-sqlite3 exige cgo: CGO_ENABLED=0 gera um binário que falha em runtime.
go mod download
CGO_ENABLED=1 go build -tags "sqlite_fts5 sqlite_omit_load_extension" -o bin/pkm-notes-backend ./backend

# Testar o binário
./bin/pkm-notes-backend --help
```

Para testar o build multi-arquitetura completo, use o Dockerfile (ele compila
com cgo para a plataforma de destino):

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t tektite:local .
```

## Configuração GitHub Actions

### Requisitos

Configure estes secrets no seu repositório GitHub:

1. **DOCKERHUB_USERNAME** - Seu username do Docker Hub
2. **DOCKERHUB_TOKEN** - Token de acesso (recomendado) ou senha

### Gatilhos

- **Push para branches main/master**
- **Tags semanticas** (`v1.2.3`)
- **Pull requests** (apenas para testes)
- **Execução manual** (`workflow_dispatch`)

### Outputs de Imagem

O workflow produz:

```
giovbon/tektite:latest      # main/master branches
giovbon/tektite:v1.2.3      # semantica tags
giovbon/tektite:1.2         # major.minor tags
giovbon/tektite:<sha>       # hash curto
```

## Arquitetura

### Multi-estágio

1. **Stage 1 (Builder)**: Go 1.27-alpine
   - Instala certificados CA, tzdata, gcc e musl-dev
   - Baixa dependências Go
   - Compila binário estático com `CGO_ENABLED=1` (necessário para o SQLite)

2. **Stage 2 (Runtime)**: Alpine 3.20
   - Minimal, focado em segurança
   - Usuário não-privilegiado `appuser`
   - Binário e frontend (`web/frontend`) copiados do stage anterior

### Multi-arquitetura

```dockerfile
FROM golang:1.27-alpine AS builder
# O stage roda na plataforma de destino (arm64 via QEMU no CI), pois o cgo
# precisa de um compilador nativo.
CGO_ENABLED=1 GOOS=$TARGETOS GOARCH=$TARGETARCH \
  go build -tags "sqlite_fts5 sqlite_omit_load_extension" -o /pkm-notes-backend ./backend
```

## Baseado em Referência (Basalt)

Este setup é baseado no projeto basalt com adaptações:

| Característica | Basalt | PKM Notes |
|---------------|--------|-----------|
| Nome do Binário | `basalt` | `pkm-notes-backend` |
| Pacote Principal | `./cmd/basalt` | `./backend` |
| Imagem Docker | `giovbon/tektite` | `giovbon/tektite` |
| Database | SQLite integrado | SQLite integrado |
| Frontend | Vite + Tailwind | Go Serve + Static |

## Debug e Manutenção

### Verificar Docker Hub Login

```bash
# Manualmente
docker login

# Via GitHub Actions (workflow)
- name: Log in to Docker Hub
  uses: docker/login-action@v3
  with:
    username: ${{ secrets.DOCKERHUB_USERNAME }}
    password: ${{ secrets.DOCKERHUB_TOKEN }}
```

### Construir Manualmente

```bash
# Construir apenas para arm64
docker buildx build --platform linux/arm64 \
  --build-arg TARGETOS=linux \
  --build-arg TARGETARCH=arm64 \
  --tag giovbon/tektite:test \
  .

# Construir multi-arquitetura
docker buildx build --platform linux/amd64,linux/arm64 \
  --tag giovbon/tektite:test \
  .
```

### Testar Workflow Localmente

```bash
cd backend
go vet -tags "sqlite_fts5 sqlite_omit_load_extension" ./...
go test -tags "sqlite_fts5 sqlite_omit_load_extension" -race ./...

cd ../web/frontend
npm ci
npm test
npm run lint
npm run test:e2e
```

## Problemas Comuns

### "Docker não está instalado"

```bash
# Instale Docker
apt-get update && apt-get install -y docker.io docker-buildx
```

### "Permission denied"

```bash
# Adicione usuário ao grupo docker
sudo usermod -aG docker $USER
# Re login
```

### "Docker Hub authentication failed"

```bash
# Verifique username e token
docker login
```

### "Multiplexação Docker não disponível"

```bash
# Configure Docker Buildx
docker buildx create --name temp-builder --use
docker buildx inspect --bootstrap
```

## Migration de Basalt

Se você estiver migrando do basalt:

### Arquivos Chave para Manter

- `Dockerfile` (adaptado para pkm-notes)
- `docker-compose.yml` (adaptado para pkm-notes)
- `build-and-push.sh` (novo script de automação)
- `.github/workflows/docker-publish.yml` (novo workflow)

### Arquivos do Basalt para Remover

- `basalt/Dockerfile` (não necessário mais)
- `basalt/docker-compose.yml` (não necessário mais)
- `basalt/build-js.sh` (talvez ainda necessário para frontend)
- `basalt/build-tailwind.sh` (talvez ainda necessário para frontend)

## FAQ

### **Por que arm64 é importante?**

ARM64 (Apple Silicon, Raspberry Pi, etc.) é crescente. Oferecer builds para ARM64 aumenta acessibilidade.

### **Por que multi-arquitetura?**

Docker Hub prefere multi-arquitetura. GitHub Actions suporta múltiplas plataformas com buildx.

### **Por que script de automação separado?**

GitHub Actions é para CI/CD. Script local é para uso manual/flexível.

### **Como manter sincronizado com basalt?**

Use basalt como referência, adapte para seu projeto. GitHub Actions workflow é similar.

## Próximos Passos

1. **Configure secrets** do Docker Hub
2. **Execute testes locais** para validar
3. **Execute script de automação** para deploy
4. **Monitore builds** no GitHub Actions
5. **Atualize documentação** conforme necessário

## Agradecimentos

Baseado no excelente projeto reference [basalt](https://github.com/giovbon/basalt) com adaptações para o PKM Notes.