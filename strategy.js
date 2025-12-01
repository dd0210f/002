// strategy.js - Automated Hedging Strategy UI Client

const strategyState = {
    pairs: [],
    flipInterval: 3600000, // milliseconds (1 hour default)
    isRunning: false,
    timers: {}, // Deprecated, kept for structure compatibility
    positionCheckInterval: null
};

// Available trading pairs - Will be loaded dynamically from background
let AVAILABLE_PAIRS = [
    { id: 'BTC-PERP', name: 'BTC-PERP' },
    { id: 'ETH-PERP', name: 'ETH-PERP' }
];
let DEFAULT_PAIR_ID = AVAILABLE_PAIRS[0]?.id || '';

// Initialize the page
document.addEventListener('DOMContentLoaded', () => {
    loadMarketsFromBackground();
    loadStrategyState();
    setupEventListeners();
    // Start polling for display updates (in case storage events miss, though unlikely)
    setInterval(updatePositionDisplay, 2000);
});

function loadMarketsFromBackground() {
    chrome.runtime.sendMessage({ type: 'get_markets' }, (markets) => {
        if (markets && Array.isArray(markets) && markets.length > 0) {
            AVAILABLE_PAIRS = markets.map(m => ({
                id: m.id || m.symbol,
                name: m.symbol || m.id,
                market_id: m.market_id,
                underlying: m.underlying
            }));
            DEFAULT_PAIR_ID = AVAILABLE_PAIRS[0]?.id || '';
            renderPairSuggestions();
            logMessage(`已加载 ${AVAILABLE_PAIRS.length} 个市场`);
        } else {
            logMessage('使用默认市场列表');
        }
    });
}

function refreshMarkets() {
    logMessage('正在刷新市场列表...');
    chrome.runtime.sendMessage({ type: 'refresh_markets' }, (markets) => {
        if (markets && Array.isArray(markets) && markets.length > 0) {
            AVAILABLE_PAIRS = markets.map(m => ({
                id: m.id || m.symbol,
                name: m.symbol || m.id,
                market_id: m.market_id,
                underlying: m.underlying
            }));
            DEFAULT_PAIR_ID = AVAILABLE_PAIRS[0]?.id || '';
            renderPairSuggestions();
            logMessage(`市场列表已更新，共 ${AVAILABLE_PAIRS.length} 个市场`);
        }
    });
}

function renderPairSuggestions() {
    const list = document.getElementById('pair-suggestions');
    if (!list) return;
    list.innerHTML = '';
    AVAILABLE_PAIRS.forEach(pair => {
        const option = document.createElement('option');
        option.value = pair.id;
        option.label = pair.name || pair.id;
        list.appendChild(option);
    });
}

function normalizePairInput(value) {
    return (value || '').trim().toUpperCase();
}

function handlePairInputChange(event) {
    const input = event.target;
    const normalized = normalizePairInput(input.value);
    if (input.value !== normalized) {
        input.value = normalized;
    }
    collectPairConfig();
}

function setupEventListeners() {
    document.getElementById('add-pair-btn').addEventListener('click', () => addPairRow());
    document.getElementById('start-strategy-btn').addEventListener('click', startStrategy);
    document.getElementById('stop-strategy-btn').addEventListener('click', stopStrategy);
    document.getElementById('close-all-btn').addEventListener('click', closeAllPositions);

    // Add refresh markets button listener if it exists
    const refreshBtn = document.getElementById('refresh-markets-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', refreshMarkets);
    }

    document.getElementById('flip-interval').addEventListener('change', (e) => {
        strategyState.flipInterval = parseInt(e.target.value) * 60 * 1000;
        saveStrategyState();
    });
}

