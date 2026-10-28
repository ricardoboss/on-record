# Package an existing production build. No Node.js or metadata retrieval is needed here.
FROM nginxinc/nginx-unprivileged:stable-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY dist/ /srv/on-record/
COPY docker/headers.awk /usr/local/share/on-record/headers.awk

# Adapt the existing static-host headers; this does not compile or fetch app data.
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
