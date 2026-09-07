package database

import (
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/golang-migrate/migrate/v4"
	migratedatabase "github.com/golang-migrate/migrate/v4/database"
	migratepostgres "github.com/golang-migrate/migrate/v4/database/postgres"
	migratesqlite "github.com/golang-migrate/migrate/v4/database/sqlite"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

//go:embed migrations/postgresql/*.sql migrations/sqlite/*.sql
var migrationFiles embed.FS

type migrationLogger struct {
	backend Backend
}

func (logger migrationLogger) Printf(format string, args ...any) {
	detail := strings.TrimSpace(fmt.Sprintf(format, args...))
	slog.Info("database migration", "database", logger.backend, "detail", detail)
}

func (migrationLogger) Verbose() bool {
	return false
}

func migrateSchema(backend Backend, dsn string) error {
	driverName, directory, migrationName := "sqlite", "migrations/sqlite", "sqlite"
	if backend == BackendPostgreSQL {
		driverName, directory, migrationName = "pgx", "migrations/postgresql", "postgres"
	}
	slog.Info("checking database migrations", "database", backend)
	db, err := sql.Open(driverName, dsn)
	if err != nil {
		return err
	}

	var databaseDriver migratedatabase.Driver
	if backend == BackendPostgreSQL {
		databaseDriver, err = migratepostgres.WithInstance(db, &migratepostgres.Config{})
	} else {
		databaseDriver, err = migratesqlite.WithInstance(db, &migratesqlite.Config{})
	}
	if err != nil {
		db.Close()
		return err
	}
	sourceDriver, err := iofs.New(migrationFiles, directory)
	if err != nil {
		databaseDriver.Close()
		return err
	}
	migrator, err := migrate.NewWithInstance("iofs", sourceDriver, migrationName, databaseDriver)
	if err != nil {
		sourceDriver.Close()
		databaseDriver.Close()
		return err
	}
	migrator.Log = migrationLogger{backend: backend}
	migrationErr := migrator.Up()
	migrationsApplied := migrationErr == nil
	sourceErr, databaseErr := migrator.Close()
	if migrationErr != nil && !errors.Is(migrationErr, migrate.ErrNoChange) {
		return migrationErr
	}
	if sourceErr != nil {
		return fmt.Errorf("close migration source: %w", sourceErr)
	}
	if databaseErr != nil {
		return fmt.Errorf("close migration database: %w", databaseErr)
	}
	if migrationsApplied {
		slog.Info("database migrations applied", "database", backend)
	} else {
		slog.Info("database migrations are up to date", "database", backend)
	}
	return nil
}
