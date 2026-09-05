"""Structured logging shared by this repo's python tools — same contract as
lib/log.sh / lib/log.mjs: one JSON object per line on stderr.

    {"ts":"2025-09-02T12:00:00Z","level":"info","tool":"local-llm/upkeep","msg":"...","key":"value"}

Env:
    LOG_LEVEL   debug|info|warn|error   (default: info)
    LOG_FORMAT  json|logfmt             (default: json)
    LOG_TOOL    component name          (default "python"; set per tool with
                set_tool(), e.g. log.set_tool("local-llm/upkeep"))

Stdout stays reserved for machine-consumed output — never log to it.

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

_PRIOS = {"debug": 0, "info": 1, "warn": 2, "error": 3}
_threshold = _PRIOS.get(os.environ.get("LOG_LEVEL", "info").lower(), 1)
_tool = os.environ.get("LOG_TOOL", "python")


def set_tool(name: str) -> None:
    global _tool
    _tool = name


def emit(level: str, msg: str, **fields) -> None:
    if _PRIOS.get(level, 1) < _threshold:
        return
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
        line = json.dumps(rec, ensure_ascii=False, default=str)
    print(line, file=sys.stderr)


def debug(msg: str, **fields) -> None:
    emit("debug", msg, **fields)


def info(msg: str, **fields) -> None:
    emit("info", msg, **fields)


def warn(msg: str, **fields) -> None:
    emit("warn", msg, **fields)


def error(msg: str, **fields) -> None:
    emit("error", msg, **fields)
