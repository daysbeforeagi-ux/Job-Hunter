# Job Hunt Agent

A private local job-search dashboard. When clicked, it discovers current roles, removes duplicates, ranks each role against every résumé set, and tracks application outcomes with weekly, monthly, and yearly activity reporting.

Final submission is always manual. The service has no unattended application scheduler and does not sign into Google or employer accounts.

## Safety and privacy

- Candidate facts must come from `profile.json` or locally extracted text from the selected résumé.
- Unknown or low-confidence required answers are left for the user.
- Salary, legal declarations, assessments, CAPTCHAs, identity verification, passwords, and long essays are never answered automatically.
- Sensitive answers are proposed only when the corresponding category is explicitly configured in `voluntaryDisclosures`.
- The dashboard listens only on `127.0.0.1` and is available only on this Mac.
- API keys, candidate contact details, full résumé contents, form values, and browser credentials are not returned by the dashboard state API or written to audit logs.

Private files and folders excluded from Git include `.env`, `profile.json`, `sources.json`, `Resumes/`, `data/`, `artifacts/`, and any legacy browser state.

## Application workflow

1. Open [http://127.0.0.1:4317](http://127.0.0.1:4317).
2. Click **Find & Rank Jobs** to discover current postings and screen up to 30 jobs against all résumé sets. Screening does not run in the background.
3. Review matching roles in the pipeline and open a posting directly.
4. Choose **Applied**, **Not applied yet**, **Not interested**, **Job unavailable**, or **Application blocked** to record the outcome. Changes can be undone.
5. Use the Activity section to review added jobs and recorded outcomes for this week, month, or year.
6. Apply on the employer's site, then mark the outcome in the dashboard. Final submission remains your decision.

Outcome metrics are based on timestamped status history and job creation dates, not only each job's current status. Undoing a status removes that mark from historical outcome totals. Activity periods are calendar-to-date in the configured `JOB_AGENT_TIMEZONE` (default `Asia/Kolkata`).

## Dashboard and background screening

Double-click `dashboard.command` to open the local dashboard. If the background service is not installed, it starts the dashboard for the lifetime of that Terminal window.

The Job Agent launchers explicitly open Google Chrome instead of the macOS default browser. `open-chrome.command` defaults to the `Profile 1` directory and can be configured with `CHROME_PROFILE_DIRECTORY`. It stores no email, password, cookies, or Google credentials.

For a persistent local dashboard, double-click `install-autopilot.command`. It deploys the runtime to:

```text
~/Library/Application Support/Job Hunt Agent
```

It preserves the deployed `data/` tracker during upgrades and installs a macOS LaunchAgent that starts the dashboard at login. Discovery and ranking remain manual; the service does not run a startup or scheduled screening cycle. Re-run the installer after source or profile changes. A previously deployed extension folder is moved to Trash during upgrade; remove the old unpacked extension from Chrome's extensions page separately.

The editable screening settings are in `.env`:

```bash
AUTOMATION_ENABLED=false
AUTOMATION_INTERVAL_MINUTES=360
AUTO_DISCOVERY_LIMIT=60
AUTO_SCAN_LIMIT=30
AUTO_MINIMUM_SCORE=65
DAILY_SCAN_LIMIT=30
JOB_AGENT_TIMEZONE=Asia/Kolkata
```

The **Find & Rank Jobs** action discovers up to 60 candidates total across web search and configured ATS feeds, then screens at most 30 per run, subject to the remaining daily budget and minimum score. When both sources have results, discovery alternates between them and removes duplicate postings. The dashboard’s **Jobs screened daily** setting takes effect on the next India calendar day, preserving the current day’s count. No screening occurs until you click the button.

### Résumé sets

Use **Add résumé** in the résumé sets panel to upload a PDF of up to 10 MB. After explicit consent, the dashboard extracts its text and sends that text to Gemini once to derive target roles, skills, and a concise matching summary. The PDF stays in the local `Resumes/` directory; extracted full text is not stored in job records. The new set is considered alongside every existing set during future ranking. Uploaded-set metadata is kept in the deployed `data/resume-sets.json` manifest so it survives installer upgrades.

## Fresh setup

The project includes an isolated Node.js runtime. No system-wide Node installation is required.

```bash
cp .env.example .env
env PATH="$PWD/.runtime/bin:$PATH" npm start -- doctor
```

Set `GEMINI_API_KEY` locally in `.env`. Never paste it into chat or commit it. The model can be changed with `GEMINI_MODEL`.

Click-triggered discovery requires no manually supplied job URLs. `sources.json` is an optional supplement for public Greenhouse and Lever feeds. Manual intake remains available in the dashboard and CLI:

```bash
env PATH="$PWD/.runtime/bin:$PATH" npm start -- add --url "https://company.example/job/123"
env PATH="$PWD/.runtime/bin:$PATH" npm start -- import --file jobs.example.csv
env PATH="$PWD/.runtime/bin:$PATH" npm start -- discover
env PATH="$PWD/.runtime/bin:$PATH" npm start -- scan --limit 50
```

The legacy CLI browser flow remains supervised and requires its existing confirmation gates; the dashboard does not invoke it.

## Tracking statuses

The normal dashboard statuses are `ready`, `saved`, `submitted`, `not_interested`, `job_closed`, and `application_blocked`. Discovery may also use `queued`, `analyzing`, and `skipped`. Older records using legacy recovery statuses remain readable.

Export the tracker from the dashboard or query it locally:

```bash
env PATH="$PWD/.runtime/bin:$PATH" npm start -- queue
env PATH="$PWD/.runtime/bin:$PATH" npm start -- stats
```

## Optional Google Sheets sync

The local tracker remains authoritative. Sheets sync is one-way and rewrites the configured `Applications` tab.

```bash
GOOGLE_SHEET_ID=spreadsheet_id_from_the_url
GOOGLE_SERVICE_ACCOUNT_EMAIL=service-account@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GOOGLE_SHEET_TAB=Applications
```

Share the spreadsheet with the service-account email as an editor, restart the dashboard, then use **Sync Sheet**.

## Verification

```bash
env PATH="$PWD/.runtime/bin:$PATH" npm run typecheck
env PATH="$PWD/.runtime/bin:$PATH" npm test
```

Browser integration tests use synthetic local forms and never contact or submit to an employer website.
