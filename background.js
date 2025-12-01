// background.js
// 维护行情状态，并代理 Variational / Lighter 下单

const state = {
  variational: null,
  lighter: null, // 保留向后兼容，存储最后更新的市场
  lighterMarkets: {}, // 新增：按 symbol 存储多个市场数据 (e.g. "BTC-PERP", "ETH-PERP")
  logs: [],
  hedge: {
    last_pair: null,
    lighter_order: null,
    variational_order: null,
    last_check: null,
    imbalance: null
  }
};

// 默认 Variational 合约定义（兜底用）
const ORDER_INSTRUMENT = {
  instrument_type: "perpetual_future",
  underlying: "BTC",
  funding_interval_s: 3600,
  settlement_asset: "USDC"
};

const HEDGE_MODES = {
  MARKET: "market",
  LIGHTER_LIMIT: "lighter_limit"
};

const DEFAULT_CONFIG = {
  hedge_ratio: 1, // 对冲数量比例
  hedge_slippage: 0.001, // Variational 市价单默认最大滑点
  hedge_mode: HEDGE_MODES.MARKET,
  variational_base_url: "https://omni.variational.io",
  lighter_signer_url: "http://127.0.0.1:8787",
  variational_instrument: {
    instrument_type: "perpetual_future",
    underlying: "BTC",
    funding_interval_s: 3600,
    settlement_asset: "USDC"
  }
};

// Market cache configuration
const LOCAL_SIGNER_URL = "http://127.0.0.1:8787";
const MARKET_CACHE_KEY = "lighter_markets_cache";
const MARKET_CACHE_DURATION = 3600000; // 1 hour in milliseconds

// Default pairs as fallback
const DEFAULT_PAIRS = [
  { id: "BTC-PERP", underlying: "BTC" },
  { id: "ETH-PERP", underlying: "ETH" }
];

// Fetch markets from local lighter-signer-manager backend
async function fetchLighterMarkets() {
  try {
    const url = `${LOCAL_SIGNER_URL}/markets`;
    console.log(`[Market Fetch] Fetching from local backend: ${url}`);

    const res = await fetch(url);

    if (!res.ok) {
      console.error(`[Market Fetch] Backend returned HTTP ${res.status}`);
      logEvent(`获取市场列表失败: HTTP ${res.status}，请确保 lighter-signer-manager 正在运行`);
      return null;
    }

    const data = await res.json();
    console.log(`[Market Fetch] Response:`, data);

    if (!data.ok || !Array.isArray(data.markets)) {
      console.error(`[Market Fetch] Unexpected response format:`, data);
      return null;
    }

    const markets = data.markets;

    if (markets.length === 0) {
      console.warn(`[Market Fetch] Empty markets list`);
      logEvent('获取到空的市场列表');
      return null;
    }

    console.log(`[Market Fetch] ✓ Success! Got ${markets.length} markets`);

    // Cache the result
    const cacheData = {
      timestamp: Date.now(),
      markets: markets
    };
    await chrome.storage.local.set({ [MARKET_CACHE_KEY]: cacheData });
    logEvent(`已更新市场列表，共 ${markets.length} 个市场`);

    return markets;

  } catch (err) {
    console.error(`[Market Fetch] Error:`, err);
    logEvent(`获取市场列表失败: ${err.message}。请确保 lighter-signer-manager 正在运行 (http://127.0.0.1:8787)`);
    return null;
  }
}

// Get markets from cache or fetch if stale
async function getLighterMarkets(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await chrome.storage.local.get([MARKET_CACHE_KEY]);
    if (cached[MARKET_CACHE_KEY]) {
      const { timestamp, markets } = cached[MARKET_CACHE_KEY];
      const age = Date.now() - timestamp;
      if (age < MARKET_CACHE_DURATION) {
        console.log(`[Market Cache] Using cached data (${markets.length} markets, age: ${Math.round(age / 1000)}s)`);
        return markets;
      }
    }
  }

  // Fetch fresh data
  console.log('[Market Cache] Fetching fresh market data from local backend...');
  const markets = await fetchLighterMarkets();
  return markets || DEFAULT_PAIRS;
}

function buildVariationalEndpoints(base) {
  const root = base || DEFAULT_CONFIG.variational_base_url;
  return {
    limit: `${root}/api/orders/new/limit`,
    market: `${root}/api/orders/new/market`,
    orders_query: `${root}/api/orders/v2?limit=100&offset=0`,
    quote: `${root}/api/quotes/indicative`
  };
}

function getLocalBestPrice(side, marketReference) {
  // 尝试从 marketReference 中提取 symbol（例如 "BTC-PERP", "ETH-PERP"）
  let ticker = null;

  if (marketReference) {
    // 先尝试直接匹配 symbol
    const normalizedRef = String(marketReference).toUpperCase();
    ticker = state.lighterMarkets[normalizedRef];

    if (!ticker) {
      // 尝试从 market_id 提取 underlying (e.g., "BTC-PERP" -> "BTC")
      const underlying = normalizedRef.split("-")[0];
      const possibleSymbol = `${underlying}-PERP`;
      ticker = state.lighterMarkets[possibleSymbol];
    }
  }

  // 如果找不到特定市场，回退到 state.lighter（最后更新的市场）
  if (!ticker) {
    ticker = state.lighter;
  }

  if (!ticker) {
    console.log("[getLocalBestPrice] 无可用的Lighter市场数据 - WebSocket可能未连接或未收到数据");
    console.log("[getLocalBestPrice] 已有市场:", Object.keys(state.lighterMarkets));
    return null;
  }

  console.log("[getLocalBestPrice] 使用市场数据:", {
    requestedMarket: marketReference,
    usedSymbol: ticker.symbol,
    bid1: ticker.bid1,
    ask1: ticker.ask1,
    bid: ticker.bid,
    ask: ticker.ask,
    mid: ticker.mid,
    markPrice: ticker.markPrice
  });

  let price;
  if (side === "buy") {
    price = Number(ticker.ask1 ?? ticker.ask ?? ticker.mid ?? ticker.markPrice ?? null);
    console.log(`[getLocalBestPrice] buy side价格: ${price} (来源: ${ticker.ask1 ? 'ask1' : ticker.ask ? 'ask' : ticker.mid ? 'mid' : ticker.markPrice ? 'markPrice' : 'none'})`);
  } else {
    price = Number(ticker.bid1 ?? ticker.bid ?? ticker.mid ?? ticker.markPrice ?? null);
    console.log(`[getLocalBestPrice] sell side价格: ${price} (来源: ${ticker.bid1 ? 'bid1' : ticker.bid ? 'bid' : ticker.mid ? 'mid' : ticker.markPrice ? 'markPrice' : 'none'})`);
  }

  return price;
}


