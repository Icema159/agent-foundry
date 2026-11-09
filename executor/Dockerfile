FROM node:22-alpine AS executor
WORKDIR /app
COPY dist/isolated-executor/ ./
COPY package.json ./package.json
RUN mkdir -p /ledger /secrets /demo-output && chmod -R a-w /app
USER 10001:10001
ENTRYPOINT ["node", "/app/main.mjs"]

FROM node:22-alpine AS private-api
WORKDIR /app
COPY package.json ./package.json
COPY node_modules ./node_modules
COPY dist/src ./dist/src
# Root-owned code remains immutable to UID10001; launch also requires --read-only.
USER 10001:10001
ENV FOUNDRY_PRIVATE_API=1
ENTRYPOINT ["node", "/app/dist/src/executor-runtime/private-api.js"]

# Opt-in test instrumentation. Production builds use target executor/private-api.
FROM executor AS write-fault-test
COPY dist/executor-fault/main.mjs /app/main.mjs
