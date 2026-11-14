# Docker para Invariante

Este diretório contém os arquivos de configuração Docker para construir, rodar e distribuir o Invariante.

## Arquivos

### 1. Dockerfile
Um Dockerfile multi-estágio para construir a aplicação Invariante:

- **Estágio 1 (Builder)**: Compila o binário Go usando a imagem `golang:1.27-alpine`
  - Suporta múltiplas arquiteturas (amd64, arm64)
  - Usa `go mod download` para cache de dependências
  - Compila para arquitetura nativa detectada automaticamente
  - Gera binário ELF verificado

- **Estágio 2 (Runtime)**: Usa a imagem Alpine minimal
  - Instala certificados CA e timezone
  - Cria usuário não-privilegiado `appuser` para segurança
  - Define permissões adequadas para diretórios de dados
  - Expõe a porta 8000
  - Define `NOTES_DIR=/app/data` por padrão

### 2. docker-compose.yml
Arquivo de composição Docker para rodar a aplicação:

- **Build**: Constrói localmente usando o Dockerfile (suporta múltiplas plataformas)
- **Portas**: Expõe a porta 8000 para a porta 8000 do host
- **Environment**: Define variáveis de ambiente para porta, diretório de dados e tema padrão
- **Volumes**: Monta o diretório `./data:/app/data` para persistência de dados
- **Restart**: Usa "unless-stopped" para não parar em caso de fallos

### 3. build-and-push.sh
Script de automação para construir e pushar para Docker Hub:

- **Multi-arquitetura**: Constrói tanto para amd64 quanto arm64
- **Arquitetura específica**: Especialmente foca em arm64 como solicitado
- **Push para Docker Hub**: Pusha imagens para `giovbon/tektite`
- **Manifesto multi-arquitetura**: Cria manifesto que roda em múltiplas arquiteturas
- **Verificações**: Inclui checagens para Docker, login do Docker Hub e validação

## Como usar

### Rodar localmente

```bash
# Construir e rodar usando Docker Compose
docker compose up -d

# Ou construir manualmente usando Dockerfile
docker build -t invariante:latest .
docker run -d -p 8000:8000 --name invariante invariante:latest

# Verificar saúde
curl http://localhost:8000/api/health
```

### Construir e pushar para Docker Hub

```bash
# Execute o script de automação (requer Docker Buildx)
./build-and-push.sh

# Alternativamente, construir manualmente para arm64
DOCKERFILE_PATH=/mnt/c/Users/Giovani/Desktop/projeto-pkm-main
docker buildx build --platform linux/arm64 \
  --build-arg TARGETOS=linux \
  --build-arg TARGETARCH=arm64 \
  --tag giovbon/tektite:latest \
  --output type=docker \
  "$DOCKERFILE_PATH"

docker push giovbon/tektite:latest
```

### Documentação de referência do Dockerfile (inspirada no basalt)

- **Multi-stage**: Separa construção e runtime para produção menor
- **Suporte a múltiplas arquiteturas**: Detecta arquitetura nativa automaticamente
- **Segurança**: Executa como usuário não-privilegiado
- **Cache**: Usa cache de camadas do Docker para reconstruções mais rápidas
- **Validação**: Verifica que binário compilado é executável ELF

## Notas Especiais

1. **Foco em arm64**: O script automaticamente constrói para arm64 como solicitado pelo usuário
2. **Persistência de dados**: Use volumes Docker ou monte diretório local para dados persistentes
3. **Configuração**: Use variáveis de ambiente ou docker-compose.yml para configurações adicionais
4. **Construções otimizadas**: Usas `trimpath` e flags de ldflags para binários menores

## Problemas e Soluções

- **Docker Buildx não disponível**: Script cria builder automaticamente se necessário
- **Login do Docker Hub**: Script verifica login e guia você através do processo
- **Problemas de permissão**: Script executa como usuário `appuser` dedicado

## Manutenção

- Atualize a versão do Go no Dockerfile se necessário
- Modifique as variáveis de ambiente em docker-compose.yml
- Adicione build args para configurações personalizadas
- Atualize o script de automação conforme necessário

## Sincronização com Projeto de Referência (basalt)

Este Dockerfile é baseado no projeto reference basalt, com adaptações específicas para o Invariante:

- Adaptou nome do binário (`invariante-backend` vs `basalt`)
- Atualizou importações Go e dependências (`github.com/mattn/go-sqlite3`, `github.com/yuin/goldmark`)
- Configurou rotas de API diferentes
- Adicionou scripts específicos para o Invariante (`run.sh`)
- Adaptou configurações de frontend (`./web/frontend` vs `./web`)