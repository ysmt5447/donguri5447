const express = require('express'), crypto = require('crypto'), path = require('path');
const PR = require('./price.js');
PR.setSeed(process.env.PRICE_SEED || 'change-me');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');
const START = { d: 100000, k: 0, gd: 0, gk: 0 };     // 初期資金
const CLAIM_AMOUNT = 5000, CLAIM_INTERVAL = 3600e3;  // どんぐり拾い: 1時間ごと
const LEVS = [2, 5, 10, 25], LOSSCUT = 0.2;          // 残り証拠金が20%以下でロスカット
const KEYS = Object.keys(PR.PAIRS);

// ---- 保存先: DATABASE_URL があればPostgres、なければ data.json ----
let store;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const ready = pool.query('create table if not exists users(name text primary key, data jsonb not null)');
  store = {
    async get(n) { await ready; const r = await pool.query('select data from users where name=$1', [n]); return r.rows[0] ? r.rows[0].data : null; },
    async set(n, d) { await ready; await pool.query('insert into users(name,data) values($1,$2) on conflict(name) do update set data=$2', [n, d]); },
    async all() { await ready; return (await pool.query('select data from users')).rows.map((r) => r.data); },
  };
} else {
  const fs = require('fs'), F = 'data.json'; let db = {};
  try { db = JSON.parse(fs.readFileSync(F)); } catch {}
  store = { async get(n) { return db[n] || null; }, async set(n, d) { db[n] = d; fs.writeFileSync(F, JSON.stringify(db)); }, async all() { return Object.values(db); } };
}

const locks = {};
function withLock(n, fn) { const p = (locks[n] || Promise.resolve()).then(() => fn()); locks[n] = p.catch(() => {}); return p; }

// ---- ログイン ----
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function makeToken(name) { const p = Buffer.from(JSON.stringify({ n: name, e: Date.now() + 30 * 864e5 })).toString('base64url'); return p + '.' + sign(p); }
function readToken(t) {
  try { const [p, s] = String(t).split('.'); if (!p || sign(p) !== s) return null; const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.e > Date.now() ? o.n : null; } catch { return null; }
}
const need = (req, res, next) => { const n = readToken((req.headers.authorization || '').replace('Bearer ', '')); if (!n) return res.status(401).json({ error: 'ログインしてね' }); req.uname = n; next(); };
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); });
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const id = () => crypto.randomBytes(4).toString('hex');

function norm(u) { u.positions = u.positions || []; u.alerts = u.alerts || []; u.notices = u.notices || []; u.history = u.history || []; u.lastChecked = u.lastChecked || Date.now(); return u; }
const pub = (u) => ({ name: u.name, wallet: u.wallet, history: u.history, lastClaim: u.lastClaim, positions: u.positions, alerts: u.alerts, notices: u.notices });
const quotesAt = (t) => { const o = {}; KEYS.forEach((k) => { o[k] = PR.quote(k, t); }); return o; };
const rate = (pair, qs) => (PR.PAIRS[pair].quote === 'k' ? qs.KD.mid : 1);
function pnl(p, qs) { const q = qs[p.pair], cur = p.side === 'long' ? q.bid : q.ask; return p.units * (p.side === 'long' ? cur - p.entry : p.entry - cur) * rate(p.pair, qs); }
const equity = (p, qs) => p.margin + pnl(p, qs);
function valueOf(u, qs) {
  const w = u.wallet, K = qs.KD.mid; let v = w.d + w.k * K + w.gd * qs.GDD.mid + w.gk * qs.GKK.mid * K;
  (u.positions || []).forEach((p) => { v += Math.max(0, equity(p, qs)); }); return v;
}
function note(u, t, text) { u.notices.unshift({ id: id(), t, text, seen: false }); u.notices = u.notices.slice(0, 30); }
const fm = (x) => Math.round(x).toLocaleString('ja-JP');

