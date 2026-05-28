FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
RUN npm run --silent bundle:scale

FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/scale.cjs /app/coordinator.cjs

CMD ["node", "/app/coordinator.cjs"]
