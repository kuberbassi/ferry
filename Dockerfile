# Stage 1: Build Frontend
FROM node:24-slim AS web-builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 2: Build Rust Signalling Server
FROM rust:1-slim AS server-builder
WORKDIR /app/server
COPY server/Cargo.toml server/Cargo.lock* ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src
COPY server/src ./src
RUN touch src/main.rs && cargo build --release

# Stage 3: Minimal Runtime
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server-builder /app/server/target/release/ferry-signalling /usr/local/bin/ferry-signalling
COPY --from=web-builder /app/web/dist /app/static

ENV STATIC_DIR=/app/static
EXPOSE 8787

CMD ["ferry-signalling"]
