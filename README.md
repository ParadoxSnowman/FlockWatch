# FlockWatch — Media & PR Monitor

A static, source-first monitor for how Flock Safety “win” stories reach the public: which agency posts them, which newsrooms run them, who owns those newsrooms, whether sponsorship is disclosed, and whether the same text turns up in more than one place.

It is a lead generator for records requests. It is not a payment detector, and nothing in it should be published as evidence of coordination without the underlying documents.

---


## Pressure & response: the timing claim

The hypothesis this view tests is that promotional output rises as removal pressure rises. Three design choices decide whether the resulting chart is evidence or decoration.

**Share, not count.** The headline series is promotional items as a share of all Flock coverage in the same period. If Flock is simply in the news more, raw promotional counts climb on their own and mean nothing. A rising *share* while opposition rises is a real observation; a rising count with a flat share is not, and the tool says so explicitly.

**A backfill guard.** Every item is stamped with `first_seen` when the collector first encounters it. Periods published before continuous monitoring began are marked backfill, excluded from every statistic, and hatched on the chart. Without this, a monitor started last month would always slope upward — search indexes surface recent material and let older material decay — and the tool would manufacture a hockey stick on day one. When no item carries `first_seen` at all, the whole dataset is treated as backfill rather than as comparable.

**Local windows, not a national aggregate.** "Promotional coverage nationally rose in a month when opposition nationally rose" is weak, because both track deployment growth. The stronger claim is local: when a specific council takes up removal, does promotional output *in that jurisdiction* rise against that jurisdiction's own prior window? Each place is its own control. Events without a complete baseline window inside the monitored period are dropped rather than estimated.

The findings panel writes plain sentences that can say **supported**, **contradicted**, **no clear effect**, or **not enough data yet** — and today it correctly says the last of these. A tool that can only confirm is not evidence, which is why `scripts/test_timeline.py` contains four refusal cases: backfill-only data must produce no trend, thin periods must produce no rate, too few events must produce no ratio, and rising volume with a constant ratio must read as flat.

### Sources feeding it

`data/sources.json` now carries five query sets. `opposition_queries` find the removal-pressure events the timeline measures against: council votes, hearings, petitions, moratoriums, cancelled contracts. `station_domains` are queried directly because Google News collapses syndicated copies into a single cluster, hiding exactly the cross-property republication the reuse detector looks for.

`agency_feeds` is empty and is the highest-value thing to fill in by hand. Facebook and Instagram block most post indexing, so the search-based agency check finds a fraction of what departments post. Most departments publish releases on a city or county `.gov` page and many expose RSS, which returns full text — the same text that would show verbatim overlap if a vendor supplied it. Add entries as:

```json
{ "agency_id": "akron-police-department-oh", "name": "Akron Police Department", "state": "OH", "url": "https://example.gov/news/rss" }
```

Ten to twenty real feeds will do more for the agency channel than any change to the code.

---

## Investigation workflow

1. **Signals** — every collected item with its channel, disclosure label, stance, and any shared passage. Filter by stance to read the critical coverage against the promotional coverage.
2. **Pressure & response** — opposition events plotted against promotional share, with backfill shaded out and a local before/after table.
3. **Newsroom watch** — outlets and their verified parent companies, each with a promotional/critical balance bar, verbatim-reuse count, and disclosed sponsorship count. Toggle **By owner** to see concentration across a parent company and how often one story ran at several of its properties.
4. **Agency watchlist** — documented Flock agencies with resolved public accounts, rotated through every 24 hours.
5. **Caseboard** — agencies ranked by a transparent lead score. Verbatim reuse now carries real weight; a shared keyword carries none.
6. **Records request** — generates a targeted state or local public-records request, including pre-publication-approval and media-metrics categories aimed squarely at the coordination question.
7. **Public records exchange** — file through MuckRock, publish through DocumentCloud, submit the public URL; on GitHub Pages this opens a moderated GitHub issue. No MuckRock or DocumentCloud credential is ever requested or stored.

Request status, dates and reference numbers stay in the browser's local storage and are never added to the public dataset.

---

## What this cannot tell you

- **Who wrote a passage first.** Capture order reflects when the monitor saw an item and what date its feed reported. It is not provenance.
- **Whether money changed hands.** Only an explicit sponsorship label is evidence of payment. Nothing else here is.
- **Whether a police post was prompted by Flock.** Only the responsive communications answer that, which is what the records builder exists for.
- **Anything about an outlet beyond this beat.** Only Flock-related coverage is collected, so these counts describe one topic, not a newsroom.
- **Complete social coverage.** Platforms do not expose full public feeds; these are indexed-public-post checks, not authenticated scraping.

Stance detection is keyword-based and approximate. Treat a stance label as a sorting aid, and correct it at the source before relying on a count.

---

## Publish on GitHub Pages

1. Create a repository and upload this project.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to `main`. The Pages workflow builds and publishes.
4. The monitor workflow runs hourly at minute 17 and commits changed data back.

No API key is required. Queries live in `data/sources.json`.

## Local development

```bash
npm install
npm test              # reuse-detection checks + headless interface smoke test
npm run reanalyze:dry # re-score stored data without writing or fetching
python3 -m http.server 8000   # then open http://localhost:8000
```

`npm test` runs three suites. `scripts/test_analysis.py` pins the behaviour that matters most — that two unrelated stories sharing a common phrase are **not** grouped, while two stories sharing a lifted paragraph are. `scripts/smoke_test.mjs` boots the real page in jsdom against the real data, walks every view, and asserts that a `javascript:` URL in the dataset can never become a live link. All three run in CI, and the reuse checks also gate the hourly data commit.

After changing a threshold in `scripts/analysis.py`, run `npm run reanalyze` to re-score stored data instead of waiting for the collector.

## Data files

| File | Contents |
| --- | --- |
| `data/live.json` | Normalized posts and stories with stance and reuse fields |
| `data/agencies.json` | Documented Flock agencies and resolved public accounts |
| `data/outlets.json` | Manually sourced outlet ownership, each with a citation |
| `data/evidence.json` | Manually reviewed evidence about the PR mechanism |
| `data/records.json` | Public MuckRock requests, DocumentCloud files, approved community links |
| `data/sources.json` | Search surfaces: promotional, accountability, and newsroom query sets |
| `data/timeline.json` | Weekly and monthly series, trend, and local event windows |
| `data/status.json` | Collector freshness, source health, stance and reuse counts |

Agency coverage is seeded from official Flock transparency portals collected by [The News & Observer's Private Eyes project](https://github.com/mcclatchy-southeast/private_eyes). A historical portal documents past use; it does not prove an agency is a current customer, and the interface flags entries older than 18 months.

## Editorial standard

Every displayed item keeps its original URL, publisher, channel, disclosure label, stance, and — where one exists — the exact overlapping text. Sponsored and company-owned content are separated from ordinary newsroom coverage. Correct or remove any item the underlying source does not support.

Before publishing a submitted document, check it for personal contact information, credentials, victim or witness information, information about minors, and anything the agency failed to redact.
