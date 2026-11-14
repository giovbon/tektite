# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# Stage 1: Build
# -----------------------------------------------------------------------------
# O driver go-sqlite3 usa cgo, então NÃO dá para compilar com CGO_ENABLED=0
# (o binário resultante falha em runtime com "go-sqlite3 requires cgo").
# Também não fixamos --platform=$BUILDPLATFORM: o stage precisa rodar na
# arquitetura de destino para que o cgo use o compilador nativo. Em builds
# multi-arquitetura o arm64 roda via QEMU (o workflow configura o QEMU).
FROM golang:1.27-alpine AS builder

WORKDIR /src

ARG TARGETOS=linux
ARG TARGETARCH

# gcc + musl-dev são obrigatórios para compilar o SQLite via cgo.
RUN apk add --no-cache ca-certificates tzdata gcc musl-dev

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN set -eux; \
    ARCH="${TARGETARCH:-$(go env GOARCH)}"; \
    OS="${TARGETOS:-linux}"; \
    echo "Compilando ${OS}/${ARCH} com cgo e SQLite FTS5"; \
    CGO_ENABLED=1 GOOS="${OS}" GOARCH="${ARCH}" \
    go build \
        -trimpath \
        -ldflags="-s -w -linkmode external -extldflags '-static'" \
        -tags "sqlite_fts5 sqlite_omit_load_extension" \
        -o /invariante-backend ./backend; \
    head -c 4 /invariante-backend | grep -q ELF || { \
        echo "ERRO: /invariante-backend não é um executável ELF."; \
        echo "Verifique se o pacote main está em ./backend."; \
        exit 1; \
    }; \
    echo "OK: binário estático ELF gerado para ${OS}/${ARCH}"

# -----------------------------------------------------------------------------
# Stage 2: Runtime minimal
# -----------------------------------------------------------------------------
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -g 10001 -S appgroup && \
    adduser -u 10001 -S appuser -G appgroup

WORKDIR /app

COPY --from=builder /invariante-backend /app/invariante-backend
# O backend serve a UI a partir de ./web/frontend (relativo ao WORKDIR).
COPY --from=builder /src/web/frontend /app/web/frontend

# Configurar permissões
RUN chmod +x /app/invariante-backend && \
    mkdir -p /app/data && \
    chown -R appuser:appgroup /app

USER appuser

EXPOSE 8000

ENV PORT=8000 \
    NOTES_DIR=/app/data

VOLUME ["/app/data"]

# /api/health é público (não exige autenticação) e faz ping no SQLite.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/app/invariante-backend"]
