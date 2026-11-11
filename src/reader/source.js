// Random-access reads from one file, with hard limits. The reader handles
// uploads from strangers, so a hostile file must not be able to make it
// allocate, loop or run without bound.
import fs from 'node:fs/promises';

/** code: 'unsupported' (not a format we read), 'corrupt', or 'limit'. */
export class ReadError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

export const MAX_BLOCK = 32 * 1024 * 1024; // largest piece ever held in memory (a tag with artwork)
const MAX_READS = 100_000;

export class Source {
  constructor(fh, size, timeoutMs) {
    this.fh = fh;
    this.size = size;
    this.reads = 0;
    this.deadline = Date.now() + timeoutMs;
  }

  static async open(file, timeoutMs) {
    const fh = await fs.open(file, 'r');
    try {
      const { size } = await fh.stat();
      return new Source(fh, size, timeoutMs);
    } catch (e) {
      await fh.close();
      throw e;
    }
  }

  close() {
    return this.fh.close();
  }

  /** Up to `length` bytes at `pos`. Shorter (or empty) at the end of the file. */
  async read(pos, length) {
    if (!Number.isSafeInteger(pos) || !Number.isSafeInteger(length) || pos < 0 || length < 0) throw new ReadError('corrupt');
    if (length > MAX_BLOCK) throw new ReadError('limit');
    if (++this.reads > MAX_READS || Date.now() > this.deadline) throw new ReadError('limit');
    const want = Math.max(0, Math.min(length, this.size - pos));
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const { bytesRead } = await this.fh.read(buf, got, want - got, pos + got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    return got === want ? buf : buf.subarray(0, got);
  }
}
