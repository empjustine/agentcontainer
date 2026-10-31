// generate.go — `estige generate [out]`: emit estige.json, the deployed
// HOST ALLOWLIST (v2, docs/d047 — host routing is the only mode).
//
// The allowlist is the defaults of the OWNER's stack — nothing else is
// routable (deny-by-absence, docs/d047):
//
//  1. pi-ai — piAiProviders below (pi-coding-agent's built-in registry,
//     extracted from the installed pi): one allowHosts row per DISTINCT
//     upstream host, value scheme://host (the HOST ROOT — base paths belong
//     to the client, which is what lets multi-base hosts like opencode vs
//     opencode-go share one row).
//  2. the lib/cloud-providers.json fact table (docs/d024, data since d102)
//     — the hand-added rows the catalogs never knew (cline-pass, hyper,
//     inferx), the pi-native set, and the local llama-swap farm (since d070
//     a plain row keyed by its tsnet serve hostname like every other host).
//  3. two static metadata passthroughs, models.dev and catwalk (public, no
//     keys, never drift-checked against the catalogs).
//
// pi-ai rows with NO single fixed upstream base (per-region bedrock,
// per-project vertex, OAuth backends — piAiNonRoutable below) are reported
// as skips with their reason, so a gap in the allowlist is a decision,
// never an oversight.
//
// The address contract this table serves (docs/d047): a client names the
// upstream HOST as the first path segment and carries the provider's full
// base path after it — `<base>/<host><base-path>` (providerRouteUrl in
// coding-agent/route-probe.mjs, derived from the same fact-table base URLs,
// and what committed artifacts' canonical URLs become at install, docs/d070).
// The proxy strips the route key and single-joins the rest onto the root.
// Routes absent from the table answer the plain funnel 404; keys are
// deliberately NOT consulted — estige performs NO credential handling.
//
// Drift checking is keyed by host (docs/d047): a fact-table provider whose
// upstream host is missing from the deployed allowHosts warns (dead host
// route), and a deployed host no owner source claims warns (unreviewed
// row). The deployed file is re-read so the report reflects what the exit
// node will serve, not what this run held in memory.
//
// Byte-parity with the former node generator is a deliberate contract
// (docs/d102): same artifact bytes (canonical JSON — docs/d050), same log
// line vocabulary and field order, same collapse semantics. It is what let
// the node half be deleted the same commit this landed.
//
// Usage: `estige generate [out]` (out defaults to ./estige.json — the path
// the exit node serves when run from this folder; the root orchestrator
// passes the path explicitly). Env: LIB_DIR (default ../lib, resolved from
// the working directory), LOG_TOOL (log tool override).
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// ---------------------------------------------------------------------------
// Source 1 fact table: pi-ai's BUILT-IN cloud providers (folded in from the
// former lib/pi-ai-providers.mjs — docs/d039; rationale docs/d038). Facts
// were extracted from the installed pi 0.85.1 provider registry and
// cross-checked against pi-mono's packages/ai/src/providers/*.ts. Like every
// vendored catalog here, the copy is a floor, not a feed: a stale row is a
// drifted route, so re-extract when the host's pi version moves.
//
// Only providers with a STABLE, account-independent HTTPS base URL are
// allowlisted — the proxy forwards to scheme://host, so per-region /
// per-project / per-account / OAuth endpoints cannot be expressed.
//
// api is the wire dialect pi-ai speaks against that base (informational:
// the proxy forwards byte-for-byte whatever the client sends, docs/d047);
// otherApis is the provider's remaining registrations (all must share the
// upstream host — providerRouteUrl and d048's per-model api overrides
// handle the dialect split client-side). This table lives in Go code, not
// JSON, because it is this folder's own re-extraction input — no other
// consumer reads it (docs/d102).
// ---------------------------------------------------------------------------

type piAiProvider struct {
	ID        string            `json:"id"`
	Label     string            `json:"label"`
	API       string            `json:"api"`
	BaseURL   string            `json:"baseUrl"`
	APIKeyEnv string            `json:"apiKeyEnv"`
	OtherAPIs map[string]string `json:"otherApis,omitempty"`
}

