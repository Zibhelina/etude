// An example answer for watch mode: the chord in root position, from the root in the lower octave.
const pcs = key.pcs ?? [];
const out = [];
for (const pc of pcs) {
  let m = 48 + pc;
  while (out.length && m <= out[out.length - 1]) m += 12;
  out.push(m);
}
return out;
