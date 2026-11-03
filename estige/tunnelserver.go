// tunnelserver.go — the tunnel's server role (modes C–E): the /vpn namespace
// (docs/d073 §5: VPN-R11..R22, §8: VPN-R31..R34).
//
// Dispatch is by path only (VPN-R42): main's ServeHTTP hands this handler
// exactly the tunnel path and answers the camouflage 404 to everything else —
// the namespace is the whole edge now that d108 retired the allowlist reverse
// proxy (legacy "mode A"), so there is no second surface to stay
// indistinguishable from; what remains is that enabling or disabling the
// tunnel is invisible from outside (both states answer the same 404,
// VPN-R34/R2).
//
// The 101 is written on the hijacked connection with the logging wrapper
// kept in the chain (VPN-R13): auth and upgrade validation run BEFORE the
// hijack, so an unauthenticated upgrade never reaches a 101 (VPN-R39). The
// capability that names this namespace lives at the Funnel edge and never
// reaches us (docs/d085) — so there is no path secret left to keep out of
// the CLF line.
package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
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

// tunnelPath is the tunnel family's single reserved path. The capability
// that names the namespace lives at the Funnel edge (the mount prefix, which
// http.StripPrefix removes before a request can reach us — docs/d085); all
// the proxy needs is one fixed, reserved place to dispatch on.
const tunnelPath = "/vpn"

// maxOperatorKeys bounds the principal set (docs/d078 §2): a structural
// guard, not a performance one — the scan is linear regardless — that keeps
// the credential model a bounded key set and out of the user-directory
// business NFR-5 forbids.
const maxOperatorKeys = 32

// operatorKey is one security principal: an id that is a log-safe LABEL
// (never a capability — docs/d078 §5 lets it appear in server logs) plus
// the bearer token it authenticates (VPN-R31 as amended by docs/d078).
type operatorKey struct {
	id    string
	token string
}

type tunnelServer struct {
	keys   []operatorKey
	egress *egressPolicy
	// sessions is the mode E per-trace-id registry (d077 §3/§4, d081's
	// amendment): minted by span-1 windows, self-removing on session close.
	sessions *exchangeSessions
}

// isTunnelPath reports whether this request belongs to the tunnel
// namespace. Exact-match only: /vpn/anything-else is not tunnel traffic and
// answers the same camouflage 404 as any other unlisted path (the namespace
// boundary stays invisible, VPN-R34).
func (t *tunnelServer) isTunnelPath(path string) bool {
	return path == tunnelPath
}

// matchOperatorKey returns the id of the principal whose bearer credential
// the request carries, or "" for none (VPN-R31 as amended by docs/d078).
// Constant-time per entry AND no early exit: the scan visits every key
// whether or not one already matched, so neither the matched principal's
// position nor the set's contents leak through timing (VPN-R33). The
// "Bearer " scheme prefix is public format, not secret, so an early return
// on its absence leaks nothing.
func matchOperatorKey(r *http.Request, keys []operatorKey) string {
	const scheme = "Bearer "
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, scheme) {
		return ""
	}
	got := []byte(auth[len(scheme):])
	matched := ""
	for _, k := range keys {
		if subtle.ConstantTimeCompare(got, []byte(k.token)) == 1 {
			matched = k.id
		}
	}
	return matched
}

