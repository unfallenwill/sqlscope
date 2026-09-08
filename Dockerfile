# Build stage
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# Runtime stage
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Databases are declared via standard DSN URIs, e.g.:
#   docker run -i --rm -e SQLSCOPE_DSN='sqlite:////data/app.db' -v "$PWD/data:/data" sqlscope
#   docker run -i --rm -e SQLSCOPE_DSN='mysql://user:pass@host:3306/db' sqlscope
#   docker run -i --rm -e SQLSCOPE_CONNECTIONS='{"oltp":"mysql://u:p@h/db","cache":"sqlite:///a.db"}' sqlscope
# HTTP transport (streamable HTTP):
#   docker run --rm -p 3000:3000 -e SQLSCOPE_DSN='sqlite:////data/app.db' -v "$PWD/data:/data" \
#     sqlscope node dist/index.js --transport http --host 0.0.0.0 --port 3000 --token s3cret
EXPOSE 3000
# Default is the MCP stdio transport: keep stdin open with `docker run -i`
CMD ["node", "--no-warnings", "dist/index.js"]
