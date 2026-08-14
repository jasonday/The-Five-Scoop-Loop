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

// Read a value from a row by trying several likely header names.
function pick(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') {
      return row[k];
    }
  }
  return undefined;
}

// "Yes" / true / checked -> true
function isYes(value) {
  if (value === true) return true;
  if (value === undefined || value === null) return false;
  return /^(yes|y|true|1)$/i.test(String(value).trim());
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

// A stable id derived from the row itself, so reprocessing the same submission
// updates its entry in place instead of creating a duplicate. Prefers an
// explicit id column, then the form Timestamp, then the Strava link.
function stableId(row) {
  const key =
    pick(row, ['Submission ID', 'ID', 'Id']) ||
    pick(row, ['Timestamp']) ||
    pick(row, ['Strava Activity Link', 'Strava', 'Activity Link']) ||
    ('row-' + row.rowIndex);
  return 'sub_' + crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 12);
}

async function processPhoto(url, id) {
  const driveId = driveIdFrom(url);
  if (!driveId) return '';
  const directUrl = `https://drive.google.com/uc?export=download&id=${driveId}`;
  const res = await fetch(directUrl);
  const buffer = await res.buffer();

  const filename = `${id}.webp`;
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

  const manifestRows = [];

  for (const row of rows) {
    const id = stableId(row);
    const runnerName = pick(row, ['Runner Name', 'Name']) || 'Anonymous';
    console.log(`Processing entry for ${runnerName}...`);

    let photoUrl = '';
    const photoField = pick(row, ['Photo Evidence', 'Photo', 'Photos', 'Finish Photo']);
    if (photoField) {
      try { photoUrl = await processPhoto(photoField, id); }
      catch (err) { console.error('Failed to process photo:', err.message); }
    }

    let routeGeoJSON = null;
    let gpxDistance;
    let gpxDuration;
    const gpxField = pick(row, ['GPX File', 'GPX', 'GPS Track']);
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

    // Fun-run status: a closed-shop reroute, or a run we cannot time (no GPX
    // timestamps and no form time). Untimed runs cannot be fairly ranked.
    const rerouted = isYes(
      pick(row, [
        'Were any of the ice cream shops closed, causing you to reroute?',
        'Rerouted',
        'Reroute',
        'Closed Shop Reroute'
      ])
    );
    const missingTime = durationMinutes == null;
    if (missingTime) {
      console.warn(`No usable time for ${runnerName}; marking as a fun run.`);
    }
    const funRun = rerouted || missingTime;
    const funRunReason = rerouted ? 'reroute' : (missingTime ? 'no-time' : '');

    const entry = {
      id,
      runnerName,
      region: slugifyRegion(pick(row, ['Region', 'Loop'])),
      date: pick(row, ['Date', 'Run Date']) || new Date().toISOString().split('T')[0],
      stravaUrl: pick(row, ['Strava Activity Link', 'Strava', 'Activity Link']) || '',
      photoUrl,
      photoAlt: pick(row, ['Photo Alt Text', 'Photo Description']) || '',
      distanceMiles,
      durationMinutes,
      rerouted,
      funRun,
      funRunReason,
      shopsVisited: (pick(row, ['Shops Visited', 'Shops']) || '')
        .toString()
        .split(/[;,\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
      notes: pick(row, ['Notes', 'Comments']) || '',
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
    const fileIds = [driveIdFrom(photoField || ''), driveIdFrom(gpxField || '')].filter(Boolean);
    manifestRows.push({ rowIndex: row.rowIndex, fileIds });
  }

  fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify(data, null, 2));

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
