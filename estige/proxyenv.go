package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
)

// proxyEnvLoopback is the always-direct set: a client must be able to reach
// the local services it talks to without going back through the relay.
var proxyEnvLoopback = []string{"127.0.0.1", "localhost", "::1"}

// runProxyEnv is the d095 CHAIN STEP, now a binary verb: print the loopback
// proxy spelling as shell assignments so an operator's shell can
//
//	eval "$(estige proxy-env)"
//
// before starting a client. It starts no process and probes no readiness —
// the relay is a host service (estige-relay.service / the runit service), and
// its own upstream chain is read from the ambient env BEFORE this spelling is
// printed (self-chain refusal lives in relayConfigFromEnv).
func runProxyEnv(args []string) {
	fs := flag.NewFlagSet("proxy-env", flag.ExitOnError)
	proxyAddr := fs.String("proxy-listen", "127.0.0.1:3128", "relay role: loopback HTTP CONNECT listener")
	socksAddr := fs.String("socks-listen", "127.0.0.1:1080", "relay role: loopback SOCKS5 listener")
	_ = fs.Parse(args)

	for _, line := range proxyEnvLines(*proxyAddr, *socksAddr) {
		fmt.Println(line)
	}
}

// proxyEnvLines returns `export KEY='value'` lines: evaluated in the operator's
// shell, the spelling must reach the child process, and a plain assignment
// would not. Values are single-quoted so a URL never undergoes shell expansion.
//
// WHY every conventional variable is printed in BOTH cases (docs/d130): there
// is no agreed case for them — curl and wget disagree on which they read for
// an http:// URL — so exporting one spelling hands any child reading the other
// a DIRECT dial past the kill switch (VPN-R26). The table below is the one
// source of both spellings, so they cannot drift apart.
func proxyEnvLines(proxyAddr, socksAddr string) []string {
	httpURL := "http://" + proxyAddr
	noProxy := mergeNoProxy(os.Getenv("NO_PROXY"))

	// WHY socks5h and not socks5 (docs/d130): the relay's SOCKS listener
	// refuses a literal-IP target because the exit node owns resolution and
	// pinning (VPN-R22), and socks5:// is exactly the spelling that makes a
	// client resolve first and send the refused ATYP. socks5h keeps the name
	// on the wire, which is also what VPN-R24 asks the client to offer.
	conventional := []struct{ name, value string }{
		{"HTTP_PROXY", httpURL},
		{"HTTPS_PROXY", httpURL},
		{"ALL_PROXY", "socks5h://" + socksAddr},
		{"NO_PROXY", noProxy},
	}

	lines := make([]string, 0, 2*len(conventional)+1)
	for _, v := range conventional {
		lines = append(lines, shellAssignment(v.name, v.value), shellAssignment(strings.ToLower(v.name), v.value))
	}
	// NODE_USE_ENV_PROXY is node's own switch, not a conventional variable: it
	// has no lowercase form, and node ignores the proxy variables entirely
	// without it — so it is part of the spelling, not an extra knob (docs/d095).
	return append(lines, shellAssignment("NODE_USE_ENV_PROXY", "1"))
}

// mergeNoProxy keeps loopback direct and appends the host's existing entries
// without duplicating them. One spelling of the merged list, printed once.
func mergeNoProxy(existing string) string {
	items := append([]string{}, proxyEnvLoopback...)
	seen := make(map[string]bool, len(items))
	for _, item := range items {
		seen[item] = true
	}
	for _, item := range strings.Split(existing, ",") {
		item = strings.TrimSpace(item)
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		items = append(items, item)
	}
	return strings.Join(items, ",")
}

func shellAssignment(key, value string) string {
	return "export " + key + "=" + shellQuote(value)
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}
