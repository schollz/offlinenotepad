package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	"github.com/schollz/offlinenotepad/internal/app"
	"github.com/schollz/offlinenotepad/internal/database"
	"github.com/schollz/offlinenotepad/internal/legacy"
	"github.com/schollz/offlinenotepad/internal/site"
	"golang.org/x/term"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		slog.Error("offlinenotepad stopped", "error", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if err := godotenv.Load(); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("load .env: %w", err)
	}
	if legacyArgs, matched, err := legacyMigrationAlias(args); matched {
		if err != nil {
			return err
		}
		return migrateLegacyArchive(legacyArgs)
	}
	command := "serve"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		command = args[0]
		args = args[1:]
	}
	switch command {
	case "serve":
		return serve(args)
	case "migrate":
		return migrate(args)
	case "migrate-legacy":
		return migrateLegacy(args)
	case "stage-legacy":
		return migrateLegacyArchive(args)
	default:
		return fmt.Errorf("unknown command %q", command)
	}
}

func migrateLegacyArchive(args []string) error {
	flags := flag.NewFlagSet("stage-legacy", flag.ContinueOnError)
	source := flags.String("source", "data.db", "legacy bbolt database")
	dryRun := flags.Bool("dry-run", false, "validate without writing")
	if err := flags.Parse(args); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	store, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer store.Close()
	result, err := legacy.StageArchive(ctx, store, legacy.ArchiveOptions{Source: *source, DryRun: *dryRun})
	if err != nil {
		return err
	}
	slog.Info("legacy archive staged", "dry_run", *dryRun,
		"workspaces_imported", result.WorkspacesImported, "workspaces_skipped", result.WorkspacesSkipped,
		"documents_imported", result.DocumentsImported, "documents_skipped", result.DocumentsSkipped,
		"publications_imported", result.PublicationsImported, "publications_skipped", result.PublicationsSkipped)
	return nil
}

func legacyMigrationAlias(args []string) ([]string, bool, error) {
	if len(args) == 0 {
		return nil, false, nil
	}
	var source string
	remaining := args[1:]
	switch {
	case args[0] == "-migrate":
		if len(remaining) == 0 || strings.HasPrefix(remaining[0], "-") {
			return nil, true, errors.New("usage: offlinenotepad -migrate LEGACY_DATA_DB [--dry-run]")
		}
		source, remaining = remaining[0], remaining[1:]
	case strings.HasPrefix(args[0], "-migrate="):
		source = strings.TrimPrefix(args[0], "-migrate=")
		if strings.TrimSpace(source) == "" {
			return nil, true, errors.New("legacy database path is required")
		}
	default:
		return nil, false, nil
	}
	legacyArgs := []string{"--source", source}
	return append(legacyArgs, remaining...), true, nil
}

func loggerFor(level string) *slog.Logger {
	var parsed slog.Level
	if err := parsed.UnmarshalText([]byte(level)); err != nil {
		parsed = slog.LevelInfo
	}
	return slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: parsed}))
}

func openStore(ctx context.Context) (*database.Store, error) {
	return database.Open(ctx, database.ConfigFromEnv())
}

func serve(args []string) error {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	port := flags.Int("port", envInt("PORT", 8251), "HTTP port")
	level := flags.String("log", envString("LOG_LEVEL", "info"), "log level")
	if err := flags.Parse(args); err != nil {
		return err
	}
	logger := loggerFor(*level)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	store, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer store.Close()
	application, err := app.New(store, site.Content(), logger, app.Config{
		SiteURL:                strings.TrimSpace(os.Getenv("SITE_URL")),
		AllowedOrigins:         splitOrigins(os.Getenv("ALLOWED_ORIGINS")),
		LegacyMigrationEnabled: envBool("LEGACY_MIGRATION_ENABLED", true),
		UmamiURL:               strings.TrimSpace(os.Getenv("UMAMI_URL")),
		UmamiWebsiteID:         strings.TrimSpace(os.Getenv("UMAMI_WEBSITE_ID")),
	})
	if err != nil {
		return err
	}
	server := &http.Server{Addr: ":" + strconv.Itoa(*port), Handler: application.Handler(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 1 << 20}
	errorsChannel := make(chan error, 1)
	go func() {
		logger.Info("server listening", "port", *port, "database", store.Backend())
		errorsChannel <- server.ListenAndServe()
	}()
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(shutdownCtx)
	case err := <-errorsChannel:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func migrate(args []string) error {
	flags := flag.NewFlagSet("migrate", flag.ContinueOnError)
	if err := flags.Parse(args); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	store, err := openStore(ctx)
	if err != nil {
		return err
	}
	return store.Close()
}

func migrateLegacy(args []string) error {
	flags := flag.NewFlagSet("migrate-legacy", flag.ContinueOnError)
	source := flags.String("source", "data.db", "legacy bbolt database")
	username := flags.String("username", "", "legacy username")
	dryRun := flags.Bool("dry-run", false, "validate without writing")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *username == "" {
		fmt.Fprint(os.Stderr, "Legacy account username (not a note title): ")
		value, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil {
			return fmt.Errorf("read notebook name: %w", err)
		}
		*username = strings.TrimSpace(value)
		if *username == "" {
			return errors.New("legacy notebook name is required")
		}
	}
	fmt.Fprint(os.Stderr, "Legacy notebook password: ")
	password, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return fmt.Errorf("read password: %w", err)
	}
	defer clear(password)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	store, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer store.Close()
	result, err := legacy.Migrate(ctx, store, legacy.Options{Source: *source, Username: *username, Password: password, DryRun: *dryRun})
	if err != nil {
		return err
	}
	slog.Info("legacy migration complete", "dry_run", *dryRun, "documents_imported", result.DocumentsImported, "documents_skipped", result.DocumentsSkipped, "publications_imported", result.PublicationsImported, "publications_skipped", result.PublicationsSkipped)
	return nil
}

func envString(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
func envInt(key string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key)))
	if err == nil && value > 0 && value < 65536 {
		return value
	}
	return fallback
}
func splitOrigins(value string) []string {
	var result []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			result = append(result, item)
		}
	}
	return result
}

func envBool(key string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}
