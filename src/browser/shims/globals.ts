// Node globals the core uses (Buffer, a few process fields). Imported before anything else.
import { Buffer } from "buffer";

const g = globalThis as any;
g.Buffer ??= Buffer;
g.process ??= {
  env: { ETUDE_SQL: "wasm", TMPDIR: "/tmp" },
  pid: 1,
  platform: "browser",
  versions: {},
  cwd: () => "/",
  stderr: { write: (s: string) => console.debug(s.trimEnd()) },
};
