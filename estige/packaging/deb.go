package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"fmt"
	"time"
)

// termuxPrefix is the absolute root a Termux .deb installs into. The data tar
// paths are this prefix without the leading slash.
const termuxPrefix = "/data/data/com.termux/files/usr"

// pkgFile is one payload path shared by both writers. mode carries the full
// Unix st_mode (type bits included, as RPM wants); tar takes only the
// permission bits.
type pkgFile struct {
	path   string
	mode   int64
	data   []byte
	dir    bool
	config bool
}

// termuxFiles is the .deb payload table from the task spec: one binary, the
// env conffile, and a runit service shipped down.
func termuxFiles(binary []byte) []pkgFile {
	files := []pkgFile{
		{path: termuxPrefix + "/bin", mode: 0o040755, dir: true},
		{path: termuxPrefix + "/etc", mode: 0o040755, dir: true},
		{path: termuxPrefix + "/etc/estige", mode: 0o040755, dir: true},
		{path: termuxPrefix + "/var", mode: 0o040755, dir: true},
		{path: termuxPrefix + "/var/service", mode: 0o040755, dir: true},
		{path: termuxPrefix + "/var/service/estige", mode: 0o040755, dir: true},
		{path: termuxPrefix + "/var/service/estige/log", mode: 0o040755, dir: true},
		{path: termuxPrefix + "/var/log", mode: 0o040755, dir: true},
		{path: termuxPrefix + "/var/log/sv", mode: 0o040755, dir: true},
		{path: termuxPrefix + "/var/log/sv/estige", mode: 0o040755, dir: true},
		{path: termuxPrefix + "/bin/estige", mode: 0o100755, data: binary},
		{path: termuxPrefix + "/etc/estige/env", mode: 0o100600, data: embeddedFile("termux/env"), config: true},
		{path: termuxPrefix + "/var/service/estige/run", mode: 0o100755, data: embeddedFile("termux/service/run")},
		{path: termuxPrefix + "/var/service/estige/log/run", mode: 0o100755, data: embeddedFile("termux/service/log/run")},
		{path: termuxPrefix + "/var/service/estige/down", mode: 0o100644, data: embeddedFile("termux/service/down")},
	}
	return files
}

func buildDeb(version string, binary []byte) ([]byte, error) {
	now := time.Now()
	files := termuxFiles(binary)

	var installedKiB int64
	for _, f := range files {
		if !f.dir {
			installedKiB += (int64(len(f.data)) + 1023) / 1024
		}
	}

	control := fmt.Sprintf(`Package: estige
Version: %s
Architecture: aarch64
Maintainer: estige maintainers
Installed-Size: %d
Depends: termux-services
Section: net
Priority: optional
Description: SSL-VPN tunnel node for Termux
 One self-contained Go binary serving the estige exit node.
 Configuration is environment only: $PREFIX/etc/estige/env.
`, version, installedKiB)

	dataTar, err := tarGz(payloadEntries(files), now)
	if err != nil {
		return nil, err
	}
	controlTar, err := tarGz([]tarEntry{
		{name: "./control", mode: 0o644, data: []byte(control)},
		{name: "./postinst", mode: 0o755, data: embeddedFile("termux/postinst")},
		{name: "./conffiles", mode: 0o644, data: []byte(termuxPrefix + "/etc/estige/env\n")},
	}, now)
	if err != nil {
		return nil, err
	}

	var out bytes.Buffer
	if err := writeAr(&out, []arMember{
		{name: "debian-binary", data: []byte("2.0\n"), mode: 0o100644, modTime: now},
		{name: "control.tar.gz", data: controlTar, mode: 0o100644, modTime: now},
		{name: "data.tar.gz", data: dataTar, mode: 0o100644, modTime: now},
	}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

type tarEntry struct {
	name string
	mode int64
	data []byte
	dir  bool
}

func payloadEntries(files []pkgFile) []tarEntry {
	entries := make([]tarEntry, 0, len(files))
	for _, f := range files {
		name := "." + f.path
		if f.dir {
			name += "/"
		}
		entries = append(entries, tarEntry{
			name: name,
			mode: f.mode & 0o7777,
			data: f.data,
			dir:  f.dir,
		})
	}
	return entries
}

func tarGz(entries []tarEntry, now time.Time) ([]byte, error) {
	var buf bytes.Buffer
	gz, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if err != nil {
		return nil, err
	}
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		hdr := &tar.Header{
			Name:     e.name,
			Mode:     e.mode,
			ModTime:  now,
			Uid:      0,
			Gid:      0,
			Uname:    "root",
			Gname:    "root",
			Format:   tar.FormatGNU,
			Typeflag: tar.TypeReg,
			Size:     int64(len(e.data)),
		}
		if e.dir {
			hdr.Typeflag = tar.TypeDir
			hdr.Size = 0
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return nil, err
		}
		if !e.dir {
			if _, err := tw.Write(e.data); err != nil {
				return nil, err
			}
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
