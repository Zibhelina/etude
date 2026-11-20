// `etude mcp`: the collection as a Model Context Protocol server over stdio, for agents (Claude Code, Codex,
// Claude Desktop, Cursor). Notes get their own tools; everything else goes through etude_help and etude_run, the
// same pair Ask Etude uses. Each call opens the collection, runs one CLI command and closes it, so the app can stay
// open beside it: an open page takes outside edits live.
import { command, CliError } from "../registry.ts";
import { mcpRefusal, PROFILE_WRITES } from "../../core/agent-guard.ts";

const DENY = ["serve", "update", "mcp", "agent", "db restore", "settings chatgpt login", "settings chatgpt logout", "settings chatgpt import", "settings key set", "settings key unset", "market publish", "media prune", ...PROFILE_WRITES];

type Json = Record<string, any>;
interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  /** The CLI argv for a call, plus what goes on stdin. */
  argv(a: Json): { argv: string[]; stdin?: string };
  writes?: boolean;
}

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const bool = (description: string) => ({ type: "boolean", description });
const NOTE = str('The note: its id (or the first 8 characters of it, as notes_tree shows), its exact title, or its path through the folders ("Journal/2026-11-08").');
/** `--name=value`, so a value starting with "-" (a Markdown list) isn't read as a flag. */
const flag = (name: string, v: unknown) => (v === undefined || v === null || v === false ? [] : v === true ? [`--${name}`] : [`--${name}=${v}`]);

const ELEMENT_PROPS: Record<string, Json> = {
  x: num("Left edge."),
  y: num("Top edge."),
  width: num("Width."),
  height: num("Height."),
  dx: num("edit: move right by this much."),
  dy: num("edit: move down by this much."),
  text: str("A text element's words, or the label in a shape or on an arrow (a frame's name)."),
  color: str("Line and text colour: #rrggbb or black, gray, red, pink, grape, violet, indigo, blue, cyan, teal, green, lime, yellow, orange."),
  background: str("Fill: #rrggbb, transparent, or a colour name (its light shade)."),
  fill: { type: "string", enum: ["solid", "hachure", "cross-hatch", "zigzag"] },
  stroke_width: num("Line width: 1, 2 or 4."),
  stroke_style: { type: "string", enum: ["solid", "dashed", "dotted"] },
  roughness: num("0 clean, 1 hand-drawn, 2 sketchy."),
  opacity: num("0 to 100."),
  font_size: num("Text size (20)."),
  font: { type: "string", enum: ["hand", "normal", "code"] },
  align: { type: "string", enum: ["left", "center", "right"] },
  from: str("Arrow/line: start at this element id (it stays attached)."),
  to: str("Arrow/line: end at this element id."),
  points: { type: "array", items: { type: "array", items: { type: "number" } }, description: "Arrow/line: points relative to x,y, e.g. [[0,0],[120,40]]." },
  head: { type: "string", enum: ["arrow", "triangle", "dot", "bar", "none"] },
  link: str("A URL it opens."),
  frame: str("Put it in this frame (id)."),
  file: str("add image: a picture file on disk (copied into the collection's media)."),
  order: { type: "string", enum: ["front", "back"], description: "edit: bring to the front or send to the back." },
};

