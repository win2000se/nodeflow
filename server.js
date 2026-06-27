import express from 'express';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const pexec = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- database ----
const db = new Database(path.join(DATA_DIR, 'nodeflow.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS patches (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    tags      TEXT DEFAULT '',
    json      TEXT NOT NULL,
    thumb     TEXT DEFAULT '',
    created   INTEGER NOT NULL,
    updated   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_patches_updated ON patches(updated DESC);
`);

const app = express();
app.use(express.json({ limit: '25mb' }));   // covers base64-encoded images/GIFs up to ~18MB raw

// ---- media uploads ----
const uploadsDir = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// Animated GIF/WebP don't play reliably as textures: Brave blocks the ImageDecoder
// API, and drawImage on an <img> only ever yields frame 0 for WebP in Chromium.
// So we transcode animated uploads to h264 MP4, which the frontend's <video> path
// plays correctly on both Brave and iPhone Safari. (MP4 has no alpha — transparency
// becomes a solid background; it's the only format that plays everywhere on the target
// devices.) ffmpeg can't decode animated WebP, so ImageMagick demuxes it to GIF first.
async function transcodeAnimated(dest) {
  const ext = path.extname(dest).toLowerCase();
  let isAnim = false;
  if (ext === '.webp') {
    isAnim = fs.readFileSync(dest).includes(Buffer.from('ANIM'));   // RIFF animation chunk
  } else if (ext === '.gif') {
    try {
      const { stdout } = await pexec('identify', ['-format', '%n\n', dest]);
      isAnim = parseInt(stdout, 10) > 1;
    } catch (e) { isAnim = false; }
  }
  if (!isAnim) return null;

  const mp4 = dest.replace(/\.(webp|gif)$/i, '') + '.mp4';
  let gifSrc = dest, tmpGif = null;
  if (ext === '.webp') {                       // ffmpeg can't read animated webp → demux to gif
    tmpGif = dest + '.tmp.gif';
    await pexec('convert', [dest, tmpGif]);
    gifSrc = tmpGif;
  }
  try {
    await pexec('ffmpeg', ['-y', '-loglevel', 'error', '-i', gifSrc,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',   // h264 needs even dimensions
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4],
      { maxBuffer: 16 * 1024 * 1024 });
  } finally {
    if (tmpGif) { try { fs.unlinkSync(tmpGif); } catch (e) {} }
  }
  try { fs.unlinkSync(dest); } catch (e) {}     // drop the original; only the mp4 is served
  return mp4;
}

app.post('/api/uploads', async (req, res) => {
  const { filename = 'upload', data } = req.body || {};
  if (!data) return res.status(400).json({ error: 'data required' });
  const safe = (filename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const dest = path.join(uploadsDir, Date.now() + '_' + safe);
  try {
    fs.writeFileSync(dest, Buffer.from(data, 'base64'));
    let served = dest;
    try {
      const mp4 = await transcodeAnimated(dest);   // animated gif/webp → mp4
      if (mp4) served = mp4;
    } catch (e) { console.error('transcode failed, serving original:', e.message); }
    res.json({ url: '/uploads/' + path.basename(served) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/uploads', (_req, res) => {
  try {
    const files = fs.readdirSync(uploadsDir)
      .filter(f => /\.(gif|png|jpg|jpeg|webp|svg|mp4|webm)$/i.test(f))
      .map(f => ({ name: f, url: '/uploads/' + f }));
    res.json(files);
  } catch (e) { res.json([]); }
});

app.delete('/api/uploads/:filename', (req, res) => {
  const safe = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  try { fs.unlinkSync(path.join(uploadsDir, safe)); } catch (e) {}
  res.json({ ok: true });
});

// ---- API ----
const listStmt   = db.prepare('SELECT id, name, tags, thumb, created, updated FROM patches ORDER BY updated DESC LIMIT 500');
const getStmt    = db.prepare('SELECT * FROM patches WHERE id = ?');
const insertStmt = db.prepare('INSERT INTO patches (name, tags, json, thumb, created, updated) VALUES (?, ?, ?, ?, ?, ?)');
const updateStmt = db.prepare('UPDATE patches SET name = ?, tags = ?, json = ?, thumb = ?, updated = ? WHERE id = ?');
const deleteStmt = db.prepare('DELETE FROM patches WHERE id = ?');

app.get('/api/health', (_req, res) => res.json({ ok: true, count: db.prepare('SELECT COUNT(*) c FROM patches').get().c }));

// list (metadata + thumbnails, no full json — keeps the response light)
app.get('/api/patches', (_req, res) => {
  res.json(listStmt.all());
});

// full patch (with json) for loading
app.get('/api/patches/:id', (req, res) => {
  const row = getStmt.get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

// create
app.post('/api/patches', (req, res) => {
  const { name, json, tags = '', thumb = '' } = req.body || {};
  if (!name || !json) return res.status(400).json({ error: 'name and json required' });
  const now = Date.now();
  const info = insertStmt.run(String(name).slice(0, 200), String(tags).slice(0, 300), String(json), String(thumb), now, now);
  res.json({ id: info.lastInsertRowid });
});

// update (rename / overwrite / re-tag)
app.put('/api/patches/:id', (req, res) => {
  const row = getStmt.get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'not found' });
  const { name = row.name, json = row.json, tags = row.tags, thumb = row.thumb } = req.body || {};
  updateStmt.run(String(name).slice(0, 200), String(tags).slice(0, 300), String(json), String(thumb), Date.now(), row.id);
  res.json({ ok: true });
});

// delete
app.delete('/api/patches/:id', (req, res) => {
  deleteStmt.run(Number(req.params.id));
  res.json({ ok: true });
});

// ---- static frontend ----
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`NODEFLOW server on http://localhost:${PORT}`));
