// tunnelserver.go — the tunnel's server role (modes C–E): the `/<prefix>/vpn` namespace
// (docs/d073 §5: VPN-R11..R22, §8: VPN-R31..R34, §10: VPN-R44).
//
// Dispatch is by path only (VPN-R42): main's ServeHTTP hands this handler
// exactly the tunnel path and everything else stays mode A — and since the
// prefix is checked to never collide with an allowlist host at startup,
// enabling or disabling the tunnel is invisible from outside (both states answer
// the same camouflage 404, VPN-R34/R2).
//
// The 101 is written on the hijacked connection with the logging wrapper
// kept in the chain (VPN-R13): auth and upgrade validation run BEFORE the
// hijack, so an unauthenticated upgrade never reaches a 101 (VPN-R39), and
// the CLF line afterwards carries a redacted path (VPN-R44 — the prefix is
// a capability, so our own access log never echoes it).
package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	// tunnelHandshakeTimeout bounds the HELLO→CONNECT preamble (VPN-R39:
	// every idle stretch in the protocol is bounded, not just mid-relay).
	tunnelHandshakeTimeout = 10 * time.Second
	// tunnelDialTimeout bounds name resolution plus TCP establishment for a
	// CONNECT, so a hung resolver cannot pin a session slot.
	tunnelDialTimeout = 15 * time.Second
)

// logPathRedaction replaces the capability segment in logged request URIs.
const logPathRedaction = "REDACTED"

type tunnelServer struct {
	prefix string
	token  string
	egress *egressPolicy
}

// isTunnelPath reports whether this request belongs to the tunnel
// namespace. Exact-match only: `/<prefix>/anything-else` is not tunnel
// traffic and falls through to mode A, where the prefix answers the same
// 404 as any unlisted host (the namespace boundary stays invisible,
// VPN-R34).
func (t *tunnelServer) isTunnelPath(path string) bool {
	return path == "/"+t.prefix+"/vpn"
}

// checkBearer validates the operator credential (VPN-R31): constant-time
// over the secret itself (VPN-R33) — the "Bearer " scheme prefix is public
// format, not secret, so an early return on its absence leaks nothing.
func checkBearer(r *http.Request, token string) bool {
	const scheme = "Bearer "
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, scheme) {
		return false
	}
	got := []byte(auth[len(scheme):])
	want := []byte(token)
	return len(got) == len(want) && subtle.ConstantTimeCompare(got, want) == 1
}

// serveTunnel takes a tunnel-path request to either a live session or
// camouflage 404 — it never returns a response that distinguishes "wrong
// credential" from "wrong path" (VPN-R34).
func (t *tunnelServer) serveTunnel(w http.ResponseWriter, r *http.Request) {
	// Factor 1 first: an unknown credential must not even learn whether
	// /<prefix>/vpn exists as a route (VPN-R12: rejected before any 101).
	if !checkBearer(r, t.token) {
		writeFunnel404(w, r, t.redactedURI(r))
		return
	}
	// Factor 2: the request must actually be a v13 websocket upgrade with a
	// well-formed key; anything else is not a tunnel request at all.
	resp, err := wsAccept(r)
	if err != nil {
		writeFunnel404(w, r, t.redactedURI(r))
		return
	}

	// From here the peer is authenticated, so a proxy-internal failure may
	// answer like one (RFC 9457 — the module's internal-error contract).
	lw := &loggingResponseWriter{ResponseWriter: w}
	conn, brw, err := http.NewResponseController(lw).Hijack()
	if err != nil {
		writeProblem(lw, r, http.StatusInternalServerError, "hijack-failed",
			"Could not switch protocols on the tunnel connection", "", err)
		// Authenticated, but the path still carries the prefix — the CLF line
		// gets the redacted URI (VPN-R44), and no 101 ever happened.
		logCombinedRequestURI(r, t.redactedURI(r), http.StatusInternalServerError, lw.size)
		return
	}
	if _, err := brw.Write(resp); err != nil {
		conn.Close()
		return
	}
	if err := brw.Flush(); err != nil {
		conn.Close()
		return
	}
	// net/http never saw the 101 through WriteHeader — record it so the
	// CLF line is honest (the Unwrap chain keeps Hijack reachable,
	// VPN-R13).
	lw.recordSwitched(len(resp))
	logCombinedRequestURI(r, t.redactedURI(r), http.StatusSwitchingProtocols, len(resp))

	// The session outlives ServeHTTP: once hijacked, nothing on this
	// connection is net/http's business anymore.
	ws := &wsConn{conn: conn, br: brw.Reader, bw: brw.Writer, client: false}
	go t.runSession(ws)
}