// serveTunnel takes a tunnel-path request to either a live session or
// camouflage 404 — it never returns a response that distinguishes "wrong
// credential" from "wrong path" (VPN-R34).
func (t *tunnelServer) serveTunnel(w http.ResponseWriter, r *http.Request) {
	// Factor 1 first: an unknown credential must not even learn whether
	// /<prefix>/vpn exists as a route (VPN-R12: rejected before any 101).
	keyID := matchOperatorKey(r, t.keys)
	if keyID == "" {
		writeFunnel404(w, r)
		return
	}
	// Mode C/E arrival (docs/d077 §4): an authenticated POST with no
	// upgrade is a body session — no 101, no hijack — and traceparent
	// presence is what separates the two shapes: a windowed mode E exchange
	// carries its demux key (d081's amendment — E built), an unbroken
	// request does not and gets mode C's long-lived stream. The per-request
	// bearer above is their whole auth (d077 §5: the credential rides every
	// request, since a body session has no handshake header of its own).
	if r.Method == http.MethodPost && !headerHasToken(r.Header, "Upgrade", "websocket") {
		if r.Header.Get("traceparent") != "" {
			t.serveTunnelExchange(w, r, keyID)
			return
		}
		t.serveTunnelPOST(w, r, keyID)
		return
	}
	// Factor 2: the request must actually be a v13 websocket upgrade with a
	// well-formed key; anything else is not a tunnel request at all.
	resp, err := wsAccept(r)
	if err != nil {
		writeFunnel404(w, r)
		return
	}

	// Attribution (docs/d078 §5): the matched id is a label, so a success
	// may say it out loud — as a side line, not inside the CLF, so the
	// standard access log stays parseable by stock tools. A rejection above
	// never names an id: the response vocabulary (VPN-R34) and the auth
	// failure path must not count keys.
	log.Printf("[estige] tunnel session: authenticated key=%s", keyID)

	// From here the peer is authenticated, so a proxy-internal failure may
	// answer like one (RFC 9457 — the module's internal-error contract).
	lw := &loggingResponseWriter{ResponseWriter: w}
	conn, brw, err := http.NewResponseController(lw).Hijack()
	if err != nil {
		writeProblem(lw, r, http.StatusInternalServerError, "hijack-failed",
			"Could not switch protocols on the tunnel connection", "", err)
		// Authenticated, but no 101 ever happened — the CLF line records
		// the failure.
		logCombinedRequestURI(r, http.StatusInternalServerError, lw.size)
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
	logCombinedRequestURI(r, http.StatusSwitchingProtocols, len(resp))

	// The session outlives ServeHTTP: once hijacked, nothing on this
	// connection is net/http's business anymore.
	ws := &wsConn{conn: conn, br: brw.Reader, bw: brw.Writer, client: false}
	go t.runSession(ws)
}

// serveTunnelPOST runs a mode C session (docs/d077 §3): the response
// headers are the session-open signal, and unlike the 101 path the handler
// must stay alive for the whole session — returning would end the response
// body that carries it. Attribution happens at the same point the 101 path
// does it: after auth, before any session work (docs/d078 §5).
func (t *tunnelServer) serveTunnelPOST(w http.ResponseWriter, r *http.Request, keyID string) {
	log.Printf("[estige] tunnel session: authenticated key=%s", keyID)

	lw := &loggingResponseWriter{ResponseWriter: w}
	p := &postStream{r: r, w: lw}
	defer p.Close()

	// This response is the session-open signal: it must go out before the
	// client has sent a single tunnel byte (d077 §5). net/http's h1 default
	// is to drain the still-open request body first — which deadlocks
	// against exactly this client, that waits for the response before it
	// writes (Go Issue 15527). h2 is full duplex by default; this makes h1
	// the same, and both implementations accept it unconditionally.
	if err := http.NewResponseController(lw).EnableFullDuplex(); err != nil {
		// Fail loudly: without full duplex the session would open and then
		// hang, which reads as network loss rather than a defect (NFR-2).
		log.Printf("[estige] tunnel mode C: full duplex unavailable: %v", err)
		lw.WriteHeader(http.StatusInternalServerError)
		logCombinedRequestURI(r, http.StatusInternalServerError, lw.size)
		return
	}

	lw.WriteHeader(http.StatusOK)
	if err := http.NewResponseController(lw).Flush(); err != nil {
		// Headers never made it out: the session cannot exist. The status
		// was not committed, so this is the honest CLF outcome.
		logCombinedRequestURI(r, http.StatusInternalServerError, lw.size)
		return
	}
	t.runSession(p)
	logCombinedRequestURI(r, http.StatusOK, lw.size)
}

// postStream is mode C's carrier (docs/d077 §3/§5): frames ride the HTTP
// request body inbound and the response body outbound. Everything the 101
// path gets from owning its hijacked connection has to be re-earned here
// through net/http's controllers — deadlines per read/write (VPN-R39) and a
// write mutex so the relay's goroutines never interleave frames — while the
// camouflage contract (VPN-R34) is already spent: an unauthenticated POST
// never reached this type.
type postStream struct {
	r         *http.Request
	w         http.ResponseWriter
	wmu       sync.Mutex
	closeOnce sync.Once
}

func (p *postStream) readTunnelMsg() ([]byte, error) {
	return readFrameFromStream(p.r.Body)
}

func (p *postStream) writeTunnelMsg(msg []byte) error {
	p.wmu.Lock()
	defer p.wmu.Unlock()
	// Same bound the hijacked path takes from its conn write deadline: a
	// peer that stops draining must surface as an error, not a goroutine
	// parked in a write (VPN-R39).
	rc := http.NewResponseController(p.w)
	_ = rc.SetWriteDeadline(time.Now().Add(tunnelKeepaliveInterval))
	_, err := p.w.Write(msg)
	if err == nil {
		_ = rc.Flush()
	}
	_ = rc.SetWriteDeadline(time.Time{})
	return err
}

// setReadDeadline reaches the connection under the ResponseWriter: the
// request body reads from it, so the handshake's and the relay's read
// bounds apply to the body exactly as they do to a hijacked socket.
func (p *postStream) setReadDeadline(t time.Time) error {
	return http.NewResponseController(p.w).SetReadDeadline(t)
}

// protocolViolation has no in-band signal to send: a body carries no close
// frame vocabulary, so the teardown itself is the abort — the peer sees the
// response body end (unambiguous without frames once the session's own
// rules define it). See docs/d077 §5.
func (p *postStream) protocolViolation() {}

func (p *postStream) transport() string { return "post" }

func (p *postStream) Close() error {
	p.closeOnce.Do(func() {
		// Deadlines must be cleared before the connection goes back to
		// net/http: a stale write deadline would kill whatever the next
		// keep-alive request tries to write.
		rc := http.NewResponseController(p.w)
		_ = rc.SetReadDeadline(time.Time{})
		_ = rc.SetWriteDeadline(time.Time{})
		_ = p.r.Body.Close()
	})
	return nil
}

// runSession is one tunnel's whole life: HELLO → CONNECT → relay →
// lifecycle log (VPN-R16's frame set, VPN-R20's remote resolution). It is
// carrier-agnostic (docs/d077 §5): the same session over the 101 path and
// over a mode C body.
func (t *tunnelServer) runSession(s tunnelStream) {
	start := time.Now()
	var (
		label   string
		target  string
		outcome = outcomeProtocolError
		stats   relayStats
	)
	defer func() {
		_ = s.Close()
		// VPN-R19's contract: who (principal + label), where (target), how
		// much (bytes/duration), outcome — nothing derivable from reading
		// the stream, never the credential; plus the carrier (docs/d077 §4:
		// transport is operational debugging data, h2|wss|post).
		logTunnelLifecycle(label, target, s.transport(), start, stats, outcome)
	}()

	// Phase 1 — HELLO (VPN-R16): magic, version, client label.
	_ = s.setReadDeadline(time.Now().Add(tunnelHandshakeTimeout))
	helloMsg, err := readTunnelFrame(s)
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
	if err := sendFrame(s, frameHelloOK, []byte{tunnelVersion}); err != nil {
		return
	}

	// Phase 2 — CONNECT (VPN-R20..R22): parse, policy-check, resolve once,
	// pin, dial. The policy is the egress table only — the d047 host
	// allowlist is mode-A-only (docs/d080).
	_ = s.setReadDeadline(time.Now().Add(tunnelHandshakeTimeout))
	connectMsg, err := readTunnelFrame(s)
	if err != nil {
		return
	}
	typ, _, payload, err = decodeFrame(connectMsg)
	if err != nil || typ != frameConnect {
		return
	}
	target = string(payload)
	failConnect := func(reason string) {
		_ = sendFrame(s, frameConnectErr, []byte(reason))
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

	if err := sendFrame(s, frameConnected, nil); err != nil {
		upConn.Close()
		return
	}
	// The relay owns the deadlines from here (VPN-R14).
	_ = s.setReadDeadline(time.Time{})
	// The pinned address stays out of the log on purpose: VPN-R19 allows
	// "where" as the target the operator asked for, not resolver internals.
	stats, _ = relay(s, upConn, tunnelKeepaliveInterval, tunnelIdleTimeout)
	outcome = stats.outcome
}

// logTunnelLifecycle renders the one log line per tunnel (VPN-R19).
// transport is the carrier the session actually ran on (docs/d077 §4): at
// the exit node that is what arrived — "post" for a mode C session, since a
// proxy strips the ALPN evidence on the way in.
func logTunnelLifecycle(label, target, transport string, start time.Time, stats relayStats, outcome string) {
	log.Printf("[vpn] who=operator label=%q target=%q transport=%s bytes_in=%d bytes_out=%d duration_ms=%d outcome=%s",
		label, target, transport, stats.received, stats.sent,
		time.Since(start).Milliseconds(), outcome)
}

// operatorKeysFromEnv builds the exit node's principal set from the env
// chain — the only home credentials have (VPN-R32: never the config file;
// and no digest of a token stored beside the plaintext, which would be a
// second credential copy for zero protection — docs/d078 §2). The roles
// are disjoint since d090: VPN_OPERATOR_KEYS is the exit node's set and
// VPN_OPERATOR_TOKEN is the relay node's bearer, read nowhere else —
// d078 §2's back-compat merge is retired, and a TOKEN-only exit node
// refuses with the zero-wire migration spelled out. When both are set the
// keyset wins (TOKEN is ignored HERE; it stays the relay credential on a
// shared-env host running both roles). Every failure here refuses the
// tunnel rather than weakening it (NFR-2, VPN-R26).
func operatorKeysFromEnv() ([]operatorKey, error) {
	byID, err := decodeOperatorKeys(os.Getenv(envOperatorKeys))
	if err != nil {
		return nil, err
	}
	if len(byID) == 0 {
		if os.Getenv(envOperatorToken) != "" {
			return nil, fmt.Errorf("%s is the relay node's bearer; the exit node reads %s — the migration is zero-wire: set %s={\"default\": \"<the same token>\"} (docs/d090)", envOperatorToken, envOperatorKeys, envOperatorKeys)
		}
		return nil, fmt.Errorf("no operator credential: set %s (VPN-R26/R31 fail-closed)", envOperatorKeys)
	}
	if len(byID) > maxOperatorKeys {
		return nil, fmt.Errorf("%d operator keys exceed cap %d (docs/d078: a bounded set, not a user directory)", len(byID), maxOperatorKeys)
	}
	// Floor, not entropy proof: the vault owns how strong each token is;
	// this only catches empty or truncated loads BEFORE the surface exists
	// (VPN-R31/R26 — refuse without a credential, loudly). The same check
	// refuses control characters, which is what keeps a token from injecting
	// headers in the hand-rolled mode D handshake (validOperatorToken).
	keys := make([]operatorKey, 0, len(byID))
	for id, token := range byID {
		if len(token) < 16 {
			return nil, fmt.Errorf("operator key %q shorter than 16 bytes (VPN-R26/R31 fail-closed)", id)
		}
		if !validOperatorToken(token) {
			return nil, fmt.Errorf("operator key %q contains a control character: a bearer token may not carry header framing (RFC 9110 field-value; VPN-R26 fail-closed)", id)
		}
		keys = append(keys, operatorKey{id: id, token: token})
	}
	return keys, nil
}

// decodeOperatorKeys parses VPN_OPERATOR_KEYS strictly — duplicate ids are
// rejected, never last-wins: encoding/json would silently keep the final
// duplicate, and a shadowed principal is a key the operator believes exists
// but does not (NFR-2 fail-loudly; docs/d078 §2).
func decodeOperatorKeys(raw string) (map[string]string, error) {
	if raw == "" {
		return map[string]string{}, nil
	}
	dec := json.NewDecoder(strings.NewReader(raw))
	open, err := dec.Token()
	if err != nil {
		return nil, fmt.Errorf("%s is not a JSON object: %v", envOperatorKeys, err)
	}
	if delim, ok := open.(json.Delim); !ok || delim != '{' {
		return nil, fmt.Errorf("%s must be a JSON object {\"<id>\": \"<token>\"} (docs/d078 §2)", envOperatorKeys)
	}
	out := make(map[string]string)
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, fmt.Errorf("%s: %v", envOperatorKeys, err)
		}
		id, ok := keyTok.(string)
		if !ok || !validOperatorID(id) {
			return nil, fmt.Errorf("%s id %v must be 1..64 chars of [A-Za-z0-9_-] — ids are log-safe labels (docs/d078 §2)", envOperatorKeys, keyTok)
		}
		if _, dup := out[id]; dup {
			return nil, fmt.Errorf("%s repeats id %q: rejected, not last-wins (docs/d078 §2)", envOperatorKeys, id)
		}
		var token string
		if err := dec.Decode(&token); err != nil {
			return nil, fmt.Errorf("%s value for %q must be a string: %v", envOperatorKeys, id, err)
		}
		out[id] = token
	}
	// dec.More only PEEKS at the closing brace, so consume it explicitly and
	// only then decide whether anything followed the object.
	closeTok, err := dec.Token()
	if err != nil {
		return nil, fmt.Errorf("%s is not a complete JSON object: %v", envOperatorKeys, err)
	}
	if closeTok != json.Delim('}') {
		return nil, fmt.Errorf("%s must be one JSON object, nothing else", envOperatorKeys)
	}
	// Exactly io.EOF ends a clean object; any other outcome — a returned
	// token OR a parse error on garbage — is trailing content (invalid JSON
	// after the object must not be excused just because Token() errored).
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%s has trailing content after the JSON object", envOperatorKeys)
	}
	return out, nil
}

