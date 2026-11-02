#!/bin/sh
# Unit files are gone; drop the cached definitions.
/usr/bin/systemctl daemon-reload >/dev/null 2>&1 || :

exit 0
