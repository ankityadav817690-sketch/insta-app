/**
 * InstaClone — multi-user social app backend
 * Zero external dependencies: node:sqlite, node:crypto, node:http
 * Run: node server.js   (PORT / DB_PATH / UPLOAD_DIR env optional)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || ROOT;      // put a persistent disk here on deploy
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'insta.db');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------------- database ---------------- */
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  fullname TEXT NOT NULL,
  bio TEXT DEFAULT '',
  avatar TEXT DEFAULT '',
  email TEXT DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reset_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  image TEXT NOT NULL,
  caption TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS likes (
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL,
  following_id INTEGER NOT NULL,
  PRIMARY KEY (follower_id, following_id)
);
CREATE TABLE IF NOT EXISTS saves (
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  media TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS story_views (
  story_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (story_id, user_id)
);
CREATE TABLE IF NOT EXISTS reels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  video TEXT NOT NULL,
  caption TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reel_likes (
  reel_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (reel_id, user_id)
);
`);

/* lightweight migrations for older databases */
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('users', 'avatar', "avatar TEXT DEFAULT ''");
ensureColumn('users', 'email', "email TEXT DEFAULT ''");

/* ---------------- helpers ---------------- */
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + sha(salt + pw);
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  return sha(salt + pw) === hash;
}
const newToken = () => crypto.randomBytes(32).toString('hex');

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function currentUser(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  return db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
  ).get(token) || null;
}

function requireUser(req, res) {
  const u = currentUser(req);
  if (!u) { json(res, 401, { error: 'Login required' }); return null; }
  return u;
}

function publicUser(u, viewerId) {
  if (!u) return null;
  const posts = db.prepare('SELECT COUNT(*) c FROM posts WHERE user_id = ?').get(u.id).c;
  const followers = db.prepare('SELECT COUNT(*) c FROM follows WHERE following_id = ?').get(u.id).c;
  const following = db.prepare('SELECT COUNT(*) c FROM follows WHERE follower_id = ?').get(u.id).c;
  const isFollowing = viewerId
    ? !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(viewerId, u.id)
    : false;
  return {
    id: u.id, username: u.username, fullname: u.fullname, bio: u.bio || '',
    avatar: u.avatar || '', email: viewerId === u.id ? (u.email || '') : '',
    posts, followers, following, isFollowing, isMe: viewerId === u.id,
  };
}

const POST_SQL = `SELECT p.*, u.username, u.fullname, u.avatar FROM posts p JOIN users u ON u.id = p.user_id`;

function postView(p, viewerId) {
  const likes = db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id = ?').get(p.id).c;
  const liked = viewerId
    ? !!db.prepare('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?').get(p.id, viewerId) : false;
  const saved = viewerId
    ? !!db.prepare('SELECT 1 FROM saves WHERE post_id = ? AND user_id = ?').get(p.id, viewerId) : false;
  const comments = db.prepare(
    `SELECT c.id, c.text, c.created_at, u.username, u.avatar FROM comments c
     JOIN users u ON u.id = c.user_id WHERE c.post_id = ? ORDER BY c.id ASC LIMIT 100`
  ).all(p.id);
  return {
    id: p.id, image: p.image, caption: p.caption, created_at: p.created_at,
    author: { id: p.user_id, username: p.username, fullname: p.fullname, avatar: p.avatar || '' },
    likes, liked, saved, comments,
  };
}

const REEL_SQL = `SELECT r.*, u.username, u.fullname, u.avatar FROM reels r JOIN users u ON u.id = r.user_id`;
function reelView(r, viewerId) {
  const likes = db.prepare('SELECT COUNT(*) c FROM reel_likes WHERE reel_id = ?').get(r.id).c;
  const liked = viewerId
    ? !!db.prepare('SELECT 1 FROM reel_likes WHERE reel_id = ? AND user_id = ?').get(r.id, viewerId) : false;
  return {
    id: r.id, video: r.video, caption: r.caption, created_at: r.created_at,
    author: { id: r.user_id, username: r.username, fullname: r.fullname, avatar: r.avatar || '' },
    likes, liked,
  };
}

const MEDIA_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.m4v'];

function saveUpload(file, allowed, maxBytes) {
  if (!file) return { error: 'No file uploaded' };
  const ext = (path.extname(file.filename) || '').toLowerCase();
  if (!allowed.includes(ext)) return { error: 'Unsupported file type: ' + (ext || 'unknown') };
  if (file.data.length > maxBytes) return { error: 'File too large' };
  const name = crypto.randomBytes(12).toString('hex') + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), file.data);
  return { url: '/uploads/' + name };
}

/* ---------------- static files ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
};

function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { json(res, 404, { error: 'Not found' }); return; }
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const range = req.headers.range;
    if (range && type.startsWith('video/')) {
      const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (isNaN(start) || start >= st.size) { res.writeHead(416); res.end(); return; }
      if (isNaN(end) || end >= st.size) end = st.size - 1;
      res.writeHead(206, {
        'content-type': type, 'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${st.size}`,
        'content-length': end - start + 1,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'content-type': type, 'content-length': st.size,
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function serveStatic(req, res, urlPath) {
  if (urlPath.startsWith('/uploads/')) {
    const name = path.basename(decodeURIComponent(urlPath));
    return sendFile(req, res, path.join(UPLOAD_DIR, name));
  }
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) { json(res, 403, { error: 'Forbidden' }); return; }
  return sendFile(req, res, file);
}

