// Run: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createEnv } = require('./gas-mock');

// Tests that use the real participant list need apps-script/Private.gs (kept out of the public repository).
const HAS_SEED = fs.existsSync(path.join(__dirname, '..', 'apps-script', 'Private.gs'));
const seedTest = HAS_SEED ? test : (name, fn) => test.skip(name + ' (needs apps-script/Private.gs)', fn);
const SEED = HAS_SEED ? Array.from(createEnv().api.SEED_PARTICIPANTS, r => Array.from(r)) : [];
const MOB1 = HAS_SEED ? SEED[0][1] : '';   // participant NUH-001
const MOB4 = HAS_SEED ? SEED[3][1] : '';   // participant NUH-004

const TEST_PW = 'test-only-password'; // not the real admin password
const DAY1 = '2026-10-12T05:00:00.000Z'; // 10:30 IST on Day 1
const PHOTO = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');
const PERFECT = { q1: [0, 2], q2: 1, q3: [2, 3, 4], q4: 0, q5: 1, q6: [0, 1, 2, 3, 4], q7: 0, q8: 0, q9: [0, 1, 2], q10: 1, q11: 0, q12: 'Sh. Example, 9876543210, help@example.com' };

function ready(extraProps) {
  const env = createEnv({ now: DAY1, props: Object.assign({ ADMIN_PASSWORD: TEST_PW }, extraProps || {}) });
  env.api.setup();
  return env;
}
function login(env) {
  const r = env.call('login', { password: TEST_PW });
  assert.equal(r.ok, true, r.error);
  return r.token;
}
const rows = (env, name) => env.ss.getSheetByName(name).data.slice(1);

test('answer key totals exactly 20 marks', () => {
  const env = createEnv();
  assert.equal(env.api.ANSWER_KEY.reduce((s, k) => s + k.m, 0), 20);
  assert.deepEqual(Array.from(env.api.ANSWER_KEY, k => k.m), [2, 1, 3, 1, 1, 4, 1, 1, 3, 1, 1, 1]);
});

test('scoring: perfect answers score 20, empty scores 0', () => {
  const { nmmsScore, ANSWER_KEY } = createEnv().api;
  assert.equal(nmmsScore(PERFECT, ANSWER_KEY).total, 20);
  assert.equal(nmmsScore({}, ANSWER_KEY).total, 0);
});

test('scoring: checkbox questions need the exact set', () => {
  const { nmmsScore, ANSWER_KEY } = createEnv().api;
  const q = (n, v) => nmmsScore(Object.assign({}, PERFECT, { ['q' + n]: v }), ANSWER_KEY).marks[n - 1];
  assert.equal(q(1, [2, 0]), 2, 'order does not matter');
  assert.equal(q(1, [0]), 0, 'subset gets nothing');
  assert.equal(q(1, [0, 1, 2]), 0, 'superset gets nothing');
  assert.equal(q(3, [2, 3]), 0);
  assert.equal(q(6, [0, 1, 2, 3]), 0);
  assert.equal(q(9, [0, 1, 2, 3]), 0, 'L3 by SNO is not required');
  assert.equal(q(2, 4), 0, 'wrong single choice');
  assert.equal(q(2, ''), 0, 'blank single choice');
});

test('scoring: Q11 any answer = 1, Q12 needs a meaningful response', () => {
  const { nmmsScore, ANSWER_KEY } = createEnv().api;
  const m = a => nmmsScore(Object.assign({}, PERFECT, a), ANSWER_KEY).marks;
  assert.equal(m({ q11: 1 })[10], 1);
  assert.equal(m({ q11: null })[10], 0);
  assert.equal(m({ q12: 'NA' })[11], 0);
  assert.equal(m({ q12: '   ' })[11], 0);
  assert.equal(m({ q12: 'DEO office helpdesk 9876543210' })[11], 1);
});

seedTest('setup seeds exactly 34 participants without duplicates', () => {
  const env = ready();
  const p = rows(env, 'Participants');
  assert.equal(p.length, 34);
  assert.equal(p[0][0], 'NUH-001');
  assert.equal(p[33][0], 'NUH-034');
  const mobiles = p.map(r => r[2]).filter(Boolean);
  assert.equal(new Set(mobiles).size, mobiles.length, 'no duplicate mobiles');
  assert.equal(mobiles.length, 33, 'Nishant Raheja has no mobile');
  const nishant = p.find(r => r[1] === 'Nishant Raheja');
  assert.equal(nishant[2], '');
  assert.equal(p.find(r => r[1] === 'EM Khan')[3], 'O/o DEO Nuh');
  env.api.setup(); // running setup again must not re-seed
  assert.equal(rows(env, 'Participants').length, 34);
});

