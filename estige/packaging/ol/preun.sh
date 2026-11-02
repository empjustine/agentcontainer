#!/bin/sh
# Final erase: stop both roles. The env files are conffiles, so an upgrade or
# reinstall leaves the operator's credentials in place.
if [ "$1" -eq 0 ] && [ -x /usr/bin/systemctl ]; then
	/usr/bin/systemctl --no-reload disable --now estige.service estige-relay.service >/dev/null 2>&1 || :
fi

exit 0
