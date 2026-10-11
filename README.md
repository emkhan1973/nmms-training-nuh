# NMMS INO Training 2026–27 — Nuh

Training-cum-Workshop for INOs under NMMS Scheme (2026–27), Department of School Education, Nuh, Haryana.
12–14 October 2026, DIET Malab (Nuh).

A static website (`site/`) backed by Google Apps Script + Google Sheets + a private Google Drive folder (`apps-script/`).

## What is in this folder

| Path | Purpose |
|---|---|
| `site/index.html` | The whole web app: Home message, Attendance with photo, Participants, Timetable, Training Materials, Pre-Test, Post-Test, Admin Dashboard and reports, Import Documents |
| `site/config.js` | Apps Script web-app URL (`GAS_URL`) |
| `site/assets/nmms-banner.jpg` | The supplied banner, an unchanged copy of `NMMS Training Workshop Nuh.jpg` (2048×768) |
| `apps-script/Code.gs` | Backend: API, server-side scoring, admin sessions, Sheets/Drive storage, one-time `setup()` |
| `apps-script/appsscript.json` | Apps Script manifest (time zone Asia/Kolkata, V8) |
| `apps-script/Private.gs` | **Not in Git.** Spreadsheet ID and the 34-participant seed list with mobile numbers |
| `.github/workflows/pages.yml` | Publishes `site/` to GitHub Pages |
| `tests/` | Backend tests (real `Code.gs` on in-memory Google mocks) and a local preview server |

## 1. Deploy the backend (Apps Script)

1. Open https://script.google.com → **New project**. Name it `NMMS INO Training 2026-27 API`.
   Use a new project. The script currently deployed for the Pre/Post Google Form results serves another page and must not be overwritten.
2. Replace the editor contents with `apps-script/Code.gs`. In Project Settings, tick “Show appsscript.json” and paste `apps-script/appsscript.json`.
3. **Project Settings → Script properties → Add**:
   - `ADMIN_PASSWORD` = the department password. Never write it in this repository or in `site/`.
   - Spreadsheet: add the file `apps-script/Private.gs` to the same Apps Script project. It holds the spreadsheet ID and the 34-participant seed list and is kept out of Git. You can instead set the script property `SPREADSHEET_ID`.
4. Select the function `setup` → **Run** → authorise. It creates the sheets, seeds the 34 participants (only if the Participants sheet is empty), creates two private Drive folders and logs a summary.
5. **Deploy → New deployment → Web app**: Execute as **Me**, Who has access **Anyone**. Copy the URL ending in `/exec`.
6. Open the URL in a browser. It should show `{"ok":true,"service":"NMMS INO Training 2026-27 API","version":2}`.

### Sheets created or used

- `Participants`: Participant ID, Name, Mobile, School / Office, Block, Updated At.
- `Attendance`: the earlier script's 13 columns are kept unchanged. Appended: Participant ID, Status, Correction, Photo File ID, Consent, Check-in ISO. Old rows are not modified and are ignored by the reports (they have no Participant ID).
- `PreTestResponses` and `PostTestResponses`, kept separate: answers, Q1–Q12 marks, Total (out of 20), Q11 response, raw answers JSON.
- `Materials`: one row per resource. The columns Topic, Kind (file/link) and Link URL are appended automatically to an existing sheet.
- `Timetable`, `AuditLog`, `Settings`.

Photos and training files are stored in Drive folders that the script creates without any sharing, so they have no public URLs. The website gets them only through the API: photos for an admin session only, materials only once published.

## 2. Publish the website (GitHub Pages)

`site/config.js` already contains the Apps Script web-app URL. The URL is public by design, because every visitor's browser calls it.

1. Push this folder to a GitHub repository on the `main` branch. `.gitignore` keeps `apps-script/Private.gs` (mobile numbers, spreadsheet ID) out of Git.
2. In the repository, open **Settings → Pages → Build and deployment** and set **Source: GitHub Actions**.
3. The workflow `.github/workflows/pages.yml` publishes only the `site/` folder. It first fails the run if `site/` contains a 10-digit mobile number or an admin password.
4. The site will be at `https://<user>.github.io/<repository>/`. All paths in `site/` are relative, so it works under that sub-path.