async function resolveBestLighterPrice(side, marketReference, signerUrl) {
  console.log(`[resolveBestLighterPrice] 开始获取价格: side=${side}, marketReference=${marketReference}, signerUrl=${signerUrl}`);

  const local = getLocalBestPrice(side, marketReference);
  if (Number.isFinite(local) && local > 0) {
    console.log(`[resolveBestLighterPrice] ✓ 从本地state.lighter获取价格成功: ${local}`);
    return local;
  }

  console.log(`[resolveBestLighterPrice] 本地价格获取失败，尝试API回退...`);

  if (!marketReference) {
    console.log(`[resolveBestLighterPrice] ✗ 缺少 marketReference`);
    return null;
  }

  // Normalize market reference - Lighter API uses bare symbols without -PERP suffix
  let normalizedMarket = String(marketReference).toUpperCase();
  // Remove -PERP suffix if present (e.g., "BTC-PERP" -> "BTC")
  normalizedMarket = normalizedMarket.replace(/-PERP$/i, '');

  console.log(`[resolveBestLighterPrice] Normalized market: ${marketReference} -> ${normalizedMarket}`);

  // Try local backend first (more reliable than external signer)
  const backendUrl = DEFAULT_CONFIG.lighter_signer_url || 'http://127.0.0.1:8787';

  try {
    const url = `${backendUrl}/market/bbo/${encodeURIComponent(normalizedMarket)}`;
    console.log(`[resolveBestLighterPrice] 调用本地后端API: ${url}`);

    const res = await fetch(url);
    console.log(`[resolveBestLighterPrice] API响应状态: ${res.status}`);

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      console.log(`[resolveBestLighterPrice] ✗ API返回错误: ${res.status} ${errorText}`);
      return null;
    }

    const payload = await res.json().catch(() => null);
    console.log(`[resolveBestLighterPrice] API返回数据:`, payload);

    const data = payload?.data || payload;
    if (!data) {
      console.log(`[resolveBestLighterPrice] ✗ API返回数据为空`);
      return null;
    }

    const price = side === "buy" ? data.ask : data.bid;
    if (!price || price <= 0) {
      console.log(`[resolveBestLighterPrice] ✗ API返回的价格无效: ${price}`);
      return null;
    }

    console.log(`[resolveBestLighterPrice] ✓ 从API获取价格成功: ${price} (${side} side)`);
    return Number(price);
  } catch (err) {
    console.warn(`[resolveBestLighterPrice] ✗ 异常:`, err);
    return null;
  }
}

function buildMarketReference(order) {
  const ref = (
    order.market_reference ||
    order.market_symbol ||
    order.market_id ||
    order.marketId ||
    state.hedge.last_pair ||
    null
  );
  console.log(`[buildMarketReference] 解析市场引用:`, {
    result: ref,
    order_market_reference: order.market_reference,
    order_market_symbol: order.market_symbol,
    order_market_id: order.market_id,
    order_marketId: order.marketId,
    hedge_last_pair: state.hedge.last_pair
  });
  return ref;
}

async function prepareLighterOrderForStrategy(order, config, signerUrl) {
  const prepared = { ...order };
  prepared.market_reference = buildMarketReference(order);
  prepared.strategy_mode = config.hedge_mode || HEDGE_MODES.MARKET;
  if (
    prepared.order_type === "market" &&
    prepared.strategy_mode === HEDGE_MODES.LIGHTER_LIMIT &&
    !prepared.force_market_order
  ) {
    const bestPrice = await resolveBestLighterPrice(
      prepared.side,
      prepared.market_reference,
      signerUrl
    );
    if (Number.isFinite(bestPrice) && bestPrice > 0) {
      prepared.order_type = "limit";
      prepared.price = bestPrice;
      prepared.strategy_limit_price = bestPrice;
      prepared.strategy_attempt = (prepared.strategy_attempt || 0) + 1;
    } else {
      logEvent("无法获取 Lighter 买一/卖一价格，回退为市价单");
    }
  }
  return prepared;
}

async function cloneWithUpdatedLimitPrice(order, signerUrl) {
  const price = await resolveBestLighterPrice(order.side, order.market_reference, signerUrl);
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    ...order,
    order_type: "limit",
    price,
    strategy_limit_price: price,
    strategy_attempt: (order.strategy_attempt || 0) + 1
  };
}

const STORAGE_LOGS_KEY = "dcc_logs";
let logsLoaded = false;