seedTest('public data never contains mobile numbers', () => {
  const env = ready();
  const r = env.call('public');
  assert.equal(r.ok, true);
  assert.equal(r.participants.length, 34);
  const text = JSON.stringify(r);
  assert.ok(!text.includes(MOB1));
  assert.ok(!('mobile' in r.participants[0]));
});

seedTest('admin actions are refused without a valid session', () => {
  const env = ready();
  for (const a of ['admin', 'photo', 'saveParticipant', 'importParticipants', 'correctAttendance', 'saveTimetable', 'uploadMaterial', 'updateMaterial', 'deleteMaterial', 'saveSettings']) {
    const r = env.call(a, { token: 'f'.repeat(64) });
    assert.equal(r.ok, false, a);
    assert.equal(r.code, 'auth', a);
  }
});

seedTest('login: wrong password refused, lock-out after 5 failures, password not configurable from client', () => {
  const env = ready();
  assert.equal(env.call('login', { password: '0000' }).code, 'auth');
  const t = login(env);
  assert.match(t, /^[a-f0-9]{64}$/);
  assert.equal(env.call('admin', { token: t }).ok, true);
  env.call('logout', { token: t });
  assert.equal(env.call('admin', { token: t }).code, 'auth', 'logout ends the session');
  for (let i = 0; i < 5; i++) env.call('login', { password: 'bad' });
  assert.equal(env.call('login', { password: TEST_PW }).code, 'locked');
  const noPw = createEnv({ now: DAY1 });
  noPw.api.setup();
  assert.equal(noPw.call('login', { password: TEST_PW }).code, 'not_configured');
});

seedTest('attendance: one record per participant per day, with consent and photo', () => {
  const env = ready();
  assert.equal(env.call('attend', { pid: 'NUH-001', day: 1, photo: PHOTO }).error, 'Photo consent is required.');
  assert.equal(env.call('attend', { pid: 'NUH-001', day: 1, consent: true, photo: 'data:text/html;base64,AAAA' }).ok, false);
  assert.equal(env.call('attend', { pid: 'NUH-999', day: 1, consent: true, photo: PHOTO }).ok, false);
  assert.equal(env.call('attend', { pid: 'NUH-001', day: 2, consent: true, photo: PHOTO }).code, 'closed', 'Day 2 not open on Day 1');
  const a = env.call('attend', { pid: 'NUH-001', day: 1, consent: true, photo: PHOTO });
  assert.equal(a.ok, true);
  assert.equal(a.duplicate, false);
  const b = env.call('attend', { pid: 'NUH-001', day: 1, consent: true, photo: PHOTO });
  assert.equal(b.duplicate, true);
  const att = rows(env, 'Attendance');
  assert.equal(att.length, 1);
  const H = env.ss.getSheetByName('Attendance').data[0];
  const rec = Object.fromEntries(H.map((h, i) => [h, att[0][i]]));
  assert.equal(rec['Record Key'], 'NUH-001_2026-10-12');
  assert.equal(rec['Attendance Date'], '2026-10-12');
  assert.equal(rec['Status'], 'present');
  assert.equal(rec['Consent'], 'YES');
  assert.match(rec['Photo File ID'], /^file\d+$/);
  assert.equal(rec['Mobile'], MOB1);
  const pub = env.call('public');
  assert.deepEqual(pub.marks.map(m => [m.pid, m.day, m.status]), [['NUH-001', 1, 'present']]);
  const t = login(env);
  const ph = env.call('photo', { token: t, key: 'NUH-001_2026-10-12' });
  assert.equal(ph.photo, PHOTO);
});

seedTest('attendance keeps the earlier Attendance sheet columns and old rows', () => {
  const env = createEnv({ now: DAY1, props: { ADMIN_PASSWORD: TEST_PW } });
  const sh = env.ss.insertSheet('Attendance');
  const old = ['Record Key', 'District', 'Officer Name', 'Mobile', 'School / Office', 'Block', 'Designation', 'Subject', 'Training Day', 'Attendance Date', 'Timestamp', 'Demo', 'Photo Backup Status'];
  sh.appendRow(old);
  sh.appendRow(['old-key', 'NUH', 'Old Person', '9999999999', 'X', 'Nuh', 'INO', '', 'Day 1', '2026-10-11', 'x', 'YES', 'No photo']);
  env.api.setup();
  const H = sh.data[0];
  assert.deepEqual(H.slice(0, 13), old, 'original columns unchanged');
  assert.ok(H.includes('Participant ID') && H.includes('Photo File ID'));
  assert.equal(sh.data[1][2], 'Old Person', 'old row untouched');
  env.call('attend', { pid: 'NUH-002', day: 1, consent: true, photo: PHOTO });
  assert.equal(sh.data.length, 3);
  assert.equal(env.call('public').marks.length, 1, 'old rows without Participant ID are not reported');
});

