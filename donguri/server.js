const express = require('express'), crypto = require('crypto'), path = require('path');
const Orders = require('./orders.js');
const LOCAL_TEST = process.env.LOCAL_TEST === '1';
const PR = require('./price.js');
PR.setSeed(process.env.PRICE_SEED || 'change-me');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');
const START = { d: 100000, k: 0, gd: 0 };
const GOLD = 10000000;  // 金のどんぐり 1こ = 1,000万どんぐり（ずっと同じ）     // 初期資金
const CLAIM_AMOUNT = 5000, CLAIM_INTERVAL = 3600e3;  // どんぐり拾い: 1時間ごと
const LEVS = [2, 5, 10, 25, 75, 100], LOSSCUT = 0.2;          // 残り証拠金が20%以下でロスカット
const KEYS = Object.keys(PR.PAIRS);

// ---- 保存先: DATABASE_URL があればPostgres、なければ data.json ----
let store;
if (LOCAL_TEST) {
  const db = new Map();
  store = {
    async get(n) { return db.has(n) ? structuredClone(db.get(n)) : null; },
    async set(n, d) { db.set(n, structuredClone(d)); },
    async all() { return [...db.values()].map(d => structuredClone(d)); },
  };
} else if (process.env.DATABASE_URL) {
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

function norm(u) {
  u.orders = u.orders || []; u.positions = u.positions || []; u.alerts = u.alerts || []; u.notices = u.notices || []; u.history = u.history || []; u.lastChecked = u.lastChecked || Date.now();
  if (u.v !== 2) { // 旧バージョン（金のくるみ・金の値動きあり）からの移行
    u.positions = u.positions.filter((p) => { if (p.pair === 'KD') return true; u.wallet.d = r4(u.wallet.d + p.margin); return false; });
    u.alerts = u.alerts.filter((a) => a.pair === 'KD');
    if (u.wallet.gk > 0) u.wallet.d = r4(u.wallet.d + u.wallet.gk * 200000 * 150);
    delete u.wallet.gk;
    const f = u.wallet.gd - Math.floor(u.wallet.gd);
    if (f > 0) { u.wallet.d = r4(u.wallet.d + f * GOLD); u.wallet.gd = Math.floor(u.wallet.gd); }
    u.v = 2;
  }
  return u;
}
const pub = (u) => ({ name: u.name, wallet: u.wallet, history: u.history, lastClaim: u.lastClaim, positions: u.positions, orders: u.orders || [], alerts: u.alerts, notices: u.notices });
const quotesAt = (t) => { const o = {}; KEYS.forEach((k) => { o[k] = PR.quote(k, t); }); return o; };
const rate = (pair, qs) => (PR.PAIRS[pair].quote === 'k' ? qs.KD.mid : 1);
function pnl(p, qs) { const q = qs[p.pair], cur = p.side === 'long' ? q.bid : q.ask; return p.units * (p.side === 'long' ? cur - p.entry : p.entry - cur) * rate(p.pair, qs); }
const equity = (p, qs) => p.margin + pnl(p, qs);
function valueOf(u, qs) {
  const w = u.wallet, K = qs.KD.mid; let v = w.d + w.k * K + w.gd * GOLD + (w.gk || 0) * 30000000;
  (u.positions || []).forEach((p) => { v += qs[p.pair] ? Math.max(0, equity(p, qs)) : p.margin; }); return v;
}
function note(u, t, text) { u.notices.unshift({ id: id(), t, text, seen: false }); u.notices = u.notices.slice(0, 30); }
const fm = (x) => Math.round(x).toLocaleString('ja-JP');

// ---- 見ていない間に起きたこと（ロスカット・アラート）を、過去にさかのぼって判定 ----
function settle(u, now) {
  norm(u);
  // Fixed UTC grid: results do not depend on how often a player opens the page.
  const end = Math.floor(now / 2000) * 2000;
  const last = Math.max(Math.floor(u.lastChecked / 2000) * 2000, end - 14 * 864e5);
  u.lastChecked = Math.max(u.lastChecked, end);
  if (!u.positions.length && !u.alerts.length && !u.orders.length) return false;
  for (let ms = last + 2000; ms <= end; ms += 2000) {
    const qs = quotesAt(ms / 1000);
    u.alerts = u.alerts.filter((a) => {
      if (a.t > ms) return true;
      const m = qs[a.pair].mid, hit = a.dir === 'above' ? m >= a.price : m <= a.price;
      if (hit) note(u, ms, `🔔 ${PR.PAIRS[a.pair].name} が ${fm(a.price)} ${a.dir === 'above' ? '以上' : '以下'}になりました（${fm(m)}）`);
      return !hit;
    });
    Orders.tick(u, qs, ms, { id, note, equity, rate, lossCut: LOSSCUT });
    if (!u.positions.length && !u.alerts.length && !u.orders.length) break;
  }
  u.history = u.history.slice(0, 50);
  return true;
}

async function account(req) {
  const u = norm(await store.get(req.uname));
  settle(u, Date.now());
  await store.set(u.name, u);
  return u;
}
const levelValue = x => x === '' || x == null ? null : Number(x);

// ---- API ----
app.get('/api/news', (req, res) => {
  const now = Date.now();
  res.set('Cache-Control', 'no-store');
  res.json({ now, simulated: true, items: PR.news(now / 1000) });
});
app.get('/api/prices', (req, res) => res.json({ now: Date.now(), prices: quotesAt(Date.now() / 1000) }));
app.get('/api/chart', (req, res) => {
  const k = req.query.pair, range = Math.min(Math.max(Number(req.query.range) || 300, 60), 604800 * 2);
  if (!PR.PAIRS[k]) return res.status(400).json({ error: 'pair?' });
  const N = 60, S = 12, now = Date.now() / 1000, candles = [];
  for (let i = 0; i < N; i++) {                       // ローソク足1本 = range/N 秒
    const t0 = now - (range * (N - i)) / N, dt = range / N / S; let o, c, h = -Infinity, l = Infinity;
    for (let j = 0; j <= S; j++) { const m = PR.quote(k, t0 + dt * j).mid; if (j === 0) o = m; c = m; if (m > h) h = m; if (m < l) l = m; }
    candles.push({ o, h, l, c });
  }
  res.json({ now: now * 1000, candles });
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
    const dirty = u.v !== 2;
    if (settle(u, Date.now()) || dirty) await store.set(u.name, u);
    res.json(pub(u));
  });
}));

