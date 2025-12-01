const varPriceEl = document.getElementById("var-price");
const ligPriceEl = document.getElementById("lig-price");
const spreadEl = document.getElementById("spread");
const spreadLongEl = document.getElementById("spread-long");
const spreadShortEl = document.getElementById("spread-short");
const varMarkEl = document.getElementById("var-mark");
const varBidEl = document.getElementById("var-bid");
const varAskEl = document.getElementById("var-ask");

// Variational form elements
const orderForm = document.getElementById("order-form");
const closeBtn = document.getElementById("close-popup");
const tokenInput = document.getElementById("vr-token");
const walletInput = document.getElementById("wallet-address");
const orderTypeSelect = document.getElementById("order-type");
const instrumentInput = document.getElementById("instrument-symbol");
const limitPriceRow = document.getElementById("limit-price-row");
const limitPriceInput = document.getElementById("limit-price");
const slippageRow = document.getElementById("slippage-row");
const maxSlippageInput = document.getElementById("max-slippage");
const qtyInput = document.getElementById("qty");
const sideSelect = document.getElementById("side");
const reduceOnlyInput = document.getElementById("reduce-only");
const autoResizeInput = document.getElementById("auto-resize");
const useMarkInput = document.getElementById("use-mark");
const submitBtn = document.getElementById("submit-order");
const orderStatusEl = document.getElementById("order-status");
const orderDetailsEl = document.getElementById("order-details");

// Lighter form elements
const lighterForm = document.getElementById("lighter-form");
const signerUrlInput = document.getElementById("signer-url");
const lighterMarketInput = document.getElementById("lighter-market");
const pairSelect = document.getElementById("pair-select");
const lighterOrderTypeSelect = document.getElementById("lighter-order-type");
const lighterLimitRow = document.getElementById("lighter-limit-row");
const lighterPriceInput = document.getElementById("lighter-price");
const lighterMaxSlippageInput = document.getElementById("lighter-max-slippage");
const lighterQtyInput = document.getElementById("lighter-qty");
const lighterSideSelect = document.getElementById("lighter-side");
const lighterReduceOnlyInput = document.getElementById("lighter-reduce-only");
const lighterSubmitBtn = document.getElementById("submit-lighter");
const lighterStatusEl = document.getElementById("lighter-status");
const lighterResponseEl = document.getElementById("lighter-response");

const logOutput = document.getElementById("log-output");
const navButtons = Array.from(document.querySelectorAll(".nav-btn"));
const subTabButtons = Array.from(document.querySelectorAll(".sub-tab-btn"));
const tabPanels = Array.from(document.querySelectorAll(".tab-panel"));
const subPanels = Array.from(document.querySelectorAll(".sub-panel"));

const STORAGE_KEYS = {
  token: "vrToken",
  wallet: "walletAddress",
  lighterSignerUrl: "lighterSignerUrl",
  lighterMarket: "lighterMarketId",
  hedgeConfig: "hedgeConfig",
  selectedPair: "selectedPair",
  apiConfig: "apiConfig",
  instrumentSymbol: "variationalInstrumentSymbol"
};

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

let pairsCache = [
  { id: "BTC-PERP", underlying: "BTC" },
  { id: "ETH-PERP", underlying: "ETH" }
];

const POLL_INTERVAL_MS = 2000;
const MAX_PENDING_ATTEMPTS = 15;
const LIGHTER_DEFAULT_URL = "http://127.0.0.1:8787";
const VAR_DEFAULT_BASE = "https://omni.variational.io";

let pollTimer = null;
let pollAttempts = 0;
let manualCloseRequested = false;
const logBuffer = [];

function setText(el, value, digits = 2) {
  if (!el) return;
  if (value === null || value === undefined || Number.isNaN(value)) {
    el.textContent = "--";
  } else {
    el.textContent = Number(value).toFixed(digits);
  }
}

function setSpreadColor(el, value) {
  if (!el) return;
  if (value === null || value === undefined || Number.isNaN(value)) {
    el.textContent = "--";
    el.className = "";
  } else {
    el.textContent = Number(value).toFixed(2);
    el.className = value >= 0 ? "text-green" : "text-red"; // Updated classes
  }
}

