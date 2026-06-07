#!/bin/sh

if [ -x /usr/bin/podman ]; then
	exec podman "$@"
elif [ -x /usr/bin/docker ]; then
	exec docker "$@"
else
	>&2 printf "fatal: can't find container tool"
	exit 91
fi