var piAiProviders = []piAiProvider{
	{ID: "anthropic", Label: "Anthropic", API: "anthropic-messages", BaseURL: "https://api.anthropic.com", APIKeyEnv: "ANTHROPIC_API_KEY"},
	{ID: "openai", Label: "OpenAI", API: "openai-responses", BaseURL: "https://api.openai.com/v1", APIKeyEnv: "OPENAI_API_KEY"},
	{ID: "deepseek", Label: "DeepSeek", API: "openai-completions", BaseURL: "https://api.deepseek.com", APIKeyEnv: "DEEPSEEK_API_KEY"},
	{ID: "google", Label: "Google Gemini", API: "google-generative-ai", BaseURL: "https://generativelanguage.googleapis.com/v1beta", APIKeyEnv: "GEMINI_API_KEY"},
	{ID: "mistral", Label: "Mistral", API: "mistral-conversations", BaseURL: "https://api.mistral.ai", APIKeyEnv: "MISTRAL_API_KEY"},
	{ID: "groq", Label: "Groq", API: "openai-completions", BaseURL: "https://api.groq.com/openai/v1", APIKeyEnv: "GROQ_API_KEY"},
	{ID: "cerebras", Label: "Cerebras", API: "openai-completions", BaseURL: "https://api.cerebras.ai/v1", APIKeyEnv: "CEREBRAS_API_KEY"},
	{ID: "xai", Label: "xAI", API: "openai-responses", BaseURL: "https://api.x.ai/v1", APIKeyEnv: "XAI_API_KEY"},
	{ID: "openrouter", Label: "OpenRouter", API: "openai-completions", BaseURL: "https://openrouter.ai/api/v1", APIKeyEnv: "OPENROUTER_API_KEY"},
	{ID: "opencode", Label: "OpenCode Zen", API: "openai-completions",
		// Four dialects against two bases (zen vs zen/v1) — all on the
		// opencode.ai HOST, so one allowlist row covers them; the client
		// carries its own base path (providerRouteUrl, docs/d047).
		BaseURL: "https://opencode.ai/zen/v1", APIKeyEnv: "OPENCODE_API_KEY",
		OtherAPIs: map[string]string{
			"anthropic-messages":   "https://opencode.ai/zen",
			"google-generative-ai": "https://opencode.ai/zen/v1",
			"openai-responses":     "https://opencode.ai/zen/v1",
		}},
	{ID: "opencode-go", Label: "OpenCode Go", API: "openai-completions", BaseURL: "https://opencode.ai/zen/go/v1", APIKeyEnv: "OPENCODE_API_KEY",
		OtherAPIs: map[string]string{
			"anthropic-messages": "https://opencode.ai/zen/go",
			"openai-responses":   "https://opencode.ai/zen/go/v1",
		}},
	{ID: "together", Label: "Together AI", API: "openai-completions", BaseURL: "https://api.together.ai/v1", APIKeyEnv: "TOGETHER_API_KEY"},
	{ID: "baseten", Label: "Baseten", API: "openai-completions", BaseURL: "https://inference.baseten.co/v1", APIKeyEnv: "BASETEN_API_KEY"},
	{ID: "fireworks", Label: "Fireworks", API: "openai-completions",
		// pi-mono providers/fireworks.ts: base WITHOUT the /v1 the ai-sdk
		// dialect appends — pi's own path composition supplies it.
		BaseURL: "https://api.fireworks.ai/inference", APIKeyEnv: "FIREWORKS_API_KEY"},
	{ID: "huggingface", Label: "Hugging Face", API: "openai-completions", BaseURL: "https://router.huggingface.co/v1", APIKeyEnv: "HF_TOKEN"},
	{ID: "kimi-coding", Label: "Kimi For Coding", API: "anthropic-messages", BaseURL: "https://api.kimi.com/coding", APIKeyEnv: "KIMI_API_KEY"},
	{ID: "minimax", Label: "MiniMax", API: "anthropic-messages", BaseURL: "https://api.minimax.io/anthropic", APIKeyEnv: "MINIMAX_API_KEY"},
	{ID: "minimax-cn", Label: "MiniMax (China)", API: "anthropic-messages", BaseURL: "https://api.minimaxi.com/anthropic", APIKeyEnv: "MINIMAX_CN_API_KEY"},
	{ID: "moonshotai", Label: "Moonshot", API: "openai-completions", BaseURL: "https://api.moonshot.ai/v1", APIKeyEnv: "MOONSHOT_API_KEY"},
	{ID: "moonshotai-cn", Label: "Moonshot (China)", API: "openai-completions", BaseURL: "https://api.moonshot.cn/v1", APIKeyEnv: "MOONSHOT_API_KEY"},
	{ID: "zai", Label: "Z.AI", API: "openai-completions", BaseURL: "https://api.z.ai/api/coding/paas/v4", APIKeyEnv: "ZAI_API_KEY"},
	{ID: "zai-coding-cn", Label: "ZAI Coding Plan (China)", API: "openai-completions", BaseURL: "https://open.bigmodel.cn/api/coding/paas/v4", APIKeyEnv: "ZAI_CODING_CN_API_KEY"},
	{ID: "ant-ling", Label: "Ant Ling", API: "openai-completions", BaseURL: "https://api.ant-ling.com/v1", APIKeyEnv: "ANT_LING_API_KEY"},
	{ID: "vercel-ai-gateway", Label: "Vercel AI Gateway", API: "anthropic-messages", BaseURL: "https://ai-gateway.vercel.sh", APIKeyEnv: "AI_GATEWAY_API_KEY"},
	{ID: "qwen-token-plan", Label: "Qwen Token Plan", API: "openai-completions", BaseURL: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", APIKeyEnv: "QWEN_TOKEN_PLAN_API_KEY"},
	{ID: "qwen-token-plan-cn", Label: "Qwen Token Plan (China)", API: "openai-completions", BaseURL: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", APIKeyEnv: "QWEN_TOKEN_PLAN_CN_API_KEY"},
	{ID: "qwen-token-plan-individual", Label: "Qwen Token Plan (Individual)", API: "openai-completions",
		// Same upstream as qwen-token-plan — one allowHosts row covers both;
		// the client's base path distinguishes nothing here (same base too).
		BaseURL: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", APIKeyEnv: "QWEN_TOKEN_PLAN_API_KEY"},
	{ID: "xiaomi", Label: "Xiaomi MiMo", API: "openai-completions", BaseURL: "https://api.xiaomimimo.com/v1", APIKeyEnv: "XIAOMI_API_KEY"},
	{ID: "xiaomi-token-plan-cn", Label: "Xiaomi MiMo Token Plan (China)", API: "openai-completions", BaseURL: "https://token-plan-cn.xiaomimimo.com/v1", APIKeyEnv: "XIAOMI_TOKEN_PLAN_CN_API_KEY"},
	{ID: "xiaomi-token-plan-ams", Label: "Xiaomi MiMo Token Plan (Amsterdam)", API: "openai-completions", BaseURL: "https://token-plan-ams.xiaomimimo.com/v1", APIKeyEnv: "XIAOMI_TOKEN_PLAN_AMS_API_KEY"},
	{ID: "xiaomi-token-plan-sgp", Label: "Xiaomi MiMo Token Plan (Singapore)", API: "openai-completions", BaseURL: "https://token-plan-sgp.xiaomimimo.com/v1", APIKeyEnv: "XIAOMI_TOKEN_PLAN_SGP_API_KEY"},
}

// pi-ai providers with NO single fixed upstream host — reported as skips so
// the allowlist gap is a decision, never an oversight (docs/d047). Order
// matches piAiProviders' registry order, which is the log order.
var piAiNonRoutable = []struct{ id, reason string }{
	{"amazon-bedrock", "per-region SigV4 endpoints (bedrock-runtime.<region>.amazonaws.com)"},
	{"google-vertex", "per-project + per-location endpoints ({location}-aiplatform.googleapis.com)"},
	{"azure-openai-responses", "per-resource endpoints (<resource>.openai.azure.com)"},
	{"cloudflare-ai-gateway", "per-account gateway URL ({CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID} placeholders)"},
	{"cloudflare-workers-ai", "per-account URL (api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID})"},
	{"openai-codex", "ChatGPT subscription OAuth backend (chatgpt.com/backend-api), not a public provider endpoint"},
	{"github-copilot", "GitHub subscription OAuth with per-user endpoints (api.individual.githubcopilot.com)"},
	{"radius", "dynamic gateway — the base URL is per-deployment configuration, not a registry fact"},
	{"faux", "pi's built-in test provider — no network endpoint"},
}

// cloudProviderRow is one row of lib/cloud-providers.json (docs/d024): the
// SHARED fact table, JSON since d102 so this generator and every node
// generator read the same bytes. Only id/baseUrl feed the allowlist; the
// rest is carried for completeness of the shared shape.
type cloudProviderRow struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	APIKeyEnv string `json:"apiKeyEnv"`
	BaseURL   string `json:"baseUrl"`
	Support   string `json:"support"`
	Note      string `json:"note,omitempty"`
}

// generatedConfig is the deployed config document. Field order matters:
// json.Marshal emits struct fields in declaration order, and the committed
// bytes put listen first (the node generator's assembly order — docs/d050
// keeps everything except the named maps as constructed). AllowHosts is a
// map, so encoding/json sorts its keys in code-unit order — the same
// canonical rule canonicalizeManifest applied.
type generatedConfig struct {
	Listen     string            `json:"listen"`
	AllowHosts map[string]string `json:"allowHosts"`
}

// hostKey is the allowlist KEY form of a full base URL: host[:port], no
// scheme, no path — the first path segment a client route names (docs/d047).
func hostKey(rawURL string) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	if u.Host == "" {
		return "", fmt.Errorf("no host in %q", rawURL)
	}
	return u.Host, nil
}

// hostRoot is the allowlist VALUE form: scheme://host[:port] — the root the
// proxy single-joins the client's remainder onto; base paths belong to the
// client (providerRouteUrl, docs/d047).
func hostRoot(rawURL string) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	return u.Scheme + "://" + u.Host, nil
}

