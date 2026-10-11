// Local preview: serves site/ and answers /exec with the real Code.gs running on in-memory mocks.
// Data lives in memory only and disappears when the server stops. Never use for real records.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createEnv } = require('./gas-mock');

const PORT = Number(process.env.PORT || 8787);
const env = createEnv({ props: { ADMIN_PASSWORD: process.env.LOCAL_ADMIN_PASSWORD || 'local-test', ALLOW_ANY_DAY: process.env.ALLOW_ANY_DAY || '' } });
env.api.setup();
if (!env.api.SEED_PARTICIPANTS.length) console.log('Note: apps-script/Private.gs not found, so the participant list is empty in this preview.');
const SITE = path.join(__dirname, '..', 'site');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.css': 'text/css' };

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/exec') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 20e6) req.destroy(); });
    req.on('end', () => {
      const out = env.api.doPost({ postData: { contents: body } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(out.content);
    });
    return;
  }
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end("window.NMMS_CONFIG = { GAS_URL: '/exec' };");
  }
  const file = path.join(SITE, url === '/' ? 'index.html' : url);
  if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log('Local preview (in-memory test data) on http://localhost:' + PORT));
