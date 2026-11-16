// journald.go — the journal protocol sink (docs/d155).
//
// WHY the raw protocol and not sd_journal_send: the binary is built
// CGO_ENABLED=0 (docs/d120's packages, the Containerfile), and libsystemd
// arrives through cgo. The protocol is a Unix datagram of FIELD=value lines —
// exactly what the library writes — so a static binary reaches it with
// net.DialUnix and no dependency.
//
// WHY detection is JOURNAL_STREAM and not a flag: systemd sets the variable
// only for a service whose output it attached to the journal, and it names the
// stream by device:inode. Comparing it with our own stderr/stdout is the one
// signal that says "the journal is the consumer" without inventing a knob
// (d155, R1). Everything else — a terminal, podman, runit — keeps the stream
// path byte for byte.
package main

import (
	"context"
	"encoding/binary"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

// journalSocketPath is a variable so a test can own it (d155): the suite must
// not require a running journald, and nothing reads this path from the
// environment.
var journalSocketPath = "/run/systemd/journal/socket"

// journalMu serializes datagrams: one Write per entry is the protocol's
// requirement (a split datagram is a mangled entry), and emitting from
// several goroutines must not interleave.
type journalSink struct {
	mu   sync.Mutex
	conn net.Conn
}

// emit sends one entry and never fails the daemon (d155, R2): a socket that
// disappears falls back to the stream path with one warning, because logging
// is not allowed to be the reason a tunnel dies.
func (j *journalSink) emit(s severity, text string, fields []journalField) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.conn == nil {
		streamSink{}.emit(s, text, fields)
		return
	}
	if _, err := j.conn.Write(journalDatagram(s, text, fields)); err != nil {
		_ = j.conn.Close()
		j.conn = nil
		streamSink{}.emit(sevWarn, "[estige] journal socket write failed, falling back to stderr: "+err.Error(), nil)
		streamSink{}.emit(s, text, fields)
	}
}

// installLogSink switches the process to the journal when it is detected.
// Called once, before the first line (R1); a false return leaves the stream
// path untouched.
func installLogSink() bool {
	if !journalStreamMatches() {
		return false
	}
	var d net.Dialer
	conn, err := d.DialContext(context.Background(), "unixgram", journalSocketPath)
	if err != nil {
		logLine(sevWarn, "[estige] journal detected but %s is unreachable, writing stderr instead: %v", journalSocketPath, err)
		return false
	}
	activeSink = &journalSink{conn: conn}
	return true
}

// journalStreamMatches compares JOURNAL_STREAM's device:inode with this
// process's two output streams. A malformed value is a mismatch: guessing
// would put fields into a consumer that did not ask for them.
func journalStreamMatches() bool {
	raw := os.Getenv("JOURNAL_STREAM")
	devText, inoText, ok := strings.Cut(raw, ":")
	if !ok {
		return false
	}
	dev, err := strconv.ParseUint(devText, 10, 64)
	if err != nil {
		return false
	}
	ino, err := strconv.ParseUint(inoText, 10, 64)
	if err != nil {
		return false
	}
	for _, f := range []*os.File{os.Stdout, os.Stderr} {
		if journalStreamIs(f, dev, ino) {
			return true
		}
	}
	return false
}

func journalStreamIs(f *os.File, dev, ino uint64) bool {
	info, err := f.Stat()
	if err != nil {
		return false
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return false
	}
	return uint64(st.Dev) == dev && uint64(st.Ino) == ino
}

// journalDatagram renders one entry: PRIORITY and SEVERITY_NUMBER on every
// line (R4), the text as MESSAGE (R3), then this record's fields.
//
// Values are written in the journal's binary form only when they contain a
// newline: the text form's field separator is a newline, so a value with one
// would otherwise forge a second field. Every value we emit is operator-shaped
// text (a host name, a label, an error sentence) but %q-quoting is not a
// guarantee the protocol understands, so the encoder owns the rule.
func journalDatagram(s severity, text string, fields []journalField) []byte {
	var b []byte
	appendText := func(name, value string) {
		if strings.ContainsRune(value, '\n') {
			b = append(b, name...)
			b = append(b, '\n')
			var size [8]byte
			binary.LittleEndian.PutUint64(size[:], uint64(len(value)))
			b = append(b, size[:]...)
			b = append(b, value...)
			b = append(b, '\n')
			return
		}
		b = append(b, name...)
		b = append(b, '=')
		b = append(b, value...)
		b = append(b, '\n')
	}
	appendText("PRIORITY", strconv.Itoa(s.priority()))
	appendText("SEVERITY_NUMBER", strconv.Itoa(s.number()))
	appendText("SYSLOG_IDENTIFIER", logIdentifier())
	appendText("TOOL", "estige")
	appendText("MESSAGE", text)
	for _, f := range fields {
		appendText(f.name, f.value)
	}
	return b
}

// logIdentifier is the binary's name by role (d088): the two deployments
// are different units and must be distinguishable in the journal.
func logIdentifier() string {
	if nodeRole == roleRelay {
		return "estige-relay"
	}
	return "estige"
}
