# Stage 1: Build the React UI
FROM node:22-alpine AS ui-builder
WORKDIR /src/ui
COPY ui/package*.json ./
RUN npm ci --prefer-offline
COPY ui/ ./
RUN npm run build
# Output lands at /src/internal/api/ui_static (per vite.config.ts outDir)

# Stage 2: Build the Go binary with embedded UI
FROM golang:1.25-alpine AS go-builder
WORKDIR /src
# Fetch dependencies first (layer cache)
COPY go.mod go.sum ./
RUN go mod download
# Copy source and embedded UI output from previous stage
COPY . .
COPY --from=ui-builder /src/internal/api/ui_static ./internal/api/ui_static
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -tags embedui -ldflags="-s -w" \
    -o /whatslive ./cmd/agent

# Stage 3: Minimal runtime image
FROM alpine:3.21
RUN apk add --no-cache ca-certificates
WORKDIR /data
COPY --from=go-builder /whatslive /usr/local/bin/whatslive
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/whatslive"]
CMD ["--db", "/data/whatslive.db"]
