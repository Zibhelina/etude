# Market

The **Market** tab lists themes, decks and card types other people shared. It reads a public GitHub repository, [Zibhelina/etude-market](https://github.com/Zibhelina/etude-market), so browsing and installing need no account.

## Installing

Open an entry and press **Install**:

- a **theme** becomes one of your custom themes (**Install and use** also selects it);
- a **deck** is imported as a pack, with the custom card types it uses;
- a **card type** is imported with a few example cards. Its detail page runs the card live first, so you can try it before installing.

Installing again updates the entry in place. Items match by id, so a deck update changes content and keeps your scheduling. When the market has a newer version, the entry shows **Update**.

```sh
etude market list --kind type
etude market show typing-test
etude market install typing-test --dry-run
etude market install typing-test
etude market installed
```

## Entry previews

Entry details open as a mini product page: a title and compact facts, a swipeable gallery, the description, and a persistent action bar. Descriptions support blank-line paragraph breaks. Card types retain their live, disposable preview beneath the description.

Add optional media in the catalog repository at `media/<themes|decks|types>/<id>/`. Use lowercase slug filenames, prefixed with numbers to set the order (`01-preview.mp4`, `02-front.webp`). `etude market index` discovers up to 12 files per entry, each at most 12 MiB. Supported formats: WebP, PNG, JPG, MP4 and WebM. Place a screenshot immediately after a clip to provide its poster. Clips start paused, play inline, and pause when you swipe away or close the detail page. The first screenshot also supplies the poster, so it should show the same activity as the clip.

The index exposes `media: string[]`, also returned by `etude market show`. The app serves indexed media through `/api/market/media/<kind>/<id>/<index>`; it accepts no arbitrary file path or external URL. Entries without media retain their cover or theme miniature.

Deck details count leaf topics separately from parent folders. A collection with 20 topics and 6 grouping folders displays **20 topics**.

## Publishing

**Market → Publish**, pick the deck, card type or theme, describe it and press **Open pull request**. Etude uses the GitHub CLI on the machine running the server (`gh auth login`): it forks the market repository when you can't push to it, adds the entry file on a new branch and opens the pull request. It goes live once a maintainer merges it.

Decks are shared without review history. Built-in themes and card types can't be published; publish a copy you changed.

A card type's [assets](types.md#assets) travel inside the entry as base64, with decks and card types alike, so an entry file can be up to 32 MiB. The index lists each type's asset count and size (`summary.types[].assets: { files, bytes }`), and `etude market check` and `etude market index` validate them like the rest of the type.

Without the GitHub CLI, **Save file** downloads the entry and **Add on GitHub** opens the repository's upload page.

```sh
etude market publish "Japanese::Kana" --kind deck --description "All 92 kana, both ways" --tag japanese
etude market publish my-theme --kind theme -o my-theme.json    # just write the file
etude market publish morse --kind type --dry-run               # check it, send nothing
```

## A market of your own

The market is a folder of entry files plus an `index.json`, so any repository or folder with the same layout works:

```sh
etude settings set market.url=https://raw.githubusercontent.com/you/your-market/main market.repo=you/your-market
etude market index ./your-market        # validate every entry and write index.json
```

`etude market index` dry-run imports every deck and card type into an empty collection before writing the index; the market repository runs it on every pull request and after every merge. The entry format is in the market repository's CONTRIBUTING.md.
