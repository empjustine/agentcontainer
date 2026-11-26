package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

type seenCapture struct {
	severity severity
	text     string
	fields   []journalField
}

func (s *seenCapture) emit(se severity, text string, fields []journalField) {
	s.severity = se
	s.text = text
	s.fields = fields
}

func captureSeen(t *testing.T) *seenCapture {
	t.Helper()
	resetSeenHosts()
	capture := &seenCapture{}
	prev := activeSink
	activeSink = capture
	t.Cleanup(func() { activeSink = prev })
	return capture
}

func seenCert(t *testing.T) string {
	t.Helper()
	der, err := mintPrincipalCertificate(testHostKey(t), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return encodeEPub(der)
}

func TestSeenHostRelayEvent(t *testing.T) {
	capture := captureSeen(t)
	public := seenCert(t)
	if err := logSeenHost(roleRelay, "https://exit.example:8443/vpn", "exit-home", public); err != nil {
		t.Fatal(err)
	}
	var record seenHostRecord
	if err := json.Unmarshal([]byte(capture.text), &record); err != nil {
		t.Fatal(err)
	}
	if record.Msg != eventSeenHosts || record.Role != roleRelay || record.SeverityNumber != sevWarn.number() {
		t.Fatalf("record header = %+v", record)
	}
	if record.Entry.Endpoint != "https://exit.example:8443/vpn" || record.Entry.Name != "exit-home" || record.Entry.Public != public {
		t.Fatalf("entry = %+v", record.Entry)
	}
	if capture.severity != sevWarn {
		t.Fatal("event did not carry warning severity")
	}
	got := make(map[string]string)
	for _, field := range capture.fields {
		got[field.name] = field.value
	}
	for key, want := range map[string]string{
		"EVENT": eventSeenHosts, "ROLE": roleRelay, "NAME": "exit-home",
		"PUBLIC": public, "ENDPOINT": "https://exit.example:8443/vpn",
	} {
		if got[key] != want {
			t.Fatalf("field %s = %q, want %q", key, got[key], want)
		}
	}
}

func TestSeenHostExitEvent(t *testing.T) {
	capture := captureSeen(t)
	public := seenCert(t)
	if err := logSeenHost(roleExit, "ignored", "relay_bazzite", public); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(capture.text, "ignored") {
		t.Fatal("exit event leaked an endpoint")
	}
	for _, field := range capture.fields {
		if field.name == "ENDPOINT" {
			t.Fatal("exit event carried an endpoint field")
		}
	}
}

func TestSeenHostRejects(t *testing.T) {
	captureSeen(t)
	public := seenCert(t)
	cases := []struct {
		name      string
		role      string
		endpoint  string
		principal string
		public    string
	}{
		{"role", "witness", "url", "exit-home", public},
		{"endpoint", roleRelay, "", "exit-home", public},
		{"principal", roleExit, "", "bad name", public},
		{"public", roleExit, "", "exit-home", "not-a-cert"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := logSeenHost(tc.role, tc.endpoint, tc.principal, tc.public); err == nil {
				t.Fatal("invalid seen_hosts input accepted")
			}
		})
	}
}

// TestSeenHostIsThrottled: the event is evidence, not an amplifier — a repeat
// from the same peer inside the window is dropped, a different peer still
// logs, and the dedupe window expires so a genuine later attempt is visible.
func TestSeenHostIsThrottled(t *testing.T) {
	capture := captureSeen(t)
	public := seenCert(t)
	first := time.Now()
	if err := logSeenHost(roleExit, "", "relay_bazzite", public); err != nil {
		t.Fatal(err)
	}
	emitted := capture.text
	if emitted == "" {
		t.Fatal("the first hint was not emitted")
	}
	if err := logSeenHost(roleExit, "", "relay_bazzite", public); err != nil {
		t.Fatal(err)
	}
	if capture.text != emitted {
		t.Fatal("a repeated hint inside the window was emitted again")
	}
	other := seenCert(t)
	if err := logSeenHost(roleExit, "", "relay_laptop", other); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(capture.text, "relay_laptop") {
		t.Fatal("a different peer's hint was suppressed")
	}
	// Age the WINDOW past its span: suppression is per window, so the same
	// peer becomes visible again.
	seenHostRecent.mu.Lock()
	seenHostRecent.windowStart = first.Add(-2 * seenHostWindow)
	seenHostRecent.mu.Unlock()
	if err := logSeenHost(roleExit, "", "relay_bazzite", public); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(capture.text, "relay_bazzite") {
		t.Fatal("an expired hint was not re-emitted")
	}
}

// TestSeenHostEmissionIsBudgeted: the window has a TOTAL budget, so a prober
// minting a fresh certificate per request cannot turn the mandated hint into a
// warn-log amplifier. Distinct peers inside the budget all log; past it the
// window stays quiet until it rolls over.
func TestSeenHostEmissionIsBudgeted(t *testing.T) {
	capture := captureSeen(t)
	for i := range seenHostBudget {
		capture.text = ""
		if err := logSeenHost(roleExit, "", "relay_filler", seenCert(t)); err != nil {
			t.Fatal(err)
		}
		if capture.text == "" {
			t.Fatalf("hint %d inside the budget was suppressed", i+1)
		}
	}
	capture.text = ""
	if err := logSeenHost(roleExit, "", "relay_genuine", seenCert(t)); err != nil {
		t.Fatal(err)
	}
	if capture.text != "" {
		t.Fatal("the budget did not bound a window's emissions")
	}

	// Roll the window over: the budget reopens and a genuine hint logs again.
	seenHostRecent.mu.Lock()
	seenHostRecent.windowStart = time.Now().Add(-2 * seenHostWindow)
	seenHostRecent.mu.Unlock()
	if err := logSeenHost(roleExit, "", "relay_genuine", seenCert(t)); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(capture.text, "relay_genuine") {
		t.Fatal("the next window did not reopen the budget")
	}
}