const TOOLS: Tool[] = [
  {
    name: "notes_tree",
    description: "The Notes tree as indented lines: each note's title, its kind (folders end in /; canvas, pdf, file, web, kanban are marked) and the first 8 characters of its id, which any other tool accepts. Start here to find where things are.",
    inputSchema: { type: "object", properties: { under: str("Only this folder or page and what's inside it (id, title or path)."), depth: num("At most this many levels."), paths: bool("Return [{ path, id, kind, updated }] with full paths instead of the indented tree.") } },
    argv: (a) => ({ argv: ["note", "tree", ...(a.under ? [a.under] : []), ...flag("depth", a.depth), ...flag("paths", a.paths)] }),
  },
  {
    name: "notes_search",
    description: "Notes whose title or text has every word (pages, files, canvases, boards), title matches first, each with a snippet.",
    inputSchema: { type: "object", properties: { query: str("Words to look for."), limit: num("At most this many (20).") }, required: ["query"] },
    argv: (a) => ({ argv: ["note", "search", ...flag("limit", a.limit), "--", ...String(a.query).split(/\s+/).filter(Boolean)] }),
  },
  {
    name: "notes_read",
    description:
      "Read a note: a header line (path, kind, id, last change), then a page as Markdown, a file's or web file's text, a kanban board as Markdown, a canvas's elements as JSON, or a folder's contents. blocks: true numbers a page's top-level blocks (for notes_block and notes_append's at) and marks with * and their type the ones Markdown can't hold whole (columns, portals, toggles, coloured text). lines: true numbers a file's lines.",
    inputSchema: { type: "object", properties: { note: NOTE, blocks: bool("Number the page's top-level blocks."), lines: bool("Number a file's lines.") }, required: ["note"] },
    argv: (a) => ({ argv: ["note", "read", a.note, ...flag("blocks", a.blocks), ...flag("lines", a.lines)] }),
  },
  {
    name: "notes_create",
    description: "Make a note: a page (with a Markdown body; pictures at local paths are copied in), a folder, a file (code or text kept exactly, highlighted by the extension in its title), a web file (HTML/CSS/JS, live in portals), a kanban board, a canvas, or a PDF note from a file on disk. Returns the new note.",
    inputSchema: {
      type: "object",
      properties: {
        title: str("Its title (for a file, a name with an extension: main.py)."),
        parent: str("The folder or page to put it in (id, title or path). Top level when left out."),
        kind: { type: "string", enum: ["page", "folder", "file", "web", "kanban", "canvas", "pdf"], description: "page by default." },
        markdown: str("A page's body as Markdown: headings, lists, - [ ] to-dos, tables, code, $math$, > [!note] callouts, ![alt](picture path), [[links]] to other notes."),
        content: str("A file's text or a web file's HTML."),
        columns: str('A kanban board\'s columns, comma separated ("Backlog,This week,Done").'),
        pdf: str("kind pdf: the PDF file on disk."),
        icon: str("One emoji."),
      },
      required: ["title"],
    },
    argv: (a) => {
      const kind = a.kind ?? (a.pdf ? "pdf" : a.content !== undefined ? "file" : "page");
      const k = kind === "page" ? [] : kind === "file" ? ["--file"] : kind === "pdf" ? [`--pdf=${a.pdf ?? ""}`] : [`--${kind}`];
      const body = kind === "page" && a.markdown !== undefined ? { argv: ["--md=-"], stdin: String(a.markdown) } : (kind === "file" || kind === "web") && a.content !== undefined ? { argv: ["--content=-"], stdin: String(a.content) } : { argv: [] as string[] };
      return { argv: ["note", "new", a.title, ...k, ...flag("parent", a.parent), ...flag("icon", a.icon), ...flag("columns", a.columns), ...body.argv], stdin: body.stdin };
    },
    writes: true,
  },
  {
    name: "notes_append",
    description: "Add to a note without touching anything already there. A page takes Markdown (or block JSON for what Markdown can't say) at the end (default), at the top, at the end of the section under a heading, or before top-level block N; a file or web file takes text at the end, the top, or before line N. Returns what was added.",
    inputSchema: {
      type: "object",
      properties: { note: NOTE, markdown: str("What to add: Markdown for a page, plain text for a file."), json: str("Pages: blocks as JSON (one node, a list, or a doc), like notes_block prints."), under: str("Pages: a heading; add at the end of its section."), at: num("Before top-level block N (pages, 0 = top) or line N (files, 1 = first)."), top: bool("At the very top.") },
      required: ["note"],
    },
    argv: (a) => {
      if ((a.markdown === undefined) === (a.json === undefined)) throw new CliError("give markdown or json");
      const body = a.json !== undefined ? ["--json=-"] : ["--md=-"];
      return { argv: ["note", "append", a.note, ...body, ...flag("under", a.under), ...flag("at", a.at), ...flag("top", a.top)], stdin: String(a.json !== undefined ? (typeof a.json === "string" ? a.json : JSON.stringify(a.json)) : a.markdown) };
    },
    writes: true,
  },
  {
    name: "notes_patch",
    description:
      "Replace a piece of a page or file, like find-and-replace. On a page it works on the Markdown notes_read shows and only rewrites the blocks it touches; on a file or web file on the exact text. old must appear exactly once (or set all); on a page it may span several blocks. Tick a to-do with old \"- [ ] Lab 2\", new \"- [x] Lab 2\"; an empty new deletes. Blocks marked * in notes_read keep their formatting when old sits inside one run of their text; otherwise use notes_block (or force, which loses what Markdown can't say).",
    inputSchema: { type: "object", properties: { note: NOTE, old: str("The text to replace, as it reads in notes_read."), new: str("What goes in its place (empty to delete)."), all: bool("Every place it appears."), force: bool("Pages: rewrite blocks Markdown can't hold whole anyway.") }, required: ["note", "old", "new"] },
    argv: (a) => ({ argv: ["note", "patch", a.note, `--old=${a.old}`, "--new=-", ...flag("all", a.all), ...flag("force", a.force)], stdin: String(a.new ?? "") }),
    writes: true,
  },
  {
    name: "notes_block",
    description:
      "One top-level block of a page as the editor's own JSON node, for anything Markdown can't say: columns, toggles (details), callouts, portals and embeds, flashcards, coloured or resized text, alignment. get prints it (copy a real one to learn the shape); set replaces it with JSON (one node or a list) or Markdown; move puts it (and count-1 after it) before block to; delete removes it. Numbers come from notes_read with blocks: true.",
    inputSchema: {
      type: "object",
      properties: { note: NOTE, n: num("The block's number (0 = first)."), action: { type: "string", enum: ["get", "set", "move", "delete"] }, json: { description: "set: the new block(s) as JSON (object, list, or a JSON string)." }, markdown: str("set: the new block(s) as Markdown."), to: num("move: before this block (the page's length = the end)."), count: num("move/delete: this many blocks from n.") },
      required: ["note", "n"],
    },
    argv: (a) => {
      const base = ["note", "block", a.note, String(a.n)];
      const act = a.action ?? "get";
      if (act === "get") return { argv: base };
      if (act === "delete") return { argv: [...base, "--delete", ...flag("count", a.count)] };
      if (act === "move") return { argv: [...base, `--to=${a.to}`, ...flag("count", a.count)] };
      if (a.json !== undefined) return { argv: [...base, "--set=-"], stdin: typeof a.json === "string" ? a.json : JSON.stringify(a.json) };
      if (a.markdown !== undefined) return { argv: [...base, "--md=-"], stdin: String(a.markdown) };
      throw new CliError("set needs json or markdown");
    },
    writes: true,
  },
  {
    name: "notes_canvas",
    description:
      "Draw on a canvas (an Excalidraw whiteboard), element by element. list: every element (id, type, box, words, what arrows connect). add: a rectangle, ellipse, diamond, text, arrow, line, image or frame; shapes take a label with text, arrows tie two elements together with from/to and follow them when they move. edit: change an element's words, colours, size or place (x/y or dx/dy), or order it front/back; a shape's label and its arrows follow. delete: remove elements (their labels go too).",
    inputSchema: {
      type: "object",
      properties: { canvas: str("The canvas: id (or its start), title or path."), action: { type: "string", enum: ["list", "add", "edit", "delete"] }, type: { type: "string", enum: ["rectangle", "ellipse", "diamond", "text", "arrow", "line", "image", "frame"], description: "add: what to draw." }, element: str("edit: the element's id (or its first 4+ characters)."), elements: { type: "array", items: { type: "string" }, description: "delete: element ids." }, ...ELEMENT_PROPS },
      required: ["canvas"],
    },
    argv: (a) => {
      const act = a.action ?? "list";
      if (act === "list") return { argv: ["note", "canvas", a.canvas] };
      if (act === "delete") return { argv: ["note", "canvas", "delete", a.canvas, ...(a.elements ?? (a.element ? [a.element] : []))] };
      const props: string[] = [];
      let stdin: string | undefined;
      for (const k of Object.keys(ELEMENT_PROPS)) {
        if (a[k] === undefined || k === "order") continue;
        const name = k.replace(/_/g, "-");
        if (k === "points") props.push(`--points=${JSON.stringify(a[k])}`);
        else if (k === "text") (props.push("--text=-"), (stdin = String(a.text)));
        else props.push(...flag(name, a[k]));
      }
      if (act === "add") {
        if (!a.type) throw new CliError("add needs type");
        return { argv: ["note", "canvas", "add", a.canvas, a.type, ...props], stdin };
      }
      if (!a.element) throw new CliError("edit needs element");
      return { argv: ["note", "canvas", "edit", a.canvas, a.element, ...props, ...(a.order === "front" ? ["--front"] : a.order === "back" ? ["--back"] : [])], stdin };
    },
    writes: true,
  },
  {
    name: "notes_kanban",
    description:
      "Work a kanban board like in the app. show: the columns and their cards (id, title, due, labels, to-dos done). card: one card with its page as Markdown. add: a card in a column (first by default) with due day, labels, cover colour and a Markdown page. move: a card to a column (and a place in it). edit: a card's title, due, labels (replace) or cover, its whole page (markdown), or part of it (old/new find-and-replace, append). archive / restore: a card. column: add a column (a new name) or change one (rename, color, limit, done, at, remove).",
    inputSchema: {
      type: "object",
      properties: {
        board: str("The board: id (or its start), title or path."),
        action: { type: "string", enum: ["show", "card", "add", "move", "edit", "archive", "restore", "column"] },
        card: str("card/move/edit/archive/restore: the card's id or exact title. add: the new card's title."),
        column: str("add/move: the column (name, id or number, 1 = first). column: the column to change, or a new name to add one."),
        at: num("add/move: place in the column (0 = top). column: move the column to this place (0 = first)."),
        title: str("edit: new title."),
        due: str("YYYY-MM-DD, today, tomorrow, or none."),
        labels: { type: "array", items: { type: "string" }, description: "Labels by name (name:colour picks a colour; new ones are made). On edit they replace the card's labels; [] removes all." },
        cover: { type: "string", enum: ["grey", "red", "orange", "gold", "green", "teal", "blue", "purple", "pink", "none"] },
        markdown: str("add/edit: the card's whole page as Markdown."),
        old: str("edit: text in the card's page to replace (as action card shows it)."),
        new: str("edit: what goes in place of old (empty deletes)."),
        append: str("edit: Markdown to add at the end of the card's page."),
        rename: str("column: new name."),
        color: { type: "string", enum: ["grey", "red", "orange", "gold", "green", "teal", "blue", "purple", "pink"] },
        limit: num("column: at most this many cards (0 = none)."),
        done: bool("column: its cards count as done (false: they don't)."),
        remove: bool("column: remove it (its cards go to the archive)."),
        full: bool("show: the whole board as JSON, with every card's page."),
      },
      required: ["board"],
    },
    argv: (a) => {
      const act = a.action ?? "show";
      const b = a.board;
      const need = (k: string) => {
        if (a[k] === undefined) throw new CliError(`${act} needs ${k}`);
        return String(a[k]);
      };
      const meta = [...flag("due", a.due), ...flag("cover", a.cover), ...(Array.isArray(a.labels) ? a.labels.map((l: string) => `--label=${l}`) : [])];
      switch (act) {
        case "show":
          return { argv: ["note", "kanban", b, ...flag("full", a.full)] };
        case "card":
          return { argv: ["note", "kanban", "card", b, need("card")] };
        case "add":
          return { argv: ["note", "kanban", "add", b, need("card"), ...flag("column", a.column), ...flag("at", a.at), ...meta, ...(a.markdown !== undefined ? ["--md=-"] : [])], stdin: a.markdown };
        case "move":
          return { argv: ["note", "kanban", "move", b, need("card"), need("column"), ...flag("at", a.at)] };
        case "edit": {
          const labels = Array.isArray(a.labels) && !a.labels.length ? ["--no-labels"] : [];
          const body = a.markdown !== undefined ? { argv: ["--md=-"], stdin: String(a.markdown) } : a.append !== undefined ? { argv: ["--append=-"], stdin: String(a.append) } : { argv: [] as string[], stdin: undefined };
          if (a.markdown !== undefined && a.append !== undefined) throw new CliError("markdown replaces the page and append adds to it: pick one");
          return { argv: ["note", "kanban", "edit", b, need("card"), ...flag("title", a.title), ...meta, ...labels, ...(a.old !== undefined ? [`--old=${a.old}`, `--new=${a.new ?? ""}`] : []), ...body.argv], stdin: body.stdin };
        }
        case "archive":
          return { argv: ["note", "kanban", "archive", b, need("card")] };
        case "restore":
          return { argv: ["note", "kanban", "archive", b, need("card"), "--restore"] };
        case "column":
          return {
            argv: ["note", "kanban", "column", b, need("column"), ...flag("rename", a.rename), ...flag("color", a.color), ...flag("limit", a.limit), ...flag("at", a.at), ...(a.done === true ? ["--done"] : a.done === false ? ["--not-done"] : []), ...flag("remove", a.remove)],
          };
        default:
          throw new CliError(`no action ${act}`);
      }
    },
    writes: true,
  },
  {
    name: "notes_edit",
    description: "Change a note's title, icon or look (cover preset or a picture on disk, page width, font, text size), or replace a page's whole body with Markdown or a file's whole text (for parts use notes_patch, notes_append or notes_block: a whole rewrite of a page drops what Markdown can't say).",
    inputSchema: {
      type: "object",
      properties: {
        note: NOTE,
        title: str("New title."),
        icon: str("One emoji; empty removes it."),
        markdown: str("The page's whole new body."),
        content: str("A file's or web file's whole new text."),
        cover: str("sky, teal, plum, mustard, brick, moss, rose, night, dawn, sea, paper, ink, a picture file on disk, or none."),
        width: { type: "string", enum: ["normal", "wide", "full"] },
        font: { type: "string", enum: ["sans", "serif", "mono"] },
        size: { type: "string", enum: ["small", "normal", "large"] },
      },
      required: ["note"],
    },
    argv: (a) => {
      const body = a.markdown !== undefined ? { argv: ["--md=-"], stdin: String(a.markdown) } : a.content !== undefined ? { argv: ["--content=-"], stdin: String(a.content) } : { argv: [] as string[] };
      return { argv: ["note", "edit", a.note, ...flag("title", a.title), ...(a.icon !== undefined ? [`--icon=${a.icon}`] : []), ...flag("cover", a.cover), ...flag("width", a.width), ...flag("font", a.font), ...flag("size", a.size), ...body.argv], stdin: body.stdin };
    },
    writes: true,
  },
  {
    name: "notes_organize",
    description: "Where a note lives and how it's kept: move it into another folder or page (or the top level, at a place among its siblings), archive or unarchive it (with what's inside), delete it for good (confirm: true), pin it to the start page or unpin it, or open a portal to it (a web file, canvas or kanban board) inside a page.",
    inputSchema: {
      type: "object",
      properties: {
        note: NOTE,
        action: { type: "string", enum: ["move", "archive", "unarchive", "delete", "pin", "unpin", "portal"] },
        parent: str("move: the new folder or page (id, title or path)."),
        top: bool("move: to the top level."),
        index: num("move: place among its new siblings, 0 first."),
        page: str("portal: the page it opens in."),
        at: num("portal: before this top-level block of the page (the end by default)."),
        confirm: bool("delete: yes, delete it and everything inside it for good."),
      },
      required: ["note", "action"],
    },
    argv: (a) => {
      switch (a.action) {
        case "move":
          return { argv: ["note", "move", a.note, ...(a.top ? ["--top"] : a.parent ? [a.parent] : []), ...flag("index", a.index)] };
        case "delete":
          if (!a.confirm) throw new CliError("deleting is for good: set confirm: true (archive keeps it)");
          return { argv: ["note", "delete", a.note, "--yes"] };
        case "portal":
          if (!a.page) throw new CliError("portal needs page");
          return { argv: ["note", "portal", a.note, a.page, ...flag("at", a.at)] };
        case "archive":
        case "unarchive":
        case "pin":
        case "unpin":
          return { argv: ["note", a.action, a.note] };
        default:
          throw new CliError(`no action ${a.action}`);
      }
    },
    writes: true,
  },
  {
    name: "notes_view",
    description:
      "What the open Etude app shows, and changing it the way the person could with the mouse. show: the screen, the Notebook's panes (numbered from 1, each with its tabs, tab groups, pins and size) and the sidebar, Notes' pages and the Ask panel. open: a note (or, with no note, a New tab) as a tab, in place of the front page, or in a pane of its own on a side (right, left, top, bottom) of another. close: a tab, or a whole pane. close-others: every other unpinned tab in that tab's pane. focus: a tab or a pane. pin / unpin a tab; icon: a pinned tab's icon (an emoji; clear for the page's own). move: a tab into a pane's tabs (before a tab) or, with side, to a side of a pane. group: tabs into a new group (name, color) or an existing one (group). group-edit: rename, recolour, fold or unfold a group. ungroup: a whole group, or one tab out of its group. group-close: a group and its tabs. group-move: a whole group along its strip (before) or into another pane. resize: a pane's share of its split (size 0.05–0.95). zoom: a pane's own zoom (in, out, reset, or a size like 1.25), the rest of the window as it is. sidebar: open, rail or none. pages: show or hide Notes' page tree. panel: open or close the Ask side panel. go: another screen (notes, library, study, browse, stats, market, settings, or a path). Tabs are notes (id, its start, title or path) or the chat:… / new:… ids show lists; panes are a number, an open tab or \"chat\". Needs the app open on this computer.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["show", "open", "close", "close-others", "focus", "pin", "unpin", "icon", "move", "group", "group-edit", "ungroup", "group-close", "group-move", "resize", "zoom", "sidebar", "pages", "panel", "go"] },
        note: str("The tab or note it acts on (open: leave out for a New tab)."),
        tabs: { type: "array", items: { type: "string" }, description: "group: the tabs to put in it." },
        where: { type: "string", enum: ["right", "left", "top", "bottom", "tab", "replace"], description: "open: a pane on that side, a new tab (default), or in place of the front page." },
        beside: str("open: the pane it goes beside or into: its number, a tab open there, or chat. The focused pane by default."),
        pane: str("close: the whole pane. focus, resize, zoom: a pane (number, a tab in it, or chat). move, group-move: the pane it goes to (move: \"panel\" sends an Ask chat back to the side panel)."),
        before: str("move, group-move: the tab it goes in front of (the end when left out). open as a tab: the tab it goes in front of, or \"end\" (next to the front page when left out)."),
        side: { type: "string", enum: ["right", "left", "top", "bottom"], description: "move: a pane of its own on that side of pane." },
        group: str("group: an existing group to add to; group-edit, ungroup, group-close: the group (id or name)."),
        name: str("group, group-edit: the group's name."),
        color: str("group, group-edit: gray, blue, red, yellow, green, pink, purple, orange, or #rrggbb."),
        fold: { type: "boolean", description: "group-edit: true folds the group into its label, false shows its tabs." },
        icon: str("icon: an emoji (or emoji:…, art:…, media:…); \"clear\" for the page's own."),
        size: { type: "number", description: "resize: the pane's share of its split, 0.05 to 0.95." },
        zoom: str("zoom: in, out, reset, or a size (1.25 or 125%, from 50% to 300%)."),
        mode: { type: "string", enum: ["open", "rail", "none"], description: "sidebar: open wide, folded to icons, or hidden." },
        open: { type: "boolean", description: "pages, panel: show (true) or hide (false)." },
        route: str("go: a screen or path."),
      },
      required: ["action"],
    },
    argv: (a) => {
      const need = (k: string) => {
        if (a[k] === undefined || a[k] === null || a[k] === "") throw new CliError(`${a.action} needs ${k}`);
        return String(a[k]);
      };
      switch (a.action) {
        case "show":
          return { argv: ["view", "show"] };
        case "open":
          return { argv: ["view", "open", ...(a.note ? [a.note] : []), ...flag("where", a.where), ...flag("beside", a.beside), ...flag("before", a.before)] };
        case "close":
          return { argv: ["view", "close", ...(a.note ? [a.note] : []), ...flag("pane", a.pane)] };
        case "close-others":
          return { argv: ["view", "close-others", need("note")] };
        case "focus":
          if (!a.note && !a.pane) throw new CliError("focus needs note or pane");
          return { argv: ["view", "focus", String(a.note ?? a.pane)] };
        case "pin":
        case "unpin":
          return { argv: ["view", "pin", need("note"), ...(a.action === "unpin" ? ["--off"] : [])] };
        case "icon":
          return { argv: ["view", "icon", need("note"), ...(a.icon && a.icon !== "clear" ? [String(a.icon)] : ["--clear"])] };
        case "move":
          return { argv: ["view", "move", need("note"), ...flag("to", a.pane), ...flag("before", a.before), ...flag("side", a.side)] };
        case "group": {
          const tabs = Array.isArray(a.tabs) && a.tabs.length ? a.tabs.map(String) : a.note ? [String(a.note)] : [];
          if (!tabs.length) throw new CliError("group needs tabs");
          return { argv: ["view", "group", ...tabs, ...flag("into", a.group), ...flag("name", a.name), ...flag("color", a.color)] };
        }
        case "group-edit":
          return { argv: ["view", "group-edit", need("group"), ...(a.name !== undefined ? [`--name=${a.name}`] : []), ...flag("color", a.color), ...(a.fold === true ? ["--fold"] : a.fold === false ? ["--unfold"] : [])] };
        case "ungroup":
          if (!a.group && !a.note) throw new CliError("ungroup needs group or note");
          return { argv: ["view", "ungroup", ...(a.group ? [String(a.group)] : []), ...flag("tab", a.group ? undefined : a.note)] };
        case "group-close":
          return { argv: ["view", "group-close", need("group")] };
        case "group-move":
          return { argv: ["view", "group-move", need("group"), ...flag("to", a.pane), ...flag("before", a.before)] };
        case "resize":
          return { argv: ["view", "resize", String(a.pane ?? a.note ?? need("pane")), need("size")] };
        case "zoom":
          return { argv: ["view", "zoom", String(a.pane ?? a.note ?? need("pane")), need("zoom")] };
        case "sidebar":
          return { argv: ["view", "sidebar", need("mode")] };
        case "pages":
        case "panel":
          if (typeof a.open !== "boolean") throw new CliError(`${a.action} needs open`);
          return { argv: ["view", a.action, a.action === "pages" ? (a.open ? "show" : "hide") : a.open ? "open" : "close"] };
        case "go":
          return { argv: ["view", "go", need("route")] };
        default:
          throw new CliError(`no action ${a.action}`);
      }
    },
    writes: true,
  },
  {
    name: "etude_help",
    description: "Look up Etude CLI commands (decks, cards, practice, stats, settings, themes, Market…): with no query the command groups, with words the matching commands with their arguments, flags and examples. Use it before etude_run.",
    inputSchema: { type: "object", properties: { query: str("A group name or words.") } },
    argv: () => ({ argv: [] }),
  },
  {
    name: "etude_run",
    description: "Run one Etude CLI command on the collection and get its JSON output, e.g. [\"deck\",\"list\"], [\"stats\",\"overview\"], [\"search\",\"deck:Networking is:due\"]. Leave out the leading \"etude\". Write flags as --name=value. Destructive commands need --yes; try --dry-run first.",
    inputSchema: { type: "object", properties: { argv: { type: "array", items: { type: "string" }, description: "The command and its arguments." }, stdin: str("Text for an argument given as -.") }, required: ["argv"] },
    argv: (a) => ({ argv: (Array.isArray(a.argv) ? a.argv.map(String) : []).filter((x: string, i: number) => !(i === 0 && x === "etude")), stdin: a.stdin }),
  },
];