seedTest('tests: pre and post stored separately, scored on the server, one attempt each', () => {
  const env = ready();
  const r1 = env.call('submitTest', { type: 'pre', pid: 'NUH-003', answers: Object.assign({}, PERFECT, { q2: 0 }), total: 20 });
  assert.equal(r1.ok, true);
  assert.equal(env.call('submitTest', { type: 'pre', pid: 'NUH-003', answers: PERFECT }).duplicate, true);
  assert.equal(env.call('submitTest', { type: 'post', pid: 'NUH-003', answers: PERFECT }).duplicate, false);
  assert.equal(rows(env, 'PreTestResponses').length, 1);
  assert.equal(rows(env, 'PostTestResponses').length, 1);
  const t = login(env);
  const ad = env.call('admin', { token: t });
  assert.equal(ad.pre[0].total, 19, 'client-sent total ignored');
  assert.equal(ad.post[0].total, 20);
  assert.deepEqual(ad.pre[0].marks, [2, 0, 3, 1, 1, 4, 1, 1, 3, 1, 1, 1]);
  const H = env.ss.getSheetByName('PreTestResponses').data[0];
  const row = rows(env, 'PreTestResponses')[0];
  assert.equal(row[H.indexOf('Q1 Answer')], '1, 3');
  assert.equal(row[H.indexOf('Total (out of 20)')], 19);
  assert.equal(row[H.indexOf('Q11 Response')], 'Yes');
  const pub = env.call('public');
  assert.deepEqual(pub.testmarks.map(x => x.type).sort(), ['post', 'pre']);
  assert.ok(!JSON.stringify(pub).includes('answers'), 'answers are not public');
});

seedTest('tests: closed test refused; Q12 formula text stored safely', () => {
  const env = ready();
  const t = login(env);
  assert.equal(env.call('saveSettings', { token: t, settings: { preOpen: 'no', postOpen: 'yes' } }).ok, true);
  assert.equal(env.call('submitTest', { type: 'pre', pid: 'NUH-004', answers: PERFECT }).code, 'closed');
  env.call('submitTest', { type: 'post', pid: 'NUH-004', answers: Object.assign({}, PERFECT, { q12: '=HYPERLINK("x")' }) });
  const H = env.ss.getSheetByName('PostTestResponses').data[0];
  assert.equal(rows(env, 'PostTestResponses')[0][H.indexOf('Q12 Answer')], '=HYPERLINK("x")', 'stored as text (apostrophe prefix)');
  assert.equal(env.call('saveSettings', { token: t, settings: { preFormUrl: 'javascript:alert(1)' } }).ok, false);
});

seedTest('participants: duplicate rule and CSV import', () => {
  const env = ready();
  const t = login(env);
  const dup = env.call('saveParticipant', { token: t, participant: { name: 'New Person', mobile: MOB1, school: 'GSSS X', block: 'Nuh' } });
  assert.equal(dup.code, 'duplicate', 'same mobile');
  const dup2 = env.call('saveParticipant', { token: t, participant: { name: 'sumit  KUMAR', mobile: '', school: 'ggsss f.p. jhirka', block: 'FP Jhirka' } });
  assert.equal(dup2.code, 'duplicate', 'same name + school');
  const add = env.call('saveParticipant', { token: t, participant: { name: 'New Person', mobile: '', school: 'GSSS X', block: 'Nuh' } });
  assert.equal(add.id, 'NUH-035');
  const edit = env.call('saveParticipant', { token: t, participant: { id: 'NUH-033', name: 'Nishant Raheja', mobile: '9812345678', school: 'GSSS Kherla', block: 'Nuh' } });
  assert.equal(edit.ok, true);
  const imp = env.call('importParticipants', { token: t, rows: [
    { participant_id: 'NUH-001', name: 'Sumit Kumar', mobile: MOB1, school_or_office: 'GGSSS F.P. JHIRKA', block: 'FP Jhirka' },
    { name: 'Tara Chand', mobile: MOB4, school_or_office: 'GSSS DOHA', block: 'FP Jhirka' },
    { name: 'Another New', mobile: '7000000001', school_or_office: 'GSSS Y', block: 'Tauru' },
    { name: 'Bad Mobile', mobile: '12345', school_or_office: 'GSSS Z', block: 'Tauru' }
  ] });
  assert.equal(imp.created, 1);
  assert.equal(imp.updated, 2);
  assert.equal(imp.errors.length, 1);
  assert.equal(rows(env, 'Participants').length, 36);
});

