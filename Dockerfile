FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY migrations ./migrations
COPY public ./public
RUN npx tsc -p tsconfig.json
# Migrations are idempotent (schema_migrations tracks what's applied), so
# running this on every boot is safe -- needed for single-service platforms
# that just run this image directly, unlike docker-compose.yml's cluster
# where a separate `migrate` service runs first.
CMD ["sh", "-c", "node dist/src/migrate.js && node dist/src/server.js"]
