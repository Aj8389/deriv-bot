// server.js

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;
const path = require("path");

const app = express();

app.use(express.static(__dirname));
app.use(express.json());

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
  martingaleMultiplier: 2,
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
  baseStake: 10,

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
// HELPERS
// ─────────────────────────────────────────────
function nextId() {
  return ++state.reqId;
}

function sendDeriv(data) {
  if (
    state.derivSocket &&
    state.derivSocket.readyState === WebSocket.OPEN
  ) {
    state.derivSocket.send(JSON.stringify(data));
  }
}

function broadcast(data) {
  const raw = JSON.stringify(data);

  state.browserClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(raw);
      } catch (e) {}
    }
  });
}

function log(msg, level = "info") {
  console.log(`[${level.toUpperCase()}] ${msg}`);
}

function getStats() {
  const total = state.todayWins + state.todayLosses;

  return {
    wins: state.todayWins,
    losses: state.todayLosses,
    total: state.todayTradeCount,
    pnl: state.todayPnl,
    winRate:
      total > 0
        ? Math.round((state.todayWins / total) * 100)
        : 0,
    bestStreak: state.bestStreak,
    remaining: Math.max(
      0,
      state.maxTradesPerDay - state.todayTradeCount
    ),
  };
}

// ─────────────────────────────────────────────
// CONNECT TO DERIV
// ─────────────────────────────────────────────
function connectDeriv(token) {
  state.token = token;

  if (state.derivSocket) {
    try {
      state.derivSocket.close();
    } catch (e) {}
  }

  log("Connecting to Deriv...", "info");

  broadcast({
    type: "CONN_STATUS",
    status: "connecting",
    label: "CONNECTING...",
  });

  const ws = new WebSocket(DERIV_WS);

  state.derivSocket = ws;

  ws.on("open", () => {
    log("Deriv WS Open", "ok");

    sendDeriv({
      authorize: token,
      req_id: nextId(),
    });
  });

  ws.on("message", (raw) => {
    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    handleDerivMessage(data);
  });

  ws.on("error", (err) => {
    log(err.message, "err");

    broadcast({
      type: "CONN_STATUS",
      status: "error",
      label: "WS ERROR",
    });
  });

  ws.on("close", () => {
    log("Deriv WS Closed", "warn");

    state.authorized = false;

    broadcast({
      type: "CONN_STATUS",
      status: "error",
      label: "DISCONNECTED",
    });
  });
}

// ─────────────────────────────────────────────
// HANDLE DERIV MESSAGES
// ─────────────────────────────────────────────
function handleDerivMessage(data) {
  if (data.error) {
    log(data.error.message, "err");

    broadcast({
      type: "LOG",
      level: "err",
      msg: data.error.message,
    });

    return;
  }

  // AUTHORIZE
  if (data.msg_type === "authorize") {
    const auth = data.authorize;

    state.authorized = true;
    state.loginid = auth.loginid;
    state.balance = parseFloat(auth.balance);
    state.currency = auth.currency;

    log("Authorized Successfully", "ok");

    broadcast({
      type: "AUTHORIZED",
      loginid: auth.loginid,
      balance: auth.balance,
      currency: auth.currency,
    });

    sendDeriv({
      balance: 1,
      subscribe: 1,
      req_id: nextId(),
    });

    subscribeTicks(state.symbol);
  }

  // BALANCE
  else if (data.msg_type === "balance") {
    state.balance = parseFloat(data.balance.balance);

    broadcast({
      type: "BALANCE_UPDATE",
      balance: state.balance,
      currency: state.currency,
    });
  }

  // TICK
  else if (data.msg_type === "tick") {
    const price = parseFloat(data.tick.quote);

    state.lastPrice = state.currentPrice || price;
    state.currentPrice = price;

    state.tickBuffer.push(price);

    if (state.tickBuffer.length > 300) {
      state.tickBuffer.shift();
    }

    state.priceHistory.push(price);

    if (state.priceHistory.length > 100) {
      state.priceHistory.shift();
    }

    broadcast({
      type: "TICK",
      price,
      symbol: data.tick.symbol,
    });
  }

  // HISTORY
  else if (
    data.msg_type === "ticks_history" &&
    data.history
  ) {
    const prices = data.history.prices.map(parseFloat);

    state.tickBuffer = prices;
    state.priceHistory = prices.slice(-100);

    broadcast({
      type: "PRICE_HISTORY",
      prices: state.priceHistory,
    });
  }
}

