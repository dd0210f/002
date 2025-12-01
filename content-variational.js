// content-variational.js
// 在 omni.variational.io 页面里，轮询 /api/quotes/indicative，取价格给扩展用

const EXCHANGE = "variational";

const INSTRUMENT = {
  instrument_type: "perpetual_future",
  underlying: "BTC",
  funding_interval_s: 3600,
  settlement_asset: "USDC"
};

// 只用来“问价格”的数量，足够小即可，但要 >= min_qty
const PROBE_QTY = "0.001";

function safeSendMessage(msg) {
  if (!chrome.runtime || !chrome.runtime.id) return;
  try {
    chrome.runtime.sendMessage(msg);
  } catch (e) {
    console.warn("sendMessage failed:", e);
  }
}

async function fetchIndicativeQuote() {
  try {
    const body = {
      instrument: INSTRUMENT,
      qty: PROBE_QTY
    };

    const res = await fetch("/api/quotes/indicative", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/plain, */*"
      },
      credentials: "include",
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      console.warn("indicative quote HTTP error:", res.status);
      return;
    }

    const json = await res.json();

    if (!json.bid || !json.ask || !json.mark_price) {
      console.warn("indicative quote missing fields:", json);
      return;
    }

    const ticker = {
      symbol: "BTC-PERP-USDC",
      lastPrice: Number(json.mark_price),   // 先直接用 mark 当“主价格”
      bid1: Number(json.bid),
      ask1: Number(json.ask),
      markPrice: Number(json.mark_price),
      indexPrice: Number(json.index_price),
      ts: Date.now()
    };

    console.log("[CS] variational ticker", ticker);

    safeSendMessage({
      type: "market_update",
      exchange: EXCHANGE,
      data: ticker
    });
  } catch (err) {
    console.warn("fetchIndicativeQuote error:", err);
  }
}

// 1 秒轮询一次
setInterval(fetchIndicativeQuote, 1000);
fetchIndicativeQuote();
