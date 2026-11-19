import net from 'node:net';
import fs from 'node:fs';
import { serverLogger } from './logger';

const NBDMAGIC = Buffer.from('NBDMAGIC', 'ascii');
const IHAVEOPT = Buffer.from('IHAVEOPT', 'ascii');
const NBD_REPLY_MAGIC = 0x0003e889045565a9n;
const NBD_REQUEST_MAGIC = 0x25609513;
const NBD_SIMPLE_REPLY_MAGIC = 0x67446698;

const NBD_FLAG_FIXED_NEWSTYLE = 1 << 0;
const NBD_FLAG_NO_ZEROES = 1 << 1;

const NBD_FLAG_HAS_FLAGS = 1 << 0;
const NBD_FLAG_READ_ONLY = 1 << 1;

const NBD_OPT_EXPORT_NAME = 1;
const NBD_OPT_ABORT = 2;
const NBD_OPT_LIST = 3;
const NBD_OPT_INFO = 6;
const NBD_OPT_GO = 7;

const NBD_REP_ACK = 1;
const NBD_REP_SERVER = 2;
const NBD_REP_INFO = 3;
const NBD_REP_ERR_UNSUP = 0x80000001;

const NBD_INFO_EXPORT = 0;
const NBD_INFO_BLOCK_SIZE = 3;

const NBD_CMD_READ = 0;
const NBD_CMD_DISC = 2;
const NBD_CMD_FLUSH = 3;

export interface NbdSource {
  type: 'http' | 'file';
  url?: string;
  fallbackUrls?: string[];
  filePath?: string;
  totalSizeBytes: number;
  exportName: string;
}

/**
 * Pure-Node read-only NBD (Network Block Device) server backed by HTTP Range requests
 * with a bounded in-memory LRU block cache + sequential read-ahead.
 * Allows QEMU on RAM-backed gVisor overlayfs (12 GiB) to mount a 3-5 GiB Windows ISO
 * via ~64 MiB of LRU cache instead of pinning the full ISO in container RAM.
 */
export class NbdIsoServer {
  private source: NbdSource;
  private server: net.Server | null = null;
  private port = 0;
  private blockSize: number;
  private maxCachedBlocks: number;
  private cache: Map<number, Buffer> = new Map();
  private inFlight: Map<number, Promise<Buffer>> = new Map();
  private resolvedUrls: string[] = [];
  private localFd: number | null = null;
  private activeSockets: Set<net.Socket> = new Set();
  private bytesServed = 0;

  constructor(source: NbdSource, opts?: { blockSizeBytes?: number; maxCacheMb?: number }) {
    this.source = source;
    this.blockSize = opts?.blockSizeBytes || 1024 * 1024; // 1 MiB chunks balance seek speed & prefetch throughput
    const maxMb = opts?.maxCacheMb || 64;
    this.maxCachedBlocks = Math.max(8, Math.floor((maxMb * 1024 * 1024) / this.blockSize));
  }

  public getPort(): number {
    return this.port;
  }

  public getNbdUri(): string {
    if (!this.port) throw new Error('NBD server is not listening');
    return `nbd://127.0.0.1:${this.port}/${this.source.exportName}`;
  }

  public getStats(): { port: number; bytesServed: number; cacheBlocks: number; blockSize: number } {
    return {
      port: this.port,
      bytesServed: this.bytesServed,
      cacheBlocks: this.cache.size,
      blockSize: this.blockSize,
    };
  }

