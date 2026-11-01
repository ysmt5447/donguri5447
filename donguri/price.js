// 価格は「時刻から計算する関数」。サーバーが眠っていても価格は動き続ける。
// サーバーだけが持つ（秘密のシードで未来の価格を推測できなくする）。
(function (root) {
  const L = [[4,6e-4],[40,1.5e-3],[400,3e-3],[4e3,6e-3],[4e4,1.2e-2],[4e5,3e-2],[3e6,6e-2]];
  const PAIRS = {
    KD:  { name: 'くるみ / どんぐり',       base: 150,    spread: 0.001, seed: 11, quote: 'd', layers: L },
  };
  let SEED = 0;
  function setSeed(str) { let x = 7; for (const ch of String(str)) x = Math.imul(x ^ ch.charCodeAt(0), 16777619); SEED = x | 0; }
  function h(n, s) {
    let x = Math.imul(n | 0, 374761393) + Math.imul(s | 0, 668265263);
    x = Math.imul(x ^ (x >>> 13), 1274126177); x ^= x >>> 16;
    return ((x >>> 0) / 4294967295) * 2 - 1;
  }
  function vn(t, s) {
    const i = Math.floor(t), f = t - i, u = f;
    return h(i, s) * (1 - u) + h(i + 1, s) * u;
  }
  // Stateless, seeded market: every timestamp has the same quote after a restart.
  const STORIES = [
    ['くるみ豊作の見通し、供給増を意識', -1],
    ['森の菓子工房、くるみの大量購入を発表', 1],
    ['輸送路の倒木でくるみ出荷に遅れ', 1],
    ['どんぐり備蓄の放出、交換需要に変化', 1],
    ['くるみ需要が一服、在庫積み上がる', -1],
    ['森の中央銀行、どんぐり回収を発表', -1],
    ['冬支度の買い付けでくるみ需要拡大', 1],
    ['新しい収穫機が普及、くるみ生産効率改善', -1],
  ];
  const SLOT = 1800;
  function event(slot) {
    const t = slot * SLOT + 120 + Math.floor((h(slot, SEED + 701) + 1) * 600);
    const story = STORIES[Math.min(STORIES.length - 1, Math.floor((h(slot, SEED + 702) + 1) * STORIES.length / 2))];
    const impact = story[1] * (0.0015 + (h(slot, SEED + 703) + 1) * 0.0025);
    return { id: String(slot), t: t * 1000, title: story[0], impact,
      direction: story[1] > 0 ? 'up' : 'down', category: '架空ニュース' };
  }
  function news(tSec, limit = 12) {
    const result = [];
    for (let slot = Math.floor(tSec / SLOT); result.length < limit; slot--) {
      const e = event(slot); if (e.t <= tSec * 1000) result.push(e);
    }
    return result;
  }
  function quote(key, tSec) {
    const c = PAIRS[key];
    if (!c || !Number.isFinite(tSec)) throw new Error('Invalid quote');
    // Linear multiscale noise creates jagged ticks instead of rounded waves.
    // Slow volatility regimes produce quiet stretches and clustered turbulence.
    const vol = Math.exp(0.8 * vn(tSec / 2400, SEED + 801));
    let a = 0;
    c.layers.forEach((l, j) => {
      a += l[1] * vn(tSec / l[0], c.seed * 31 + j + SEED) * (j < 3 ? vol : 1);
    });
    a += vol * (0.00022 * vn(tSec, SEED + 802) + 0.00045 * vn(tSec / 11, SEED + 803));
    let stress = 0;
    const slot = Math.floor(tSec / SLOT);
    for (let i = slot - 8; i <= slot; i++) {
      const e = event(i), age = tSec - e.t / 1000;
      if (age < 0) continue; // Never incorporate an unpublished headline.
      // Fast repricing, followed by gradual digestion of the news.
      a += e.impact * (1 - Math.exp(-age / 8)) * Math.exp(-age / 1500);
      stress += Math.abs(e.impact) * Math.exp(-age / 180);
    }
    const mid = c.base * Math.exp(a);
    const spread = c.spread * Math.min(3, 0.8 + vol * 0.2 + stress * 120);
    return { mid, bid: mid * (1 - spread / 2), ask: mid * (1 + spread / 2), spread };
  }
  const api = { PAIRS, quote, setSeed, news };
  if (typeof module !== 'undefined') module.exports = api; else root.PriceLib = api;
})(this);
