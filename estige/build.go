//go:build ignore

// build.go — build the estige container image from the binary on this host.
//
// WHY a standalone file: `go run build.go` compiles this file alone, so the
// image path never re-enters the unit's node builder and the binary is the
// one the operator already built with `go build .` (d236). No second compile
// happens here — a host toolchain is a prerequisite, stated loudly.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const imageContainerfile = `FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates busybox-static && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/lib/estige/.local/share
# The store is a bind mount from the host (run.go); the image only owns the
# path, so the operator's provisioned keys keep their host ownership.
ENV XDG_DATA_HOME=/var/lib/estige/.local/share
COPY --chown=65532:65532 estige /usr/local/bin/estige
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/estige"]
`

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "estige build: "+format+"\n", args...)
	os.Exit(1)
}

func containerTool() string {
	for _, tool := range []string{"podman", "docker"} {
		if _, err := exec.LookPath(tool); err == nil {
			return tool
		}
	}
	fatal("neither podman nor docker is on PATH; install one to build the image")
	return ""
}

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "-h" || os.Args[1] == "--help") {
		fmt.Println("usage: go run build.go   # builds localhost/estige:<VERSION> from ./estige")
		return
	}
	pwd, err := os.Getwd()
	if err != nil {
		fatal("cwd: %v", err)
	}
	version, err := os.ReadFile(filepath.Join(pwd, "packaging", "VERSION"))
	if err != nil {
		fatal("version: %v", err)
	}
	tag := os.Getenv("IMAGE_TAG")
	if tag == "" {
		tag = "localhost/estige:" + strings.TrimSpace(string(version))
	}
	tool := containerTool()
	ctx, err := os.MkdirTemp("", "estige-image")
	if err != nil {
		fatal("build context: %v", err)
	}
	defer os.RemoveAll(ctx)
	binary, err := os.ReadFile(filepath.Join(pwd, "estige"))
	if err != nil {
		fatal("build ./estige first (go build .): %v", err)
	}
	if err := os.WriteFile(filepath.Join(ctx, "estige"), binary, 0o755); err != nil {
		fatal("stage binary: %v", err)
	}
	if err := os.WriteFile(filepath.Join(ctx, "Containerfile"), []byte(imageContainerfile), 0o644); err != nil {
		fatal("stage Containerfile: %v", err)
	}
	// Both backends take the same explicit `build` subcommand; podman's
	// `image build` alias is optional and its argument order differs from
	// docker's, so one spelling keeps the two from drifting.
	args := []string{"build", "--pull", "-t", tag, "-f", "Containerfile", "."}
	cmd := exec.Command(tool, args...)
	cmd.Dir = ctx
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			fatal("%s build exited %d", tool, exit.ExitCode())
		}
		fatal("run %s: %v", tool, err)
	}
	fmt.Printf("estige build: %s\n", tag)
}