// Initialize logs from storage
chrome.storage.local.get([STORAGE_LOGS_KEY], (result) => {
  if (result[STORAGE_LOGS_KEY]) {
    // Merge: Current memory logs (newest) + Stored logs (older)
    // Prevent duplicates if necessary, but simple concat is usually fine for logs
    // unless we re-loaded the same logs.
    // Actually, state.logs might have some startup logs.
    state.logs = state.logs.concat(result[STORAGE_LOGS_KEY]);
    // Trim
    if (state.logs.length > 1000) state.logs.length = 1000;
  }
  logsLoaded = true;
  // Persist the merged result immediately to ensure consistency
  chrome.storage.local.set({ [STORAGE_LOGS_KEY]: state.logs });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "market_update":
      if (msg.exchange === "lighter" && msg.data && msg.data.symbol) {
        // 存储到对应的市场
        state.lighterMarkets[msg.data.symbol] = msg.data;
        // 同时更新 state.lighter 为最新数据（向后兼容）
        state.lighter = msg.data;
      } else {
        state[msg.exchange] = msg.data;
      }
      return;
    case "get_state":
      sendResponse(state);
      return;
    case "get_pairs":
      // Deprecated - kept for backward compatibility
      sendResponse(DEFAULT_PAIRS);
      return;
    case "get_markets":
      runAsync(sendResponse, () => getLighterMarkets(false));
      return true;
    case "refresh_markets":
      runAsync(sendResponse, () => getLighterMarkets(true));
      return true;
    case "get_config":
      chrome.storage.sync.get(["hedgeConfig"], (stored) => {
        sendResponse(stored.hedgeConfig || DEFAULT_CONFIG);
      });
      return true;
    case "set_config":
      chrome.storage.sync.set({ hedgeConfig: msg.payload }, () => {
        sendResponse({ ok: true });
      });
      return true;
    case "place_order":
      runAsync(sendResponse, () => placeVariationalOrder(msg.order, msg.creds));
      return true;
    case "poll_order":
      runAsync(sendResponse, () => pollVariationalOrder(msg.rfqId));
      return true;
    case "lighter_place_order":
      runAsync(sendResponse, () => placeLighterOrder(msg.payload));
      return true;
    case "get_logs":
      sendResponse(state.logs);
      return true;
    case "add_log":
      logEvent(msg.message, false);
      sendResponse({ ok: true });
      return true;
    case "get_hedge_status":
      sendResponse(state.hedge);
      return true;
    // ... (previous code)

    case "strategy_start":
      runAsync(sendResponse, () => handleStartStrategy());
      return true;
    case "strategy_stop":
      runAsync(sendResponse, () => handleStopStrategy());
      return true;
    case "strategy_close_all":
      runAsync(sendResponse, () => handleCloseAll());
      return true;
    case "strategy_update_state":
      // UI updates state (e.g. config changes), just save it
      chrome.storage.local.set({ strategyState: msg.payload }, () => {
        sendResponse({ ok: true });
      });
      return true;

    default:
      break;
  }
  return false;
});

// ...

// --- Strategy Core Logic ---

async function handleStartStrategy() {
  const result = await chrome.storage.local.get(['strategyState']);
  const state = result.strategyState;
  if (!state) throw new Error("无策略配置");

  // Check credentials
  const creds = await new Promise(resolve => chrome.storage.sync.get(["vrToken", "walletAddress"], resolve));
  if (!creds.vrToken || !creds.walletAddress) {
    throw new Error("未配置 API Token 或钱包地址，请先在配置页保存！");
  }

  state.isRunning = true;
  await chrome.storage.local.set({ strategyState: state });
  logEvent("策略启动");

  // Create alarm
  chrome.alarms.create('strategyTicker', { periodInMinutes: 1 });

  // Open initial positions
  for (const pair of state.pairs) {
    if (pair.status === 'idle') {
      await openPosition(pair);
    } else if (pair.status === 'error') {
      // Auto-recovery logic
      const hasPositions = pair.positions && (pair.positions.lighter || pair.positions.variational);
      if (!hasPositions) {
        logEvent(`[${pair.id}] 尝试从错误状态恢复 (无持仓)，重新开仓...`);
        await openPosition(pair);
      } else {
        logEvent(`[${pair.id}] 尝试从错误状态恢复 (有持仓)，恢复运行状态。请检查仓位是否平衡！`);
        pair.status = 'running';
        // Update state immediately to reflect running status
        await chrome.storage.local.set({ strategyState: state });
      }
    }
  }
}

async function handleStopStrategy() {
  const result = await chrome.storage.local.get(['strategyState']);
  const state = result.strategyState;
  if (state) {
    state.isRunning = false;
    await chrome.storage.local.set({ strategyState: state });
  }
  chrome.alarms.clear('strategyTicker');
  logEvent("策略停止");
}

async function handleCloseAll() {
  await handleStopStrategy();
  logEvent("开始平仓所有持仓...");

  const result = await chrome.storage.local.get(['strategyState']);
  const state = result.strategyState;
  if (!state) return;

  for (const pair of state.pairs) {
    await closePosition(pair);
  }
  logEvent("所有持仓已平仓");
}

