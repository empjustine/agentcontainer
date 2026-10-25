// tunnelproto.go — the tunnel's application-layer protocol (modes C–E)
// (docs/d073 §5.2: VPN-R15..R19, VPN-R39).
//
// The transport under this protocol is one WebSocket per CONNECT (VPN-R17),
// but the protocol itself deliberately does not lean on WebSocket framing for
// its shape: every tunnel frame is length-prefixed and self-delimiting, so
// the codec reads as a byte-stream protocol and survives a future transport
// change (and makes the mux a field addition, not a redesign — the stream id
// is reserved from version 1 exactly so VPN-R17's v3 mux is additive).
// One tunnel frame rides in one WebSocket binary message.
//
// Authentication does NOT appear here (VPN-R12): credentials ride the
// WebSocket handshake header, so by the time a HELLO is decoded the peer is
// already the operator. The client label in HELLO is non-secret identity for
// the connection log (VPN-R19), not a credential.
package main

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// Tunnel protocol version and HELLO magic (VPN-R15: "a fixed magic/version
// in the opening HELLO"). The magic never changes; the version does.
const (
	tunnelVersion  = 1
	tunnelMagic    = "lrpx"
	tunnelLabelMax = 64
	tunnelErrMax   = 128
)

// Frame types (VPN-R16's required control set, plus the data frame).
// v1 uses stream id 0 for every frame; the field exists (and is validated)
// so the v3 stream mux needs no version bump (VPN-R17).
const (
	frameHello      byte = 1
	frameHelloOK    byte = 2
	frameConnect    byte = 3
	frameConnected  byte = 4
	frameConnectErr byte = 5
	frameClose      byte = 6 // half-close of the sender's direction
	framePing       byte = 7
	framePong       byte = 8
	frameData       byte = 9
	tunnelStreamV1       = 0
)

// Frame payload cap: bounds per-frame allocation (VPN-R39) while staying far
// above a TLS record (16 KiB) so the relay never fragments ordinary traffic.
const maxFramePayload = 64 << 10

// frameHeaderLen is the fixed prefix: u32 payload length, u16 stream id,
// u8 type, u8 reserved flags.
const frameHeaderLen = 8

// CONNECT_ERR reasons: a small, stable vocabulary so the client (and the
// connection log) can distinguish policy outcomes from transport outcomes
// without the server leaking resolver or host internals.
const (
	errReasonTargetIP   = "target-ip-literal" // VPN-R22: resolution stays server-side
	errReasonPortDenied = "port-denied"       // VPN-R37
	errReasonDenied     = "egress-denied"     // VPN-R35/36
	errReasonResolve    = "resolve-failed"
	errReasonDial       = "dial-failed"
	errReasonInvalid    = "invalid-target"
)

// ErrProtocol marks a peer that spoke the protocol wrong; callers tear the
// tunnel down (there is no in-protocol recovery — one stream, one life).
var ErrProtocol = errors.New("tunnel protocol error")

// encodeFrame renders one frame: fixed header + payload.
func encodeFrame(typ byte, stream uint16, payload []byte) ([]byte, error) {
	if len(payload) > maxFramePayload {
		return nil, fmt.Errorf("%w: frame payload %d exceeds %d", ErrProtocol, len(payload), maxFramePayload)
	}
	buf := make([]byte, frameHeaderLen+len(payload))
	binary.BigEndian.PutUint32(buf[0:4], uint32(len(payload)))
	binary.BigEndian.PutUint16(buf[4:6], stream)
	buf[6] = typ
	// buf[7] stays zero: flags are reserved by version 1 (VPN-R15). A peer
	// must not set them before a version defines them — checked on decode.
	copy(buf[frameHeaderLen:], payload)
	return buf, nil
}