// ---- 見ていない間に起きたこと（ロスカット・アラート）を、過去にさかのぼって判定 ----
function settle(u, now) {
  norm(u);
  const last = Math.max(u.lastChecked, now - 14 * 864e5); u.lastChecked = now;
  if (!u.positions.length && !u.alerts.length) return false;
  const step = Math.max(2, (now - last) / 1000 / 20000); let t = last / 1000;
  while (u.positions.length || u.alerts.length) {
    t = Math.min(t + step, now / 1000);
    const qs = quotesAt(t), ms = t * 1000;
    u.alerts = u.alerts.filter((a) => {
      if (a.t > ms) return true;
      const m = qs[a.pair].mid, hit = a.dir === 'above' ? m >= a.price : m <= a.price;
      if (hit) note(u, ms, `🔔 ${PR.PAIRS[a.pair].name} が ${fm(a.price)} ${a.dir === 'above' ? '以上' : '以下'}になりました（${fm(m)}）`);
      return !hit;
    });
    u.positions = u.positions.filter((p) => {
      if (p.t > ms) return true;
      const e = equity(p, qs);
      if (e > p.margin * LOSSCUT) return true;
      u.wallet.d = r4(u.wallet.d + Math.max(0, e));
      u.history.unshift({ t: ms, kind: 'losscut', pair: p.pair, pnl: r4(Math.max(0, e) - p.margin) });
      note(u, ms, `⚠️ ロスカット！ ${PR.PAIRS[p.pair].name} の${p.side === 'long' ? 'ロング' : 'ショート'}が自動で決済されました`);
      return false;
    });
    if (t >= now / 1000) break;
  }
  u.history = u.history.slice(0, 50);
  return true;
}

// ---- API ----
app.get('/api/prices', (req, res) => res.json({ now: Date.now(), prices: quotesAt(Date.now() / 1000) }));
app.get('/api/chart', (req, res) => {
  const k = req.query.pair, range = Math.min(Math.max(Number(req.query.range) || 300, 60), 604800 * 2);
  if (!PR.PAIRS[k]) return res.status(400).json({ error: 'pair?' });
  const now = Date.now() / 1000, pts = [];
  for (let i = 150; i >= 0; i--) pts.push(PR.quote(k, now - (range * i) / 150).mid);
  res.json({ pts });
});

app.post('/api/register', wrap(async (req, res) => {
  const { name, password } = req.body || {};
  if (!/^[A-Za-z0-9_ぁ-んァ-ヶ一-龠ー]{1,16}$/.test(name || '')) return res.status(400).json({ error: 'なまえは16文字まで（記号は _ のみ）' });
  if (!password || password.length < 4) return res.status(400).json({ error: 'パスワードは4文字以上' });
  if (await store.get(name)) return res.status(400).json({ error: 'そのなまえは使われています' });
  const salt = crypto.randomBytes(16).toString('hex');
  const u = norm({ name, salt, hash: hashPw(password, salt), wallet: { ...START }, lastClaim: 0 });
  await store.set(name, u);
  res.json({ token: makeToken(name), user: pub(u) });
}));

app.post('/api/login', wrap(async (req, res) => {
  const { name, password } = req.body || {};
  const u = await store.get(String(name));
  if (!u || hashPw(String(password), u.salt) !== u.hash) return res.status(401).json({ error: 'なまえかパスワードが違います' });
  res.json({ token: makeToken(u.name), user: pub(norm(u)) });
}));

// 画面から定期的に呼ばれる。ここで「さかのぼり判定」も行う
app.get('/api/me', need, wrap(async (req, res) => {
  await withLock(req.uname, async () => {
    const u = await store.get(req.uname); if (!u) return res.status(401).json({ error: 'ユーザーなし' });
    if (settle(u, Date.now())) await store.set(u.name, u);
    res.json(pub(u));
  });
}));

app.post('/api/seen', need, wrap(async (req, res) => {
  await withLock(req.uname, async () => {
    const u = norm(await store.get(req.uname)); u.notices.forEach((n) => { n.seen = true; });
    await store.set(u.name, u); res.json(pub(u));
  });
}));

// 現物取引
const TP = { KD: { b: 'k', q: 'd' }, GDD: { b: 'gd', q: 'd' }, GKK: { b: 'gk', q: 'k' } };
app.post('/api/trade', need, wrap(async (req, res) => {
  const { pair, side } = req.body || {}; const amount = r4(Number(req.body.amount)); const p = TP[pair];
  if (!p || !['buy', 'sell'].includes(side) || !(amount > 0)) return res.status(400).json({ error: '注文が正しくありません' });
  await withLock(req.uname, async () => {
    const u = norm(await store.get(req.uname)), w = u.wallet, q = PR.quote(pair, Date.now() / 1000); let cost;
    if (side === 'buy') { cost = r4(amount * q.ask); if (w[p.q] < cost) return res.status(400).json({ error: '残高が足りません' }); w[p.q] = r4(w[p.q] - cost); w[p.b] = r4(w[p.b] + amount); }
    else { cost = r4(amount * q.bid); if (w[p.b] < amount) return res.status(400).json({ error: '持っている数が足りません' }); w[p.b] = r4(w[p.b] - amount); w[p.q] = r4(w[p.q] + cost); }
    u.history.unshift({ t: Date.now(), kind: 'spot', pair, side, amount, price: side === 'buy' ? q.ask : q.bid, total: cost });
    u.history = u.history.slice(0, 50);
    await store.set(u.name, u); res.json(pub(u));
  });
}));