seedTest('attendance correction is logged and keeps one row', () => {
  const env = ready();
  const t = login(env);
  assert.equal(env.call('correctAttendance', { token: t, pid: 'NUH-005', day: 1, status: 'present', reason: '' }).ok, false, 'reason required');
  assert.equal(env.call('correctAttendance', { token: t, pid: 'NUH-005', day: 1, status: 'present', reason: 'Phone camera failed' }).ok, true);
  assert.equal(env.call('attend', { pid: 'NUH-005', day: 1, consent: true, photo: PHOTO }).duplicate, true);
  assert.equal(env.call('correctAttendance', { token: t, pid: 'NUH-005', day: 1, status: 'absent', reason: 'Left at 10 am' }).ok, true);
  assert.equal(rows(env, 'Attendance').length, 1);
  const ad = env.call('admin', { token: t });
  assert.equal(ad.attendance[0].status, 'absent');
  assert.match(ad.attendance[0].correction, /Phone camera failed.*\|.*Left at 10 am/);
  assert.ok(ad.audit.some(a => a.action === 'attendance_correction'));
});

seedTest('timetable save validates times and replaces only that day', () => {
  const env = ready();
  const t = login(env);
  assert.equal(env.call('saveTimetable', { token: t, day: 1, rows: [{ start: '9.30', end: '', topic: 'X' }] }).ok, false);
  env.call('saveTimetable', { token: t, day: 1, rows: [{ start: '', end: '', topic: 'NMMS Scheme Guidelines', tbc: true }, { start: '09:30', end: '10:30', topic: 'B' }] });
  env.call('saveTimetable', { token: t, day: 2, rows: [{ topic: 'Sample OMR Sheet for NMMS Exam' }] });
  env.call('saveTimetable', { token: t, day: 1, rows: [{ start: '09:30', end: '10:30', topic: 'Only one' }] });
  const tt = env.call('public').timetable;
  assert.equal(tt[1].length, 1);
  assert.equal(tt[1][0].start, '09:30');
  assert.equal(tt[1][0].tbc, false);
  assert.equal(tt[2][0].tbc, true);
  assert.equal(tt[3], null);
});

const adminMats = (env, t) => env.call('admin', { token: t }).materials;

seedTest('materials: locked module — no public listing, files only with an admin session', () => {
  const env = ready();
  const t = login(env);
  const pdf = Buffer.from('%PDF-1.4 test').toString('base64');
  const fake = Buffer.from('<html>not a pdf').toString('base64');
  const meta = { title: 'Guidelines', topic: 'd1-guidelines', category: 'Guidelines', order: 1, published: true };
  assert.equal(env.call('uploadMaterial', { token: t, meta, file: { name: 'a.pdf', mime: 'application/pdf', data: fake } }).ok, false, 'magic bytes checked');
  assert.equal(env.call('uploadMaterial', { token: t, meta, file: { name: 'a.exe', data: pdf } }).ok, false, 'extension checked');
  const up = env.call('uploadMaterial', { token: t, meta, file: { name: 'NMMS Guidelines.pdf', mime: 'application/pdf', data: pdf } });
  assert.equal(up.ok, true, up.error);
  assert.ok(!('materials' in env.call('public')), 'materials are not in public data');
  assert.equal(env.call('material', { id: up.id }).code, 'auth', 'published file still needs the password');
  assert.equal(env.call('material', { id: up.id, token: t }).data, pdf);
  assert.equal(adminMats(env, t).length, 1);
  assert.equal(env.call('deleteMaterial', { token: t, id: up.id }).ok, true);
  assert.equal(adminMats(env, t).length, 0);
  assert.equal([...env.files.values()].filter(f => f.trashed).length, 1, 'file moved to Drive trash');
});

