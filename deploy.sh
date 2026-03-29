#!/bin/bash
docker stop scrapes 2>/dev/null
docker rm scrapes 2>/dev/null

docker run -d \
  --name scrapes \
  --network coolify \
  --restart unless-stopped \
  -e N8N_WEBHOOK=https://n8n.felaniam.cloud/webhook/scrapes \
  -e PORT=3100 \
  -l 'traefik.enable=true' \
  -l 'traefik.http.services.scrapes.loadbalancer.server.port=3100' \
  -l 'traefik.http.routers.scrapes-http.rule=Host(`scrapes.felaniam.cloud`) && PathPrefix(`/`)' \
  -l 'traefik.http.routers.scrapes-http.entryPoints=http' \
  -l 'traefik.http.routers.scrapes-http.service=scrapes' \
  -l 'traefik.http.routers.scrapes-http.middlewares=redirect-to-https' \
  -l 'traefik.http.middlewares.redirect-to-https.redirectscheme.scheme=https' \
  -l 'traefik.http.routers.scrapes-https.rule=Host(`scrapes.felaniam.cloud`) && PathPrefix(`/`)' \
  -l 'traefik.http.routers.scrapes-https.entryPoints=https' \
  -l 'traefik.http.routers.scrapes-https.service=scrapes' \
  -l 'traefik.http.routers.scrapes-https.tls=true' \
  -l 'traefik.http.routers.scrapes-https.tls.certresolver=letsencrypt' \
  -l 'traefik.http.routers.scrapes-https.middlewares=gzip' \
  -l 'traefik.http.middlewares.gzip.compress=true' \
  scrapes
