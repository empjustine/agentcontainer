// forwarding.go — ssh-style local port forwarding on the relay node
// (docs/d144).
//
// WHY a listener per argv argument and not a config surface: the invocation
// IS the statement (ssh's own model). Each accepted connection buys its own
// tunnel exactly as a CONNECT does — no new frame, no new credential rule,
// no store entry, no egress change — so d104's one-authentication-one-
// connection bound holds unchanged and the exit's policy remains the only
// egress decision. The loopback-only bind keeps VPN-R23 structural.
package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
)

// maxForwards bounds the listener set the way maxStorePeers bounds the
// principal set: a structural cap, not a performance one (docs/d144).
const maxForwards = 32

// forwardSpec is one parsed -L argument.
type forwardSpec struct {
	bind string // loopback address the listener binds (default 127.0.0.1)
	port uint16 // listener port
	host string // target hostname; resolution stays at the exit (VPN-R22)
	dest uint16 // target port
}

func (f forwardSpec) listenAddr() string { return net.JoinHostPort(f.bind, strconv.Itoa(int(f.port))) }
func (f forwardSpec) target() string     { return net.JoinHostPort(f.host, strconv.Itoa(int(f.dest))) }

// forwardList is the repeatable -L flag.
type forwardList []string

func (l *forwardList) String() string { return strings.Join(*l, " ") }

func (l *forwardList) Set(v string) error {
	*l = append(*l, v)
	return nil
}

// parseForwards validates the whole argv set before any bind: a broken
// forward never becomes a listening socket (docs/d144).
func parseForwards(args []string) ([]forwardSpec, error) {
	if len(args) > maxForwards {
		return nil, fmt.Errorf("%d -L forwards exceed cap %d (docs/d144)", len(args), maxForwards)
	}
	specs := make([]forwardSpec, 0, len(args))
	seen := make(map[string]struct{}, len(args))
	for i, arg := range args {
		spec, err := parseForwardArg(arg)
		if err != nil {
			return nil, fmt.Errorf("-L[%d] %q: %w", i, arg, err)
		}
		if _, dup := seen[spec.listenAddr()]; dup {
			return nil, fmt.Errorf("-L[%d] %q: %s is already bound (docs/d144)", i, arg, spec.listenAddr())
		}
		seen[spec.listenAddr()] = struct{}{}
		specs = append(specs, spec)
	}
	return specs, nil
}

// parseForwardArg accepts ssh's spelling: [<bind>:]<port>:<host>:<port>.
func parseForwardArg(arg string) (forwardSpec, error) {
	fields := strings.Split(arg, ":")
	// A bracketed IPv6 target reintroduces colons; d144 keeps the grammar
	// to host names and IPv4-shaped fields, and an IPv6 target is a future
	// widening rather than a silently mis-parsed listener.
	if len(fields) != 3 && len(fields) != 4 {
		return forwardSpec{}, errors.New("want [<bind>:]<port>:<host>:<port>")
	}
	bind := "127.0.0.1"
	if len(fields) == 4 {
		bind = fields[0]
		fields = fields[1:]
	}
	listenPort, err := parseForwardPort(fields[0])
	if err != nil {
		return forwardSpec{}, fmt.Errorf("listener port: %w", err)
	}
	host := fields[1]
	if host == "" {
		return forwardSpec{}, errors.New("target host is empty")
	}
	destPort, err := parseForwardPort(fields[2])
	if err != nil {
		return forwardSpec{}, fmt.Errorf("target port: %w", err)
	}
	if err := requireLoopback(net.JoinHostPort(bind, strconv.Itoa(int(listenPort)))); err != nil {
		return forwardSpec{}, err
	}
	return forwardSpec{bind: bind, port: listenPort, host: host, dest: destPort}, nil
}

func parseForwardPort(s string) (uint16, error) {
	n, err := strconv.ParseUint(s, 10, 16)
	if err != nil || n == 0 {
		return 0, fmt.Errorf("%q is not a port number", s)
	}
	return uint16(n), nil
}

// bindForwards binds every listener before serving any: half a forward set
// is a configuration the operator did not ask for, so a failure closes what
// was opened and refuses startup.
func (c *relayNode) bindForwards(runCtx context.Context, specs []forwardSpec) ([]net.Listener, error) {
	listeners := make([]net.Listener, 0, len(specs))
	for _, spec := range specs {
		ln, err := new(net.ListenConfig).Listen(runCtx, "tcp", spec.listenAddr())
		if err != nil {
			for _, opened := range listeners {
				_ = opened.Close()
			}
			return nil, fmt.Errorf("forward %s: %w", spec.listenAddr(), err)
		}
		listeners = append(listeners, ln)
		logLine(sevInfo, "[vpn-relay] forward %s -> %s (docs/d144)", spec.listenAddr(), spec.target())
	}
	return listeners, nil
}

// serveForward accepts until the listener closes; each connection runs the
// ordinary CONNECT path with the argument's target.
func (c *relayNode) serveForward(runCtx context.Context, ln net.Listener, spec forwardSpec) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go c.runForwardConn(runCtx, conn, spec)
	}
}

func (c *relayNode) runForwardConn(runCtx context.Context, conn net.Conn, spec forwardSpec) {
	defer func() { _ = conn.Close() }()
	target := spec.target()
	s, err := c.openTunnel(runCtx, target)
	if err != nil {
		// A forward whose tunnel cannot open reports through the records,
		// never through a direct dial (VPN-R26, docs/d144).
		c.refusedRecord(target, viaForward, "", tunnelErrReason(err))
		return
	}
	live, finish := c.beginRelaySession(s, target, viaForward, "")
	stats, _ := relay(s, conn, live)
	finish(stats.outcome)
}
