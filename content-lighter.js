// content-lighter.js
// 作用：连接 Lighter 官方 WebSocket，订阅多个市场的 order_book + market_stats
// 然后把 bid/ask/mark/indexPrice 以和 variational 一样的格式发给 background.js
console.log("[lighter] content script loaded at", location.href);

const EXCHANGE = "lighter";
const L_WS_URL = "wss://mainnet.zklighter.elliot.ai/stream";

// 支持多个市场
const MARKETS = {
  1: "BTC-PERP",  // BTC 市场索引
  2: "ETH-PERP"   // ETH 市场索引
};

// 为每个市场维护独立的状态
const marketStates = {};
for (const marketIndex in MARKETS) {
  marketStates[marketIndex] = {
    symbol: MARKETS[marketIndex],
    bestBid: null,
    bestAsk: null,
    markPrice: null,
    indexPrice: null,
    lastTs: null
  };
}

let ws = null;
let reconnectTimer = null;

function log(...args) {
  console.log("[lighter-ws]", ...args);
}

function publishMarket(marketIndex) {
  const state = marketStates[marketIndex];
  if (!state || state.bestBid == null || state.bestAsk == null) return;

  const mid = (state.bestBid + state.bestAsk) / 2;

  const ticker = {
    symbol: state.symbol,
    bid1: state.bestBid,
    ask1: state.bestAsk,
    mid,
    markPrice: state.markPrice ?? mid,
    indexPrice: state.indexPrice ?? null,
    ts: state.lastTs || Date.now()
  };

  // 发送到 background，使用 symbol 作为区分
  chrome.runtime.sendMessage({
    type: "market_update",
    exchange: EXCHANGE,
    data: ticker
  });
}

function handleMessage(ev) {
  try {
    const msg = JSON.parse(ev.data);

    if (msg.type === "update/order_book" && msg.order_book) {
      const ob = msg.order_book;
      const marketIndex = ob.market_index;

      if (!marketStates[marketIndex]) {
        // 未知市场，跳过
        return;
      }

      const state = marketStates[marketIndex];
      const bids = ob.bids || [];
      const asks = ob.asks || [];

      if (bids.length > 0) {
        let bestBid = null;
        for (const b of bids) {
          const p = Number(b.price);
          if (!Number.isFinite(p)) continue;
          if (bestBid == null || p > bestBid) bestBid = p;
        }
        state.bestBid = bestBid;
      }

      if (asks.length > 0) {
        let bestAsk = null;
        for (const a of asks) {
          const p = Number(a.price);
          if (!Number.isFinite(p)) continue;
          if (bestAsk == null || p < bestAsk) bestAsk = p;
        }
        state.bestAsk = bestAsk;
      }

      state.lastTs = Date.now();
      publishMarket(marketIndex);
      return;
    }

    if (msg.type === "update/market_stats" && msg.market_stats) {
      const ms = msg.market_stats;
      const marketIndex = ms.market_index;

      if (!marketStates[marketIndex]) {
        // 未知市场，跳过
        return;
      }

      const state = marketStates[marketIndex];
      if (ms.mark_price) state.markPrice = Number(ms.mark_price);
      if (ms.index_price) state.indexPrice = Number(ms.index_price);
      state.lastTs = Date.now();
      publishMarket(marketIndex);
      return;
    }

  } catch (e) {
    console.error("[lighter-ws] parse error", e);
  }
}

function connectWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  log("connecting to", L_WS_URL);
  ws = new WebSocket(L_WS_URL);

  ws.onopen = () => {
    log("ws open, subscribing to markets:", Object.keys(MARKETS).map(idx => `${MARKETS[idx]}(${idx})`).join(", "));

    // 订阅所有市场的 order_book 和 market_stats
    for (const marketIndex in MARKETS) {
      const subs = [
        { type: "subscribe", channel: `order_book/${marketIndex}` },
        { type: "subscribe", channel: `market_stats/${marketIndex}` }
      ];

      for (const s of subs) {
        ws.send(JSON.stringify(s));
      }
    }
  };

  ws.onmessage = handleMessage;

  ws.onerror = (e) => {
    console.error("[lighter-ws] error", e);
  };

  ws.onclose = (e) => {
    log("ws closed", e.code, e.reason);
    ws = null;
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWs();
      }, 3000);
    }
  };
}

if (location.host.includes("app.lighter.xyz")) {
  connectWs();
}
