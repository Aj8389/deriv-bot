/**
 * DerivBot Pro - REAL BACKEND
 * ===========================
 * This actually connects to Deriv's WebSocket API and places real trades.
 *
 * SETUP:
 *   npm install ws express
 *   node server.js
 *   Open http://localhost:3000
 */

const express = require("express");
const http = require("http");
const { WebSocket, WebSocketServer } = require("ws");
const path = require("path");

const app = express();
app.use(express.static(__dirname));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const DERIV_WS = "wss://ws.binaryws.com/websockets/v3?app_id=1089";
const PORT = 3000;

// ─────────────────────────────────────────────
// GLOBAL BOT STATE
// ─────────────────────────────────────────────
let state = {
  derivSocket: null,
  browserClients: new Set(),
  token: null,
  authorized: false,
  loginid: null,
  balance: 0,
  currency: "USD",
  botRunning: false,
  symbol: "R_100",
  strategy: "RSI_EMA",
  stake: 10,
  stopLossPct: 15,
  takeProfitPct: 30,
  maxTradesPerDay: 10,
  dailyLossLimit: 100,
  martingaleEnabled: false,
  martingaleMultiplier: 2.0,
  martingaleMaxSteps: 3,
  contractType: "AUTO",
  duration: 1,
  durationUnit: "m",
  pauseOn3Losses: true,
  todayWins: 0,
  todayLosses: 0,
  todayPnl: 0,
  todayTradeCount: 0,
  consecutiveLosses: 0,
  bestStreak: 0,
  currentStreak: 0,
  martStep: 0,
  basStake: 10,
  paused: false,
  pauseTimer: null,
  trades: [],
  activeTrade: null,
  activeContractId: null,
  tickBuffer: [],
  priceHistory: [],
  currentPrice: 0,
  lastPrice: 0,
  reqId: 1,
  lastSignalTime: 0,
};

// ─────────────────────────────────────────────
// DERIV API CONNECTION
// ─────────────────────────────────────────────
function connectDeriv(token) {
  state.token = token;
  if (state.derivSocket) {
    try { state.derivSocket.close(); } catch (_) {}
    state.derivSocket = null;
  }
  log("Connecting to Deriv API...", "info");
  broadcast({ type: "CONN_STATUS", status: "connecting", label: "CONNECTING..." });
  const ws = new WebSocket(DERIV_WS);
  state.derivSocket = ws;

  ws.on("open", () => {
    log("WebSocket open. Authorizing...", "info");
    sendDeriv({ authorize: token, req_id: nextId() });
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    handleDerivMessage(msg);
    broadcast({ type: "DERIV_RAW", msg });
  });

  ws.on("error", (err) => {
    log("Deriv WS error: " + err.message, "err");
    broadcast({ type: "CONN_STATUS", status: "error", label: "WS ERROR" });
  });

  ws.on("close", () => {
    log("Deriv WS closed. Reconnecting in 5s...", "warn");
    broadcast({ type: "CONN_STATUS", status: "error", label: "RECONNECTING..." });
    state.authorized = false;
    setTimeout(() => { if (state.token) connectDeriv(state.token); }, 5000);
  });
}

