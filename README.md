# 🤖 Predict.fun Points & Market Maker Bot

A high-performance automated trading bot for **Predict.fun** (Blast/BSC). This repository provides a complete suite of tools for **Points Farming**, **Market Making**, and **Drip Arbitrage**, fully integrated with the official Predict.fun SDK.

---

## 🚀 Features

### 1. Market Making & Points Farming
*   **Optimal Yield**: Targeted at "Boosted" markets where Predict.fun provides multiplier points.
*   **Dual-Sided Quoting**: Places BUY orders for both YES and NO tokens to stay delta-neutral while earning points.
*   **Smart Spread Targeting**: Automatically snaps to the widest allowed spread to maximize efficiency and minimize risk.

### 2. Dip Arbitrage Strategy
*   **DIP Detection**: Monitors price drops in YES or NO tokens.
*   **Leg-Based Execution**: Buys the "dipped" side and completes the completeset at a target sum (e.g., < 0.95 USDT) to lock in profit.

### 3. Integrated Wallet & Discovery Tools
*   **Live Scanning**: Directly scan the API for the best markets (no stale local files).
*   **Wallet Management**: Check balances (BNB/USDT), token shares, and manage EOA to Smart Account (Predict Account) transitions.
*   **Auto-Patching SDK**: Automatically detects market types (Standard, Yield Bearing, Negative Risk) and patches the SDK with the correct contract addresses.

---

## 📦 Commands & Usage

### Discovery & Setup
| Command | Description |
| :--- | :--- |
| `npm run find-market` | **Recommended**: Finds top boosted markets for farming right now. |
| `npm run search-market -- <keyword>` | Search for specific markets by keyword. |
| `npm run dump-markets` | Dumps all active markets and their stats to a JSON file. |
| `npm run find-my-account` | Discover which **Predict Account** is linked to your EIP-1193 Signer. |
| `npm run approve-1155` | One-time setup: Approve all necessary Predict.fun contracts. |

### Wallet & Inventory
| Command | Description |
| :--- | :--- |
| `npm run check-balance` | View your Signer's BNB balance (for gas). |
| `npm run check-usdt` | View your Trader's USDT collateral balance. |
| `npm run check-shares` | View YES/NO token balances for the current `MARKET_ID`. |
| `npm run check-allowance` | Check if you have granted permissions to the exchange. |

### Trading & Strategy
| Command | Description |
| :--- | :--- |
| **`npm start`** | **Run the Market Maker Bot** using the `MARKET_ID` in `.env`. |
| `npm run sell-all` | **Emergency Exit**: Cancels open orders and dumps all shares at floor price. |
| `npm run redeem` | **Claim**: Redeem winning shares or Merge YES+NO sets for collateral. |

---

## ⚙️ Configuration (.env)

Ensure your `.env` is setup correctly:

```env
PRIVATE_KEY=your_private_key
API_KEY=your_predict_api_key
CHAIN_ID=56
PREDICT_ACCOUNT=0x... (Optional: If you use a Predict Smart Account)
MARKET_ID=5312
SIZE=50.0
SPREAD=0.04
```

---

## 🛠 Advanced Features

### SDK Auto-Patching
This bot leverages a custom `ApiClient` that automatically re-configures the `@predictdotfun/sdk` based on the market type. Whether you are trading on **Yield Bearing Conditional Tokens** or **Negative Risk** markets, the bot handles the contract switching internally.

### Error Handling
The `ApiClient` includes robust error handling for common issues like `CollateralPerMarketExceededError` or authentication timeouts, ensuring your bot stays online under heavy market load.

### Position Exit Logic
In `bot.ts`, any fill event triggers an immediate re-evaluation and potential exit strategy to lock in points and move to the next trade, minimizing exposure to long-term market direction.