// decodeFrame parses a complete frame and validates the v1 contract:
// declared length matches the bytes, payload is within the cap, flags are
// zero, the type is one version 1 defined, and the stream id is the
// unmuxed 0 (VPN-R17 — anything else is a v3 frame arriving early).
func decodeFrame(msg []byte) (typ byte, stream uint16, payload []byte, err error) {
	if len(msg) < frameHeaderLen {
		return 0, 0, nil, fmt.Errorf("%w: short frame (%d bytes)", ErrProtocol, len(msg))
	}
	n := binary.BigEndian.Uint32(msg[0:4])
	if n > maxFramePayload {
		return 0, 0, nil, fmt.Errorf("%w: declared payload %d exceeds %d", ErrProtocol, n, maxFramePayload)
	}
	if int(n) != len(msg)-frameHeaderLen {
		return 0, 0, nil, fmt.Errorf("%w: length %d does not match %d payload bytes", ErrProtocol, n, len(msg)-frameHeaderLen)
	}
	stream = binary.BigEndian.Uint16(msg[4:6])
	if stream != tunnelStreamV1 {
		return 0, 0, nil, fmt.Errorf("%w: stream id %d in version 1 (unmuxed, VPN-R17)", ErrProtocol, stream)
	}
	typ = msg[6]
	if msg[7] != 0 {
		return 0, 0, nil, fmt.Errorf("%w: reserved flags set", ErrProtocol)
	}
	if !definedFrameType(typ) {
		return 0, 0, nil, fmt.Errorf("%w: unknown frame type %d", ErrProtocol, typ)
	}
	return typ, stream, msg[frameHeaderLen:], nil
}

func definedFrameType(typ byte) bool {
	return typ >= frameHello && typ <= frameData
}

// readTunnelFrame reads one WebSocket message carrying exactly one protocol
// frame. The tunnel protocol is binary-only (VPN-R15); readMessage has
// already consumed control frames, so anything non-binary here is a peer
// speaking the wrong protocol.
func readTunnelFrame(ws *wsConn) ([]byte, error) {
	opcode, msg, err := ws.readMessage()
	if err != nil {
		return nil, err
	}
	if opcode != wsOpBinary {
		return nil, fmt.Errorf("%W: non-binary message in the tunnel", ErrProtocol)
	}
	return msg, nil
}

// encodeHello renders the opening HELLO payload: magic, version, then the
// non-secret client label (VPN-R16). Length-prefixed so a label change can
// never shift the version bytes.
func encodeHello(label string) ([]byte, error) {
	if len(label) > tunnelLabelMax {
		return nil, fmt.Errorf("%w: client label longer than %d bytes", ErrProtocol, tunnelLabelMax)
	}
	buf := make([]byte, 0, len(tunnelMagic)+2+len(label))
	buf = append(buf, tunnelMagic...)
	buf = append(buf, byte(tunnelVersion), byte(len(label)))
	buf = append(buf, label...)
	return buf, nil
}

// decodeHello validates the magic/version/label triple. A wrong magic means
// this is not the tunnel protocol at all; a wrong version means the peer
// speaks a protocol version we do not — both are fatal to the session.
func decodeHello(payload []byte) (version byte, label string, err error) {
	if len(payload) < len(tunnelMagic)+2 {
		return 0, "", fmt.Errorf("%w: truncated HELLO", ErrProtocol)
	}
	if string(payload[:len(tunnelMagic)]) != tunnelMagic {
		return 0, "", fmt.Errorf("%w: bad HELLO magic", ErrProtocol)
	}
	version = payload[len(tunnelMagic)]
	if version != tunnelVersion {
		return 0, "", fmt.Errorf("%w: peer speaks version %d, we speak %d", ErrProtocol, version, tunnelVersion)
	}
	ll := int(payload[len(tunnelMagic)+1])
	if ll > tunnelLabelMax || len(payload) != len(tunnelMagic)+2+ll {
		return 0, "", fmt.Errorf("%w: bad HELLO label length", ErrProtocol)
	}
	return version, string(payload[len(tunnelMagic)+2:]), nil
}
