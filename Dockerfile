# Development and test image for robotraconteur_typescript_node.
# Build rr-ts-dev and rr-ts-dev-cpp in robotraconteur_typescript first, then: podman build -t rr-ts-node-dev .
FROM localhost/rr-ts-dev-cpp

WORKDIR /work/robotraconteur_typescript_node
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
