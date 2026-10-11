/**
 * NMMS INO Training 2026-27 — backend v2
 * Department of School Education, Nuh, Haryana
 *
 * Extends the earlier "NMMS Training Saathi Attendance backup" Apps Script:
 *  - same spreadsheet and the same `Attendance` sheet (existing columns are kept,
 *    new columns are appended at the end; old rows are never modified),
 *  - photos still go to Google Drive, but into a private folder (no sharing is set).
 *
 * Deploy this as a NEW Apps Script project (script.google.com > New project). Do not paste it over the
 * currently deployed NMMS Pre/Post results script — that deployment serves another page.
 * Deploy > New deployment > Web app — Execute as: Me, Who has access: Anyone.
 * Script properties (Project Settings > Script properties):
 *   ADMIN_PASSWORD   (required)  admin password, never stored in this file or the website
 *   SPREADSHEET_ID   (optional)  overrides PRIVATE_SPREADSHEET_ID from Private.gs
 *   PHOTO_FOLDER_ID, MATERIALS_FOLDER_ID  (created automatically by setup())
 *   ALLOW_ANY_DAY    (optional)  "yes" lets participants mark any training day (testing only)
 * Run setup() once from the editor after pasting this file.
 */

const TZ = 'Asia/Kolkata';
const DAYS = { 1: '2026-10-12', 2: '2026-10-13', 3: '2026-10-14' };
const TOKEN_TTL = 7200;          // admin session: 2 hours, renewed on every admin call
const MAX_FAILS = 5;             // failed logins before lock-out
const LOCK_SECONDS = 900;        // lock-out window: 15 minutes
const MAX_PHOTO_CHARS = 400000;  // ~300 KB image as a data URL
const MAX_FILE_BYTES = 10 * 1024 * 1024;   // documents and images
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;  // MP4 / WebM