app.post('/api/seen', need, wrap(async (req, res) => {
  await withLock(req.uname, async () => {
    const u = await account(req); u.notices.forEach((n) => { n.seen = true; });
    await store.set(u.name, u); res.json(pub(u));
  });
}));

// 現物取引
const TP = { KD: { b: 'k', q: 'd' } };
app.post('/api/trade', need, wrap(async (req, res) => {
  const { pair, side } = req.body || {}; const amount = r4(Number(req.body.amount)); const p = TP[pair];
  if (!p || !['buy', 'sell'].includes(side) || !(Number.isFinite(amount) && amount > 0)) return res.status(400).json({ error: '注文が正しくありません' });
  await withLock(req.uname, async () => {
    const u = await account(req), w = u.wallet, q = PR.quote(pair, Date.now() / 1000); let cost;
    if (side === 'buy') { cost = r4(amount * q.ask); if (w[p.q] < cost) return res.status(400).json({ error: '残高が足りません' }); w[p.q] = r4(w[p.q] - cost); w[p.b] = r4(w[p.b] + amount); }
    else { cost = r4(amount * q.bid); if (w[p.b] < amount) return res.status(400).json({ error: '持っている数が足りません' }); w[p.b] = r4(w[p.b] - amount); w[p.q] = r4(w[p.q] + cost); }
    u.history.unshift({ t: Date.now(), kind: 'spot', pair, side, amount, price: side === 'buy' ? q.ask : q.bid, total: cost });
    u.history = u.history.slice(0, 50);
    await store.set(u.name, u); res.json(pub(u));
  });
}));

