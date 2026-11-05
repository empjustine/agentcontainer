// vocabulary.go — the wire spellings more than one carrier names: URL schemes,
// the h1 ALPN token, the body carriers' log value, and the proxy environment
// variables. They live in one place because a second spelling of a fact is the
// drift class docs/d090 kills: the ALPN offer, the chain parser's scheme
// switch and the proxy-env table must agree on "wss" and "socks5" by
// construction, not by review. goconst surfaced the repetition; the names
// carry the meaning, the values are the wire.
package main

const (
	schemeHTTP   = "http"
	schemeHTTPS  = "https"
	schemeWS     = "ws"
	schemeWSS    = "wss"
	schemeSOCKS5 = "socks5"

	// protoHTTP11 is the h1 ALPN token: mode C's downgrade target and mode
	// E's floor (docs/d077 — offering h2 on E's transport would silently
	// promote a floor session onto C's plane).
	protoHTTP11 = "http/1.1"

	// transportPOST is the lifecycle log's carrier value for the body
	// carriers (docs/d077's h2 | wss | post vocabulary). The relay node
	// can tell C from E by its own plane, but the log stays stable.
	transportPOST = "post"

	// envHTTPProxy/envHTTPSProxy are the uppercase spellings the chain parser
	// reads first and the proxy-env table exports (docs/d094, docs/d130);
	// the lowercase forms are derived with strings.ToLower.
	envHTTPProxy  = "HTTP_PROXY"
	envHTTPSProxy = "HTTPS_PROXY"
)
