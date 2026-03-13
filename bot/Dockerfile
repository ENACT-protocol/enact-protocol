FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src/ ./src/
COPY tsconfig.json ./
RUN npx tsc
RUN npm prune --omit=dev
CMD ["node", "dist/index.js"]