const FILE_TYPES = {
  pdf:  { mime: 'application/pdf', magic: '%PDF' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: 'PK' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', magic: 'PK' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: 'PK' },
  jpg:  { mime: 'image/jpeg', magic: 'JPG' },
  jpeg: { mime: 'image/jpeg', magic: 'JPG' },
  png:  { mime: 'image/png', magic: 'PNG' },
  webp: { mime: 'image/webp', magic: 'RIFF' },
  doc:  { mime: 'application/msword', magic: 'OLE' },
  ppt:  { mime: 'application/vnd.ms-powerpoint', magic: 'OLE' },
  xls:  { mime: 'application/vnd.ms-excel', magic: 'OLE' },
  mp4:  { mime: 'video/mp4', magic: 'FTYP', video: true },
  webm: { mime: 'video/webm', magic: 'EBML', video: true }
};
/* Training Materials topic folders (ids are shared with the website). */
const TOPICS = {
  'd1-guidelines': 1, 'd1-registration': 1, 'd1-prospectus': 1, 'd1-practice': 1,
  'd2-omr': 2, 'd2-renewal': 2, 'd2-nsp-school': 2, 'd2-ino-portal': 2,
  'd3-hoi-portal': 3, 'd3-fresh': 3
};
const CATEGORIES = ['Presentation', 'Guidelines', 'Circular / Letter', 'Form / Template', 'Practice Sheet', 'Other'];

/* Answer key — server side only. Option indexes are 0-based. Total = 20 marks. */
const ANSWER_KEY = [
  { t: 'multi',  a: [0, 2],          m: 2, n: 4 }, // Q1  BSEH + SCERT website
  { t: 'single', a: 1,               m: 1, n: 5 }, // Q2  Class 9th
  { t: 'multi',  a: [2, 3, 4],       m: 3, n: 5 }, // Q3  options 3, 4, 5
  { t: 'single', a: 0,               m: 1, n: 5 }, // Q4
  { t: 'single', a: 1,               m: 1, n: 4 }, // Q5
  { t: 'multi',  a: [0, 1, 2, 3, 4], m: 4, n: 5 }, // Q6  all five
  { t: 'single', a: 0,               m: 1, n: 2 }, // Q7
  { t: 'single', a: 0,               m: 1, n: 2 }, // Q8
  { t: 'multi',  a: [0, 1, 2],       m: 3, n: 4 }, // Q9
  { t: 'single', a: 1,               m: 1, n: 3 }, // Q10
  { t: 'any',                        m: 1, n: 2 }, // Q11 self-assessment: any answer
  { t: 'text',                       m: 1 }        // Q12 meaningful text
];

/* The participant seed list (with mobile numbers) and the spreadsheet ID live in Private.gs,
   which is kept out of the public repository. Apps Script shares one global scope across files. */
function seedParticipants_() { return typeof SEED_PARTICIPANTS !== 'undefined' ? SEED_PARTICIPANTS : []; }

const Q_HEADERS = [];
for (let i = 1; i <= 12; i++) Q_HEADERS.push('Q' + i + ' Answer');
for (let i = 1; i <= 12; i++) Q_HEADERS.push('Q' + i + ' Marks');
const TEST_HEADERS = ['Participant ID', 'Name', 'School / Office', 'Block', 'Submitted At']
  .concat(Q_HEADERS, ['Total (out of 20)', 'Q11 Response', 'Answers JSON']);

const HEADERS = {
  Participants: ['Participant ID', 'Name', 'Mobile', 'School / Office', 'Block', 'Updated At'],
  // First 13 columns are the earlier script's schema, unchanged.
  Attendance: ['Record Key', 'District', 'Officer Name', 'Mobile', 'School / Office', 'Block', 'Designation',
    'Subject', 'Training Day', 'Attendance Date', 'Timestamp', 'Demo', 'Photo Backup Status',
    'Participant ID', 'Status', 'Correction', 'Photo File ID', 'Consent', 'Check-in ISO'],
  PreTestResponses: TEST_HEADERS,
  PostTestResponses: TEST_HEADERS,
  Timetable: ['Day', 'Order', 'Start', 'End', 'Topic', 'Presenter', 'Room', 'Notes', 'Time TBC'],
  Materials: ['Material ID', 'Title', 'Description', 'Day', 'Category', 'Order', 'Published', 'File ID',
    'File Name', 'MIME', 'Size', 'Uploaded At', 'Topic', 'Kind', 'Link URL'],
  AuditLog: ['Time', 'Action', 'Target', 'Details'],
  Settings: ['Key', 'Value']
};
const SETTING_DEFAULTS = { preFormUrl: '', postFormUrl: '', preOpen: 'yes', postOpen: 'yes' };

/*SCORING-START*/
function nmmsMeaningful(s) {
  s = String(s == null ? '' : s).trim();
  if (s.length < 5) return false;
  if (/^(na|n\/a|no|nil|none|nothing|not known|-+|\.+)$/i.test(s)) return false;
  return /[A-Za-z0-9ऀ-ॿ]/.test(s);
}
function nmmsScore(answers, key) {
  answers = answers || {};
  const marks = [];
  for (let i = 0; i < key.length; i++) {
    const k = key[i], a = answers['q' + (i + 1)];
    let m = 0;
    if (k.t === 'multi') {
      let sel = Array.isArray(a) ? a.map(Number).filter(function (x) { return isFinite(x); }) : [];
      sel = sel.filter(function (x, j) { return sel.indexOf(x) === j; }).sort(function (x, y) { return x - y; });
      const want = k.a.slice().sort(function (x, y) { return x - y; });
      if (sel.length === want.length && sel.every(function (x, j) { return x === want[j]; })) m = k.m;
    } else if (k.t === 'single') {
      if (a !== null && a !== undefined && a !== '' && !Array.isArray(a) && Number(a) === k.a) m = k.m;
    } else if (k.t === 'any') {
      if (a !== null && a !== undefined && a !== '' && !Array.isArray(a) && Number(a) >= 0 && Number(a) < k.n) m = k.m;
    } else if (k.t === 'text') {
      if (nmmsMeaningful(a)) m = k.m;
    }
    marks.push(m);
  }
  return { marks: marks, total: marks.reduce(function (s, x) { return s + x; }, 0) };
}
/*SCORING-END*/

/* ---------------- HTTP entry points ---------------- */

function doGet() {
  return json_({ ok: true, service: 'NMMS INO Training 2026-27 API', version: 2 });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, code: 'bad_request', error: 'Invalid request body' });
  }
  try {
    const h = HANDLERS[req.action];
    if (!h) throw err_('bad_request', 'Unknown action');
    if (h.admin) requireAdmin_(req.token);
    const out = h.fn(req) || {};
    out.ok = true;
    return json_(out);
  } catch (err) {
    const code = err && err.code ? err.code : 'server_error';
    if (code === 'server_error') console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, code: code, error: code === 'server_error' ? 'Server error: ' + String(err && err.message || err).slice(0, 200) : err.message });
  }
}

const HANDLERS = {
  public:             { fn: publicData_ },
  attend:             { fn: attend_ },
  submitTest:         { fn: submitTest_ },
  material:           { fn: material_ },
  login:              { fn: login_ },
  logout:             { fn: logout_ },
  admin:              { fn: adminData_, admin: true },
  photo:              { fn: photo_, admin: true },
  saveParticipant:    { fn: saveParticipant_, admin: true },
  importParticipants: { fn: importParticipants_, admin: true },
  correctAttendance:  { fn: correctAttendance_, admin: true },
  saveTimetable:      { fn: saveTimetable_, admin: true },
  uploadMaterial:     { fn: uploadMaterial_, admin: true },
  updateMaterial:     { fn: updateMaterial_, admin: true },
  addLink:            { fn: addLink_, admin: true },
  deleteMaterial:     { fn: deleteMaterial_, admin: true },
  saveSettings:       { fn: saveSettings_, admin: true }
};

/* ---------------- Public handlers ---------------- */

