// tunnelserver.go — the tunnel's server role: the /vpn namespace
// (docs/d073 §5: VPN-R11..R22, §8: VPN-R31..R34).
//
// Dispatch is by path only (VPN-R42): main's ServeHTTP hands this handler
// exactly the tunnel path and answers the camouflage 404 to everything else —
// the namespace is the whole edge now that d108 retired the allowlist reverse
// proxy (legacy allowlist relay), so there is no second surface to stay
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
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"maps"
	"net/http"
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

// operatorKey is one admitted principal: an id that is a log-safe LABEL
// (never a capability — docs/d078 §5) and the egress table its store row
// carries. The credential itself is the pinned certificate in the store; the
// name only indexes the policy that travels with it.
type operatorKey struct {
	id     string
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
	keys      []operatorKey
	admission admissionTrust
	replay    *nonceRing
	principal string
	selfDER   []byte
	private   ed25519.PrivateKey
	egress    *egressPolicy
	// sessions is the per-trace-id registry the two windowed POST carriers
	// share (d077 §3/§4, d081's amendment, docs/d222): minted by span-1
	// windows, self-removing on session close.
	sessions *exchangeSessions

	// live is every admitted session, in every carrier. It is the status
	// surface and the drain's work list (docs/d106): the windowed-carrier
	// registry knows only its own sessions, and net/http tracks no hijacked
	// conn.
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

// wrapChannel starts the inner session after admission. The peer's
// certificate comes from the admission proof, so the channel is pinned to the
// principal that was just admitted.
func (t *tunnelServer) wrapChannel(handshakeCtx context.Context, s tunnelStream, peer *admissionResult) (tunnelStream, error) {
	local := tls.Certificate{Certificate: [][]byte{t.selfDER}, PrivateKey: t.private}
	conn, err := serverChannelHandshake(handshakeCtx, s, local, []*x509.Certificate{peer.Cert})
	if err != nil {
		return nil, err
	}
	return newTLSTunnelStream(conn, s), nil
}

// keyByName returns the admitted principal's one policy row. A staged
// rotation may store two rows under the name, but loadExitStore refuses a pair
// whose egress disagrees, so the first match is that principal's only answer
// and row order cannot decide policy.
func (t *tunnelServer) keyByName(name string) *operatorKey {
	for i := range t.keys {
		if t.keys[i].id == name {
			return &t.keys[i]
		}
	}
	return nil
}

// serveTunnel takes a tunnel-path request to either a live session or
// camouflage 404 — it never returns a response that distinguishes "wrong
// credential" from "wrong path" (VPN-R34).
func (t *tunnelServer) serveTunnel(w http.ResponseWriter, r *http.Request, h2UnboundedRefused bool) {
	// Every POST carrier's relay waits for the response before writing a
	// byte, so an early refusal must not let net/http's h1.1 server drain the
	// still-open body first — the two sides would wait on each other. Full
	// duplex makes every response path (auth refusal, camouflage 404,
	// carrier switch) safe to write immediately.
	if r.Method == http.MethodPost {
		_ = http.NewResponseController(w).EnableFullDuplex()
	}
	// Factor 1 first: an unknown credential must not even learn whether
	// /<prefix>/vpn exists as a route (VPN-R12: rejected before any 101).
	result, err := validateRelayAdmission(r.Header.Values(eRelayAuthHeader), r.Header.Values(ePubHeader), t.admission, t.principal, t.replay)
	if err != nil {
		if untrusted, ok := errors.AsType[*untrustedPeerError](err); ok {
			_ = logSeenHost(roleExit, "", untrusted.Name, untrusted.Public)
		}
		writeFunnel404(w, r)
		return
	}
	key := t.keyByName(result.Name)
	if key == nil {
		writeFunnel404(w, r)
		return
	}
	response, err := admissionResponse(t.private, t.principal, t.selfDER, &result)
	if err != nil {
		writeProblem(w, r, http.StatusInternalServerError, "admission-response-failed",
			"Could not answer the tunnel admission", err)
		return
	}
	// An admission-bearing response is never cacheable and varies on
	// everything: `Vary: *` tells an intermediary the response cannot be
	// reused for another request, and the Cache-Control pair does the same
	// for caches that read only that field. A window rides these headers on
	// every exchange, so the whole session stays uncacheable.
	response.Set("Vary", "*")
	response.Set("Cache-Control", "no-cache, private")
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
	// Body-carrier arrival (docs/d077 §4, docs/d222): an authenticated POST
	// with no upgrade is a body session — no 101, no hijack. The window
	// header is h2-post-windowed's discriminator and rides with traceparent;
	// without it the POST is h2-post-unbounded's single long-lived request.
	//
	// A traceparent without a window header is h1.1-post-windowed, which v5
	// retired (d241): its channel cannot complete behind an upgrade-stripping
	// gateway, and serving the carrier unprotected would be a silent
	// downgrade. It fails closed here — no carrier answer, no fallback.
	if r.Method == http.MethodPost && !headerHasToken(r.Header, "Upgrade", "websocket") {
		if r.Header.Get(windowHeader) != "" {
			t.serveH2Window(w, r, key, &result, response)
			return
		}
		if r.Header.Get("Traceparent") != "" {
			logLine(sevWarn, "[estige] tunnel: refusing a retired h1.1-post-windowed window (d241)")
			writeFunnel404(w, r)
			return
		}
		t.serveH2Unbounded(w, r, key, id, h2UnboundedRefused, &result, response)
		return
	}
	// Factor 2: the request must actually be a v13 websocket upgrade with a
	// well-formed key; anything else is not a tunnel request at all.
	resp, err := wsAccept(r, response)
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
	channel, err := t.wrapChannel(context.WithoutCancel(r.Context()), ws, &result)
	if err != nil {
		_ = ws.Close()
		return
	}
	go t.runSession(context.WithoutCancel(r.Context()), channel, key)
}

// serveH2Unbounded runs an h2-post-unbounded session (docs/d077 §3): the
// response headers are the session-open signal, and unlike the 101 path the
// handler must stay alive for the whole session — returning would end the
// response body that carries it. Attribution happens at the same point the
// 101 path does it: after auth, before any session work (docs/d078 §5).
func (t *tunnelServer) serveH2Unbounded(w http.ResponseWriter, r *http.Request, key *operatorKey, id string, refused bool, peer *admissionResult, response http.Header) {
	lw := &loggingResponseWriter{ResponseWriter: w, start: time.Now()}
	// The port decides, not a per-request header (docs/d222): the exit
	// serves an edge whose connector caps a single request body, and on that
	// port this carrier is structurally unable to finish a session — the
	// edge rejects the body mid-stream, after the session started. The
	// refusal lands at request initiation, before the body is read, so the
	// relay can learn the port's posture from one cheap response.
	if refused {
		writeProblem(lw, r, http.StatusBadRequest, "h2-post-unbounded-refused",
			"This port serves a capped edge: h2-post-unbounded is refused",
			errors.New("use h2-post-windowed; the relay discovers this refusal"))
		logAccess(r, http.StatusBadRequest, lw.size, lw.start)
		return
	}
	p := &h2UnboundedServerStream{r: r, w: lw, id: id}
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
		logLine(sevError, "[estige] tunnel h2-post-unbounded: full duplex unavailable: %v", err)
		lw.WriteHeader(http.StatusInternalServerError)
		logAccess(r, http.StatusInternalServerError, lw.size, lw.start)
		return
	}

	maps.Copy(lw.Header(), response)
	lw.WriteHeader(http.StatusOK)
	if err := http.NewResponseController(lw).Flush(); err != nil {
		// Headers never made it out: the session cannot exist. The status
		// was not committed, so this is the honest CLF outcome.
		logAccess(r, http.StatusInternalServerError, lw.size, lw.start)
		return
	}
	channel, err := t.wrapChannel(context.WithoutCancel(r.Context()), p, peer)
	if err != nil {
		logLine(sevWarn, "[estige] tunnel h2-post-unbounded: inner handshake failed: %v", err)
		logAccess(r, http.StatusOK, lw.size, lw.start)
		return
	}
	t.runSession(context.WithoutCancel(r.Context()), channel, key)
	logAccess(r, http.StatusOK, lw.size, lw.start)
}