function saveInstrumentPreference(value) {
  if (!chrome.storage?.sync) return;
  chrome.storage.sync.set({
    [STORAGE_KEYS.instrumentSymbol]: value ?? ""
  });
}

function restoreInstrumentPreference() {
  if (!instrumentInput || !chrome.storage?.sync) return;
  chrome.storage.sync.get([STORAGE_KEYS.instrumentSymbol], (stored) => {
    if (stored?.[STORAGE_KEYS.instrumentSymbol]) {
      instrumentInput.value = stored[STORAGE_KEYS.instrumentSymbol];
    } else if (!instrumentInput.value) {
      instrumentInput.value = ORDER_INSTRUMENT.underlying;
    }
  });
}

function parseInstrumentInput() {
  if (!instrumentInput) return { ...ORDER_INSTRUMENT };
  const raw = instrumentInput.value?.trim();
  if (!raw) return { ...ORDER_INSTRUMENT };
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      return {
        ...ORDER_INSTRUMENT,
        ...parsed
      };
    } catch (err) {
      throw new Error("合约 JSON 无法解析");
    }
  }
  const upper = raw.toUpperCase();
  const underlying = upper.includes("-") ? upper.split("-")[0] : upper;
  return {
    ...ORDER_INSTRUMENT,
    underlying
  };
}

function refreshMarkets() {
  chrome.runtime.sendMessage({ type: "get_state" }, (state) => {
    if (!state) return;
    const v = state.variational;
    const l = state.lighter;

    const vBid = v?.bid1 ?? null;
    const vAsk = v?.ask1 ?? null;
    const vMain = v ? v.markPrice ?? v.lastPrice ?? v.mid ?? null : null;

    const lBid = l?.bid1 ?? null;
    const lAsk = l?.ask1 ?? null;
    const lMain = l ? l.markPrice ?? l.lastPrice ?? l.mid ?? null : null;

    setText(varPriceEl, vMain);
    setText(ligPriceEl, lMain);

    if (vMain !== null && lMain !== null) {
      setSpreadColor(spreadEl, vMain - lMain);
    } else {
      setSpreadColor(spreadEl, null);
    }

    const spreadLong = vAsk !== null && lBid !== null ? vAsk - lBid : null;
    const spreadShort = vBid !== null && lAsk !== null ? vBid - lAsk : null;
    setSpreadColor(spreadLongEl, spreadLong);
    setSpreadColor(spreadShortEl, spreadShort);

    const vMark = v?.markPrice ?? v?.lastPrice ?? null;
    setText(varMarkEl, vMark);
    setText(varBidEl, vBid);
    setText(varAskEl, vAsk);
  });
}

setInterval(refreshMarkets, 500);
refreshMarkets();

function logMessage(msg) {
  const timestamp = new Date().toLocaleTimeString();
  const formattedMsg = `[${timestamp}] ${msg}`;

  // Send to background for persistence
  chrome.runtime.sendMessage({ type: "add_log", message: formattedMsg });

  // Optimistic render
  renderLogEntry(formattedMsg);
}

function renderLogEntry(entryText) {
  if (!logOutput) return;
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.textContent = entryText;

  if (logOutput.firstChild) {
    logOutput.insertBefore(entry, logOutput.firstChild);
  } else {
    logOutput.appendChild(entry);
  }

  while (logOutput.children.length > 200) {
    logOutput.removeChild(logOutput.lastChild);
  }
}

function initLogs() {
  const logPanel = document.getElementById("log-output");
  if (!logPanel) return;

  // Load initial logs from storage
  chrome.storage.local.get(["dcc_logs"], (result) => {
    const logs = result.dcc_logs || [];
    logPanel.innerHTML = ""; // Clear "System Initialized"
    logs.forEach(log => {
      const entry = document.createElement("div");
      entry.className = "log-entry";
      entry.textContent = log;
      logPanel.appendChild(entry);
    });
  });

  // Listen for new logs from background/other contexts
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.dcc_logs) {
      const newLogs = changes.dcc_logs.newValue || [];
      // Simple approach: re-render if significantly different, or just prepend the new ones?
      // Since we unshift in background, index 0 is newest.
      // If we just want to show the latest, we can check if the first item is different.
      // But since we optimistically render local logs, we might duplicate if we aren't careful.
      // However, background saves the exact string we sent.
      // To avoid complexity, let's just re-render the whole list for now, 
      // or better: only prepend if it's not the one we just added.
      // Actually, re-rendering 100 items is fast. Let's just re-render to ensure consistency.

      logPanel.innerHTML = "";
      newLogs.forEach(log => {
        const entry = document.createElement("div");
        entry.className = "log-entry";
        entry.textContent = log;
        logPanel.appendChild(entry);
      });
    }
  });
}

