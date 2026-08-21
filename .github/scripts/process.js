/**
 * Pulls approved rows from the submissions Apps Script endpoint, downsizes each
 * photo to a 1600px WebP, simplifies each GPX track into a lightweight GeoJSON
 * line, and writes the result to _data/submissions.json for Jekyll to render.
 *
 * Env:
 *   APPS_SCRIPT_URL  Web app URL that returns approved rows as JSON and accepts
 *                    a POST of processed row indexes to mark them done.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { DOMParser } = require('@xmldom/xmldom');

// These packages ship ESM-only in recent versions, so load them via dynamic
// import (works for both ESM and CommonJS builds). Assigned in loadDeps().
let fetch, simplify, gpx;

async function loadDeps() {
  const fetchMod = await import('node-fetch');
  fetch = fetchMod.default;
  const simplifyMod = await import('@turf/simplify');
  simplify = simplifyMod.default || simplifyMod.simplify || simplifyMod;
  const togeojson = await import('@tmcw/togeojson');
  gpx = togeojson.gpx;
}

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const ROOT = path.join(__dirname, '../..');
const SUBMISSIONS_FILE = path.join(ROOT, '_data/submissions.json');
const IMAGE_DIR = path.join(ROOT, 'assets/images/submissions');
// finalize.js reads this after the commit to mark rows processed + trash files.
const MANIFEST_FILE = process.env.PROCESSED_MANIFEST || path.join(__dirname, 'processed-manifest.json');
// Committed cache of resolved embeds, keyed by URL, so we hit Iframely once
// per link ever. The key stays in the environment and never in this file.
const EMBEDS_FILE = path.join(__dirname, 'embeds-cache.json');
const IFRAMELY_KEY = process.env.IFRAMELY_KEY;

// Map whatever the form/sheet calls a region to the slug used in loops.yaml.
const REGION_SLUGS = {
  'portland': 'portland',
  'portland/south portland': 'portland',
  'portland / south portland': 'portland',
  'south portland': 'portland',
  'saco-oob': 'saco-oob',
  'saco': 'saco-oob',
  'saco/old orchard beach': 'saco-oob',
  'saco / old orchard beach': 'saco-oob',
  'old orchard beach': 'saco-oob'
};

function slugifyRegion(value) {
  if (!value) return 'portland';
  const key = String(value).trim().toLowerCase();
  return REGION_SLUGS[key] || key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Read a value from a row by trying several header names. Exact match first,
// then a case- and whitespace-insensitive fallback so small header edits still
// resolve.
function pick(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') {
      return row[k];
    }
  }
  const norm = (s) => String(s).trim().toLowerCase();
  const map = {};
  for (const rk of Object.keys(row)) map[norm(rk)] = row[rk];
  for (const k of keys) {
    const v = map[norm(k)];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}

// Normalize a date cell (ISO datetime, Date, or M/D/YYYY) to YYYY-MM-DD.
function normalizeDate(value) {
  if (!value) return '';
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = parseFloat(String(value).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? undefined : n;
}

// The sheet's ID column value, if present (the Apps Script fills it in).
function sheetId(row) {
  return String(pick(row, ['ID', 'Id', 'Submission ID']) || '').trim();
}

// The submission id used on the site (photo filenames, deep links). When the
// sheet has an ID column we use it directly (sanitized); otherwise we derive a
// stable id from the row so reprocessing updates in place instead of duplicating.
function stableId(row) {
  const explicit = sheetId(row);
  if (explicit) return explicit.replace(/[^a-zA-Z0-9_-]/g, '');
  const key =
    pick(row, ['Timestamp']) ||
    pick(row, ['Strava Activity Link', 'Strava', 'Activity Link']) ||
    ('row-' + row.rowIndex);
  return 'sub_' + crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 12);
}

// `attachment` is { id, name, mimeType, data } with data as base64, embedded
// directly in the Apps Script response (see Code.gs) -- no network fetch to
// Drive, so this works regardless of the file's sharing settings.
async function processPhotoAttachment(attachment, baseName) {
  const buffer = Buffer.from(attachment.data, 'base64');
  const filename = `${baseName}.webp`;
  await sharp(buffer)
    .rotate() // honor EXIF orientation before stripping metadata
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 72, effort: 6 })
    .toFile(path.join(IMAGE_DIR, filename));

  return `/assets/images/submissions/${filename}`;
}

// Great-circle distance between two [lon, lat] points, in miles.
function haversineMiles(a, b) {
  const R = 3958.7613; // Earth radius in miles
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Collect every LineString coordinate array from a GeoJSON feature/collection.
function collectLines(geojson) {
  const lines = [];
  const feats = geojson.type === 'FeatureCollection' ? geojson.features : [geojson];
  for (const f of feats) {
    const g = (f && f.geometry) || f;
    if (!g) continue;
    if (g.type === 'LineString') lines.push(g.coordinates);
    else if (g.type === 'MultiLineString') g.coordinates.forEach((c) => lines.push(c));
  }
  return lines;
}

// Collect all point timestamps (ms) that togeojson attaches to the track.
function collectTimes(geojson) {
  const times = [];
  const feats = geojson.type === 'FeatureCollection' ? geojson.features : [geojson];
  for (const f of feats) {
    const props = (f && f.properties) || {};
    const cp = props.coordinateProperties || {};
    const source = cp.times || props.coordTimes;
    const flat = [];
    (function walk(x) {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x) flat.push(x);
    })(source);
    for (const s of flat) {
      const t = new Date(s).getTime();
      if (!isNaN(t)) times.push(t);
    }
  }
  return times;
}

// Distance (miles) and elapsed time (minutes) derived from the raw track.
function statsFromGeojson(geojson) {
  let miles = 0;
  for (const line of collectLines(geojson)) {
    for (let i = 1; i < line.length; i++) {
      miles += haversineMiles(line[i - 1], line[i]);
    }
  }

  const times = collectTimes(geojson);
  let durationMinutes;
  if (times.length >= 2) {
    const span = Math.max(...times) - Math.min(...times);
    durationMinutes = Math.round(span / 60000);
  }

  return {
    distanceMiles: miles > 0 ? Math.round(miles * 100) / 100 : undefined,
    durationMinutes
  };
}

// `attachment` is { id, name, mimeType, data } with data as base64 (see
// processPhotoAttachment above for why -- same reasoning applies to the GPX).
async function processGpxAttachment(attachment) {
  const gpxText = Buffer.from(attachment.data, 'base64').toString('utf8');

  const xml = new DOMParser().parseFromString(gpxText, 'text/xml');
  const geojson = gpx(xml);

  // Measure from the full-resolution track before simplifying the display line.
  const stats = statsFromGeojson(geojson);

  // Lower tolerance = more detail; higher = smaller file.
  const simplified = simplify(geojson, { tolerance: 0.00005, highQuality: true });

  return {
    geojson: simplified,
    distanceMiles: stats.distanceMiles,
    durationMinutes: stats.durationMinutes
  };
}

// Every http(s) URL in a cell, de-duplicated. Users enter one per line, but may
// use commas or spaces; those are all delimiters the regex naturally stops on.
function allUrls(value) {
  const matches = String(value || '').match(/https?:\/\/[^\s,'"]+/g) || [];
  const seen = [];
  for (const raw of matches) {
    const url = raw.replace(/[),.;]+$/, ''); // trim trailing prose punctuation
    if (url && !seen.includes(url)) seen.push(url);
  }
  return seen.slice(0, 10);
}

// A thumbnail href from an Iframely response, if any.
function pickThumbnail(data) {
  const links = data.links || {};
  const groups = [links.thumbnail, links.image, links.icon].filter(Array.isArray);
  for (const group of groups) {
    if (group[0] && group[0].href) return group[0].href;
  }
  return data.thumbnail_url || null;
}

// A provider-native iframe (no Iframely key baked in) from the response, if any.
function extractIframe(data) {
  const links = data.links || {};
  const candidates = [].concat(links.player || [], links.reader || [], links.app || []);
  for (const l of candidates) {
    if (!l || !l.href) continue;
    if (/iframe\.ly|iframely/i.test(l.href)) continue; // that form needs the key
    let ratio = null;
    if (l.media) {
      if (l.media['aspect-ratio']) ratio = Number(l.media['aspect-ratio']);
      else if (l.media.width && l.media.height) ratio = l.media.width / l.media.height;
    }
    return { src: l.href, ratio: ratio && isFinite(ratio) ? Math.round(ratio * 1000) / 1000 : null };
  }
  return null;
}

function buildEmbed(url, data) {
  const meta = data.meta || {};
  const iframe = extractIframe(data);
  return {
    url,
    title: meta.title || url,
    provider: meta.site || meta.provider_name || '',
    thumbnailUrl: pickThumbnail(data),
    iframeSrc: iframe ? iframe.src : null,
    aspectRatio: iframe ? iframe.ratio : null
  };
}

// Safety net: never persist anything containing the secret key.
function scrubKey(embed) {
  if (!IFRAMELY_KEY) return embed;
  for (const k of Object.keys(embed)) {
    if (typeof embed[k] === 'string' && embed[k].includes(IFRAMELY_KEY)) embed[k] = null;
  }
  return embed;
}

// Resolve one URL to an embed, using (and filling) the cache.
async function resolveOneEmbed(url, cache) {
  if (cache[url]) return cache[url];

  let embed = { url, title: url, provider: '', thumbnailUrl: null, iframeSrc: null, aspectRatio: null };
  if (!IFRAMELY_KEY) {
    console.warn('IFRAMELY_KEY not set; storing evidence as a plain link.');
  } else {
    try {
      const api = `https://iframe.ly/api/iframely?url=${encodeURIComponent(url)}&key=${IFRAMELY_KEY}`;
      const res = await fetch(api);
      const data = await res.json();
      if (data && !data.error) embed = buildEmbed(url, data);
      else console.warn(`Iframely could not resolve ${url}:`, data && data.error);
    } catch (err) {
      console.error(`Iframely request failed for ${url}:`, err.message);
    }
  }

  embed = scrubKey(embed);
  cache[url] = embed;
  return embed;
}

// A field may hold several evidence links (different platforms).
async function resolveEmbeds(rawValue, cache) {
  const embeds = [];
  for (const url of allUrls(rawValue)) {
    embeds.push(await resolveOneEmbed(url, cache));
  }
  return embeds;
}

// Prints an aggregate summary to the Action log, and -- when running in
// GitHub Actions -- also appends a rendered markdown table to the job's Step
// Summary tab, so the outcome is visible without scrolling through per-row
// log lines.
function printSummary(summary) {
  const p = summary.photos;
  const g = summary.gpx;

  const lines = [];
  lines.push('');
  lines.push('=== Run summary ===');
  lines.push(`Entries processed: ${summary.entries.length}`);
  lines.push(
    `Photos: ${p.saved} saved / ${p.total} total` + (p.failed ? ` (${p.failed} FAILED)` : '')
  );
  lines.push(
    `GPX: ${g.saved} saved, ${g.empty} empty, ${g.failed} failed, ${g.missing} missing`
  );
  lines.push(`Evidence links resolved: ${summary.evidenceLinks}`);
  if (summary.entries.length) {
    lines.push('');
    lines.push('Per entry:');
    for (const e of summary.entries) {
      const dist = e.distanceMiles != null ? `${e.distanceMiles.toFixed(1)}mi` : 'no distance';
      const dur = e.durationMinutes != null ? `${e.durationMinutes}min` : 'no time';
      // Flag anything worth a human glance: a GPX that didn't come through
      // clean, or photos that were attempted but all failed. A row with
      // zero photos attempted (evidence-only submission) is not flagged.
      const [savedCount, attemptedCount] = e.photos.split('/').map(Number);
      const photosAllFailed = attemptedCount > 0 && savedCount === 0;
      const flag = (e.gpxStatus !== 'saved' || photosAllFailed) ? '  <-- check this one' : '';
      lines.push(
        `  - ${e.runnerName} (${e.loopType}, ${e.region}): ` +
        `photos ${e.photos}, gpx ${e.gpxStatus} (${dist}, ${dur}), ` +
        `evidence ${e.evidenceLinks}${flag}`
      );
    }
  }
  lines.push('');
  console.log(lines.join('\n'));

  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!stepSummaryPath) return;
  try {
    const md = [];
    md.push('## Scoop Loops submission run');
    md.push('');
    md.push(`- **Entries processed:** ${summary.entries.length}`);
    md.push(`- **Photos:** ${p.saved} saved / ${p.total} total${p.failed ? ` (**${p.failed} failed**)` : ''}`);
    md.push(`- **GPX:** ${g.saved} saved, ${g.empty} empty, ${g.failed} failed, ${g.missing} missing`);
    md.push(`- **Evidence links resolved:** ${summary.evidenceLinks}`);
    if (summary.entries.length) {
      md.push('');
      md.push('| Runner | Loop | Region | Photos | GPX | Distance | Time | Evidence |');
      md.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
      for (const e of summary.entries) {
        const dist = e.distanceMiles != null ? `${e.distanceMiles.toFixed(1)} mi` : '—';
        const dur = e.durationMinutes != null ? `${e.durationMinutes} min` : '—';
        md.push(
          `| ${e.runnerName} | ${e.loopType} | ${e.region} | ${e.photos} | ${e.gpxStatus} | ${dist} | ${dur} | ${e.evidenceLinks} |`
        );
      }
    }
    md.push('');
    fs.appendFileSync(stepSummaryPath, md.join('\n') + '\n');
  } catch (err) {
    // The step summary is a nice-to-have; never fail the run over it.
    console.warn('Could not write GITHUB_STEP_SUMMARY:', err.message);
  }
}

async function run() {
  if (!APPS_SCRIPT_URL) {
    console.error('Missing APPS_SCRIPT_URL environment variable.');
    process.exit(1);
  }
  if (!fs.existsSync(IMAGE_DIR)) fs.mkdirSync(IMAGE_DIR, { recursive: true });
  // Ensure this exists on disk even on a run with zero approved rows, so the
  // workflow's `git add` on this literal path never fails with "did not
  // match any files".
  if (!fs.existsSync(EMBEDS_FILE)) fs.writeFileSync(EMBEDS_FILE, '{}');

  await loadDeps();

  const res = await fetch(APPS_SCRIPT_URL);
  const bodyText = await res.text();
  let rows;
  try {
    rows = JSON.parse(bodyText);
  } catch (err) {
    // The endpoint returned HTML (usually a Google sign-in or error page),
    // which means the request did not reach the JSON endpoint anonymously.
    console.error(
      'Apps Script did not return JSON (status ' + res.status + ', ' +
      (res.headers.get('content-type') || 'unknown type') + ').\n' +
      'This almost always means the Web app is not deployed with access "Anyone",\n' +
      'the APPS_SCRIPT_URL secret is not the /exec deployment URL, or the latest\n' +
      'Code.gs was not re-deployed as a new version. Test the URL in a private\n' +
      'browser window: it should return JSON, not a login page.\n' +
      'First 200 chars of the response:\n' + bodyText.slice(0, 200)
    );
    process.exit(1);
  }

  if (!Array.isArray(rows)) {
    console.error('Expected a JSON array from Apps Script, got: ' + typeof rows);
    process.exit(1);
  }
  if (rows.length === 0) {
    console.log('No new approved submissions found.');
    return;
  }

  let data = [];
  if (fs.existsSync(SUBMISSIONS_FILE)) {
    data = JSON.parse(fs.readFileSync(SUBMISSIONS_FILE, 'utf-8'));
  }

  let embeds = {};
  if (fs.existsSync(EMBEDS_FILE)) {
    embeds = JSON.parse(fs.readFileSync(EMBEDS_FILE, 'utf-8'));
  }

  const manifestRows = [];
  // Aggregated across all rows this run, printed as a summary at the end so
  // the Action log (and the GitHub Step Summary, if available) shows at a
  // glance what was saved, what failed, and why -- without having to scroll
  // back through every row's individual log lines.
  const summary = {
    photos: { total: 0, saved: 0, failed: 0 },
    gpx: { saved: 0, empty: 0, failed: 0, missing: 0 },
    evidenceLinks: 0,
    entries: []
  };

  for (const row of rows) {
    const id = stableId(row);
    const runnerName = pick(row, ['Your name', 'Your full name', 'Runner Name', 'Name']) || 'Anonymous';
    console.log(`Processing entry for ${runnerName}...`);

    // A submission may include several photos (one per shop, plus a selfie).
    // The Apps Script embeds each file's actual bytes (base64) in the
    // response, since form-uploaded files are private to the form owner and
    // cannot be fetched anonymously -- see Code.gs for why.
    const photoAttachments = Array.isArray(row.photoAttachments) ? row.photoAttachments : [];
    if (!Array.isArray(row.photoAttachments)) {
      console.warn(
        `No photoAttachments field on the response for ${runnerName}. ` +
        `Is the Apps Script deployment up to date? See .github/apps-script/README.md.`
      );
    }

    const photos = [];
    // Only file ids that were actually embedded into this entry get queued
    // for Drive cleanup below -- a failed download/decode must never trash a
    // file whose content was never saved anywhere.
    const savedPhotoIds = [];
    for (let n = 0; n < photoAttachments.length; n++) {
      const att = photoAttachments[n];
      try {
        const src = await processPhotoAttachment(att, `${id}_${n + 1}`);
        photos.push({
          src,
          alt: `${runnerName} ice cream run photo ${n + 1} of ${photoAttachments.length}`
        });
        savedPhotoIds.push(att.id);
      } catch (err) {
        console.error(`Failed to process photo ${n + 1} (${att.name || att.id}):`, err.message);
      }
    }
    summary.photos.total += photoAttachments.length;
    summary.photos.saved += photos.length;
    summary.photos.failed += photoAttachments.length - photos.length;

    let routeGeoJSON = null;
    let gpxDistance;
    let gpxDuration;
    let savedGpxId = null;
    let gpxStatus = 'missing'; // 'saved' | 'empty' | 'failed' | 'missing'
    if (row.gpxAttachment) {
      try {
        const result = await processGpxAttachment(row.gpxAttachment);
        if (result.geojson && result.geojson.features && result.geojson.features.length > 0) {
          routeGeoJSON = result.geojson;
          gpxDistance = result.distanceMiles;
          gpxDuration = result.durationMinutes;
          savedGpxId = row.gpxAttachment.id;
          gpxStatus = 'saved';
        } else {
          console.warn(`GPX for ${runnerName} parsed but had no track points; check the uploaded file.`);
          gpxStatus = 'empty';
        }
      } catch (err) {
        console.error('Failed to process GPX:', err.message);
        gpxStatus = 'failed';
      }
    } else {
      console.warn(`No gpxAttachment field on the response for ${runnerName}.`);
    }
    summary.gpx[gpxStatus] += 1;

    // Prefer values measured from the GPX; fall back to any form-provided ones.
    const distanceMiles = gpxDistance != null
      ? gpxDistance
      : toNumber(pick(row, ['Distance', 'Distance (mi)', 'Miles']));
    const durationMinutes = gpxDuration != null
      ? gpxDuration
      : toNumber(pick(row, ['Duration (min)', 'Time (min)', 'Minutes']));

    // Which loop: the full five shops, or the shorter three-shop version (any
    // three of the region's shops). Each type has its own leaderboard.
    const loopAnswer = String(
      pick(row, ['Did you complete the Five Scoop Loop or the Three Scoop Loop?', 'Loop Type']) || ''
    ).toLowerCase();
    const loopType = /three|\b3\b/.test(loopAnswer) ? 'three' : 'five';
    if (durationMinutes == null) {
      console.warn(`No usable time for ${runnerName}; entry will sort last on its board.`);
    }

    // Optional alternate evidence links (YouTube, Instagram, TikTok, Strava, ...),
    // one or more, resolved to cached embeds.
    const evidence = await resolveEmbeds(
      pick(row, ['Alternate evidence', 'Alternate Evidence', 'Video/Post Link']),
      embeds
    );
    summary.evidenceLinks += evidence.length;

    const entry = {
      id,
      runnerName,
      region: slugifyRegion(pick(row, ['Which Scoop Loop did you complete?', 'Which Five Scoop Loop did you complete?', 'Region', 'Loop'])),
      loopType,
      date: normalizeDate(pick(row, ['Date completed', 'Date', 'Run Date'])) || new Date().toISOString().split('T')[0],
      activityUrl: pick(row, ['Link to activity', 'Strava Activity Link', 'Strava', 'Activity Link', 'Activity']) || '',
      photos,
      evidence,
      distanceMiles,
      durationMinutes,
      notes: pick(row, ['Add a short note about your run', 'Notes', 'Comments']) || '',
      routeGeoJSON
    };

    summary.entries.push({
      runnerName,
      region: entry.region,
      loopType,
      photos: `${photos.length}/${photoAttachments.length}`,
      gpxStatus,
      distanceMiles,
      durationMinutes,
      evidenceLinks: evidence.length
    });

    // Upsert by stable id: if this row was already processed, replace it in
    // place rather than appending a duplicate.
    const existingIdx = data.findIndex((e) => e.id === id);
    if (existingIdx >= 0) {
      data[existingIdx] = entry;
    } else {
      data.push(entry);
    }

    // The Drive files to trash once this entry is safely committed to GitHub.
    // Only ids that were successfully embedded above are included -- a file
    // that failed to download/decode/parse is left alone in Drive rather
    // than trashed with no copy of its content anywhere. Carry the sheet ID
    // so finalize matches the row even if rows move; rowIndex is the
    // fallback for sheets without an ID column.
    const fileIds = [...savedPhotoIds, savedGpxId].filter(Boolean);
    manifestRows.push({ id: sheetId(row), rowIndex: row.rowIndex, fileIds });
  }

  fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify(data, null, 2));
  fs.writeFileSync(EMBEDS_FILE, JSON.stringify(embeds, null, 2));

  // Write a manifest of rows to finalize AFTER the site content is committed.
  // finalize.js marks the sheet's Processed column and trashes the redundant
  // Drive files. Nothing is deleted here, so a failed commit never loses the
  // original photos or GPX.
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify({ rows: manifestRows }, null, 2));

  printSummary(summary);
  console.log(`Processed ${manifestRows.length} submission(s). Wrote finalize manifest.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
