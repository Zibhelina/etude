// Builds the image occlusion .apkg fixtures in test/fixtures/anki/ (legacy schema, stored zip):
//   io-builtin.apkg  Anki's built-in Image Occlusion notetype (23.10+)
//   io-enhanced.apkg the Image Occlusion Enhanced add-on, plus one note whose mask is missing
// node scripts/make-occlusion-fixtures.ts
import { crc32, deflateSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const out = new URL("../test/fixtures/anki/", import.meta.url);

/** A small PNG, w×h: a light ground with a few coloured blocks in a `rgb` tint. */
function png(w: number, h: number, rgb: [number, number, number]) {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const blocks: [number, number, number, number][] = [[0.1, 0.2, 0.25, 0.1], [0.5, 0.2, 0.1, 0.1], [0.65, 0.15, 0.1, 0.1], [0.1, 0.6, 0.2, 0.2], [0.45, 0.45, 0.3, 0.35]];
  const px = (x: number, y: number): number[] => {
    const fx = x / w, fy = y / h;
    const inBlock = blocks.findIndex(([bx, by, bw, bh]) => fx >= bx && fx < bx + bw && fy >= by && fy < by + bh);
    if (inBlock >= 0) return rgb.map((c) => Math.max(0, c - inBlock * 18));
    return (x + y) % 16 < 1 ? [205, 205, 210] : [240, 238, 232];
  };
  const raw = Buffer.concat(Array.from({ length: h }, (_, y) => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, (_, x) => px(x, y)).flat())])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A zip with stored (uncompressed) entries. */
function zip(entries: [string, Buffer][]) {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name, "utf8");
    const crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    locals.push(lh, n, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const CRT = 1_760_000_000; // collection creation, unix seconds
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);

interface Model { id: number; name: string; type: number; flds: string[]; tmpls: { name: string; qfmt: string; afmt: string }[]; css?: string }
interface Note { id: number; guid: string; mid: number; flds: string[]; tags?: string }
interface Card { id: number; nid: number; ord: number; review?: { ivl: number; dueIn: number; log: { daysAgo: number; ease: number }[] } }

function collection(models: Model[], notes: Note[], cards: Card[]) {
  const dir = mkdtempSync(join(tmpdir(), "etude-io-fixture-"));
  const file = join(dir, "collection.anki2");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE col (id integer primary key, crt integer, mod integer, scm integer, ver integer, dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text);
    CREATE TABLE notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld text, csum integer, flags integer, data text);
    CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer, mod integer, usn integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer, odid integer, flags integer, data text);
    CREATE TABLE revlog (id integer primary key, cid integer, usn integer, ease integer, ivl integer, lastIvl integer, factor integer, time integer, type integer);
  `);
  const mjson = Object.fromEntries(
    models.map((m) => [
      String(m.id),
      { id: m.id, name: m.name, type: m.type, css: m.css ?? ".card { font-family: arial; }", flds: m.flds.map((name, ord) => ({ name, ord })), tmpls: m.tmpls.map((t, ord) => ({ ...t, ord })) },
    ]),
  );
  const decks = { "1": { id: 1, name: "Default", dyn: 0, conf: 1, desc: "" }, "2000": { id: 2000, name: "Anatomy", dyn: 0, conf: 1, desc: "" } };
  const dconf = { "1": { id: 1, name: "Default", new: { delays: [1, 10], perDay: 20 }, lapse: { delays: [10] }, rev: { perDay: 200, maxIvl: 36500 } } };
  db.prepare("INSERT INTO col VALUES (1, ?, 0, 0, 11, 0, 0, 0, '{}', ?, ?, ?, '{}')").run(CRT, JSON.stringify(mjson), JSON.stringify(decks), JSON.stringify(dconf));
  for (const n of notes) db.prepare("INSERT INTO notes VALUES (?, ?, ?, 0, 0, ?, ?, '', 0, 0, '')").run(n.id, n.guid, n.mid, n.tags ?? "", n.flds.join("\x1f"));
  for (const c of cards) {
    const r = c.review;
    const today = Math.floor((now - CRT) / DAY);
    db.prepare("INSERT INTO cards VALUES (?, ?, 2000, ?, 0, 0, ?, ?, ?, ?, 2500, ?, 0, 0, 0, 0, 0, '')").run(
      c.id, c.nid, c.ord, r ? 2 : 0, r ? 2 : 0, r ? today + r.dueIn : c.id % 1000, r ? r.ivl : 0, r ? r.log.length : 0,
    );
    for (const [i, l] of (r?.log ?? []).entries()) db.prepare("INSERT INTO revlog VALUES (?, ?, 0, ?, 1, 0, 2500, 4200, ?)").run((now - l.daysAgo * DAY) * 1000 + i, c.id, l.ease, i ? 1 : 0);
  }
  db.close();
  const buf = readFileSync(file);
  rmSync(dir, { recursive: true, force: true });
  return buf;
}

function apkg(name: string, col: Buffer, media: [string, Buffer][]) {
  const map = Object.fromEntries(media.map(([n], i) => [String(i), n]));
  const data = zip([["collection.anki2", col], ["media", Buffer.from(JSON.stringify(map))], ...media.map(([, b], i): [string, Buffer] => [String(i), b])]);
  writeFileSync(new URL(name, out), data);
  console.log(`${name}: ${data.length} bytes`);
}

// ---- Anki's built-in Image Occlusion
{
  const IO = 1_700_000_000_001;
  const occl = [
    "{{c1::image-occlusion:rect:left=.1:top=.2:width=.25:height=.1:oi=1}}",
    "{{c2::image-occlusion:rect:left=.5:top=.2:width=.1:height=.1:oi=1}}",
    "{{c2::image-occlusion:ellipse:left=.7:top=.2:rx=.05:ry=.05:oi=1}}",
    "{{c3::image-occlusion:polygon:left=.1:top=.6:points=.1\\,.6 .3\\,.62 .2\\,.8:oi=1}}",
    "{{c4::image-occlusion:text:left=.5:top=.8:text=Heart\\: front view:scale=1:fs=.05}}",
  ].join("<br>");
  const col = collection(
    [{ id: IO, name: "Image Occlusion", type: 1, flds: ["Occlusion", "Image", "Header", "Back Extra", "Comments"], tmpls: [{ name: "Image Occlusion", qfmt: "{{#Header}}<div>{{Header}}</div>{{/Header}}{{cloze:Occlusion}}{{Image}}", afmt: "{{cloze:Occlusion}}{{Image}}{{Back Extra}}" }] }],
    [{ id: 1_700_000_100_000, guid: "ioBuiltin1", mid: IO, flds: [occl, '<img src="heart-io.png">', "Heart, <b>anterior</b> view", "Great vessels leave the base.", "From the fixture"], tags: "anatomy heart" }],
    [
      { id: 1_700_000_200_001, nid: 1_700_000_100_000, ord: 0, review: { ivl: 4, dueIn: 2, log: [{ daysAgo: 5, ease: 3 }, { daysAgo: 2, ease: 3 }] } },
      { id: 1_700_000_200_002, nid: 1_700_000_100_000, ord: 1 },
      { id: 1_700_000_200_003, nid: 1_700_000_100_000, ord: 2 },
    ],
  );
  apkg("io-builtin.apkg", col, [["heart-io.png", png(240, 160, [190, 70, 70])]]);
}

// ---- Image Occlusion Enhanced
{
  const IOE = 1_700_000_000_002;
  const flds = ["ID (hidden)", "Header", "Image", "Question Mask", "Footer", "Remarks", "Sources", "Extra 1", "Extra 2", "Answer Mask", "Original Mask"];
  const mask = `<?xml version="1.0"?>
<svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">
 <g><title>Labels</title></g>
 <g><title>Masks</title>
  <rect id="u1-ao-1" height="30" width="100" y="60" x="40" fill="#FFEBA2" stroke="#2D2D2D"/>
  <rect id="u1-ao-2" height="40" width="60" y="60" x="200" fill="#FFEBA2" stroke="#2D2D2D"/>
  <g id="u1-ao-3"><rect height="20" width="40" y="200" x="40"/><rect height="20" width="40" y="200" x="300"/></g>
 </g>
</svg>`;
  const note = (i: number, extra: Partial<Record<string, string>> = {}): Note => {
    const v: Record<string, string> = {
      "ID (hidden)": `u1-ao-${i}`,
      Header: "Skull, lateral",
      Image: '<img src="skull-ioe.png">',
      "Question Mask": `<img src="u1-ao-${i}-Q.svg">`,
      Footer: "Count the bones.",
      Remarks: "",
      Sources: "Fixture plate",
      "Extra 1": "",
      "Extra 2": "",
      "Answer Mask": `<img src="u1-ao-${i}-A.svg">`,
      "Original Mask": '<img src="u1-ao-O.svg">',
      ...extra,
    };
    return { id: 1_700_000_300_000 + i, guid: `ioeNote${i}`, mid: IOE, flds: flds.map((f) => v[f] ?? ""), tags: "anatomy skull" };
  };
  const broken = note(9, { "ID (hidden)": "u2-ao-1", "Original Mask": '<img src="missing-O.svg">' });
  broken.guid = "ioeBroken";
  const col = collection(
    [{ id: IOE, name: "Image Occlusion Enhanced", type: 0, flds, tmpls: [{ name: "IO Card", qfmt: "{{#Image}}<div>{{Header}}</div><div style=\"position:relative\">{{Image}}{{Question Mask}}</div>{{/Image}}", afmt: "{{Image}}{{Answer Mask}}<div>{{Footer}}</div>" }] }],
    [note(1), note(2), note(3), broken],
    [
      { id: 1_700_000_400_001, nid: 1_700_000_300_001, ord: 0, review: { ivl: 10, dueIn: 5, log: [{ daysAgo: 12, ease: 3 }, { daysAgo: 5, ease: 4 }] } },
      { id: 1_700_000_400_002, nid: 1_700_000_300_002, ord: 0 },
      { id: 1_700_000_400_003, nid: 1_700_000_300_003, ord: 0 },
      { id: 1_700_000_400_009, nid: 1_700_000_300_009, ord: 0 },
    ],
  );
  apkg("io-enhanced.apkg", col, [
    ["skull-ioe.png", png(240, 180, [80, 90, 170])],
    ["u1-ao-O.svg", Buffer.from(mask)],
  ]);
}