// h2UnboundedServerStream is h2-post-unbounded's carrier (docs/d077 §3/§5): frames ride the HTTP
// request body inbound and the response body outbound. Everything the 101
// path gets from owning its hijacked connection has to be re-earned here
// through net/http's controllers — deadlines per read/write (VPN-R39) and a
// write mutex so the relay's goroutines never interleave frames — while the
// camouflage contract (VPN-R34) is already spent: an unauthenticated POST
// never reached this type.
type h2UnboundedServerStream struct {
	r         *http.Request
	w         http.ResponseWriter
	id        string
	wmu       sync.Mutex
	closeOnce sync.Once
}

func (p *h2UnboundedServerStream) sessionID() string { return p.id }

func (p *h2UnboundedServerStream) readTunnelMsg() ([]byte, error) {
	return readFrameFromStream(p.r.Body)
}

func (p *h2UnboundedServerStream) writeTunnelMsg(msg []byte) error {
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
func (p *h2UnboundedServerStream) setReadDeadline(t time.Time) error {
	return http.NewResponseController(p.w).SetReadDeadline(t)
}

// protocolViolation has no in-band signal to send: a body carries no close
// frame vocabulary, so the teardown itself is the abort — the peer sees the
// response body end (unambiguous without frames once the session's own
// rules define it). See docs/d077 §5.
func (p *h2UnboundedServerStream) protocolViolation() {}

func (p *h2UnboundedServerStream) transport() string { return carrierH2Unbounded }

func (p *h2UnboundedServerStream) Close() error {
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
// over a h2-post-unbounded body.
func (t *tunnelServer) runSession(sessionCtx context.Context, s tunnelStream, key *operatorKey) {
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
	dialCtx, cancel := context.WithTimeout(sessionCtx, tunnelDialTimeout)
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

// enableTunnel wires the tunnel surface from the exit store and fails loudly
// on any input that would weaken an invariant (NFR-2): a misconfigured
// capability that binds anyway is worse than one that refuses to start,
// because it fails OPEN at the first probe instead of never. The store is the
// arming fact and the only config surface — credentials, admitted relays and
// egress all arrive from it (d236), never from the environment.
func (s *server) enableTunnel() error {
	root, err := storeRoot()
	if err != nil {
		return fmt.Errorf("exit store: %w", err)
	}
	store, err := loadExitStore(root)
	if err != nil {
		return err
	}
	keys := make([]operatorKey, 0, len(store.Relays))
	for _, entry := range store.Relays {
		key := operatorKey{id: entry.Name}
		if entry.Egress != nil {
			policy, err := newEgressPolicy(*entry.Egress)
			if err != nil {
				return fmt.Errorf("exit.json relay %q egress: %w", entry.Name, err)
			}
			key.policy = policy
		}
		keys = append(keys, key)
	}
	policy, err := newEgressPolicy(store.Egress)
	if err != nil {
		return fmt.Errorf("exit.json egress: %w", err)
	}
	s.vpn = &tunnelServer{
		keys:      keys,
		admission: trustFromExitStore(store),
		replay:    newNonceRing(replayRingSize),
		principal: store.Principal,
		selfDER:   store.SelfDER,
		private:   store.Private,
		egress:    policy,
		sessions:  newExchangeSessions(),
		live:      newLiveRegistry(),
	}
	logLine(sevInfo, "[estige] tunnel carriers: %s, %s, %s (at %s)",
		carrierH2Unbounded, carrierWebSocket, carrierH2Windowed, tunnelPath)
	return nil
}
