package main

import (
	"bytes"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/schollz/offlinenotepad/internal/legacy"
)

func TestLegacyMigrationAlias(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		want    []string
		matched bool
		wantErr bool
	}{
		{name: "short form", args: []string{"-migrate", "data.db"}, want: []string{"--source", "data.db"}, matched: true},
		{name: "equals form", args: []string{"-migrate=/backup/data.db", "--dry-run"}, want: []string{"--source", "/backup/data.db", "--dry-run"}, matched: true},
		{name: "missing source", args: []string{"-migrate"}, matched: true, wantErr: true},
		{name: "normal command", args: []string{"serve"}, matched: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, matched, err := legacyMigrationAlias(test.args)
			if matched != test.matched || (err != nil) != test.wantErr || !reflect.DeepEqual(got, test.want) {
				t.Fatalf("legacyMigrationAlias(%q) = %q, %v, %v", test.args, got, matched, err)
			}
		})
	}
}

func TestLegacyMigrationProgressLoggerThrottlesIntermediateUpdates(t *testing.T) {
	var output bytes.Buffer
	reporter := legacyMigrationProgressLogger{
		logger:   slog.New(slog.NewTextHandler(&output, nil)),
		interval: time.Hour,
	}
	reporter.Report(legacy.ArchiveProgress{Phase: legacy.ArchiveProgressInspect})
	reporter.Report(legacy.ArchiveProgress{Phase: legacy.ArchiveProgressReadDocuments, Total: 100})
	reporter.Report(legacy.ArchiveProgress{Phase: legacy.ArchiveProgressReadDocuments, Completed: 50, Total: 100})
	reporter.Report(legacy.ArchiveProgress{
		Phase: legacy.ArchiveProgressReadDocuments, Completed: 100, Total: 100,
		Diagnostics: legacy.ArchiveDiagnostics{DocumentsRecoveredMissingHash: 1},
	})

	logs := output.String()
	if strings.Count(logs, "phase=read_documents") != 2 {
		t.Fatalf("expected start and completion logs only:\n%s", logs)
	}
	for _, expected := range []string{"phase=inspect", "completed=0 total=100 percent=0", "completed=100 total=100 percent=100", "documents_recovered_missing_hash=1"} {
		if !strings.Contains(logs, expected) {
			t.Errorf("progress logs did not contain %q:\n%s", expected, logs)
		}
	}
}

func TestLegacyMigrationFailureLogIncludesSafeProgressContext(t *testing.T) {
	var output bytes.Buffer
	reporter := legacyMigrationProgressLogger{logger: slog.New(slog.NewTextHandler(&output, nil))}
	reporter.Report(legacy.ArchiveProgress{
		Phase: legacy.ArchiveProgressStageRecords, Completed: 12, Total: 100,
		Diagnostics: legacy.ArchiveDiagnostics{DocumentsSkippedInvalidCiphertext: 2},
	})
	reporter.ReportFailure(errors.New("destination database could not stage the legacy archive"))
	logs := output.String()
	for _, expected := range []string{
		`level=ERROR msg="legacy migration failed"`,
		"phase=stage_records",
		"completed=12 total=100 percent=12",
		"documents_skipped_invalid_ciphertext=2",
		`error="destination database could not stage the legacy archive"`,
	} {
		if !strings.Contains(logs, expected) {
			t.Errorf("failure log did not contain %q:\n%s", expected, logs)
		}
	}
}
