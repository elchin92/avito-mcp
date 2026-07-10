import { constants, promises as fs, type Stats } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

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
 *   5. descriptor-anchored, no-follow traversal + inode identity check
 *   6. fs.stat: regular file only (not dir, not device, not socket)
 *   7. bounded descriptor read (size ≤ maxBytes)
 *   8. extension/magic-byte agreement (JPEG / PNG / WEBP)
 *
 * All pre-checks run before the file is opened for reading — we read only if they all pass.
 */

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
type FileHandle = import('node:fs/promises').FileHandle;

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
      | 'stat_failed'
      | 'duplicate_file'
      | 'batch_too_large',
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
  // Prefer the narrowest matching root when configured directories overlap.
  const allowedRoot = realAllowedDirs
    .filter((dir): dir is string => dir !== null && isPathInside(realFile, dir))
    .sort((a, b) => b.length - a.length)[0];
  if (!allowedRoot) {
    throw new UploadGuardError(
      `path not inside any AVITO_MCP_ALLOWED_UPLOAD_DIRS entry`,
      realFile,
      'outside_allowed_dirs',
    );
  }

  // Capture the canonical file/root identities before opening. The Linux path
  // below traverses from an opened filesystem root and compares these identities,
  // so replacing any parent after realpath cannot redirect the read elsewhere.
  let expectedFileStat: Stats;
  let expectedRootStat: Stats;
  try {
    [expectedFileStat, expectedRootStat] = await Promise.all([
      fs.stat(realFile),
      fs.stat(allowedRoot),
    ]);
  } catch (err) {
    throw new UploadGuardError(
      `stat failed: ${(err as NodeJS.ErrnoException).code ?? 'EUNKNOWN'}`,
      realFile,
      'stat_failed',
    );
  }

  // 5-7. Open once, then inspect and read through the same descriptor.
  let handle: FileHandle;
  try {
    handle = await openValidatedFile(realFile, allowedRoot, expectedFileStat, expectedRootStat);
  } catch (err) {
    if (err instanceof UploadGuardError) throw err;
    const code = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN';
    throw new UploadGuardError(
      `secure open failed: ${code}`,
      realFile,
      code === 'ELOOP' || code === 'ENOTDIR' ? 'symlink_escape' : 'stat_failed',
    );
  }
  let stat: Stats;
  let data: Buffer;
  try {
    stat = await handle.stat();
    if (!stat.isFile()) {
      throw new UploadGuardError(
        'not a regular file (directory, device, socket, or fifo)',
        realFile,
        'not_regular_file',
      );
    }
    if (stat.size > cfg.maxBytes) {
      throw new UploadGuardError(
        `${stat.size} bytes > AVITO_MCP_MAX_UPLOAD_MB limit (${cfg.maxBytes} bytes)`,
        realFile,
        'too_large',
      );
    }
    data = await readHandleWithLimit(handle, cfg.maxBytes, realFile);
  } finally {
    await handle.close().catch(() => undefined);
  }

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
  return { realPath: realFile, filename, size: data.byteLength, mime, data };
}

function isPathInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function sameIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Linux exposes descriptor-relative paths through procfs. Opening every path
 * component through the previous directory descriptor provides openat-like
 * semantics without a native addon: intermediate symlinks are never followed,
 * and renaming/replacing a parent cannot redirect an already opened descriptor.
 */
async function openValidatedFile(
  realFile: string,
  allowedRoot: string,
  expectedFileStat: Stats,
  expectedRootStat: Stats,
): Promise<FileHandle> {
  if (process.platform === 'linux') {
    return openLinuxAnchored(realFile, allowedRoot, expectedFileStat, expectedRootStat);
  }
  return openPortableVerified(realFile, allowedRoot, expectedFileStat, expectedRootStat);
}

