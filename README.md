# Inkleaf Reader

A desktop e-book reader for Windows. It opens **EPUB, MOBI, AZW3/AZW, PDF, FB2 and CBZ** files.

**PDFs** use Mozilla's pdf.js. They get the table of contents (from the PDF's outline), search, text selection, highlights and notes, page-turn effects, **Fit page / Fit width / zoom** (Ctrl +/−, Ctrl+mouse wheel, Ctrl+0 to fit), and optional **dark pages**. Font and spacing settings don't apply to PDFs, because their layout is fixed. Scanned PDFs that contain only images (no text) can be read, but you can't search them or select text in them.

## Install
- **Installer:** `dist/Inkleaf Reader Setup 1.0.0.exe` installs the app, adds a Start-menu entry and registers it as the "Open with" app for e-book files.
- **Portable:** `dist/InkleafReader-Portable-1.0.0.exe` runs without installing.

## Run from source
```
npm install
npm start          # run the app
npm run dist       # build the installer and portable exe into dist/
```

## Features
- A library with covers, reading progress, "Continue reading", search and sorting
- **Bookshelf view:** use the toggle next to the search box to see your books as spines on wooden shelves. Each spine's color comes from the cover and its thickness from the book's length. A ribbon marks books you're reading; hover over a spine to see the cover
- **Page numbers:** printed under each page, plus "Page 45–46 of 312" in the bottom bar. These are real counts for your current window size and font, worked out in the background when you open a book or change the layout. Turn them on or off in Aa → *Page numbers*
- **Page-turn animation:** a 3D page flip with shading, or a slide, or none. Change it in Aa → *Page turn*
- Imports a whole folder of books at once, or open books by drag-and-drop
- Reopens each book where you stopped
- Shows one or two pages at a time, or a continuous scroll
- Themes: light, sepia, dark and black. You can also set the font, text size, line spacing, margins and line width
- Table of contents, search inside the book, bookmarks, and highlights in 4 colors
- **Your own notes on any passage:** select text, click **Add note**, and write as much as you want, in as many paragraphs as you want. Passages with notes get a dotted underline and a dot; click one to read the note. The **Notes** tab lists all your highlights and notes, and **Export…** saves them as a Markdown file
- Full-screen mode for reading without distractions

## Keyboard shortcuts
| Key | Action |
|---|---|
| ← → / PgUp PgDn / Space | Previous or next page (the mouse wheel also turns pages) |
| Click the left or right edge of the page | Turn the page |
| Click the middle of the page / `I` | Hide or show the toolbars |
| `T` | Table of contents |
| Ctrl+F | Search inside the book |
| Ctrl+B | Bookmark this page |
| Ctrl + / Ctrl − / Ctrl 0 | Change the text size or reset it |
| F11 or `F` | Full screen |
| Alt+← | Go back after following a link |
| Ctrl+O | Open a book |
| Esc | Close a panel, then leave full screen, then return to the library |

## Notes
- DRM-protected Kindle and Adobe books cannot be opened. Only DRM-free files work.
- Your library and settings are stored in `%APPDATA%\Inkleaf Reader\`. Book files stay where they are and are never copied or changed.
- The **Atkinson Hyperlegible** font (by the Braille Institute) is bundled in `src/renderer/fonts/` under the SIL Open Font License (`OFL.txt` is included). Choose it in Aa → *Font*.
- The book engine is [foliate-js](https://github.com/johnfactotum/foliate-js) (MIT license), stored in `vendor/foliate-js`.