// validOperatorID is the label shape docs/d078 §2 promises: ids reach server
// logs (§5), so they must be log-safe and must never be secret-shaped: an id
// is a name, not a capability.
func validOperatorID(id string) bool {
	if len(id) < 1 || len(id) > 64 {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

// validOperatorToken rejects a credential that could not ride a header intact.
//
// WHY this is a load-time refusal and not an escaping problem: mode D's
// handshake writes the Authorization header with fmt.Fprintf into a hand-rolled
// request (websocket.go wsDial), so a token containing CR/LF closes the header
// and opens one of the peer's choosing — the transport is being handed
// structure it should never interpret. Modes C and E build the header through
// net/http, which rejects such a value at Send time, so the same token would
// fail late and inconsistently there instead of never at all.
//
// The rule is RFC 9110 field-value (VCHAR plus SP/HTAB): a bearer token is
// opaque, but it is not allowed to bring framing with it. Length is a separate
// floor — the vault owns entropy, this only catches truncated loads
// (VPN-R31/R26).
func validOperatorToken(token string) bool {
	if len(token) < 16 {
		return false
	}
	for i := 0; i < len(token); i++ {
		c := token[i]
		if c < 0x20 || c == 0x7f {
			return false
		}
	}
	return true
}

// enableTunnel wires the tunnel surface from the credential set + the caller's
// egress policy and fails loudly on any input that would weaken an invariant
// (NFR-2): a misconfigured capability that binds anyway is worse than one that
// refuses to start, because it fails OPEN at the first probe instead of never.
// The egress policy is a parameter, not a lookup, so the tests drive the same
// construction the boot does without touching the environment.
func (s *server) enableTunnel(egress egressConfig) error {
	keys, err := operatorKeysFromEnv()
	if err != nil {
		return err
	}
	policy, err := newEgressPolicy(egress)
	if err != nil {
		return err
	}
	s.vpn = &tunnelServer{keys: keys, egress: policy, sessions: newExchangeSessions()}
	log.Printf("[estige] tunnel (modes C–E): enabled at %s", tunnelPath)
	return nil
}

// egressFromEnv reads the exit node's operator opt-ins (VPN-R38) off the env
// chain: VPN_TUNNEL_EGRESS, a JSON object {"allowCidrs": [...], "ports": [...]}.
// Unset means the requirement's own defaults — deny the RFC 1918 / metadata /
// loopback table, allow 80 and 443 — so a plain deployment configures nothing.
//
// WHY env rather than the file it used to be: d108 deleted the config file
// outright (the allowlist was the only reason a file ever existed), and the
// policy's permanent home is d104's role store, whose exit.json carries
// egress beside the admitted relays. Until that store lands, the env chain is
// the whole surface, which is also where the credential already lives.
//
// Parsing is strict (unknown fields and trailing content refused) because a
// typo'd "allowCidr" would otherwise silently enforce the default deny: the
// operator would believe a range is reachable while every dial to it fails
// (NFR-2 fail-loudly, the same rule decodeOperatorKeys follows).
func egressFromEnv() (egressConfig, error) {
	raw := os.Getenv(envTunnelEgress)
	if raw == "" {
		return egressConfig{}, nil
	}
	var cfg egressConfig
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		return egressConfig{}, fmt.Errorf("%s must be a JSON object {\"allowCidrs\": [\"10.0.0.0/8\"], \"ports\": [443]}: %v", envTunnelEgress, err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return egressConfig{}, fmt.Errorf("%s has content after the JSON object", envTunnelEgress)
	}
	// An all-empty object decodes cleanly but configures nothing: unset already
	// means the default deny table, so a blob that names neither a range nor a
	// port is a typo whose silent reading is "configured" (the same fail-loudly
	// rule as the unknown-field check above). Naming only one half is fine —
	// d104's defaults fill the other.
	if len(cfg.AllowCidrs) == 0 && len(cfg.Ports) == 0 {
		return egressConfig{}, fmt.Errorf("%s names neither a CIDR nor a port — unset it for the defaults", envTunnelEgress)
	}
	return cfg, nil
}