async function openLinuxAnchored(
  realFile: string,
  allowedRoot: string,
  expectedFileStat: Stats,
  expectedRootStat: Stats,
): Promise<FileHandle> {
  if (
    typeof constants.O_DIRECTORY !== 'number' ||
    typeof constants.O_NOFOLLOW !== 'number'
  ) {
    throw new UploadGuardError(
      'platform does not expose O_DIRECTORY/O_NOFOLLOW for secure traversal',
      realFile,
      'symlink_escape',
    );
  }

  const relativeFile = relative(allowedRoot, realFile);
  if (!relativeFile || isAbsolute(relativeFile) || relativeFile.split(sep).includes('..')) {
    throw new UploadGuardError('invalid descriptor-relative upload path', realFile, 'symlink_escape');
  }
  const components = relativeFile.split(sep).filter(Boolean);
  const filename = components.pop();
  if (!filename) {
    throw new UploadGuardError('upload path has no filename', realFile, 'not_regular_file');
  }

  let directory = await openLinuxDirectory(allowedRoot);
  try {
    const rootStat = await directory.stat();
    if (!sameIdentity(rootStat, expectedRootStat)) {
      throw new UploadGuardError(
        'allowed directory changed during validation',
        realFile,
        'symlink_escape',
      );
    }

    for (const component of components) {
      const next = await fs.open(
        procChild(directory, component),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const previous = directory;
      directory = next;
      await previous.close().catch(() => undefined);
    }

    const file = await fs.open(
      procChild(directory, filename),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const openedStat = await file.stat();
      if (!sameIdentity(openedStat, expectedFileStat)) {
        throw new UploadGuardError(
          'file changed during validation',
          realFile,
          'symlink_escape',
        );
      }
      return file;
    } catch (err) {
      await file.close().catch(() => undefined);
      throw err;
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
}

async function openLinuxDirectory(absolutePath: string): Promise<FileHandle> {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let directory = await fs.open('/', flags);
  try {
    for (const component of absolutePath.split(sep).filter(Boolean)) {
      const next = await fs.open(procChild(directory, component), flags);
      const previous = directory;
      directory = next;
      await previous.close().catch(() => undefined);
    }
    return directory;
  } catch (err) {
    await directory.close().catch(() => undefined);
    throw err;
  }
}

function procChild(directory: FileHandle, component: string): string {
  if (!component || component === '.' || component === '..' || component.includes(sep)) {
    throw new Error('invalid descriptor path component');
  }
  return `/proc/self/fd/${directory.fd}/${component}`;
}

/**
 * Other platforms do not expose openat through Node. Require O_NOFOLLOW, then
 * re-resolve both path and root and compare the opened inode before any read.
 * If these primitives cannot prove identity, reject rather than weakening the
 * configured local-file boundary.
 */
async function openPortableVerified(
  realFile: string,
  allowedRoot: string,
  expectedFileStat: Stats,
  expectedRootStat: Stats,
): Promise<FileHandle> {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new UploadGuardError(
      'platform cannot verify a no-follow file descriptor',
      realFile,
      'symlink_escape',
    );
  }
  const file = await fs.open(realFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const [openedStat, postFile, postRoot] = await Promise.all([
      file.stat(),
      fs.realpath(realFile),
      fs.realpath(allowedRoot),
    ]);
    const [postFileStat, postRootStat] = await Promise.all([
      fs.stat(postFile),
      fs.stat(postRoot),
    ]);
    if (
      postFile !== realFile ||
      postRoot !== allowedRoot ||
      !isPathInside(postFile, postRoot) ||
      !sameIdentity(openedStat, expectedFileStat) ||
      !sameIdentity(postFileStat, openedStat) ||
      !sameIdentity(postRootStat, expectedRootStat)
    ) {
      throw new UploadGuardError(
        'file or parent directory changed during validation',
        realFile,
        'symlink_escape',
      );
    }
    return file;
  } catch (err) {
    await file.close().catch(() => undefined);
    throw err;
  }
}

async function readHandleWithLimit(
  handle: import('node:fs/promises').FileHandle,
  maxBytes: number,
  path: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const chunkSize = 64 * 1024;
  while (true) {
    const chunk = Buffer.allocUnsafe(Math.min(chunkSize, maxBytes - total + 1));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) {
      throw new UploadGuardError(
        `${total} bytes read > AVITO_MCP_MAX_UPLOAD_MB limit (${maxBytes} bytes)`,
        path,
        'too_large',
      );
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
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
