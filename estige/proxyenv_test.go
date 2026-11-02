package main

import (
	"reflect"
	"testing"
)

func TestProxyEnvLinesMergesNoProxyAndQuotes(t *testing.T) {
	t.Setenv("NO_PROXY", "internal.test, 127.0.0.1")

	got := proxyEnvLines("127.0.0.1:3128", "127.0.0.1:1080")
	want := []string{
		"export HTTP_PROXY='http://127.0.0.1:3128'",
		"export HTTPS_PROXY='http://127.0.0.1:3128'",
		"export ALL_PROXY='socks5://127.0.0.1:1080'",
		"export NO_PROXY='127.0.0.1,localhost,::1,internal.test'",
		"export NODE_USE_ENV_PROXY='1'",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("proxyEnvLines mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestShellQuoteSurvivesApostrophe(t *testing.T) {
	if got, want := shellQuote("a'b"), `'a'\''b'`; got != want {
		t.Fatalf("shellQuote = %q, want %q", got, want)
	}
}
