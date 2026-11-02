// Command estige-packaging writes the Termux .deb and Oracle Linux .rpm from
// format inputs beside this file. The build target passes the already-built
// binaries; this program only formats them, so it needs no packaging tool on
// the host (docs/d102, estige/README.md).
package main

import (
	"embed"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

//go:embed VERSION termux ol
var packagingFS embed.FS

// versionPattern is deliberately narrower than Debian's or RPM's grammars: it
// is the intersection of what both accept and what a git tag can carry. A
// dash would split RPM's version/release and Debian's version/revision.
var versionPattern = regexp.MustCompile(`^[0-9][0-9A-Za-z.+~_]*$`)

func main() {
	versionFlag := flag.String("version", "", "package version (default: embedded VERSION, override with ESTIGE_VERSION)")
	releaseFlag := flag.String("release", "1", "RPM release number")
	debBinary := flag.String("deb-binary", "", "path to the android/arm64 estige binary for the .deb")
	rpmBinary := flag.String("rpm-binary", "", "path to the linux/amd64 estige binary for the .rpm")
	outDir := flag.String("out", "out", "output directory")
	flag.Parse()

	if err := run(*versionFlag, *releaseFlag, *debBinary, *rpmBinary, *outDir); err != nil {
		fmt.Fprintln(os.Stderr, "estige-packaging:", err)
		os.Exit(1)
	}
}

func run(versionFlag, release, debBinary, rpmBinary, outDir string) error {
	version, err := packageVersion(versionFlag)
	if err != nil {
		return err
	}
	if !regexp.MustCompile(`^[0-9]+$`).MatchString(release) {
		return fmt.Errorf("release %q must be a bare integer", release)
	}
	if debBinary == "" && rpmBinary == "" {
		return errors.New("nothing to package: pass -deb-binary and/or -rpm-binary")
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}

	if debBinary != "" {
		bin, err := os.ReadFile(debBinary)
		if err != nil {
			return err
		}
		artifact, err := buildDeb(version, bin)
		if err != nil {
			return fmt.Errorf("deb: %w", err)
		}
		name := fmt.Sprintf("estige_%s_aarch64.deb", version)
		path := filepath.Join(outDir, name)
		if err := os.WriteFile(path, artifact, 0o644); err != nil {
			return err
		}
		fmt.Println(path)
	}

	if rpmBinary != "" {
		bin, err := os.ReadFile(rpmBinary)
		if err != nil {
			return err
		}
		artifact, err := buildRPM(version, release, bin)
		if err != nil {
			return fmt.Errorf("rpm: %w", err)
		}
		name := fmt.Sprintf("estige-%s-%s.x86_64.rpm", version, release)
		path := filepath.Join(outDir, name)
		if err := os.WriteFile(path, artifact, 0o644); err != nil {
			return err
		}
		fmt.Println(path)
	}
	return nil
}

func packageVersion(flagValue string) (string, error) {
	version := strings.TrimSpace(flagValue)
	if version == "" {
		version = strings.TrimSpace(os.Getenv("ESTIGE_VERSION"))
	}
	if version == "" {
		raw, err := packagingFS.ReadFile("VERSION")
		if err != nil {
			return "", err
		}
		version = strings.TrimSpace(string(raw))
	}
	if !versionPattern.MatchString(version) {
		return "", fmt.Errorf("version %q must match %s (no dash: RPM release is separate)", version, versionPattern)
	}
	return version, nil
}

func embeddedFile(name string) []byte {
	data, err := packagingFS.ReadFile(name)
	if err != nil {
		panic("embedded packaging file missing: " + name)
	}
	return data
}
