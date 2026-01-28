# 🤖 PredFi: Predict.fun Yield & Arbitrage Bot

PredFi is a professional-grade automated trading suite for **Predict.fun** (on Blast and BSC). Designed for maximum efficiency, it combines institutional-grade **Points Farming** with opportunistic **Dip Arbitrage** strategies.

---

## 🌟 Key Strategies

### 1. Market Making & Points Farmer (`STRATEGY=MM`)
*   **Dual-Sided Quoting**: Simulates liquidity by placing BUY orders for both YES and NO tokens simultaneously.
*   **Delta-Neutral Capture**: Captures the wider spread multiplier on "Boosted" markets while staying market-neutral.
*   **Exit-on-Fill**: Upon any single-leg fill, the bot immediately cancels outstanding orders and market-dumps the position. This minimizes directional risk and maximizes turnover for points.
*   **Volatility Protection**: Automatically detects high-frequency re-quotes and widens spreads to avoid being "picked off" during fast moves.

### 2. Dip Arbitrage (`STRATEGY=DIP`)
*   **Sliding Window Monitoring**: Tracks price history over a 3-10 second window to detect sudden price "dips" (>15%).
*   **Leg-Based Execution**: 
    1.  Buy the "cheapened" side immediately.
    2.  Wait for the opposite side's price to align such that `Cost(YES) + Cost(NO) < 1.00` (Target: 0.95).
    3.  Complete the set and lock in the arbitrage profit.

---

## 🛠 Features

*   **Official SDK Integration**: Built using the official `@predictdotfun/sdk` for maximum stability and easy updates via NPM.
*   **SDK Auto-Patching**: The only bot that dynamically re-configures the SDK instance in real-time based on the market type (**Standard**, **Yield Bearing**, or **Negative Risk**).
*   **Smart Wallet Support**: Fully integrated with Predict.fun's Privy/Smart Account architecture.
*   **Real-time WebSocket**: Low-latency orderbook and wallet event tracking.
*   **Dynamic Scaling**: Automatically scales position sizes down if your USDT balance is insufficient for the configured `SIZE`.

---

## 🚀 Quick Start

### 1. Installation

```bash
git clone https://github.com/your-repo/PredFi.git
cd PredFi
npm install
```

### 2. Configuration
Copy the `.env.example` to `.env` and fill in your credentials.

```env
PRIVATE_KEY=your_eoa_private_key   # Keeps BNB/ETH for gas
API_KEY=your_predict_api_key      # From settings.predict.fun
PREDICT_ACCOUNT=0x...             # [REQUIRED] Your Smart Account address from the website
MARKET_ID=5312                    # Target market (use npm run find-market)
STRATEGY=MM                       # 'MM' or 'DIP'
SIZE=50                           # Min 50 shares for points
SPREAD=0.04                       # 4 cents spread targeting
```

### 3. Setup Permissions
Run this once to approve the exchange to spend your collateral and handle your tokens:
```bash
npm run approve-1155
```

### 4. Run the Bot
```bash
npm start
```

---

## 📦 Command Reference

### Discovery & Setup
| Command | Description |
| :--- | :--- |
| `npm run find-market` | **Recommended**: Scans the API for the best active "Boosted" markets. |
| `npm run search-market -- <key>` | Search for specific markets (e.g., `npm run search-market -- "Bitcoin"`). |
| `npm run inspect-market` | Provides detailed on-chain and off-chain info for the `MARKET_ID` in `.env`. |
| `npm run dump-markets` | Exports all active market data to `markets_dump.json`. |
| `npm run find-my-account` | Resolves the Smart Account (Predict Account) linked to your Private Key. |

### Wallet Management
| Command | Description |
| :--- | :--- |
| `npm run check-balance` | Check EOA BNB/ETH balance (for gas). |
| `npm run check-usdt` | Check Smart Account USDT balance (for trading). |
| `npm run check-shares` | View current YES/NO token holdings for the active `MARKET_ID`. |
| `npm run check-allowance` | Verify if the CTF Exchange is approved. |

### Trading & Maintenance
| Command | Description |
| :--- | :--- |
| `npm start` | Launches the configured strategy. |
| `npm run sell-all` | **Emergency**: Cancels all orders and dumps every share you own at market price. |
| `npm run redeem` | Redeems winning shares or merges YES+NO sets back into USDT. |

---

## ⚠️ Important Considerations

*   **Gas**: Ensure your Signer (EOA) wallet has at least 0.01 BNB/ETH.
*   **Collateral**: Trading happens with USDT in your **Predict Account** (Smart Wallet).
*   **Points**: Predict.fun typically requires a minimum of **50 shares** per leg to qualify for points multipliers.
*   **Errors**: If you see `InsufficientCollateral`, the bot will automatically try to scale down the size, but ensure you have enough USDT for at least the minimum tick.

---

## 📜 Technical Architecture
The bot uses a modular `ApiClient` service that abstracts the complexities of the Predict.fun protocol:
- **`src/services/api.ts`**: Handles authentication, SDK patching, and transaction signing.
- **`src/services/ws.ts`**: Manages stable WebSocket connections and subscriptions.
- **`src/bot.ts`**: The core Market Making logic.
- **`src/strategies/`**: Pluggable directory for new trading logic.
