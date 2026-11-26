package main

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func admissionMaterial(t *testing.T, priv ed25519.PrivateKey) []byte {
	t.Helper()
	der, err := mintPrincipalCertificate(priv, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func admissionPub(t *testing.T, priv ed25519.PrivateKey) ed25519.PublicKey {
	t.Helper()
	pub, ok := priv.Public().(ed25519.PublicKey)
	if !ok {
		t.Fatal("key is not Ed25519")
	}
	return pub
}

func TestValidateRelayAdmission(t *testing.T) {
	relayPriv := testHostKey(t)
	relayDER := admissionMaterial(t, relayPriv)
	exitPriv := testHostKey(t)
	exitDER := admissionMaterial(t, exitPriv)
	trust := admissionTrust{"relay_bazzite": {relayCertFromDER(t, relayDER)}}

	headers, _, err := channelRequestHeaders(relayPriv, "relay_bazzite", "exit-home", relayDER)
	if err != nil {
		t.Fatal(err)
	}
	result, err := validateRelayAdmission(headers.Values(eRelayAuthHeader), headers.Values(ePubHeader), trust, "exit-home", newNonceRing(4))
	if err != nil {
		t.Fatal(err)
	}
	if result.Name != "relay_bazzite" || len(result.Nonce) != 16 || !result.Cert.Equal(trust["relay_bazzite"][0]) {
		t.Fatalf("result = %+v", result)
	}

	response, err := channelResponseHeaders(exitPriv, "exit-home", "relay_bazzite", result.Nonce, exitDER)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := verifyExitAuth(response.Get(eExitAuthHeader), admissionPub(t, exitPriv), "exit-home", "relay_bazzite", result.Nonce); err != nil {
		t.Fatalf("exit proof: %v", err)
	}
}

func relayCertFromDER(t *testing.T, der []byte) *x509.Certificate {
	t.Helper()
	cert, err := parsePrincipalCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return cert
}

func TestValidateRelayAdmissionFailures(t *testing.T) {
	relayPriv := testHostKey(t)
	relayDER := admissionMaterial(t, relayPriv)
	otherPriv := testHostKey(t)
	otherDER := admissionMaterial(t, otherPriv)

	headers, _, err := channelRequestHeaders(relayPriv, "relay_bazzite", "exit-home", relayDER)
	if err != nil {
		t.Fatal(err)
	}
	trust := admissionTrust{"relay_bazzite": {relayCertFromDER(t, relayDER)}}

	wrongCert := make(http.Header)
	wrongCert.Set(eRelayAuthHeader, headers.Get(eRelayAuthHeader))
	wrongCert.Set(ePubHeader, encodeEPub(otherDER))
	_, err = validateRelayAdmission(wrongCert.Values(eRelayAuthHeader), wrongCert.Values(ePubHeader), trust, "exit-home", newNonceRing(4))
	var untrusted *untrustedPeerError
	if !errors.As(err, &untrusted) || untrusted.Name != "relay_bazzite" {
		t.Fatalf("wrong certificate: %v", err)
	}

	unknown, _, err := channelRequestHeaders(otherPriv, "relay_laptop", "exit-home", otherDER)
	if err != nil {
		t.Fatal(err)
	}
	_, err = validateRelayAdmission(unknown.Values(eRelayAuthHeader), unknown.Values(ePubHeader), trust, "exit-home", newNonceRing(4))
	if !errors.As(err, &untrusted) || untrusted.Name != "relay_laptop" {
		t.Fatalf("unknown principal: %v", err)
	}

	tampered := strings.Replace(headers.Get(eRelayAuthHeader), "v2.", "v3.", 1)
	_, err = validateRelayAdmission([]string{tampered}, headers.Values(ePubHeader), trust, "exit-home", newNonceRing(4))
	if err == nil || errors.As(err, &untrusted) {
		t.Fatalf("tampered token: %v", err)
	}
}

func TestTrustMapFromTheExitStore(t *testing.T) {
	cert := relayCertFromDER(t, admissionMaterial(t, testHostKey(t)))
	var relayRow relayPeerEntry
	relayRow.Name = "relay_bazzite"
	relayRow.Cert = cert
	exit := &exitStore{Relays: []relayPeerEntry{relayRow}}
	if pinnedCertificate(trustFromExitStore(exit), "relay_bazzite", cert) == nil {
		t.Fatal("exit trust map lost its pinned certificate")
	}
}

func TestMutualAdmissionAndSingleUseProofs(t *testing.T) {
	relayPriv, exitPriv := testHostKey(t), testHostKey(t)
	relayDER, exitDER := admissionMaterial(t, relayPriv), admissionMaterial(t, exitPriv)
	exitTrust := admissionTrust{"relay": {relayCertFromDER(t, relayDER)}}
	relayTrust := admissionTrust{"exit": {relayCertFromDER(t, exitDER)}}
	exitRing, relayRing := newNonceRing(4), newNonceRing(4)

	headers, nonce, err := channelRequestHeaders(relayPriv, "relay", "exit", relayDER)
	if err != nil {
		t.Fatal(err)
	}
	result, err := validateRelayAdmission(headers.Values(eRelayAuthHeader), headers.Values(ePubHeader), exitTrust, "exit", exitRing)
	if err != nil {
		t.Fatal(err)
	}
	response, err := admissionResponse(exitPriv, "exit", exitDER, &result)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateExitAdmission(response.Values(eExitAuthHeader), response.Values(ePubHeader), relayTrust, "exit", "relay", nonce, relayRing); err != nil {
		t.Fatal(err)
	}

	// Both halves are single-use: the same bytes cannot answer a second
	// exchange, even though their signatures and pins are still valid.
	if _, err := validateRelayAdmission(headers.Values(eRelayAuthHeader), headers.Values(ePubHeader), exitTrust, "exit", exitRing); err == nil {
		t.Fatal("replayed relay proof was accepted")
	}
	if err := validateExitAdmission(response.Values(eExitAuthHeader), response.Values(ePubHeader), relayTrust, "exit", "relay", nonce, relayRing); err == nil {
		t.Fatal("replayed exit proof was accepted")
	}

	// A captured exit proof does not bind a later relay nonce.
	fresh, freshNonce, err := channelRequestHeaders(relayPriv, "relay", "exit", relayDER)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := validateRelayAdmission(fresh.Values(eRelayAuthHeader), fresh.Values(ePubHeader), exitTrust, "exit", exitRing); err != nil {
		t.Fatal(err)
	}
	if err := validateExitAdmission(response.Values(eExitAuthHeader), response.Values(ePubHeader), relayTrust, "exit", "relay", freshNonce, relayRing); err == nil {
		t.Fatal("exit proof from another exchange verified")
	}
}

func TestExitAdmissionRefusesWrongPin(t *testing.T) {
	exitPriv := testHostKey(t)
	exitDER := admissionMaterial(t, exitPriv)
	otherDER := admissionMaterial(t, testHostKey(t))
	relayPriv := testHostKey(t)
	relayDER := admissionMaterial(t, relayPriv)
	headers, nonce, err := channelRequestHeaders(relayPriv, "relay", "exit", relayDER)
	if err != nil {
		t.Fatal(err)
	}
	result, err := validateRelayAdmission(headers.Values(eRelayAuthHeader), headers.Values(ePubHeader), admissionTrust{"relay": {relayCertFromDER(t, relayDER)}}, "exit", newNonceRing(4))
	if err != nil {
		t.Fatal(err)
	}
	response, err := admissionResponse(exitPriv, "exit", exitDER, &result)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateExitAdmission(response.Values(eExitAuthHeader), response.Values(ePubHeader), admissionTrust{"exit": {relayCertFromDER(t, otherDER)}}, "exit", "relay", nonce, newNonceRing(4)); err == nil {
		t.Fatal("exit proof verified against the wrong pin")
	}
}

func TestNonceRingEvictsAtCapacity(t *testing.T) {
	ring := newNonceRing(2)
	one, two, three := bytesOf(1), bytesOf(2), bytesOf(3)
	if !ring.consume(one) || !ring.consume(two) || ring.consume(one) {
		t.Fatal("ring did not track the first two nonces")
	}
	if !ring.consume(three) || ring.consume(two) {
		t.Fatal("ring did not evict the oldest nonce")
	}
}

// d131: a refused exit proof is a credential failure, not a carrier failure.
// The dial must stop at the first rung instead of demoting — otherwise an
// impostor that fails to answer with the pinned exit's proof simply gets the
// session handed to it on the next rung.
func TestWrongExitPinStopsTheLadder(t *testing.T) {
	s := newTunnelServer(t, true, egressConfig{AllowCidrs: []string{"127.0.0.0/8"}, Ports: []uint16{1}})
	exit := newHTTPSServer(t, s)
	exitAddr := exit.Listener.Addr().String()

	// The relay keeps the suite identity (so the exit admits it) but pins a
	// foreign certificate for the exit.
	foreignDER, err := mintPrincipalCertificate(testHostKey(t), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	relayFile := fmt.Sprintf(`{"endpoint":"wss://%s%s","exit":[{"name":%q,"public":%q}]}`,
		exitAddr, tunnelPath, testV5Principal, encodeEPub(foreignDER))
	writeTestRoleFile(t, "relay.json", relayFile)
	logBuf := captureLog(t)
	// The hint's dedupe window is process-global, so a repeat run
	// (go test -count=2) must start it empty for this assertion to mean
	// anything.
	resetSeenHosts()
	httpAddr := freeLoopbackAddr(t)
	cfg, err := relayConfigFromEnv(httpAddr, freeLoopbackAddr(t), relaySelection{}, false, false)
	if err != nil {
		t.Fatal(err)
	}
	runCtx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runRelayNode(runCtx, cfg) }()
	waitForHealth(t, "http://"+httpAddr+healthPath)

	conn := rawDial(t, httpAddr)
	defer conn.Close()
	mustWrite(t, conn, "CONNECT "+testTargetAlias+":443 HTTP/1.1\r\nHost: "+testTargetAlias+"\r\n\r\n")
	status, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		t.Fatalf("CONNECT status: %v", err)
	}
	if strings.Contains(status, " 200 ") {
		t.Fatalf("the impostor exit served the session: %q", strings.TrimSpace(status))
	}
	// The refusal is terminal, and the relay still hands the operator the
	// hint the certificate earned: one seen_hosts event, no next rung.
	waitForLog(t, logBuf, `"msg":"seen_hosts"`)
	if dumped := logBuf.String(); strings.Contains(dumped, "trying h2-post-windowed") {
		t.Fatalf("a refused exit proof demoted the ladder:\n%s", dumped)
	}
	req, err := http.NewRequestWithContext(runCtx, http.MethodGet, "http://"+httpAddr+healthPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	health, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer health.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(health.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if last, _ := body["last_error"].(string); !strings.Contains(last, "channel admission failed") {
		t.Fatalf("last_error = %q, want the admission refusal", last)
	}
}

// d133's staged rotation: one exit name carrying two certificates. Admission
// trusts either row and the inner channel must pin the same set — a relay
// that pinned only row 0 would clear the proof and then die in the handshake
// until the operator reordered the rows.
func TestStagedExitRotationPinsEveryRow(t *testing.T) {
	upstream := newHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "rotation-ok")
	}))
	upPort := portOf(t, upstream.Listener.Addr().String())
	s := newTunnelServer(t, true, egressConfig{AllowCidrs: []string{"127.0.0.0/8"}, Ports: []uint16{upPort}})
	exit := newHTTPSServer(t, s)
	exitAddr := exit.Listener.Addr().String()

	// A foreign certificate first, the live one second: row order must not
	// decide whether the session works.
	foreignDER, err := mintPrincipalCertificate(testHostKey(t), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	relayFile := fmt.Sprintf(`{"endpoint":"wss://%s%s","exit":[{"name":%q,"public":%q},{"name":%q,"public":%q}]}`,
		exitAddr, tunnelPath,
		testV5Principal, encodeEPub(foreignDER),
		testV5Principal, encodeEPub(testV5CertDER))
	writeTestRoleFile(t, "relay.json", relayFile)
	httpAddr := freeLoopbackAddr(t)
	cfg, err := relayConfigFromEnv(httpAddr, freeLoopbackAddr(t), relaySelection{}, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.peerCerts) != 2 {
		t.Fatalf("pinned %d certificates for a two-row exit, want both", len(cfg.peerCerts))
	}
	rctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runRelayNode(rctx, cfg) }()
	waitForHealth(t, "http://"+httpAddr+healthPath)

	conn := rawDial(t, httpAddr)
	defer conn.Close()
	mustWrite(t, conn, fmt.Sprintf("CONNECT %s:%d HTTP/1.1\r\nHost: %s\r\n\r\nGET /rot HTTP/1.1\r\nHost: local.test\r\nConnection: close\r\n\r\n",
		testTargetAlias, upPort, testTargetAlias))
	br := bufio.NewReader(conn)
	status, err := br.ReadString('\n')
	if err != nil || !strings.Contains(status, " 200 ") {
		t.Fatalf("CONNECT: %q err=%v", status, err)
	}
	resp := readHTTPResponse(t, br)
	defer resp.Body.Close()
	if body, _ := io.ReadAll(resp.Body); string(body) != "rotation-ok" {
		t.Fatalf("body=%q, want the tunnel to survive a staged exit rotation", body)
	}
}