// ─────────────────────────────────────────────
// HANDLE DERIV MESSAGES
// ─────────────────────────────────────────────
function handleDerivMessage(data) {
  if (data.error) {
    log("Deriv Error [" + data.msg_type + "]: " + data.error.message, "err");
    broadcast({ type: "LOG", level: "err", msg: "Deriv: " + data.error.message });
    return;
  }

  if (data.msg_type === "authorize") {
    const auth = data.authorize;
    state.authorized = true;
    state.loginid = auth.loginid;
    state.balance = parseFloat(auth.balance);
    state.currency = auth.currency;
    log("Authorized: " + auth.loginid + " | Balance: " + auth.balance + " " + auth.currency, "ok");
    broadcast({ type: "AUTHORIZED", loginid: auth.loginid, balance: auth.balance, currency: auth.currency });
    sendDeriv({ balance: 1, subscribe: 1, req_id: nextId() });
    sendDeriv({ transaction: 1, subscribe: 1, req_id: nextId() });
    subscribeToTicks(state.symbol);
  }

  else if (data.msg_type === "balance" && data.balance) {
    state.balance = parseFloat(data.balance.balance);
    broadcast({ type: "BALANCE_UPDATE", balance: state.balance, currency: state.currency });
  }

  else if (data.msg_type === "tick") {
    const price = parseFloat(data.tick.quote);
    state.lastPrice = state.currentPrice || price;
    state.currentPrice = price;
    state.tickBuffer.push(price);
    if (state.tickBuffer.length > 300) state.tickBuffer.shift();
    state.priceHistory.push(price);
    if (state.priceHistory.length > 100) state.priceHistory.shift();
    broadcast({ type: "TICK", price, symbol: data.tick.symbol, epoch: data.tick.epoch });
    if (state.botRunning && !state.paused) runSignalAnalysis();
  }

  else if (data.msg_type === "ticks_history" && data.history) {
    const prices = data.history.prices.map(parseFloat);
    state.tickBuffer = prices.slice();
    state.priceHistory = prices.slice(-100);
    state.currentPrice = prices[prices.length - 1];
    state.lastPrice = prices[prices.length - 2] || state.currentPrice;
    log("Loaded " + prices.length + " ticks for " + state.symbol, "info");
    broadcast({ type: "PRICE_HISTORY", prices: state.priceHistory });
  }

  else if (data.msg_type === "buy" && data.buy) {
    const buy = data.buy;
    state.activeContractId = buy.contract_id;
    log("Trade PLACED — Contract: " + buy.contract_id + " | Entry: " + buy.buy_price, "ok");
    broadcast({ type: "TRADE_PLACED", contractId: buy.contract_id, buyPrice: buy.buy_price });
    sendDeriv({ proposal_open_contract: 1, contract_id: buy.contract_id, subscribe: 1, req_id: nextId() });
  }

  else if (data.msg_type === "proposal_open_contract" && data.proposal_open_contract) {
    const poc = data.proposal_open_contract;
    broadcast({ type: "CONTRACT_UPDATE", poc, profit: parseFloat(poc.profit) || 0 });
    if (poc.is_expired || poc.is_sold || poc.status === "sold" || poc.status === "won" || poc.status === "lost") {
      finalizeRealTrade(poc);
    }
  }

  else if (data.msg_type === "transaction" && data.transaction) {
    const tx = data.transaction;
    if (tx.action === "buy") {
      log("Transaction: Bought contract " + tx.contract_id + " for " + tx.amount, "info");
    }
  }
}

function subscribeToTicks(symbol) {
  sendDeriv({ ticks_history: symbol, count: 200, end: "latest", style: "ticks", req_id: nextId() });
  sendDeriv({ ticks: symbol, subscribe: 1, req_id: nextId() });
  log("Subscribed to ticks: " + symbol, "info");
}

