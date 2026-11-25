// logging.go — one line per event, one sink per process (docs/d106, d155).
//
// WHY a sink instead of log.Printf everywhere: the same record has to reach
// two consumers with different needs. A stream consumer (a terminal, runit's
// svlogd, podman logs) wants the text line and nothing else; journald wants
// the fields, because it parses nothing out of a stream line. Both are the
// same line, so the producer builds it once and the sink decides how to hand
// it over — that is the whole reason this file exists (docs/d155, R3/R5).
//
// The stream path is byte-identical to the old log.Println output: the
// standard logger still carries it, so a test that redirects log.SetOutput
// keeps working and the Combined Log Format stays parseable by stock tools.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"
)

// severity is the one mapping table docs/d155 asks for: the stream's own
// vocabulary and syslog's live here together so a second table cannot appear.
type severity int

const (
	sevFatal severity = iota
	sevError
	sevWarn
	sevInfo
)

// priority is syslog's PRIORITY field (lower is worse).
func (s severity) priority() int {
	switch s {
	case sevFatal:
		return 2
	case sevError:
		return 3
	case sevWarn:
		return 4
	default:
		return 6
	}
}

// number is OpenTelemetry's SeverityNumber (docs/d151), so one jq predicate
// works on the journal and on any future JSONL stream.
func (s severity) number() int {
	switch s {
	case sevFatal:
		return 21
	case sevError:
		return 17
	case sevWarn:
		return 13
	default:
		return 9
	}
}

// journalField is one structured field, already spelled in journal case
// (uppercase, d155's naming rule) so the sink does no translation.
type journalField struct {
	name  string
	value string
}

// logSink receives every line this process emits.
type logSink interface {
	emit(s severity, text string, fields []journalField)
}

// streamSink is the unchanged behaviour (d155's "absent journal"): the
// standard logger writes the text to stderr, no fields, no protocol.
type streamSink struct{}

func (streamSink) emit(_ severity, text string, _ []journalField) { log.Print(text) }

func init() {
	// The access line carries its own bracketed timestamp; the standard
	// logger's "2009/01/02 15:04:05" prefix would break the CLF grammar.
	log.SetFlags(0)
}

// activeSink is process-wide because a line has no owner to thread a sink
// through: the exit node's handlers, the relay's listeners and the CLI verbs
// all emit from different call stacks.
var activeSink logSink = streamSink{}

// logLine emits one preformatted line with no structured fields.
func logLine(s severity, format string, args ...any) {
	activeSink.emit(s, fmt.Sprintf(format, args...), nil)
}

// fatalLine is log.Fatalf with the severity the journal needs: the line is
// emitted (so systemd records an error, not whatever stderr defaults to) and
// then the process exits 1, as log.Fatalf would.
func fatalLine(format string, args ...any) {
	logLine(sevError, format, args...)
	os.Exit(1)
}

// sessionRecord is d106's per-session record. One struct for open, close and
// refused keeps the three shapes from drifting into three vocabularies: a
// field that does not apply stays empty and is simply not printed.
type sessionRecord struct {
	Role      string // exit | relay
	Event     string // open | close | refused
	ID        string // 32 lowercase hex, shared by both nodes
	Key       string // matched operator key id; "-" when the node never saw it
	Label     string // client label from HELLO
	Via       string // connect | socks5 | http | forward (relay only)
	Transport string // h2 | wss | post
	Target    string // host:port the operator asked for
	URL       string // relay only: the URL form the client spoke
	Outcome   string // close only
	Reason    string // refused only
	Up        int64  // client -> origin
	Down      int64  // origin -> client
	Duration  int64  // milliseconds
}

// emit sends the record at the severity its event class owns.
func (r sessionRecord) emit() {
	s := sevInfo
	if r.Event == eventRefused {
		s = sevWarn
	}
	activeSink.emit(s, r.text(), r.fields())
}

