#!/bin/sh
# container-tool.sh — shared container-runtime detection.  Source it;
# assumes the repo lives at ~/agentcontainer.  Sets globals:
#   _container_tool 'podman'|'docker'; _userns/_keep_groups/_vol_u (rootless
#   podman SELinux/UID flags, empty on docker).
# See docs/container-tooling.md.

if [ -x /usr/bin/podman ]; then
	_container_tool='podman'
	_userns='--userns=keep-id'
	_keep_groups='--group-add keep-groups'
	_vol_u=',U'
elif [ -x /usr/bin/docker ]; then
	_container_tool='docker'
	_userns=''
	_keep_groups=''
	_vol_u=''
else
	>&2 printf "fatal: can't find container tool"
	exit 91
fi
