#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""run.py — llama-swap launcher for LOCAL GGUF inference (container hosts
only; podman/docker). Entered as::

    ./environment.sh ./py-run.sh llm-local-inference/run.py

Cloud/remote relaying is served by ../estige — this launcher runs the single
llama-swap instance that owns local llama.cpp serving.

Port model (docs/d027, reshaped by d070, port moved by d224):
llama-swap publishes LAN port ${HOST_PORT:-9292} → in-container 8080, which is
upstream llama-swap's own example shape (`-p 9292:8080` over the image's
default `-listen 0.0.0.0:8080`). Host port 8080 belongs to ../estige — the
tailscale funnel serves the whole <funnel-id> route on it — so this launcher
takes a different one. The world reaches this instance only through its tsnet
`tailscale serve` hostname (the fact-table row in
../coding-agent/lib/cloud-providers.json), which maps the host root onto the
publish port above.

llama-server's own default port (9931 in current llama.cpp) is deliberately
unreachable from here: the LLAMA_SERVER macro in 00-general.yaml always passes
`--port ${PORT}`, and llama-swap assigns ${PORT} from `startPort`
(llama-swap-core.json). Backend ports stay llama-swap's internal concern, so no
client or outside host ever names one.

d170 folded the former shell runner (run.sh + lib/workload-runtime.sh + the
lib/workload-*.jq filters) into this file: the description API existed
because shell has no arrays; Python does, so the jq layer is gone. The runner
also no longer inspects the host beyond the container backend and the GPU
device nodes (d170 Decisions 5-6): the mount-source checks, the env
allowlist machinery, and the .paths staleness preflight are all removed —
stale baked paths surface as a swap-time 127 from llama-server, and their
offline re-verify is upkeep.py's open follow-up (d170, Consequences).

