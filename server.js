/* ============================================================
 * Yisi Store 亿丝应用商店 - 后端服务器
 * 零依赖（仅用 Node.js 内置模块），JSON 文件存储，一键启动
 * 启动: node server.js   (默认端口 8080, 可用环境变量 PORT 修改)
 * ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;   // 单个文件上限 30MB
const MAX_BODY_BYTES = 45 * 1024 * 1024;     // JSON请求体上限 45MB（base64膨胀）

/* ---------------- 管理员账号（仅此一处，APP内不展示） ---------------- */
const ADMIN_USERNAME = '管理员';
const ADMIN_PASSWORD = '123456789';

/* ---------------- 数据层 ---------------- */
const AVATAR_COLORS = ['#1E6FFF', '#FF6F1E', '#12B76A', '#9B51E0', '#F04438', '#0EA5E9', '#F59E0B', '#EC4899', '#10B981', '#6366F1'];

function emptyDb() {
  return {
    users: [],        // {id, username, password, salt, nickname, bio, avatarColor, time}
    posts: [],        // {id, uid, content, time, likes:[uid], comments:[{uid, content, time}]}
    messages: [],     // {id, from, to, content, time}
    apps: [],         // {id, uid, name, icon, category, version, desc, downloadUrl, size, status, reason, time, auditTime}
    sessions: {},     // token -> {uid | 'admin'}
    seq: { user: 1, post: 1, msg: 1, app: 1 }
  };
}

let db = emptyDb();
let saveTimer = null;

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      db = Object.assign(emptyDb(), parsed);
    }
  } catch (e) {
    console.error('[DB] 读取失败，使用空库:', e.message);
    db = emptyDb();
  }
}

function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch (e) {
      console.error('[DB] 保存失败:', e.message);
    }
  }, 150);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function publicUser(u) {
  return { id: u.id, username: u.username, nickname: u.nickname, bio: u.bio, avatarColor: u.avatarColor, time: u.time };
}

function now() {
  return new Date().toISOString();
}

/* ---------------- 工具 ---------------- */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > MAX_BODY_BYTES) { reject(new Error('请求体过大')); req.destroy(); } });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, data) {
  const payload = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization'
  });
  res.end(payload);
}

function ok(res, data) { sendJson(res, 200, { ok: true, ...data }); }
function fail(res, code, msg) { sendJson(res, code, { ok: false, error: msg }); }

function getToken(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

function authUser(req) {
  const t = getToken(req);
  if (!t || !db.sessions[t]) return null;
  if (db.sessions[t] === 'admin') {
    // 管理员也可参与发帖/评论/私信（uid=0 虚拟身份）
    return { id: 0, username: '管理员', nickname: '管理员', bio: 'Yisi Store 管理员', avatarColor: '#FF5A2C', role: 'admin' };
  }
  const uid = db.sessions[t];
  const u = db.users.find(x => x.id === uid);
  return u || null;
}

function authAdmin(req) {
  const t = getToken(req);
  return t && db.sessions[t] === 'admin';
}

function normalizeName(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}

/* ---------------- 文件上传辅助 ---------------- */
function safeExt(name) {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : 'bin';
}

function formatSize(bytes) {
  const n = parseInt(bytes, 10) || 0;
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + 'GB';
}

// 校验并保存 base64 上传的文件，返回附件对象（url 为相对路径 /uploads/xxx）
function saveUploadedFile(fileName, dataBase64) {
  fileName = normalizeName(fileName);
  if (!fileName || fileName.length > 100) throw new Error('文件名无效');
  if (!dataBase64) throw new Error('文件内容为空');
  const buf = Buffer.from(dataBase64, 'base64');
  if (buf.length === 0) throw new Error('文件内容无效');
  if (buf.length > MAX_UPLOAD_BYTES) throw new Error('文件超过 30MB 上限');
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const id = crypto.randomBytes(10).toString('hex');
  const storedName = id + '.' + safeExt(fileName);
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), buf);
  return {
    fileName: fileName,
    fileSize: buf.length,
    fileSizeText: formatSize(buf.length),
    fileUrl: '/uploads/' + storedName,
    fileType: safeExt(fileName)
  };
}

/* ---------------- 路由 ---------------- */
const routes = [];

function compilePattern(p) {
  // 将 :xxx 路径参数转换为匹配数字的正则组
  const re = p.replace(/:[A-Za-z0-9_]+/g, '([0-9]+)');
  return new RegExp('^' + re + '$');
}

function route(method, pattern, handler) {
  routes.push({ method, pattern: compilePattern(pattern), handler });
}

