
# ==============================================================================
# Stage 2: runtime (Moon Studio Cloud Windows — Bun / TCG / KVM=N)
# ==============================================================================
FROM oven/bun:1-debian AS runtime

ARG DEBIAN_FRONTEND=noninteractive

ENV NODE_ENV=production \
    PORT=3000 \
    KVM=N \
    ACCEL=tcg

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    genisoimage \
    ovmf \
    p7zip-full \
    procps \
    qemu-system-x86 \
    qemu-utils \
    swtpm \
    swtpm-tools \
    xrdp \
    xfce4 \
    xfce4-terminal \
    dbus-x11 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies using Bun
COPY package.json bun.lock ./

RUN bun install --frozen-lockfile --production=false

# Copy project source
COPY . .

# Preserve ISO downloader
COPY --from=iso-downloader /usr/local/bin/download-windows-iso.sh /usr/local/bin/download-windows-iso.sh
COPY --from=iso-downloader /app/data/iso /app/data/iso

# Build frontend and prepare persistent data directories
RUN bun run build \
    && mkdir -p /app/data/disks \
                  /app/data/tpm \
                  /app/data/provisioning \
                  /app/data/iso

EXPOSE 3000 3389

# Run TypeScript server natively with Bun
CMD ["bun", "run", "server.ts"]