async function openPosition(pair) {
  // Reload state to ensure we have latest (though we passed pair object)
  // Actually, we should modify the pair object and save the WHOLE state.
  // This is tricky if multiple operations happen. 
  // Ideally we lock or re-fetch.
  // For simplicity, we re-fetch state, find the pair, modify, and save.

  let result = await chrome.storage.local.get(['strategyState']);
  let state = result.strategyState;
  let targetPair = state.pairs.find(p => p.id === pair.id);
  if (!targetPair) return; // Pair removed?

  targetPair.status = 'opening';
  await chrome.storage.local.set({ strategyState: state });

  try {
    const direction = targetPair.currentDirection;
    const lighterSide = direction === 'lighter_short' ? 'sell' : 'buy';
    const variationalSide = direction === 'lighter_short' ? 'buy' : 'sell';

    logEvent(`[${targetPair.id}] 开仓: Lighter ${lighterSide}, Variational ${variationalSide}`);

    const creds = await new Promise((resolve) =>
      chrome.storage.sync.get(["vrToken", "walletAddress"], resolve)
    );

    const config = await new Promise((resolve) =>
      chrome.storage.sync.get(["hedgeConfig"], (stored) =>
        resolve(stored.hedgeConfig || DEFAULT_CONFIG)
      )
    );
    const instrument =
      deriveInstrumentFromMarket(targetPair.id) ||
      config.variational_instrument ||
      ORDER_INSTRUMENT;

    const [lighterResult, variationalResult] = await Promise.allSettled([
      retryOperation(() => placeLighterOrder({
        signerUrl: config.lighter_signer_url || DEFAULT_CONFIG.lighter_signer_url,
        skipAutoHedge: true,
        order: {
          market_id: targetPair.id,
          order_type: 'market',
          side: lighterSide,
          quantity: targetPair.quantity
        }
      }), 3, 2000),

      retryOperation(() => placeVariationalOrder({
        order_type: 'market',
        side: variationalSide,
        instrument: instrument,
        qty: targetPair.quantity.toString(),
        max_slippage: 0.001,
        is_reduce_only: false
      }, creds), 3, 2000)
    ]);

    const lighterOk = lighterResult.status === 'fulfilled' && lighterResult.value && lighterResult.value.ok !== false;
    const variationalOk = variationalResult.status === 'fulfilled' && variationalResult.value && variationalResult.value.ok !== false;

    if (!lighterOk) {
      const err = lighterResult.status === 'rejected' ? lighterResult.reason : lighterResult.value;
      logEvent(`[${targetPair.id}] Lighter 下单失败: ${err?.message || JSON.stringify(err)}`);
    }
    if (!variationalOk) {
      const err = variationalResult.status === 'rejected' ? variationalResult.reason : variationalResult.value;
      logEvent(`[${targetPair.id}] Variational 下单失败: ${err?.message || JSON.stringify(err)}`);
    }

    // Re-fetch state before saving to minimize race conditions
    result = await chrome.storage.local.get(['strategyState']);
    state = result.strategyState;
    targetPair = state.pairs.find(p => p.id === pair.id);
    if (!targetPair) return;

    // Save whatever succeeded
    if (lighterOk) {
      targetPair.positions.lighter = { side: lighterSide, quantity: targetPair.quantity };
    }
    if (variationalOk) {
      targetPair.positions.variational = { side: variationalSide, quantity: targetPair.quantity };
    }

    if (!lighterOk || !variationalOk) {
      // Partial or full failure
      targetPair.status = 'error';
      await chrome.storage.local.set({ strategyState: state });
      throw new Error(`开仓失败 - Lighter: ${lighterOk ? 'OK' : 'FAIL'}, Variational: ${variationalOk ? 'OK' : 'FAIL'}`);
    }

    // Full success
    targetPair.status = 'running';
    targetPair.lastFlip = Date.now();
    targetPair.nextFlip = Date.now() + state.flipInterval;

    await chrome.storage.local.set({ strategyState: state });
    logEvent(`[${targetPair.id}] 开仓成功`);

  } catch (err) {
    logEvent(`[${pair.id}] 开仓失败: ${err.message}`);

    // Status update handled above for partials, but catch-all here
    result = await chrome.storage.local.get(['strategyState']);
    state = result.strategyState;
    targetPair = state.pairs.find(p => p.id === pair.id);
    if (targetPair && targetPair.status !== 'error') {
      targetPair.status = 'error';
      await chrome.storage.local.set({ strategyState: state });
    }
  }
}

async function closePosition(pair) {
  let result = await chrome.storage.local.get(['strategyState']);
  let state = result.strategyState;
  let targetPair = state.pairs.find(p => p.id === pair.id);
  if (!targetPair) return;

  const qty = targetPair.quantity;
  targetPair.status = 'closing';
  await chrome.storage.local.set({ strategyState: state });

  try {
    logEvent(`[${targetPair.id}] 平仓中...`);

    const creds = await new Promise((resolve) =>
      chrome.storage.sync.get(["vrToken", "walletAddress"], resolve)
    );
    const config = await new Promise((resolve) =>
      chrome.storage.sync.get(["hedgeConfig"], (stored) =>
        resolve(stored.hedgeConfig || DEFAULT_CONFIG)
      )
    );
    const instrument =
      deriveInstrumentFromMarket(targetPair.id) ||
      config.variational_instrument ||
      ORDER_INSTRUMENT;

    const closePromises = [];

    // Close Lighter
    if (targetPair.positions.lighter) {
      const closeSide = targetPair.positions.lighter.side === 'buy' ? 'sell' : 'buy';
      closePromises.push(placeLighterOrder({
        signerUrl: config.lighter_signer_url || DEFAULT_CONFIG.lighter_signer_url,
        skipAutoHedge: true,
        order: {
          market_id: targetPair.id,
          order_type: 'market',
          side: closeSide,
          quantity: targetPair.positions.lighter.quantity
        }
      }));
    } else {
      const closeSide = targetPair.currentDirection === 'lighter_short' ? 'buy' : 'sell';
      logEvent(`[${targetPair.id}] Lighter 无持仓记录，尝试按当前方向平仓`);
      closePromises.push(placeLighterOrder({
        signerUrl: config.lighter_signer_url || DEFAULT_CONFIG.lighter_signer_url,
        skipAutoHedge: true,
        order: {
          market_id: targetPair.id,
          order_type: 'market',
          side: closeSide,
          quantity: qty
        }
      }));
    }

    // Close Variational
    if (targetPair.positions.variational) {
      const closeSide = targetPair.positions.variational.side === 'buy' ? 'sell' : 'buy';
      closePromises.push(placeVariationalOrder({
        order_type: 'market',
        side: closeSide,
        instrument: instrument,
        qty: targetPair.positions.variational.quantity.toString(),
        max_slippage: 0.001,
        is_reduce_only: false
      }, creds));
    } else {
      const closeSide = targetPair.currentDirection === 'lighter_short' ? 'sell' : 'buy';
      logEvent(`[${targetPair.id}] Variational 无持仓记录，尝试按当前方向平仓`);
      closePromises.push(placeVariationalOrder({
        order_type: 'market',
        side: closeSide,
        instrument: instrument,
        qty: qty.toString(),
        max_slippage: 0.001,
        is_reduce_only: false
      }, creds));
    }

    await Promise.all(closePromises);

    // Update state
    result = await chrome.storage.local.get(['strategyState']);
    state = result.strategyState;
    targetPair = state.pairs.find(p => p.id === pair.id);
    if (targetPair) {
      targetPair.positions.lighter = null;
      targetPair.positions.variational = null;
      targetPair.status = 'idle';
      await chrome.storage.local.set({ strategyState: state });
    }
    logEvent(`[${pair.id}] 平仓成功`);

  } catch (err) {
    logEvent(`[${pair.id}] 平仓失败: ${err.message}`);
    result = await chrome.storage.local.get(['strategyState']);
    state = result.strategyState;
    targetPair = state.pairs.find(p => p.id === pair.id);
    if (targetPair) {
      targetPair.status = 'error';
      await chrome.storage.local.set({ strategyState: state });
    }
  }
}

