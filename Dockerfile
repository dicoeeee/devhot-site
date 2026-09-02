FROM node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b

WORKDIR /workspace

COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY . .
RUN npx playwright install --with-deps chromium firefox webkit
RUN npm run gate