// ─────────────────────────────────────────────
// TECHNICAL ANALYSIS ENGINE
// ─────────────────────────────────────────────
const TA = {
  rsi(prices, period) {
    period = period || 14;
    if (prices.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = prices.length - period; i < prices.length; i++) {
      const d = prices[i] - prices[i - 1];
      if (d > 0) gains += d; else losses -= d;
    }
    if (losses === 0) return 100;
    return 100 - 100 / (1 + gains / losses);
  },

  ema(prices, period) {
    if (prices.length < period) return prices[prices.length - 1] || 0;
    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce(function(a, b) { return a + b; }, 0) / period;
    for (let i = period; i < prices.length; i++) { ema = prices[i] * k + ema * (1 - k); }
    return ema;
  },

  bollingerBands(prices, period, mult) {
    period = period || 20; mult = mult || 2;
    if (prices.length < period) return { upper: 0, lower: 0, middle: 0 };
    const sl = prices.slice(-period);
    const mean = sl.reduce(function(a, b) { return a + b; }, 0) / period;
    const std = Math.sqrt(sl.map(function(v) { return (v - mean) * (v - mean); }).reduce(function(a, b) { return a + b; }, 0) / period);
    return { upper: mean + std * mult, lower: mean - std * mult, middle: mean };
  },

  analyze(prices, strategy) {
    if (prices.length < 35) return { signal: "WAIT", strength: 0, rsi: 50, reason: "Not enough data" };
    const rsi = this.rsi(prices);
    const ema9 = this.ema(prices, 9);
    const ema21 = this.ema(prices, 21);
    const bb = this.bollingerBands(prices);
    const last = prices[prices.length - 1];
    const macd = this.ema(prices, 12) - this.ema(prices, 26);
    let signal = "WAIT", strength = 0, reason = "";

    if (strategy === "RSI_EMA") {
      if (rsi < 30 && ema9 > ema21) { signal = "BUY"; strength = Math.min(95, 55 + (30 - rsi) * 1.5); reason = "RSI oversold + EMA bullish"; }
      else if (rsi > 70 && ema9 < ema21) { signal = "SELL"; strength = Math.min(95, 55 + (rsi - 70) * 1.5); reason = "RSI overbought + EMA bearish"; }
      else { strength = 20 + Math.abs(50 - rsi) * 0.5; reason = "RSI neutral " + rsi.toFixed(1); }
    } else if (strategy === "BOLLINGER") {
      if (last < bb.lower && rsi < 45) { signal = "BUY"; strength = 72 + Math.random() * 18; reason = "Price below lower BB"; }
      else if (last > bb.upper && rsi > 55) { signal = "SELL"; strength = 72 + Math.random() * 18; reason = "Price above upper BB"; }
      else { strength = 25; reason = "Within BB bands"; }
    } else if (strategy === "MACD") {
      if (macd > 0.0001 && rsi < 62) { signal = "BUY"; strength = 65 + Math.random() * 20; reason = "MACD positive"; }
      else if (macd < -0.0001 && rsi > 38) { signal = "SELL"; strength = 65 + Math.random() * 20; reason = "MACD negative"; }
      else { strength = 20; reason = "MACD neutral"; }
    } else if (strategy === "SCALPER") {
      const r = prices.slice(-6);
      const allDn = r.every(function(v, i) { return i === 0 || v <= r[i-1]; });
      const allUp = r.every(function(v, i) { return i === 0 || v >= r[i-1]; });
      if (allDn && rsi < 50) { signal = "BUY"; strength = 60 + Math.random() * 25; reason = "Tick downtrend reversal"; }
      else if (allUp && rsi > 50) { signal = "SELL"; strength = 60 + Math.random() * 25; reason = "Tick uptrend reversal"; }
      else { strength = 20; reason = "No tick pattern"; }
    }

    return { signal, strength: Math.round(strength), rsi: Math.round(rsi * 10) / 10, ema9, ema21, macd, reason };
  }
};

// ─────────────────────────────────────────────
// SIGNAL ANALYSIS
// ─────────────────────────────────────────────
function runSignalAnalysis() {
  const now = Date.now();
  if (now - state.lastSignalTime < 10000) return;
  if (state.activeTrade) return;
  if (!state.authorized) return;
  const analysis = TA.analyze(state.tickBuffer, state.strategy);
  broadcast({ type: "SIGNAL_UPDATE", analysis });
  if ((analysis.signal === "BUY" || analysis.signal === "SELL") && analysis.strength >= 65) {
    state.lastSignalTime = now;
    log("Signal: " + analysis.signal + " | Strength: " + analysis.strength + "% | " + analysis.reason, "info");
    broadcast({ type: "LOG", level: "info", msg: "Signal " + analysis.signal + " (" + analysis.strength + "%) — " + analysis.reason });
    triggerTrade(analysis.signal, analysis);
  }
}

