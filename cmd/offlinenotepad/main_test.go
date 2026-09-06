package main

import (
	"bytes"
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
	reporter.Report(legacy.ArchiveProgress{Phase: legacy.ArchiveProgressReadDocuments, Completed: 100, Total: 100})

	logs := output.String()
	if strings.Count(logs, "phase=read_documents") != 2 {
		t.Fatalf("expected start and completion logs only:\n%s", logs)
	}
	for _, expected := range []string{"phase=inspect", "completed=0 total=100 percent=0", "completed=100 total=100 percent=100"} {
		if !strings.Contains(logs, expected) {
			t.Errorf("progress logs did not contain %q:\n%s", expected, logs)
		}
	}
}
