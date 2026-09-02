# FlockWatch — Media & PR Monitor

A static, source-first monitor for how Flock Safety “win” stories reach the public: which agency posts them, which newsrooms run them, who owns those newsrooms, whether sponsorship is disclosed, and whether the same text turns up in more than one place.

It is a lead generator for records requests. It is not a payment detector, and nothing in it should be published as evidence of coordination without the underlying documents.

---

## What changed in v2, and why

**Grouping by shared phrase was removed.** v1 grouped stories by which watch phrase they contained, so every story using “within minutes” became one “amplification cluster.” Run against the current dataset, that method reported seven clusters; verbatim analysis of the same data reports zero. Two departments in different states can independently tell a reporter a plate hit came back within minutes. The old method turned that coincidence into a finding.

Grouping now requires **contiguous runs of eight or more identical words** (five where only a short feed snippet was captured). Independent writers covering the same event share vocabulary, not long word runs. The overlapping passage is stored and displayed next to the claim so it can be checked rather than trusted.

**Critical coverage is now collected.** v1 scored stories for promotional language and discarded anything below a threshold, so accountability reporting could never enter the dataset. Every per-outlet statistic was therefore uninterpretable: an outlet with twelve promotional stories looked identical whether or not it had also run five critical ones. The collector now deliberately searches for lawsuits, audits, privacy objections, cancelled contracts, ICE data-sharing and studies finding no crime effect, and keeps them. The **coverage balance** metric is the result, and an outlet that never publishes accountability coverage is a far more defensible observation than a phrase count.

**Syndication is separated from independent pickup.** Station groups routinely run one story across many properties. Counted naively that looks like broad independent interest. Near-identical copy under different publisher names is now labelled as syndication and rolled up under the parent company, so one story counts as one story.

Also: article body text is fetched where possible so reuse detection sees more than a 30-word RSS snippet; feed URLs are scheme-checked before they reach an `href`; derived views are cached so typing in a search box no longer rebuilds 375 agency matches per keystroke; and CSV exports are guarded against spreadsheet formula injection.

---

## Investigation workflow

1. **Signals** — every collected item with its channel, disclosure label, stance, and any shared passage. Filter by stance to read the critical coverage against the promotional coverage.
2. **Newsroom watch** — outlets and their verified parent companies, each with a promotional/critical balance bar, verbatim-reuse count, and disclosed sponsorship count. Toggle **By owner** to see concentration across a parent company and how often one story ran at several of its properties.
3. **Agency watchlist** — documented Flock agencies with resolved public accounts, rotated through every 24 hours.
4. **Caseboard** — agencies ranked by a transparent lead score. Verbatim reuse now carries real weight; a shared keyword carries none.
5. **Records request** — generates a targeted state or local public-records request, including pre-publication-approval and media-metrics categories aimed squarely at the coordination question.
6. **Public records exchange** — file through MuckRock, publish through DocumentCloud, submit the public URL; on GitHub Pages this opens a moderated GitHub issue. No MuckRock or DocumentCloud credential is ever requested or stored.

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

`npm test` runs two suites. `scripts/test_analysis.py` pins the behaviour that matters most — that two unrelated stories sharing a common phrase are **not** grouped, while two stories sharing a lifted paragraph are. `scripts/smoke_test.mjs` boots the real page in jsdom against the real data, walks every view, and asserts that a `javascript:` URL in the dataset can never become a live link. Both run in CI, and the reuse checks also gate the hourly data commit.

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
| `data/status.json` | Collector freshness, source health, stance and reuse counts |

Agency coverage is seeded from official Flock transparency portals collected by [The News & Observer's Private Eyes project](https://github.com/mcclatchy-southeast/private_eyes). A historical portal documents past use; it does not prove an agency is a current customer, and the interface flags entries older than 18 months.

## Editorial standard

Every displayed item keeps its original URL, publisher, channel, disclosure label, stance, and — where one exists — the exact overlapping text. Sponsored and company-owned content are separated from ordinary newsroom coverage. Correct or remove any item the underlying source does not support.

Before publishing a submitted document, check it for personal contact information, credentials, victim or witness information, information about minors, and anything the agency failed to redact.