command({
  name: "mcp",
  summary: "Serve the collection to an AI agent over the Model Context Protocol (stdio): tools to find, read, create and edit notes, plus etude_help and etude_run for every other command.",
  description:
    "Add it to an agent's MCP servers as the command `etude mcp --db <collection>` (or with ETUDE_DB set). Each tool call opens the collection, runs one command and closes it, so the app can stay open: a page open in it takes the change live. With --read-only, tools that write are left out and etude_run refuses commands that write. serve, update, agent, db restore, key or sign-in commands and changes to agent profiles (`etude agents add`, `edit`…) aren't available.",
  flags: [{ name: "read-only", type: "boolean", description: "Only tools that read." }],
  noDb: true,
  examples: ["etude mcp --db ~/Etude/etude.db", "claude mcp add etude -- etude mcp --db ~/Etude/etude.db"],
  output: "JSON-RPC messages on stdout until stdin closes",
  async run(ctx) {
    const { run, resolveCommand, parseInvocation, wantsHelp, VERSION } = await import("../run.ts");
    const { helpText } = await import("../../core/agent.ts");
    const readOnly = !!ctx.flags["read-only"];
    const tools = TOOLS.filter((t) => !(readOnly && t.writes));
    const send = (m: Json) => process.stdout.write(JSON.stringify(m) + "\n");
    const exec = async (argv: string[], stdin = "") => {
      let out = "", err = "";
      const code = await run(["--db", ctx.dbPath, ...argv], { stdout: (s) => (out += s), stderr: (s) => (err += s), stdin: () => stdin, isTTY: false, env: process.env }, { mcp: true });
      return { code, out, err };
    };
    const call = async (name: string, a: Json): Promise<{ text: string; isError: boolean }> => {
      const t = tools.find((x) => x.name === name);
      if (!t) return { text: `unknown tool "${name}"`, isError: true };
      if (name === "etude_help") return { text: await helpText(String(a.query ?? "")), isError: false };
      let inv: { argv: string[]; stdin?: string };
      try {
        inv = t.argv(a ?? {});
      } catch (e) {
        return { text: (e as Error).message, isError: true };
      }
      if (inv.argv.some((x) => x === "--db" || x.startsWith("--db="))) return { text: "--db can't be used here: the server works on its own collection", isError: true };
      const cmd = resolveCommand(inv.argv);
      if (cmd && DENY.some((d) => cmd.name === d || cmd.name.startsWith(d + " "))) return { text: `\`etude ${cmd.name}\` isn't available over MCP`, isError: true };
      const isHelp = wantsHelp(inv.argv, cmd ?? undefined);
      let parsed: ReturnType<typeof parseInvocation> = null;
      if (cmd && !isHelp) {
        let refused: string | null = null;
        try {
          parsed = parseInvocation(inv.argv);
          refused = parsed ? mcpRefusal(parsed.cmd, parsed.values, parsed.named) : mcpRefusal(cmd);
        } catch {
          refused = mcpRefusal(cmd);
        }
        if (refused) return { text: `Not allowed: ${refused}`, isError: true };
      }
      const isDry = !!parsed?.values["dry-run"];
      if (readOnly && cmd?.writes && !isDry && !isHelp) return { text: `\`etude ${cmd.name}\` writes, and this server is read-only`, isError: true };
      const r = await exec(inv.argv, inv.stdin ?? "");
      const text = (r.out || "").trim() + (r.code !== 0 ? (r.out ? "\n" : "") + (r.err || `exit ${r.code}`).trim() : "");
      return { text: text || "(done)", isError: r.code !== 0 };
    };

    let chain = Promise.resolve();
    const handle = async (line: string) => {
      let m: Json;
      try {
        m = JSON.parse(line);
      } catch {
        return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      }
      const { id, method, params } = m;
      const reply = (result: Json) => id !== undefined && send({ jsonrpc: "2.0", id, result });
      const fail = (code: number, message: string) => id !== undefined && send({ jsonrpc: "2.0", id, error: { code, message } });
      if (method === "initialize") {
        return reply({
          protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "etude", version: VERSION },
          instructions: "Etude's notes and practice collection. Find notes with notes_tree or notes_search and read them with notes_read. Change pages and files with notes_patch (find-and-replace) and notes_append, and anything Markdown can't say with notes_block. Draw on canvases with notes_canvas and work kanban boards with notes_kanban. notes_edit changes titles, icons, looks or a whole body; notes_organize moves, archives, deletes, pins and opens portals. notes_view shows what the open app has on screen and opens, splits, closes or focuses notes there. Decks, cards, practice and everything else: etude_help, then etude_run.",
        });
      }
      if (method === "ping") return reply({});
      if (method === "tools/list") return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      if (method === "tools/call") {
        try {
          const r = await call(String(params?.name), params?.arguments ?? {});
          return reply({ content: [{ type: "text", text: r.text }], isError: r.isError });
        } catch (e) {
          return reply({ content: [{ type: "text", text: `error: ${(e as Error).message}` }], isError: true });
        }
      }
      if (method === "resources/list") return reply({ resources: [] });
      if (method === "prompts/list") return reply({ prompts: [] });
      if (typeof method === "string" && method.startsWith("notifications/")) return;
      return fail(-32601, `no method ${method}`);
    };

    await new Promise<void>((done) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) chain = chain.then(async () => {
            await handle(line);
          });
        }
      });
      process.stdin.on("end", () => chain.then(() => done()));
    });
    return undefined;
  },
});
