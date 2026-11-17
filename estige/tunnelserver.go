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
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
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
//
// policy is the principal's own egress table (docs/d078): nil means the
// process default from VPN_TUNNEL_EGRESS, which is what a plain string
// value in the keyset has always meant. A per-key table narrows one
// principal without giving every relay the same blast radius.
type operatorKey struct {
	id     string
	token  string
	policy *egressPolicy
}

// policyOr returns the principal's table when it has one, else the process
// default. Never nil for an admitted key: the process default is built
// before any session can exist.
func (k *operatorKey) policyOr(def *egressPolicy) *egressPolicy {
	if k != nil && k.policy != nil {
		return k.policy
	}
	return def
}

type tunnelServer struct {
	keys   []operatorKey
	egress *egressPolicy
	// sessions is the mode E per-trace-id registry (d077 §3/§4, d081's
	// amendment): minted by span-1 windows, self-removing on session close.
	sessions *exchangeSessions

	// live is every admitted session, in every carrier. It is the status
	// surface and the drain's work list (docs/d106): the mode E registry
	// knows only its own carrier, and net/http tracks no hijacked conn.
	live liveRegistry
}

// liveSession is one admitted session's pull-side state. Byte counters are
// atomics because the status surface reads them while the pump writes.
type liveSession struct {
	id        string
	keyID     string
	label     string
	via       string
	target    string
	transport string
	start     time.Time
	stream    tunnelStream
	up        atomic.Int64 // client -> origin
	down      atomic.Int64 // origin -> client
}

