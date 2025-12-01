from __future__ import annotations

import asyncio
import json
import logging
import ssl
import time
from asyncio import Queue, QueueEmpty
from decimal import Decimal
from typing import Any, Dict, Literal, Optional, Tuple

from pydantic import BaseModel, Field

from .config import get_settings

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
settings = get_settings()

try:
    import lighter
    from lighter import ApiClient, Configuration, OrderApi, SignerClient
    import websockets
except ImportError as exc:
    raise RuntimeError(
        "lighter-python SDK is required. Install via "
        "`pip install git+https://github.com/elliottech/lighter-python.git`."
    ) from exc

from .lighter_custom_websocket import LighterCustomWebSocketManager


class OrderRequest(BaseModel):
    market_id: str = Field(..., description="Symbol, e.g. BTC-PERP")
    order_type: Literal["limit", "market"]
    side: Literal["buy", "sell"]
    quantity: Decimal
    price: Optional[Decimal] = None
    max_slippage: Optional[Decimal] = Field(
        default=Decimal("0.001"),  # 0.1%
        description="市价单允许的滑点比例",
    )
    reduce_only: bool = False


class LighterOrderMonitor:
    """Maintain order statuses by subscribing to Lighter account order updates."""

    def __init__(self, signer: SignerClient, account_index: int, market_index: int):
        self.signer = signer
        self.account_index = account_index
        self.market_index = market_index
        self._orders: Dict[str, Dict[str, Any]] = {}
        self._ws_manager: Optional[LighterCustomWebSocketManager] = None
        self._task: Optional[asyncio.Task] = None

    def ensure_started(self) -> None:
        if self._task is None:
            logger.info(f"Starting Lighter WebSocket for market {self.market_index}")
            
            # Create config dict for WebSocket manager
            config = type('Config', (), {
                'contract_id': self.market_index,
                'account_index': self.account_index,
                'lighter_client': self.signer
            })()
            
            self._ws_manager = LighterCustomWebSocketManager(
                config=config,
                order_update_callback=self._handle_order_updates
            )
            
            # Set up logging for WebSocket manager
            class WSLogger:
                def log(self, msg, level='INFO'):
                    if level == 'INFO':
                        logger.info(f"[WS] {msg}")
                    elif level == 'WARNING':
                        logger.warning(f"[WS] {msg}")
                    elif level == 'ERROR':
                        logger.error(f"[WS] {msg}")
                    else:
                        logger.debug(f"[WS] {msg}")
            
            self._ws_manager.set_logger(WSLogger())
            logger.info("WebSocket manager logger configured")
            
            loop = asyncio.get_running_loop()
            
            async def run_ws_with_logging():
                try:
                    logger.info("Starting WebSocket connect task...")
                    await self._ws_manager.connect()
                except Exception as e:
                    logger.error(f"WebSocket task failed: {e}")
                    import traceback
                    logger.error(f"Traceback: {traceback.format_exc()}")
            
            self._task = loop.create_task(run_ws_with_logging())
            logger.info("WebSocket task created and started")

    def track_order(
        self,
        client_order_index: int,
        market_index: int,
        meta: Dict[str, Any],
    ) -> None:
        key = str(client_order_index)
        entry = {
            "client_order_index": key,
            "market_index": market_index,
            "status": meta.get("status", "pending"),
            "side": meta.get("side"),
            "quantity": str(meta.get("quantity")),
            "submitted_at": time.time(),
        }
        self._orders[key] = entry
        logger.info(f"Tracking order {key} for market {market_index}")

    def get_status(self, client_order_index: str) -> Optional[Dict[str, Any]]:
        entry = self._orders.get(str(client_order_index))
        if not entry:
            return None
        return dict(entry)

    def update_status(self, client_order_index: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """Update cached status manually (used when fallback查询得到结果)."""
        key = str(client_order_index)
        entry = self._orders.setdefault(key, {"client_order_index": key})
        entry.update(data)
        status = str(entry.get("status", "")).lower()
        if status in {"filled", "canceled", "expired"}:
            entry["completed_at"] = time.time()
        logger.info(f"Order {key} status refreshed via fallback: {status}")
        return dict(entry)

    def _handle_order_updates(self, orders: list) -> None:
        """Handle order updates from WebSocket."""
        for order in orders:
            self._handle_order_update(order)

    def _handle_order_update(self, order: Dict[str, Any]) -> None:
        client_index = order.get("client_order_index") or order.get("client_order_id")
        if client_index is None:
            return
        key = str(client_index)
        entry = self._orders.setdefault(key, {"client_order_index": key})
        status = str(order.get("status", entry.get("status", "unknown"))).lower()
        entry.update(
            {
                "status": status,
                "filled_base_amount": order.get("filled_base_amount"),
                "remaining_base_amount": order.get("remaining_base_amount"),
                "price": order.get("price"),
                "order_index": order.get("order_index"),
                "updated_at": time.time(),
                "side": entry.get("side")
                or ("sell" if order.get("is_ask") else "buy"),
            }
        )
        if order.get("market_index") is not None:
            entry["market_index"] = order["market_index"]
        if order.get("initial_base_amount") is not None:
            entry["quantity"] = str(order["initial_base_amount"])
        if status in {"filled", "canceled", "expired"}:
            entry["completed_at"] = time.time()
            logger.info(f"Order {key} completed with status {status}. Filled: {entry.get('filled_base_amount')}")


class LighterService:
    def __init__(self) -> None:
        self.settings = settings
        self._signer = SignerClient(
            url=self.settings.lighter_base_url,
            private_key=self.settings.api_key_private_key,
            account_index=self.settings.lighter_account_index,
            api_key_index=self.settings.lighter_api_key_index,
        )
        configuration = Configuration(host=self.settings.lighter_base_url)
        self._order_api = OrderApi(ApiClient(configuration))
        self._market_cache: Dict[str, Dict[str, Any]] = {}
        self._market_lock = asyncio.Lock()
        self._order_monitor: Optional[LighterOrderMonitor] = None

    def _ensure_monitor(self, market_id: int) -> None:
        if self._order_monitor is None:
            logger.info("Initializing LighterOrderMonitor...")
            self._order_monitor = LighterOrderMonitor(
                self._signer, self.settings.lighter_account_index, market_id
            )
            self._order_monitor.ensure_started()

    async def get_best_prices(self, symbol: str) -> Dict[str, Optional[float]]:
        bid, ask = await self._get_best_prices(symbol)
        return {
            "symbol": symbol,
            "bid": float(bid) if bid is not None else None,
            "ask": float(ask) if ask is not None else None
        }

    async def get_all_markets(self) -> list[Dict[str, Any]]:
        """Fetch all available markets from Lighter."""
        try:
            books = await self._order_api.order_books()
            markets = []
            for market in books.order_books:
                markets.append({
                    "market_id": market.market_id,
                    "symbol": market.symbol,
                    "id": market.symbol,  # For compatibility with frontend
                    "underlying": market.symbol.split('-')[0] if market.symbol else 'Unknown',
                    "base_asset": getattr(market, 'base_asset', None),
                    "quote_asset": getattr(market, 'quote_asset', None),
                })
            return sorted(markets, key=lambda x: x['market_id'])
        except Exception as e:
            logger.error(f"Error fetching markets: {e}")
            raise


    async def submit_order(self, req: OrderRequest) -> Dict[str, Any]:
        market = await self._get_market_info(req.market_id)
        base_multiplier = Decimal(10) ** market["size_decimals"]
        price_multiplier = Decimal(10) ** market["price_decimals"]

        base_amount = int(req.quantity * base_multiplier)

        if req.order_type == "limit":
            if req.price is None:
                raise ValueError("限价单需要传入 price")
            price_int = int(req.price * price_multiplier)
        else:
            # 市价单：根据盘口价与滑点计算宽限价（用 Decimal，最后转 int）
            best_bid, best_ask = await self._get_best_prices(req.market_id)
            # Use much larger slippage for market orders to ensure they fill
            slippage = getattr(req, "max_slippage", None) or Decimal("0.05")  # 5% default
            if not isinstance(slippage, Decimal):
                try:
                    slippage = Decimal(str(slippage))
                except Exception:
                    slippage = Decimal("0.05")  # 5% default
            
            # Ensure minimum slippage for market orders
            if slippage < Decimal("0.02"):  # Minimum 2%
                slippage = Decimal("0.02")
            
            logger.info(f"Market order slippage: {slippage} ({float(slippage)*100}%)")

            if req.side.lower() == "buy":
                anchor_price = best_ask or best_bid  # 优先吃 ask，退化用 bid
                if anchor_price is None:
                    logger.warning("无法获取盘口价格，使用极端价格兜底")
                    # Use very high price for buy to ensure fill
                    price_int = 999999999  # Will be adjusted by price_multiplier
                else:
                    # Buy: use ask price + slippage to ensure fill
                    price_int = int(anchor_price * (Decimal(1) + slippage) * price_multiplier)
                    logger.info(f"Buy market order: anchor={anchor_price}, final_price={price_int / price_multiplier}")
            else:
                anchor_price = best_bid or best_ask
                if anchor_price is None:
                    logger.warning("无法获取盘口价格，使用极端价格兜底")
                    # Use very low price for sell to ensure fill
                    price_int = 1
                else:
                    # Sell: use bid price - slippage to ensure fill
                    price_int = int(anchor_price * (Decimal(1) - slippage) * price_multiplier)
                    logger.info(f"Sell market order: anchor={anchor_price}, final_price={price_int / price_multiplier}")

        if price_int < 1:
            # 避免由于精度或请求错误导致价格为 0
            price_int = 1

        is_ask = req.side.lower() == "sell"
        if req.order_type == "limit":
            order_type = self._signer.ORDER_TYPE_LIMIT
            time_in_force = self._signer.ORDER_TIME_IN_FORCE_GOOD_TILL_TIME
            order_expiry = self._signer.DEFAULT_28_DAY_ORDER_EXPIRY
        else:
            # Market order: use IOC with wide price range
            order_type = self._signer.ORDER_TYPE_MARKET
            time_in_force = self._signer.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL
            order_expiry = self._signer.DEFAULT_IOC_EXPIRY

        loop = asyncio.get_running_loop()
        order_params = {
            "market_index": market["market_id"],
            "client_order_index": int(loop.time() * 1000) % 1_000_000,
            "base_amount": base_amount,
            "price": price_int,
            "is_ask": is_ask,
            "order_type": order_type,
            "time_in_force": time_in_force,
            "reduce_only": req.reduce_only,
            "trigger_price": 0,
            "order_expiry": order_expiry,
        }

        logger.info("Submitting Lighter order: %s", order_params)
        logger.info(f"Market info: {market}")
        logger.info(f"Current monitor state: {self._order_monitor}")

        # Start monitoring BEFORE submitting to avoid race condition
        logger.info(f"Calling _ensure_monitor with market_id={market['market_id']}")
        self._ensure_monitor(market["market_id"])
        logger.info(f"After _ensure_monitor, monitor state: {self._order_monitor}")
        
        if self._order_monitor:
            logger.info(f"Tracking order {order_params['client_order_index']}")
            self._order_monitor.track_order(
                order_params["client_order_index"],
                market["market_id"],
                {"side": req.side, "quantity": req.quantity, "status": "submitted"},
            )
        else:
            logger.error("Order monitor is None after _ensure_monitor!")

        logger.info("Calling create_order...")

        order_result, tx_hash, error = await self._signer.create_order(**order_params)
        if error:
            raise RuntimeError(f"Lighter create_order error: {error}")

        return {
            "order": order_result,
            "tx_hash": tx_hash,
            "client_order_index": order_params["client_order_index"],
            "market_index": market["market_id"],
        }

    async def _get_market_info(self, symbol: str) -> Dict[str, Any]:
        if symbol in self._market_cache:
            return self._market_cache[symbol]

        async with self._market_lock:
            if symbol in self._market_cache:
                return self._market_cache[symbol]

            books = await self._order_api.order_books()
            
            # Log all available markets for debugging
            all_symbols = [market.symbol for market in books.order_books]
            logger.info(f"Available Lighter markets: {all_symbols}")
            logger.info(f"Looking for symbol: {symbol}")
            
            for market in books.order_books:
                self._market_cache[market.symbol] = {
                    "market_id": market.market_id,
                    "size_decimals": market.supported_size_decimals,
                    "price_decimals": market.supported_price_decimals,
                }

            if symbol not in self._market_cache:
                raise ValueError(f"未找到交易对 {symbol} 的市场信息。可用市场: {', '.join(all_symbols)}")

            return self._market_cache[symbol]

    async def _get_best_prices(
        self, symbol: str
    ) -> Tuple[Optional[Decimal], Optional[Decimal]]:
        """
        拉取盘口最优 bid/ask，返回 Decimal 价格（未乘精度）
        优先使用 WebSocket 实时数据，回退到 REST API
        """
        try:
            logger.info(f"Fetching best prices for {symbol}...")
            
            # Get market info first to know which market we're querying
            market_info = await self._get_market_info(symbol)
            market_id = market_info['market_id']
            
            # Try WebSocket data ONLY if it's for the same market
            if self._order_monitor and self._order_monitor._ws_manager:
                ws_manager = self._order_monitor._ws_manager
                # Check if WebSocket is connected to the same market
                if ws_manager.market_index == market_id and ws_manager.snapshot_loaded:
                    # Use the cached best bid/ask from WebSocket
                    best_bid = Decimal(str(ws_manager.best_bid)) if ws_manager.best_bid else None
                    best_ask = Decimal(str(ws_manager.best_ask)) if ws_manager.best_ask else None
                    
                    if best_bid or best_ask:
                        logger.info(f"✓ Got prices from WebSocket for {symbol}: bid={best_bid}, ask={best_ask}")
                        return best_bid, best_ask
                else:
                    logger.info(f"WebSocket is for market {ws_manager.market_index}, but we need market {market_id}")
            
            # Fallback: Use REST API for other markets or when WebSocket unavailable
            logger.info(f"Using REST API for {symbol} prices...")
            
            logger.info(f"Getting orderbook details for market_id={market_id}, symbol={symbol}")
            
            # Use order_book_details to get actual bid/ask data
            response = await self._order_api.order_book_details(market_id=market_id)
            
            if not response:
                logger.warning(f"No orderbook response returned for {symbol}")
                return None, None
            
            # The response has a nested 'order_book_details' attribute
            orderbook = None
            if hasattr(response, 'order_book_details'):
                orderbook = response.order_book_details
                logger.info(f"Found nested order_book_details attribute")
            else:
                orderbook = response
                
            logger.info(f"Orderbook type: {type(orderbook)}")
            
            # Check if orderbook is a list - extract first element if so
            if isinstance(orderbook, list):
                if len(orderbook) == 0:
                    logger.warning(f"Orderbook is an empty list")
                    return None, None
                logger.info(f"Orderbook is a list with {len(orderbook)} elements, extracting first element")
                orderbook = orderbook[0]
                logger.info(f"Extracted element type: {type(orderbook)}")
            
            # REST API doesn't provide orderbook data, only market info
            # Use last_trade_price as reference and estimate spread
            logger.warning(f"REST API doesn't provide real-time orderbook. Using last_trade_price as reference.")
            
            # Convert to dict to get last_trade_price
            orderbook_dict = None
            if hasattr(orderbook, 'to_dict'):
                try:
                    orderbook_dict = orderbook.to_dict()
                    logger.info(f"Successfully converted to dict with keys: {list(orderbook_dict.keys())[:5]}...")
                except Exception as e:
                    logger.error(f"Failed to convert orderbook to dict: {e}")
            
            # Try to get last_trade_price from dict or attribute
            last_price = None
            if orderbook_dict:
                last_price = orderbook_dict.get('last_trade_price')
            if not last_price:
                # Fallback to attribute
                last_price = getattr(orderbook, 'last_trade_price', None)
            
            logger.info(f"Extracted last_trade_price: {last_price}")
            
            if not last_price or last_price <= 0:
                logger.error(f"No valid last_trade_price available for {symbol}")
                return None, None
            
            last_price_decimal = Decimal(str(last_price))
            logger.info(f"Using last_trade_price={last_price_decimal} for {symbol}")
            
            # Estimate a tight spread (0.05% = 5 basis points) for liquid markets
            # This creates synthetic bid/ask around the last trade price
            spread_bps = Decimal("0.0005")  # 0.05%
            half_spread = last_price_decimal * spread_bps
            
            best_bid = last_price_decimal - half_spread
            best_ask = last_price_decimal + half_spread
            
            logger.info(f"Estimated prices for {symbol}: bid={best_bid}, ask={best_ask} (spread={half_spread*2})")
            
            return best_bid, best_ask
            
        except Exception as e:
            logger.error(f"Error fetching best prices for {symbol}: {e}")
            import traceback
            logger.error(f"Traceback: {traceback.format_exc()}")
            return None, None

    async def fetch_order(self, client_order_index: str) -> Optional[Dict[str, Any]]:
        """
        Fallback: Fetch order status from Lighter API if WS missed it.
        Strategies:
        1. Check active orders (if pending/open).
        2. Check account trades/positions (if filled).
        Since we don't have a direct 'get_order_by_client_id' easily, we scan active orders first.
        """
        try:
            # 1. Check active orders
            auth_token, err = self._signer.create_auth_token_with_expiry(int(time.time() + 60))
            if err:
                logger.warning(f"fetch_order auth error: {err}")
                return None
            
            # We need market_id. If we don't have it, we can't easily query active orders efficiently 
            # without scanning all markets or knowing the market from the request.
            # But client_order_index is unique per account usually? 
            # Let's assume we can find it if we know the market.
            # Wait, get_tracked_order calls this? No, get_tracked_order is sync.
            # This method is async.
            
            # Let's try to find the order in the monitor first to get market_id
            monitor_entry = self._order_monitor.get_status(client_order_index) if self._order_monitor else None
            market_id = monitor_entry.get("market_index") if monitor_entry else None
            
            if not market_id:
                # If we don't know market_id, we can't query active_orders easily (requires market_id).
                # We might have to skip or try a default if only one market is used.
                # For now, return None if unknown.
                logger.warning(f"fetch_order: unknown market_id for {client_order_index}")
                return None

            orders_res = await self._order_api.account_active_orders(
                account_index=self.settings.lighter_account_index,
                market_id=market_id,
                auth=auth_token
            )

            if orders_res and getattr(orders_res, "orders", None):
                for o in orders_res.orders:
                    if str(o.client_order_index) == str(client_order_index):
                        return {
                            "status": o.status,
                            "filled_base_amount": o.filled_base_amount,
                            "remaining_base_amount": o.remaining_base_amount,
                            "price": o.price,
                            "side": "sell" if o.is_ask else "buy",
                            "market_index": market_id,
                            "order_index": getattr(o, "order_index", None)
                        }

            # 2. If not in active orders, check inactive (filled/canceled) orders
            inactive_res = await self._order_api.account_inactive_orders(
                account_index=self.settings.lighter_account_index,
                market_id=market_id,
                limit=50,
                auth=auth_token
            )

            if inactive_res and getattr(inactive_res, "orders", None):
                for o in inactive_res.orders:
                    if str(o.client_order_index) == str(client_order_index):
                        return {
                            "status": o.status,
                            "filled_base_amount": o.filled_base_amount,
                            "remaining_base_amount": o.remaining_base_amount,
                            "price": o.price,
                            "side": "sell" if o.is_ask else "buy",
                            "market_index": market_id,
                            "order_index": getattr(o, "order_index", None)
                        }

            logger.info(f"Order {client_order_index} not found via REST fallback (active/inactive).")
            return None
            
        except Exception as e:
            logger.error(f"fetch_order error: {e}")
            return None

    async def fetch_positions(self) -> Dict[str, Any]:
        # 官方 SDK 暂未封装仓位查询，返回空字典
        return {}

    async def get_tracked_order(self, client_order_index: str) -> Optional[Dict[str, Any]]:
        if not self._order_monitor:
            return None
        
        # 1. Check memory cache (WS)
        data = self._order_monitor.get_status(client_order_index)
        
        # 2. If status is final, return it
        if data and data.get("status") in ["filled", "canceled", "expired"]:
            return data
            
        # 3. If missing or pending, try fallback fetch
        logger.info(f"Order {client_order_index} status pending/unknown, attempting fallback fetch...")
        fetched = await self.fetch_order(client_order_index)
        if fetched:
            if self._order_monitor:
                merged = {
                    "status": fetched.get("status"),
                    "filled_base_amount": fetched.get("filled_base_amount"),
                    "remaining_base_amount": fetched.get("remaining_base_amount"),
                    "market_index": fetched.get("market_index"),
                    "side": fetched.get("side"),
                }
                updated = self._order_monitor.update_status(client_order_index, merged)
                return updated
            return fetched
        
        return data

    async def cancel_client_order(self, client_order_index: int) -> Dict[str, Any]:
        if not client_order_index:
            raise ValueError("client_order_index is required")

        data = await self.get_tracked_order(str(client_order_index))
        if not data:
            raise ValueError(f"未找到订单 {client_order_index} 的状态信息")

        market_index = data.get("market_index")
        order_index = data.get("order_index")
        if market_index is None or order_index is None:
            raise ValueError("无法获取取消所需的订单索引，请稍后重试")

        cancel_order, tx_hash, error = await self._signer.cancel_order(
            market_index=int(market_index),
            order_index=int(order_index)
        )
        if error:
            raise RuntimeError(f"Cancel order error: {error}")

        if self._order_monitor:
            self._order_monitor.update_status(
                client_order_index,
                {"status": "canceled", "order_index": order_index, "market_index": market_index}
            )

        return {
            "client_order_index": client_order_index,
            "order_index": order_index,
            "market_index": market_index,
            "tx_hash": tx_hash
        }


service = LighterService()
