# Submissions bridge (Google Apps Script)

`Code.gs` connects the Google Form responses sheet to the GitHub Actions
pipeline. The flow:

1. A runner submits the form. A new row lands in the sheet with the photo and
   GPX stored in Drive.
2. You review the row and type `yes` in the **Approved** column.
3. The scheduled GitHub Action runs `process.js`, which calls this web app
   (`GET`) to fetch approved, not-yet-processed rows. On the way out, the script
   writes a random **ID** into any approved row that lacks one. `process.js`
   downsizes photos to 1600px WebP, simplifies the GPX to GeoJSON, writes
   `_data/submissions.json`, and commits everything to the repo.
4. Only after that commit succeeds, the Action runs `finalize.js`, which calls
   this web app (`POST`) to stamp the **Processed** column and move the original
   Drive photo/GPX to the trash (they now live in GitHub). Rows are matched by
   **ID**, so deleting or reordering rows never marks the wrong one.

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

1. In the responses spreadsheet: **Extensions → Apps Script**.
2. Paste the contents of `Code.gs` and save.
3. **Deploy → New deployment → Web app**.
   - Description: `Scoop Loops submissions`
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Copy the web app URL.
5. In the GitHub repo: **Settings → Secrets and variables → Actions → New
   repository secret**, name it `APPS_SCRIPT_URL`, paste the URL.

Re-deploy (Deploy → Manage deployments → Edit → new version) whenever you change
`Code.gs`.

## Notes

- The web app URL is the only credential. Treat it as a secret; it is not stored
  in the repo.
- `Processed` is stamped only after a successful commit, so a failed run never
  deletes source files. Unfinished rows are simply picked up on the next run.
- To reprocess a row, clear its `Processed` cell (and re-add the Drive files if
  they were trashed).
