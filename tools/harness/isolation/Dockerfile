FROM node:22.23.4-bookworm-slim
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable && corepack prepare pnpm@8.15.2 --activate && chmod -R a+rX /opt/corepack