/* 健康检查 */
route('GET', '/api/health', async (req, res) => ok(res, { server: 'yisi-store', time: now(), users: db.users.length, apps: db.apps.length, posts: db.posts.length }));

/* 文件上传（base64），返回附件对象 */
route('POST', '/api/upload', async (req, res) => {
  const b = await parseBody(req);
  const att = saveUploadedFile(b.fileName, b.data);
  ok(res, { attachment: att });
});

/* 用户列表：?q=关键词 搜索；?all=1 返回全部（用于共创勾选） */
route('GET', '/api/users', async (req, res) => {
  const u = authUser(req);
  if (!u) return fail(res, 401, '未登录');
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('all') === '1') {
    const list = db.users.filter(x => x.id !== u.id).map(publicUser);
    return ok(res, { users: list });
  }
  const q = normalizeName(url.searchParams.get('q') || '');
  if (!q) return ok(res, { users: [] });
  const list = db.users
    .filter(x => x.id !== u.id && (x.username.includes(q) || x.nickname.includes(q)))
    .slice(0, 30)
    .map(publicUser);
  ok(res, { users: list });
});

/* 注册 */
route('POST', '/api/register', async (req, res) => {
  const b = await parseBody(req);
  const username = normalizeName(b.username);
  const password = String(b.password || '');
  const nickname = normalizeName(b.nickname) || username;
  if (!username || username.length < 2 || username.length > 20) return fail(res, 400, '用户名需 2-20 个字符');
  if (!password || password.length < 6) return fail(res, 400, '密码至少 6 位');
  if (username === ADMIN_USERNAME) return fail(res, 400, '该用户名已被占用');
  if (db.users.some(u => u.username === username)) return fail(res, 409, '用户名已被注册');
  const salt = crypto.randomBytes(8).toString('hex');
  const user = {
    id: db.seq.user++,
    username,
    password: sha256(password + salt),
    salt,
    nickname,
    bio: '这个人很懒~',
    avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
    time: now()
  };
  db.users.push(user);
  const token = newToken();
  db.sessions[token] = user.id;
  saveDb();
  ok(res, { token, user: publicUser(user) });
});

/* 登录（含管理员） */
route('POST', '/api/login', async (req, res) => {
  const b = await parseBody(req);
  const username = normalizeName(b.username);
  const password = String(b.password || '');
  if (!username || !password) return fail(res, 400, '请输入用户名和密码');

  if (username === ADMIN_USERNAME) {
    if (password !== ADMIN_PASSWORD) return fail(res, 401, '用户名或密码错误');
    const token = newToken();
    db.sessions[token] = 'admin';
    saveDb();
    return ok(res, { token, user: { id: 0, username: ADMIN_USERNAME, nickname: '管理员', bio: 'Yisi Store 管理员', avatarColor: '#FF5A2C', role: 'admin' } });
  }

  const u = db.users.find(x => x.username === username);
  if (!u || u.password !== sha256(password + u.salt)) return fail(res, 401, '用户名或密码错误');
  const token = newToken();
  db.sessions[token] = u.id;
  saveDb();
  ok(res, { token, user: publicUser(u) });
});

/* 当前用户信息 */
route('GET', '/api/me', async (req, res) => {
  const u = authUser(req);
  if (!u) return fail(res, 401, '未登录');
  ok(res, { user: publicUser(u) });
});

/* 更新资料 */
route('POST', '/api/me', async (req, res) => {
  const u = authUser(req);
  if (!u) return fail(res, 401, '未登录');
  const b = await parseBody(req);
  if (b.nickname !== undefined) {
    const n = normalizeName(b.nickname);
    if (!n || n.length < 1 || n.length > 16) return fail(res, 400, '昵称需 1-16 个字符');
    u.nickname = n;
  }
  if (b.bio !== undefined) {
    const bio = normalizeName(b.bio);
    if (bio.length > 60) return fail(res, 400, '简介最多 60 个字符');
    u.bio = bio || '这个人很懒~';
  }
  saveDb();
  ok(res, { user: publicUser(u) });
});

/* 会话列表 */
route('GET', '/api/conversations', async (req, res) => {
  const u = authUser(req);
  if (!u) return fail(res, 401, '未登录');
  const peers = new Map();
  db.messages.filter(m => m.from === u.id || m.to === u.id).forEach(m => {
    const peerId = m.from === u.id ? m.to : m.from;
    if (!peers.has(peerId) || m.time > peers.get(peerId).time) peers.set(peerId, { time: m.time, content: m.content, from: m.from });
  });
  const convs = [...peers.entries()].map(([pid, last]) => {
    let p = db.users.find(x => x.id === pid);
    if (!p) {
      p = pid === 0
        ? { id: 0, username: '管理员', nickname: '管理员', bio: 'Yisi Store 管理员', avatarColor: '#FF5A2C' }
        : { id: pid, username: '已注销', nickname: '已注销', avatarColor: '#999' };
    }
    return { peer: p, last: last };
  });
  convs.sort((a, b) => (b.last.time < a.last.time ? -1 : 1));
  ok(res, { conversations: convs });
});

