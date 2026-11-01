const r4 = x => Math.round(x * 1e4) / 1e4;
const positive = x => Number.isFinite(x) && x > 0;
function levels(side, reference, tp, sl) {
  for (const x of [tp, sl]) if (x != null && !positive(x)) return '価格は正の数で入力してください';
  if (tp != null && (side === 'long' ? tp <= reference : tp >= reference)) return '利確価格はロングなら基準価格より上、ショートなら下にしてください';
  if (sl != null && (side === 'long' ? sl >= reference : sl <= reference)) return '損切り価格はロングなら基準価格より下、ショートなら上にしてください';
  return null;
}
function hit(order, q) {
  const price = order.side === 'long' ? q.ask : q.bid;
  return order.type === 'limit' ? (order.side === 'long' ? price <= order.price : price >= order.price) : (order.side === 'long' ? price >= order.price : price <= order.price);
}
function tick(u, qs, ms, { id, note, equity, rate, lossCut }) {
  // Close existing positions before opening pending orders at this tick.
  u.positions = u.positions.filter(p => {
    if (p.t > ms) return true;
    const q = qs[p.pair], cur = p.side === 'long' ? q.bid : q.ask, e = equity(p, qs);
    const tp = (p.protectionT || p.t) <= ms && p.tp != null && (p.side === 'long' ? cur >= p.tp : cur <= p.tp);
    const sl = (p.protectionT || p.t) <= ms && p.sl != null && (p.side === 'long' ? cur <= p.sl : cur >= p.sl);
    const kind = e <= p.margin * lossCut ? 'losscut' : sl ? 'stoploss' : tp ? 'takeprofit' : null;
    if (!kind) return true;
    u.wallet.d = r4(u.wallet.d + Math.max(0, e));
    u.history.unshift({ t: ms, kind, pair: p.pair, price: cur, pnl: r4(Math.max(0, e) - p.margin) });
    note(u, ms, `${kind === 'takeprofit' ? '利確' : kind === 'stoploss' ? '損切り' : 'ロスカット'}：${p.side === 'long' ? 'ロング' : 'ショート'}を ${cur.toFixed(3)} で自動決済しました`);
    return false; // TP and SL disappear together with the position (OCO).
  });
  u.orders = u.orders.filter(o => {
    if (o.t > ms) return true;
    if (o.expires <= ms) { note(u, ms, '予約注文の有効期限が切れました'); return false; }
    const q = qs[o.pair];
    if (!hit(o, q)) return true;
    const entry = o.side === 'long' ? q.ask : q.bid;
    const margin = r4(o.units * entry * rate(o.pair, qs) / o.lev);
    if (u.positions.length >= 10 || margin < 1 || !Number.isFinite(margin) || u.wallet.d < margin) {
      note(u, ms, '予約注文は証拠金不足・保有上限により失効しました'); return false;
    }
    u.wallet.d = r4(u.wallet.d - margin);
    u.positions.push({ id: id(), pair: o.pair, side: o.side, units: o.units, lev: o.lev, entry, margin, t: ms, tp: o.tp, sl: o.sl });
    u.history.unshift({ t: ms, kind: 'open', pair: o.pair, side: o.side, units: o.units, lev: o.lev, price: entry, orderId: o.id });
    note(u, ms, `予約注文成立：${o.side === 'long' ? 'ロング' : 'ショート'} ${entry.toFixed(3)}`);
    return false;
  });
}
module.exports = { levels, hit, tick, positive };