  public async start(): Promise<number> {
    if (this.server && this.port > 0) return this.port;

    if (this.source.type === 'file' && this.source.filePath) {
      this.localFd = fs.openSync(this.source.filePath, 'r');
    } else if (this.source.type === 'http' && this.source.url) {
      const candidates = [this.source.url, ...(this.source.fallbackUrls || [])].filter(Boolean);
      const resolved: string[] = [];
      let lastProbeErr: unknown;
      for (const candidate of candidates) {
        try {
          const finalUrl = await this.probeAndResolveHttpRange(candidate);
          resolved.push(finalUrl);
        } catch (err) {
          lastProbeErr = err;
        }
      }
      if (resolved.length === 0) {
        throw lastProbeErr instanceof Error ? lastProbeErr : new Error('No HTTP Range ISO mirror reachable');
      }
      this.resolvedUrls = resolved;
    }

    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.handleClient(socket);
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
          this.server = server;
          resolve();
        } else {
          reject(new Error('Failed to bind NBD ephemeral port'));
        }
      });
    });

    serverLogger.info(
      'NbdIso',
      `Read-only NBD ISO stream server online on 127.0.0.1:${this.port}/${this.source.exportName} (${(this.source.totalSizeBytes / (1024 * 1024)).toFixed(1)} MiB, cache=${Math.round(this.maxCachedBlocks * (this.blockSize / (1024 * 1024)))} MiB)`
    );
    return this.port;
  }

  public async stop(): Promise<void> {
    for (const sock of this.activeSockets) {
      try {
        sock.destroy();
      } catch {
        // ignore
      }
    }
    this.activeSockets.clear();
    if (this.server) {
      const srv = this.server;
      this.server = null;
      this.port = 0;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    if (this.localFd !== null) {
      try {
        fs.closeSync(this.localFd);
      } catch {
        // ignore
      }
      this.localFd = null;
    }
    this.cache.clear();
    this.inFlight.clear();
  }

  private async probeAndResolveHttpRange(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          Range: 'bytes=0-1023',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) dockurr-windows/1.0',
        },
        signal: controller.signal,
      });
      if (res.status !== 206 && res.status !== 200) {
        throw new Error(`HTTP Range probe returned status ${res.status} for ${url}`);
      }
      const rangeHdr = res.headers.get('content-range');
      if (rangeHdr) {
        const m = rangeHdr.match(/\/(\d+)$/);
        if (m && Number(m[1]) > 0) {
          this.source.totalSizeBytes = Number(m[1]);
        }
      } else {
        const len = Number(res.headers.get('content-length') || '0');
        if (res.status === 200 && len > 0) {
          this.source.totalSizeBytes = len;
        }
      }
      await res.arrayBuffer();
      return res.url || url;
    } finally {
      clearTimeout(timer);
    }
  }

  private putCache(blockIdx: number, data: Buffer): void {
    if (this.cache.has(blockIdx)) {
      this.cache.delete(blockIdx);
    } else if (this.cache.size >= this.maxCachedBlocks) {
      // Keep block 0..7 (UDF descriptors & boot tables) pinned when possible; evict oldest non-header block
      for (const k of this.cache.keys()) {
        if (k >= 8) {
          this.cache.delete(k);
          break;
        }
      }
      if (this.cache.size >= this.maxCachedBlocks) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey !== undefined) this.cache.delete(oldestKey);
      }
    }
    this.cache.set(blockIdx, data);
  }

  private async fetchBlock(blockIdx: number, triggerPrefetch = true): Promise<Buffer> {
    const cached = this.cache.get(blockIdx);
    if (cached) {
      this.cache.delete(blockIdx);
      this.cache.set(blockIdx, cached);
      return cached;
    }

    const existingFlight = this.inFlight.get(blockIdx);
    if (existingFlight) {
      return existingFlight;
    }

    const start = blockIdx * this.blockSize;
    if (start >= this.source.totalSizeBytes) {
      return Buffer.alloc(0);
    }
    const endExclusive = Math.min(this.source.totalSizeBytes, start + this.blockSize);
    const len = endExclusive - start;

    const promise = (async () => {
      if (this.source.type === 'file' && this.localFd !== null) {
        const buf = Buffer.allocUnsafe(len);
        const bytesRead = fs.readSync(this.localFd, buf, 0, len, start);
        const sliced = bytesRead === len ? buf : buf.subarray(0, bytesRead);
        this.putCache(blockIdx, sliced);
        return sliced;
      }

      const urlsToTry =
        this.resolvedUrls.length > 0
          ? this.resolvedUrls
          : [this.source.url!, ...(this.source.fallbackUrls || [])].filter(Boolean);
      let lastErr: unknown;

      for (const targetUrl of urlsToTry) {
        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 25000);
          try {
            const res = await fetch(targetUrl, {
              method: 'GET',
              redirect: 'follow',
              headers: {
                Range: `bytes=${start}-${endExclusive - 1}`,
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) dockurr-windows/1.0',
              },
              signal: controller.signal,
            });
            if (res.status !== 206 && res.status !== 200) {
              throw new Error(`HTTP Range read ${start}-${endExclusive - 1} failed: HTTP ${res.status}`);
            }
            const ab = await res.arrayBuffer();
            const buf = Buffer.from(ab);
            if (buf.length < len && start + buf.length < this.source.totalSizeBytes) {
              throw new Error(`Short HTTP Range response: got ${buf.length}, expected ${len}`);
            }
            this.putCache(blockIdx, buf);
            return buf;
          } catch (err) {
            lastErr = err;
            if (attempt < maxRetries) {
              await new Promise((r) => setTimeout(r, attempt * 350));
            }
          } finally {
            clearTimeout(timer);
          }
        }
      }
      throw lastErr;
    })();

    this.inFlight.set(blockIdx, promise);
    try {
      const result = await promise;
      if (triggerPrefetch && this.source.type === 'http') {
        for (let ahead = 1; ahead <= 3; ahead++) {
          const nextIdx = blockIdx + ahead;
          if (nextIdx * this.blockSize < this.source.totalSizeBytes && !this.cache.has(nextIdx) && !this.inFlight.has(nextIdx)) {
            this.fetchBlock(nextIdx, false).catch(() => undefined);
          }
        }
      }
      return result;
    } finally {
      this.inFlight.delete(blockIdx);
    }
  }

  public async readRange(offset: number, length: number): Promise<Buffer> {
    if (length === 0) return Buffer.alloc(0);
    if (offset >= this.source.totalSizeBytes) return Buffer.alloc(length, 0);
    const out = Buffer.alloc(length, 0);
    let written = 0;
    let cur = offset;

    while (written < length && cur < this.source.totalSizeBytes) {
      const blockIdx = Math.floor(cur / this.blockSize);
      const blockStart = blockIdx * this.blockSize;
      const inBlockOffset = cur - blockStart;
      const block = await this.fetchBlock(blockIdx, true);
      if (inBlockOffset >= block.length) {
        break;
      }
      const copyLen = Math.min(length - written, block.length - inBlockOffset);
      block.copy(out, written, inBlockOffset, inBlockOffset + copyLen);
      written += copyLen;
      cur += copyLen;
    }
    this.bytesServed += written;
    return out;
  }

  private safeWrite(socket: net.Socket, buf: Buffer): void {
    if (!socket.destroyed && socket.writable) {
      socket.write(buf);
    }
  }

  private sendOptionReply(socket: net.Socket, opt: number, replyType: number, payload?: Buffer): void {
    const dataLen = payload ? payload.length : 0;
    const hdr = Buffer.allocUnsafe(20 + dataLen);
    hdr.writeBigUInt64BE(NBD_REPLY_MAGIC, 0);
    hdr.writeUInt32BE(opt, 8);
    hdr.writeUInt32BE(replyType, 12);
    hdr.writeUInt32BE(dataLen, 16);
    if (payload && dataLen > 0) {
      payload.copy(hdr, 20);
    }
    this.safeWrite(socket, hdr);
  }

  private handleClient(socket: net.Socket): void {
    this.activeSockets.add(socket);
    socket.setNoDelay(true);

    // Send initial NBD Fixed Newstyle greeting
    const greeting = Buffer.allocUnsafe(18);
    NBDMAGIC.copy(greeting, 0);
    IHAVEOPT.copy(greeting, 8);
    greeting.writeUInt16BE(NBD_FLAG_FIXED_NEWSTYLE | NBD_FLAG_NO_ZEROES, 16);
    this.safeWrite(socket, greeting);

    let phase: 'client_flags' | 'options' | 'transmission' = 'client_flags';
    let clientFlags = 0;
    let rxBuf = Buffer.alloc(0);
    let processing = false;
    let queue = Promise.resolve();

    const enqueue = (fn: () => Promise<void>) => {
      queue = queue.then(fn).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('ECONNRESET') && !msg.includes('EPIPE')) {
          serverLogger.warn('NbdIso', `Client stream error: ${msg}`);
        }
        if (!socket.destroyed) socket.destroy();
      });
    };

    const processBuffer = () => {
      if (processing) return;
      processing = true;
      enqueue(async () => {
        try {
          while (!socket.destroyed) {
            if (phase === 'client_flags') {
              if (rxBuf.length < 4) break;
              clientFlags = rxBuf.readUInt32BE(0);
              rxBuf = rxBuf.subarray(4);
              phase = 'options';
              continue;
            }

            if (phase === 'options') {
              if (rxBuf.length < 16) break;
              const magic = rxBuf.subarray(0, 8);
              if (!magic.equals(IHAVEOPT)) {
                socket.destroy();
                return;
              }
              const opt = rxBuf.readUInt32BE(8);
              const optLen = rxBuf.readUInt32BE(12);
              if (rxBuf.length < 16 + optLen) break;
              const optData = rxBuf.subarray(16, 16 + optLen);
              rxBuf = rxBuf.subarray(16 + optLen);

              if (opt === NBD_OPT_LIST) {
                const nameBuf = Buffer.from(this.source.exportName, 'utf8');
                const p = Buffer.allocUnsafe(4 + nameBuf.length);
                p.writeUInt32BE(nameBuf.length, 0);
                nameBuf.copy(p, 4);
                this.sendOptionReply(socket, opt, NBD_REP_SERVER, p);
                this.sendOptionReply(socket, opt, NBD_REP_ACK);
              } else if (opt === NBD_OPT_EXPORT_NAME) {
                const wantZeroes = (clientFlags & NBD_FLAG_NO_ZEROES) === 0;
                const rep = Buffer.alloc(10 + (wantZeroes ? 124 : 0));
                rep.writeBigUInt64BE(BigInt(this.source.totalSizeBytes), 0);
                rep.writeUInt16BE(NBD_FLAG_HAS_FLAGS | NBD_FLAG_READ_ONLY, 8);
                this.safeWrite(socket, rep);
                phase = 'transmission';
              } else if (opt === NBD_OPT_INFO || opt === NBD_OPT_GO) {
                // NBD_INFO_EXPORT
                const expInfo = Buffer.allocUnsafe(12);
                expInfo.writeUInt16BE(NBD_INFO_EXPORT, 0);
                expInfo.writeBigUInt64BE(BigInt(this.source.totalSizeBytes), 2);
                expInfo.writeUInt16BE(NBD_FLAG_HAS_FLAGS | NBD_FLAG_READ_ONLY, 10);
                this.sendOptionReply(socket, opt, NBD_REP_INFO, expInfo);

                // NBD_INFO_BLOCK_SIZE
                const blkInfo = Buffer.allocUnsafe(14);
                blkInfo.writeUInt16BE(NBD_INFO_BLOCK_SIZE, 0);
                blkInfo.writeUInt32BE(512, 2);
                blkInfo.writeUInt32BE(65536, 6);
                blkInfo.writeUInt32BE(1024 * 1024, 10);
                this.sendOptionReply(socket, opt, NBD_REP_INFO, blkInfo);

                this.sendOptionReply(socket, opt, NBD_REP_ACK);
                if (opt === NBD_OPT_GO) {
                  phase = 'transmission';
                }
              } else if (opt === NBD_OPT_ABORT) {
                this.sendOptionReply(socket, opt, NBD_REP_ACK);
                socket.end();
                return;
              } else {
                // Ignore unknown optional capabilities (e.g. structured replies) cleanly
                void optData;
                this.sendOptionReply(socket, opt, NBD_REP_ERR_UNSUP);
              }
              continue;
            }

            if (phase === 'transmission') {
              if (rxBuf.length < 28) break;
              const reqMagic = rxBuf.readUInt32BE(0);
              if (reqMagic !== NBD_REQUEST_MAGIC) {
                socket.destroy();
                return;
              }
              const _flags = rxBuf.readUInt16BE(4);
              const cmdType = rxBuf.readUInt16BE(6);
              const handle = rxBuf.subarray(8, 16);
              const offsetBig = rxBuf.readBigUInt64BE(16);
              const len = rxBuf.readUInt32BE(24);
              rxBuf = rxBuf.subarray(28);

              if (cmdType === NBD_CMD_DISC) {
                socket.end();
                return;
              }

              if (cmdType === NBD_CMD_FLUSH) {
                const reply = Buffer.allocUnsafe(16);
                reply.writeUInt32BE(NBD_SIMPLE_REPLY_MAGIC, 0);
                reply.writeUInt32BE(0, 4);
                handle.copy(reply, 8);
                this.safeWrite(socket, reply);
                continue;
              }

              if (cmdType === NBD_CMD_READ) {
                const offsetNum = Number(offsetBig);
                const payload = await this.readRange(offsetNum, len);
                const hdr = Buffer.allocUnsafe(16);
                hdr.writeUInt32BE(NBD_SIMPLE_REPLY_MAGIC, 0);
                hdr.writeUInt32BE(0, 4);
                handle.copy(hdr, 8);
                this.safeWrite(socket, Buffer.concat([hdr, payload]));
                continue;
              }

              // Read-only export rejects write/trim with EROFS (30)
              const errReply = Buffer.allocUnsafe(16);
              errReply.writeUInt32BE(NBD_SIMPLE_REPLY_MAGIC, 0);
              errReply.writeUInt32BE(30, 4);
              handle.copy(errReply, 8);
              this.safeWrite(socket, errReply);
            }
          }
        } finally {
          processing = false;
          if (rxBuf.length > 0 && !socket.destroyed) {
            setImmediate(processBuffer);
          }
        }
      });
    };

    socket.on('data', (chunk) => {
      rxBuf = rxBuf.length > 0 ? Buffer.concat([rxBuf, chunk]) : chunk;
      processBuffer();
    });

    socket.on('close', () => {
      this.activeSockets.delete(socket);
    });
    socket.on('error', () => {
      this.activeSockets.delete(socket);
    });
  }
}