function addPairRow(initialData = null) {
    const container = document.getElementById('pairs-container');

    const row = document.createElement('div');
    row.className = 'pair-row';
    row.innerHTML = `
    <div class="form-group" style="margin-bottom: 0;">
      <label>交易对</label>
      <input type="text" class="pair-input" list="pair-suggestions" placeholder="e.g. BTC-PERP or ETH-PERP">
    </div>
    <div class="form-group" style="margin-bottom: 0;">
      <label>数量</label>
      <input type="number" class="quantity-input" step="0.00001" placeholder="0.00">
    </div>
    <button class="btn btn-outline btn-sm remove-btn" style="height: 36px; margin-bottom: 1px;">删除</button>
  `;

    container.appendChild(row);

    // Set initial values if provided
    const pairInput = row.querySelector('.pair-input');
    const quantityInput = row.querySelector('.quantity-input');
    if (initialData) {
        if (pairInput) pairInput.value = initialData.id;
        if (quantityInput) quantityInput.value = initialData.quantity;
    } else if (pairInput && DEFAULT_PAIR_ID) {
        pairInput.value = DEFAULT_PAIR_ID;
    }

    // Attach event listeners
    row.querySelector('.remove-btn').addEventListener('click', () => removePairRow(row));
    if (pairInput) {
        pairInput.addEventListener('input', handlePairInputChange);
        pairInput.addEventListener('blur', handlePairInputChange);
    }
    if (quantityInput) {
        quantityInput.addEventListener('input', collectPairConfig);
        quantityInput.addEventListener('change', collectPairConfig);
    }

    // Only collect config if we are adding a new row manually (not loading)
    if (!initialData) {
        collectPairConfig();
    }
}

function removePairRow(row) {
    row.remove();
    collectPairConfig();
}

function collectPairConfig() {
    const newPairs = [];
    const rows = document.querySelectorAll('.pair-row');

    rows.forEach((row, idx) => {
        const pairInput = row.querySelector('.pair-input');
        const quantityInput = row.querySelector('.quantity-input');
        if (!pairInput || !quantityInput) {
            return;
        }

        const id = normalizePairInput(pairInput.value);
        const qty = parseFloat(quantityInput.value);
        if (!id || !Number.isFinite(qty) || qty <= 0) {
            return;
        }

        // Try to preserve existing state for this ID
        const existing = strategyState.pairs.find(p => p.id === id);

        // Alternate default direction by row order
        const defaultDir = idx % 2 === 0 ? 'lighter_short' : 'lighter_long';

        if (existing) {
            // Update quantity but keep status
            if (existing.quantity !== qty) {
                existing.quantity = qty;
            }
            newPairs.push(existing);
        } else {
            // New pair
            newPairs.push({
                id,
                quantity: qty,
                status: 'idle',
                currentDirection: defaultDir,
                positions: {
                    lighter: null,
                    variational: null
                },
                lastFlip: null,
                nextFlip: null
            });
        }
    });

    strategyState.pairs = newPairs;
    saveStrategyState();
}

function startStrategy() {
    if (strategyState.pairs.length === 0) {
        logMessage('请至少配置一个交易对');
        return;
    }

    logMessage('正在启动策略...');
    chrome.runtime.sendMessage({ type: 'strategy_start' }, (resp) => {
        if (resp && resp.ok === false) {
            logMessage(`启动失败: ${resp.error}`);
        }
    });
}

function stopStrategy() {
    logMessage('正在停止策略...');
    chrome.runtime.sendMessage({ type: 'strategy_stop' });
}

// Listen for state changes from background script
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.strategyState) {
        const newState = changes.strategyState.newValue;
        if (newState) {
            // Merge state but preserve UI-specific things if any (none currently)
            Object.assign(strategyState, newState);
            updatePositionDisplay();

            // Sync button state
            if (strategyState.isRunning) {
                document.getElementById('start-strategy-btn').style.display = 'none';
                document.getElementById('stop-strategy-btn').style.display = 'block';
            } else {
                document.getElementById('start-strategy-btn').style.display = 'block';
                document.getElementById('stop-strategy-btn').style.display = 'none';
            }
        }
    }
});

async function closeAllPositions() {
    if (!confirm('确定要平仓所有持仓吗？这将停止所有策略。')) {
        return;
    }
    logMessage('正在请求一键平仓...');
    chrome.runtime.sendMessage({ type: 'strategy_close_all' });
}

