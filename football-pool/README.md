# Pick Sheet Converter (web)

Upload the week's scanned packet, press Convert, download the pool spreadsheet.
Everything runs in the visitor's browser: the PDF never leaves their computer.
A browser port of `football_pool.py`, with the same rules and thresholds.

## Files

| File | What it is |
|---|---|
| `index.html` | The page |
| `pool-engine.js` | The reader: checkboxes, names, tiebreakers, spreadsheet |
| `example-sheet.jpg` | The example shown on the page (name and tiebreaker blurred) |
| `supabase-setup.sql` | One-time Supabase setup for the roster |

Put the first three in a `football-pool` folder on the site. The page loads its
readers (pdf.js, OpenCV.js, Tesseract.js, ExcelJS) from jsDelivr at pinned
versions: about 12 MB on first use, then cached by the browser.

## Connecting the roster (Supabase)

1. In your **Extrarandom Projects** Supabase project, open **SQL Editor**, paste
   in `supabase-setup.sql`, and run it. This creates the roster table, loads the
   current regulars, and stores the password ("Nathan") as a hash that only
   Supabase can check.
2. Open **Project Settings > API** and copy the **Project URL** and the
   **anon public** key.
3. At the top of the script in `index.html`, fill in `supabaseUrl` and
   `supabaseAnonKey`. The anon key is designed to be public; visitors can read
   the roster but can only change it through the password check.

Until this is done the page uses a built-in copy of the roster, and the
Edit regulars window is read-only.

To change the password later, run in the SQL Editor:
`update pool_settings set value = extensions.crypt('NewPassword', extensions.gen_salt('bf')) where key = 'roster_passcode_hash';`

## Tested accuracy (browser version)

| | Week 3 (45 sheets) | Week 2 (44 sheets) |
|---|---|---|
| Picks | 720/720 correct | not hand-verified |
| Names | 0 wrong (28 read, 17 flagged) | 0 wrong (25 read, 19 flagged) |
| Tiebreakers | 0 wrong (32 read, 13 flagged) | **1 wrong** (29 read, 14 flagged) |

**Known issue:** on Week 2, Jessica O's handwritten "49" was read as "14" and
not flagged. Handwritten tiebreakers can be misread consistently by the
browser's OCR; this is being fixed. Until then, double-check tiebreakers on
handwritten sheets before scoring the Monday game.
