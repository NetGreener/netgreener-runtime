# Azure Container Apps / local Docker gate image for Node Runtime (Express dry-run).
# Does not change default EXPORT_MODE. Build from netgreener_node/:
#   docker build -f examples/aca-container-gate/Dockerfile -t ng-aca-gate .

FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev=false
COPY . .
RUN npm run build
ENV NETGREENER_SERVICE_RUNTIME=1
ENV NETGREENER_RUNTIME_DRY_RUN=1
ENV NETGREENER_TOKEN=ngs_local_dry_run
ENV NETGREENER_PROJECT_ID=1
# ACA-shaped signals (persistent lifecycle — not serverless)
ENV CONTAINER_APP_NAME=netgreener-aca-gate
ENV CONTAINER_APP_REVISION=local-gate
ENV container=docker
EXPOSE 8080
CMD ["node", "examples/aca-container-gate/server.mjs"]