function publicData_() {
  const parts = read_('Participants').rows.map(function (r) {
    return { id: s_(r['Participant ID']), name: s_(r['Name']), school: s_(r['School / Office']), block: s_(r['Block']) };
  }).filter(function (p) { return p.id; });
  const marks = read_('Attendance').rows.filter(function (r) { return s_(r['Participant ID']); }).map(function (r) {
    return { pid: s_(r['Participant ID']), day: dayNum_(r), date: s_(r['Attendance Date']), at: s_(r['Check-in ISO']), status: s_(r['Status']) || 'present' };
  });
  const testmarks = [];
  ['pre', 'post'].forEach(function (type) {
    read_(testSheet_(type)).rows.forEach(function (r) {
      if (s_(r['Participant ID'])) testmarks.push({ pid: s_(r['Participant ID']), type: type, at: s_(r['Submitted At']) });
    });
  });
  return {
    participants: parts, marks: marks, testmarks: testmarks,
    timetable: timetable_(),
    // Training Materials are a locked module: listed only in adminData_ and served only with an admin session.
    settings: settings_(),
    today: today_()
  };
}

function attend_(req) {
  const pid = s_(req.pid), day = Number(req.day);
  if (!DAYS[day]) throw err_('bad_request', 'Invalid training day.');
  if (prop_('ALLOW_ANY_DAY') !== 'yes' && DAYS[day] !== today_()) {
    throw err_('closed', 'Day ' + day + ' attendance can be marked only on ' + DAYS[day] + '.');
  }
  if (req.consent !== true) throw err_('bad_request', 'Photo consent is required.');
  const photo = String(req.photo || '');
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(photo);
  if (!m || photo.length > MAX_PHOTO_CHARS) throw err_('bad_request', 'A valid photo (JPEG/PNG/WebP, max 300 KB) is required.');
  return withLock_(function () {
    const p = participant_(pid);
    if (!p) throw err_('bad_request', 'Participant not found in the approved list.');
    const key = pid + '_' + DAYS[day];
    const t = read_('Attendance');
    const ex = t.rows.filter(function (r) { return s_(r['Record Key']) === key; })[0];
    if (ex) return { duplicate: true, at: s_(ex['Check-in ISO']), status: s_(ex['Status']) || 'present' };
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), 'image/' + m[1], key + '.' + ext);
    const file = folder_('PHOTO_FOLDER_ID', 'NMMS INO Training 2026-27 - Attendance Photos (private)').createFile(blob);
    const now = now_();
    append_('Attendance', {
      'Record Key': key, 'District': 'NUH', 'Officer Name': p.name, 'Mobile': p.mobile,
      'School / Office': p.school, 'Block': p.block, 'Designation': 'INO', 'Subject': '',
      'Training Day': 'Day ' + day, 'Attendance Date': DAYS[day],
      'Timestamp': Utilities.formatDate(now, TZ, 'dd-MM-yyyy HH:mm:ss'), 'Demo': 'NO',
      'Photo Backup Status': 'Stored privately in Drive', 'Participant ID': pid, 'Status': 'present',
      'Correction': '', 'Photo File ID': file.getId(), 'Consent': 'YES', 'Check-in ISO': now.toISOString()
    });
    return { duplicate: false, at: now.toISOString() };
  });
}

function submitTest_(req) {
  const type = req.type;
  if (type !== 'pre' && type !== 'post') throw err_('bad_request', 'Invalid test type.');
  if (settings_()[type + 'Open'] === 'no') throw err_('closed', (type === 'pre' ? 'Pre' : 'Post') + '-Test is closed.');
  const answers = cleanAnswers_(req.answers);
  const pid = s_(req.pid);
  return withLock_(function () {
    const p = participant_(pid);
    if (!p) throw err_('bad_request', 'Participant not found in the approved list.');
    const name = testSheet_(type);
    if (read_(name).rows.some(function (r) { return s_(r['Participant ID']) === pid; })) return { duplicate: true };
    const sc = nmmsScore(answers, ANSWER_KEY); // never trust a client-sent score
    const row = {
      'Participant ID': pid, 'Name': p.name, 'School / Office': p.school, 'Block': p.block,
      'Submitted At': now_().toISOString(), 'Total (out of 20)': sc.total,
      'Q11 Response': answers.q11 === 0 ? 'Yes' : answers.q11 === 1 ? 'No' : '',
      'Answers JSON': JSON.stringify(answers)
    };
    for (let i = 1; i <= 12; i++) {
      row['Q' + i + ' Answer'] = answerText_(answers['q' + i], ANSWER_KEY[i - 1]);
      row['Q' + i + ' Marks'] = sc.marks[i - 1];
    }
    append_(name, row);
    return { duplicate: false };
  });
}

function material_(req) {
  requireAdmin_(req.token); // Training Materials are locked behind the admin password
  const m = materials_().filter(function (x) { return x.id === s_(req.id); })[0];
  if (!m) throw err_('not_found', 'Material not found.');
  if (m.kind === 'link' || !m.fileId) throw err_('bad_request', 'This resource is a link, not a file.');
  const blob = DriveApp.getFileById(m.fileId).getBlob();
  return { name: m.name, mime: m.mime, data: Utilities.base64Encode(blob.getBytes()) };
}

/* ---------------- Admin session ---------------- */

