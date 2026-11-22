"""Route third-party log records through this unit's structured log.

Vetted libraries (`huggingface_hub`, `gguf`, `pypdf`) log through
standard logging with their own handlers, so their prose lands on stderr
beside lib/log.py's JSON lines (docs/d045). Third-party prose cannot follow the
static-message rule, but the level, logger name and exception can be fields.
tqdm bars are not log records and stay each downloader's own concern.

Usage: import dep_log next to log, then call dep_log.install() once at startup.
Adding a logging dependency means adding its root logger to LOGGERS here.
"""

import logging

import log

# Root logger names of the vetted dependencies that emit through stdlib logging.
LOGGERS = ("huggingface_hub", "gguf", "pypdf", "py.warnings")

_LEVELS = (
    (logging.CRITICAL, "fatal"),
    (logging.ERROR, "error"),
    (logging.WARNING, "warn"),
    (logging.INFO, "info"),
    (logging.DEBUG, "debug"),
)


class _StructuredHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        level = next((name for floor, name in _LEVELS if record.levelno >= floor), "debug")
        fields = {"logger": record.name}
        if record.exc_info and record.exc_info[1] is not None:
            fields["error"] = record.exc_info[1]
        log.emit(level, record.getMessage(), **fields)


def install() -> None:
    """Replace library handlers and capture warnings as log records."""
    for name in LOGGERS:
        target = logging.getLogger(name)
        for handler in target.handlers[:]:
            target.removeHandler(handler)
        target.addHandler(_StructuredHandler())
        target.propagate = False
    # Library notices such as vault/auth failures use warnings.warn rather
    # than a logger; captureWarnings feeds them to py.warnings above.
    logging.captureWarnings(True)
