# Submissions bridge (Google Apps Script)

`Code.gs` connects the Google Form responses sheet to the GitHub Actions
pipeline. The flow:

1. A runner submits the form. A new row lands in the sheet with the photo and
   GPX stored in Drive, privately owned by the form (not shared publicly).
2. You review the row and type `yes` in the **Approved** column.
3. The scheduled GitHub Action runs `process.js`, which calls this web app
   (`GET`) to fetch approved, not-yet-processed rows. On the way out, the
   script writes a random **ID** into any approved row that lacks one, and
   **reads each row's photo/GPX files itself** (as their owner) and embeds the
   raw bytes, base64-encoded, in the JSON response — see "Why files are
   embedded, not fetched" below. `process.js` decodes them, downsizes photos
   to 1600px WebP, simplifies the GPX to GeoJSON, writes
   `_data/submissions.json`, and commits everything to the repo.
4. Only after that commit succeeds, the Action runs `finalize.js`, which calls
   this web app (`POST`) to stamp the **Processed** column and move the
   original Drive photo/GPX to the trash (they now live in GitHub). Only files
   that were actually embedded in the committed entry are trashed — a photo or
   GPX that failed to process is left alone in Drive so nothing is ever lost.
   Rows are matched by **ID**, so deleting or reordering rows never marks the
   wrong one.

### Why files are embedded, not fetched

Files a Google Form uploads are private to the form's owner, not shared
"Anyone with the link." A plain HTTP fetch from GitHub Actions (which has no
Google login) gets a permission-denied page back instead of the file — this
used to fail silently: photos came back empty, and the GPX parser accepted the
error page as "valid but empty" XML, producing a track with no points and no
error. To avoid depending on any Drive sharing setting (and without making
runners' files public), this script reads the bytes itself via `DriveApp`,
since it already runs as the file owner, and hands them to `process.js`
directly in the response. A soft cap (`MAX_PAYLOAD_BYTES`, default 30 MB)
keeps any one response from growing unbounded; if a backlog of approved rows
is larger than that, the extras are simply picked up on the next scheduled
run — nothing is skipped or lost, it just spreads across a few runs. The
first row is always included even if it alone exceeds the cap, so one large
submission can never stall the queue.

## Sheet setup

Add three columns to the responses sheet, with these exact headers:

- `Approved`  — you type `yes` to release a row.
- `Processed` — left blank; the pipeline fills it with a timestamp.
- `ID`        — left blank; the script fills it with a random UUID on first
  processing. This is the stable key used for marking, cleanup, and the site's
  photo filenames and share links.

If your sheet tab is not named `Form Responses 1`, update `SHEET_NAME` at the
top of `Code.gs`. You can also rename the header constants there if you prefer
different column names.

**Deleting a row:** because the Action matches by `ID`, you can safely delete
any row (for example, a rejected or duplicate entry) without disturbing others.
To also remove a published entry from the site, delete its object from
`_data/submissions.json` (its `id` equals the sheet `ID`).

**Drive space:** trashed files leave your Drive quota after Google empties the
trash (about 30 days), or immediately if you empty it yourself. If you want the
Action to permanently delete instead of trashing, say so and it can use the
Drive advanced service (irreversible).

## Deploy

1. In the responses spreadsheet: **Extensions → Apps Script**. (This creates a
   script *bound* to the spreadsheet, which is what lets it find the sheet
   automatically. If you instead created the project from script.google.com
   directly, it's a *standalone* script — see "Standalone script" below.)
2. Paste the contents of `Code.gs` and save.
3. **Deploy → New deployment → Web app**.
   - Description: `Scoop Loops submissions`
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Copy the web app URL — use the one ending in **`/exec`** (not `/dev`; the
   dev URL always requires you to be logged in as the script owner).
5. In the GitHub repo: **Settings → Secrets and variables → Actions → New
   repository secret**, name it `APPS_SCRIPT_URL`, paste the URL.

Re-deploy (Deploy → Manage deployments → Edit → new version) whenever you change
`Code.gs`. Editing the code alone does not update the live `/exec` endpoint.

### Standalone script

If the project is standalone (no bound spreadsheet), `SpreadsheetApp.getActiveSpreadsheet()`
returns nothing and `doGet`/`doPost` fail with `Cannot read properties of null
(reading 'getSheetByName')`. Fix it once:

1. In the Apps Script editor, select `setSpreadsheetId` from the function
   dropdown next to Run.
2. Edit the call in the code (or run it from the editor's console) with your
   sheet's ID — the long string in its URL: `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.
3. Click **Run** once. Approve the permission prompt if asked.

After that, `getSheet_()` uses the stored ID automatically; you do not need to
run it again unless you change spreadsheets.

### Troubleshooting

Test the deployed `/exec` URL in a **private/incognito** browser window
(logged out):

- Returns HTML (a Google sign-in page) → deployment access is not set to
  **Anyone**, or the secret points at `/dev` instead of `/exec`. On a Google
  Workspace account, an admin policy can also block sharing web apps
  externally — check with your admin, or move the script to a personal
  Google account.
- Returns `Cannot read properties of null (reading 'getSheetByName')` → this
  is a standalone script; follow "Standalone script" above.
- Returns `Authorization is required to perform that action` → open the
  script editor and run `doGet` once manually to grant the Sheets/Drive
  permission prompts, then redeploy.
- Returns JSON (even just `[]`) → the endpoint is working correctly.

**Photos are empty and/or the GPX route is missing, but the run shows up on
the site with no error:** this was the old behavior when files were fetched
directly by URL and the fetch silently got a permission-denied page instead of
the file. It should no longer happen now that files are embedded as described
above. If it still does, check the Action's log for `No photoAttachments
field on the response for <name>` or `No gpxAttachment field` — that means
`Code.gs` was not redeployed after the update (edits to the code do not affect
the live `/exec` endpoint until you deploy a new version).

**A photo or the GPX never shows up, and the original Drive file is still
there after a run:** that means it failed to process (check the Action log for
`Failed to process photo ...` or `GPX for ... parsed but had no track
points`) and was deliberately left untrashed. Fix the underlying file (corrupt
upload, wrong file type, GPX exported without timestamps) and clear that row's
`Processed` cell to have it retried on the next run.

## Notes

- The web app URL is the only credential. Treat it as a secret; it is not stored
  in the repo.
- `Processed` is stamped only after a successful commit, so a failed run never
  deletes source files. Unfinished rows are simply picked up on the next run.
- To reprocess a row, clear its `Processed` cell (and re-add the Drive files if
  they were trashed).
