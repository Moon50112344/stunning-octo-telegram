import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NbdIsoServer } from './nbdIsoServer';

const execFileAsync = promisify(execFile);

test('NbdIsoServer serves HTTP Range requests with LRU cache and fallback mirror to QEMU tools', async () => {
  const payload = Buffer.alloc(3 * 1024 * 1024, 0xaa);
  payload.write('CD001_WINDOWS_7_SP1_TEST', 32768, 'ascii');
  payload.write('END_SECTOR_SIGNATURE', payload.length - 64, 'ascii');

  let primaryCalls = 0;
  let fallbackCalls = 0;

  const server = http.createServer((req, res) => {
    const urlPath = req.url || '/';
    if (urlPath === '/fail-after-probe') {
      primaryCalls++;
      // Allow initial 0-1023 probe, then fail block reads to verify automatic failover to fallback mirror
      if (req.headers.range === 'bytes=0-1023') {
        res.writeHead(206, {
          'Content-Range': `bytes 0-1023/${payload.length}`,
          'Content-Length': '1024',
          'Accept-Ranges': 'bytes',
        });
        res.end(payload.subarray(0, 1024));
        return;
      }
      res.writeHead(503);
      res.end('Upstream error');
      return;
    }

    fallbackCalls++;
    const rangeHdr = req.headers.range || '';
    const m = rangeHdr.match(/^bytes=(\d+)-(\d+)$/);
    if (!m) {
      res.writeHead(200, { 'Content-Length': String(payload.length), 'Accept-Ranges': 'bytes' });
      res.end(payload);
      return;
    }
    const start = Number(m[1]);
    const end = Math.min(payload.length - 1, Number(m[2]));
    const slice = payload.subarray(start, end + 1);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${payload.length}`,
      'Content-Length': String(slice.length),
      'Accept-Ranges': 'bytes',
    });
    res.end(slice);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const nbd = new NbdIsoServer(
    {
      type: 'http',
      url: `${baseUrl}/fail-after-probe`,
      fallbackUrls: [`${baseUrl}/healthy`],
      totalSizeBytes: payload.length,
      exportName: 'iso',
    },
    { blockSizeBytes: 512 * 1024, maxCacheMb: 2 }
  );

  try {
    const port = await nbd.start();
    assert.ok(port > 0);
    const uri = nbd.getNbdUri();
    assert.equal(uri, `nbd://127.0.0.1:${port}/iso`);

    const sig = await nbd.readRange(32768, 24);
    assert.equal(sig.toString('ascii'), 'CD001_WINDOWS_7_SP1_TEST');
    assert.ok(primaryCalls >= 1);
    assert.ok(fallbackCalls >= 1);

    // Cached second read should hit LRU cache rather than repeating HTTP calls
    const beforeCached = fallbackCalls;
    const cachedSig = await nbd.readRange(32768, 24);
    assert.equal(cachedSig.toString('ascii'), 'CD001_WINDOWS_7_SP1_TEST');
    assert.equal(fallbackCalls, beforeCached);

    const endSig = await nbd.readRange(payload.length - 64, 20);
    assert.equal(endSig.toString('ascii'), 'END_SECTOR_SIGNATURE');

    if (fs.existsSync('/usr/bin/qemu-img')) {
      const { stdout } = await execFileAsync('/usr/bin/qemu-img', ['info', uri], { timeout: 5000 });
      assert.ok(stdout.includes('file format: raw'));
      assert.ok(stdout.includes(`(${payload.length} bytes)`));
    }

    if (fs.existsSync('/usr/bin/qemu-io')) {
      const { stdout } = await execFileAsync(
        '/usr/bin/qemu-io',
        ['-r', '-c', 'read -v 32768 16', uri],
        { timeout: 5000 }
      );
      assert.ok(
        stdout.includes('43 44 30 30 31 5f 57 49 4e 44 4f 57 53 5f 37 5f') ||
          stdout.includes('CD001_WINDOWS_7_') ||
          stdout.includes('CD001.WINDOWS.7.')
      );
    }

    const stats = nbd.getStats();
    assert.ok(stats.bytesServed >= 68);
    assert.ok(stats.cacheBlocks >= 1);
  } finally {
    await nbd.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('NbdIsoServer enforces bounded LRU eviction while pinning initial header blocks', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbd-lru-'));
  const filePath = path.join(tmpDir, 'test.iso');
  fs.writeFileSync(filePath, Buffer.alloc(16 * 64 * 1024, 0x11));

  const nbd = new NbdIsoServer(
    {
      type: 'file',
      filePath,
      totalSizeBytes: 16 * 64 * 1024,
      exportName: 'iso',
    },
    { blockSizeBytes: 64 * 1024, maxCacheMb: 0.5 } // 8 max blocks
  );

  try {
    await nbd.start();
    for (let i = 0; i < 14; i++) {
      await nbd.readRange(i * 64 * 1024, 512);
    }
    const stats = nbd.getStats();
    assert.ok(stats.cacheBlocks <= 8, `Expected bounded cache <= 8 blocks, got ${stats.cacheBlocks}`);
  } finally {
    await nbd.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