The free GitHub plan requires a **public** repository for Pages. The repository then shows the source code, but no participant data: participant data lives only in the Google Sheet and Drive.

## 3. Password lock (Training Materials, Dashboard, Import Documents)

- **What is locked:** Training Materials, Dashboard and Import Documents show a lock (🔒) in the menu. Opening them by menu, direct link (`#materials`, `#materials/<topic>`, `#dashboard`, `#import`) or after a refresh shows the locked page and a password dialog.
- **Where the password is checked:** The password (set as the `ADMIN_PASSWORD` script property) is checked by the Apps Script server. It is never in the website code.
- **After unlocking:** A correct password returns a random 64-character session token. It lasts 2 hours, is renewed on use and is kept in this tab's session storage only. **🔒 Lock** in the top strip ends the session on the server.
- **What the server enforces:** Every protected API call needs a valid token: materials list and files, upload, edit, delete, reports, mobile numbers, photos, corrections, timetable editing and settings. The menu lock is only the visible part.
- **Wrong passwords:** After 5 wrong passwords, unlocking is blocked for 15 minutes. Unlocks and admin actions are written to `AuditLog`.
- **Who can unlock:** Anyone who knows the password gets full admin rights, including uploads, deletions and participant mobile numbers. Share it only with the training team.

## 4. Scoring

Pre-Test and Post-Test use the same 12 questions (2+1+3+1+1+4+1+1+3+1+1+1 = 20). Scores are always computed on the server from the stored answers (`nmmsScore` in `Code.gs`), so a score sent by a browser is ignored. Checkbox questions (Q1, Q3, Q6, Q9) score only for the exact correct set. Q11 gives 1 mark for either answer. Q12 gives 1 mark for a meaningful answer of at least 5 characters (not "NA", "nil" and so on). The answer key exists only in `Code.gs`, never in the website.

## 5. Timetable

The default timetable is taken from `Revised INO workshop schedule.pdf`: 9:30 start, tea break 11:00–11:15, lunch 1:15–1:45, sessions to 4:30, then tea. Two readings to confirm: Day 2 Session 5 (3:00–4:30) has no topic in the PDF, and Day 3 has no separate time row, so it follows the main header times (Morning Assembly 9:30–10:30, Session 1 10:30–11:00). Admins can change any row in Dashboard → Timetable Editor. A saved version replaces the default for that day.

## 5b. Digital Board presentation

- **Home banner:** The Home page has a **Digital Board — Full Screen** button under the banner. It shows the same banner image across the whole screen with `object-fit: contain`, so nothing is cropped and the aspect ratio is kept. On a screen with a different shape you get black bars.
- **Materials:** Every file in Training Materials and Import Documents has **Present on Digital Board**. One shared viewer is used for all of these, so the code is not duplicated.
- **Controls:** The viewer uses the browser Fullscreen API where available and otherwise fills the window. It has floating Close, Full Screen / Exit, zoom, page and Download controls, and Escape closes it.
- **Formats:** PDF, images, video, DOCX and XLS/XLSX render inside the app. DOC, PPT and PPTX show Download / Open externally.
- **Why not an online Office viewer:** Training files are private Drive files, so Microsoft or Google online viewers (which need a public URL) are not used.

## 5c. Dashboard tables

- **KPI cards:** The cards at the top are unchanged.
- **Table 1, Attendance Details:**
  - One row per participant: S.No., ID, name, mobile, school/office, block, Day 1/2/3 columns (status, check-in time, photo button, Correct button), overall status, last check-in and Remarks (correction history).
  - Filters: search, block, school/office and status.
  - Header totals: registered, present on any day, present today and attendance %.
- **Table 2, Pre-Test & Post-Test Details:**
  - One row per participant: S.No., ID, name, mobile, school/office, block, then for each test the score, maximum (20), % and submission time, followed by Improvement and Status.
  - A test that was not taken shows "not submitted", never 0.
- **Exports:** Both tables export to CSV (opens in Excel) and .xlsx, using the rows currently shown by the filters. With no filters, that is everyone. The test .xlsx also has question-wise sheets for Pre-Test and Post-Test.
- **Designation:** It is not recorded for participants, so there is no Designation column.
- **Timetable:** The Timetable page and the Timetable Editor show only Time, Session and TBC. Presenter, Room and Notes are no longer shown. Values already stored in the `Timetable` sheet are kept and are not deleted.