// ─────────────────────────────────────────────
// TRADE EXECUTION
// ─────────────────────────────────────────────
function triggerTrade(direction, analysis) {
  if (!state.botRunning) return;
  if (!state.authorized) { log("Not authorized", "err"); return; }
  if (state.activeTrade) { log("Trade in progress — skip", "warn"); return; }
  if (state.paused) { log("Bot paused — skip", "warn"); return; }
  if (state.todayTradeCount >= state.maxTradesPerDay) {
    log("Daily trade limit reached. Stopping.", "warn");
    broadcast({ type: "LOG", level: "warn", msg: "Daily trade limit reached. Bot stopped." });
    stopBot(); return;
  }
  if (state.todayPnl <= -state.dailyLossLimit) {
    log("Daily loss limit hit. Stopping.", "err");
    broadcast({ type: "LOG", level: "err", msg: "Daily loss limit hit. Bot stopped." });
    stopBot(); return;
  }

  let stake = state.stake;
  if (state.martingaleEnabled && state.martStep > 0 && state.martStep <= state.martingaleMaxSteps) {
    stake = Math.round(state.basStake * Math.pow(state.martingaleMultiplier, state.martStep) * 100) / 100;
    broadcast({ type: "LOG", level: "warn", msg: "Martingale step " + state.martStep + ": stake $" + stake });
  } else {
    state.basStake = stake;
  }

  const contractType = state.contractType === "AUTO" ? (direction === "BUY" ? "CALL" : "PUT") : state.contractType;

  state.activeTrade = {
    id: "T" + Date.now(), direction, contractType, stake,
    entryPrice: state.currentPrice, analysis, openTime: Date.now(), status: "open"
  };
  state.todayTradeCount++;

  broadcast({ type: "TRADE_OPENED", trade: state.activeTrade, tradeCount: state.todayTradeCount });
  log("Placing " + direction + " | " + state.symbol + " | Stake: $" + stake + " | " + contractType, "ok");

  sendDeriv({
    buy: 1, price: stake,
    parameters: {
      amount: stake, basis: "stake",
      contract_type: contractType,
      currency: state.currency,
      duration: state.duration,
      duration_unit: state.durationUnit,
      symbol: state.symbol
    },
    req_id: nextId()
  });
}

// ─────────────────────────────────────────────
// TRADE FINALIZATION
// ─────────────────────────────────────────────
function finalizeRealTrade(poc) {
  if (!state.activeTrade) return;
  const profit = parseFloat(poc.profit) || 0;
  const isWin = profit > 0;
  const trade = state.activeTrade;
  trade.status = isWin ? "win" : "loss";
  trade.exitPrice = poc.exit_tick_display_value || poc.sell_price || state.currentPrice;
  trade.profit = profit;
  trade.closeTime = Date.now();
  trade.contractId = poc.contract_id;

  if (isWin) {
    state.todayWins++; state.consecutiveLosses = 0; state.currentStreak++;
    state.martStep = 0;
    if (state.currentStreak > state.bestStreak) state.bestStreak = state.currentStreak;
  } else {
    state.todayLosses++; state.consecutiveLosses++; state.currentStreak = 0;
    state.martStep = Math.min(state.martStep + 1, state.martingaleMaxSteps);
    if (state.pauseOn3Losses && state.consecutiveLosses >= 3) triggerPause();
  }

  state.todayPnl = Math.round((state.todayPnl + profit) * 100) / 100;
  state.trades.unshift(Object.assign({}, trade));
  if (state.trades.length > 500) state.trades.pop();
  state.activeTrade = null;
  state.activeContractId = null;

  const stats = getStats();
  broadcast({ type: "TRADE_CLOSED", trade, stats });
  log((isWin ? "WIN" : "LOSS") + " PnL: " + (profit >= 0 ? "+" : "") + "$" + Math.abs(profit).toFixed(2) + " | WR: " + stats.winRate + "%", isWin ? "ok" : "err");
}

