#!/bin/sh
# Unit files are installed: drop the cached definitions. The units are not
# enabled here — enabling a role before its env file carries a credential
# would only produce a service that refuses to boot.
/usr/bin/systemctl daemon-reload >/dev/null 2>&1 || :

exit 0
