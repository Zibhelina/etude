// The server side of folders on this computer (src/core/folders.ts): opening and closing them, listing what's
// inside, a file's bytes, and the Notebook's own note routes for ids that are files on disk ("fs:…").
// Registered before the note routes, so those never see such an id.
import fs from "node:fs";
import type { Context, Hono } from "hono";
import { EtudeError, type Etude } from "../core/engine.ts";
import { isFsId } from "../core/folders.ts";
import { bringIntoNotebook } from "../core/folder-bring.ts";
import { takeIntoFolder } from "../core/folder-take.ts";
import { syncFor } from "../core/sync/client.ts";

/** The most of a file one answer carries; a player or PDF reader asks for the rest in ranges. */
const CHUNK = 8 * 1024 * 1024;
const MAX_WHOLE = 256 * 1024 * 1024;

function sendRaw(c: Context, r: { path: string; size: number; mime: string; name: string; mtime: number }, download: boolean): Response {
  const headers: Record<string, string> = {
    "Content-Type": r.mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    // A file from disk never runs as a page of the app, whatever it holds.
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    ETag: `"${r.size}-${Math.round(r.mtime)}"`,
  };
  if (download) headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(r.name)}`;
  if (c.req.header("if-none-match") === headers.ETag) return c.body(null, 304, headers);
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
  if (range && r.size > 0 && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, r.size - Number(range[2]));
    let end = range[1] && range[2] ? Number(range[2]) : r.size - 1;
    if (!(start >= 0 && start < r.size)) return c.body(null, 416, { ...headers, "Content-Range": `bytes */${r.size}` });
    end = Math.min(end, r.size - 1, start + CHUNK - 1);
    const buf = new Uint8Array(end - start + 1);
    const fd = fs.openSync(r.path, "r");
    let got = 0;
    try {
      while (got < buf.length) {
        const n = fs.readSync(fd, buf, got, buf.length - got, start + got);
        if (!n) break;
        got += n;
      }
    } finally {
      fs.closeSync(fd);
    }
    start = Math.min(start, r.size - 1);
    return c.body(buf.subarray(0, got), 206, { ...headers, "Content-Range": `bytes ${start}-${start + got - 1}/${r.size}`, "Content-Length": String(got) });
  }
  if (r.size > MAX_WHOLE) throw new EtudeError("that file is too big to open here", 413);
  return c.body(new Uint8Array(fs.readFileSync(r.path)), 200, headers);
}

export function folderRoutes(app: Hono, etude: Etude, body: <T = any>(c: Context) => Promise<T>) {
  const F = () => etude.folders;
  const fsParam = (c: Context): string | null => {
    const id = c.req.param("id");
    return isFsId(id) ? id : null;
  };

  // ---- the folders themselves
  app.get("/api/folders", (c) => c.json({ available: F().available, folders: F().list() }, 200, { "Cache-Control": "no-store" }));
  app.post("/api/folders", async (c) => {
    const b = await body(c);
    return c.json(F().open(String(b.path ?? ""), { name: b.name, trash: b.trash, hidden: !!b.hidden }));
  });
  app.patch("/api/folders/:folder", async (c) => {
    const b = await body(c);
    return c.json(F().edit(c.req.param("folder"), { name: b.name, trash: b.trash, hidden: b.hidden === undefined ? undefined : !!b.hidden }));
  });
  app.delete("/api/folders/:folder", (c) => c.json(F().close(c.req.param("folder"))));

  // ---- what's in them. The tree asks for the folders it has unfolded, all at once; a folder that's gone comes back null.
  app.post("/api/folders/entries", async (c) => {
    const b = await body(c);
    const dirs: string[] = Array.isArray(b.dirs) ? b.dirs.map(String).slice(0, 500) : [];
    const out: Record<string, unknown> = {};
    for (const d of dirs) {
      try {
        out[d] = F().children(d);
      } catch {
        out[d] = null;
      }
    }
    return c.json({ available: F().available, roots: F().roots(), dirs: out, stamps: stamps(dirs) }, 200, { "Cache-Control": "no-store" });
  });
  /**
   * What the tree compares between two looks. Besides the folders' own stamps: the orders given by hand, which
   * folders Sync carries (part of what the tree draws), and removals Sync is holding back (shown as a notice).
   * The listing and the poll answer with the same thing, or the tree would take every poll for a change.
   */
  const stamps = (dirs: string[]) => {
    const marks = etude.folderSync.marks();
    return { ...F().stamps(dirs), order: F().orderStamp(), synced: marks.map((l) => l.id).join("\n"), held: marks.filter((l) => l.paused).map((l) => ({ syncId: l.syncId, name: l.name, why: l.paused })) };
  };
  app.post("/api/folders/stamps", async (c) => {
    const b = await body(c);
    return c.json(stamps(Array.isArray(b.dirs) ? b.dirs.map(String) : []), 200, { "Cache-Control": "no-store" });
  });

  // ---- folders Sync carries to the other devices (src/core/sync/folder-files.ts)
  // A change here is followed by a sync right away, in the background, so files start moving without waiting for the next one.
  const kick = () => void syncFor(etude).auto().catch(() => {});
  app.get("/api/folders/sync", (c) => c.json(etude.folderSync.status(), 200, { "Cache-Control": "no-store" }));
  app.post("/api/folders/sync", async (c) => {
    const b = await body(c);
    if (b.estimate) return c.json(etude.folderSync.estimate(String(b.id ?? "")));
    const link = etude.folderSync.mark(String(b.id ?? ""), { name: typeof b.name === "string" ? b.name : undefined });
    kick();
    return c.json(link);
  });
  app.post("/api/folders/sync/link", async (c) => {
    const b = await body(c);
    const link = etude.folderSync.link(String(b.syncId ?? ""), String(b.path ?? ""));
    kick();
    return c.json(link);
  });
  app.post("/api/folders/sync/off", async (c) => {
    const b = await body(c);
    const out = etude.folderSync.unlink(String(b.syncId ?? b.id ?? ""), { everywhere: b.everywhere === true });
    if (out.everywhere) kick();
    return c.json(out);
  });
  app.post("/api/folders/sync/go", async (c) => {
    const b = await body(c);
    const link = etude.folderSync.goAhead(String(b.syncId ?? b.id ?? ""));
    kick();
    return c.json(link);
  });
  // Rows for tabs whose folder isn't unfolded (null when the file is gone).
  app.post("/api/folders/rows", async (c) => {
    const b = await body(c);
    const ids: string[] = Array.isArray(b.ids) ? b.ids.map(String).slice(0, 200) : [];
    return c.json(
      ids.map((id) => {
        try {
          return F().summary(id);
        } catch {
          return null;
        }
      }),
    );
  });
  app.get("/api/folders/resolve", async (c) => c.json({ id: await F().resolveLink(c.req.query("from") ?? "", c.req.query("target") ?? "") }));
  // A file's bytes: by id, or what a link in another file (`from`) points at.
  app.get("/api/folders/raw", async (c) => {
    let id = c.req.query("id") ?? "";
    if (!id && c.req.query("from")) id = (await F().resolveLink(c.req.query("from")!, c.req.query("target") ?? "")) ?? "";
    if (!id) return c.text("not found", 404, { "Cache-Control": "no-store" });
    return sendRaw(c, F().raw(id), c.req.query("download") === "1");
  });
  app.post("/api/folders/restore", async (c) => {
    const b = await body(c);
    return c.json(F().restore(String(b.id ?? ""), String(b.trashed ?? "")));
  });

  // ---- the note routes, for files on disk
  app.get("/api/notes/:id", (c, next) => {
    const id = fsParam(c);
    return id ? c.json(F().get(id)) : next();
  });
  app.get("/api/notes/:id/stamp", (c, next) => {
    const id = fsParam(c);
    return id ? c.json(F().stamp(id)) : next();
  });
  app.get("/api/notes/:id/backlinks", (c, next) => (fsParam(c) ? c.json([]) : next()));
  app.get("/api/notes/:id/export", (c, next) => {
    const id = fsParam(c);
    return id ? sendRaw(c, F().raw(id), true) : next();
  });
  app.patch("/api/notes/:id", async (c, next) => {
    const id = fsParam(c);
    if (!id) return next();
    const b = await body(c);
    let at = id;
    if (typeof b.content === "string") F().write(at, b.content, { base: b.base });
    // A page kept as a file: its document, own title (pageTitle), icon or look. `title` renames the file.
    if (b.doc !== undefined || b.scene !== undefined || b.board !== undefined || b.pageTitle !== undefined || b.icon !== undefined || b.look !== undefined) F().writePage(at, { doc: b.doc, scene: b.scene, board: b.board, title: b.pageTitle, icon: b.icon, look: b.look }, { base: b.base });
    if (typeof b.title === "string") at = F().rename(at, b.title).id;
    return c.json(F().get(at));
  });
  app.post("/api/notes/:id/pin", async (c, next) => {
    const id = fsParam(c);
    if (!id) return next();
    const b = await c.req.json().catch(() => ({}));
    return c.json(F().pin(id, b.pinned !== false));
  });
  app.post("/api/notes/:id/opened", (c, next) => {
    const id = fsParam(c);
    return id ? c.json(F().markOpened(id)) : next();
  });
  app.post("/api/notes/:id/move", async (c, next) => {
    const id = fsParam(c);
    if (!id) return next();
    const b = await body(c);
    return c.json(F().move(id, String(b.parentId ?? ""), typeof b.index === "number" ? b.index : undefined));
  });
  // Several at once, each to its folder and its place there (a drag of a selection, and its Undo).
  app.post("/api/folders/place", async (c) => {
    const b = await body(c);
    const items = Array.isArray(b.items) ? b.items.map((it: any) => ({ id: String(it?.id ?? ""), parentId: String(it?.parentId ?? ""), index: typeof it?.index === "number" ? it.index : undefined })) : [];
    return c.json(F().place(items));
  });
  // Between the collection and a folder on this computer, either way (a drag from one to the other): notes become
  // files (`take`) or files become notes (`bring`). Nothing is deleted: the notes go to the Archive, the files to
  // their folder's trash.
  app.post("/api/folders/take", async (c) => {
    const b = await body(c);
    const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
    const into = String(b.parentId ?? "");
    if (!ids.length || !isFsId(into)) throw new EtudeError("name the notes and the folder they go into");
    const reports = [];
    for (const id of ids) reports.push(await takeIntoFolder(etude, id, into));
    return c.json({ reports, moved: reports.flatMap((r) => r.moved) });
  });
  app.post("/api/folders/bring", async (c) => {
    const b = await body(c);
    const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
    if (!ids.length || !ids.every(isFsId)) throw new EtudeError("name the files to bring into the Notebook");
    const parent = typeof b.parentId === "string" && b.parentId ? b.parentId : null;
    if (isFsId(parent)) throw new EtudeError("that's a folder on this computer: move the files there instead");
    return c.json(await bringIntoNotebook(etude, ids, parent, { index: typeof b.index === "number" ? b.index : undefined }));
  });
  app.post("/api/folders/sort", async (c) => c.json(F().sortByName(String((await body(c)).id ?? ""))));
  app.post("/api/notes/:id/archive", async (c, next) => {
    const id = fsParam(c);
    if (!id) return next();
    const b = await body(c);
    if (b.archived !== true) throw new EtudeError("a file comes back from the trash with Undo, or by moving it out of the trash folder");
    return c.json(F().trash(id));
  });
  // Never deleted from here: it goes to the folder's trash.
  app.delete("/api/notes/:id", (c, next) => {
    const id = fsParam(c);
    return id ? c.json(F().trash(id)) : next();
  });
  app.post("/api/notes/:id/portal", (c, next) => {
    if (!fsParam(c)) return next();
    throw new EtudeError("a portal can't be added from here to a page or file kept on this computer yet");
  });
}
