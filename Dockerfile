ARG NODE_BUILD_IMAGE=node:24-bookworm
ARG NODE_RUNTIME_IMAGE=node:24-bookworm-slim
FROM --platform=${BUILDPLATFORM} ${NODE_BUILD_IMAGE} AS dependencies

WORKDIR /opt/node_app

ARG TARGETARCH

COPY package.json yarn.lock ./
COPY excalidraw-app/package.json excalidraw-app/
COPY packages/common/package.json packages/common/
COPY packages/element/package.json packages/element/
COPY packages/excalidraw/package.json packages/excalidraw/
COPY packages/fractional-indexing/package.json packages/fractional-indexing/
COPY packages/interactive-widgets/package.json packages/interactive-widgets/
COPY packages/laser-pointer/package.json packages/laser-pointer/
COPY packages/math/package.json packages/math/
COPY packages/utils/package.json packages/utils/

ENV YARN_CACHE_FOLDER=/root/.cache/yarn

# do not ignore optional dependencies:
# Error: Cannot find module @rollup/rollup-linux-x64-gnu
RUN --mount=type=cache,target=/root/.cache/yarn \
    npm_config_target_arch=${TARGETARCH} yarn --frozen-lockfile --network-timeout 600000

COPY . .

FROM dependencies AS development

ENV NODE_ENV=development

EXPOSE 3001

CMD ["yarn", "--cwd", "./excalidraw-app", "start", "--host", "0.0.0.0"]

FROM dependencies AS build

ARG NODE_ENV=production

RUN npm_config_target_arch=${TARGETARCH} yarn build:production

FROM ${NODE_RUNTIME_IMAGE} AS production

WORKDIR /opt/node_app
ENV NODE_ENV=production
COPY --from=build /opt/node_app/excalidraw-app/build ./excalidraw-app/build
COPY --from=build /opt/node_app/excalidraw-app/server-dist ./excalidraw-app/server-dist
EXPOSE 3001
CMD ["node", "excalidraw-app/server-dist/main.mjs"]

HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
