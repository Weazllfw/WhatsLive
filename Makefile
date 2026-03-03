.PHONY: build-ui build-agent-linux build-agent-windows build-all \
        docker-build docker-up docker-dev \
        run-dev ui-dev scan \
        clean

# ── UI ──────────────────────────────────────────────────────────────────────

# Build the React UI (must run before any Go build that embeds the UI).
build-ui:
	cd ui && npm ci --prefer-offline && npm run build

# Start the Vite dev server (proxies /api and /ws to localhost:8080).
# Run alongside `make run-dev SUBNET=…` in a second terminal.
ui-dev:
	cd ui && npm run dev

# ── Agent (release builds) ───────────────────────────────────────────────────

# Build the Linux agent binary with embedded UI.
build-agent-linux: build-ui
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
	  go build -tags embedui -ldflags="-s -w" \
	  -o dist/whatslive-linux-amd64 ./cmd/agent

# Build the Windows agent binary with embedded UI.
# modernc.org/sqlite is pure Go — no C compiler required for cross-compilation.
build-agent-windows: build-ui
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 \
	  go build -tags embedui -ldflags="-s -w" \
	  -o dist/whatslive-windows-amd64.exe ./cmd/agent

# Build both binaries.
build-all: build-agent-linux build-agent-windows

# Build a single-binary for the current platform (no cross-compilation).
# On Windows: make build-native  → dist/whatslive.exe
# On Linux:   make build-native  → dist/whatslive
build-native: build-ui
	CGO_ENABLED=0 \
	  go build -tags embedui -ldflags="-s -w" \
	  -o dist/whatslive$(if $(filter Windows_NT,$(OS)),.exe,) ./cmd/agent

# ── Development (native, no embedding) ───────────────────────────────────────

# Run the agent in dev mode (no embedded UI, faster rebuild).
# SUBNET is required: make run-dev SUBNET=192.168.1.0/24
run-dev:
	go run ./cmd/agent --subnet $(SUBNET)

# Hot-reload agent via air (install: go install github.com/air-verse/air@latest).
# SUBNET is required: make dev SUBNET=192.168.1.0/24
dev:
	SUBNET=$(SUBNET) air

# One-shot discovery scan — prints found devices and exits (no server started).
# make scan SUBNET=192.168.1.0/24
scan:
	go run ./cmd/agent --subnet $(SUBNET) --scan-only

# ── Docker (Linux host / CI) ──────────────────────────────────────────────────

# Build the production Docker image.
docker-build:
	docker build -f deploy/Dockerfile -t whatslive:latest .

# Start production container.
# SUBNET is optional: make docker-up SUBNET=192.168.1.0/24
docker-up:
	SUBNET=$(SUBNET) docker compose -f deploy/docker-compose.yml up --build

# Start development container with hot-reload (Linux host only).
# SUBNET is required: make docker-dev SUBNET=192.168.1.0/24
docker-dev:
	SUBNET=$(SUBNET) docker compose -f deploy/docker-compose.dev.yml up --build

# ── Misc ──────────────────────────────────────────────────────────────────────

# Clean build artefacts.
clean:
	rm -rf dist/ tmp/ internal/api/ui_static/
