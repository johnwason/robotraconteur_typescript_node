#!/bin/sh
# Run a command in the development container with this repository and the shared package mounted.
# node_modules comes from the image through an anonymous volume.
# Set RR_SHARED to use a different checkout of robotraconteur_typescript.
cd "$(dirname "$0")/.." || exit 1
shared=$(cd "${RR_SHARED:-../robotraconteur_typescript}" && pwd) || exit 1
exec podman run --rm \
    -v "$PWD:/work/robotraconteur_typescript_node:Z" \
    -v /work/robotraconteur_typescript_node/node_modules \
    -v "$shared:/work/robotraconteur_typescript:Z" \
    -w /work/robotraconteur_typescript_node \
    ${RR_TEST_SERVER_SCRIPT:+-e RR_TEST_SERVER_SCRIPT="$RR_TEST_SERVER_SCRIPT"} \
    rr-ts-node-dev "$@"