function login_(req) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('login_fails') || 0);
  if (fails >= MAX_FAILS) throw err_('locked', 'Too many failed attempts. Try again after 15 minutes.');
  const pw = prop_('ADMIN_PASSWORD');
  if (!pw) throw err_('not_configured', 'Admin password is not configured on the server (script property ADMIN_PASSWORD).');
  if (!safeEq_(String(req.password || ''), pw)) {
    cache.put('login_fails', String(fails + 1), LOCK_SECONDS);
    Utilities.sleep(700);
    audit_('login_failed', 'admin', 'attempt ' + (fails + 1));
    throw err_('auth', 'Incorrect password.');
  }
  cache.remove('login_fails');
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  cache.put('adm_' + token, '1', TOKEN_TTL);
  audit_('login', 'admin', '');
  return { token: token, expiresIn: TOKEN_TTL };
}

function logout_(req) {
  if (req.token) CacheService.getScriptCache().remove('adm_' + req.token);
  return {};
}

function requireAdmin_(token) {
  const c = CacheService.getScriptCache();
  if (!token || !/^[a-f0-9]{64}$/i.test(String(token)) || !c.get('adm_' + token)) {
    throw err_('auth', 'Admin session expired. Please log in again.');
  }
  c.put('adm_' + token, '1', TOKEN_TTL);
}

/* ---------------- Admin handlers ---------------- */

function adminData_() {
  const contacts = {};
  read_('Participants').rows.forEach(function (r) { if (s_(r['Participant ID'])) contacts[s_(r['Participant ID'])] = s_(r['Mobile']); });
  const attendance = read_('Attendance').rows.filter(function (r) { return s_(r['Participant ID']); }).map(function (r) {
    return {
      key: s_(r['Record Key']), pid: s_(r['Participant ID']), day: dayNum_(r), date: s_(r['Attendance Date']),
      at: s_(r['Check-in ISO']), status: s_(r['Status']) || 'present', correction: s_(r['Correction']),
      hasPhoto: !!s_(r['Photo File ID'])
    };
  });
  const tests = {};
  ['pre', 'post'].forEach(function (type) {
    tests[type] = read_(testSheet_(type)).rows.filter(function (r) { return s_(r['Participant ID']); }).map(function (r) {
      let answers = {};
      try { answers = JSON.parse(s_(r['Answers JSON']) || '{}'); } catch (e) { answers = {}; }
      const sc = nmmsScore(answers, ANSWER_KEY);
      return { pid: s_(r['Participant ID']), at: s_(r['Submitted At']), answers: answers, marks: sc.marks, total: sc.total };
    });
  });
  const audit = read_('AuditLog').rows.slice(-300).reverse().map(function (r) {
    return { at: s_(r['Time']), action: s_(r['Action']), target: s_(r['Target']), details: s_(r['Details']) };
  });
  return { contacts: contacts, attendance: attendance, pre: tests.pre, post: tests.post, audit: audit, materials: materials_(), settings: settings_() };
}