// redactedURI is the CLF path for tunnel requests: the capability segment
// never reaches our access log (VPN-R44; the Funnel edge still sees the
// real path — accepted here exactly as d070 accepted the edge logging the
// funnel id).
func (t *tunnelServer) redactedURI(r *http.Request) string {
	uri := "/" + logPathRedaction + "/vpn"
	if r.URL.RawQuery != "" {
		uri += "?" + r.URL.RawQuery
	}
	return uri
}

// runSession is one tunnel's whole life: HELLO → CONNECT → relay →
// lifecycle log (VPN-R16's frame set, VPN-R20's remote resolution).
func (t *tunnelServer) runSession(ws *wsConn) {
	start := time.Now()
	var (
		label   string
		target  string
		outcome = outcomeProtocolError
		stats   relayStats
	)
	defer func() {
		_ = ws.Close()
		// VPN-R19's contract: who (principal + label), where (target), how
		// much (bytes/duration), outcome — nothing derivable from reading
		// the stream, never the credential, prefix only as a digest
		// (VPN-R44).
		logTunnelLifecycle(t.prefix, label, target, start, stats, outcome)
	}()

	// Phase 1 — HELLO (VPN-R16): magic, version, client label.
	_ = ws.conn.SetReadDeadline(time.Now().Add(tunnelHandshakeTimeout))
	helloMsg, err := readTunnelFrame(ws)
	if err != nil {
		return
	}
	typ, _, payload, err := decodeFrame(helloMsg)
	if err != nil || typ != frameHello {
		return
	}
	version, helloLabel, err := decodeHello(payload)
	if err != nil || version != tunnelVersion {
		return
	}
	label = helloLabel
	if err := sendFrame(ws, frameHelloOK, []byte{tunnelVersion}); err != nil {
		return
	}

	// Phase 2 — CONNECT (VPN-R20..R22): parse, policy-check, resolve once,
	// pin, dial.
	_ = ws.conn.SetReadDeadline(time.Now().Add(tunnelHandshakeTimeout))
	connectMsg, err := readTunnelFrame(ws)
	if err != nil {
		return
	}
	typ, _, payload, err = decodeFrame(connectMsg)
	if err != nil || typ != frameConnect {
		return
	}
	target = string(payload)
	failConnect := func(reason string) {
		_ = sendFrame(ws, frameConnectErr, []byte(reason))
		outcome = reason
	}
	host, port, err := splitConnectTarget(target)
	if err != nil {
		failConnect(errReasonInvalid)
		return
	}
	if _, literal := parseIPLiteral(host); literal {
		// VPN-R22: pre-resolved targets are refused here, and here is the
		// only place the tunnel dials — resolution and pinning stay server-side.
		failConnect(errReasonTargetIP)
		return
	}
	if !t.egress.allowPort(port) {
		failConnect(errReasonPortDenied)
		return
	}
	dialCtx, cancel := context.WithTimeout(context.Background(), tunnelDialTimeout)
	upConn, _, err := dialValidated(dialCtx, t.egress, host, port)
	cancel()
	if err != nil {
		failConnect(egressFailureReason(err))
		return
	}

	if err := sendFrame(ws, frameConnected, nil); err != nil {
		upConn.Close()
		return
	}
	// The relay owns the deadlines from here (VPN-R14).
	_ = ws.conn.SetReadDeadline(time.Time{})
	// The pinned address stays out of the log on purpose: VPN-R19 allows
	// "where" as the target the operator asked for, not resolver internals.
	stats, _ = relay(ws, upConn, tunnelKeepaliveInterval, tunnelIdleTimeout)
	outcome = stats.outcome
}

