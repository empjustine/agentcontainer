package main

// forwarding_test.go — docs/d144's argv grammar and one end-to-end forward.

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestParseForwardArg(t *testing.T) {
	cases := []struct {
		arg     string
		want    forwardSpec
		wantErr string
	}{
		{arg: "2222:git.example.com:22", want: forwardSpec{bind: "127.0.0.1", port: 2222, host: "git.example.com", dest: 22}},
		{arg: "127.0.0.2:5432:db.example:5432", want: forwardSpec{bind: "127.0.0.2", port: 5432, host: "db.example", dest: 5432}},
		{arg: "::1:9000:svc:80", wantErr: "port"},
		{arg: "8080:host", wantErr: "want"},
		{arg: "8080::80", wantErr: "empty"},
		{arg: "0:host:80", wantErr: "port"},
		{arg: "8080:host:70000", wantErr: "port"},
		{arg: "0.0.0.0:8080:host:80", wantErr: "loopback"},
		{arg: "8080:host:80:extra", wantErr: "port"},
	}
	for _, tc := range cases {
		got, err := parseForwardArg(tc.arg)
		if tc.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("parseForwardArg(%q) err=%v, want containing %q", tc.arg, err, tc.wantErr)
			}
			continue
		}
		if err != nil {
			t.Errorf("parseForwardArg(%q): %v", tc.arg, err)
			continue
		}
		if got != tc.want {
			t.Errorf("parseForwardArg(%q) = %+v, want %+v", tc.arg, got, tc.want)
		}
	}
}

func TestParseForwardsRejectsDuplicatesAndTheCap(t *testing.T) {
	if _, err := parseForwards([]string{"9000:a:1", "127.0.0.1:9000:b:2"}); err == nil ||
		!strings.Contains(err.Error(), "already bound") {
		t.Fatalf("duplicate listener: err=%v", err)
	}
	args := make([]string, 0, maxForwards+1)
	for i := range maxForwards + 1 {
		args = append(args, fmt.Sprintf("%d:host:%d", 9000+i, i+1))
	}
	if _, err := parseForwards(args); err == nil || !strings.Contains(err.Error(), "cap") {
		t.Fatalf("cap: err=%v", err)
	}
}

// TestLocalForwardEndToEnd: one -L listener, one ordinary CONNECT per
// accepted connection, the exit's egress table unchanged.
func TestLocalForwardEndToEnd(t *testing.T) {
	upstream := newHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("hello-forward"))
	}))
	upPort := portOf(t, upstream.Listener.Addr().String())

	armTestTunnelEnv(t)
	s := &server{}
	if err := s.enableTunnel(egressConfig{
		AllowCidrs: []string{"127.0.0.0/8"},
		Ports:      []uint16{upPort},
	}); err != nil {
		t.Fatal(err)
	}
	exit := newHTTPSServer(t, s)

	t.Setenv(envTunnelURL, "wss://"+exit.Listener.Addr().String()+tunnelPath)
	t.Setenv(envClientLabel, "forward-e2e")
	httpAddr := freeLoopbackAddr(t)
	socksAddr := freeLoopbackAddr(t)
	cfg, err := relayConfigFromEnv(httpAddr, socksAddr, false, false)
	if err != nil {
		t.Fatal(err)
	}
	_, portText, err := net.SplitHostPort(freeLoopbackAddr(t))
	if err != nil {
		t.Fatal(err)
	}
	listenPort, err := strconv.ParseUint(portText, 10, 16)
	if err != nil {
		t.Fatal(err)
	}
	cfg.forwards = []forwardSpec{{bind: "127.0.0.1", port: uint16(listenPort), host: testTargetAlias, dest: upPort}}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runRelayNode(ctx, cfg) }()
	waitForHealth(t, "http://"+httpAddr+healthPath)
	logBuf := captureLog(t)

	conn, err := new(net.Dialer).DialContext(context.Background(), "tcp", net.JoinHostPort("127.0.0.1", strconv.FormatUint(listenPort, 10)))
	if err != nil {
		t.Fatalf("forward listener: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := conn.Write([]byte("GET /fwd HTTP/1.1\r\nHost: local.test\r\nConnection: close\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatalf("forward response: %v", err)
	}
	defer resp.Body.Close()
	body := make([]byte, len("hello-forward"))
	if _, err := resp.Body.Read(body); err != nil && err.Error() != "EOF" {
		t.Fatal(err)
	}
	if string(body) != "hello-forward" {
		t.Fatalf("body=%q", body)
	}
	waitForLog(t, logBuf, "via=forward")
	if strings.Contains(logBuf.String(), testTunnelToken) {
		t.Fatalf("credential leaked through the forward path:\n%s", logBuf.String())
	}

	// Close the forwarded connection before draining: a live session makes
	// the drain wait out its grace, which is the intended production
	// behaviour but not what this test is measuring.
	_ = conn.Close()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("relay shutdown: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("relay did not stop")
	}
}