function renderOrderDetails(order) {
  if (!orderDetailsEl || !order) return;
  const lines = [
    `状态: ${order.status ?? "--"}${order.clearing_status ? ` / ${order.clearing_status}` : ""}`,
    `方向: ${order.side ?? "--"}, 数量: ${order.qty ?? "--"}`,
    `价格: ${order.price ?? order.limit_price ?? "--"}`,
    `创建: ${order.created_at ?? "--"}`,
    `执行: ${order.execution_timestamp ?? "--"}`
  ];
  orderDetailsEl.textContent = lines.join(" | ");
}

function setStatus(msg, order = null) {
  if (orderStatusEl) {
    orderStatusEl.textContent = msg;
  }
  if (!order && orderDetailsEl) {
    orderDetailsEl.textContent = "";
  }
}

function setFormDisabled(disabled) {
  if (submitBtn) submitBtn.disabled = disabled;
}

function saveCredentials(token, wallet) {
  if (!chrome.storage?.sync) return;
  chrome.storage.sync.set({
    [STORAGE_KEYS.token]: token,
    [STORAGE_KEYS.wallet]: wallet
  });
}

function restoreCredentials() {
  if (!chrome.storage?.sync) return;
  chrome.storage.sync.get(
    [STORAGE_KEYS.token, STORAGE_KEYS.wallet],
    (stored) => {
      if (tokenInput && stored?.[STORAGE_KEYS.token]) {
        tokenInput.value = stored[STORAGE_KEYS.token];
      }
      if (walletInput && stored?.[STORAGE_KEYS.wallet]) {
        walletInput.value = stored[STORAGE_KEYS.wallet];
      }
      // Sync to config inputs
      const cfgToken = document.getElementById("cfg-var-token");
      const cfgWallet = document.getElementById("cfg-var-wallet");
      if (cfgToken && stored?.[STORAGE_KEYS.token]) {
        cfgToken.value = stored[STORAGE_KEYS.token];
      }
      if (cfgWallet && stored?.[STORAGE_KEYS.wallet]) {
        cfgWallet.value = stored[STORAGE_KEYS.wallet];
      }
    }
  );
}

function clearPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pollAttempts = 0;
}

function startPolling(rfqId) {
  clearPolling();
  pollTimer = setInterval(() => {
    pollAttempts += 1;
    chrome.runtime.sendMessage({ type: "poll_order", rfqId }, (resp) => {
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message;
        setStatus(`查询失败: ${errMsg}`);
        logMessage(`订单 ${rfqId} 查询失败: ${errMsg}`);
        clearPolling();
        return;
      }
      if (!resp) return;
      if (!resp.ok) {
        const errMsg = resp.error ?? "未知错误";
        setStatus(`查询失败: ${errMsg}`);
        logMessage(`订单 ${rfqId} 查询失败: ${errMsg}`);
        clearPolling();
        return;
      }

      const order = resp.order;
      if (!order || order.status === "pending") {
        if (pollAttempts >= MAX_PENDING_ATTEMPTS) {
          setStatus("已提交，等待同步...", order || undefined);
          if (order?.clearing_status) {
            renderOrderDetails(order);
          }
        }
        return;
      }

      clearPolling();
      if (order.status === "cleared") {
        const filledPrice = order.price ?? "--";
        const execTime = order.execution_timestamp ?? "--";
        setStatus(`成交: ${filledPrice} @ ${execTime}`, order);
        logMessage(`订单 ${rfqId} 成交: ${filledPrice} @ ${execTime}`);
        renderOrderDetails(order);
      } else {
        const extra = order.cancel_reason ? ` (${order.cancel_reason})` : "";
        setStatus(`结束: ${order.status}${extra}`, order);
        logMessage(`订单 ${rfqId} 结束: ${order.status}${extra}`);
        renderOrderDetails(order);
      }
    });
  }, POLL_INTERVAL_MS);
}

