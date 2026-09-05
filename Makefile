BINARY := offlinenotepad
WEB_DIR := web
NODE_MODULES_LOCK := $(WEB_DIR)/node_modules/.package-lock.json
AIR_VERSION := v1.65.1
SQLC_VERSION := v1.31.1
LEGACY_DB ?= data.db

.PHONY: build frontend frontend-install generate migrate migrate-legacy reset-test-db dev serve test test-race lint clean docker

build: frontend
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o $(BINARY) ./cmd/offlinenotepad

frontend: $(NODE_MODULES_LOCK)
	npm --prefix $(WEB_DIR) run build

frontend-install: $(NODE_MODULES_LOCK)

$(NODE_MODULES_LOCK): $(WEB_DIR)/package.json $(WEB_DIR)/package-lock.json
	npm --prefix $(WEB_DIR) ci

generate:
	CGO_ENABLED=0 go run github.com/sqlc-dev/sqlc/cmd/sqlc@$(SQLC_VERSION) generate

migrate:
	go run ./cmd/offlinenotepad migrate

migrate-legacy:
	go run ./cmd/offlinenotepad -migrate $(LEGACY_DB) $(LEGACY_ARGS)

reset-test-db:
	./scripts/reset-test-db.sh

dev:
	go run github.com/air-verse/air@$(AIR_VERSION) -c .air.toml

serve:
	go run ./cmd/offlinenotepad serve

test:
	npm --prefix $(WEB_DIR) test
	go test ./...

test-race:
	go test -race ./...

lint:
	npm --prefix $(WEB_DIR) run lint
	npm --prefix $(WEB_DIR) run typecheck
	go vet ./...

docker:
	docker build -t offlinenotepad:local .

clean:
	rm -f $(BINARY)
