# Scoop Loops

The goal: Run a loop that visits three or five ice cream shops, eat ice cream at each one, and return to your starting shop, all in a single continuous activity.

This repo is a static [Jekyll](https://jekyllrb.com/) site (hosted on GitHub
Pages) with an interactive Leaflet map per region and two leaderboards per
region (the Five Scoop Loop and the Three Scoop Loop). Runner submissions come
in through a Google Form, are processed by a GitHub Action, and are served
statically from `_data/`.

## How it works

- **Maps and shops** are read from `_data/loops/loops.yaml`.
- **Submissions** are read from `_data/submissions.json`.
- **Runners submit** a Google Form. You approve rows in the sheet, and a
  scheduled Action converts photos to WebP, simplifies GPX tracks to GeoJSON,
  and commits the results here. See
  [.github/apps-script/README.md](.github/apps-script/README.md) for that setup.

There is no backend and no database. Everything the site shows lives in this repo.

## Project layout

```
_config.yml                 Site config (title, baseurl, leaderboard size)
index.html                  Home: region selector, map, leaderboard, fun runs, modal
rules.md                    Challenge rules (/rules/)
_layouts/                   default.html, page.html
_includes/                  header.html, footer.html
_data/loops/loops.yaml      Regions and their five shops
_data/submissions.json      Processed runner submissions (pipeline writes this)
assets/css/main.css         Styles (light + dark, accessible)
assets/js/                  app.js (Alpine), loops-map.js, submission-map.js (Leaflet)
assets/images/submissions/  Processed WebP photos (pipeline writes these)
.github/scripts/            process.js + finalize.js submission pipeline
.github/apps-script/        Google Apps Script bridge to the responses sheet
.github/workflows/          process-submissions.yml, deploy.yml
```

## Data reference

### Regions and shops (`_data/loops/loops.yaml`)

```yaml
loops:
  - name: "Portland/South Portland"   # shown on the tab
    slug: portland                    # stable id; must match submission.region
    blurb: "Short description."
    locations:
      - id: reds_dairy_freeze         # stable id, used to focus the map
        name: "Red's Dairy Freeze"
        address: "167 Cottage Rd, South Portland, ME 04106"
        hours:                        # any day keys; shown in the popup
          Monday: 3-7PM
          # ...
        seasonal: true                # adds a "Seasonal" badge
        coordinates:
          lat: 43.6347911
          lon: -70.2462231
```

### Submissions (`_data/submissions.json`)

An array of entries. The pipeline writes these, but you can hand-edit the file
to fix or remove one.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | The sheet's `ID` column value (a random UUID the Apps Script fills in). Stable key for the WebP filename and the `/#/sub/<id>` share link. **Do not change it.** |
| `runnerName` | string | Display name. |
| `region` | string | Region slug. Must match a `slug` in `loops.yaml` (`portland`, `saco-oob`). |
| `loopType` | string | `"five"` or `"three"`. Selects which of the region's two leaderboards the entry appears on. |
| `date` | string | `YYYY-MM-DD`. |
| `activityUrl` | string | Link to the recorded activity (Strava, Garmin, Nike Run Club, etc.). The provider is detected for the link label. Empty string if none. |
| `photos` | array | One to ten proof photos, each `{ "src": <root-relative WebP path>, "alt": <alt text> }`. Rendered as a gallery. |
| `evidence` | array | Zero or more alternate evidence links resolved via Iframely, each `{ url, title, provider, thumbnailUrl, iframeSrc, aspectRatio }`. Each renders as an embed, or a link card when there is no native iframe. |
| `distanceMiles` | number or null | Measured from the GPX track. Falls back to a form field if the GPX has none. |
| `durationMinutes` | number or null | Elapsed time from the GPX (first to last point). **Leaderboard rank key** (fastest first). Missing times sort last. |
| `startTime` / `endTime` | ISO 8601 string or null | The GPX track's first and last point timestamps. Kept for reference/display; everything else needed from them (the duration) is already in `durationMinutes`. |
| `notes` | string | Free text shown in the detail modal. |
| `routeGeoJSON` | GeoJSON or null | A `FeatureCollection` with a `LineString` for the route overlay. Per-point timestamps are stripped before this is stored — they aren't rendered by the map and a full track can be hundreds of entries; only `startTime`/`endTime` above are kept. |

Each region shows two leaderboards, one per `loopType` (`five` and `three`),
each ranked by `durationMinutes` ascending. There is no fun-run board; runs that
were not finished are simply not submitted (runners share those on Instagram).

## Alternate evidence embeds

Submissions may include an alternate evidence link (YouTube, Instagram, TikTok,
Strava, etc.). During processing, each new link is resolved once through the
[Iframely](https://iframely.com/) API and cached in
`.github/scripts/embeds-cache.json` (keyed by URL), so the API is never hit
again for a link already seen.

The Iframely key is read from the `IFRAMELY_KEY` environment variable (set it as
a repo Actions secret) and is used only server-side, during the Action. To keep
it secret, the cache stores only key-free presentational data (title, provider,
thumbnail, and a provider-native iframe URL when one is available); any value
that would contain the key is dropped. Links without a native iframe (many
social posts) render as a thumbnail-and-title card that opens the original.

If `IFRAMELY_KEY` is unset, evidence links still work, just as plain link cards.

## Managing entries

- **Prevent an entry from publishing:** clear the `yes` in the sheet's
  **Approved** column before the Action runs.
- **Remove a published entry:** delete its object from
  `_data/submissions.json` and commit. Optionally delete the matching
  `assets/images/submissions/<id>.webp`. Leave the sheet row's **Processed**
  cell stamped so it does not come back.
- **Republish / refresh an entry:** clear that row's **Processed** cell. The next
  run reprocesses it and updates the entry in place (entries upsert by `id`, so
  this never creates a duplicate).

## Local development

Requires Ruby and Bundler.

```bash
bundle install
bundle exec jekyll serve
```

Then open the printed URL (it includes the `baseurl` from `_config.yml`).

## Deployment

The site deploys via GitHub Actions (`.github/workflows/deploy.yml`).

1. In **Settings → Pages**, set **Source** to **GitHub Actions**.
2. Push to `main` (or let the submissions Action commit new entries). The deploy
   workflow builds and publishes automatically.

The build passes the correct base path automatically, so it works as a project
site or with a custom domain without editing `_config.yml`.