function photo_(req) {
  const key = s_(req.key);
  const r = read_('Attendance').rows.filter(function (x) { return s_(x['Record Key']) === key; })[0];
  if (!r || !s_(r['Photo File ID'])) throw err_('not_found', 'No photo stored for this record.');
  const blob = DriveApp.getFileById(s_(r['Photo File ID'])).getBlob();
  return { photo: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

function saveParticipant_(req) {
  return withLock_(function () {
    const res = upsertParticipant_(req.participant || {}, false);
    audit_(res.created ? 'participant_add' : 'participant_edit', res.id, res.name);
    return { id: res.id };
  });
}

function importParticipants_(req) {
  const rows = Array.isArray(req.rows) ? req.rows : [];
  if (!rows.length || rows.length > 500) throw err_('bad_request', 'Provide 1–500 rows.');
  return withLock_(function () {
    let created = 0, updated = 0;
    const errors = [];
    rows.forEach(function (r, i) {
      try {
        const res = upsertParticipant_(r, true);
        if (res.created) created++; else updated++;
      } catch (e) { errors.push('Row ' + (i + 2) + ': ' + e.message); }
    });
    audit_('participant_import', 'csv', created + ' created, ' + updated + ' updated, ' + errors.length + ' errors');
    return { created: created, updated: updated, errors: errors };
  });
}

function correctAttendance_(req) {
  const pid = s_(req.pid), day = Number(req.day), status = req.status, reason = s_(req.reason).trim();
  if (!DAYS[day]) throw err_('bad_request', 'Invalid training day.');
  if (status !== 'present' && status !== 'absent') throw err_('bad_request', 'Status must be present or absent.');
  if (reason.length < 3) throw err_('bad_request', 'Please give a reason for the correction.');
  return withLock_(function () {
    const p = participant_(pid);
    if (!p) throw err_('bad_request', 'Participant not found.');
    const key = pid + '_' + DAYS[day];
    const t = read_('Attendance');
    const ex = t.rows.filter(function (r) { return s_(r['Record Key']) === key; })[0];
    const note = Utilities.formatDate(now_(), TZ, 'dd-MM-yyyy HH:mm') + ': ' + status + ' — ' + reason.slice(0, 300);
    if (ex) {
      update_(t, ex._row, { 'Status': status, 'Correction': (s_(ex['Correction']) ? s_(ex['Correction']) + ' | ' : '') + note });
    } else {
      append_('Attendance', {
        'Record Key': key, 'District': 'NUH', 'Officer Name': p.name, 'Mobile': p.mobile,
        'School / Office': p.school, 'Block': p.block, 'Designation': 'INO', 'Training Day': 'Day ' + day,
        'Attendance Date': DAYS[day], 'Timestamp': Utilities.formatDate(now_(), TZ, 'dd-MM-yyyy HH:mm:ss'),
        'Demo': 'NO', 'Photo Backup Status': 'No photo (admin correction)', 'Participant ID': pid,
        'Status': status, 'Correction': note, 'Consent': '', 'Check-in ISO': status === 'present' ? now_().toISOString() : ''
      });
    }
    audit_('attendance_correction', key, note);
    return {};
  });
}

function saveTimetable_(req) {
  const day = Number(req.day);
  if (!DAYS[day]) throw err_('bad_request', 'Invalid training day.');
  const rows = Array.isArray(req.rows) ? req.rows : [];
  if (rows.length > 40) throw err_('bad_request', 'Too many sessions.');
  const clean = rows.map(function (r, i) {
    const start = s_(r.start).trim(), end = s_(r.end).trim();
    [start, end].forEach(function (x) { if (x && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(x)) throw err_('bad_request', 'Times must be HH:MM (row ' + (i + 1) + ').'); });
    if (!s_(r.topic).trim()) throw err_('bad_request', 'Topic is required (row ' + (i + 1) + ').');
    return {
      'Day': day, 'Order': i + 1, 'Start': start, 'End': end, 'Topic': s_(r.topic).trim().slice(0, 200),
      'Presenter': s_(r.presenter).trim().slice(0, 120), 'Room': s_(r.room).trim().slice(0, 80),
      'Notes': s_(r.notes).trim().slice(0, 300), 'Time TBC': (r.tbc || !start) ? 'yes' : 'no'
    };
  });
  return withLock_(function () {
    const t = read_('Timetable');
    t.rows.filter(function (r) { return Number(r['Day']) === day; }).map(function (r) { return r._row; })
      .sort(function (a, b) { return b - a; }).forEach(function (row) { t.sh.deleteRow(row); });
    clean.forEach(function (r) { append_('Timetable', r); });
    audit_('timetable_save', 'Day ' + day, clean.length + ' sessions');
    return {};
  });
}

function uploadMaterial_(req) {
  const meta = cleanMeta_(req.meta || {});
  const f = checkFile_(req.file);
  return withLock_(function () {
    const file = folder_('MATERIALS_FOLDER_ID', 'NMMS INO Training 2026-27 - Training Materials (private)').createFile(f.blob);
    const id = 'M' + Utilities.formatDate(now_(), TZ, 'yyMMddHHmmss') + Math.floor(Math.random() * 1000);
    append_('Materials', {
      'Material ID': id, 'Title': meta.title || f.name, 'Description': meta.description, 'Day': meta.day,
      'Category': meta.category, 'Order': meta.order, 'Published': meta.published ? 'yes' : 'no',
      'File ID': file.getId(), 'File Name': f.name, 'MIME': f.mime, 'Size': f.size, 'Uploaded At': now_().toISOString(),
      'Topic': meta.topic, 'Kind': 'file', 'Link URL': ''
    });
    audit_('material_upload', id, meta.topic + ' · ' + f.name);
    return { id: id };
  });
}

function updateMaterial_(req) {
  const meta = cleanMeta_(req.meta || {});
  const f = req.file ? checkFile_(req.file) : null;
  return withLock_(function () {
    const t = read_('Materials');
    const r = t.rows.filter(function (x) { return s_(x['Material ID']) === s_(req.id); })[0];
    if (!r) throw err_('not_found', 'Material not found.');
    const upd = {
      'Title': meta.title || s_(r['Title']), 'Description': meta.description, 'Day': meta.day,
      'Category': meta.category, 'Order': meta.order, 'Published': meta.published ? 'yes' : 'no', 'Topic': meta.topic
    };
    const isLink = s_(r['Kind']) === 'link';
    if (isLink) {
      if (f) throw err_('bad_request', 'A link has no file to replace.');
      upd['Link URL'] = cleanUrl_(req.meta && req.meta.url);
    }
    if (f) {
      const file = folder_('MATERIALS_FOLDER_ID', 'NMMS INO Training 2026-27 - Training Materials (private)').createFile(f.blob);
      try { DriveApp.getFileById(s_(r['File ID'])).setTrashed(true); } catch (e) { /* old file already gone */ }
      upd['File ID'] = file.getId(); upd['File Name'] = f.name; upd['MIME'] = f.mime; upd['Size'] = f.size;
      upd['Uploaded At'] = now_().toISOString();
    }
    update_(t, r._row, upd);
    audit_(f ? 'material_replace' : 'material_edit', s_(req.id), upd['Title']);
    return {};
  });
}

function deleteMaterial_(req) {
  return withLock_(function () {
    const t = read_('Materials');
    const r = t.rows.filter(function (x) { return s_(x['Material ID']) === s_(req.id); })[0];
    if (!r) throw err_('not_found', 'Material not found.');
    if (s_(r['File ID'])) { try { DriveApp.getFileById(s_(r['File ID'])).setTrashed(true); } catch (e) { /* already gone */ } }
    t.sh.deleteRow(r._row);
    audit_('material_delete', s_(req.id), s_(r['Title']));
    return {};
  });
}

function addLink_(req) {
  const meta = cleanMeta_(req.meta || {});
  const url = cleanUrl_(req.meta && req.meta.url);
  if (!meta.title) throw err_('bad_request', 'Give the link a title.');
  return withLock_(function () {
    const id = 'L' + Utilities.formatDate(now_(), TZ, 'yyMMddHHmmss') + Math.floor(Math.random() * 1000);
    append_('Materials', {
      'Material ID': id, 'Title': meta.title, 'Description': meta.description, 'Day': meta.day, 'Category': 'Official link',
      'Order': meta.order, 'Published': meta.published ? 'yes' : 'no', 'File ID': '', 'File Name': '', 'MIME': '', 'Size': 0,
      'Uploaded At': now_().toISOString(), 'Topic': meta.topic, 'Kind': 'link', 'Link URL': url
    });
    audit_('material_link_add', id, meta.topic + ' · ' + url);
    return { id: id };
  });
}

function cleanUrl_(u) {
  u = s_(u).trim();
  if (!/^https:\/\/[^\s"'<>]+$/.test(u) || u.length > 500) throw err_('bad_request', 'Links must start with https:// and contain no spaces.');
  return u;
}

function saveSettings_(req) {
  const inS = req.settings || {};
  const out = {};
  ['preFormUrl', 'postFormUrl'].forEach(function (k) {
    const v = s_(inS[k]).trim();
    if (v && !/^https:\/\/[^\s"'<>]+$/.test(v)) throw err_('bad_request', k + ' must be an https:// link.');
    out[k] = v;
  });
  ['preOpen', 'postOpen'].forEach(function (k) { out[k] = inS[k] === 'no' ? 'no' : 'yes'; });
  return withLock_(function () {
    const t = read_('Settings');
    Object.keys(out).forEach(function (k) {
      const r = t.rows.filter(function (x) { return s_(x['Key']) === k; })[0];
      if (r) update_(t, r._row, { 'Value': out[k] }); else append_('Settings', { 'Key': k, 'Value': out[k] });
    });
    audit_('settings_save', 'settings', JSON.stringify(out));
    return {};
  });
}

/* ---------------- One-time setup (run from the editor) ---------------- */

function setup() {
  Object.keys(HEADERS).forEach(function (name) { sheet_(name); });
  const parts = read_('Participants');
  if (!parts.rows.length) {
    seedParticipants_().forEach(function (p, i) {
      append_('Participants', {
        'Participant ID': 'NUH-' + ('00' + (i + 1)).slice(-3), 'Name': p[0], 'Mobile': p[1],
        'School / Office': p[2], 'Block': p[3], 'Updated At': now_().toISOString()
      });
    });
  }
  const st = read_('Settings');
  Object.keys(SETTING_DEFAULTS).forEach(function (k) {
    if (!st.rows.some(function (r) { return s_(r['Key']) === k; })) append_('Settings', { 'Key': k, 'Value': SETTING_DEFAULTS[k] });
  });
  folder_('PHOTO_FOLDER_ID', 'NMMS INO Training 2026-27 - Attendance Photos (private)');
  folder_('MATERIALS_FOLDER_ID', 'NMMS INO Training 2026-27 - Training Materials (private)');
  const msg = 'Setup complete. Participants: ' + read_('Participants').rows.length +
    '. ADMIN_PASSWORD set: ' + (prop_('ADMIN_PASSWORD') ? 'yes' : 'NO — add it in Project Settings > Script properties');
  console.log(msg);
  return msg;
}

/* ---------------- Helpers ---------------- */

function now_() { return new Date(); }
function today_() { return Utilities.formatDate(now_(), TZ, 'yyyy-MM-dd'); }
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function err_(code, message) { const e = new Error(message); e.code = code; return e; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function testSheet_(type) { return type === 'pre' ? 'PreTestResponses' : 'PostTestResponses'; }
function digits_(v) { return s_(v).replace(/\D/g, ''); }
function norm_(v) { return s_(v).toLowerCase().replace(/[^a-z0-9ऀ-ॿ]/g, ''); }
function safeEq_(a, b) {
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

function s_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, TZ, "yyyy-MM-dd'T'HH:mm:ss");
  return String(v);
}

function dayNum_(r) {
  const d = s_(r['Attendance Date']);
  for (const k in DAYS) if (DAYS[k] === d) return Number(k);
  const m = /(\d)/.exec(s_(r['Training Day']));
  return m ? Number(m[1]) : 0;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw err_('busy', 'Server is busy. Please try again in a moment.');
  try { return fn(); } finally { lock.releaseLock(); }
}

let SS_CACHE_ = null;
function ss_() {
  if (!SS_CACHE_) {
    const id = prop_('SPREADSHEET_ID') || (typeof PRIVATE_SPREADSHEET_ID !== 'undefined' ? PRIVATE_SPREADSHEET_ID : '');
    if (!id) throw err_('not_configured', 'Spreadsheet is not configured (script property SPREADSHEET_ID or Private.gs).');
    SS_CACHE_ = SpreadsheetApp.openById(id);
  }
  return SS_CACHE_;
}

function sheet_(name) {
  const ss = ss_();
  const want = HEADERS[name];
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  let have = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0] : [];
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, want.length).setValues([want]);
    sh.setFrozenRows(1);
    have = want.slice();
  } else {
    const missing = want.filter(function (h) { return have.indexOf(h) < 0; });
    if (missing.length) {
      sh.getRange(1, have.length + 1, 1, missing.length).setValues([missing]);
      have = have.concat(missing);
    }
  }
  return { sh: sh, headers: have };
}

function read_(name) {
  const t = sheet_(name);
  const n = t.sh.getLastRow() - 1;
  t.rows = [];
  if (n < 1) return t;
  const vals = t.sh.getRange(2, 1, n, t.headers.length).getValues();
  t.rows = vals.map(function (r, i) {
    const o = { _row: i + 2 };
    t.headers.forEach(function (h, j) { o[h] = r[j]; });
    return o;
  });
  return t;
}

function cell_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return v;
  v = String(v);
  // Force text: prevents formula injection and keeps dates, times, phone numbers and IDs exactly as written.
  if (/^[=+\-@]/.test(v) || /^[\d\s:.,\/T+-]+Z?$/.test(v) || /^\d{4}-\d{2}-\d{2}T/.test(v)) return "'" + v;
  return v;
}

function append_(name, obj) {
  const t = sheet_(name);
  t.sh.appendRow(t.headers.map(function (h) { return cell_(obj[h]); }));
}

function update_(t, row, obj) {
  Object.keys(obj).forEach(function (k) {
    const c = t.headers.indexOf(k);
    if (c >= 0) t.sh.getRange(row, c + 1).setValue(cell_(obj[k]));
  });
}

function audit_(action, target, details) {
  try { append_('AuditLog', { 'Time': now_().toISOString(), 'Action': action, 'Target': s_(target), 'Details': s_(details).slice(0, 500) }); }
  catch (e) { console.error('audit failed', e); }
}

function folder_(propKey, name) {
  const id = prop_(propKey);
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ } }
  const f = DriveApp.createFolder(name); // private by default: no sharing is added
  PropertiesService.getScriptProperties().setProperty(propKey, f.getId());
  return f;
}