function handleOrderSubmit(evt) {
  evt.preventDefault();
  if (!orderForm) return;

  const orderType = orderTypeSelect?.value ?? "limit";
  const limitPrice = limitPriceInput?.value?.trim();
  const qty = qtyInput?.value?.trim();
  const side = sideSelect?.value ?? "buy";
  const token = tokenInput?.value?.trim();
  const wallet = walletInput?.value?.trim();
  const reduceOnly = reduceOnlyInput?.checked ?? false;
  const isAutoResize = autoResizeInput?.checked ?? false;
  const useMarkPrice = useMarkInput?.checked ?? false;
  const maxSlippage = Number(maxSlippageInput?.value ?? "0.0003") || 0.0003;

  if (orderType === "limit") {
    if (!limitPrice || Number(limitPrice) <= 0) {
      setStatus("无效的限价");
      return;
    }
  }

  if (!qty || Number(qty) <= 0) {
    setStatus("无效的数量");
    return;
  }

  if (!token || !wallet) {
    setStatus("缺少 Token 或钱包地址");
    return;
  }

  saveCredentials(token, wallet);
  if (instrumentInput) {
    saveInstrumentPreference(instrumentInput.value?.trim() ?? "");
  }

  let instrumentConfig;
  try {
    instrumentConfig = parseInstrumentInput();
  } catch (instrumentErr) {
    setStatus(`合约配置错误: ${instrumentErr.message}`);
    return;
  }

  const orderPayload =
    orderType === "limit"
      ? {
        order_type: "limit",
        limit_price: limitPrice,
        side,
        instrument: instrumentConfig,
        qty,
        is_auto_resize: isAutoResize,
        use_mark_price: useMarkPrice,
        is_reduce_only: reduceOnly
      }
      : {
        order_type: "market",
        side,
        instrument: instrumentConfig,
        qty,
        max_slippage: maxSlippage,
        is_reduce_only: reduceOnly
      };

  setFormDisabled(true);
  const desc = orderType === "limit" ? "限价单" : "市价单";
  setStatus(`正在提交 ${desc}...`);
  logMessage(`正在提交 Variational ${desc}: ${side} ${qty}`);

  chrome.runtime.sendMessage(
    {
      type: "place_order",
      orderType,
      order: orderPayload,
      creds: { vrToken: token, wallet }
    },
    (resp) => {
      setFormDisabled(false);
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message;
        setStatus(`通信错误: ${errMsg}`);
        logMessage(`提交失败: ${errMsg}`);
        return;
      }
      if (!resp || !resp.ok) {
        const errMsg = resp?.error ?? "未知错误";
        setStatus(`下单失败: ${errMsg}`);
        logMessage(`提交失败: ${errMsg}`);
        return;
      }
      const rfqId = resp.data?.rfq_id;
      setStatus(rfqId ? `已提交, RFQ ${rfqId}` : "已提交，等待成交...");
      logMessage(
        rfqId
          ? `已提交, RFQ ${rfqId}`
          : "已提交 (无 RFQ)"
      );
      if (rfqId) {
        startPolling(rfqId);
      }
    }
  );
}

function updateOrderTypeUI() {
  const isLimit = (orderTypeSelect?.value ?? "limit") === "limit";
  if (limitPriceRow) {
    limitPriceRow.classList.toggle("hidden", !isLimit);
  }
  if (limitPriceInput) {
    limitPriceInput.required = isLimit;
  }
  if (slippageRow) {
    slippageRow.classList.toggle("hidden", isLimit);
  }
}

// ---------- Lighter form ----------

