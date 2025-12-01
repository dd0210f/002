from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .config import get_settings
from .lighter_client import OrderRequest, service

settings = get_settings()
app = FastAPI(title="Lighter Signer Manager", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost", "http://127.0.0.1:8787", "chrome-extension://*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class OrderStatusResponse(BaseModel):
    ok: bool
    status: str | None = None
    order: dict | None = None

class CancelOrderRequest(BaseModel):
    client_order_index: int


class BestPriceResponse(BaseModel):
    ok: bool
    data: dict | None = None

@app.get("/health")
def health():
    return {
        "status": "ok",
        "network": settings.lighter_network,
        "account_index": settings.lighter_account_index,
        "network": settings.lighter_network,
    }


@app.post("/order")
async def submit_order(req: OrderRequest):
    try:
        data = await service.submit_order(req)
        return {"ok": True, "data": data}
    except Exception as exc:  # pylint: disable=broad-except
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/orders/{rfq_id}", response_model=OrderStatusResponse)
async def get_order(rfq_id: str):
    order = await service.fetch_order(rfq_id)
    return {"ok": True, "status": None, "order": order}


@app.get("/order/status/{client_order_index}", response_model=OrderStatusResponse)
async def get_order_status(client_order_index: str):
    data = await service.get_tracked_order(client_order_index)
    if not data:
        return {"ok": False, "status": None, "order": None}
    return {"ok": True, "status": data.get("status"), "order": data}


@app.get("/positions")
async def get_positions():
    try:
        return {"ok": True, "data": await service.fetch_positions()}
    except Exception as exc:  # pylint: disable=broad-except
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/order/cancel")
async def cancel_order(req: CancelOrderRequest):
    try:
        data = await service.cancel_client_order(req.client_order_index)
        return {"ok": True, "data": data}
    except Exception as exc:  # pylint: disable=broad-except
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/market/bbo/{symbol}", response_model=BestPriceResponse)
async def get_market_bbo(symbol: str):
    try:
        data = await service.get_best_prices(symbol)
        return {"ok": True, "data": data}
    except Exception as exc:  # pylint: disable=broad-except
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/markets")
async def get_markets():
    """Get all available markets from Lighter."""
    try:
        markets = await service.get_all_markets()
        return {"ok": True, "markets": markets}
    except Exception as exc:  # pylint: disable=broad-except
        raise HTTPException(status_code=400, detail=str(exc)) from exc
