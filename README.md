# The Five Scoop Loop

The goal: Run a loop that visits five ice cream shops, eat ice cream at each one, and return to your starting shop, all in a single continuous activity.

This repo is a static [Jekyll](https://jekyllrb.com/) site (hosted on GitHub
Pages) with an interactive Leaflet map per region, a leaderboard, and a separate
board for "fun runs." Runner submissions come in through a Google Form, are
processed by a GitHub Action, and are served statically from `_data/`.

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
| `id` | string | Stable id derived from the sheet row. **Do not change it.** Also the WebP filename. |
| `runnerName` | string | Display name. |
| `region` | string | Region slug. Must match a `slug` in `loops.yaml` (`portland`, `saco-oob`). |
| `date` | string | `YYYY-MM-DD`. |
| `stravaUrl` | string | Link to the activity. Empty string if none. |
| `photoUrl` | string | Root-relative path to the WebP proof photo. |
| `photoAlt` | string | Alt text for the photo (accessibility). |
| `distanceMiles` | number or null | Measured from the GPX track. Falls back to a form field if the GPX has none. |
| `durationMinutes` | number or null | Elapsed time from the GPX (first to last point). **Leaderboard rank key** (fastest first). Missing times sort last. |
| `rerouted` | boolean | Answer to "was a shop closed, forcing a reroute?" |
| `funRun` | boolean | `true` for a reroute, or when the run has no usable time. Sends the entry to the fun-runs table, out of the ranking. |
| `funRunReason` | string | Why it is a fun run: `"reroute"`, `"no-time"`, or `""` for eligible runs. |
| `shopsVisited` | string[] | Names of shops visited. |
| `notes` | string | Free text shown in the detail modal. |
| `routeGeoJSON` | GeoJSON or null | A `FeatureCollection` with a `LineString` for the route overlay. |

The leaderboard ranks eligible (`funRun: false`) entries in a region by
`durationMinutes`, ascending. Fun runs are listed separately and are not ranked.

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