/* ---------------- API ---------------- */
async function api(req, res, urlPath, query) {
  const method = req.method;

  /* ---- auth ---- */
  if (urlPath === '/api/signup' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const username = String(body.username || '').trim().toLowerCase();
    const fullname = String(body.fullname || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!/^[a-z0-9._]{3,20}$/.test(username))
      return json(res, 400, { error: 'Username: 3-20 chars, a-z, 0-9, dot or underscore' });
    if (fullname.length < 2) return json(res, 400, { error: 'Full name too short' });
    if (password.length < 6) return json(res, 400, { error: 'Password must be 6+ characters' });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'Invalid email' });
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username))
      return json(res, 409, { error: 'Username already taken' });
    if (email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(email))
      return json(res, 409, { error: 'Email already registered' });
    const info = db.prepare(
      'INSERT INTO users (username, fullname, email, password_hash) VALUES (?,?,?,?)'
    ).run(username, fullname, email, hashPassword(password));
    const token = newToken();
    db.prepare('INSERT INTO sessions (token, user_id) VALUES (?,?)').run(token, info.lastInsertRowid);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    return json(res, 201, { token, user: publicUser(u, u.id) });
  }

  if (urlPath === '/api/login' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const u = db.prepare("SELECT * FROM users WHERE username = ? OR (email IS NOT NULL AND email != '' AND email = ?)")
      .get(username, username);
    if (!u || !checkPassword(password, u.password_hash))
      return json(res, 401, { error: 'Wrong username or password' });
    const token = newToken();
    db.prepare('INSERT INTO sessions (token, user_id) VALUES (?,?)').run(token, u.id);
    return json(res, 200, { token, user: publicUser(u, u.id) });
  }

  if (urlPath === '/api/logout' && method === 'POST') {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return json(res, 200, { ok: true });
  }

  if (urlPath === '/api/me' && method === 'GET') {
    const u = currentUser(req);
    if (!u) return json(res, 200, { user: null });
    return json(res, 200, { user: publicUser(u, u.id) });
  }

  /* ---- password reset ----
     No email service is wired up, so the reset token is returned directly.
     On a real deployment set SMTP / use a mail API and send it by email instead. */
  if (urlPath === '/api/forgot' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const id = String(body.usernameOrEmail || '').trim().toLowerCase();
    const u = db.prepare("SELECT * FROM users WHERE username = ? OR (email IS NOT NULL AND email != '' AND email = ?)")
      .get(id, id);
    if (!u) return json(res, 404, { error: 'No account with that username or email' });
    const token = newToken();
    const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO reset_tokens (token, user_id, expires_at) VALUES (?,?,?)')
      .run(token, u.id, expires);
    return json(res, 200, {
      ok: true,
      resetToken: token,
      message: 'Reset link valid for 30 minutes',
    });
  }

  if (urlPath === '/api/reset' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const token = String(body.token || '');
    const password = String(body.password || '');
    if (password.length < 6) return json(res, 400, { error: 'Password must be 6+ characters' });
    const row = db.prepare('SELECT * FROM reset_tokens WHERE token = ? AND used = 0').get(token);
    if (!row) return json(res, 400, { error: 'Invalid or already used reset link' });
    if (new Date(row.expires_at).getTime() < Date.now())
      return json(res, 400, { error: 'Reset link expired' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), row.user_id);
    db.prepare('UPDATE reset_tokens SET used = 1 WHERE token = ?').run(token);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id); // log out everywhere
    return json(res, 200, { ok: true });
  }

  if (urlPath === '/api/change-password' && method === 'POST') {
    const u = requireUser(req, res); if (!u) return;
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    if (!checkPassword(String(body.current || ''), u.password_hash))
      return json(res, 400, { error: 'Current password is wrong' });
    if (String(body.next || '').length < 6)
      return json(res, 400, { error: 'New password must be 6+ characters' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(hashPassword(String(body.next)), u.id);
    return json(res, 200, { ok: true });
  }

  /* ---- posts ---- */
  if (urlPath === '/api/posts' && method === 'GET') {
    const u = currentUser(req);
    const viewer = u ? u.id : null;
    const mode = query.get('mode') || 'feed';
    let rows;
    if (mode === 'explore') {
      rows = db.prepare(`${POST_SQL} ORDER BY p.id DESC LIMIT 60`).all();
    } else if (mode === 'saved' && viewer) {
      rows = db.prepare(
        `${POST_SQL} JOIN saves s ON s.post_id = p.id AND s.user_id = ? ORDER BY p.id DESC`
      ).all(viewer);
    } else {
      const followCount = viewer
        ? db.prepare('SELECT COUNT(*) c FROM follows WHERE follower_id = ?').get(viewer).c : 0;
      rows = followCount || !viewer
        ? db.prepare(
            `${POST_SQL} WHERE p.user_id = ? OR p.user_id IN
             (SELECT following_id FROM follows WHERE follower_id = ?)
             ORDER BY p.id DESC LIMIT 60`
          ).all(viewer || 0, viewer || 0)
        : db.prepare(`${POST_SQL} ORDER BY p.id DESC LIMIT 60`).all();
    }
    return json(res, 200, { posts: rows.map((p) => postView(p, viewer)) });
  }

  if (urlPath === '/api/posts' && method === 'POST') {
    const u = requireUser(req, res); if (!u) return;
    const raw = await readBody(req, 12 * 1024 * 1024);
    const ct = req.headers['content-type'] || '';
    if (!ct.startsWith('multipart/form-data'))
      return json(res, 400, { error: 'Send multipart form data with an "image" file' });
    const parts = parseMultipart(raw, '--' + ct.split('boundary=')[1]);
    const file = parts.find((p) => p.name === 'image' && p.filename);
    const captionPart = parts.find((p) => p.name === 'caption');
    const caption = captionPart ? captionPart.data.toString('utf8').slice(0, 2000) : '';
    const saved = saveUpload(file, MEDIA_EXT, 10 * 1024 * 1024);
    if (saved.error) return json(res, 400, { error: saved.error });
    const info = db.prepare('INSERT INTO posts (user_id, image, caption) VALUES (?,?,?)')
      .run(u.id, saved.url, caption);
    const row = db.prepare(`${POST_SQL} WHERE p.id = ?`).get(info.lastInsertRowid);
    return json(res, 201, { post: postView(row, u.id) });
  }

  const m = urlPath.match(/^\/api\/posts\/(\d+)(\/(like|save|comments))?$/);
  if (m) {
    const id = Number(m[1]);
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
    if (!post) return json(res, 404, { error: 'Post not found' });

    if (!m[2] && method === 'DELETE') {
      const u = requireUser(req, res); if (!u) return;
      if (post.user_id !== u.id) return json(res, 403, { error: 'Not your post' });
      db.prepare('DELETE FROM posts WHERE id = ?').run(id);
      db.prepare('DELETE FROM likes WHERE post_id = ?').run(id);
      db.prepare('DELETE FROM comments WHERE post_id = ?').run(id);
      db.prepare('DELETE FROM saves WHERE post_id = ?').run(id);
      return json(res, 200, { ok: true });
    }

    if (m[3] === 'like' && method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      const has = db.prepare('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?').get(id, u.id);
      if (has) db.prepare('DELETE FROM likes WHERE post_id = ? AND user_id = ?').run(id, u.id);
      else db.prepare('INSERT INTO likes (post_id, user_id) VALUES (?,?)').run(id, u.id);
      return json(res, 200, { liked: !has });
    }

    if (m[3] === 'save' && method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      const has = db.prepare('SELECT 1 FROM saves WHERE post_id = ? AND user_id = ?').get(id, u.id);
      if (has) db.prepare('DELETE FROM saves WHERE post_id = ? AND user_id = ?').run(id, u.id);
      else db.prepare('INSERT INTO saves (post_id, user_id) VALUES (?,?)').run(id, u.id);
      return json(res, 200, { saved: !has });
    }

    if (m[3] === 'comments' && method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const text = String(body.text || '').trim().slice(0, 500);
      if (!text) return json(res, 400, { error: 'Comment is empty' });
      db.prepare('INSERT INTO comments (post_id, user_id, text) VALUES (?,?,?)').run(id, u.id, text);
      const list = db.prepare(
        `SELECT c.id, c.text, c.created_at, u.username, u.avatar FROM comments c
         JOIN users u ON u.id = c.user_id WHERE c.post_id = ? ORDER BY c.id ASC LIMIT 100`
      ).all(id);
      return json(res, 201, { comments: list });
    }
    return json(res, 405, { error: 'Method not allowed' });
  }

  /* ---- stories ---- */
  if (urlPath === '/api/stories' && method === 'GET') {
    const u = currentUser(req);
    const viewer = u ? u.id : null;
    const rows = db.prepare(
      `SELECT s.*, u.username, u.fullname, u.avatar FROM stories s JOIN users u ON u.id = s.user_id
       WHERE s.created_at > datetime('now','-1 day')
       AND (s.user_id = ? OR s.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?))
       ORDER BY s.id DESC`
    ).all(viewer || 0, viewer || 0);
    const groups = new Map();
    for (const s of rows) {
      if (!groups.has(s.user_id)) {
        groups.set(s.user_id, {
          user: { id: s.user_id, username: s.username, fullname: s.fullname, avatar: s.avatar || '' },
          stories: [],
        });
      }
      groups.get(s.user_id).stories.push({
        id: s.id, media: s.media, created_at: s.created_at,
        seen: viewer ? !!db.prepare('SELECT 1 FROM story_views WHERE story_id = ? AND user_id = ?').get(s.id, viewer) : false,
        views: db.prepare('SELECT COUNT(*) c FROM story_views WHERE story_id = ?').get(s.id).c,
      });
    }
    return json(res, 200, { groups: [...groups.values()] });
  }

  if (urlPath === '/api/stories' && method === 'POST') {
    const u = requireUser(req, res); if (!u) return;
    const raw = await readBody(req, 12 * 1024 * 1024);
    const ct = req.headers['content-type'] || '';
    if (!ct.startsWith('multipart/form-data'))
      return json(res, 400, { error: 'Send multipart form data with a "media" file' });
    const parts = parseMultipart(raw, '--' + ct.split('boundary=')[1]);
    const file = parts.find((p) => p.name === 'media' && p.filename);
    const saved = saveUpload(file, MEDIA_EXT, 10 * 1024 * 1024);
    if (saved.error) return json(res, 400, { error: saved.error });
    const info = db.prepare('INSERT INTO stories (user_id, media) VALUES (?,?)').run(u.id, saved.url);
    return json(res, 201, { id: info.lastInsertRowid, media: saved.url });
  }

  const sm = urlPath.match(/^\/api\/stories\/(\d+)(\/view)?$/);
  if (sm) {
    const id = Number(sm[1]);
    const story = db.prepare('SELECT * FROM stories WHERE id = ?').get(id);
    if (!story) return json(res, 404, { error: 'Story not found' });
    if (sm[2] && method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      db.prepare('INSERT OR IGNORE INTO story_views (story_id, user_id) VALUES (?,?)').run(id, u.id);
      return json(res, 200, { ok: true });
    }
    if (!sm[2] && method === 'DELETE') {
      const u = requireUser(req, res); if (!u) return;
      if (story.user_id !== u.id) return json(res, 403, { error: 'Not your story' });
      db.prepare('DELETE FROM stories WHERE id = ?').run(id);
      db.prepare('DELETE FROM story_views WHERE story_id = ?').run(id);
      return json(res, 200, { ok: true });
    }
  }

  /* ---- reels ---- */
  if (urlPath === '/api/reels' && method === 'GET') {
    const u = currentUser(req);
    const viewer = u ? u.id : null;
    const rows = db.prepare(`${REEL_SQL} ORDER BY r.id DESC LIMIT 50`).all();
    return json(res, 200, { reels: rows.map((r) => reelView(r, viewer)) });
  }

  if (urlPath === '/api/reels' && method === 'POST') {
    const u = requireUser(req, res); if (!u) return;
    const raw = await readBody(req, 60 * 1024 * 1024);
    const ct = req.headers['content-type'] || '';
    if (!ct.startsWith('multipart/form-data'))
      return json(res, 400, { error: 'Send multipart form data with a "video" file' });
    const parts = parseMultipart(raw, '--' + ct.split('boundary=')[1]);
    const file = parts.find((p) => p.name === 'video' && p.filename);
    const capPart = parts.find((p) => p.name === 'caption');
    const caption = capPart ? capPart.data.toString('utf8').slice(0, 1000) : '';
    const saved = saveUpload(file, VIDEO_EXT, 50 * 1024 * 1024);
    if (saved.error) return json(res, 400, { error: saved.error });
    const info = db.prepare('INSERT INTO reels (user_id, video, caption) VALUES (?,?,?)')
      .run(u.id, saved.url, caption);
    const row = db.prepare(`${REEL_SQL} WHERE r.id = ?`).get(info.lastInsertRowid);
    return json(res, 201, { reel: reelView(row, u.id) });
  }

  const rm = urlPath.match(/^\/api\/reels\/(\d+)(\/like)?$/);
  if (rm) {
    const id = Number(rm[1]);
    const reel = db.prepare('SELECT * FROM reels WHERE id = ?').get(id);
    if (!reel) return json(res, 404, { error: 'Reel not found' });
    if (rm[2] === '/like' && method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      const has = db.prepare('SELECT 1 FROM reel_likes WHERE reel_id = ? AND user_id = ?').get(id, u.id);
      if (has) db.prepare('DELETE FROM reel_likes WHERE reel_id = ? AND user_id = ?').run(id, u.id);
      else db.prepare('INSERT INTO reel_likes (reel_id, user_id) VALUES (?,?)').run(id, u.id);
      return json(res, 200, { liked: !has });
    }
    if (!rm[2] && method === 'DELETE') {
      const u = requireUser(req, res); if (!u) return;
      if (reel.user_id !== u.id) return json(res, 403, { error: 'Not your reel' });
      db.prepare('DELETE FROM reels WHERE id = ?').run(id);
      db.prepare('DELETE FROM reel_likes WHERE reel_id = ?').run(id);
      return json(res, 200, { ok: true });
    }
  }

  /* ---- profile ---- */
  if (urlPath === '/api/profile' && method === 'POST') {
    const u = requireUser(req, res); if (!u) return;
    const raw = await readBody(req, 12 * 1024 * 1024);
    const ct = req.headers['content-type'] || '';
    let fullname = u.fullname, bio = u.bio || '', avatar = u.avatar || '';
    if (ct.startsWith('multipart/form-data')) {
      const parts = parseMultipart(raw, '--' + ct.split('boundary=')[1]);
      const get = (n) => {
        const p = parts.find((x) => x.name === n);
        return p ? p.data.toString('utf8') : null;
      };
      if (get('fullname') !== null) fullname = get('fullname').trim().slice(0, 60);
      if (get('bio') !== null) bio = get('bio').trim().slice(0, 300);
      const file = parts.find((p) => p.name === 'avatar' && p.filename);
      if (file) {
        const saved = saveUpload(file, MEDIA_EXT, 5 * 1024 * 1024);
        if (saved.error) return json(res, 400, { error: saved.error });
        avatar = saved.url;
      }
    } else {
      const body = JSON.parse(raw.toString() || '{}');
      if (body.fullname) fullname = String(body.fullname).trim().slice(0, 60);
      if (body.bio !== undefined) bio = String(body.bio).trim().slice(0, 300);
    }
    if (fullname.length < 2) return json(res, 400, { error: 'Name too short' });
    db.prepare('UPDATE users SET fullname = ?, bio = ?, avatar = ? WHERE id = ?')
      .run(fullname, bio, avatar, u.id);
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
    return json(res, 200, { user: publicUser(fresh, u.id) });
  }

  /* ---- users ---- */
  if (urlPath === '/api/users/search' && method === 'GET') {
    const q = (query.get('q') || '').trim().toLowerCase();
    if (!q) return json(res, 200, { users: [] });
    const u = currentUser(req);
    const rows = db.prepare(
      `SELECT * FROM users WHERE username LIKE ? OR lower(fullname) LIKE ?
       ORDER BY username LIMIT 20`
    ).all(`%${q}%`, `%${q}%`);
    return json(res, 200, { users: rows.map((r) => publicUser(r, u ? u.id : null)) });
  }

  if (urlPath === '/api/users/suggested' && method === 'GET') {
    const u = currentUser(req);
    const viewer = u ? u.id : null;
    const rows = db.prepare(
      `SELECT * FROM users WHERE id != ?
       AND id NOT IN (SELECT following_id FROM follows WHERE follower_id = ?)
       ORDER BY id DESC LIMIT 10`
    ).all(viewer || 0, viewer || 0);
    return json(res, 200, { users: rows.map((r) => publicUser(r, viewer)) });
  }

  const um = urlPath.match(/^\/api\/users\/([a-z0-9._]+)(\/(follow|posts|followers|following))?$/);
  if (um) {
    const u = currentUser(req);
    const target = db.prepare('SELECT * FROM users WHERE username = ?').get(um[1]);
    if (!target) return json(res, 404, { error: 'User not found' });
    const viewer = u ? u.id : null;

    if (um[2] === '/follow' && method === 'POST') {
      const me = requireUser(req, res); if (!me) return;
      if (me.id === target.id) return json(res, 400, { error: "You can't follow yourself" });
      const has = db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?')
        .get(me.id, target.id);
      if (has) db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?')
        .run(me.id, target.id);
      else db.prepare('INSERT INTO follows (follower_id, following_id) VALUES (?,?)')
        .run(me.id, target.id);
      return json(res, 200, { following: !has, user: publicUser(target, me.id) });
    }

    if (um[2] === '/posts' && method === 'GET') {
      const rows = db.prepare(`${POST_SQL} WHERE p.user_id = ? ORDER BY p.id DESC`).all(target.id);
      return json(res, 200, {
        user: publicUser(target, viewer),
        posts: rows.map((p) => postView(p, viewer)),
      });
    }

    if (um[2] === '/followers' && method === 'GET') {
      const rows = db.prepare(
        `SELECT u.* FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.following_id = ?`
      ).all(target.id);
      return json(res, 200, { users: rows.map((r) => publicUser(r, viewer)) });
    }

    if (um[2] === '/following' && method === 'GET') {
      const rows = db.prepare(
        `SELECT u.* FROM follows f JOIN users u ON u.id = f.following_id WHERE f.follower_id = ?`
      ).all(target.id);
      return json(res, 200, { users: rows.map((r) => publicUser(r, viewer)) });
    }

    return json(res, 200, { user: publicUser(target, viewer) });
  }

  return json(res, 404, { error: 'Unknown endpoint' });
}

/* ---------------- multipart parser ---------------- */
function parseMultipart(buffer, boundary) {
  const parts = [];
  const b = Buffer.from(boundary);
  let start = buffer.indexOf(b);
  if (start === -1) return parts;
  start += b.length;
  while (start < buffer.length) {
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
    if (buffer.slice(start, start + 2).toString() === '--') break;
    const headerEnd = buffer.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;
    const headerStr = buffer.slice(start, headerEnd).toString('utf8');
    const next = buffer.indexOf(b, headerEnd);
    if (next === -1) break;
    let dataEnd = next;
    if (buffer[dataEnd - 2] === 13 && buffer[dataEnd - 1] === 10) dataEnd -= 2;
    const data = buffer.slice(headerEnd + 4, dataEnd);
    const nameM = headerStr.match(/name="([^"]*)"/i);
    const fileM = headerStr.match(/filename="([^"]*)"/i);
    if (nameM) parts.push({ name: nameM[1], filename: fileM ? fileM[1] : null, data });
    start = next + b.length;
  }
  return parts;
}

/* ---------------- server ---------------- */
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  const urlPath = parsed.pathname;
  try {
    if (urlPath.startsWith('/api/')) return await api(req, res, urlPath, parsed.searchParams);
    return serveStatic(req, res, urlPath);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('InstaClone running on http://localhost:' + PORT);
});
