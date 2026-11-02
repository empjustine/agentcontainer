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
func proxyEnvLines(proxyAddr, socksAddr string) []string {
	httpURL := "http://" + proxyAddr
	return []string{
		shellAssignment("HTTP_PROXY", httpURL),
		shellAssignment("HTTPS_PROXY", httpURL),
		shellAssignment("ALL_PROXY", "socks5://"+socksAddr),
		shellAssignment("NO_PROXY", mergeNoProxy(os.Getenv("NO_PROXY"))),
		// Node ignores the conventional variables unless this switch is on;
		// it is part of the spelling, not an extra knob (docs/d095).
		shellAssignment("NODE_USE_ENV_PROXY", "1"),
	}
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
