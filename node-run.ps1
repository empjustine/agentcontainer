# node-run.ps1 — run node with the repo-pinned version, as a command.
#
# The PowerShell counterpart of ./node-run.sh (docs/d041, d062, d138), and
# invoked the same way since d138 — a shim runs it, it does not dot-source it:
#
#   & "$PSScriptRoot/../node-run.ps1" "$PSScriptRoot/maintain-mirrors.mjs" @args
#
# WHAT carried over whole from d041: the pin is honored, no globals are set, no
# secrets are touched. The BRANCH differs because the signal differs: sh keys on
# the Termux profile, which is the one place the mise manager is absent, and
# Windows carries no profile signal at all — so the branch here asks the
# capability directly. mise on PATH -> the pin; no mise -> bare node, of the
# same standing as sh's Termux arm (a host whose interpreter is not mise's to
# manage). Deliberately 5.1-compatible: no ternary, no `??`, no
# -AdditionalChildPath, so Windows PowerShell and pwsh both run it.
#
# No `exit` on purpose: a script invoked with `&` shares the caller's runspace,
# so $LASTEXITCODE is already node's — and an `exit` here would end the caller's
# shell if this file were ever dot-sourced out of habit.
if (Get-Command mise -ErrorAction SilentlyContinue) {
	mise x node@24 -- node @args
} else {
	node @args
}
