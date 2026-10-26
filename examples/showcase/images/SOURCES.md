# Showcase images

| file | what | source | licence |
|---|---|---|---|
| `gray490-heart.webp` | Heart and lungs, front view. Henry Gray, *Anatomy of the Human Body* (20th ed., 1918), Fig. 490 | [File:Gray490.png](https://commons.wikimedia.org/wiki/File:Gray490.png), Wikimedia Commons (600×585 PNG, re-encoded as WebP q82) | Public domain (published 1918) |

`build.ts` inlines these into the pack as data URLs (`"@inline:images/<file>"` in an item field), so the Showcase works wherever the pack is imported.
