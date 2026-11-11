# Development and test image for robotraconteur_typescript_node.
# Build rr-ts-dev and rr-ts-dev-cpp in robotraconteur_typescript first, then: podman build -t rr-ts-node-dev .
FROM localhost/rr-ts-dev-cpp

# Core's Python test clients and test vector blob, at the Core commit that the robotraconteur
# package's copy of the blob comes from. They run against the TypeScript test services. Keep in
# step with RR_CORE_TEST_VECTORS_REF in .github/workflows/ci.yml
ARG RR_CORE_TEST_VECTORS_REF=7cd1610c519613f241b25453754fb118b270cdaf
RUN git init -q /opt/rr-core-tests \
    && cd /opt/rr-core-tests \
    && git remote add origin https://github.com/robotraconteur/robotraconteur.git \
    && git sparse-checkout set test/python test/robdef test/data \
    && git fetch -q --depth 1 --filter=blob:none origin "${RR_CORE_TEST_VECTORS_REF}" \
    && git checkout -q FETCH_HEAD \
    && rm -rf .git \
    && chmod -R a+rX /opt/rr-core-tests
ENV RR_CORE_PYTHON_TESTS=/opt/rr-core-tests/test/python

WORKDIR /work/robotraconteur_typescript_node
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