function participant_(pid) {
  const r = read_('Participants').rows.filter(function (x) { return s_(x['Participant ID']) === pid; })[0];
  return r ? { id: pid, name: s_(r['Name']), mobile: s_(r['Mobile']), school: s_(r['School / Office']), block: s_(r['Block']) } : null;
}

/** Duplicate rule: same 10-digit mobile, or same name + school/office (case, spaces and punctuation ignored). */
function upsertParticipant_(inP, isImport) {
  const p = {
    id: s_(inP.id || inP.participant_id).trim(), name: s_(inP.name).trim().replace(/\s+/g, ' '),
    mobile: digits_(inP.mobile), school: s_(inP.school || inP.school_or_office).trim(), block: s_(inP.block).trim()
  };
  if (p.name.length < 2) throw err_('bad_request', 'Name is required.');
  if (!p.school) throw err_('bad_request', 'School / Office is required.');
  if (!p.block) throw err_('bad_request', 'Block is required.');
  if (p.mobile && !/^[6-9]\d{9}$/.test(p.mobile)) throw err_('bad_request', 'Mobile must be a 10-digit Indian number or blank.');
  const t = read_('Participants');
  const byId = p.id ? t.rows.filter(function (r) { return s_(r['Participant ID']) === p.id; })[0] : null;
  const dupOf = function (exceptId) {
    return t.rows.filter(function (r) {
      if (s_(r['Participant ID']) === exceptId) return false;
      return (p.mobile && digits_(r['Mobile']) === p.mobile) ||
        (norm_(r['Name']) === norm_(p.name) && norm_(r['School / Office']) === norm_(p.school));
    })[0];
  };
  let target = byId;
  if (!target) {
    if (p.id && !isImport) throw err_('not_found', 'Participant ' + p.id + ' not found.');
    const d = dupOf('');
    if (d && !isImport) throw err_('duplicate', 'Duplicate of ' + s_(d['Participant ID']) + ' (' + s_(d['Name']) + ').');
    target = d || null;
  } else {
    const d = dupOf(p.id);
    if (d) throw err_('duplicate', 'Same mobile or name+school as ' + s_(d['Participant ID']) + ' (' + s_(d['Name']) + ').');
  }
  const row = { 'Name': p.name, 'Mobile': p.mobile, 'School / Office': p.school, 'Block': p.block, 'Updated At': now_().toISOString() };
  if (target) {
    update_(t, target._row, row);
    return { id: s_(target['Participant ID']), name: p.name, created: false };
  }
  let max = 0;
  t.rows.forEach(function (r) { const m = /^NUH-(\d+)$/.exec(s_(r['Participant ID'])); if (m) max = Math.max(max, Number(m[1])); });
  row['Participant ID'] = 'NUH-' + ('00' + (max + 1)).slice(-3);
  append_('Participants', row);
  return { id: row['Participant ID'], name: p.name, created: true };
}