seedTest('materials: topic folders, day taken from topic, unknown topic refused', () => {
  const env = ready();
  const t = login(env);
  const pdf = Buffer.from('%PDF-1.4 x').toString('base64');
  const file = { name: 'omr.pdf', mime: 'application/pdf', data: pdf };
  assert.equal(env.call('uploadMaterial', { token: t, meta: { title: 'x', topic: 'd9-nothing' }, file }).ok, false);
  assert.equal(env.call('uploadMaterial', { token: t, meta: { title: 'x', day: 1 }, file }).ok, false, 'topic required');
  assert.equal(env.call('uploadMaterial', { meta: { title: 'x', topic: 'd2-omr' }, file }).code, 'auth', 'upload needs the password');
  const up = env.call('uploadMaterial', { token: t, meta: { title: 'Sample OMR', topic: 'd2-omr' }, file });
  assert.equal(up.ok, true, up.error);
  const m = adminMats(env, t)[0];
  assert.equal(m.topic, 'd2-omr');
  assert.equal(m.day, 2, 'day comes from the topic');
  assert.equal(m.published, true, 'published unless unticked');
  assert.equal(m.kind, 'file');
});

seedTest('materials: official links are https-only, need admin, and have no file', () => {
  const env = ready();
  const t = login(env);
  const meta = { title: 'NSP', topic: 'd2-nsp-school', url: 'https://scholarships.gov.in/' };
  assert.equal(env.call('addLink', { meta }).code, 'auth', 'admin only');
  assert.equal(env.call('addLink', { token: t, meta: Object.assign({}, meta, { url: 'javascript:alert(1)' }) }).ok, false);
  assert.equal(env.call('addLink', { token: t, meta: Object.assign({}, meta, { url: 'http://scholarships.gov.in/' }) }).ok, false);
  const r = env.call('addLink', { token: t, meta });
  assert.equal(r.ok, true, r.error);
  const m = adminMats(env, t).find(x => x.id === r.id);
  assert.equal(m.kind, 'link');
  assert.equal(m.url, 'https://scholarships.gov.in/');
  assert.equal(env.call('material', { id: r.id, token: t }).ok, false, 'no file behind a link');
  const pdf = Buffer.from('%PDF-1.4 x').toString('base64');
  assert.equal(env.call('updateMaterial', { token: t, id: r.id, meta, file: { name: 'a.pdf', data: pdf } }).ok, false, 'cannot attach a file to a link');
  assert.equal(env.call('updateMaterial', { token: t, id: r.id, meta: Object.assign({}, meta, { url: 'https://scholarships.gov.in/fresh' }) }).ok, true);
  assert.equal(adminMats(env, t)[0].url, 'https://scholarships.gov.in/fresh');
  assert.equal(env.call('deleteMaterial', { token: t, id: r.id }).ok, true);
});

seedTest('materials: video, legacy Office types and size limits', () => {
  const env = ready();
  const t = login(env);
  const meta = { title: 'v', topic: 'd3-fresh' };
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42')]).toString('base64');
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]).toString('base64');
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1]).toString('base64');
  assert.equal(env.call('uploadMaterial', { token: t, meta, file: { name: 'demo.mp4', mime: 'video/mp4', data: mp4 } }).ok, true);
  assert.equal(env.call('uploadMaterial', { token: t, meta, file: { name: 'demo.webm', data: webm } }).ok, true);
  assert.equal(env.call('uploadMaterial', { token: t, meta, file: { name: 'old.doc', data: ole } }).ok, true);
  assert.equal(env.call('uploadMaterial', { token: t, meta, file: { name: 'old.ppt', data: ole } }).ok, true);
  assert.equal(env.call('uploadMaterial', { token: t, meta, file: { name: 'old.xls', mime: 'application/vnd.ms-excel', data: ole } }).ok, true);
  assert.equal(env.call('uploadMaterial', { token: t, meta, file: { name: 'fake.mp4', data: ole } }).ok, false, 'video magic checked');
  const big = Buffer.alloc(11 * 1024 * 1024); big.write('%PDF');
  assert.match(env.call('uploadMaterial', { token: t, meta, file: { name: 'big.pdf', data: big.toString('base64') } }).error, /10 MB/);
  const bigV = Buffer.alloc(11 * 1024 * 1024); Buffer.from(mp4, 'base64').copy(bigV);
  assert.equal(env.call('uploadMaterial', { token: t, meta, file: { name: 'big.mp4', data: bigV.toString('base64') } }).ok, true, 'videos may be up to 25 MB');
  assert.equal(adminMats(env, t).length, 6);
});