/* 与某人的聊天记录 */
route('GET', '/api/messages', async (req, res) => {
  const u = authUser(req);
  if (!u) return fail(res, 401, '未登录');
  const url = new URL(req.url, 'http://x');
  const peerId = parseInt(url.searchParams.get('peer') || '0', 10);
  const after = url.searchParams.get('after') || '';
  const list = db.messages
    .filter(m => (m.from === u.id && m.to === peerId) || (m.from === peerId && m.to === u.id))
    .filter(m => !after || m.time > after)
    .slice(-200);
  ok(res, { messages: list, peerId });
});

/* 发送私信（支持附件：b.attachment 为上传接口返回的对象） */
route('POST', '/api/messages', async (req, res) => {
  const u = authUser(req);
  if (!u) return fail(res, 401, '未登录');
  const b = await parseBody(req);
  const to = parseInt(b.to, 10);
  const content = String(b.content || '').trim();
  if (!to || !db.users.some(x => x.id === to)) return fail(res, 404, '用户不存在');
  const att = b.attachment || null;
  if (att && typeof att === 'object') {
    if (!att.fileUrl || typeof att.fileUrl !== 'string' || !att.fileUrl.startsWith('/uploads/')) {
      return fail(res, 400, '附件无效，请重新上传');
    }
  }
  if ((!content && !att) || (content && content.length > 1000)) return fail(res, 400, '消息内容不能为空且最多 1000 字');
  const msg = { id: db.seq.msg++, from: u.id, to, content, attachment: att || undefined, time: now() };
  db.messages.push(msg);
  saveDb();
  ok(res, { message: msg });
});

/* 论坛帖子流 */
route('GET', '/api/posts', async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const size = 20;
  const sorted = [...db.posts].sort((a, b) => (a.time < b.time ? 1 : -1));
  const list = sorted.slice((page - 1) * size, page * size).map(p => {
    let u = db.users.find(x => x.id === p.uid);
    if (!u && p.uid === 0) u = { id: 0, username: '管理员', nickname: '管理员', bio: 'Yisi Store 管理员', avatarColor: '#FF5A2C' };
    return { ...p, user: u ? publicUser(u) : null };
  });
  ok(res, { posts: list, total: db.posts.length, page, hasMore: page * size < db.posts.length });
});

/* 发帖（支持附件） */
route('POST', '/api/posts', async (req, res) => {
  const u = authUser(req);
  if (!u) return fail(res, 401, '未登录');
  const b = await parseBody(req);
  const content = String(b.content || '').trim();
  const att = b.attachment || null;
  if (att && typeof att === 'object') {
    if (!att.fileUrl || typeof att.fileUrl !== 'string' || !att.fileUrl.startsWith('/uploads/')) {
      return fail(res, 400, '附件无效，请重新上传');
    }
  }
  if ((!content && !att) || (content && content.length > 1000)) return fail(res, 400, '帖子内容 1-1000 字');
  const post = { id: db.seq.post++, uid: u.id, content, attachment: att || undefined, time: now(), likes: [], comments: [] };
  db.posts.push(post);
  saveDb();
  ok(res, { post: { ...post, user: publicUser(u) } });
});

/* 评论（支持回复：b.parentId 指定回复哪条评论） */
route('POST', '/api/posts/:id/comments', async (req, res, m) => {
  const u = authUser(req);
  if (!u) return fail(res, 401, '未登录');
  const pid = parseInt(m[1], 10);
  const post = db.posts.find(x => x.id === pid);
  if (!post) return fail(res, 404, '帖子不存在');
  const b = await parseBody(req);
  const content = String(b.content || '').trim();
  if (!content || content.length > 500) return fail(res, 400, '评论 1-500 字');
  const comment = { uid: u.id, nickname: u.nickname, avatarColor: u.avatarColor, content, time: now() };
  const parentId = parseInt(b.parentId, 10);
  if (parentId) {
    const parent = post.comments.find(c => c.id === parentId);
    if (parent) {
      comment.parentId = parentId;
      comment.parentNickname = parent.nickname || '用户';
    }
  }
  comment.id = (post.comments.length ? Math.max(...post.comments.map(c => c.id)) : 0) + 1;
  post.comments.push(comment);
  saveDb();
  ok(res, { post });
});

