FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY migrations ./migrations
RUN npx tsc -p tsconfig.json
CMD ["node", "dist/src/server.js"]
