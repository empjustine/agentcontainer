package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestFrameRoundTrip(t *testing.T) {
	for _, typ := range []byte{frameHello, frameHelloOK, frameConnect, frameConnected, frameConnectErr, frameClose, framePing, framePong, frameData} {
		payload := []byte("payload-" + string(rune('A'+typ)))
		msg, err := encodeFrame(typ, tunnelStreamV1, payload)
		if err != nil {
			t.Fatalf("type %d: encode: %v", typ, err)
		}
		gotType, gotStream, gotPayload, err := decodeFrame(msg)
		if err != nil {
			t.Fatalf("type %d: decode: %v", typ, err)
		}
		if gotType != typ || gotStream != tunnelStreamV1 || !bytes.Equal(gotPayload, payload) {
			t.Fatalf("type %d: round trip mismatch: got (%d, %d, %q)", typ, gotType, gotStream, gotPayload)
		}
	}
}

// Frame validation is the anti-corruption layer in front of the relay: a
// peer that lies about length, sets reserved bits, or speaks a future
// stream id must be rejected BEFORE anything is written anywhere
// (VPN-R17's reserved stream id, VPN-R39's bounds).
func TestDecodeRejectsMalformedFrames(t *testing.T) {
	valid, err := encodeFrame(frameData, 0, []byte("x"))
	if err != nil {
		t.Fatal(err)
	}

	cases := map[string][]byte{
		"short header":   valid[:frameHeaderLen-1],
		"trailing bytes": append(append([]byte{}, valid...), 'y'),
		"stream id set":  withStreamID(valid, 7),
		"flags set":      withFlags(valid, 0x01),
		"unknown type":   withType(valid, 42),
		"oversize decl":  withLength(valid, maxFramePayload+1),
	}
	for name, msg := range cases {
		if _, _, _, err := decodeFrame(msg); !errors.Is(err, ErrProtocol) {
			t.Errorf("%s: expected ErrProtocol, got %v", name, err)
		}
	}

	if _, _, _, err := decodeFrame(nil); !errors.Is(err, ErrProtocol) {
		t.Errorf("empty message: expected ErrProtocol, got %v", err)
	}
}

func TestEncodeBoundsPayload(t *testing.T) {
	if _, err := encodeFrame(frameData, 0, make([]byte, maxFramePayload+1)); !errors.Is(err, ErrProtocol) {
		t.Fatalf("expected oversize payload rejected at encode, got %v", err)
	}
}

// VPN-R15: the opening HELLO carries magic + version + label, and every
// deviation is fatal rather than "close enough".
func TestHelloRoundTripAndRejections(t *testing.T) {
	msg, err := encodeHello("laptop-deck")
	if err != nil {
		t.Fatal(err)
	}
	version, label, err := decodeHello(msg)
	if err != nil || version != tunnelVersion || label != "laptop-deck" {
		t.Fatalf("got (%d, %q, %v)", version, label, err)
	}

	if _, err := encodeHello(strings.Repeat("x", tunnelLabelMax+1)); !errors.Is(err, ErrProtocol) {
		t.Errorf("oversize label: expected ErrProtocol, got %v", err)
	}

	good, _ := encodeHello("laptop-deck")
	badMagic := append([]byte{}, good...)
	badMagic[0] ^= 0xff
	if _, _, err := decodeHello(badMagic); !errors.Is(err, ErrProtocol) {
		t.Errorf("bad magic: expected ErrProtocol, got %v", err)
	}

	badVersion := append([]byte{}, good...)
	badVersion[len(tunnelMagic)] = tunnelVersion + 1
	if _, _, err := decodeHello(badVersion); !errors.Is(err, ErrProtocol) {
		t.Errorf("bad version: expected ErrProtocol, got %v", err)
	}

	if _, _, err := decodeHello(good[:len(good)-1]); !errors.Is(err, ErrProtocol) {
		t.Errorf("truncated label: expected ErrProtocol, got %v", err)
	}
}

// CONNECT_ERR reasons are a vocabulary the client and the log key on —
// pin them so a rename cannot silently split the two.
func TestConnectErrReasonsAreStable(t *testing.T) {
	want := map[string]bool{
		"target-ip-literal": true,
		"port-denied":       true,
		"egress-denied":     true,
		"resolve-failed":    true,
		"dial-failed":       true,
		"invalid-target":    true,
	}
	got := map[string]bool{
		errReasonTargetIP:   true,
		errReasonPortDenied: true,
		errReasonDenied:     true,
		errReasonResolve:    true,
		errReasonDial:       true,
		errReasonInvalid:    true,
	}
	for k := range want {
		if !got[k] {
			t.Errorf("reason %q drifted", k)
		}
	}
	if len(got) != len(want) {
		t.Errorf("reason set size changed: %v", got)
	}
}

func withStreamID(msg []byte, id uint16) []byte {
	out := append([]byte{}, msg...)
	out[4] = byte(id >> 8)
	out[5] = byte(id)
	return out
}

func withFlags(msg []byte, f byte) []byte {
	out := append([]byte{}, msg...)
	out[7] = f
	return out
}

func withType(msg []byte, typ byte) []byte {
	out := append([]byte{}, msg...)
	out[6] = typ
	return out
}

func withLength(msg []byte, n uint32) []byte {
	out := append([]byte{}, msg...)
	out[0] = byte(n >> 24)
	out[1] = byte(n >> 16)
	out[2] = byte(n >> 8)
	out[3] = byte(n)
	return out
}
