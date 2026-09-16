"""Structured logging shared by this repo's python tools — same contract as
lib/log.sh / lib/log.mjs: one JSON object per line on stdout.

    {"ts":"2025-09-02T12:00:00Z","level":"info","tool":"local-llm/upkeep","msg":"...","key":"value"}

Env:
    LOG_FORMAT  json|logfmt   (default: json)
    LOG_TOOL    component name (default "python"; set per tool with set_tool(),
                e.g. log.set_tool("local-llm/upkeep"))

No level filtering happens here, ever — debug/trace/warn/error all go to the
stream; a consumer filters downstream with jsonlines tooling (docs/d045).
Stream is stdout by default; a script whose stdout IS the machine-consumed
payload calls set_stream(sys.stderr) once at startup so logs cannot interleave
with the payload (docs/d045).

Usage from a PEP-723 `uv run` script (the script's dir is on sys.path, the
repo root is not — bootstrap by inserting ../lib):

    import pathlib, sys
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "lib"))
    import log
    log.set_tool("local-llm/upkeep")
    log.info("pulled repo", repo="org/name", revision="abc123")
"""
import datetime
import json
import os
import re
import sys
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


def set_tool(name: str) -> None:
    global _tool
    _tool = name


def set_stream(stream) -> None:
    """Route logs away from stdout when this script's stdout is a
    machine-consumed payload (docs/d045); pass sys.stderr."""
    global _stream
    _stream = stream


def emit(level: str, msg: str, **fields) -> None:
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if os.environ.get("LOG_FORMAT") == "logfmt":
        def val(v) -> str:
            s = str(v)
            return json.dumps(s) if re.search(r'[\s"=\\]', s) or s == "" else s
        rest = " ".join(f"{k}={val(v)}" for k, v in fields.items())
        m = json.dumps(msg) if re.search(r'[\s"=\\]', msg) else msg
        line = f"ts={ts} level={level} tool={_tool} msg={m}"
        if rest:
            line += " " + rest
    else:
        rec = {"ts": ts, "level": level, "tool": _tool, "msg": msg, **fields}
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
