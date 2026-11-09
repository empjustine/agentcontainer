"""Structured logging shared by this repo's python tools — same contract as
lib/log.sh / lib/log.mjs: one JSON object per line on stdout.

    {"msg":"...","key":"value","ts":1756824000000,"severityNumber":9,"tool":"llm-local-inference/upkeep"}

`msg` leads and this kernel's three fields trail it, so the event is what a
truncated view keeps. `ts` is Unix epoch MILLISECONDS as a number and
`severityNumber` is OpenTelemetry's SeverityNumber, so a reader compares
numbers where it used to match level words (docs/d151 owns the record shape,
its field order and the canonical ranges).

Env:
    LOG_FORMAT  json|logfmt   (default: json)
    LOG_TOOL    component name (default "python"; set per tool with set_tool(),
                e.g. log.set_tool("llm-local-inference/upkeep"))

Level filtering is the consumer's job (docs/d045, reaffirmed by docs/d060):
nothing is dropped here. A tool logs the useful-but-noisy detail at `debug`
unconditionally instead of growing a --verbose branch, and whoever reads the
stream prunes it (`jq 'select(.severityNumber >= 5)'`, or one band with
`jq 'select(.severityNumber >= 17)'`). docs/d045 owns the rest of the contract
(static labels, structured fields, full cause chains).
Stream is stdout by default; a script whose stdout IS the machine-consumed
payload calls set_stream(sys.stderr) once at startup so logs cannot interleave
with the payload (docs/d045).

Usage from a PEP-723 `uv run` script (the script's dir is on sys.path, its
`lib/` is not — bootstrap by inserting this folder's own lib):

    import pathlib, sys
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "lib"))
    import log
    log.set_tool("llm-local-inference/upkeep")
    log.info("pulled repo", repo="org/name", revision="abc123")
"""
import json
import os
import re
import sys
import time
import traceback

_tool = os.environ.get("LOG_TOOL", "python")
_stream = sys.stderr if os.environ.get("LOG_STREAM") == "stderr" else sys.stdout

# Same policy as lib/log.mjs (docs/d045): exceptions in fields serialize as
# structured objects — name, message, traceback, and the explicit __cause__
# chain — never as interpolated prose. python's implicit __context__ is left
# out: it fires for ANY exception raised inside an except block, which would
# attach unrelated noise to every logged failure.
def _serialize(obj, depth=0):
    if isinstance(obj, BaseException):
        out = {"name": type(obj).__name__, "message": str(obj)}
        tb = "".join(traceback.format_exception(type(obj), obj, obj.__traceback__))
        if tb:
            out["traceback"] = tb
        if depth < 8 and obj.__cause__ is not None:
            out["cause"] = _serialize(obj.__cause__, depth + 1)
        return out
    return str(obj)


# OpenTelemetry SeverityNumber per level (docs/d151); the category name is
# the caller-facing spelling, the number is what reaches the wire. 0 is the
# spec's "unspecified" and no helper here can produce it.
_SEVERITY_NUMBER = {
    "trace": 1,
    "debug": 5,
    "info": 9,
    "warn": 13,
    "error": 17,
    "fatal": 21,
}


def _severity_number(level: str) -> int:
    """A level name as its SeverityNumber. An unknown level fails here rather
    than serializing no severity: a record nobody can sort is worse than a
    loud call-site bug."""
    try:
        return _SEVERITY_NUMBER[level]
    except KeyError:
        raise ValueError("unknown log level", level) from None


def set_tool(name: str) -> None:
    global _tool
    _tool = name


def set_stream(stream) -> None:
    """Route logs away from stdout when this script's stdout is a
    machine-consumed payload (docs/d045); pass sys.stderr."""
    global _stream
    _stream = stream


def emit(level: str, msg: str, **fields) -> None:
    # The event leads; the three fields this kernel fills in trail it, so a
    # reader skimming raw lines meets what happened before the bookkeeping
    # (docs/d151).
    trailer = {
        "ts": int(time.time() * 1000),
        "severityNumber": _severity_number(level),
        "tool": _tool,
    }
    if os.environ.get("LOG_FORMAT") == "logfmt":
        def val(v) -> str:
            s = str(v)
            return json.dumps(s) if re.search(r'[\s"=\\]', s) or s == "" else s
        rest = " ".join(f"{k}={val(v)}" for k, v in fields.items())
        m = json.dumps(msg) if re.search(r'[\s"=\\]', msg) else msg
        trailer = " ".join(f"{k}={v}" for k, v in trailer.items())
        line = " ".join(part for part in (f"msg={m}", rest, trailer) if part)
    else:
        rec = {"msg": msg, **fields, **trailer}
        line = json.dumps(rec, ensure_ascii=False, default=lambda o: _serialize(o))
    print(line, file=_stream)


def debug(msg: str, **fields) -> None:
    emit("debug", msg, **fields)


def info(msg: str, **fields) -> None:
    emit("info", msg, **fields)


def warn(msg: str, **fields) -> None:
    emit("warn", msg, **fields)


def error(msg: str, **fields) -> None:
    emit("error", msg, **fields)
