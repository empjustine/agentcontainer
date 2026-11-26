//go:build ignore

// run.go — run the image built by build.go; no restart policy, no rebuild.
//
// WHY the env is forwarded by NAME: an --env-file keeps credentials out of
// argv and out of this process's logging, while the -e list keeps the set of
// variables the binary can see explicit (d236's open detail resolved here).
package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// forwardedEnv is every non-secret variable the binary reads (d236): the
// identity, pairing and policy come from the store the operator mounts, never
// from this process's environment.
//
// XDG_DATA_HOME is deliberately NOT here: the image already pins it to
// /var/lib/estige/.local/share, which is where the store is mounted, so
// forwarding the host's value would point the container at a directory it
// cannot see and both roles would refuse at boot.
var forwardedEnv = []string{
	"PORT", "PORT_CLOUDFLARE", "VPN_CLIENT_LABEL",
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "estige run: "+format+"\n", args...)
	os.Exit(1)
}

func containerTool() string {
	for _, tool := range []string{"podman", "docker"} {
		if _, err := exec.LookPath(tool); err == nil {
			return tool
		}
	}
	fatal("neither podman nor docker is on PATH")
	return ""
}

func main() {
	args := os.Args[1:]
	if len(args) > 0 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Println("usage: go run run.go [args...]   # args are forwarded to /usr/local/bin/estige")
		return
	}
	tool := containerTool()
	version, err := os.ReadFile("packaging/VERSION")
	if err != nil {
		fatal("version: %v", err)
	}
	tag := os.Getenv("IMAGE_TAG")
	if tag == "" {
		tag = "localhost/estige:" + strings.TrimSpace(string(version))
	}
	// stateDir is the HOST directory the image's state mount comes from, named
	// for that job and not for the store: the store lives one level deeper, at
	// <stateDir>/.local/share/estige, because the image pins XDG_DATA_HOME to
	// /var/lib/estige/.local/share. Pointing this at a store root itself would
	// hand the container an empty mount and both roles would refuse at boot —
	// which is why the mount is logged with the store path it produces.
	stateDir := os.Getenv("ESTIGE_STATE_DIR")
	if stateDir == "" {
		stateDir = "/var/lib/estige"
	}
	fmt.Fprintf(os.Stderr, "estige run: mounting %s at /var/lib/estige (store: %s/.local/share/estige)\n",
		stateDir, strings.TrimSuffix(stateDir, "/"))
	run := []string{"run", "--rm", "--network", "host", "-v", stateDir + ":/var/lib/estige"}
	if envFile := os.Getenv("ESTIGE_ENV_FILE"); envFile != "" {
		run = append(run, "--env-file", envFile)
	} else {
		for _, name := range forwardedEnv {
			if _, ok := os.LookupEnv(name); ok {
				run = append(run, "-e", name)
			}
		}
	}
	run = append(run, tag)
	run = append(run, args...)
	cmd := exec.Command(tool, run...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		fatal("%s run: %v", tool, err)
	}
}