Env overrides:
    HOST_PORT          container published port (default 9292, upstream's example)
    LLAMA_SWAP_IMAGE   container image override
    HF_HUB_CACHE       HF cache override (default XDG_CACHE_HOME/huggingface/hub;
                       must match the cache the generator baked model paths from)

Secrets: arrive as plain environment — loaded by the explicit chain
(./environment.sh, the ONE infisical round-trip). TLALOCAYOTL_API_KEY is the
tlalocayotl provider row's own key — the fact table's local-farm row, whose id
is still `llama-swap` (the provider's former name; earlier still `bazzite`) —
and it doubles as this instance's inbound bearer because that row IS this
instance (00-general.yaml apiKeys). No cloud provider uses it. It is read ONCE
below and forwarded unconditionally when set, never inspected further (d170
Decision 6). HF_TOKEN is deliberately NOT forwarded: model paths are baked into
the generated config at generation time (docs/d029 option B), so nothing
in-container downloads — provisioning is ./40-download-models.py on the HOST.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import NoReturn

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
import log

log.set_tool("llm-local-inference/run")
# This script prints no payload — everything is log lines on stderr.
log.set_stream(sys.stderr)

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_D = SCRIPT_DIR / "config.d"
# Guest path = the generator's HUB_GUEST constant — changing one means
# changing both in the same edit. Read-only: nothing in-container writes the
# cache anymore (no launch-time downloads); provisioning/pruning happen on
# the host (./py-run.sh llm-local-inference/run_all.py).
HUB_GUEST = "/home/ubuntu/.cache/huggingface/hub"
CONTAINER_NAME = "llama-swap"
DEFAULT_IMAGE = "ghcr.io/mostlygeek/llama-swap:unified-vulkan"


def die(code: int, msg: str, **fields: object) -> NoReturn:
	log.error(msg, **fields)
	raise SystemExit(code)


def pick_backend() -> tuple[str, list[str]]:
	"""The container backend (podman preferred, docker fallback) plus the
	per-backend run prefixes. Rootless podman maps the invoking user
	(--userns=keep-id, --group-add keep-groups); docker runs rootful as-is —
	the same split the retired workload-runtime.sh carried."""
	if shutil.which("podman"):
		return "podman", ["--userns=keep-id", "--group-add", "keep-groups"]
	if shutil.which("docker"):
		return "docker", []
	die(
		91,
		"no container tool (podman/docker) — local inference requires the container backend",
	)


def collect_gpu_devs() -> list[str]:
	"""The device nodes a llama.cpp host can expose: the ROCm node plus every
	DRI render node. A GPU-less host yields an empty list — the capability
	gate that refuses such a host lives in the generator (docs/d087), not
	here."""
	devices = ["/dev/kfd"] if Path("/dev/kfd").exists() else []
	dri = Path("/dev/dri")
	if dri.is_dir():
		# Render nodes sit one level down (/dev/dri/renderD128): the d170 port
		# scanned /dev itself and so passed none of them.
		devices += sorted(str(p) for p in dri.iterdir() if p.name.startswith("renderD"))
	return devices


def main() -> None:
	# d215: no accepted arguments — argv is a mistake, not a comment field.
	if len(sys.argv) > 1:
		die(64, "run.py takes no arguments", argv=sys.argv[1:])

	if not CONFIG_D.is_dir():
		die(
			94,
			"config.d not found — generate it first with ./node-run.sh llm-local-inference/30-generate.mjs",
			dir=str(CONFIG_D),
		)
	layer = CONFIG_D / "10-local-llm-inference.yaml"
	if not layer.is_file():
		die(
			94,
			"no local-inference layer in config.d — this host cannot serve local inference (run ./node-run.sh llm-local-inference/30-generate.mjs on a GPU-capable container host)",
			dir=str(CONFIG_D),
		)

	# The tlalocayotl row's key is read ONCE here and never inspected again; it
	# is forwarded unconditionally when set, and a bare --env with an unset
	# host var would inject an EMPTY value (read as "set"), so the launch dies
	# instead (d170 Decision 6: fail forward on the one secret this runner
	# carries).
	api_key = os.environ.get("TLALOCAYOTL_API_KEY", "").strip()
	if not api_key:
		die(91, "TLALOCAYOTL_API_KEY is empty — load it through ./environment.sh")

	backend, backend_flags = pick_backend()
	hub_cache = Path(
		os.environ.get("HF_HUB_CACHE")
		or Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache")))
		/ "huggingface"
		/ "hub"
	)
	host_port = os.environ.get("HOST_PORT", "9292")
	image = os.environ.get("LLAMA_SWAP_IMAGE", DEFAULT_IMAGE)

	log.info("serving local inference", image=image, port=host_port, backend=backend)

	# Remove by name through every backend, not just the one picked for run:
	# podman and docker keep separate stores, so a stale container left by the
	# other tool would collide with --name at run time.
	for tool in ("podman", "docker"):
		if shutil.which(tool):
			subprocess.run(
				[tool, "container", "rm", "-f", CONTAINER_NAME],
				stdout=subprocess.DEVNULL,
				stderr=subprocess.DEVNULL,
				check=False,
			)

	argv = [
		backend,
		"container",
		"run",
		*backend_flags,
		"--name",
		CONTAINER_NAME,
		"--detach",
		"--init",
		"--publish",
		f"{host_port}:8080",
		# UID-mapped mounts need the invoking identity, not the container root.
		"--user",
		f"{os.environ.get('SUDO_UID', str(os.getuid()))}:{os.environ.get('SUDO_GID', str(os.getgid()))}",
		"--read-only",
		"--tmpfs",
		"/tmp:rw,size=64m",
	]
	for dev in collect_gpu_devs():
		argv += ["--device", dev]
	argv += [
		"--volume",
		f"{hub_cache}:{HUB_GUEST}:ro",
		"--volume",
		f"{CONFIG_D}:/etc/llama-swap/config.d:ro",
		"--security-opt",
		"no-new-privileges",
		"--cap-drop",
		"ALL",
		"--env",
		f"TLALOCAYOTL_API_KEY={api_key}",
		"--entrypoint",
		"llama-swap",
		image,
		"-config-dir",
		"/etc/llama-swap/config.d",
		# The image's own default (and what upstream's example publishes as
		# 9292); the host-side publish above is the only number a client sees
		# (docs/d224).
		"-listen",
		"0.0.0.0:8080",
	]
	# No infisical wrapper here: the values were loaded by the explicit chain
	# (./environment.sh) and are forwarded as plain env above.
	launched = subprocess.run(argv, check=False)
	if launched.returncode != 0:
		die(launched.returncode, "container launch failed", image=image)

	time.sleep(5)
	logs = subprocess.run(
		[backend, "logs", CONTAINER_NAME],
		check=False,
		capture_output=True,
		text=True,
	)
	sys.stdout.write("\n".join(logs.stdout.splitlines()[:20]) + "\n")


if __name__ == "__main__":
	main()
