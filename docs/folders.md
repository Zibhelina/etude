# Folders on this computer

The Notebook can open a folder from your disk and show it as it is: your Markdown notes, code, PDFs and pictures, in the same sidebar as the collection's own notes. Nothing is imported or copied. A file you change in Etude is the file on disk, and a file another program changes shows up in Etude on its own. Open the same folder in Obsidian or an editor and both see the same files.

This needs a disk to read, so it's in the desktop app and `etude serve`. The web edition and the phone apps don't have it.

## Opening a folder

Right-click **Notebook** in the sidebar → **Open a folder from this computer…**, or the start page's Import menu → **Open a folder where it is, without importing…**. Type the path or pick it (desktop app). From a terminal:

```sh
etude folder open ~/Notes
etude folder open ~/vault --name Vault --trash trash
etude folder list
etude folder close Vault        # out of the Notebook; the folder stays on disk
```

The folder becomes a row at the top level of the tree, marked with a drive. Unfolding a folder reads that folder then, so a very large one costs nothing until you look inside it. Names that start with a dot stay hidden unless you ask for them (the folder's menu, or `etude folder edit Vault --hidden show`).

## What opens how

Every file keeps the format it has. Each format has its own editor, and the editors are made to read and feel alike as far as the format allows: the same column, type, lists, to-dos, tables and code.

| File | Opens as |
|---|---|
| `.etude` | One of Etude's own kinds, in its own editor: a page (everything a page in the collection can hold), a canvas or a kanban board. **New page**, **New canvas** and **New kanban** in a folder make one. |
| `.html`, `.htm` | A web file: shown live, sandboxed, with its code a click away. **New web file** makes one. |
| `.md`, `.markdown` | The live Markdown editor: formatting drawn in place, the raw markup back where the cursor is, the file's name as its title. **Source mode** in the file's menu shows the raw text. Ctrl/⌘+B, I and E put bold, italic and code around the selection; Tab steps a list item in. |
| Code and text (`.py`, `.tex`, `.json`, `.txt`…) | The file editor, highlighted by extension. |
| `.pdf` | The PDF view. |
| Pictures, audio, video | Themselves. |
| Anything else | A page with its name, size and path. A small file with no known extension opens as text when it reads as text. |

The Markdown editor understands what a folder of notes uses on top of plain Markdown: `[[links]]` and `[[links|with another name]]`, `![[picture.png]]` and `![](picture.png)` shown in place, `==marked text==`, `%%comments%%`, `#tags`, to-dos you can tick, `> [!note]` callouts, tables drawn as tables, `$math$`, and the properties block between `---` lines at the top. A click on a link opens the file it names: a path beside the file, a path from the folder's top, or a file of that name anywhere in the folder (the nearest one first), which is how Obsidian resolves them.

## Pages as files

A page made in a folder is a file with a name, `Reading list.etude`, and the sidebar and tabs list it by that name. Inside is JSON: a format number, its kind, its own title, its icon and look, and its body: a page's document tree (the same tree `etude note show` prints for a page in the collection), a canvas's drawing in Excalidraw's element format, or a board's columns and cards. A page or board shows only the title it was given. Until it has one, the file's name shows faintly where the title goes: Tab (or → at the end) takes it, and typing anything else makes that the title. A title is saved in the file (`"title"`, left out when there is none) and never renames it; Rename in the sidebar renames the file and keeps the title. A note moved out of the collection into a folder keeps its title as its own, and a page brought back into the collection comes back under its title. Pictures put on a page or a canvas are kept in the collection's media, not beside the file. A canvas drawn from a page that is a file (`/canvas`) is made beside it.

A `.etude` file Etude can't read as a page (it isn't JSON, or a newer Etude wrote it) opens as its text and says why.

## Moving notes out of the collection

Notes that live in the collection can move into a folder on this computer and be files from then on:

```
etude folder take "Journal" Notes --dry-run   # what would go where
etude folder take "Journal" Notes --yes
```

The note and everything under it keep their tree. A page, a canvas and a kanban board each become `Name.etude`, a web file `Name.html`, a file note the file it names, a PDF note its PDF, a folder a directory; a note with notes under it gets a directory of its name and sits inside it with them, and a folder goes into a directory of its name when one is already there. Names lose what a disk won't take (`Diary 3/4` becomes `Diary 3-4`). Pins follow, and each file is as old as its note's last change.

Every file is read back and compared before anything changes in the collection. Then what linked to a note that moved follows it to the file (the other notes that moved, pages already kept as files in an open folder, and notes still in the collection), and the notes that moved go to the Archive, where they can be brought back. `--keep` copies instead and changes nothing in the collection. Notes in a shared space stay where they are.

## What saving does

- A file is only written when you change it. Opening it never touches it.
- A save replaces the file in one step (written beside it, then renamed over it), so a crash can't leave half a file. A link keeps pointing where it did.
- Windows line ends and a byte-order mark stay as the file had them.
- If another program changed the file while you were typing, the two sets of changes are put together line by line. Where both changed the same lines, both versions stay in the file.
- Files that aren't UTF-8, or are bigger than 5 MB, open read-only.

## Removing, renaming, moving

Removing a file from Etude asks first, then moves it to the folder's trash: `.trash` inside the folder unless you set another (`--trash`). Nothing is deleted, and the toast's Undo moves it back. A tab that showed it closes; when it was the only one, the start page takes its place. Renaming and dragging a file into another folder rename and move it on disk; open tabs follow.

## An order of your own