// argv may name the peer (exit row / security principal) and re-route the
// endpoint; the store's first row is only the implicit default.
func TestRelaySelectionNamesTheExit(t *testing.T) {
	store, err := loadRelayStore(mustStoreRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	if _, certs, err := store.selectExit(""); err != nil || len(certs) == 0 {
		t.Fatalf("default selection: certs=%d err=%v", len(certs), err)
	}
	if _, _, err := store.selectExit("no-such-exit"); err == nil {
		t.Fatal("an exit name the store does not pin was accepted")
	}
	writeTestRelayJSON(t, "wss://example.invalid/vpn")
	t.Setenv(envClientLabel, "selection")
	cfg, err := relayConfigFromEnv(freeLoopbackAddr(t), freeLoopbackAddr(t), relaySelection{Exit: testV5Principal}, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.peerName != testV5Principal || len(cfg.peerCerts) == 0 {
		t.Fatalf("selected peer = %q with %d certs", cfg.peerName, len(cfg.peerCerts))
	}
	override, err := relayConfigFromEnv(freeLoopbackAddr(t), freeLoopbackAddr(t),
		relaySelection{Endpoint: "https://override.example:8443/vpn"}, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if override.tunnelURL.Host != "override.example:8443" || override.tunnelURL.Scheme != schemeWSS {
		t.Fatalf("endpoint override = %s", override.tunnelURL)
	}
	if len(override.peerCerts) == 0 {
		t.Fatal("the endpoint override dropped the pinned certificate set")
	}
	// A cleartext override still needs the degraded switch.
	if _, err := relayConfigFromEnv(freeLoopbackAddr(t), freeLoopbackAddr(t),
		relaySelection{Endpoint: "ws://override.example/vpn"}, false, false); err == nil {
		t.Fatal("a cleartext endpoint override bypassed -insecure-exit")
	}
}
