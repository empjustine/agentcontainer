// relay.go — the bidirectional byte pump behind one established tunnel
// session (docs/d073 §5.2: VPN-R16 half-close, VPN-R18 backpressure,
// VPN-R14 keepalive).
//
// The SAME function runs in both roles: server relaying `local` (the
// target connection) against the tunnel, client relaying `local` (the
// application's connection) against the tunnel. The frame protocol is
// direction-symmetric, so one relay means one place where half-close,
// keepalive, idle reaping, and the no-unbounded-buffering rule live —
// and the client cannot grow a subtly different copy of them.
//
// Backpressure (VPN-R18) falls out of the shape: each direction reads at
// most one frame-worth of bytes before writing it, so a stalled peer stops
// the reader instead of filling a queue. The only timers are the
// keepalive ping and the idle reap — both provisional constants until spike
// S1 measures what the Funnel ingress actually reaps (VPN-R14).
package main

import (
	"errors"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// Provisional until S1 (d073 §13) measures the real Funnel reap budget:
// pings every 30s keep a quiet tunnel visibly alive; a tunnel silent for
// 90s (no DATA, PING, or PONG either direction) is reaped as idle.
const (
	tunnelKeepaliveInterval = 30 * time.Second
	tunnelIdleTimeout       = 90 * time.Second
)

// Relay lifecycle outcomes: the payload-free verdict the connection log
// records (VPN-R19). Values are stable vocabulary, not free text.
const (
	outcomeClosed         = "closed"       // both half-closes crossed cleanly
	outcomeIdleTimeout    = "idle-timeout" // nothing readable for tunnelIdleTimeout
	outcomePeerDisconnect = "peer-disconnected"
	outcomeLocalError     = "local-error" // the local/target socket broke
	outcomeProtocolError  = "protocol-error"
)

// relayStats is exactly the metadata VPN-R19 allows: byte counts by
// direction and an outcome — never payload, never timing per-frame.
type relayStats struct {
	sent     int64 // local → tunnel (server view: bytes received from the client)
	received int64 // tunnel → local (server view: bytes sent to the client)
	outcome  string
}

// closeWriter is the half-close half of VPN-R18's requirement: an HTTP
// client that finished its request body must still read the response, so
// shutting the write direction cannot tear the read direction down.
type closeWriter interface {
	CloseWrite() error
}

// relay runs until both directions have half-closed (outcome "closed"),
// one side fails, or the idle timer reaps the session. It closes both
// `ws` and `local` before returning — callers own no cleanup.
func relay(s tunnelStream, local net.Conn, keepalive, idle time.Duration) (relayStats, error) {
	var (
		stats    relayStats
		mu       sync.Mutex // first outcome wins; also carries its error
		errFinal error
	)
	setOutcome := func(outcome string, err error) {
		mu.Lock()
		if stats.outcome == "" {
			stats.outcome, errFinal = outcome, err
		}
		mu.Unlock()
	}

	var (
		localEOF   atomic.Bool // this side sent CLOSE (half-close of local→tunnel)
		peerClosed atomic.Bool // peer sent CLOSE (half-close of tunnel→local)
	)
	done := make(chan struct{})
	var stopOnce sync.Once
	stop := func() {
		stopOnce.Do(func() {
			close(done)
			_ = s.Close()
			_ = local.Close()
		})
	}
	bothClosed := func() {
		if localEOF.Load() && peerClosed.Load() {
			setOutcome(outcomeClosed, nil)
			stop()
		}
	}
	aborted := func() bool {
		select {
		case <-done:
			return true
		default:
			return false
		}
	}

	var wg sync.WaitGroup

	// tunnel → local: decode frames, write bytes, honor the peer's
	// half-close, answer protocol pings, enforce the idle reap.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			_ = s.setReadDeadline(time.Now().Add(idle))
			msg, err := s.readTunnelMsg()
			if err != nil {
				switch {
				case aborted():
					return // stop() already chose the outcome
				case isTimeout(err):
					setOutcome(outcomeIdleTimeout, err)
				case errors.Is(err, errWSClosed), errors.Is(err, io.EOF), errors.Is(err, net.ErrClosed):
					setOutcome(outcomePeerDisconnect, err)
				default:
					setOutcome(outcomeProtocolError, err)
				}
				stop()
				return
			}
			typ, _, payload, err := decodeFrame(msg)
			if err != nil {
				s.protocolViolation()
				setOutcome(outcomeProtocolError, err)
				stop()
				return
			}
			switch typ {
			case frameData:
				n, err := writeAll(local, payload)
				stats.received += int64(n)
				if err != nil {
					setOutcome(outcomeLocalError, err)
					stop()
					return
				}
			case frameClose:
				// Peer will send nothing more; drain still works: the
				// remaining tunnel→local direction stays open.
				halfCloseWrite(local)
				peerClosed.Store(true)
				bothClosed()
			case framePing:
				if err := sendFrame(s, framePong, payload); err != nil {
					setOutcome(outcomePeerDisconnect, err)
					stop()
					return
				}
			case framePong:
				// Activity evidence only; the read deadline above already
				// consumed it.
			default:
				// HELLO/CONNECT/CONNECTED/CONNECT_ERR belong to the session
				// preamble (see tunnelserver.go / client.go); a control frame
				// from the wrong phase is a protocol error.
				s.protocolViolation()
				setOutcome(outcomeProtocolError, errors.New("session control frame during relay"))
				stop()
				return
			}
			bothClosed()
		}
	}()

	// local → tunnel: read at most one frame's worth, send it, repeat
	// (bounded in-flight bytes — VPN-R18).
	wg.Add(1)
	go func() {
		defer wg.Done()
		buf := make([]byte, maxFramePayload)
		for {
			n, err := local.Read(buf)
			if n > 0 {
				if werr := sendFrame(s, frameData, buf[:n]); werr != nil {
					if !aborted() {
						setOutcome(outcomePeerDisconnect, werr)
						stop()
					}
					return
				}
				stats.sent += int64(n)
			}
			if err != nil {
				if aborted() {
					return
				}
				if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
					// Clean end of our direction: half-close, keep reading
					// the other direction (VPN-R18's request-body-done,
					// response-still-coming case).
					_ = sendFrame(s, frameClose, nil)
					localEOF.Store(true)
					bothClosed()
					return
				}
				setOutcome(outcomeLocalError, err)
				stop()
				return
			}
		}
	}()

	// Keepalive pings are protocol frames, not WebSocket-level pings: they
	// must be visible to OUR peer's idle timer on both ends (VPN-R14).
	wg.Add(1)
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(keepalive)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if err := sendFrame(s, framePing, nil); err != nil {
					if !aborted() {
						setOutcome(outcomePeerDisconnect, err)
						stop()
					}
					return
				}
			}
		}
	}()

	wg.Wait()
	mu.Lock()
	defer mu.Unlock()
	if stats.outcome == "" {
		// Unreachable in practice (every exit path sets one), but an
		// unset outcome would log as empty — say "closed" rather than lie.
		stats.outcome = outcomeClosed
	}
	return stats, errFinal
}

