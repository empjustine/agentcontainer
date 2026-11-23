// seenhosts.go — the untrusted certificate hint (d236).
//
// WHY this is a log event and not a file: a queue on disk would need rotation
// and would collect noise from peers that were never trusted. The line is a
// pasteable helper element; emitting it grants no trust.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

const eventSeenHosts = "seen_hosts"

type seenHostEntry struct {
	Endpoint string `json:"endpoint,omitempty"`
	Name     string `json:"name"`
	Public   string `json:"public"`
}

type seenHostRecord struct {
	TS             int64         `json:"ts"`
	SeverityNumber int           `json:"severityNumber"`
	Msg            string        `json:"msg"`
	Role           string        `json:"role"`
	Entry          seenHostEntry `json:"entry"`
}

func logSeenHost(role, endpoint, name, public string) error {
	if role != roleRelay && role != roleExit {
		return errors.New("seen_hosts role must be relay or exit")
	}
	if role == roleRelay && endpoint == "" {
		return errors.New("relay seen_hosts entry needs an endpoint")
	}
	if err := validPrincipal(name); err != nil {
		return fmt.Errorf("seen_hosts name: %w", err)
	}
	if _, _, err := parseEPubHeader([]string{public}); err != nil {
		return fmt.Errorf("seen_hosts public: %w", err)
	}
	if role == roleExit {
		endpoint = ""
	}
	record := seenHostRecord{
		TS:             time.Now().UnixMilli(),
		SeverityNumber: sevWarn.number(),
		Msg:            eventSeenHosts,
		Role:           role,
		Entry:          seenHostEntry{Endpoint: endpoint, Name: name, Public: public},
	}
	line, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("encode seen_hosts: %w", err)
	}
	fields := []journalField{
		{"EVENT", eventSeenHosts},
		{"ROLE", role},
		{"NAME", name},
		{"PUBLIC", public},
	}
	if endpoint != "" {
		fields = append(fields, journalField{"ENDPOINT", endpoint})
	}
	activeSink.emit(sevWarn, string(line), fields)
	return nil
}
