package main

import (
	"encoding/json"
	"testing"
)

// docs/d084 pins the arming contract: the config can veto or assert the
// tunnel family but never grant it — the operator keyset env is the opt-in
// (docs/d085).
func TestShouldArmTunnel(t *testing.T) {
	on, off := true, false
	cases := []struct {
		name     string
		cfg      *tunnelConfig
		envArmed bool
		want     bool
	}{
		{"nil config, unarmed env", nil, false, false},
		{"nil config, armed env", nil, true, true},
		{"absent enabled, armed env", &tunnelConfig{}, true, true},
		{"absent enabled, unarmed env", &tunnelConfig{}, false, false},
		{"veto beats armed env", &tunnelConfig{Enabled: &off}, true, false},
		{"assert with unarmed env resolves arm (enableTunnel fails the boot loudly)", &tunnelConfig{Enabled: &on}, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := shouldArmTunnel(tc.cfg, tc.envArmed); got != tc.want {
				t.Errorf("shouldArmTunnel(%+v, %v) = %v, want %v", tc.cfg, tc.envArmed, got, tc.want)
			}
		})
	}
}

// The tri-state is a wire-format contract (absent vs false vs true in the
// JSON), so the parse is pinned alongside the resolver.
func TestTunnelConfigEnabledTriState(t *testing.T) {
	cases := []struct {
		in   string
		want *bool
	}{
		{`{}`, nil},
		{`{"enabled": true}`, &[]bool{true}[0]},
		{`{"enabled": false}`, &[]bool{false}[0]},
	}
	for _, tc := range cases {
		var got tunnelConfig
		if err := json.Unmarshal([]byte(tc.in), &got); err != nil {
			t.Fatalf("Unmarshal(%s) err=%v", tc.in, err)
		}
		switch {
		case tc.want == nil && got.Enabled != nil:
			t.Errorf("Unmarshal(%s) Enabled=%v, want absent", tc.in, *got.Enabled)
		case tc.want != nil && (got.Enabled == nil || *got.Enabled != *tc.want):
			t.Errorf("Unmarshal(%s) Enabled=%v, want %v", tc.in, got.Enabled, *tc.want)
		}
	}
}
