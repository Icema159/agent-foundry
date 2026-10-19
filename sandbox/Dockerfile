FROM node:22-alpine AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --ignore-scripts && npm run build

FROM node:22-alpine
WORKDIR /opt/foundry
COPY package.json ./package.json
COPY --from=build /build/dist/src/sandbox/tool-runner.js ./tool-runner.js
USER node
ENTRYPOINT ["node", "/opt/foundry/tool-runner.js"]
