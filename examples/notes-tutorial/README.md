# The Notes tutorial

The **Notes showcase** folder every collection gets the first time it opens Notes: Start here and nine pages (writing, links and the graph, math and callouts, look and layout, cards in a page, code you can run, pictures/video/PDFs, canvases, tabs and split view), each ending with a short Try it yourself, plus a canvas, a PDF, a Code files folder (fourier.py, cheatsheet.tex) and six cards in the deck `Notes::Notes showcase`.

It is added once per collection: `src/core/notes-tutorial.ts` sets `notes_tutorial` in the collection's `meta` table, so archiving or deleting the folder doesn't bring it back. A collection that already has a top-level folder called Notes showcase is marked and left alone. Right-click Notes → Notes tutorial, the button on an empty Notes, `POST /api/notes/tutorial` or `etude note tutorial` add a fresh copy at any time (the cards keep their ids and history).

## Files

- `tutorial.json`: the notes in tree order (parents first). Note ids are `@key` (a link's or embedded canvas's `id`, an item's `source: "note:@key"`) and media are `media:<name>`; both are filled in when the tutorial is added. `pinned` is the order on the start page. `pack` is an ordinary Etude pack with the six cards.
- `media/minimi-faces.webp`: Minimi's twelve expressions (960 px wide).
- `media/spaced-retrieval.pdf`: a four-page summary written for the tutorial, printed from `source/spaced-retrieval.html` with Chromium (A5, background graphics, document outline on, so the PDF has its chapters).

The YouTube block needs a connection to play; everything else works offline.