function updateLighterOrderTypeUI() {
  const isLimit = (lighterOrderTypeSelect?.value ?? "market") === "limit";
  if (lighterLimitRow) {
    lighterLimitRow.classList.toggle("hidden", !isLimit);
  }
  if (lighterPriceInput) {
    lighterPriceInput.required = isLimit;
    if (!isLimit) lighterPriceInput.value = "";
  }
  if (lighterMaxSlippageInput) {
    lighterMaxSlippageInput.disabled = isLimit;
  }
}

function setLighterStatus(msg) {
  if (lighterStatusEl) {
    lighterStatusEl.textContent = msg;
  }
}

function renderLighterResponse(payload) {
  if (!lighterResponseEl) return;
  const hasContent = payload && Object.keys(payload).length > 0;
  lighterResponseEl.textContent = JSON.stringify(payload ?? {}, null, 2);
  if (hasContent) {
    lighterResponseEl.classList.remove("hidden");
  } else {
    lighterResponseEl.classList.add("hidden");
  }
}

function saveLighterSettings(url, marketId) {
  if (!chrome.storage?.sync) return;
  chrome.storage.sync.set({
    [STORAGE_KEYS.lighterSignerUrl]: url,
    [STORAGE_KEYS.lighterMarket]: marketId
  });
}

function restoreLighterSettings() {
  if (!chrome.storage?.sync) return;
  chrome.storage.sync.get(
    [STORAGE_KEYS.lighterSignerUrl, STORAGE_KEYS.lighterMarket, STORAGE_KEYS.hedgeConfig],
    (stored) => {
      const cfg = stored?.[STORAGE_KEYS.hedgeConfig] || {};
      if (signerUrlInput) {
        signerUrlInput.value =
          stored?.[STORAGE_KEYS.lighterSignerUrl] ??
          cfg.lighter_signer_url ??
          LIGHTER_DEFAULT_URL;
      }
      if (lighterMarketInput && stored?.[STORAGE_KEYS.lighterMarket]) {
        lighterMarketInput.value = stored[STORAGE_KEYS.lighterMarket];
      }
    }
  );
}

function handleLighterSubmit(evt) {
  evt.preventDefault();
  if (!lighterForm) return;

  const signerUrl = signerUrlInput?.value?.trim() || LIGHTER_DEFAULT_URL;
  const marketId =
    lighterMarketInput?.value?.trim() ||
    pairSelect?.value ||
    pairsCache[0]?.id ||
    "BTC-PERP";
  const orderType = lighterOrderTypeSelect?.value ?? "market";
  const price = lighterPriceInput?.value?.trim();
  const maxSlippageInput = lighterMaxSlippageInput?.value?.trim();
  const parsedMaxSlip = maxSlippageInput ? Number(maxSlippageInput) : null;
  const quantity = lighterQtyInput?.value?.trim();
  const side = lighterSideSelect?.value ?? "buy";
  const reduceOnly = lighterReduceOnlyInput?.checked ?? false;

  if (!marketId) {
    setLighterStatus("请输入市场 ID");
    return;
  }

  if (orderType === "limit" && (!price || Number(price) <= 0)) {
    setLighterStatus("无效的限价");
    return;
  }

  if (!quantity || Number(quantity) <= 0) {
    setLighterStatus("无效的数量");
    return;
  }

  saveLighterSettings(signerUrl, marketId);

  const orderPayload = {
    market_id: marketId,
    order_type: orderType,
    side,
    quantity,
    price: orderType === "limit" ? price : null,
    max_slippage:
      orderType === "market" && parsedMaxSlip !== null ? parsedMaxSlip : null,
    reduce_only: reduceOnly
  };

  if (lighterSubmitBtn) lighterSubmitBtn.disabled = true;
  setLighterStatus("正在提交到签名服务...");
  renderLighterResponse({});
  logMessage(
    `正在提交 Lighter ${orderType}: ${marketId} ${side} ${quantity}`
  );

  chrome.runtime.sendMessage(
    {
      type: "lighter_place_order",
      payload: {
        signerUrl,
        order: orderPayload
      }
    },
    (resp) => {
      if (lighterSubmitBtn) lighterSubmitBtn.disabled = false;
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message;
        setLighterStatus(`通信错误: ${errMsg}`);
        logMessage(`Lighter 失败: ${errMsg}`);
        return;
      }
      if (!resp || !resp.ok) {
        const errMsg = resp?.error ?? "未知错误";
        setLighterStatus(`下单失败: ${errMsg}`);
        logMessage(`Lighter 失败: ${errMsg}`);
        renderLighterResponse(resp);
        return;
      }
      setLighterStatus("已提交，等待成交...");
      renderLighterResponse(resp.data ?? resp);
      logMessage("Lighter 订单已提交");
    }
  );
}