function runAsync(sendResponse, task) {
  (async () => task())()
    .then(sendResponse)
    .catch((err) => {
      console.error("[BG] async task error", err);
      sendResponse({ ok: false, error: err.message || "未知错误" });
    });
}

function logEvent(msg, addTimestamp = true) {
  const ts = new Date().toISOString();
  const entry = addTimestamp ? `[${ts}] ${msg}` : msg;
  state.logs.unshift(entry);
  if (state.logs.length > 1000) state.logs.pop();

  // Only save if loaded to avoid overwriting history with a partial list
  if (logsLoaded) {
    chrome.storage.local.set({ [STORAGE_LOGS_KEY]: state.logs });
  }
}

function setVrTokenCookie(token) {
  return new Promise((resolve, reject) => {
    // Ensure we remove any existing cookie first to force update
    chrome.cookies.remove({ url: "https://omni.variational.io", name: "vr-token" }, () => {
      chrome.cookies.set(
        {
          url: "https://omni.variational.io",
          domain: ".variational.io", // Set domain explicitly to match manual behavior if needed
          name: "vr-token",
          value: token,
          secure: true,
          path: "/",
          expirationDate: (Date.now() / 1000) + 86400 // 1 day
        },
        (cookie) => {
          if (chrome.runtime.lastError) {
            // Try without domain if it fails (e.g. localhost vs production)
            chrome.cookies.set({
              url: "https://omni.variational.io",
              name: "vr-token",
              value: token,
              secure: true,
              path: "/"
            }, (c) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              } else {
                resolve(c);
              }
            });
          } else {
            resolve(cookie);
          }
        }
      );
    });
  });
}

async function placeVariationalOrder(order, creds = {}) {
  if (!order) throw new Error("缺少订单数据");
  const wallet = creds.wallet || creds.walletAddress;
  if (!creds.vrToken || !wallet) {
    throw new Error("缺少 vr-token 或钱包地址");
  }

  await setVrTokenCookie(creds.vrToken);

  const config = await new Promise((resolve) =>
    chrome.storage.sync.get(["hedgeConfig"], (stored) =>
      resolve(stored.hedgeConfig || DEFAULT_CONFIG)
    )
  );
  const endpoints = buildVariationalEndpoints(config.variational_base_url);

  const type = order.order_type === "market" ? "market" : "limit";
  const endpoint = endpoints[type];
  if (!endpoint) {
    throw new Error(`不支持的订单类型：${order.order_type}`);
  }

  const payload =
    type === "market"
      ? await buildMarketOrderPayload(order)
      : sanitizeLimitOrderPayload(order);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Use the resolved wallet value so either storage key works
      "vr-connected-address": wallet
    },
    credentials: "include",
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `HTTP ${res.status}`, details: text };
  }

  const data = await res.json();
  logEvent(`Variational 下单成功 type=${type} side=${order.side} qty=${order.qty || order.quantity || "?"}`);
  state.hedge.variational_order = data;
  return { ok: true, data };
}

function sanitizeLimitOrderPayload(order) {
  if (!order.limit_price) throw new Error("限价单缺少 limit_price");
  return {
    order_type: "limit",
    limit_price: order.limit_price,
    side: order.side,
    instrument: order.instrument,
    qty: order.qty,
    is_auto_resize: !!order.is_auto_resize,
    use_mark_price: !!order.use_mark_price,
    is_reduce_only: !!order.is_reduce_only
  };
}

async function buildMarketOrderPayload(order) {
  if (!order.qty || !order.instrument) {
    throw new Error("市价单缺少数量或合约");
  }

  const quote = await fetchQuote(order.instrument, order.qty);
  if (!quote?.quote_id) {
    throw new Error("无法获取市价单报价");
  }

  const parsedSlippage = Number(order.max_slippage);
  return {
    quote_id: quote.quote_id,
    side: order.side,
    max_slippage: Number.isFinite(parsedSlippage) ? parsedSlippage : 0.0003,
    is_reduce_only: !!order.is_reduce_only
  };
}

async function fetchQuote(instrument, qty) {
  const cfg = await new Promise((resolve) =>
    chrome.storage.sync.get(["hedgeConfig"], (stored) =>
      resolve(stored.hedgeConfig || DEFAULT_CONFIG)
    )
  );
  const endpoints = buildVariationalEndpoints(cfg.variational_base_url);

  const res = await fetch(endpoints.quote, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    credentials: "include",
    body: JSON.stringify({ instrument, qty })
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    logEvent(
      `Variational 报价失败 HTTP ${res.status} instrument=${(instrument?.instrument_id || instrument?.underlying || "n/a")
      } qty=${qty} body=${errorText?.slice(0, 200)}`
    );
    throw new Error(`获取报价失败：HTTP ${res.status}`);
  }

  return res.json();
}

async function pollVariationalOrder(rfqId) {
  if (!rfqId) {
    throw new Error("缺少 rfqId");
  }

  const cfg = await new Promise((resolve) =>
    chrome.storage.sync.get(["hedgeConfig"], (stored) =>
      resolve(stored.hedgeConfig || DEFAULT_CONFIG)
    )
  );
  const endpoints = buildVariationalEndpoints(cfg.variational_base_url);

  const res = await fetch(endpoints.orders_query, {
    method: "GET",
    credentials: "include"
  });

  if (!res.ok) {
    if (res.status === 404) {
      return { ok: true, order: null };
    }
    return { ok: false, error: `HTTP ${res.status}` };
  }

  const data = await res.json();
  const order = (data.result || []).find((o) => o.rfq_id === rfqId);
  return { ok: true, order: order || null };
}

