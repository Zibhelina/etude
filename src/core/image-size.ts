// Reads an image's pixel size from its header: PNG, JPEG, GIF, WebP, BMP and SVG (width/height or viewBox).

export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 10) return null;
  // PNG: IHDR right after the signature.
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.length >= 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  // GIF87a / GIF89a.
  if (buf.toString("latin1", 0, 3) === "GIF") return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  // BMP.
  if (buf.toString("latin1", 0, 2) === "BM" && buf.length >= 26) return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
  // JPEG: walk the segments to the first start-of-frame marker.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let p = 2;
    while (p + 9 < buf.length) {
      if (buf[p] !== 0xff) { p++; continue; }
      const m = buf[p + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
      const len = buf.readUInt16BE(p + 2);
      if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: buf.readUInt16BE(p + 7), height: buf.readUInt16BE(p + 5) };
      p += 2 + len;
    }
    return null;
  }
  // WebP: VP8 (lossy), VP8L (lossless) or VP8X (extended).
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP" && buf.length >= 30) {
    const kind = buf.toString("latin1", 12, 16);
    if (kind === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    return null;
  }
  // SVG: the root element's width/height, else its viewBox.
  const head = buf.toString("utf8", 0, Math.min(buf.length, 4096));
  const svg = /<svg\b[^>]*>/i.exec(head)?.[0];
  if (svg) {
    const attr = (n: string) => new RegExp(`\\b${n}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, "i").exec(svg)?.[1];
    const w = Number(attr("width")), h = Number(attr("height"));
    if (w > 0 && h > 0) return { width: w, height: h };
    const vb = /\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(svg);
    if (vb) return { width: Number(vb[1]), height: Number(vb[2]) };
  }
  return null;
}