function initTabs() {
  // Main Navigation
  navButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-target");

      navButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      tabPanels.forEach((panel) => panel.classList.remove("active"));
      const targetPanel = document.getElementById(targetId);
      if (targetPanel) {
        targetPanel.classList.add("active");
      }
    });
  });

  // Sub Tabs (Trade Panel)
  subTabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-subtarget");

      subTabButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      subPanels.forEach((panel) => panel.classList.add("hidden"));
      subPanels.forEach((panel) => panel.classList.remove("active"));

      const targetPanel = document.getElementById(targetId);
      if (targetPanel) {
        targetPanel.classList.remove("hidden");
        targetPanel.classList.add("active");
      }
    });
  });
}

async function loadPairs() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "get_pairs" }, (resp) => {
      if (resp && Array.isArray(resp)) {
        pairsCache = resp;
      }
      resolve(pairsCache);
    });
  });
}

function renderPairs() {
  if (!pairSelect) return;
  pairSelect.innerHTML = "";
  pairsCache.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.id;
    pairSelect.appendChild(opt);
  });
  chrome.storage.sync.get([STORAGE_KEYS.selectedPair], (stored) => {
    if (stored?.[STORAGE_KEYS.selectedPair]) {
      pairSelect.value = stored[STORAGE_KEYS.selectedPair];
      if (lighterMarketInput) lighterMarketInput.value = pairSelect.value;
    }
  });
  pairSelect.addEventListener("change", () => {
    const val = pairSelect.value;
    if (lighterMarketInput) lighterMarketInput.value = val;
    chrome.storage.sync.set({ [STORAGE_KEYS.selectedPair]: val });
  });
}

async function loadConfig() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "get_config" }, (cfg) => {
      resolve(cfg || {});
    });
  });
}

async function saveConfig(cfg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "set_config", payload: cfg }, (resp) =>
      resolve(resp)
    );
  });
}

function initConfigUI() {
  const hedgeRatioInput = document.getElementById("cfg-hedge-ratio");
  const hedgeSlipInput = document.getElementById("cfg-hedge-slip");
  const hedgeModeSelect = document.getElementById("cfg-hedge-mode");
  const cfgSignerUrlInput = document.getElementById("cfg-signer-url");
  const cfgVarBaseInput = document.getElementById("cfg-var-base");
  const cfgTokenInput = document.getElementById("cfg-var-token");
  const cfgWalletInput = document.getElementById("cfg-var-wallet");

  loadConfig().then((cfg) => {
    if (hedgeRatioInput) hedgeRatioInput.value = cfg.hedge_ratio ?? 1;
    if (hedgeSlipInput) hedgeSlipInput.value = cfg.hedge_slippage ?? 0.001;
    if (hedgeModeSelect) hedgeModeSelect.value = cfg.hedge_mode ?? HEDGE_MODES.MARKET;
    if (cfgSignerUrlInput)
      cfgSignerUrlInput.value = cfg.lighter_signer_url ?? LIGHTER_DEFAULT_URL;
    if (cfgVarBaseInput)
      cfgVarBaseInput.value = cfg.variational_base_url ?? VAR_DEFAULT_BASE;
    chrome.storage.sync.get(
      [STORAGE_KEYS.token, STORAGE_KEYS.wallet],
      (stored) => {
        if (cfgTokenInput && stored?.[STORAGE_KEYS.token]) {
          cfgTokenInput.value = stored[STORAGE_KEYS.token];
        }
        if (cfgWalletInput && stored?.[STORAGE_KEYS.wallet]) {
          cfgWalletInput.value = stored[STORAGE_KEYS.wallet];
        }
      }
    );
  });

  const saveBtn = document.getElementById("save-config");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const newCfg = {
        hedge_ratio: Number(hedgeRatioInput?.value || 1),
        hedge_slippage: Number(hedgeSlipInput?.value || 0.001),
        hedge_mode: hedgeModeSelect?.value || HEDGE_MODES.MARKET,
        lighter_signer_url:
          cfgSignerUrlInput?.value?.trim() || LIGHTER_DEFAULT_URL,
        variational_base_url:
          cfgVarBaseInput?.value?.trim() || VAR_DEFAULT_BASE
      };
      await saveConfig(newCfg);
      const tokenVal = cfgTokenInput?.value?.trim();
      const walletVal = cfgWalletInput?.value?.trim();
      chrome.storage.sync.set({
        [STORAGE_KEYS.token]: tokenVal || "",
        [STORAGE_KEYS.wallet]: walletVal || "",
        [STORAGE_KEYS.lighterSignerUrl]: newCfg.lighter_signer_url
      });
      if (tokenInput && tokenVal) tokenInput.value = tokenVal;
      if (walletInput && walletVal) walletInput.value = walletVal;
      if (signerUrlInput) signerUrlInput.value = newCfg.lighter_signer_url;
      logMessage("配置已保存");
    });
  }
}

