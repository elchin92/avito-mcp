import { promises as fs } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

/**
 * Protects `messenger_upload_images` from reading arbitrary files off disk.
 * Every check is fail-closed: if anything goes wrong, we throw —
 * the caller wraps it into an MCP isError.
 *
 * Layers:
 *   1. resolve the absolute path
 *   2. realpath → protection against symlink escape
 *   3. realpath for each allowed dir as well
 *   4. strict `dir + sep` startsWith — protection against /safe-dir-malicious
 *   5. fs.stat: regular file only (not dir, not device, not socket)
 *   6. size ≤ maxBytes
 *   7. extension in the allowlist
 *   8. magic-byte sniffing (JPEG / PNG / WEBP)
 *
 * All pre-checks run before the file is opened for reading — we read only if they all pass.
 */

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export interface UploadGuardConfig {
  allowedDirs: string[];
  maxBytes: number;
}

export interface ValidatedUpload {
  realPath: string;
  filename: string;
  size: number;
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  data: Buffer;
}

export class UploadGuardError extends Error {
  constructor(
    message: string,
    public readonly path: string,
    public readonly reason:
      | 'no_allowed_dirs'
      | 'outside_allowed_dirs'
      | 'symlink_escape'
      | 'not_regular_file'
      | 'too_large'
      | 'bad_extension'
      | 'extension_mime_mismatch'
      | 'unsupported_format'
      | 'stat_failed',
  ) {
    super(`Upload rejected (${reason}): ${message} [${path}]`);
    this.name = 'UploadGuardError';
  }
}

export async function validateUpload(
  inputPath: string,
  cfg: UploadGuardConfig,
): Promise<ValidatedUpload> {
  if (cfg.allowedDirs.length === 0) {
    throw new UploadGuardError(
      'AVITO_MCP_ALLOWED_UPLOAD_DIRS is empty',
      inputPath,
      'no_allowed_dirs',
    );
  }

  // 1. resolve
  const resolved = resolve(inputPath);

  // 2. extension check (cheap — do before fs calls)
  const ext = extname(resolved).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new UploadGuardError(
      `extension '${ext}' not in allowlist (.jpg, .jpeg, .png, .webp)`,
      resolved,
      'bad_extension',
    );
  }

  // 3-4. realpath both sides, strict startsWith with separator
  let realFile: string;
  try {
    realFile = await fs.realpath(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN';
    throw new UploadGuardError(
      `cannot resolve real path: ${code}`,
      inputPath,
      code === 'ENOENT' ? 'stat_failed' : 'symlink_escape',
    );
  }
  const realAllowedDirs = await Promise.all(
    cfg.allowedDirs.map(async (d) => {
      try {
        return await fs.realpath(d);
      } catch {
        return null;
      }
    }),
  );
  const inside = realAllowedDirs.some((dir) => {
    if (!dir) return false;
    return realFile === dir || realFile.startsWith(dir + sep);
  });
  if (!inside) {
    throw new UploadGuardError(
      `path not inside any AVITO_MCP_ALLOWED_UPLOAD_DIRS entry`,
      realFile,
      'outside_allowed_dirs',
    );
  }

  // 5. stat — regular file only
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(realFile);
  } catch (err) {
    throw new UploadGuardError(
      `stat failed: ${(err as NodeJS.ErrnoException).code ?? 'EUNKNOWN'}`,
      realFile,
      'stat_failed',
    );
  }
  if (!stat.isFile()) {
    throw new UploadGuardError(
      'not a regular file (directory, device, socket, or fifo)',
      realFile,
      'not_regular_file',
    );
  }

  // 6. size
  if (stat.size > cfg.maxBytes) {
    throw new UploadGuardError(
      `${stat.size} bytes > AVITO_MCP_MAX_UPLOAD_MB limit (${cfg.maxBytes} bytes)`,
      realFile,
      'too_large',
    );
  }

  // 7. read
  const data = await fs.readFile(realFile);

  // 8. magic-byte sniffing
  const mime = sniffMime(data);
  if (!mime) {
    throw new UploadGuardError(
      'file content is not a valid JPEG / PNG / WEBP image',
      realFile,
      'unsupported_format',
    );
  }
  // extension-mime cross-check
  const extMimeMatch =
    (mime === 'image/jpeg' && (ext === '.jpg' || ext === '.jpeg')) ||
    (mime === 'image/png' && ext === '.png') ||
    (mime === 'image/webp' && ext === '.webp');
  if (!extMimeMatch) {
    throw new UploadGuardError(
      `extension '${ext}' does not match actual content (${mime})`,
      realFile,
      'extension_mime_mismatch',
    );
  }

  const filename = realFile.split(sep).pop() ?? 'upload.bin';
  return { realPath: realFile, filename, size: stat.size, mime, data };
}

function sniffMime(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  )
    return 'image/png';
  // WEBP: 'RIFF' .... 'WEBP'
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  )
    return 'image/webp';
  return null;
}
