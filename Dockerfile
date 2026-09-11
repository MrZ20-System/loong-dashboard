FROM node:24-bookworm-slim AS build

ENV COREPACK_HOME=/tmp/corepack
WORKDIR /app

RUN corepack enable \
  && corepack prepare pnpm@11.19.0 --activate

RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates git g++ make python3 \
  && rm -rf /var/lib/apt/lists/*

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24-bookworm-slim AS runtime

ENV COREPACK_HOME=/tmp/corepack \
    NODE_ENV=production \
    LOONGBOARD_SYSTEM_CONFIG=/data/system.yaml \
    LOONGBOARD_SERVER_HOST=0.0.0.0 \
    LOONGBOARD_SERVER_PORT=4174
WORKDIR /app

RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@11.19.0 --activate

# Keep the built workspace layout intact so Node resolves the production
# workspace exports and the pinned DSH runtime exactly as native start does.
COPY --from=build /app /app

EXPOSE 4174
VOLUME ["/data"]

CMD ["pnpm", "start"]
