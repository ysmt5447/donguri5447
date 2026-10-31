// 価格は「時刻から計算する関数」。サーバーが眠っていても価格は動き続ける。
// サーバーだけが持つ（秘密のシードで未来の価格を推測できなくする）。
(function (root) {
  const big = (a) => a.map(([p, v]) => [p, v * 3]);
  const L = [[4,6e-4],[40,1.5e-3],[400,3e-3],[4e3,6e-3],[4e4,1.2e-2],[4e5,3e-2],[3e6,6e-2]];
  const PAIRS = {
    KD:  { name: 'くるみ / どんぐり',       base: 150,    spread: 0.001, seed: 11, quote: 'd', layers: L },
    GDD: { name: '金のどんぐり / どんぐり', base: 1e7,    spread: 0.003, seed: 23, quote: 'd', layers: big(L) },
    GKK: { name: '金のくるみ / くるみ',     base: 200000, spread: 0.003, seed: 37, quote: 'k', layers: big(L) },
  };
  let SEED = 0;
  function setSeed(str) { let x = 7; for (const ch of String(str)) x = Math.imul(x ^ ch.charCodeAt(0), 16777619); SEED = x | 0; }
  function h(n, s) {
    let x = Math.imul(n | 0, 374761393) + Math.imul(s | 0, 668265263);
    x = Math.imul(x ^ (x >>> 13), 1274126177); x ^= x >>> 16;
    return ((x >>> 0) / 4294967295) * 2 - 1;
  }
  function vn(t, s) {
    const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f);
    return h(i, s) * (1 - u) + h(i + 1, s) * u;
  }
  function quote(key, tSec) {
    const c = PAIRS[key]; let a = 0;
    c.layers.forEach((l, j) => { a += l[1] * vn(tSec / l[0], c.seed * 31 + j + SEED); });
    const mid = c.base * Math.exp(a), s = c.spread / 2;
    return { mid, bid: mid * (1 - s), ask: mid * (1 + s) };
  }
  const api = { PAIRS, quote, setSeed };
  if (typeof module !== 'undefined') module.exports = api; else root.PriceLib = api;
})(this);