// runGenerate is the `generate` subcommand: build the allowlist, write the
// config atomically (lib/artifact.mjs's contract — tmp + rename, replace),
// then report drift against the DEPLOYED file. Returns the process exit
// code (0 on success).
func runGenerate(args []string) int {
	setLogTool("estige/generate")

	out := "estige.json"
	if len(args) > 0 {
		out = args[0]
	}
	libDir := os.Getenv("LIB_DIR")
	if libDir == "" {
		libDir = "../lib"
	}

	// The allowlist: owner-set hosts only (header). One row per DISTINCT
	// upstream host, insertion-ordered — the collapse LOG follows this
	// order, byte-identical to the retired node generator.
	rows, err := loadCloudProviderRows(filepath.Join(libDir, "cloud-providers.json"))
	if err != nil {
		logRecord("error", "fact table unreadable", "err", err.Error())
		return 1
	}

	allowHosts := map[string]string{}
	allowHost := func(id, rawURL string) {
		key, err := hostKey(rawURL)
		if err != nil {
			logRecord("error", "owner row has an unusable base URL", "id", id, "err", err.Error())
			return
		}
		// Same host from several owner rows collapses to one entry — the
		// value is the host root, so there is nothing to conflict on
		// (docs/d047).
		if _, seen := allowHosts[key]; seen {
			logRecord("info", "owner rows share one upstream host — collapsed to one allowlist row", "host", key, "id", id)
			return
		}
		root, err := hostRoot(rawURL)
		if err != nil {
			logRecord("error", "owner row has an unusable base URL", "id", id, "err", err.Error())
			return
		}
		allowHosts[key] = root
	}

	for _, p := range piAiProviders {
		allowHost(p.ID, p.BaseURL)
	}
	// d070 §2: llama-swap rides in as a plain fact-table row — its tsnet
	// serve hostname keys the allowlist exactly like a cloud host, so no
	// alias row and no LLAMA_SWAP_BASE_URL loopback exception survive
	// (host state precondition: the serve endpoint must exist when this
	// config deploys).
	for _, row := range rows {
		allowHost(row.ID, row.BaseURL)
	}
	allowHost("models.dev", "https://models.dev")
	allowHost("catwalk", "https://catwalk.charm.land")

	for _, p := range piAiNonRoutable {
		logRecord("info", "pi-ai row has no fixed upstream host — not allowlisted", "provider", p.id, "reason", p.reason)
	}

	// Atomic replace (docs/d023/d058): the committed file's git diff is the
	// only review surface — no dry-run mode, no opt-in overwrite flag.
	doc := generatedConfig{Listen: "0.0.0.0:8080", AllowHosts: allowHosts}
	body, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		logRecord("error", "config marshal failed", "err", err.Error())
		return 1
	}
	if err := writeArtifact(out, append(body, '\n')); err != nil {
		logRecord("error", "config write failed", "path", out, "err", err.Error())
		return 1
	}
	logRecord("info", "wrote estige host-allowlist config", "path", out, "allowHosts", len(allowHosts))

	// Drift checks, keyed by host (docs/d047): re-read the deployed file so
	// the report reflects what the exit node will serve.
	deployed, err := readDeployedAllowHosts(out)
	if err != nil {
		logRecord("error", "deployed config unreadable", "path", out, "err", err.Error())
		return 1
	}
	for _, row := range rows {
		key, err := hostKey(row.BaseURL)
		if err != nil {
			continue // the write already logged the unusable URL loudly
		}
		if _, ok := deployed[key]; !ok {
			logRecord("warn", "fact-table provider's host NOT in the deployed allowHosts", "provider", row.ID, "host", key)
		}
	}
	// The owner set is pi-ai ∪ fact table ∪ the two static passthroughs.
	// Deployed keys are iterated in sorted order — the deployed file is
	// canonical (sorted), so this is the file's own order, as in node.
	for _, key := range sortedKeys(deployed) {
		known := false
		for _, p := range piAiProviders {
			if k, err := hostKey(p.BaseURL); err == nil && k == key {
				known = true
				break
			}
		}
		if !known {
			for _, row := range rows {
				if k, err := hostKey(row.BaseURL); err == nil && k == key {
					known = true
					break
				}
			}
		}
		if !known && key != "models.dev" && key != "catwalk.charm.land" {
			logRecord("warn", "deployed allowHosts entry no owner source claims — drift", "host", key)
		}
	}

	// The write above is atomic, so reaching here means `out` exists — the
	// node script's trailing existence check is what proved the same thing.
	logRecord("info", "host allowlist ready", "path", out)
	return 0
}

