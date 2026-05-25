/**
 * Hardening checks for the messenger_upload_images path-allowlist guard.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

import { validateUpload, UploadGuardError } from '../src/core/upload-guard.js';

// Minimal valid file headers
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]);
const WEBP_HEADER = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0,
]);
const TEXT_DATA = Buffer.from('hello world, this is plain text and not an image');

const RUN_ID = randomBytes(6).toString('hex');
let allowedDir: string;
let outsideDir: string;
const cleanupTargets: string[] = [];

async function writeFile(dir: string, name: string, content: Buffer): Promise<string> {
  const p = join(dir, name);
  await fs.writeFile(p, content);
  cleanupTargets.push(p);
  return p;
}

beforeAll(async () => {
  allowedDir = join(tmpdir(), `avito-mcp-upload-test-${RUN_ID}`);
  outsideDir = join(tmpdir(), `avito-mcp-upload-evil-${RUN_ID}`);
  await fs.mkdir(allowedDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
});

afterAll(async () => {
  for (const p of cleanupTargets) await fs.rm(p, { force: true, recursive: true });
  await fs.rm(allowedDir, { recursive: true, force: true });
  await fs.rm(outsideDir, { recursive: true, force: true });
});

const baseCfg = (overrides: Partial<{ dirs: string[]; maxBytes: number }> = {}) => ({
  allowedDirs: overrides.dirs ?? [allowedDir],
  maxBytes: overrides.maxBytes ?? 1024 * 1024,
});

describe('upload-guard.validateUpload', () => {
  it('accepts a valid jpg in an allowed dir', async () => {
    const p = await writeFile(allowedDir, 'pic.jpg', JPEG_HEADER);
    const v = await validateUpload(p, baseCfg());
    expect(v.mime).toBe('image/jpeg');
    expect(v.filename).toBe('pic.jpg');
  });

  it('accepts a valid png with .png extension', async () => {
    const p = await writeFile(allowedDir, 'pic.png', PNG_HEADER);
    const v = await validateUpload(p, baseCfg());
    expect(v.mime).toBe('image/png');
  });

  it('accepts a valid webp', async () => {
    const p = await writeFile(allowedDir, 'pic.webp', WEBP_HEADER);
    const v = await validateUpload(p, baseCfg());
    expect(v.mime).toBe('image/webp');
  });

  it('rejects when allowedDirs is empty', async () => {
    const p = await writeFile(allowedDir, 'pic2.jpg', JPEG_HEADER);
    await expect(validateUpload(p, baseCfg({ dirs: [] }))).rejects.toMatchObject({
      reason: 'no_allowed_dirs',
    });
  });

  it('rejects a file outside the allowlist', async () => {
    const p = await writeFile(outsideDir, 'evil.jpg', JPEG_HEADER);
    await expect(validateUpload(p, baseCfg())).rejects.toMatchObject({
      reason: 'outside_allowed_dirs',
    });
  });

  it('rejects extension not in allowlist', async () => {
    const p = await writeFile(allowedDir, 'secret.env', Buffer.from('SECRET=abc'));
    await expect(validateUpload(p, baseCfg())).rejects.toMatchObject({
      reason: 'bad_extension',
    });
  });

  it('rejects size beyond maxBytes', async () => {
    const big = Buffer.concat([JPEG_HEADER, Buffer.alloc(20)]);
    const p = await writeFile(allowedDir, 'big.jpg', big);
    await expect(validateUpload(p, baseCfg({ maxBytes: 10 }))).rejects.toMatchObject({
      reason: 'too_large',
    });
  });

  it('rejects non-image content even with .jpg extension', async () => {
    const p = await writeFile(allowedDir, 'fake.jpg', TEXT_DATA);
    await expect(validateUpload(p, baseCfg())).rejects.toMatchObject({
      reason: 'unsupported_format',
    });
  });

  it('rejects png content masquerading as jpg', async () => {
    const p = await writeFile(allowedDir, 'wrong-ext.jpg', PNG_HEADER);
    await expect(validateUpload(p, baseCfg())).rejects.toMatchObject({
      reason: 'extension_mime_mismatch',
    });
  });

  it('rejects symlink that escapes the allowed dir', async () => {
    const real = await writeFile(outsideDir, 'real.jpg', JPEG_HEADER);
    const link = join(allowedDir, 'link.jpg');
    await fs.symlink(real, link);
    cleanupTargets.push(link);
    // realpath of the link points outside allowedDir → outside_allowed_dirs
    await expect(validateUpload(link, baseCfg())).rejects.toMatchObject({
      reason: 'outside_allowed_dirs',
    });
  });

  it('rejects a directory pretending to be jpg', async () => {
    const fakeDir = join(allowedDir, 'pic.dir.jpg');
    await fs.mkdir(fakeDir, { recursive: true });
    cleanupTargets.push(fakeDir);
    await expect(validateUpload(fakeDir, baseCfg())).rejects.toMatchObject({
      reason: 'not_regular_file',
    });
  });

  it('rejects path traversal: ../outside/evil.jpg from inside allowed dir', async () => {
    await writeFile(outsideDir, 'evil2.jpg', JPEG_HEADER);
    const traversal = join(allowedDir, '..', `avito-mcp-upload-evil-${RUN_ID}`, 'evil2.jpg');
    await expect(validateUpload(traversal, baseCfg())).rejects.toMatchObject({
      reason: 'outside_allowed_dirs',
    });
  });

  it('does not match "/safe-malicious" by naive prefix on "/safe"', async () => {
    // realpath + path-separator boundary check should prevent /safe matching /safe-malicious
    const sister = `${allowedDir}-malicious`;
    await fs.mkdir(sister, { recursive: true });
    const p = await writeFile(sister, 'evil.jpg', JPEG_HEADER);
    try {
      await expect(validateUpload(p, baseCfg())).rejects.toMatchObject({
        reason: 'outside_allowed_dirs',
      });
    } finally {
      await fs.rm(sister, { recursive: true, force: true });
    }
  });
});

describe('UploadGuardError shape', () => {
  it('exposes path and reason for programmatic handling', async () => {
    const p = await writeFile(outsideDir, 'evil3.jpg', JPEG_HEADER);
    try {
      await validateUpload(p, baseCfg());
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UploadGuardError);
      const g = err as UploadGuardError;
      expect(g.reason).toBe('outside_allowed_dirs');
      expect(g.path.length).toBeGreaterThan(0);
      expect(g.message).toContain('Upload rejected');
    }
  });
});

// Use sep to keep the symbol referenced and avoid 'unused' warnings on Windows-only paths.
void sep;