// 金のどんぐり：買う・売るだけ（1こ単位、ねだんは固定）
app.post('/api/gold', need, wrap(async (req, res) => {
  const { side } = req.body || {}; const units = Math.floor(Number(req.body.units));
  if (!['buy', 'sell'].includes(side) || !(units >= 1) || units > 1000) return res.status(400).json({ error: '1こ以上の整数で入力してね' });
  await withLock(req.uname, async () => {
    const u = await account(req), w = u.wallet, cost = units * GOLD;
    if (side === 'buy') { if (w.d < cost) return res.status(400).json({ error: `どんぐりが足りません（${fm(cost)}どんぐり必要）` }); w.d = r4(w.d - cost); w.gd += units; }
    else { if (w.gd < units) return res.status(400).json({ error: '金のどんぐりが足りません' }); w.gd -= units; w.d = r4(w.d + cost); }
    u.history.unshift({ t: Date.now(), kind: 'gold', side, amount: units, price: GOLD, total: cost });
    u.history = u.history.slice(0, 50);
    await store.set(u.name, u); res.json(pub(u));
  });
}));

// レバレッジ取引：新規
app.post('/api/open', need, wrap(async (req, res) => {
  const { pair, side } = req.body || {}; const units = r4(Number(req.body.units)), lev = Number(req.body.lev);
  if (!PR.PAIRS[pair] || !['long', 'short'].includes(side) || !(Number.isFinite(units) && units > 0) || !LEVS.includes(lev)) return res.status(400).json({ error: '注文が正しくありません' });
  await withLock(req.uname, async () => {
    const u = await account(req);
    if (u.positions.length >= 10) return res.status(400).json({ error: 'ポジションは10個までです' });
    const now = Date.now(), qs = quotesAt(now / 1000), q = qs[pair], entry = side === 'long' ? q.ask : q.bid;
    const tp = levelValue(req.body.tp), sl = levelValue(req.body.sl);
    const error = Orders.levels(side, entry, tp, sl);
    if (error) return res.status(400).json({ error });
    const margin = r4((units * entry * rate(pair, qs)) / lev);
    if (margin < 1) return res.status(400).json({ error: '数量が小さすぎます' });
    if (u.wallet.d < margin) return res.status(400).json({ error: `証拠金が足りません（必要：${fm(margin)}どんぐり）` });
    u.wallet.d = r4(u.wallet.d - margin);
    u.positions.push({ id: id(), pair, side, units, lev, entry, margin, t: now, tp, sl });
    u.history.unshift({ t: now, kind: 'open', pair, side, units, lev, price: entry });
    u.history = u.history.slice(0, 50);
    await store.set(u.name, u); res.json(pub(u));
  });
}));

// レバレッジ取引：決済
app.post('/api/close', need, wrap(async (req, res) => {
  await withLock(req.uname, async () => {
    const u = await account(req);
    const i = u.positions.findIndex((p) => p.id === (req.body || {}).id);
    if (i < 0) { await store.set(u.name, u); return res.status(400).json({ error: 'そのポジションはもうありません（ロスカットされたかも）' }); }
    const p = u.positions[i], e = equity(p, quotesAt(Date.now() / 1000));
    u.wallet.d = r4(u.wallet.d + Math.max(0, e)); u.positions.splice(i, 1);
    u.history.unshift({ t: Date.now(), kind: 'close', pair: p.pair, pnl: r4(Math.max(0, e) - p.margin) });
    u.history = u.history.slice(0, 50);
    await store.set(u.name, u); res.json(pub(u));
  });
}));