// ─────────────────────────────────────────────
// SUBSCRIBE TICKS
// ─────────────────────────────────────────────
function subscribeTicks(symbol) {
  sendDeriv({
    ticks_history: symbol,
    count: 200,
    end: "latest",
    style: "ticks",
    req_id: nextId(),
  });

  sendDeriv({
    ticks: symbol,
    subscribe: 1,
    req_id: nextId(),
  });

  log(`Subscribed: ${symbol}`, "ok");
}

// ─────────────────────────────────────────────
// APPLY SETTINGS
// ─────────────────────────────────────────────
function applySettings(s) {
  if (s.symbol !== undefined) {
    state.symbol = s.symbol;
  }

  if (s.strategy !== undefined) {
    state.strategy = s.strategy;
  }

  if (s.stake !== undefined) {
    state.stake = parseFloat(s.stake);
  }

  if (s.stopLossPct !== undefined) {
    state.stopLossPct = parseFloat(s.stopLossPct);
  }

  if (s.takeProfitPct !== undefined) {
    state.takeProfitPct = parseFloat(s.takeProfitPct);
  }

  if (s.maxTradesPerDay !== undefined) {
    state.maxTradesPerDay = parseInt(s.maxTradesPerDay);
  }

  if (s.dailyLossLimit !== undefined) {
    state.dailyLossLimit = parseFloat(s.dailyLossLimit);
  }

  if (s.contractType !== undefined) {
    state.contractType = s.contractType;
  }

  if (s.duration !== undefined) {
    state.duration = parseInt(s.duration);
  }

  if (s.durationUnit !== undefined) {
    state.durationUnit = s.durationUnit;
  }
}

// ─────────────────────────────────────────────
// BOT CONTROL
// ─────────────────────────────────────────────
function startBot() {
  state.botRunning = true;

  broadcast({
    type: "BOT_STATUS",
    running: true,
  });

  log("Bot Started", "ok");
}

function stopBot() {
  state.botRunning = false;

  broadcast({
    type: "BOT_STATUS",
    running: false,
  });

  log("Bot Stopped", "warn");
}

function emergencyStop() {
  stopBot();

  state.activeTrade = null;
  state.activeContractId = null;

  broadcast({
    type: "EMERGENCY_STOP",
  });

  log("Emergency Stop", "err");
}

// ─────────────────────────────────────────────
// BROWSER WEBSOCKET
// ─────────────────────────────────────────────
wss.on("connection", (browserWs) => {
  state.browserClients.add(browserWs);

  log(
    `Browser Connected (${state.browserClients.size})`,
    "info"
  );

  browserWs.send(
    JSON.stringify({
      type: "FULL_STATE",
      state: {
        authorized: state.authorized,
        loginid: state.loginid,

        balance: state.balance,
        currency: state.currency,

        botRunning: state.botRunning,

        symbol: state.symbol,

        trades: state.trades.slice(0, 50),

        stats: getStats(),

        priceHistory: state.priceHistory,
        currentPrice: state.currentPrice,
      },
    })
  );

  browserWs.on("message", (raw) => {
    let cmd;

    try {
      cmd = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    // CONNECT
    if (cmd.type === "CONNECT") {
      connectDeriv(cmd.token);
    }

    // START BOT
    else if (cmd.type === "START_BOT") {
      if (cmd.settings) {
        applySettings(cmd.settings);
      }

      startBot();
    }

    // STOP BOT
    else if (cmd.type === "STOP_BOT") {
      stopBot();
    }

    // EMERGENCY
    else if (cmd.type === "EMERGENCY_STOP") {
      emergencyStop();
    }

    // CHANGE SYMBOL
    else if (cmd.type === "CHANGE_SYMBOL") {
      state.symbol = cmd.symbol;

      if (state.authorized) {
        subscribeTicks(cmd.symbol);
      }
    }
  });

  browserWs.on("close", () => {
    state.browserClients.delete(browserWs);

    log("Browser Disconnected", "warn");
  });
});

// ─────────────────────────────────────────────
// REST APIs
// ─────────────────────────────────────────────
app.get("/api/status", (req, res) => {
  res.json({
    authorized: state.authorized,
    loginid: state.loginid,
    balance: state.balance,
    currency: state.currency,
    botRunning: state.botRunning,
    stats: getStats(),
  });
});

app.get("/api/trades", (req, res) => {
  res.json({
    trades: state.trades.slice(0, 100),
  });
});

// ─────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
server.listen(PORT, () => {
  console.log("\n====================================");
  console.log("DerivBot Pro Backend Running");
  console.log("====================================");
  console.log(`Dashboard  : http://localhost:${PORT}`);
  console.log(`API Status : http://localhost:${PORT}/api/status`);
  console.log(`API Trades : http://localhost:${PORT}/api/trades`);
  console.log("====================================\n");
});
