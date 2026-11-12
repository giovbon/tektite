#!/bin/bash

# Script de automação para construir e pushar a imagem PKM Notes para Docker Hub
# Suporta múltiplas arquiteturas, especialmente arm64 (ARM 64-bit)

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_NAME="giovoni/tektite"
IMAGE_TAG="latest"

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # Sem cor

print_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_docker() {
    if ! command -v docker >/dev/null 2>&1; then
        print_error "Docker não está instalado. Por favor, instale o Docker primeiro."
        exit 1
    fi
    
    if ! docker info >/dev/null 2>&1; then
        print_error "Docker não está rodando. Por favor, inicie o Docker primeiro."
        exit 1
    fi
}

check_docker_hub_login() {
    if ! docker info --format '{{json .}} | jq -e ".".ClientInfo.Username' 2>/dev/null | grep -q "^$" 2>/dev/null; then
        print_warn "Você não está logado no Docker Hub."
        print_warn "Por favor, faça login com 'docker login' antes de continuar."
        echo -n "Deseja fazer login agora? (s/N): "
        read -r answer
        if [[ "$answer" =~ ^[Ss]$ ]]; then
            docker login
        else
            print_error "Por favor, faça login no Docker Hub para continuar."
            exit 1
        fi
    fi
}

build_image() {
    local platform="$1"
    local arch="$2"
    
    print_info "Construindo imagem para ${platform}/${arch}..."
    
    docker buildx build --platform "$platform" \
        --build-arg TARGETOS="linux" \
        --build-arg TARGETARCH="$arch" \
        --tag "$REPO_NAME:$IMAGE_TAG-$arch" \
        --tag "$REPO_NAME:$IMAGE_TAG" \
        --output "type=docker" \
        "$SCRIPT_DIR"
}

build_multiarch() {
    # Verificar se o Docker Buildx está disponível
    if ! docker buildx inspect >/dev/null 2>&1; then
        print_warn "Docker Buildx não está disponível. Criando um builder...
        docker buildx create --name temp-builder --use
        docker buildx inspect --bootstrap
    fi
    
    print_info "Construindo imagens multi-arquitetura..."
    
    # Construir para amd64 (x86_64) - arquitetura comum em clouds
    if build_image "linux/amd64" "amd64"; then
        print_info "Imagem amd64 construída com sucesso."
    else
        print_error "Falha ao construir imagem amd64."
        exit 1
    fi
    
    # Construir para arm64 (ARM 64-bit) - especialmente solicitado
    if build_image "linux/arm64" "arm64"; then
        print_info "Imagem arm64 construída com sucesso."
    else
        print_error "Falha ao construir imagem arm64."
        exit 1
    fi
}

push_image() {
    print_info "Fazendo push para Docker Hub..."
    
    # Fazer push das imagens específicas para cada arquitetura
    docker push "$REPO_NAME:$IMAGE_TAG-amd64"
    docker push "$REPO_NAME:$IMAGE_TAG-arm64"
    
    # Também fazer push da imagem genérica (última construída)
    docker push "$REPO_NAME:$IMAGE_TAG"
}

create_manifest() {
    print_info "Criando manifesto multi-arquitetura..."
    
    docker buildx imagetools create \
        --tag "$REPO_NAME:$IMAGE_TAG" \
        "$REPO_NAME:$IMAGE_TAG-amd64" \
        "$REPO_NAME:$IMAGE_TAG-arm64"
}

main() {
    print_info "=== Automação de Build e Push do PKM Notes ==="
    
    check_docker
    check_docker_hub_login
    
    print_info "Construindo para múltiplas arquiteturas..."
    build_multiarch
    
    print_info "Fazendo push para Docker Hub..."
    push_image
    
    print_info "Criando manifesto multi-arquitetura..."
    create_manifest
    
    print_info "=== Conclusão ==="
    print_info "Imagens construídas e pushadas com sucesso para Docker Hub:"
    print_info "  - $REPO_NAME:$IMAGE_TAG-amd64"
    print_info "  - $REPO_NAME:$IMAGE_TAG-arm64"
    print_info "  - $REPO_NAME:$IMAGE_TAG (manifesto multi-arquitetura)"
    
    print_info "Para rodar a aplicação localmente:"
    print_info "  docker compose up -d"
    print_info "  curl http://localhost:8000/api/health"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi

# Tornar o script executável
chmod +x "$SCRIPT_DIR/build-and-push.sh"