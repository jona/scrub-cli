#!/bin/sh
set -eu

# Rivet runners use neither agentOS nor the bundled local engine executables.
test -d ./node_modules
rm -rf \
    ./node_modules/@rivet-dev/agentos-* \
    ./node_modules/@rivet-dev/agent-os-* \
    ./node_modules/@agentos-software \
    ./node_modules/@rivetkit/engine-cli-*
