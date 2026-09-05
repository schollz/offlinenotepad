package main

import (
	"reflect"
	"testing"
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