/* 点赞 */
route('POST', '/api/posts/:id/like', async (req, res, m) => {
  const u = authUser(req);
  if (!u) return fail(res, 401, '未登录');
  const pid = parseInt(m[1], 10);
  const post = db.posts.find(x => x.id === pid);
  if (!post) return fail(res, 404, '帖子不存在');
  const idx = post.likes.indexOf(u.id);
  if (idx >= 0) post.likes.splice(idx, 1); else post.likes.push(u.id);
  saveDb();
  ok(res, { likes: post.likes.length, liked: idx < 0 });
});

/* 已上架应用（仅审核通过的展示给所有人） */
route('GET', '/api/apps', async (req, res) => {
  const list = db.apps.filter(a => a.status === 'approved').sort((a, b) => (a.time < b.time ? 1 : -1));
  ok(res, { apps: list.map(a => appPublic(a)) });
});

function appPublic(a) {
  const ratings = a.ratings || {};
  const cnt = Object.keys(ratings).length;
  const sum = Object.values(ratings).reduce((s, v) => s + v, 0);
  const rating = cnt ? Math.round((sum / cnt) * 10) / 10 : 0;
  const co = (a.coAuthors || []).map(uid => {
    const u = db.users.find(x => x.id === uid);
    return u ? { id: u.id, username: u.username, nickname: u.nickname, avatarColor: u.avatarColor } : null;
  }).filter(Boolean);
  return { id: a.id, name: a.name, icon: a.icon, category: a.category, version: a.version, desc: a.desc, downloadUrl: a.downloadUrl, size: a.size, time: a.time, uid: a.uid, rating, ratingCount: cnt, coAuthors: co };
}

/* 评分（1-5星，每人只能评一次，重复评分会覆盖自己的） */
route('POST', '/api/apps/:id/rate', async (req, res, m) => {
  const u = authUser(req);
  if (!u) return fail(res, 401, '未登录');
  const id = parseInt(m[1], 10);
  const app = db.apps.find(x => x.id === id);
  if (!app) return fail(res, 404, '应用不存在');
  const b = await parseBody(req);
  const score = parseInt(b.score, 10);
  if (!score || score < 1 || score > 5) return fail(res, 400, '评分需为 1-5 星');
  if (!app.ratings) app.ratings = {};
  app.ratings[u.id] = score;
  saveDb();
  const p = appPublic(app);
  ok(res, { rating: p.rating, ratingCount: p.ratingCount, my: score });
});

/* 搜索应用 */
route('GET', '/api/apps/search', async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = normalizeName(url.searchParams.get('q') || '');
  let list = db.apps.filter(a => a.status === 'approved');
  if (q) list = list.filter(a => a.name.includes(q) || a.desc.includes(q) || a.category.includes(q));
  list.sort((a, b) => (a.time < b.time ? 1 : -1));
  ok(res, { apps: list });
});

/* 提交上架申请（支持直接上传文件：b.fileName+b.data(base64)；支持共创人 b.coAuthors=[uid]） */
route('POST', '/api/apps', async (req, res) => {
  const u = authUser(req);
  if (!u) return fail(res, 401, '未登录');
  const b = await parseBody(req);
  const name = normalizeName(b.name);
  const desc = normalizeName(b.desc);
  const version = normalizeName(b.version) || '1.0.0';
  const category = normalizeName(b.category) || '其他';
  const icon = String(b.icon || '').trim() || '📦';
  let size = String(b.size || '').trim();
  if (!name || name.length > 30) return fail(res, 400, '应用名称 1-30 字');
  if (!desc || desc.length > 200) return fail(res, 400, '应用简介 1-200 字');
  let downloadUrl = String(b.downloadUrl || '').trim();
  // 优先处理直接上传的文件：自动保存并生成下载链接
  if (b.fileName && b.data) {
    const att = saveUploadedFile(b.fileName, b.data);
    downloadUrl = att.fileUrl;
    if (!size) size = att.fileSizeText;
  }
  if (!downloadUrl || !/^(\/uploads\/|https?:\/\/)/i.test(downloadUrl)) return fail(res, 400, '请填写有效的下载链接(http/https)或上传应用文件');
  // 共创人：过滤出真实存在的用户，且不包含自己
  const coAuthors = Array.isArray(b.coAuthors)
    ? [...new Set(b.coAuthors.map(x => parseInt(x, 10)).filter(x => x && x !== u.id && db.users.some(us => us.id === x)))]
    : [];
  const app = { id: db.seq.app++, uid: u.id, name, icon, category, version, desc, downloadUrl, size, coAuthors, status: 'pending', reason: '', time: now(), auditTime: '', ratings: {} };
  db.apps.push(app);
  saveDb();
  ok(res, { app: appPublic(app) });
});

