# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# Stage 1: Build (usa binário pré-compilado se existir, ou compila nativamente)
# -----------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:1.21-alpine AS builder

WORKDIR /src

ENV GOTOOLCHAIN=auto

# Definido linux como padrão para TARGETOS
ARG TARGETOS=linux
ARG TARGETARCH

RUN apk add --no-cache ca-certificates tzdata git

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# 1. Compilar para múltiplas arquiteturas, suportando arm64 (ARM 64-bit)
RUN set -e; \
    ARCH="${TARGETARCH:-$(go env GOARCH)}"; \
    echo "Compilando nativamente para ${TARGETOS:-linux}/${ARCH}"; \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${ARCH} go build \
        -trimpath \
        -ldflags="-s -w" \
        -o /pkm-notes-backend ./backend; \
    if ! head -c 4 /pkm-notes-backend | grep -q "ELF"; then \
        echo "ERRO: /pkm-notes-backend nao e um executavel ELF."; \
        echo "O pacote main nao foi compilado - verifique o caminho ./backend no Dockerfile."; \
        exit 1; \
    fi; \
    echo "OK: binario ELF gerado para ${TARGETOS:-linux}/${ARCH}"

# -----------------------------------------------------------------------------
# Stage 2: Runtime Minimal
# -----------------------------------------------------------------------------
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -g 10001 -S appgroup && \
    adduser -u 10001 -S appuser -G appgroup

WORKDIR /app

COPY --from=builder /pkm-notes-backend /app/pkm-notes-backend

# Configurar permissões
RUN chmod +x /app/pkm-notes-backend && \
    mkdir -p /app/data && \
    chown -R appuser:appgroup /app

USER appuser

EXPOSE 8000

ENV PORT=8000 \
    NOTES_DIR=/app/data

VOLUME ["/app/data"]

ENTRYPOINT ["/app/pkm-notes-backend"]