// logTunnelLifecycle renders the one log line per tunnel (VPN-R19/R44).
// The prefix is reduced to a digest so operators can still tell WHICH
// capability a session used without the log becoming a key store.
func logTunnelLifecycle(prefix, label, target string, start time.Time, stats relayStats, outcome string) {
	log.Printf("[vpn] who=operator label=%q target=%q tunnel=%s bytes_in=%d bytes_out=%d duration_ms=%d outcome=%s",
		label, target, prefixDigest(prefix), stats.received, stats.sent,
		time.Since(start).Milliseconds(), outcome)
}

// prefixDigest reduces the capability prefix to a comparable short id:
// lifecycle and startup logs may say WHICH namespace a session used
// without becoming a store of the value itself (VPN-R44).
func prefixDigest(prefix string) string {
	sum := sha256.Sum256([]byte(prefix))
	return hex.EncodeToString(sum[:4])
}

// enableTunnel wires the tunnel surface from config data + environment and
// fails loudly on any input that would weaken an invariant (NFR-2): a
// misconfigured capability that binds anyway is worse than one that refuses
// to start, because it fails OPEN at the first probe instead of never.
func (s *server) enableTunnel(tn *tunnelConfig) error {
	prefix := os.Getenv(envTunnelPrefix)
	token := os.Getenv(envOperatorToken)
	if err := validateCapabilityPrefix(prefix); err != nil {
		return err
	}
	// Floor, not entropy proof: the vault owns how strong the token is;
	// this only catches empty or truncated loads BEFORE the surface exists
	// (VPN-R31/R26 — refuse without a credential, loudly).
	if len(token) < 16 {
		return fmt.Errorf("%s missing or shorter than 16 bytes (VPN-R26/R31 fail-closed)", envOperatorToken)
	}
	// The prefix may never be an allowlist host: /<prefix>/… is the
	// tunnel's namespace, and a provider carrying that name would make
	// dispatch a matter of request order — VPN-R42 forbids exactly that
	// coupling, and startup is where "never" is enforceable.
	if _, clash := s.providers[prefix]; clash {
		return fmt.Errorf("capability prefix collides with allowlist host %q", prefix)
	}
	egress, err := newEgressPolicy(tn.Egress)
	if err != nil {
		return err
	}
	s.vpn = &tunnelServer{prefix: prefix, token: token, egress: egress}
	// The real prefix appears in no log line, here or later (VPN-R44).
	log.Printf("[llm-reverse-proxy] tunnel (modes C–E): enabled at /%s/ (prefix digest %s)",
		logPathRedaction, prefixDigest(prefix))
	return nil
}

// validateCapabilityPrefix treats the prefix as what it is: a bearer secret
// in path form. VPN-R44 fixes the shape at ~100+ bits (a UUID's 122 is the
// recommended shape); the length floor below is the structural half of that
// claim, and the charset is what a URL path segment needs to survive
// routing (no separators, no dot-segments).
func validateCapabilityPrefix(prefix string) error {
	if len(prefix) < 22 || len(prefix) > 64 {
		return fmt.Errorf("%s must be 22..64 characters (VPN-R44: UUID-class capability), got %d", envTunnelPrefix, len(prefix))
	}
	for _, r := range prefix {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return fmt.Errorf("%s contains %q: only [A-Za-z0-9_-] are safe in a capability path segment", envTunnelPrefix, r)
		}
	}
	return nil
}