async function sendLighterOrderRequest(signerUrl, order) {
  const url = new URL("/order", signerUrl).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(order)
  });
  const raw = await res.json().catch(() => null);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: raw?.detail ?? raw?.error ?? "Signer 服务返回错误"
    };
  }

  return { ok: true, data: raw?.data || raw };
}

async function cancelLighterOrderRequest(signerUrl, clientOrderIndex) {
  if (!clientOrderIndex) return { ok: false, error: "缺少 client_order_index" };
  const url = new URL("/order/cancel", signerUrl).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_order_index: clientOrderIndex })
  });
  if (!res.ok) {
    const raw = await res.json().catch(() => null);
    return { ok: false, status: res.status, error: raw?.detail ?? "取消订单失败" };
  }
  return res.json().catch(() => ({ ok: true }));
}

async function placeLighterOrder(payload = {}) {
  const { signerUrl, order, skipAutoHedge } = payload;
  if (!signerUrl) throw new Error("缺少 signerUrl");
  if (!order) throw new Error("缺少 order 数据");

  const config = await new Promise((resolve) =>
    chrome.storage.sync.get(["hedgeConfig"], (stored) =>
      resolve(stored.hedgeConfig || DEFAULT_CONFIG)
    )
  );

  const preparedOrder = await prepareLighterOrderForStrategy(order, config, signerUrl);
  const result = await sendLighterOrderRequest(signerUrl, preparedOrder);
  if (!result.ok) return result;

  const data = result.data;
  const clientOrderIndex = data?.client_order_index;
  logEvent(
    `Lighter 订单已提交 type=${preparedOrder.order_type} side=${preparedOrder.side} qty=${preparedOrder.quantity || "?"
    } client_order_index=${clientOrderIndex ?? "n/a"}`
  );

  // Only trigger auto-hedge if skipAutoHedge is not set
  if (clientOrderIndex && !skipAutoHedge) {
    // Since WebSocket monitoring is unreliable, trigger hedge after a short delay
    // assuming the limit order will be filled quickly
    startLighterWatcher({
      signerUrl,
      originalOrder: preparedOrder,
      clientOrderIndex,
      hedgeConfig: config,
      attempt: 1
    });
  } else if (skipAutoHedge) {
    logEvent(`跳过自动对冲（来自策略系统）`);
  } else {
    logEvent("缺少 client_order_index，无法等待成交自动对冲");
  }

  return { ok: true, data };
}

async function waitForLighterFill(signerUrl, clientOrderIndex, orderType = 'limit', options = {}) {
  const statusUrl = new URL(`/order/status/${clientOrderIndex}`, signerUrl).toString();
  const limitMode = options.limitMode === true;
  // Market orders: 1 attempt (2s), Limit orders: default 15 attempts (30s) or 30 attempts (60s) when limit mode
  const maxAttempts = orderType === 'market' ? 1 : limitMode ? 30 : 15;
  const timeoutSeconds = (maxAttempts * 2);
  const timeoutMsg = `${timeoutSeconds}秒`;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const res = await fetch(statusUrl);
    if (!res.ok) {
      logEvent(`查询 Lighter 订单状态失败：HTTP ${res.status}`);
      await delay(2000);
      continue;
    }
    const body = await res.json().catch(() => null);
    const status = body?.status?.toLowerCase();
    if (status === "filled") {
      logEvent(`Lighter 订单已成交 client_order_index=${clientOrderIndex}`);
      return body?.order || {};
    }
    if (status === "canceled" || status === "expired") {
      throw new Error(`Lighter 订单状态：${body?.status}`);
    }
    await delay(2000);
  }
  // Timeout handling
  if (orderType === 'market') {
    logEvent(`等待 Lighter 市价成交超时（${timeoutMsg}），假定已成交并继续对冲`);
    return null;
  }
  const errMsg = `等待 Lighter 限价单成交超时（${timeoutMsg}），已放弃本次自动对冲`;
  logEvent(errMsg);
  const timeoutErr = new Error(errMsg);
  timeoutErr.code = 'lighter_limit_timeout';
  throw timeoutErr;
}

function startLighterWatcher({
  signerUrl,
  originalOrder,
  clientOrderIndex,
  hedgeConfig,
  attempt = 1,
  maxAttempts = 3
}) {
  (async () => {
    try {
      logEvent(`等待 Lighter 成交 client_order_index=${clientOrderIndex}`);
      const filled = await waitForLighterFill(
        signerUrl,
        clientOrderIndex,
        originalOrder.order_type,
        { limitMode: originalOrder.strategy_mode === HEDGE_MODES.LIGHTER_LIMIT }
      );
      const marketReference = buildMarketReference(originalOrder);

      // Use filled data if available, otherwise use original order
      const filledQty = filled
        ? Number(filled?.filled_base_amount ?? filled?.quantity ?? originalOrder.quantity)
        : Number(originalOrder.quantity);

      const orderForHedge = filled ? {
        ...originalOrder,
        ...filled,
        market_reference: marketReference,
        filled_base_amount: filled?.filled_base_amount ?? filled?.quantity,
        side: filled?.side ?? originalOrder.side,
        market_id: filled?.market_id ?? filled?.market_index ?? originalOrder.market_id
      } : {
        ...originalOrder,
        market_reference: marketReference
      };

      state.hedge.lighter_order = filled || originalOrder;
      logEvent(`触发对冲 数量=${filledQty} 方向=${orderForHedge.side}`);
      await autoHedge(orderForHedge, filledQty);
    } catch (err) {
      logEvent(`等待 Lighter 成交失败: ${err.message || err}`);
      const limitMode = originalOrder.strategy_mode === HEDGE_MODES.LIGHTER_LIMIT;
      if (limitMode && err.code === 'lighter_limit_timeout' && attempt < maxAttempts) {
        try {
          await handleLighterLimitRetry({
            signerUrl,
            previousOrder: originalOrder,
            clientOrderIndex,
            hedgeConfig,
            attempt,
            maxAttempts
          });
          return;
        } catch (retryErr) {
          logEvent(`限价订单重试失败: ${retryErr.message || retryErr}`);
        }
      }
      if (originalOrder.order_type === 'market') {
        logEvent(`市价订单未确认，尝试使用原始订单参数进行对冲`);
        try {
          await autoHedge(originalOrder, Number(originalOrder.quantity));
        } catch (hedgeErr) {
          logEvent(`对冲失败: ${hedgeErr.message || hedgeErr}`);
        }
      } else {
        logEvent(`限价订单未确认成交，跳过 Variational 对冲`);
      }
    }
  })();
}

