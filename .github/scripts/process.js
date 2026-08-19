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

function driveIdFrom(value) {
  const match = String(value).match(/[-\w]{25,}/);
  return match ? match[0] : null;
}

// All Drive file ids in a cell (a Forms multi-upload puts several links in one
// cell). Only treat a cell as file links if it actually contains a URL, so we
// never pull "ids" out of prose fields like alt text.
function driveIdsFrom(value) {
  const s = String(value || '');
  if (!/https?:\/\/|drive\.google/i.test(s)) return [];
  return s.match(/[-\w]{25,}/g) || [];
}

// Gather up to 10 photo file ids across any photo-ish columns, de-duplicated.
function collectPhotoIds(row) {
  const ids = [];
  for (const key of Object.keys(row)) {
    if (!/photo|image|proof|selfie|picture/i.test(key)) continue;
    if (/alt|description|caption/i.test(key)) continue; // skip text fields
    for (const fileId of driveIdsFrom(row[key])) {
      if (!ids.includes(fileId)) ids.push(fileId);
    }
  }
  return ids.slice(0, 10);
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

async function processPhotoId(driveId, baseName) {
  const directUrl = `https://drive.google.com/uc?export=download&id=${driveId}`;
  const res = await fetch(directUrl);
  const buffer = await res.buffer();

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

async function processGpx(url) {
  const driveId = driveIdFrom(url);
  if (!driveId) return { geojson: null, distanceMiles: undefined, durationMinutes: undefined };
  const directUrl = `https://drive.google.com/uc?export=download&id=${driveId}`;
  const res = await fetch(directUrl);
  const gpxText = await res.text();

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

async function run() {
  if (!APPS_SCRIPT_URL) {
    console.error('Missing APPS_SCRIPT_URL environment variable.');
    process.exit(1);
  }
  if (!fs.existsSync(IMAGE_DIR)) fs.mkdirSync(IMAGE_DIR, { recursive: true });

  await loadDeps();

  const rows = await (await fetch(APPS_SCRIPT_URL)).json();
  if (!rows || rows.length === 0) {
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

  for (const row of rows) {
    const id = stableId(row);
    const runnerName = pick(row, ['Your name', 'Your full name', 'Runner Name', 'Name']) || 'Anonymous';
    console.log(`Processing entry for ${runnerName}...`);

    // A submission may include several photos (one per shop, plus a selfie).
    const photoIds = collectPhotoIds(row);
    const photos = [];
    for (let n = 0; n < photoIds.length; n++) {
      try {
        const src = await processPhotoId(photoIds[n], `${id}_${n + 1}`);
        photos.push({
          src,
          alt: `${runnerName} ice cream run photo ${n + 1} of ${photoIds.length}`
        });
      } catch (err) {
        console.error(`Failed to process photo ${n + 1}:`, err.message);
      }
    }

    let routeGeoJSON = null;
    let gpxDistance;
    let gpxDuration;
    const gpxField = pick(row, ['GPX file', 'GPX File', 'GPX', 'GPS Track']);
    if (gpxField) {
      try {
        const result = await processGpx(gpxField);
        routeGeoJSON = result.geojson;
        gpxDistance = result.distanceMiles;
        gpxDuration = result.durationMinutes;
      } catch (err) {
        console.error('Failed to process GPX:', err.message);
      }
    }

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

    // Upsert by stable id: if this row was already processed, replace it in
    // place rather than appending a duplicate.
    const existingIdx = data.findIndex((e) => e.id === id);
    if (existingIdx >= 0) {
      data[existingIdx] = entry;
    } else {
      data.push(entry);
    }

    // The Drive files to trash once this entry is safely committed to GitHub.
    // Carry the sheet ID so finalize matches the row even if rows move; rowIndex
    // is the fallback for sheets without an ID column.
    const fileIds = [...photoIds, driveIdFrom(gpxField || '')].filter(Boolean);
    manifestRows.push({ id: sheetId(row), rowIndex: row.rowIndex, fileIds });
  }

  fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify(data, null, 2));
  fs.writeFileSync(EMBEDS_FILE, JSON.stringify(embeds, null, 2));

  // Write a manifest of rows to finalize AFTER the site content is committed.
  // finalize.js marks the sheet's Processed column and trashes the redundant
  // Drive files. Nothing is deleted here, so a failed commit never loses the
  // original photos or GPX.
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify({ rows: manifestRows }, null, 2));

  console.log(`Processed ${manifestRows.length} submission(s). Wrote finalize manifest.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
