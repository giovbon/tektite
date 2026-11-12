#!/bin/bash

# Script de automação para construir e publicar a imagem do Tektite no Docker Hub.
# Suporta múltiplas arquiteturas (amd64 e arm64) em um único manifesto.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_NAME="${DOCKERHUB_USERNAME:-giovbon}/tektite"
IMAGE_TAG="${IMAGE_TAG:-latest}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

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

    if ! docker buildx version >/dev/null 2>&1; then
        print_error "Docker Buildx não está disponível."
        exit 1
    fi
}

ensure_qemu() {
    # Em hosts amd64, o build de arm64 usa emulação. Se o binfmt não estiver
    # registrado, o build falha com "exec format error".
    if [[ "$(uname -m)" == "x86_64" ]] && [[ "$PLATFORMS" == *arm64* ]]; then
        print_info "Registrando emuladores QEMU para builds multi-arquitetura..."
        docker run --privileged --rm tonistiigi/binfmt --install arm64 >/dev/null
    fi
}

main() {
    print_info "=== Build e push do Tektite ==="

    check_docker

    print_info "Imagem de destino: ${REPO_NAME}:${IMAGE_TAG}"
    print_info "Plataformas: ${PLATFORMS}"
    print_warn "É necessário estar logado no Docker Hub (docker login)."

    ensure_qemu

    # O buildx publica o manifesto multi-arquitetura diretamente.
    docker buildx build \
        --platform "${PLATFORMS}" \
        --tag "${REPO_NAME}:${IMAGE_TAG}" \
        --push \
        "${SCRIPT_DIR}"

    print_info "=== Conclusão ==="
    print_info "Imagem publicada: ${REPO_NAME}:${IMAGE_TAG}"
    print_info "Para rodar a aplicação localmente:"
    print_info "  docker compose up -d"
    print_info "  curl http://localhost:8000/api/health"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