// Pending leveraged entries and position-level OCO exits.
app.post('/api/order', need, wrap(async (req, res) => {
  await withLock(req.uname, async () => {
    const u = await account(req), { pair, side, type } = req.body;
    const units = r4(Number(req.body.units)), lev = Number(req.body.lev), price = Number(req.body.price);
    const tp = levelValue(req.body.tp), sl = levelValue(req.body.sl);
    if (!PR.PAIRS[pair] || !['long', 'short'].includes(side) || !['limit', 'stop'].includes(type) || !Orders.positive(units) || !Orders.positive(price) || !LEVS.includes(lev)) return res.status(400).json({ error: '注文が正しくありません' });
    const error = Orders.levels(side, price, tp, sl);
    if (error) return res.status(400).json({ error });
    if (u.orders.length >= 20) return res.status(400).json({ error: '予約注文は20件までです' });
    const now = Date.now(), q = PR.quote(pair, now / 1000);
    if (Orders.hit({ side, type, price }, q)) return res.status(400).json({ error: '現在値ですでに条件を満たしています。予約価格を変更するか成行を使ってください' });
    const margin = r4(units * price / lev);
    if (!Number.isFinite(margin) || margin < 1 || margin > u.wallet.d) return res.status(400).json({ error: '必要証拠金は1以上、現在の残高以下にしてください' });
    u.orders.push({ id: id(), pair, side, type, price, units, lev, tp, sl, t: now, expires: now + 14 * 864e5 });
    await store.set(u.name, u); res.json(pub(u));
  });
}));
app.post('/api/order/cancel', need, wrap(async (req, res) => {
  await withLock(req.uname, async () => {
    const u = await account(req);
    const i = u.orders.findIndex(o => o.id === req.body.id);
    if (i < 0) return res.status(400).json({ error: 'その注文は成立・失効・取消済みです' });
    u.orders.splice(i, 1); await store.set(u.name, u); res.json(pub(u));
  });
}));
app.post('/api/protection', need, wrap(async (req, res) => {
  await withLock(req.uname, async () => {
    const u = await account(req), p = u.positions.find(p => p.id === req.body.id);
    if (!p) return res.status(400).json({ error: 'そのポジションは決済済みです' });
    const tp = levelValue(req.body.tp), sl = levelValue(req.body.sl), q = PR.quote(p.pair, Date.now() / 1000);
    const error = Orders.levels(p.side, p.side === 'long' ? q.bid : q.ask, tp, sl);
    if (error) return res.status(400).json({ error });
    p.tp = tp; p.sl = sl;
    // Do not apply freshly changed protection retroactively to an earlier tick.
    p.protectionT = Date.now();
    await store.set(u.name, u); res.json(pub(u));
  });
}));

// 価格アラート
app.post('/api/alert', need, wrap(async (req, res) => {
  const { pair, dir } = req.body || {}, price = Number(req.body.price);
  if (!PR.PAIRS[pair] || !['above', 'below'].includes(dir) || !(price > 0) || !isFinite(price)) return res.status(400).json({ error: 'アラートの内容が正しくありません' });
  await withLock(req.uname, async () => {
    const u = await account(req);
    if (u.alerts.length >= 10) return res.status(400).json({ error: 'アラートは10個までです' });
    u.alerts.push({ id: id(), pair, dir, price, t: Date.now() });
    await store.set(u.name, u); res.json(pub(u));
  });
}));
app.post('/api/alert/del', need, wrap(async (req, res) => {
  await withLock(req.uname, async () => {
    const u = await account(req); u.alerts = u.alerts.filter((a) => a.id !== (req.body || {}).id);
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
    const u = await account(req), now = Date.now();
    if (now - u.lastClaim < CLAIM_INTERVAL) return res.status(400).json({ error: 'まだ落ちてないみたい（1時間に1回）' });
    u.wallet.d = r4(u.wallet.d + CLAIM_AMOUNT); u.lastClaim = now;
    await store.set(u.name, u); res.json(pub(u));
  });
}));

async function boot() {
  if (LOCAL_TEST) {
    const salt = crypto.randomBytes(16).toString('hex');
    await store.set('test', norm({ name: 'test', salt, hash: hashPw('5447', salt), wallet: { ...START }, lastClaim: 0 }));
  }
  const port = process.env.PORT || 3000;
  app.listen(port, LOCAL_TEST ? '127.0.0.1' : '0.0.0.0', () => {
    console.log(`donguri-fx running: http://127.0.0.1:${port}${LOCAL_TEST ? ' (local test / in-memory storage)' : ''}`);
  });
}
boot().catch(e => { console.error(e); process.exitCode = 1; });
