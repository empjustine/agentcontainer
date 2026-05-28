#!/bin/sh

set -xe

cat agentcontainer.Containerfile | podman build -t 'localhost/agentcontainer:latest' -
