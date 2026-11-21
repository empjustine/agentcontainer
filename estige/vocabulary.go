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

	// protoHTTP11 is the h1 ALPN token: the h2 carriers' downgrade target and
	// the h1.1-post-windowed floor (offering h2 there would silently promote
	// a floor session onto the h2 plane).
	protoHTTP11 = "http/1.1"

	// Carrier names are mechanism names, never letters (docs/d105): one
	// spelling per carrier, shared by the lifecycle log, the relay's policy
	// memory and the exit's admission decisions.
	carrierH2Unbounded = "h2-post-unbounded"
	carrierH2Windowed  = "h2-post-windowed"
	carrierWebSocket   = "websocket"
	carrierH1Windowed  = "h1.1-post-windowed"

	// envHTTPProxy/envHTTPSProxy are the uppercase spellings the chain parser
	// reads first and the proxy-env table exports (docs/d094, docs/d130);
	// the lowercase forms are derived with strings.ToLower.
	envHTTPProxy  = "HTTP_PROXY"
	envHTTPSProxy = "HTTPS_PROXY"
)
