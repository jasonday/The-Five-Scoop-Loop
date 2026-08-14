/**
 * Runs only after process.js has committed the new submissions + images to the
 * repo. Sends the finalize manifest to the Apps Script endpoint, which marks the
 * sheet's Processed column and trashes the now-redundant Drive photos/GPX.
 *
 * Splitting this from process.js means Drive files are only deleted once their
 * processed copies are safely in GitHub.
 *
 * Env:
 *   APPS_SCRIPT_URL      Apps Script web app URL (same one process.js reads).
 *   PROCESSED_MANIFEST   Optional manifest path (defaults next to this file).
 */

const fs = require('fs');
const path = require('path');

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const MANIFEST_FILE = process.env.PROCESSED_MANIFEST || path.join(__dirname, 'processed-manifest.json');

async function run() {
  if (!APPS_SCRIPT_URL) {
    console.error('Missing APPS_SCRIPT_URL environment variable.');
    process.exit(1);
  }
  if (!fs.existsSync(MANIFEST_FILE)) {
    console.log('No finalize manifest found. Nothing to finalize.');
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf-8'));
  const rows = (manifest && manifest.rows) || [];
  if (rows.length === 0) {
    console.log('Manifest is empty. Nothing to finalize.');
    return;
  }

  const fetch = (await import('node-fetch')).default;
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows })
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`Finalize failed (${res.status}): ${text}`);
    process.exit(1);
  }

  console.log(`Finalized ${rows.length} row(s). Apps Script response: ${text}`);

  // Clean up so a re-run does not re-post stale rows.
  fs.unlinkSync(MANIFEST_FILE);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