function logMessage(msg) {
    console.log(`[Strategy] ${msg}`);
    try {
        chrome.runtime.sendMessage({
            type: 'add_log',
            message: `[策略] ${msg}`
        });
    } catch (e) {
        console.error('Failed to send log:', e);
    }
}

function updatePositionDisplay() {
    try {
        const content = document.getElementById('positions-content');
        if (!content) return;

        if (!strategyState.pairs || !Array.isArray(strategyState.pairs) || strategyState.pairs.length === 0) {
            content.innerHTML = '<div class="empty-state">暂无配置交易对 (运行中: ' + strategyState.isRunning + ')</div>';
            return;
        }

        // Always show table if we have pairs, even if idle
        let html = '<table><thead><tr>';
        html += '<th>交易对</th><th>状态</th><th>Lighter</th><th>Variational</th><th>下次翻转</th>';
        html += '</tr></thead><tbody>';

        strategyState.pairs.forEach(pair => {
            // Show all pairs
            const statusClass = pair.status === 'running' ? 'status-running' :
                pair.status === 'error' ? 'status-error' :
                    pair.status === 'opening' ? 'status-warning' :
                        pair.status === 'closing' ? 'status-warning' : 'status-idle';

            const lighterPos = pair.positions && pair.positions.lighter ?
                `<span class="text-${pair.positions.lighter.side === 'buy' ? 'green' : 'red'}">
            ${pair.positions.lighter.side === 'buy' ? '+' : '-'}${pair.positions.lighter.quantity}
          </span>` : '-';

            const variationalPos = pair.positions && pair.positions.variational ?
                `<span class="text-${pair.positions.variational.side === 'buy' ? 'green' : 'red'}">
            ${pair.positions.variational.side === 'buy' ? '+' : '-'}${pair.positions.variational.quantity}
          </span>` : '-';

            const nextFlip = pair.nextFlip ? formatCountdown(pair.nextFlip) : '-';

            html += `<tr>
          <td>${pair.id}</td>
          <td><span class="status-badge ${statusClass}">${getStatusText(pair.status)}</span></td>
          <td>${lighterPos}</td>
          <td>${variationalPos}</td>
          <td>${nextFlip}</td>
        </tr>`;
        });

        html += '</tbody></table>';
        content.innerHTML = html;
    } catch (e) {
        console.error('Update display error:', e);
        const content = document.getElementById('positions-content');
        if (content) content.innerHTML = '<div class="empty-state text-red">显示出错</div>';
    }
}

function getStatusText(status) {
    const statusMap = {
        'idle': '空闲',
        'opening': '开仓中',
        'running': '运行中',
        'closing': '平仓中',
        'error': '错误'
    };
    return statusMap[status] || status;
}

function formatCountdown(timestamp) {
    const now = Date.now();
    const diff = timestamp - now;

    if (diff <= 0) return '即将翻转';

    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) {
        return `${minutes}分钟后`;
    }

    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}小时${mins}分钟后`;
}

function saveStrategyState() {
    // Send updated state to background to save/sync
    chrome.runtime.sendMessage({
        type: 'strategy_update_state',
        payload: strategyState
    });
}

function loadStrategyState() {
    chrome.storage.local.get(['strategyState'], (result) => {
        if (result.strategyState) {
            Object.assign(strategyState, result.strategyState);

            // Clear existing rows
            const container = document.getElementById('pairs-container');
            container.innerHTML = '';

            // Re-create UI rows from state
            strategyState.pairs.forEach(pair => {
                addPairRow(pair);
            });

            // Restore UI if strategy was running
            if (strategyState.isRunning) {
                document.getElementById('start-strategy-btn').style.display = 'none';
                document.getElementById('stop-strategy-btn').style.display = 'block';
            }

            if (strategyState.flipInterval) {
                document.getElementById('flip-interval').value = strategyState.flipInterval / 60000;
            }

            // Update display
            updatePositionDisplay();
        } else {
            // Default init if no state
            if (strategyState.pairs.length === 0) {
                addPairRow();
            }
        }
    });
}
