# maintain.ps1 — interpreter shim: run the repo-pinned node on the mirror
# maintenance. Windows-native counterpart of maintain.sh: WSL2 misbehaves on
# non-NTFS and non-local UNC farm roots, so those roots are maintained from
# Windows itself, with Git for Windows talking to the share directly
# (docs/d062 owns the rationale and the file-ownership rule). Usage lives in
# maintain-mirrors.mjs (--help) and non-bare-issues.md. No secrets and no
# container runtime are involved.
#
# Fail-fast like maintain.sh's `set -eu`: a missing lib or script aborts
# instead of falling through to a run with nothing loaded.
$ErrorActionPreference = 'Stop'
# '/'-spelled paths resolve on every PowerShell host — the shim itself stays
# testable off Windows (docs/d062).
. "$PSScriptRoot/../lib/node-run.ps1"
node_run "$PSScriptRoot/maintain-mirrors.mjs" @args
exit $LASTEXITCODE