// ─────────────────────────────────────────────
// BOT CONTROL
// ─────────────────────────────────────────────
function startBot() {
  if (!state.authorized) { broadcast({ type: "LOG", level: "err", msg: "Cannot start: not authorized" }); return; }
  state.botRunning = true; state.paused = false; state.lastSignalTime = 0;
  state.martStep = 0; state.consecutiveLosses = 0;
  broadcast({ type: "BOT_STATUS", running: true });
  log("Bot STARTED | " + state.strategy + " | " + state.symbol + " | $" + state.stake, "ok");
  broadcast({ type: "LOG", level: "ok", msg: "Bot started | " + state.strategy + " | " + state.symbol });
}

function stopBot() {
  state.botRunning = false;
  if (state.pauseTimer) { clearTimeout(state.pauseTimer); state.pauseTimer = null; }
  broadcast({ type: "BOT_STATUS", running: false });
  log("Bot STOPPED", "warn");
  broadcast({ type: "LOG", level: "warn", msg: "Bot stopped" });
}

function triggerPause() {
  state.paused = true;
  log("3 consecutive losses — pausing 60s", "warn");
  broadcast({ type: "LOG", level: "warn", msg: "3 losses in a row — pausing 60 seconds" });
  if (state.pauseTimer) clearTimeout(state.pauseTimer);
  state.pauseTimer = setTimeout(function() {
    state.paused = false; state.consecutiveLosses = 0;
    log("Bot resumed", "ok");
    broadcast({ type: "LOG", level: "ok", msg: "Bot resumed after 60s pause" });
  }, 60000);
}