async function handleLighterLimitRetry({
  signerUrl,
  previousOrder,
  clientOrderIndex,
  hedgeConfig,
  attempt,
  maxAttempts
}) {
  const cancelRes = await cancelLighterOrderRequest(signerUrl, clientOrderIndex);
  if (!cancelRes.ok) {
    throw new Error(cancelRes.error || "取消限价单失败");
  }

  const nextOrder = await cloneWithUpdatedLimitPrice(previousOrder, signerUrl);
  if (!nextOrder) {
    throw new Error("无法获取最新盘口价格");
  }

  const sendRes = await sendLighterOrderRequest(signerUrl, nextOrder);
  if (!sendRes.ok) {
    throw new Error(sendRes.error || "重新挂单失败");
  }

  logEvent(
    `已重新提交 Lighter 限价单 attempt=${attempt + 1}/${maxAttempts} client_order_index=${sendRes.data?.client_order_index}`
  );

  startLighterWatcher({
    signerUrl,
    originalOrder: nextOrder,
    clientOrderIndex: sendRes.data?.client_order_index,
    hedgeConfig,
    attempt: attempt + 1,
    maxAttempts
  });
}

async function autoHedge(lighterOrder, filledQtyOverride) {
  const config = await new Promise((resolve) =>
    chrome.storage.sync.get(["hedgeConfig"], (stored) =>
      resolve(stored.hedgeConfig || DEFAULT_CONFIG)
    )
  );
  const ratio = Number(config.hedge_ratio || 1);
  if (!Number.isFinite(ratio) || ratio <= 0) return;

  const baseQtyRaw = Number(
    filledQtyOverride ??
    lighterOrder?.filled_base_amount ??
    lighterOrder?.quantity ??
    lighterOrder?.qty ??
    0
  );
  if (!baseQtyRaw || baseQtyRaw <= 0) {
    logEvent("对冲跳过：数量无效");
    return;
  }

  const qty = baseQtyRaw * ratio;
  const side = lighterOrder.side === "buy" ? "sell" : "buy";
  const marketReference =
    lighterOrder.market_reference ||
    lighterOrder.market_symbol ||
    (typeof lighterOrder.market_id === "string" && lighterOrder.market_id.includes("-")
      ? lighterOrder.market_id
      : null) ||
    (typeof lighterOrder.marketId === "string" && lighterOrder.marketId.includes("-")
      ? lighterOrder.marketId
      : null) ||
    state.hedge.last_pair ||
    lighterOrder.market_id ||
    lighterOrder.marketId;
  state.hedge.last_pair = marketReference || state.hedge.last_pair;
  state.hedge.lighter_order = {
    ...lighterOrder,
    market_reference: marketReference,
    quantity: baseQtyRaw
  };

  const instrument =
    lighterOrder.instrument ||
    deriveInstrumentFromMarket(
      marketReference || lighterOrder.market_id || lighterOrder.marketId
    ) ||
    config.variational_instrument ||
    ORDER_INSTRUMENT;

  const hedgeOrder = {
    order_type: "market",
    side: side,
    instrument,
    qty: qty.toString(),
    max_slippage: config.hedge_slippage || 0.001,
    is_reduce_only: false
  };
  logEvent(
    `准备 Variational 对冲 instrument=${instrument?.instrument_id || instrument?.symbol || instrument?.underlying
    } side=${side} qty=${qty}`
  );

  const creds = await new Promise((resolve) =>
    chrome.storage.sync.get(["vrToken", "walletAddress"], resolve)
  );

  try {
    const res = await retryOperation(() => placeVariationalOrder(hedgeOrder, creds), 3, 1500);
    if (res.ok) {
      logEvent(`对冲下单完成 side=${side} qty=${qty} rfq=${res.data?.rfq_id}`);
      state.hedge.last_check = new Date().toISOString();
      state.hedge.imbalance = Math.abs(baseQtyRaw - qty);
      if (res.data?.rfq_id) {
        try {
          const poll = await pollVariationalOrder(res.data.rfq_id);
          state.hedge.variational_order = poll?.order || res.data;
        } catch (e) {
          logEvent(`对冲状态查询失败: ${e.message || e}`);
        }
      }
    } else {
      logEvent(`对冲下单失败: ${res.error} ${res.details || ""}`);
    }
  } catch (err) {
    logEvent(`对冲下单异常: ${err.message}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Strategy Execution Logic (Background) ---

// Helper for retrying async operations
async function retryOperation(fn, maxRetries = 3, delayMs = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await fn();
      if (result && result.ok === false) {
        throw new Error(result.error || 'Unknown error');
      }
      return result;
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      logEvent(`操作失败 (尝试 ${i + 1}/${maxRetries}): ${err.message}. ${delayMs}ms 后重试...`);
      await delay(delayMs);
      delayMs *= 1.5;
    }
  }
}

// Alarm listener for periodic strategy checks and market refresh
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'strategyTicker') {
    checkStrategy();
  } else if (alarm.name === 'marketRefresh') {
    fetchLighterMarkets();
  }
});

// Initialize market refresh alarm on startup
chrome.alarms.create('marketRefresh', { periodInMinutes: 60 });
// Fetch markets immediately on startup
fetchLighterMarkets();

async function checkStrategy() {
  const result = await chrome.storage.local.get(['strategyState']);
  const state = result.strategyState;

  if (!state || !state.isRunning) return;

  const now = Date.now();
  let stateChanged = false;

  for (const pair of state.pairs) {
    if (pair.status === 'running' && pair.nextFlip && now >= pair.nextFlip) {
      logEvent(`[${pair.id}] 触发定时反转...`);
      await executeFlip(pair, state.flipInterval);
      stateChanged = true;
    }
  }

  if (stateChanged) {
    chrome.storage.local.set({ strategyState: state });
  }
}

async function executeFlip(pair, flipInterval) {
  logEvent(`[${pair.id}] 开始执行后台反转...`);

  const currentDir = pair.currentDirection;
  const nextDir = currentDir === 'lighter_short' ? 'lighter_long' : 'lighter_short';

  const lighterSide = currentDir === 'lighter_short' ? 'buy' : 'sell';
  const lighterQty = pair.quantity * 2;

  const variationalSide = currentDir === 'lighter_short' ? 'sell' : 'buy';
  const variationalQty = pair.quantity * 2;

  logEvent(`[${pair.id}] 执行反转: Lighter ${lighterSide} ${lighterQty}, Variational ${variationalSide} ${variationalQty}`);

  try {
    // Get credentials for Variational
    const creds = await new Promise((resolve) =>
      chrome.storage.sync.get(["vrToken", "walletAddress"], resolve)
    );

    // Config for Variational instrument
    const config = await new Promise((resolve) =>
      chrome.storage.sync.get(["hedgeConfig"], (stored) =>
        resolve(stored.hedgeConfig || DEFAULT_CONFIG)
      )
    );
    const instrument =
      deriveInstrumentFromMarket(pair.id) ||
      config.variational_instrument ||
      ORDER_INSTRUMENT;

    const signerUrl = config.lighter_signer_url || DEFAULT_CONFIG.lighter_signer_url;

    // Prepare Lighter order with price resolution
    const lighterOrderBase = {
      market_id: pair.id,
      order_type: 'market',  // Will be converted to limit if price is available
      side: lighterSide,
      quantity: lighterQty
    };

    const preparedLighterOrder = await prepareLighterOrderForStrategy(lighterOrderBase, config, signerUrl);
    logEvent(`[${pair.id}] 反转订单类型: ${preparedLighterOrder.order_type}${preparedLighterOrder.price ? ` @ ${preparedLighterOrder.price}` : ''}`);

    // Step 1: Place Lighter order first with retry
    logEvent(`[${pair.id}] Step 1: 提交 Lighter ${lighterSide} ${lighterQty}...`);
    let lighterResult;
    try {
      lighterResult = await retryOperation(() => placeLighterOrder({
        signerUrl: signerUrl,
        skipAutoHedge: true,
        order: preparedLighterOrder
      }), 3, 2000);
    } catch (err) {
      logEvent(`[${pair.id}] Lighter 订单失败: ${err?.message || JSON.stringify(err)}`);
      logEvent(`[${pair.id}] 反转失败，策略已停止`);
      pair.status = 'error';
      return;
    }

    const lighterOk = lighterResult && lighterResult.ok !== false;
    if (!lighterOk) {
      logEvent(`[${pair.id}] Lighter 订单未成功: ${JSON.stringify(lighterResult)}`);
      logEvent(`[${pair.id}] 反转失败，策略已停止`);
      pair.status = 'error';
      return;
    }

    logEvent(`[${pair.id}] ✓ Lighter 订单已提交，等待成交确认...`);

    // Step 2: Wait for Lighter order confirmation (give it some time to fill)
    // For market orders, typically fill within seconds
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Step 3: Place Variational hedge order
    logEvent(`[${pair.id}] Step 2: 提交 Variational ${variationalSide} ${variationalQty} 对冲...`);
    let variationalResult;
    try {
      variationalResult = await retryOperation(() => placeVariationalOrder({
        order_type: 'market',
        side: variationalSide,
        instrument: instrument,
        qty: variationalQty.toString(),
        max_slippage: 0.001,
        is_reduce_only: false
      }, creds), 3, 2000);
    } catch (err) {
      logEvent(`[${pair.id}] ⚠️ Variational 对冲失败: ${err?.message || JSON.stringify(err)}`);
      logEvent(`[${pair.id}] Lighter 已成交但 Variational 失败 - 存在单边敞口！请立即手动对冲！`);
      pair.status = 'error';
      return;
    }

    const variationalOk = variationalResult && variationalResult.ok !== false;
    if (!variationalOk) {
      logEvent(`[${pair.id}] ⚠️ Variational 对冲未成功: ${JSON.stringify(variationalResult)}`);
      logEvent(`[${pair.id}] Lighter 已成交但 Variational 失败 - 存在单边敞口！请立即手动对冲！`);
      pair.status = 'error';
      return;
    }

    logEvent(`[${pair.id}] ✓ 反转成功完成`);

    // Success
    pair.currentDirection = nextDir;
    pair.positions.lighter = { side: lighterSide, quantity: pair.quantity };
    pair.positions.variational = { side: variationalSide, quantity: pair.quantity };

    pair.lastFlip = Date.now();
    pair.nextFlip = Date.now() + flipInterval;
    pair.status = 'running';

    logEvent(`[${pair.id}] 反转完成`);

  } catch (err) {
    logEvent(`[${pair.id}] 反转执行致命错误: ${err.message}`);
    pair.status = 'error';
  }
}

function deriveInstrumentFromMarket(marketId) {
  if (!marketId) return null;
  const normalized = String(marketId).trim();
  if (!normalized) return null;
  const upper = normalized.toUpperCase();
  const parts = upper.split("-");
  const underlying = (parts[0] || "BTC").trim() || "BTC";
  const suffix = parts.length > 1 ? parts.slice(1).join("-") : "PERP";
  const symbol = parts.length > 1 ? upper : `${underlying}-${suffix}`;
  return {
    instrument_type: "perpetual_future",
    underlying,
    funding_interval_s: 3600,
    settlement_asset: "USDC",
    instrument_id: symbol,
    symbol,
    market_id: symbol
  };
}
