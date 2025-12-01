# Lighter Signer Manager

This service exposes a minimal HTTP API that forwards order requests to the official [lighter-python](https://github.com/elliottech/lighter-python) SDK. Secrets stay on your machine; browser plugins only call `http://127.0.0.1`.

## Features

- Loads API key private key + account/api indexes from `.env`
- Uses `lighter.SignerClient` to sign orders and `lighter.OrderApi` to fetch market info
- Endpoints:
  - `GET /health`
  - `POST /order`
  - `GET /orders/{rfq_id}` (placeholder)
  - `GET /positions` (placeholder)

## Directory Layout

```
lighter-signer-manager/
├── app/
│   ├── __init__.py
│   ├── config.py
│   ├── lighter_client.py
│   └── server.py
├── .env.example
├── requirements.txt
└── README.md
```

## Quick Start

1. **Install dependencies (inside venv)**  
   `pip install -r requirements.txt`
2. **Create `.env`** (see template below) and fill in the Signer private key + indexes.
3. **Run the service**  
   `uvicorn app.server:app --host 127.0.0.1 --port 8787 --reload`
4. **Verify**  
   `curl http://127.0.0.1:8787/health`

### Example `.env`

```
LIGHTER_BASE_URL=https://mainnet.zklighter.elliot.ai
LIGHTER_NETWORK=mainnet
API_KEY_PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000000
LIGHTER_ACCOUNT_INDEX=0
LIGHTER_API_KEY_INDEX=0
LIGHTER_MAX_ORDERS_LIMIT=100
SIGNER_HOST=127.0.0.1
SIGNER_PORT=8787
```

> **Security Tips**  
> - Keep `.env` local; never commit it.  
> - Restrict the service to `127.0.0.1`.  
> - Use a dedicated machine for Signer if possible.

## HTTP API

### `GET /health`
Returns `{ "status": "ok", "network": "mainnet", "account_index": 0 }`

### `POST /order`
```json
{
  "market_id": "BTC-PERP",
  "order_type": "limit",
  "side": "buy",
  "quantity": 0.01,
  "price": 95000,
  "reduce_only": false
}
```
Response: `{ "ok": true, "data": { "order": ..., "tx_hash": ... } }`

### `GET /orders/{rfq_id}`
Placeholder – currently returns `{ "ok": true, "order": null }`.

### `GET /positions`
Placeholder – returns `{ "ok": true, "data": {} }`.

## Integrating With Chrome Extension

Configure the extension to send requests to `http://127.0.0.1:8787/order`. Only public params (market, qty, etc.) leave the browser; Signer credentials remain in `.env`.

## Notes

- If the official SDK changes parameter names, update `app/lighter_client.py`.
- To extend status/positions queries, implement the placeholder methods using SDK APIs.