A folder lists what's in it by name, folders first. Drag a file or a folder between two others and it stays there: a disk has no order, so Etude keeps the folder's (in the collection, for this computer; nothing is written into the folder, and other programs still see it by name). From then on that folder lists in your order, a file renamed in Etude keeps its place, and anything made since goes after the rest. Each folder has its own order. **Sort by name** in the folder's menu, or `etude folder sort`, goes back to names. Notes moved in from the collection (above) keep the order they had in the Notebook.

## Finding

The start page's search and `etude folder search <words>` look in the open folders too: file names first, then the text of Markdown and text files. With [ripgrep](https://github.com/BurntSushi/ripgrep) installed the search uses it; without it the folder is walked. `node_modules`, `__pycache__` and the trash are left out.

## From the command line

Every file can be named as `Folder name/path/inside`, by its path on disk, or by its id (`fs:…`, as `folder ls` prints).

```sh
etude folder ls Vault/Journal
etude folder read Vault/Journal/Monday.md --lines
etude folder patch Vault/Journal/Monday.md --old "lake" --new "river"
etude folder new Vault/Journal Tuesday.md --content "# Tuesday"   # a name with an extension: that file
etude folder new Vault/Journal "Reading list" --md "- [ ] Dune"   # a name without one: a page, Reading list.etude
etude folder rename Vault/Journal/Tuesday.md Wednesday
etude folder move Vault/Journal/Wednesday.md Vault/Archive
etude folder move Vault/Journal Vault --index 0       # first in its folder: an order of your own
etude folder sort Vault                               # back to the order of the names
etude folder trash Vault/Archive/Wednesday.md
etude folder where ~/vault/Journal/Monday.md     # the id, for `etude view open`
```

## Syncing a folder to your other devices

A folder on this computer can travel through Etude Sync, the way a vault does in Obsidian Sync: every device that takes it has the real files, in a real folder, and each file keeps its format.

- **Start it** on the computer that has the folder: right-click the folder in the Notebook → **Sync to your other devices…** (an open folder itself, or any folder inside one). The dialog says how many files and bytes will travel. This computer becomes the folder's **home**.
- **Take it** on another computer: Notebook → **Open a folder** lists it under *Synced from your other devices*. Say where it goes there; the directory is made if it isn't there, opened in the Notebook, and filled on the next sync. Files already in it stay.
- From then on a change on any device reaches the others with the next sync (the app syncs by itself about every half minute, and within seconds of a change of its own). A file renamed or moved is renamed on the other devices, not sent again.
- **Removed on one device**: on the others it moves to the folder's trash. Nothing is deleted.
- **Changed in two places** before a sync: the home device's version keeps the name, and the other is kept beside it as `name (conflict 2026-01-05 142233).md`. Between two devices that aren't the home, the first to sync keeps the name. Both versions are on every device.
- **A lot removed at once** (more than 20 files and more than half the folder) isn't sent on: a notice says so, and **Go ahead** lets it through. A folder that isn't on disk (a drive not plugged in) is left alone and nothing is taken for removed.
- **Stop** from the same menu: on this computer only (the others go on syncing it), or for every device. Either way every device keeps the files it has.

What travels: every file the Notebook shows in the folder. What doesn't: names that start with a dot (unless the folder shows them), the folder's trash, `node_modules`, `.git`, links to other places, files over 100 MB, and empty folders. A synced folder renamed or moved in the Notebook stays synced; one renamed by another program has to be given its place again (`etude folder sync list` shows it as missing). Files are encrypted with the vault's key like everything else in Sync, and count toward the Sync plan's storage. Only the files as they are now take room there: when a file changes or goes, its old version leaves the vault with the next sync, and ending a folder's sync for every device takes all of its files out.

It needs Sync set up on the collection (Settings → Sync). Phones and the web edition have no folders to put files in: they carry on syncing and leave synced folders alone. So does any Etude from 2.4.1 on; 2.4.0 stops syncing when it meets one, until it's updated.

```
etude folder sync on Notes --dry-run      # how much would travel
etude folder sync on Notes/Journal        # start; this computer is its home
etude folder sync list                    # what's here, and what other devices carry
etude folder sync link Journal ~/Journal  # on another computer: give it a place
etude folder sync go Journal              # let held removals through
etude folder sync off Journal             # stop here; --everywhere ends it for every device
etude sync now
```

## The assistant

Ask Etude can work in the folders you opened: read, search and change the files in them with the `etude folder` commands, asking first as much as the chat's permission setting says (every change, only what's marked, or nothing). It can't open or close a folder, change what one shows, or choose which folders Sync carries: which folders are in the Notebook, and which leave this computer, stays your choice. An agent you connected yourself keeps whatever access you gave it.

## Dragging between the collection and a folder

In the Notebook's tree a page can be dragged from the collection into a folder on this computer, and a file from a folder into the collection, in either direction. The first is `etude folder take`, the second `etude folder bring`:

```
etude folder bring "Notes/Plan.etude" --dry-run
etude folder bring "Notes/Plan.etude" --into "Courses"
```

A `.etude` file becomes the page, canvas or board it holds, a Markdown or text file a file note with the same name, an `.html` file a web file, a PDF a PDF note, a directory a folder note with what's in it. Images, sound, video and other binary files have no note kind, so a move that holds one is refused before anything changes. The notes are made and read back first; then links to the files follow them, and the files go to the folder's trash (the notes that left the collection wait in the Archive). Neither direction has Undo; the originals are where those two say.

## What isn't there yet

- A folder can't be shared with other people the way a page in a shared space can. Sync carries it between your own devices only.
- A Markdown file isn't turned into a page, or a page into Markdown: each stays what it is.
