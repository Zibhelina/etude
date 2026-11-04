// Reads a collection backup (Settings → Data in the serverless builds) without letting a small zip
// unpack into gigabytes: every entry's declared size is counted before anything is inflated, and
// fflate never writes past the size an entry declares.
import { unzipSync } from "fflate";

export const BACKUP_LIMITS = { file: 1024 ** 3, total: 2 * 1024 ** 3, entries: 200_000 };

class TooLarge extends Error {}

const ours = (name: string) => name === "etude.db" || name === "etude-backup.json" || (name.startsWith("media/") && !name.endsWith("/"));

/** The backup's files (etude.db, etude-backup.json, media/…); anything else in the zip is skipped. */
export function readBackup(bytes: Uint8Array, limits = BACKUP_LIMITS): Record<string, Uint8Array> {
  let total = 0;
  let entries = 0;
  try {
    return unzipSync(bytes, {
      filter: (f) => {
        if (!ours(f.name)) return false;
        const size = Math.max(f.size, f.originalSize);
        if (++entries > limits.entries) throw new TooLarge(`it has more than ${limits.entries} files`);
        if (size > limits.file) throw new TooLarge(`${f.name} would unpack to more than ${limits.file} bytes`);
        total += size;
        if (total > limits.total) throw new TooLarge(`it would unpack to more than ${limits.total} bytes`);
        return true;
      },
    });
  } catch (e) {
    if (e instanceof TooLarge) throw new Error(`that backup is too large to restore here: ${e.message}`);
    throw new Error("that file isn't an Etude backup (not a zip)");
  }
}
