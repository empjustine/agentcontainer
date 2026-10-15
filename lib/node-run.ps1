# lib/node-run.ps1 — run node with the repo-pinned version, standalone.
#
# The PowerShell counterpart of lib/node-run.sh (docs/d041, docs/d062): a
# Windows shim dot-sources this file and calls
#
#   node_run <script.mjs> [args...]
#
# d041's contract carries over whole — pin honored, sourcing sets no globals
# (so it cannot collide with the caller's own state or source order), no
# secrets. The BRANCH differs because the signal differs: sh keys on the
# Termux profile, which is the one place the mise manager is absent, and
# Windows carries no profile signal at all — so the branch here asks the
# capability directly. mise on PATH -> the pin; no mise -> bare node, of the
# same standing as sh's Termux arm (a host whose interpreter is not mise's to
# manage). Deliberately 5.1-compatible: no ternary, no `??`, no
# -AdditionalChildPath, so Windows PowerShell and pwsh both run it.
function node_run {
	if (Get-Command mise -ErrorAction SilentlyContinue) {
		mise x node@24 -- node @args
	} else {
		node @args
	}
}