function cleanAnswers_(a) {
  a = a && typeof a === 'object' ? a : {};
  const out = {};
  ANSWER_KEY.forEach(function (k, i) {
    const v = a['q' + (i + 1)];
    if (k.t === 'multi') {
      const arr = Array.isArray(v) ? v.map(Number).filter(function (x) { return Number.isInteger(x) && x >= 0 && x < k.n; }) : [];
      out['q' + (i + 1)] = arr.filter(function (x, j) { return arr.indexOf(x) === j; }).sort(function (x, y) { return x - y; });
    } else if (k.t === 'text') {
      out['q' + (i + 1)] = s_(v).trim().slice(0, 300);
    } else {
      const n = Number(v);
      out['q' + (i + 1)] = (v !== null && v !== '' && v !== undefined && Number.isInteger(n) && n >= 0 && n < k.n) ? n : null;
    }
  });
  return out;
}

function answerText_(v, k) {
  if (k.t === 'multi') return (v || []).map(function (x) { return x + 1; }).join(', ');
  if (k.t === 'text') return v || '';
  return v === null || v === undefined ? '' : String(v + 1);
}

function timetable_() {
  const out = { 1: null, 2: null, 3: null };
  read_('Timetable').rows.forEach(function (r) {
    const d = Number(r['Day']);
    if (!out[d]) out[d] = [];
    out[d].push({
      order: Number(r['Order']) || 0, start: hm_(r['Start']), end: hm_(r['End']), topic: s_(r['Topic']),
      presenter: s_(r['Presenter']), room: s_(r['Room']), notes: s_(r['Notes']), tbc: s_(r['Time TBC']) !== 'no'
    });
  });
  Object.keys(out).forEach(function (d) { if (out[d]) out[d].sort(function (a, b) { return a.order - b.order; }); });
  return out;
}

