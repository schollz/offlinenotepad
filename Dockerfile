FROM node:24-alpine AS frontend

WORKDIR /src/web

COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/index.html web/public.html web/tsconfig.json web/tsconfig.app.json web/tsconfig.node.json web/vite.config.ts ./
COPY web/public ./public
COPY web/src ./src
RUN npm run build

FROM golang:1.27.1-alpine AS backend

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY cmd ./cmd
COPY internal ./internal
COPY --from=frontend /src/internal/site/build ./internal/site/build
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/offlinenotepad ./cmd/offlinenotepad

FROM alpine:3.23

RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S offlinenotepad \
    && adduser -S -G offlinenotepad offlinenotepad \
    && mkdir -p /data \
    && chown offlinenotepad:offlinenotepad /data

COPY --from=backend /out/offlinenotepad /usr/local/bin/offlinenotepad

ENV PORT=8251 \
    SQLITE_PATH=/data/offlinenotepad.sqlite3

USER offlinenotepad
EXPOSE 8251

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8251/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/offlinenotepad"]
CMD ["serve"]
