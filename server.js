// Hashu Hub - ONE server: website + /api/search (youtube via yt-dlp, fitgirl, cinesubz) + MP3 hosting.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const SECRET = '';
const MEDIA_DIR = process.env.MEDIA_DIR || '/tmp/media';
const MAX_MINUTES = Number(process.env.MAX_MINUTES || 20);
const KEEP_MINUTES = Number(process.env.KEEP_MINUTES || 30);
const MAX_JOBS = Number(process.env.MAX_JOBS || 2);
const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';
const EXTRA = (process.env.YTDLP_ARGS || '').split(' ').filter(Boolean);

fs.mkdirSync(MEDIA_DIR, { recursive: true });

// optional YouTube cookies (base64 of cookies.txt) to get past "confirm you're not a bot"
let COOKIES = null;
if (process.env.YT_COOKIES_B64) {
  COOKIES = '/tmp/cookies.txt';
  fs.writeFileSync(COOKIES, Buffer.from(process.env.YT_COOKIES_B64, 'base64'));
}

const baseArgs = () => {
  const a = ['--no-warnings', '--no-playlist', '--js-runtimes', 'node', ...EXTRA];
  if (COOKIES) a.push('--cookies', COOKIES);
  return a;
};

function run(args, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, args);
    let out = '', err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Timed out')); }, timeout);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => {
      clearTimeout(t);
      code === 0 ? resolve(out) : reject(new Error(cleanErr(err) || 'yt-dlp failed (' + code + ')'));
    });
  });
}
const cleanErr = s => (s.split('\n').filter(l => /ERROR/.test(l)).pop() || s).replace(/^ERROR:\s*/, '').trim().slice(0, 300);

const fmtDur = s => { s = Math.round(s || 0); const m = Math.floor(s / 60); return m + ':' + String(s % 60).padStart(2, '0'); };

async function search(q, n = 6) {
  const out = await run([...baseArgs(), '--flat-playlist', '-j', `ytsearch${n}:${q}`], { timeout: 30000 });
  return out.split('\n').filter(Boolean).map(l => {
    const j = JSON.parse(l);
    return {
      title: j.title,
      videoId: j.id,
      url: 'https://www.youtube.com/watch?v=' + j.id,
      thumbnail: `https://i.ytimg.com/vi/${j.id}/hqdefault.jpg`,
      duration: j.duration ? fmtDur(j.duration) : null,
      author: j.channel || j.uploader || null
    };
  });
}

// ---- MP3 jobs (de-duplicated + limited concurrency) ----
const jobs = new Map();
let active = 0;
const waiters = [];
const acquire = () => new Promise(r => { if (active < MAX_JOBS) { active++; r(); } else waiters.push(r); });
const release = () => { const n = waiters.shift(); if (n) n(); else active--; };

function metaPath(id) { return path.join(MEDIA_DIR, id + '.json'); }

async function makeMp3(id) {
  const mp3 = path.join(MEDIA_DIR, id + '.mp3');
  if (fs.existsSync(mp3) && fs.existsSync(metaPath(id))) return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
  if (jobs.has(id)) return jobs.get(id);
  const job = (async () => {
    await acquire();
    try {
      const out = await run([
        ...baseArgs(),
        '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '128K',
        '--match-filter', `duration<=${MAX_MINUTES * 60}`,
        '--print-json', '-o', path.join(MEDIA_DIR, id + '.%(ext)s'),
        'https://www.youtube.com/watch?v=' + id
      ], { timeout: 240000 });
      if (!fs.existsSync(mp3)) throw new Error(`Video is longer than ${MAX_MINUTES} minutes or unavailable`);
      const j = JSON.parse(out.trim().split('\n').pop());
      const meta = { title: j.title, thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, duration: fmtDur(j.duration), author: j.channel || j.uploader || null };
      fs.writeFileSync(metaPath(id), JSON.stringify(meta));
      return meta;
    } finally { release(); jobs.delete(id); }
  })();
  jobs.set(id, job);
  return job;
}

// cleanup old files
setInterval(() => {
  const limit = Date.now() - KEEP_MINUTES * 60000;
  for (const f of fs.readdirSync(MEDIA_DIR)) {
    const p = path.join(MEDIA_DIR, f);
    try { if (fs.statSync(p).mtimeMs < limit) fs.unlinkSync(p); } catch {}
  }
}, 5 * 60000).unref();

// ---- HTTP ----
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj, null, 2));
};
const baseUrl = req => (process.env.PUBLIC_URL || ((req.headers['x-forwarded-proto'] || 'http').split(',')[0] + '://' + req.headers.host)).replace(/\/$/, '');

function serveMedia(req, res, name) {
  if (!/^[\w-]{11}\.mp3$/.test(name)) return json(res, 404, { error: 'Not found' });
  const file = path.join(MEDIA_DIR, name);
  if (!fs.existsSync(file)) return json(res, 404, { error: 'File expired. Request it again.' });
  const size = fs.statSync(file).size;
  const head = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Content-Disposition': `inline; filename="${name}"` };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const start = m[1] ? parseInt(m[1]) : 0;
    const end = m[2] ? Math.min(parseInt(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...head, 'Content-Length': size });
  fs.createReadStream(file).pipe(res);
}

const legacy = require('./api/search.js');   // fitgirl + cinesubz scraping (same code as Vercel)
const INDEX = fs.readFileSync(path.join(__dirname, 'index.html'));

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/health') return json(res, 200, { status: 'ok' });
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(INDEX);
    }
    if (u.pathname.startsWith('/media/')) return serveMedia(req, res, u.pathname.slice(7));

    if (u.pathname === '/api/search') {
      const site = u.searchParams.get('site') || 'fitgirl';
      const q = (u.searchParams.get('q') || '').trim();
      const id = (u.searchParams.get('id') || '').trim();

      if (site === 'youtube') {
        if (id) {                                   // MP3
          if (!/^[\w-]{11}$/.test(id)) return json(res, 400, { status: 'error', error: 'Invalid video id' });
          const meta = await makeMp3(id);
          return json(res, 200, { status: 'success', site, videoId: id, title: meta.title, download_url: `${baseUrl(req)}/media/${id}.mp3` });
        }
        if (q) {                                    // search
          const results = await search(q, 6);
          return results.length ? json(res, 200, { status: 'success', site, query: q, results }) : json(res, 404, { status: 'error', message: 'No results found' });
        }
        return json(res, 400, { error: 'Provide q or id' });
      }

      // fitgirl / cinesubz -> existing handler (express-style adapter)
      req.query = Object.fromEntries(u.searchParams);
      res.status = c => { res.statusCode = c; return res; };
      res.json = o => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); };
      return legacy(req, res);
    }
    json(res, 404, { status: 'error', error: 'Not found' });
  } catch (e) {
    json(res, 500, { status: 'error', error: e.message, details: e.message });
  }
}).listen(PORT, () => console.log('Hashu Hub on :' + PORT));
