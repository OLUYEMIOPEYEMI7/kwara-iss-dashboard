# Kwara State ISS — Field Monitoring Dashboard

A field monitoring dashboard for the **Kwara State Integrated Supportive
Supervision (ISS)** programme. It shows where supervision visits have been
conducted — State → LGA → Ward → Health facility — highlights the six
thematic performance domains and tracer KPIs from the checklist, flags
data-quality issues, and tracks corrective actions to closure.

**Live site:** enable GitHub Pages on this repo (Settings → Pages → Deploy
from branch `main`, folder `/`) and it will be served at
`https://<your-username>.github.io/<repo-name>/`.

**Data collection form:** https://ee.kobotoolbox.org/XpP4DMwV
**KoboToolbox asset:** `a3px58eSfDuyg3PLUdNBpR` on `kf.kobotoolbox.org`

## How it's put together

```
index.html               the dashboard page
assets/
  style.css               design system + layout
  app.js                  all scoring, filtering, charts and interactions
  schema.json             form structure: domains, checklist items, tracer
                          KPIs, LGA/ward/facility hierarchy — mirrors the
                          deployed XLSForm exactly
data/
  live_submissions.json   flattened real submissions (refreshed on a schedule)
  live_meta.json          when the live snapshot was last fetched
  sample_submissions.json realistic demo data for the "Sample preview" toggle
scripts/
  fetch_kobo_data.py       pulls submissions from the Kobo API and writes data/
.github/workflows/
  refresh-data.yml         scheduled job that keeps live_submissions.json current
```

All scoring (domain scores, overall weighted score, GREEN/AMBER/RED/CRITICAL
classification, critical red-flag detection) is computed **in the browser**
from raw item-level responses, using the exact same rules as the XLSForm's
`calculate` fields. There is no separate scoring logic to keep in sync — the
dashboard reads whatever the form produces.

## Why the data refreshes on a schedule instead of "live"

KoboToolbox's API does not send the CORS headers a static site would need to
call it directly from the browser, and — more importantly — your API token
must never be shipped in client-side code on a public site like GitHub
Pages, since anyone viewing the page could read it out of the network tab
and get full access to your Kobo account.

Instead:

1. The token is stored as a **GitHub Actions secret** (`KOBO_API_TOKEN`),
   which is never exposed in the repository or the built site.
2. A scheduled workflow (every 6 hours, or run manually from the Actions
   tab) fetches submissions server-side and commits the flattened result to
   `data/live_submissions.json`.
3. The dashboard just reads that JSON file like any other static asset.

## One-time setup

1. **Settings → Secrets and variables → Actions → New repository secret**
   Name: `KOBO_API_TOKEN`
   Value: your KoboToolbox API token (Account Settings → API Token on
   kf.kobotoolbox.org).
2. **Settings → Pages** → Source: `Deploy from a branch` → Branch: `main`, folder `/`.
3. **Actions tab** → "Refresh Kobo submission data" → **Run workflow** to
   pull the first snapshot immediately, rather than waiting for the next
   scheduled run.

Until the first run, or while the form has no submissions yet, the
dashboard shows an honest empty state — the layout and hierarchy are fully
visible, but the numbers read zero. Use the **Sample preview** toggle in
the top bar at any time to see the dashboard populated with representative
demo data; it is always clearly labelled and never mixed with real figures.

## Updating the form structure

If checklist items, domains, weights, or KPI fields change in the XLSForm,
regenerate `assets/schema.json` from the deployed asset's `/content`
endpoint rather than hand-editing it, so the dashboard and the form never
drift apart.