## 5a. Training Materials

- **Three day cards:** Day 1, Day 2 and Day 3 cards show the date, theme, topic count and published resource count.
- **Topic folders:** Each of the 10 topics opens its own page at `#materials/<topic>`, for example `#materials/d2-omr`.
  - Day 1: `d1-guidelines`, `d1-registration`, `d1-prospectus`, `d1-practice`
  - Day 2: `d2-omr`, `d2-renewal`, `d2-nsp-school`, `d2-ino-portal`
  - Day 3: `d3-hoi-portal`, `d3-fresh`
- **Inside a folder:**
  - Everyone can search, use View / Open (full-screen viewer) and Download.
  - Admins also get Upload File (one file with title, description and a publish switch), Import Files (several files at once), Add Official Link (https only), Edit (title, description, folder, order, published), Replace File and Delete.
  - These admin actions are checked on the server.
- **Official NMMS Links:** BSEH, SCERT Haryana and NSP links open in a new tab with `rel="noopener noreferrer"`. Nothing is copied from those sites.
- **Upload formats:** PDF, DOC, DOCX, PPT, PPTX, XLS, XLSX, JPG, PNG and WebP up to 10 MB; MP4 and WebM up to 25 MB. The server checks the extension, the MIME type and the file's first bytes.
- **Viewer:**

  | Format | How it opens |
  |---|---|
  | PDF | pdf.js, with pages, zoom and full screen |
  | Images | Fitted to the screen |
  | Video | Browser player (MP4 and WebM; a format the browser cannot play shows a download fallback) |
  | DOCX | Text view |
  | XLS, XLSX | Table view |
  | DOC, PPT, PPTX | Message with Download and Open externally |

- **Storage:** Files are stored in the private Drive folder and metadata in the `Materials` sheet. Once the backend is deployed, all devices see the same materials. Nothing is kept in browser storage.

## 6. Tests

```bash
npm test
```

19 tests run the real `Code.gs` against in-memory stand-ins for SpreadsheetApp, DriveApp, CacheService, LockService and PropertiesService. They cover the 20-mark key, exact-set scoring, the 34-participant seed, no mobiles in public data, admin refusal without a session, login lock-out, one attendance per participant per day, old Attendance columns preserved, separate pre/post storage, ignoring a client-sent score, formula-injection safety, duplicate rule and CSV import, corrections with audit, timetable validation, and materials (topic folders, https-only links, video and legacy Office types, size limits, drafts hidden, admin-only changes).

Local preview with the same backend code (in-memory data only, password `local-test`). Without `apps-script/Private.gs` the participant list is empty and the tests that need it are skipped:

```bash
npm run preview
```

## Pre-session checklist (on the real deployment)

1. Admin login works; Dashboard shows 34 participants.
2. On a phone: Attendance → pick a test name → Open Camera → Capture → Confirm. Check the row in the `Attendance` sheet and the photo in the Drive folder. Then use Dashboard → Correct to mark that test record absent with the reason "test".
3. Upload one PDF in Import Documents, publish it, open it from Training Materials → View Full Screen.
4. Download the Attendance, Pre-Test and Post-Test Excel files.

## Limitations

- **Not yet verified against real Google services.** The backend has been tested only on mocks. Real Sheets/Drive behaviour, quotas and the web-app redirect must be checked with the checklist above.
- **A 4-digit password is weak.** It can be guessed in a few thousand tries. The lock-out slows this down, but it is global, so repeated wrong guesses by anyone also lock the real admin out for 15 minutes. Use a longer password if possible.
- **Participant identity is by name selection.** Anyone with the link can pick any name. The photo and the admin correction tools are the safeguards.
- **Attendance is accepted only on the matching training date** (Asia/Kolkata). Set script property `ALLOW_ANY_DAY=yes` only for testing.
- PPTX files cannot be previewed in a browser. Participants get a download button, and uploading a PDF copy is recommended. DOCX and XLSX previews show text and tables, not exact formatting.
- Excel export, PDF preview and DOCX preview load their libraries from cdnjs, so they need internet access. CSV export works without it.
- Apps Script web apps answer in about 1–3 seconds. With 34 participants this is fine. Concurrent writes are serialised with `LockService`.
- The site does not have a demo mode.
