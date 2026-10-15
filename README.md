# Variational <-> Lighter Hedging Bot
# Variational <-> Lighter 对冲机器人

[English](#english) | [中文](#chinese)

---

<a name="english"></a>
## 🇬🇧 English Documentation

### 1. Project Overview
This project is a Chrome Extension designed to automate hedging strategies between **Lighter** (a decentralized exchange) and **Variational** (a derivatives platform). It monitors market data from both platforms and automatically places a hedging order on Variational when an order is filled on Lighter.

### 2. Key Features
*   **Real-time Monitoring**: Displays live prices, spreads, and arbitrage opportunities for Variational and Lighter.
*   **Auto-Hedging**: Automatically executes a market order on Variational (opposite side) immediately after a Lighter order is filled.
*   **Manual Trading**: Provides a unified interface to place manual orders on both platforms.
*   **Local Signing**: Uses a local Python service (`lighter-signer-manager`) to handle Lighter private key signing securely, keeping sensitive keys out of the browser.
*   **Persistent Logs**: Records all actions and errors locally, persisting across sessions.

### 3. System Architecture
The system consists of two main parts:
1.  **Chrome Extension (`dcc/`)**:
    *   **`background.js`**: The brain of the bot. Manages state, executes hedging logic, and communicates with the local signer.
    *   **`popup.html/js`**: The user interface for monitoring and configuration.
    *   **`content-*.js`**: Scripts injected into exchange websites to scrape real-time market data.
2.  **Local Signer Service (`lighter-signer-manager/`)**:
    *   A Python FastAPI server running locally.
    *   Holds the Lighter API Private Key.
    *   Signs and submits orders to Lighter upon request from the extension.

### 4. Installation & Setup

#### Step 1: Start Local Signer
1.  Navigate to `lighter-signer-manager/`.
2.  Install dependencies (Python 3.9+ recommended):
    ```bash
    pip install -r requirements.txt
    ```
3.  Configure environment variables:
    *   Create a `.env` file based on `.env.example` (if available) or directly in `app/config.py`.
    *   Set your `API_KEY_PRIVATE_KEY` and `LIGHTER_ACCOUNT_INDEX`.
4.  Start the server:
    ```bash
    python -m app.server
    ```
    *   Server should run at `http://127.0.0.1:8787`.

#### Step 2: Install Chrome Extension
1.  Open Chrome and go to `chrome://extensions/`.
2.  Enable **Developer mode** (top right).
3.  Click **Load unpacked**.
4.  Select the `dcc` folder (the root of this project).

### 5. Usage
1.  **Configuration**:
    *   Open the extension popup.
    *   Go to the **Config (配置)** tab.
    *   Enter your Variational `vr-token` and `Wallet Address`.
    *   Set the **Hedge Ratio** (e.g., 1.0 for 1:1 hedging).
2.  **Trading**:
    *   Use the **Trade (交易)** tab to place manual orders if needed.
    *   For auto-hedging, place an order on Lighter (via the extension or Lighter UI if the content script is active). The bot will detect the fill and hedge on Variational.
3.  **Monitoring**:
    *   Check the **Monitor (监控)** tab for live spreads.
    *   Check the **Logs (日志)** tab for activity history.

---

<a name="chinese"></a>
## 🇨🇳 中文说明文档

### 1. 项目简介
本项目是一个 Chrome 浏览器插件，旨在实现 **Lighter**（去中心化交易所）和 **Variational**（衍生品平台）之间的自动化对冲策略。它实时监控两个平台的市场数据，并在 Lighter 上的订单成交后，自动在 Variational 上执行反向对冲交易。

### 2. 核心功能
*   **实时监控**：在插件弹窗中实时显示 Variational 和 Lighter 的价格、价差及套利机会。
*   **自动对冲**：当检测到 Lighter 订单成交时，自动在 Variational 下达反向市价单进行对冲。
*   **手动交易**：提供统一的界面，支持在两个平台手动下单（限价/市价）。
*   **本地签名服务**：使用本地 Python 服务 (`lighter-signer-manager`) 安全处理 Lighter 的私钥签名，避免将私钥暴露在浏览器环境中。
*   **日志持久化**：本地记录所有操作和错误日志，重启插件后依然可见。

### 3. 系统架构
系统由两部分组成：
1.  **Chrome 扩展 (`dcc/`)**：
    *   **`background.js`**：核心逻辑，负责状态管理、执行对冲策略、与本地签名服务通信。
    *   **`popup.html/js`**：用户界面，用于监控行情和配置参数。
    *   **`content-*.js`**：注入到交易所网页的脚本，用于抓取实时行情数据。
2.  **本地签名服务 (`lighter-signer-manager/`)**：
    *   一个运行在本地的 Python FastAPI 服务。
    *   保管 Lighter 的 API 私钥。
    *   接收来自扩展的请求，进行签名并向 Lighter 提交订单。

### 4. 安装与设置

#### 第一步：启动本地签名服务
1.  进入 `lighter-signer-manager/` 目录。
2.  安装依赖（建议使用 Python 3.9+）：
    ```bash
    pip install -r requirements.txt
    ```
    *(注：如果没有 requirements.txt，请查看代码中的依赖，通常需要 `fastapi`, `uvicorn`, `lighter-v1-python` 等)*
3.  配置环境变量：
    *   在目录下创建 `.env` 文件。
    *   设置 `API_KEY_PRIVATE_KEY`（Lighter 私钥）和 `LIGHTER_ACCOUNT_INDEX`。
4.  启动服务：
    ```bash
    python -m app.server
    ```
    *   服务默认运行在 `http://127.0.0.1:8787`。

#### 第二步：安装 Chrome 扩展
1.  打开 Chrome 浏览器，访问 `chrome://extensions/`。
2.  开启右上角的 **开发者模式 (Developer mode)**。
3.  点击 **加载已解压的扩展程序 (Load unpacked)**。
4.  选择本项目的根目录 (`dcc` 文件夹)。

### 5. 使用指南
1.  **配置 (Config)**：
    *   点击插件图标打开弹窗。
    *   进入 **配置** 标签页。
    *   填写 Variational 的 `vr-token` 和 `钱包地址`。
    *   设置 **对冲比例 (Hedge Ratio)**（例如 1.0 表示 1:1 对冲）。
2.  **交易 (Trade)**：
    *   在 **交易** 标签页可以手动在 Variational 或 Lighter 下单。
3.  **监控与对冲**：
    *   在 **监控** 标签页查看实时价差。
    *   当 Lighter 订单（通过插件或网页）成交时，插件会自动在 Variational 下单对冲。
    *   在 **日志** 标签页查看详细的操作记录。

### 6. 文件结构说明
*   `manifest.json`: 插件配置文件，定义权限和脚本。
*   `background.js`: 后台服务，处理核心业务逻辑。
*   `popup.html` / `popup.js`: 插件弹窗界面代码。
*   `content-lighter.js`: Lighter 网页脚本，抓取 WebSocket 行情。
*   `content-variational.js`: Variational 网页脚本，轮询行情。
*   `lighter-signer-manager/`: 本地签名服务目录。