// loadCloudProviderRows reads the shared fact table. The array order is the
// collapse/drift log order — the same bytes node generators read (docs/d102).
func loadCloudProviderRows(path string) ([]cloudProviderRow, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var rows []cloudProviderRow
	if err := json.Unmarshal(data, &rows); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	for _, row := range rows {
		if row.ID == "" || row.BaseURL == "" {
			return nil, fmt.Errorf("%s: row missing id or baseUrl (%q)", path, row.ID)
		}
	}
	return rows, nil
}

// readDeployedAllowHosts parses the deployed config's allowHosts map.
func readDeployedAllowHosts(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var doc struct {
		AllowHosts map[string]string `json:"allowHosts"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return doc.AllowHosts, nil
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// writeArtifact writes tmp + rename (lib/artifact.mjs's atomic-replace
// contract, docs/d023): a failed or partial write never clobbers the live
// artifact.
func writeArtifact(out string, body []byte) error {
	tmp := out + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, out)
}

// --- structured logging (docs/d045 — one JSON object per line) -------------
// Byte-shape parity with lib/log.mjs: ts/level/tool/msg first, then the
// caller's fields IN THE ORDER GIVEN (not map-random, not alphabetical), no
// HTML escaping — operator tooling cannot tell which generator half ran.

var logTool = "estige"

func setLogTool(tool string) {
	logTool = tool
}

func logRecord(level, msg string, fields ...any) {
	var line bytes.Buffer
	fmt.Fprintf(&line, `{"ts":%s,"level":%s,"tool":%s,"msg":%s`, encodeValue(time.Now().UTC().Format("2006-01-02T15:04:05Z")), encodeValue(level), encodeValue(logTool), encodeValue(msg))
	for i := 0; i+1 < len(fields); i += 2 {
		fmt.Fprintf(&line, ",%s:%s", encodeValue(fmt.Sprint(fields[i])), encodeValue(fields[i+1]))
	}
	line.WriteString("}\n")
	os.Stdout.Write(line.Bytes())
}

// encodeValue renders one JSON scalar/object without node's (JSON.stringify)
// escaping differences: no HTML escaping, UTF-8 passthrough.
func encodeValue(v any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return []byte(`""`)
	}
	return bytes.TrimRight(buf.Bytes(), "\n")
}