func (l *liveSession) addUp(n int64)   { l.up.Add(n) }
func (l *liveSession) addDown(n int64) { l.down.Add(n) }

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
// on its absence leaks nothing. Exactly one header is required: a second
// spelling leaves the edge and estige free to verify different values.
func matchOperatorKey(r *http.Request, keys []operatorKey) *operatorKey {
	const scheme = "Bearer "
	values := r.Header.Values("Authorization")
	if len(values) != 1 {
		return nil
	}
	auth := values[0]
	if !strings.HasPrefix(auth, scheme) {
		return nil
	}
	got := []byte(auth[len(scheme):])
	var matched *operatorKey
	for i := range keys {
		if subtle.ConstantTimeCompare(got, []byte(keys[i].token)) == 1 {
			matched = &keys[i]
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
	key := matchOperatorKey(r, t.keys)
	if key == nil {
		writeFunnel404(w, r)
		return
	}
	// The correlation id is per-session diagnostic metadata (docs/d106):
	// the relay mints it and sends it on the session-opening request; a
	// malformed or absent value is replaced locally, because the header is
	// never an authorization input.
	id := r.Header.Get(sessionIDHeader)
	if !validSessionID(id) {
		if minted, err := newSessionID(); err == nil {
			id = minted
		}
	}
	// Mode C/E arrival (docs/d077 §4): an authenticated POST with no
	// upgrade is a body session — no 101, no hijack — and traceparent
	// presence is what separates the two shapes: a windowed mode E exchange
	// carries its demux key (d081's amendment — E built), an unbroken
	// request does not and gets mode C's long-lived stream. The per-request
	// bearer above is their whole auth (d077 §5: the credential rides every
	// request, since a body session has no handshake header of its own).
	if r.Method == http.MethodPost && !headerHasToken(r.Header, "Upgrade", "websocket") {
		if r.Header.Get("Traceparent") != "" {
			t.serveTunnelExchange(w, r, key)
			return
		}
		t.serveTunnelPOST(w, r, key, id)
		return
	}
	// Factor 2: the request must actually be a v13 websocket upgrade with a
	// well-formed key; anything else is not a tunnel request at all.
	resp, err := wsAccept(r)
	if err != nil {
		writeFunnel404(w, r)
		return
	}

	// Attribution moved into the session records (docs/d106): the matched
	// key is a field on open/close, not a second line per session. A
	// rejection above still never names an id — the response vocabulary
	// (VPN-R34) and the auth failure path must not count keys.

	// From here the peer is authenticated, so a proxy-internal failure may
	// answer like one (RFC 9457 — the module's internal-error contract).
	lw := &loggingResponseWriter{ResponseWriter: w, start: time.Now()}
	conn, brw, err := http.NewResponseController(lw).Hijack()
	if err != nil {
		writeProblem(lw, r, http.StatusInternalServerError, "hijack-failed",
			"Could not switch protocols on the tunnel connection", err)
		// Authenticated, but no 101 ever happened — the CLF line records
		// the failure.
		logAccess(r, http.StatusInternalServerError, lw.size, lw.start)
		return
	}
	if _, err := brw.Write(resp); err != nil {
		_ = conn.Close()
		return
	}
	if err := brw.Flush(); err != nil {
		_ = conn.Close()
		return
	}
	// net/http never saw the 101 through WriteHeader — record it so the
	// CLF line is honest (the Unwrap chain keeps Hijack reachable,
	// VPN-R13).
	lw.recordSwitched(len(resp))
	logAccess(r, http.StatusSwitchingProtocols, len(resp), lw.start)

	// The session outlives ServeHTTP: once hijacked, nothing on this
	// connection is net/http's business anymore.
	ws := &wsConn{conn: conn, br: brw.Reader, bw: brw.Writer, client: false, id: id}
	go t.runSession(context.WithoutCancel(r.Context()), ws, key)
}

// serveTunnelPOST runs a mode C session (docs/d077 §3): the response
// headers are the session-open signal, and unlike the 101 path the handler
// must stay alive for the whole session — returning would end the response
// body that carries it. Attribution happens at the same point the 101 path
// does it: after auth, before any session work (docs/d078 §5).
func (t *tunnelServer) serveTunnelPOST(w http.ResponseWriter, r *http.Request, key *operatorKey, id string) {
	lw := &loggingResponseWriter{ResponseWriter: w, start: time.Now()}
	p := &postStream{r: r, w: lw, id: id}
	defer func() { _ = p.Close() }()

	// This response is the session-open signal: it must go out before the
	// client has sent a single tunnel byte (d077 §5). net/http's h1 default
	// is to drain the still-open request body first — which deadlocks
	// against exactly this client, that waits for the response before it
	// writes (Go Issue 15527). h2 is full duplex by default; this makes h1
	// the same, and both implementations accept it unconditionally.
	if err := http.NewResponseController(lw).EnableFullDuplex(); err != nil {
		// Fail loudly: without full duplex the session would open and then
		// hang, which reads as network loss rather than a defect (NFR-2).
		logLine(sevError, "[estige] tunnel mode C: full duplex unavailable: %v", err)
		lw.WriteHeader(http.StatusInternalServerError)
		logAccess(r, http.StatusInternalServerError, lw.size, lw.start)
		return
	}

	lw.WriteHeader(http.StatusOK)
	if err := http.NewResponseController(lw).Flush(); err != nil {
		// Headers never made it out: the session cannot exist. The status
		// was not committed, so this is the honest CLF outcome.
		logAccess(r, http.StatusInternalServerError, lw.size, lw.start)
		return
	}
	t.runSession(context.WithoutCancel(r.Context()), p, key)
	logAccess(r, http.StatusOK, lw.size, lw.start)
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
	id        string
	wmu       sync.Mutex
	closeOnce sync.Once
}

func (p *postStream) sessionID() string { return p.id }

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

func (p *postStream) transport() string { return transportPOST }

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
// open/close records (VPN-R16's frame set, VPN-R20's remote resolution). It
// is carrier-agnostic (docs/d077 §5): the same session over the 101 path and
// over a mode C body.
func (t *tunnelServer) runSession(ctx context.Context, s tunnelStream, key *operatorKey) {
	start := time.Now()
	var (
		label   string
		target  string
		outcome = outcomeProtocolError
		stats   relayStats
		live    *liveSession
	)
	defer func() {
		_ = s.Close()
		if live != nil {
			t.live.unregister(live)
		}
		// VPN-R19's contract: who (principal + label), where (target), how
		// much (bytes/duration), outcome — nothing derivable from reading
		// the stream, never the credential; plus the carrier (docs/d077 §4:
		// transport is operational debugging data, h2|wss|post).
		//
		// A session that never reached the streaming state is a refusal, not
		// a zero-byte close (docs/d106): the reason is the same token the
		// peer's CONNECT_ERR carried.
		rec := sessionRecord{
			Role: roleExit, ID: s.sessionID(), Key: key.id, Label: label,
			Via: viaConnect, Transport: s.transport(), Target: target,
			// The pump's sent/received are viewpoint-relative; the record's
			// names are not (docs/d106). At the exit, local is the target:
			// local→tunnel (sent) is origin→client = down, tunnel→local
			// (received) is client→origin = up.
			Up: stats.received, Down: stats.sent,
			Duration: time.Since(start).Milliseconds(),
		}
		if live != nil {
			rec.Event = eventClose
			rec.Outcome = stats.outcome
		} else {
			rec.Event = eventRefused
			rec.Reason = outcome
		}
		rec.emit()
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
	// The pre-dial verdict (d163): guaranteed refusals, the IP-exit gate and
	// the port set are decided here, before any lookup or socket — a refused
	// target costs no DNS and no dial, and here is still the only place the
	// tunnel dials (VPN-R22).
	policy := key.policyOr(t.egress)
	if reason := policy.targetVerdict(host, port); reason != "" {
		failConnect(reason)
		return
	}
	dialCtx, cancel := context.WithTimeout(ctx, tunnelDialTimeout)
	upConn, _, err := dialValidated(dialCtx, policy, host, port)
	cancel()
	if err != nil {
		failConnect(egressFailureReason(err))
		return
	}

	if err := sendFrame(s, frameConnected, nil); err != nil {
		_ = upConn.Close()
		return
	}
	// The relay owns the deadlines from here (VPN-R14).
	_ = s.setReadDeadline(time.Time{})
	// The pinned address stays out of the log on purpose: VPN-R19 allows
	// "where" as the target the operator asked for, not resolver internals.
	live = &liveSession{
		id: s.sessionID(), keyID: key.id, label: label, via: viaConnect,
		target: target, transport: s.transport(), start: start, stream: s,
	}
	t.live.register(live)
	sessionRecord{
		Role: roleExit, Event: eventOpen, ID: s.sessionID(), Key: key.id, Label: label,
		Via: viaConnect, Transport: s.transport(), Target: target,
	}.emit()
	stats, _ = relay(s, upConn, swappedMeter{live})
	outcome = stats.outcome
}

// validOperatorID is the label shape docs/d078 §2 promises: ids reach server
// logs (§5), so they must be log-safe and must never be secret-shaped: an id
// is a name, not a capability.
func validOperatorID(id string) bool {
	if len(id) < 1 || len(id) > 64 {
		return false
	}
	for _, r := range id {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '-' && r != '_' {
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
	s.vpn = &tunnelServer{keys: keys, egress: policy, sessions: newExchangeSessions(), live: newLiveRegistry()}
	logLine(sevInfo, "[estige] tunnel (modes C–E): enabled at %s", tunnelPath)
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
// typo'd "allowCidr" or "allowIpLiterals" would otherwise silently enforce
// the default deny: the operator would believe a target is reachable while
// every attempt at it fails (NFR-2 fail-loudly, the same rule
// decodeOperatorKeys follows).
func egressFromEnv() (egressConfig, error) {
	raw := os.Getenv(envTunnelEgress)
	if raw == "" {
		return egressConfig{}, nil
	}
	var cfg egressConfig
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		return egressConfig{}, fmt.Errorf("%s must be a JSON object {\"allowCidrs\": [\"10.0.0.0/8\"], \"ports\": [44w]}: %w", envTunnelEgress, err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return egressConfig{}, fmt.Errorf("%s has content after the JSON object", envTunnelEgress)
	}
	// An all-empty object decodes cleanly but configures nothing: unset already
	// means the default deny table, so a blob that names neither a range, a
	// port nor the IP-exit switch is a typo whose silent reading is
	// "configured" (the same fail-loudly rule as the unknown-field check
	// above). Naming only one half is fine — d104's defaults fill the other.
	if len(cfg.AllowCidrs) == 0 && len(cfg.Ports) == 0 && !cfg.AllowIPLiterals {
		return egressConfig{}, fmt.Errorf("%s names neither a CIDR, a port nor the IP-exit switch — unset it for the defaults", envTunnelEgress)
	}
	return cfg, nil
}