// レバレッジ取引：新規
app.post('/api/open', need, wrap(async (req, res) => {
  const { pair, side } = req.body || {}; const units = r4(Number(req.body.units)), lev = Number(req.body.lev);
  if (!PR.PAIRS[pair] || !['long', 'short'].includes(side) || !(units > 0) || !LEVS.includes(lev)) return res.status(400).json({ error: '注文が正しくありません' });
  await withLock(req.uname, async () => {
    const u = norm(await store.get(req.uname)); settle(u, Date.now());
    if (u.positions.length >= 10) return res.status(400).json({ error: 'ポジションは10個までです' });
    const now = Date.now(), qs = quotesAt(now / 1000), q = qs[pair], entry = side === 'long' ? q.ask : q.bid;
    const margin = r4((units * entry * rate(pair, qs)) / lev);
    if (margin < 1) return res.status(400).json({ error: '数量が小さすぎます' });
    if (u.wallet.d < margin) return res.status(400).json({ error: `証拠金が足りません（必要：${fm(margin)}どんぐり）` });
    u.wallet.d = r4(u.wallet.d - margin);
    u.positions.push({ id: id(), pair, side, units, lev, entry, margin, t: now });
    u.history.unshift({ t: now, kind: 'open', pair, side, units, lev, price: entry });
    u.history = u.history.slice(0, 50);
    await store.set(u.name, u); res.json(pub(u));
  });
}));

// レバレッジ取引：決済
app.post('/api/close', need, wrap(async (req, res) => {
  await withLock(req.uname, async () => {
    const u = norm(await store.get(req.uname)); settle(u, Date.now());
    const i = u.positions.findIndex((p) => p.id === (req.body || {}).id);
    if (i < 0) { await store.set(u.name, u); return res.status(400).json({ error: 'そのポジションはもうありません（ロスカットされたかも）' }); }
    const p = u.positions[i], e = equity(p, quotesAt(Date.now() / 1000));
    u.wallet.d = r4(u.wallet.d + Math.max(0, e)); u.positions.splice(i, 1);
    u.history.unshift({ t: Date.now(), kind: 'close', pair: p.pair, pnl: r4(Math.max(0, e) - p.margin) });
    u.history = u.history.slice(0, 50);
    await store.set(u.name, u); res.json(pub(u));
  });
}));

// 価格アラート
app.post('/api/alert', need, wrap(async (req, res) => {
  const { pair, dir } = req.body || {}, price = Number(req.body.price);
  if (!PR.PAIRS[pair] || !['above', 'below'].includes(dir) || !(price > 0) || !isFinite(price)) return res.status(400).json({ error: 'アラートの内容が正しくありません' });
  await withLock(req.uname, async () => {
    const u = norm(await store.get(req.uname)); settle(u, Date.now());
    if (u.alerts.length >= 10) return res.status(400).json({ error: 'アラートは10個までです' });
    u.alerts.push({ id: id(), pair, dir, price, t: Date.now() });
    await store.set(u.name, u); res.json(pub(u));
  });
}));
app.post('/api/alert/del', need, wrap(async (req, res) => {
  await withLock(req.uname, async () => {
    const u = norm(await store.get(req.uname)); u.alerts = u.alerts.filter((a) => a.id !== (req.body || {}).id);
    await store.set(u.name, u); res.json(pub(u));
  });
}));

// ランキング（ぜんぶの価値 = どんぐり換算）
let rc = { t: 0, v: [] };
app.get('/api/ranking', need, wrap(async (req, res) => {
  if (Date.now() - rc.t > 5000) {
    const qs = quotesAt(Date.now() / 1000);
    const v = (await store.all()).map((u) => ({ name: u.name, total: valueOf(u, qs), gold: u.wallet.gd >= 1 })).sort((a, b) => b.total - a.total);
    rc = { t: Date.now(), v };
  }
  const i = rc.v.findIndex((x) => x.name === req.uname);
  res.json({ top: rc.v.slice(0, 20), me: i < 0 ? null : { rank: i + 1, ...rc.v[i] }, count: rc.v.length });
}));

app.post('/api/claim', need, wrap(async (req, res) => {
  await withLock(req.uname, async () => {
    const u = norm(await store.get(req.uname)), now = Date.now();
    if (now - u.lastClaim < CLAIM_INTERVAL) return res.status(400).json({ error: 'まだ落ちてないみたい（1時間に1回）' });
    u.wallet.d = r4(u.wallet.d + CLAIM_AMOUNT); u.lastClaim = now;
    await store.set(u.name, u); res.json(pub(u));
  });
}));

app.listen(process.env.PORT || 3000, () => console.log('donguri-fx running'));