/* 我的发布 */
route('GET', '/api/my/apps', async (req, res) => {
  const u = authUser(req);
  if (!u) return fail(res, 401, '未登录');
  const list = db.apps.filter(a => a.uid === u.id).sort((a, b) => (a.time < b.time ? 1 : -1));
  ok(res, { apps: list.map(a => ({ ...a, coInfo: coInfoOf(a) })) });
});

function coInfoOf(a) {
  return (a.coAuthors || []).map(uid => {
    const u = db.users.find(x => x.id === uid);
    return u ? { id: u.id, username: u.username, nickname: u.nickname, avatarColor: u.avatarColor } : null;
  }).filter(Boolean);
}

/* 管理员：待审核列表 */
route('GET', '/api/admin/apps', async (req, res) => {
  if (!authAdmin(req)) return fail(res, 403, '需要管理员权限');
  const list = db.apps.filter(a => a.status === 'pending').sort((a, b) => (a.time < b.time ? 1 : -1));
  ok(res, { apps: list.map(a => ({ ...a, user: db.users.find(x => x.id === a.uid) ? publicUser(db.users.find(x => x.id === a.uid)) : null, coInfo: coInfoOf(a) })) });
});

/* 管理员：通过 */
route('POST', '/api/admin/apps/:id/approve', async (req, res, m) => {
  if (!authAdmin(req)) return fail(res, 403, '需要管理员权限');
  const id = parseInt(m[1], 10);
  const app = db.apps.find(x => x.id === id);
  if (!app) return fail(res, 404, '应用不存在');
  app.status = 'approved';
  app.auditTime = now();
  saveDb();
  ok(res, { app });
});

/* 管理员：拒绝 */
route('POST', '/api/admin/apps/:id/reject', async (req, res, m) => {
  if (!authAdmin(req)) return fail(res, 403, '需要管理员权限');
  const id = parseInt(m[1], 10);
  const app = db.apps.find(x => x.id === id);
  if (!app) return fail(res, 404, '应用不存在');
  const b = await parseBody(req);
  app.status = 'rejected';
  app.reason = normalizeName(b.reason) || '未通过审核';
  app.auditTime = now();
  saveDb();
  ok(res, { app });
});

/* ---------------- 服务器 ---------------- */
const MIME = {
  apk: 'application/vnd.android.package-archive', zip: 'application/zip', rar: 'application/x-rar-compressed',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', mp4: 'video/mp4', txt: 'text/plain',
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', json: 'application/json'
};

const handler = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  const url = new URL(req.url, 'http://x');

  /* 静态文件：/uploads/xxx 提供下载 */
  if (req.method === 'GET' && url.pathname.startsWith('/uploads/')) {
    const fname = path.basename(url.pathname);
    const fpath = path.join(UPLOAD_DIR, fname);
    try {
      if (!fs.existsSync(fpath)) return fail(res, 404, '文件不存在');
      const stat = fs.statSync(fpath);
      const ext = safeExt(fname);
      const type = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Content-Disposition': 'attachment; filename="' + fname + '"',
        'Cache-Control': 'max-age=86400'
      });
      fs.createReadStream(fpath).pipe(res);
    } catch (e) {
      fail(res, 500, '读取文件失败');
    }
    return;
  }

  let matched = false;
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.pattern);
    if (m) {
      matched = true;
      try { await r.handler(req, res, m); }
      catch (e) {
        console.error('[ERR]', req.method, url.pathname, e.message);
        fail(res, 400, e.message || '服务器错误');
      }
      break;
    }
  }
  if (!matched) fail(res, 404, '接口不存在');
};

function startServer(port) {
  port = parseInt(port, 10) || 8080;
  const server = http.createServer(handler);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log('[提示] 端口 ' + port + ' 被占用，自动改用端口 ' + (port + 1) + ' ...');
      startServer(port + 1);
    } else {
      console.error('[错误] 服务器启动失败: ' + e.message);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    console.log('==============================================');
    console.log('  Yisi Store 亿丝应用商店 - 服务器已启动');
    console.log('  本机访问:   http://127.0.0.1:' + port);
    console.log('  局域网访问: http://<本机IP>:' + port);
    console.log('  查看本机IP(Windows): ipconfig  | (Mac/Linux): ifconfig / ip addr');
    console.log('  手机连接同一WiFi后, 在APP"我的-服务器设置"中填写上面的地址');
    console.log('==============================================');
  });
}

loadDb();
startServer(PORT);