function emergencyStop() {
  stopBot();
  if (state.activeContractId && state.derivSocket && state.derivSocket.readyState === WebSocket.OPEN) {
    sendDeriv({ sell: state.activeContractId, price: 0, req_id: nextId() });
    log("Emergency: Force-sold contract", "err");
  }
  state.activeTrade = null; state.activeContractId = null;
  broadcast({ type: "EMERGENCY_STOP" });
  broadcast({ type: "LOG", level: "err", msg: "EMERGENCY STOP triggered" });
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function sendDeriv(payload) {
  if (state.derivSocket && state.derivSocket.readyState === WebSocket.OPEN) {
    state.derivSocket.send(JSON.stringify(payload));
  }
}
function broadcast(data) {
  const raw = JSON.stringify(data);
  state.browserClients.forEach(function(client) {
    if (client.readyState === WebSocket.OPEN) { try { client.send(raw); } catch (_) {} }
  });
}
function nextId() { return ++state.reqId; }
function log(msg, level) {
  level = level || "sys";
  const icons = { ok: "✓", err: "✗", warn: "⚠", info: "ℹ", sys: "·" };
  console.log("[" + new Date().toTimeString().slice(0,8) + "] " + (icons[level] || "·") + " " + msg);
}
function getStats() {
  const total = state.todayWins + state.todayLosses;
  return {
    wins: state.todayWins, losses: state.todayLosses, total: state.todayTradeCount,
    pnl: state.todayPnl, winRate: total > 0 ? Math.round(state.todayWins / total * 100) : 0,
    bestStreak: state.bestStreak, remaining: Math.max(0, state.maxTradesPerDay - state.todayTradeCount)
  };
}
function applySettings(s) {
  if (s.symbol !== undefined) state.symbol = s.symbol;
  if (s.strategy !== undefined) state.strategy = s.strategy;
  if (s.stake !== undefined) state.stake = parseFloat(s.stake);
  if (s.stopLossPct !== undefined) state.stopLossPct = parseFloat(s.stopLossPct);
  if (s.takeProfitPct !== undefined) state.takeProfitPct = parseFloat(s.takeProfitPct);
  if (s.maxTradesPerDay !== undefined) state.maxTradesPerDay = parseInt(s.maxTradesPerDay);
  if (s.dailyLossLimit !== undefined) state.dailyLossLimit = parseFloat(s.dailyLossLimit);
  if (s.martingaleEnabled !== undefined) state.martingaleEnabled = s.martingaleEnabled;
  if (s.martingaleMultiplier !== undefined) state.martingaleMultiplier = parseFloat(s.martingaleMultiplier);
  if (s.martingaleMaxSteps !== undefined) state.martingaleMaxSteps = parseInt(s.martingaleMaxSteps);
  if (s.contractType !== undefined) state.contractType = s.contractType;
  if (s.duration !== undefined) state.duration = parseInt(s.duration);
  if (s.durationUnit !== undefined) state.durationUnit = s.durationUnit;
  if (s.pauseOn3Losses !== undefined) state.pauseOn3Losses = s.pauseOn3Losses;
}

// ─────────────────────────────────────────────
// BROWSER WEBSOCKET HANDLER
// ─────────────────────────────────────────────
wss.on("connection", function(browserWs) {
  state.browserClients.add(browserWs);
  log("Browser connected. Total: " + state.browserClients.size, "info");

  browserWs.send(JSON.stringify({
    type: "FULL_STATE",
    state: {
      authorized: state.authorized, loginid: state.loginid,
      balance: state.balance, currency: state.currency,
      botRunning: state.botRunning, symbol: state.symbol,
      trades: state.trades.slice(0, 50), stats: getStats(),
      priceHistory: state.priceHistory, currentPrice: state.currentPrice
    }
  }));

  browserWs.on("message", function(raw) {
    let cmd; try { cmd = JSON.parse(raw.toString()); } catch (_) { return; }
    if (cmd.type === "CONNECT") connectDeriv(cmd.token);
    else if (cmd.type === "DISCONNECT") { if (state.derivSocket) state.derivSocket.close(); state.authorized = false; }
    else if (cmd.type === "START_BOT") { if (cmd.settings) applySettings(cmd.settings); startBot(); }
    else if (cmd.type === "STOP_BOT") stopBot();
    else if (cmd.type === "EMERGENCY_STOP") emergencyStop();
    else if (cmd.type === "UPDATE_SETTINGS") { applySettings(cmd.settings); broadcast({ type: "LOG", level: "info", msg: "Settings updated" }); }
    else if (cmd.type === "CHANGE_SYMBOL") { state.symbol = cmd.symbol; if (state.authorized) subscribeToTicks(cmd.symbol); }
    else if (cmd.type === "MANUAL_TRADE") { if (state.authorized) triggerTrade(cmd.direction, { signal: cmd.direction, strength: 100, reason: "Manual" }); }
  });

  browserWs.on("close", function() { state.browserClients.delete(browserWs); });
  browserWs.on("error", function() { state.browserClients.delete(browserWs); });
});

// ─────────────────────────────────────────────
// REST API
// ─────────────────────────────────────────────
app.use(express.json());
app.get("/api/status", function(req, res) { res.json({ authorized: state.authorized, loginid: state.loginid, balance: state.balance, currency: state.currency, botRunning: state.botRunning, stats: getStats() }); });
app.get("/api/trades", function(req, res) { res.json({ trades: state.trades.slice(0, 100) }); });
app.use(express.static(path.join(__dirname)));
app.get("/", function(req, res) { res.sendFile(path.join(__dirname, "index.html")); });

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
server.listen(PORT, function() {
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║     DerivBot Pro — Backend Running       ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log("║  Dashboard : http://localhost:" + PORT + "         ║");
  console.log("║  API Status: http://localhost:" + PORT + "/api/status ║");
  console.log("║  API Trades: http://localhost:" + PORT + "/api/trades ║");
  console.log("╚══════════════════════════════════════════╝\n");
  console.log("Waiting for browser... Open http://localhost:3000");
});