// Old initLogs removed


// Hedge Status
function initHedgeStatus() {
  const posEl = document.getElementById("hedge-positions");
  const pnlEl = document.getElementById("hedge-pnl");
  const logEl = document.getElementById("hedge-log");

  const refresh = () => {
    chrome.runtime.sendMessage({ type: "get_hedge_status" }, (data) => {
      if (!data) return;
      const lighterInfo = data.lighter_order
        ? `${data.lighter_order.side || "--"} ${data.lighter_order.quantity || data.lighter_order.qty || "--"}`
        : "--";
      const varInfo = data.variational_order
        ? `${data.variational_order.side || data.variational_order?.result?.[0]?.side || "--"} ${data.variational_order.qty || data.variational_order?.result?.[0]?.qty || "--"}`
        : "--";
      if (posEl) posEl.textContent = `L: ${lighterInfo} | V: ${varInfo}`;
      if (pnlEl) pnlEl.textContent = data.imbalance != null ? `${data.imbalance}` : "--";
      if (logEl) {
        const lines = [];
        if (data.last_pair) lines.push(`交易对: ${data.last_pair}`);
        if (data.imbalance != null) lines.push(`差额: ${data.imbalance}`);
        logEl.textContent = lines.join(" | ") || "无数据";
        logEl.title = `上次检查: ${data.last_check}`;
      }
    });
  };
  refresh();
  setInterval(refresh, 4000);
}

if (orderForm) {
  orderForm.addEventListener("submit", handleOrderSubmit);
  restoreCredentials();
  restoreInstrumentPreference();

  // Auto-save credentials on input
  const saveCreds = () => {
    const t = tokenInput?.value?.trim();
    const w = walletInput?.value?.trim();
    if (t || w) saveCredentials(t, w);
  };
  if (tokenInput) tokenInput.addEventListener('input', saveCreds);
  if (walletInput) walletInput.addEventListener('input', saveCreds);
  if (instrumentInput) {
    instrumentInput.addEventListener("blur", () => {
      saveInstrumentPreference(instrumentInput.value?.trim() ?? "");
    });
  }
}

if (orderTypeSelect) {
  orderTypeSelect.addEventListener("change", updateOrderTypeUI);
  updateOrderTypeUI();
}

if (lighterForm) {
  lighterForm.addEventListener("submit", handleLighterSubmit);
  restoreLighterSettings();
}

if (lighterOrderTypeSelect) {
  lighterOrderTypeSelect.addEventListener("change", updateLighterOrderTypeUI);
  updateLighterOrderTypeUI();
}

if (closeBtn) {
  closeBtn.addEventListener("click", () => {
    manualCloseRequested = true;
    window.close();
  });
}

window.addEventListener("blur", () => {
  if (!manualCloseRequested) {
    window.focus();
  }
});

initTabs();
loadPairs().then(renderPairs);
initConfigUI();
initLogs();
initHedgeStatus();
