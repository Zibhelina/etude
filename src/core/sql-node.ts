import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SqlConnection } from "./sql.ts";

export function openNode(path: string): SqlConnection {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  // The timeout lets the CLI and the server write at the same time: one waits instead of failing.
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec("PRAGMA journal_mode = WAL;");
  return db as unknown as SqlConnection;
}