// sendFrame encodes and writes one protocol frame on any carrier: the
// frame bytes are identical, the carrier decides how they are delimited —
// one WebSocket binary message (d073 §5.1) or a length-prefixed span of an
// HTTP body (docs/d077 §5).
func sendFrame(s tunnelStream, typ byte, payload []byte) error {
	msg, err := encodeFrame(typ, tunnelStreamV1, payload)
	if err != nil {
		return err
	}
	return s.writeTunnelMsg(msg)
}

// halfCloseWrite shuts the local socket's send direction so the local peer
// observes EOF while the read direction keeps flowing. Every local conn in
// this module is TCP (hijacked or dialed), which has CloseWrite; the
// fallback exists so a non-TCP test conn degrades to a full close instead
// of panicking — TCP never takes it.
func halfCloseWrite(local net.Conn) {
	if cw, ok := local.(closeWriter); ok {
		_ = cw.CloseWrite()
		return
	}
	_ = local.Close()
}

// writeAll loops past partial writes (net.Conn.Write is allowed to write
// fewer bytes without error).
func writeAll(w io.Writer, b []byte) (int, error) {
	total := 0
	for len(b) > 0 {
		n, err := w.Write(b)
		total += n
		if err != nil {
			return total, err
		}
		b = b[n:]
	}
	return total, nil
}

// isTimeout reports a net timeout (the idle-reap signature) without
// string-matching.
func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}
