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

var forwardedEnv = []string{
	"PORT", "PORT_CLOUDFLARE",
	"VPN_OPERATOR_KEYS", "VPN_OPERATOR_TOKEN", "VPN_TUNNEL_URL",
	"VPN_TUNNEL_EGRESS", "VPN_CLIENT_LABEL",
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
	store := os.Getenv("ESTIGE_STORE_DIR")
	if store == "" {
		store = "/var/lib/estige"
	}
	run := []string{"run", "--rm", "--network", "host", "-v", store + ":/var/lib/estige"}
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
