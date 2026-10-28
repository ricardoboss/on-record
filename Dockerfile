FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS catalogue
WORKDIR /app
RUN apk add --no-cache python3
COPY scripts/build-genres-bulk.py ./scripts/build-genres-bulk.py
ARG MUSICBRAINZ_SNAPSHOT=latest
RUN --mount=type=cache,id=musicbrainz-archives,target=/var/cache/musicbrainz,sharing=locked \
    python3 scripts/build-genres-bulk.py --snapshot "$MUSICBRAINZ_SNAPSHOT" --cache-dir /var/cache/musicbrainz

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
COPY src/ ./src/
COPY public/ ./public/
COPY tests/ ./tests/
COPY index.html tsconfig*.json vite.config.ts ./
COPY --from=catalogue /app/src/data/catalogue/genres.json ./src/data/catalogue/genres.json
RUN npm run build

# Only the compiled site and server configuration reach the runtime image.
FROM nginxinc/nginx-unprivileged:stable-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/ /srv/on-record/
COPY docker/headers.awk /usr/local/share/on-record/headers.awk

# Adapt the build's static-host headers for NGINX.
USER root
RUN test -s /srv/on-record/index.html \
    && awk -f /usr/local/share/on-record/headers.awk /srv/on-record/_headers \
       > /etc/nginx/security-headers.conf

USER nginx
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1

# Skip upstream configuration hooks so the container can run with a read-only root filesystem.
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
