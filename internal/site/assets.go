// Package site exposes the optimized Vite build embedded in the Go binary.
package site

import (
	"embed"
	"io/fs"
)

//go:embed build/* build/static/*
var files embed.FS

func Content() fs.FS {
	content, err := fs.Sub(files, "build")
	if err != nil {
		panic(err)
	}
	return content
}