function hm_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, TZ, 'HH:mm');
  return s_(v);
}

function materials_() {
  return read_('Materials').rows.filter(function (r) { return s_(r['Material ID']); }).map(function (r) {
    return {
      id: s_(r['Material ID']), title: s_(r['Title']), description: s_(r['Description']), day: Number(r['Day']) || 1,
      category: s_(r['Category']), order: Number(r['Order']) || 0, published: s_(r['Published']) === 'yes',
      fileId: s_(r['File ID']), name: s_(r['File Name']), mime: s_(r['MIME']), size: Number(r['Size']) || 0,
      at: s_(r['Uploaded At']), topic: s_(r['Topic']), kind: s_(r['Kind']) || 'file',
      url: s_(r['Kind']) === 'link' ? s_(r['Link URL']) : ''
    };
  });
}

function settings_() {
  const out = Object.assign({}, SETTING_DEFAULTS);
  read_('Settings').rows.forEach(function (r) { const k = s_(r['Key']); if (k in out) out[k] = s_(r['Value']); });
  return out;
}

function cleanMeta_(m) {
  const topic = s_(m.topic);
  if (!TOPICS[topic]) throw err_('bad_request', 'Choose a topic folder.');
  return {
    title: s_(m.title).trim().slice(0, 150), description: s_(m.description).trim().slice(0, 500),
    topic: topic, day: TOPICS[topic],
    category: CATEGORIES.indexOf(m.category) >= 0 ? m.category : 'Other',
    order: Math.max(0, Math.min(999, Number(m.order) || 0)), published: m.published !== false
  };
}

function checkFile_(f) {
  if (!f || !f.name || !f.data) throw err_('bad_request', 'File is missing.');
  const name = s_(f.name).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
  const ext = (/\.([a-z0-9]+)$/i.exec(name) || [])[1];
  const type = ext && FILE_TYPES[ext.toLowerCase()];
  if (!type) throw err_('bad_request', 'File type not allowed. Use PDF, DOC/DOCX, PPT/PPTX, XLS/XLSX, JPG, PNG, WebP, MP4 or WebM.');
  if (f.mime && f.mime !== type.mime) throw err_('bad_request', 'File content type does not match its extension.');
  if (!/^[A-Za-z0-9+/=]+$/.test(String(f.data))) throw err_('bad_request', 'File data is not valid.');
  const bytes = Utilities.base64Decode(f.data);
  const max = type.video ? MAX_VIDEO_BYTES : MAX_FILE_BYTES;
  if (bytes.length > max) throw err_('bad_request', 'File is larger than ' + (max / 1048576) + ' MB.');
  const b = function (i) { return (bytes[i] + 256) % 256; };
  const ok = {
    '%PDF': b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46,
    'PK': b(0) === 0x50 && b(1) === 0x4B,
    'OLE': b(0) === 0xD0 && b(1) === 0xCF && b(2) === 0x11 && b(3) === 0xE0,
    'JPG': b(0) === 0xFF && b(1) === 0xD8,
    'PNG': b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47,
    'RIFF': b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46,
    'FTYP': b(4) === 0x66 && b(5) === 0x74 && b(6) === 0x79 && b(7) === 0x70,
    'EBML': b(0) === 0x1A && b(1) === 0x45 && b(2) === 0xDF && b(3) === 0xA3
  }[type.magic];
  if (!ok) throw err_('bad_request', 'File content does not look like a valid .' + ext + ' file.');
  return { name: name, mime: type.mime, size: bytes.length, blob: Utilities.newBlob(bytes, type.mime, name) };
}