// text renders the logfmt line d106 specifies. Quoting is %q on the
// operator-supplied strings (label, target, URL) so neither a space nor a
// newline can forge a second record; the closed vocabularies print bare.
func (r sessionRecord) text() string {
	var b strings.Builder
	b.WriteString("ts=")
	b.WriteString(strconv.FormatInt(time.Now().UnixMilli(), 10))
	add := func(k, v string) {
		b.WriteByte(' ')
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(v)
	}
	add("role", r.Role)
	add("event", r.Event)
	if r.ID != "" {
		add("id", r.ID)
	}
	add("key", keyOrDash(r.Key))
	if r.Label != "" {
		add("label", strconv.Quote(r.Label))
	}
	if r.Via != "" {
		add("via", r.Via)
	}
	if r.Transport != "" {
		add("transport", r.Transport)
	}
	if r.Target != "" {
		add("target", strconv.Quote(r.Target))
	}
	if r.URL != "" {
		add("url", strconv.Quote(r.URL))
	}
	if r.Event == eventClose {
		add("bytes_up", strconv.FormatInt(r.Up, 10))
		add("bytes_down", strconv.FormatInt(r.Down, 10))
		add("duration_ms", strconv.FormatInt(r.Duration, 10))
		add("outcome", r.Outcome)
	}
	if r.Reason != "" {
		add("reason", r.Reason)
	}
	return b.String()
}

// fields is the same record in journal spelling (d155: d106's names made
// uppercase). ts is absent on purpose — journald stamps __REALTIME_TIMESTAMP
// and a second clock in the payload would be a second truth.
func (r sessionRecord) fields() []journalField {
	f := []journalField{
		{"EVENT", r.Event},
		{"ROLE", r.Role},
	}
	add := func(k, v string) {
		if v != "" {
			f = append(f, journalField{k, v})
		}
	}
	add("ID", r.ID)
	add("KEY", keyOrDash(r.Key))
	add("LABEL", r.Label)
	add("VIA", r.Via)
	add("TRANSPORT", r.Transport)
	add("TARGET", r.Target)
	add("URL", r.URL)
	add("OUTCOME", r.Outcome)
	add("REASON", r.Reason)
	if r.Event == eventClose {
		add("BYTES_UP", strconv.FormatInt(r.Up, 10))
		add("BYTES_DOWN", strconv.FormatInt(r.Down, 10))
		add("DURATION_MS", strconv.FormatInt(r.Duration, 10))
	}
	return f
}

func keyOrDash(key string) string {
	if key == "" {
		return "-"
	}
	return key
}

// newSessionID mints the per-session correlation id docs/d106 defines: 16
// random bytes as 32 lowercase hex — the shape h2-post-windowed puts on the
// wire as a W3C trace-id (and the shape its parser accepts).
func newSessionID() (string, error) {
	var b [16]byte
	for {
		if _, err := rand.Read(b[:]); err != nil {
			return "", err
		}
		id := hex.EncodeToString(b[:])
		if strings.Trim(id, "0") != "" {
			return id, nil
		}
	}
}

// validSessionID is the acceptance rule for the X-Estige-Session header: a
// value that does not match is ignored and a local id is minted instead. The
// header is diagnostic metadata, never an authorization input (d106), so a
// forged value can only break a join, not a session.
func validSessionID(s string) bool {
	if len(s) != 32 {
		return false
	}
	for _, r := range s {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}

// Event discriminators (docs/d106). Three, and only three: a session opens,
// closes, or never opens.
const (
	eventOpen    = "open"
	eventClose   = "close"
	eventRefused = "refused"
)

// via names the local surface a session arrived from (docs/d106). The exit
// node cannot tell SOCKS5 from CONNECT on the wire, so it always says
// connect; the relay reports the door its own client used.
const (
	viaConnect = "connect"
	viaSOCKS   = "socks5"
	viaHTTP    = "http"
	viaForward = "forward"
)

// sessionIDHeader carries the correlation id on the session-opening request
// of every carrier (docs/d106). It rides in cleartext under the Funnel edge,
// so it is a hint: the exit validates it before logging and mints its own
// otherwise.
const sessionIDHeader = "X-Estige-Session"
