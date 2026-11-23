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
