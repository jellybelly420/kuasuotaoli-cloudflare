/**
 * Kuasuotaoli Cloudflare Worker
 *
 * Routes:
 *   GET  /              → HTML dashboard (login-gated)
 *   POST /api/login     → { password } → { ok, token }
 *   GET  /api/nav       → real-time NAV from exchanges
 *   GET  /api/snapshots → NAV snapshot history from KV
 *   POST /api/snapshot  → save today's snapshot to KV
 *   POST /api/backfill  → backfill historical NAV from income history
 *
 * Environment bindings (wrangler.toml / wrangler secret put):
 *
 *   Binance accounts (主账户 + 2个子账户):
 *     BINANCE_MAIN_API_KEY   BINANCE_MAIN_SECRET_KEY
 *     BINANCE_SUB1_API_KEY   BINANCE_SUB1_SECRET_KEY
 *     BINANCE_SUB2_API_KEY   BINANCE_SUB2_SECRET_KEY
 *
 *   Bybit accounts (主账户 + 2个子账户):
 *     BYBIT_MAIN_API_KEY     BYBIT_MAIN_SECRET_KEY
 *     BYBIT_SUB1_API_KEY     BYBIT_SUB1_SECRET_KEY
 *     BYBIT_SUB2_API_KEY     BYBIT_SUB2_SECRET_KEY
 *
 *   LP_PASSWORDS     (逗号分隔, e.g. "pass1,pass2")
 *   PRINCIPAL_USD    (default 1000000)
 *   STRATEGY_START_DATE (default 2026-03-22)
 *   NAV_KV           (KV namespace binding)
 */

// 所有账户定义 — 账户 key 后缀 → 显示标签
// 每个条目: { envPrefix: 'BINANCE_MAIN', label: 'Binance 主账户', exchange: 'Binance' }
const ACCOUNT_DEFS = [
  { envPrefix: 'BINANCE_MAIN', label: 'Binance 主账户', exchange: 'Binance' },
  { envPrefix: 'BINANCE_SUB1', label: 'Binance 子账户1', exchange: 'Binance' },
  { envPrefix: 'BINANCE_SUB2', label: 'Binance 子账户2', exchange: 'Binance' },
  { envPrefix: 'BYBIT_MAIN',   label: 'Bybit 主账户',   exchange: 'Bybit'   },
  { envPrefix: 'BYBIT_SUB1',   label: 'Bybit 子账户1',  exchange: 'Bybit'   },
  { envPrefix: 'BYBIT_SUB2',   label: 'Bybit 子账户2',  exchange: 'Bybit'   },
];

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

async function hmacSha256Hex(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Simple session token (not cryptographically bound — stateless worker)
async function makeToken(password, secret) {
  return hmacSha256Hex(secret || 'session', password + Date.now().toString().slice(0, -4));
}

// ---------------------------------------------------------------------------
// Exchange API helpers
// ---------------------------------------------------------------------------

async function binanceRequest(env, path, params = {}, apiKey = null, secretKey = null) {
  apiKey = apiKey || env.BINANCE_API_KEY;
  secretKey = secretKey || env.BINANCE_SECRET_KEY;
  if (!apiKey || !secretKey) throw new Error('Binance API keys not configured');

  const ts = Date.now();
  const p = { ...params, timestamp: ts, recvWindow: 10000 };
  const qs = new URLSearchParams(p).toString();
  const sig = await hmacSha256Hex(secretKey, qs);

  // papi 路径用 papi.binance.com，其他用 api.binance.com
  const base = path.startsWith('/papi') ? 'https://papi.binance.com' : 'https://api.binance.com';
  const resp = await fetch(`${base}${path}?${qs}&signature=${sig}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Binance ${path} → ${resp.status}: ${t.slice(0, 200)}`);
  }
  return resp.json();
}

async function bybitRequest(env, path, params = {}, apiKey = null, secretKey = null) {
  apiKey = apiKey || env.BYBIT_API_KEY;
  secretKey = secretKey || env.BYBIT_SECRET_KEY;
  if (!apiKey || !secretKey) throw new Error('Bybit API keys not configured');

  const ts = Date.now();
  const recvWindow = 10000;
  const qs = new URLSearchParams(params).toString();
  const signPayload = `${ts}${apiKey}${recvWindow}${qs}`;
  const sig = await hmacSha256Hex(secretKey, signPayload);

  const url = `https://api.bybit.com${path}${qs ? '?' + qs : ''}`;
  const resp = await fetch(url, {
    headers: {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-SIGN': sig,
      'X-BAPI-SIGN-ALGO': 'HmacSHA256',
      'X-BAPI-TIMESTAMP': String(ts),
      'X-BAPI-RECV-WINDOW': String(recvWindow),
    },
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Bybit ${path} → ${resp.status}: ${t.slice(0, 200)}`);
  }
  return resp.json();
}

// Public price fetcher (no auth needed)
async function fetchPrices(symbols) {
  if (!symbols.length) return {};
  try {
    const encoded = encodeURIComponent(JSON.stringify(symbols.map(s => `"${s}USDT"`)));
    const resp = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${encoded}`);
    if (!resp.ok) throw new Error('price fetch failed');
    const data = await resp.json();
    const out = {};
    for (const item of data) {
      const base = item.symbol.replace('USDT', '');
      out[base] = parseFloat(item.price);
    }
    return out;
  } catch {
    // fallback: fetch all tickers from Bybit
    try {
      const resp = await fetch('https://api.bybit.com/v5/market/tickers?category=spot');
      const data = await resp.json();
      const out = {};
      for (const item of (data?.result?.list || [])) {
        const base = item.symbol.replace('USDT', '');
        out[base] = parseFloat(item.lastPrice);
      }
      return out;
    } catch {
      return {};
    }
  }
}

// ---------------------------------------------------------------------------
// Binance data fetching
// ---------------------------------------------------------------------------

async function fetchBinanceNAV(env, apiKey = null, secretKey = null) {
  const _binReq = (path, params) => binanceRequest(env, path, params, apiKey, secretKey);
  const STABLECOINS = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'DAI']);
  const positions = [];
  let assets = [];
  let freeUSDT = 0;
  let isPapi = false; // 是否为 Portfolio Margin 账户

  // 1. 先尝试 Portfolio Margin API (papi)
  let rawBalances = [];
  try {
    const balanceData = await _binReq('/papi/v1/balance');
    rawBalances = balanceData.filter(item => parseFloat(item.totalWalletBalance || 0) > 0)
      .map(item => ({ asset: item.asset, total: parseFloat(item.totalWalletBalance) }));
    isPapi = true;
    // 可用 USDT（扣除保证金占用后）
    try {
      const acct = await _binReq('/papi/v1/account');
      freeUSDT = parseFloat(acct.virtualMaxWithdrawAmount || 0);
    } catch { /* ignore */ }
  } catch (e) {
    // -2015 = 非 papi 账户，回退到普通 spot API
    if (e.message.includes('-2015') || e.message.includes('Invalid API-key')) {
      try {
        const spotData = await _binReq('/api/v3/account', {});
        const balances = spotData?.balances || [];
        rawBalances = balances
          .filter(b => parseFloat(b.free || 0) + parseFloat(b.locked || 0) > 0)
          .map(b => ({
            asset: b.asset,
            total: parseFloat(b.free || 0) + parseFloat(b.locked || 0),
            free: parseFloat(b.free || 0),
          }));
      } catch (e2) {
        throw new Error(`Binance spot fallback failed: ${e2.message}`);
      }
    } else {
      throw e;
    }
  }

  // 2. 获取价格
  const priceSymbols = rawBalances
    .filter(b => !STABLECOINS.has(b.asset))
    .map(b => b.asset);
  const prices = await fetchPrices(priceSymbols);

  // 3. 构建资产列表
  for (const b of rawBalances) {
    const asset = b.asset;
    const total = b.total;
    if (total <= 0) continue;

    let price;
    if (STABLECOINS.has(asset)) {
      price = 1.0;
    } else {
      price = prices[asset] || 0;
      if (!price) continue;
    }

    const navValue = total * price;
    if (navValue < 1) continue;

    // 可用余额展示：papi 用 virtualMaxWithdrawAmount，spot 用 free
    let displayAmount = total;
    if (asset === 'USDT') {
      if (isPapi && freeUSDT >= 0) displayAmount = freeUSDT;
      else if (b.free != null) displayAmount = b.free;
    } else if (b.free != null && !isPapi) {
      displayAmount = b.free;
    }
    const displayValue = displayAmount * price;

    assets.push({
      asset,
      amount: displayAmount,
      price,
      value: displayValue,
      navValue,
      positionType: 'Spot',
      direction: '-',
      notional: displayValue,
      pnl: null,
    });
  }

  // Futures positions
  try {
    const posData = await _binReq('/papi/v1/um/positionRisk');
    for (const pos of posData) {
      const posAmt = parseFloat(pos.positionAmt || 0);
      if (Math.abs(posAmt) === 0) continue;
      const markPrice = parseFloat(pos.markPrice || 0);
      if (markPrice <= 0) continue;
      const unrealizedPnl = parseFloat(pos.unRealizedProfit || 0);
      const notional = Math.abs(parseFloat(pos.notional || posAmt * markPrice));
      const symbol = pos.symbol || '';
      const base = symbol.replace(/USDT$|BUSD$|USDC$/, '');

      positions.push({
        asset: base,
        amount: Math.abs(posAmt),
        price: markPrice,
        value: notional,
        navValue: unrealizedPnl,
        positionType: 'Futures',
        direction: posAmt > 0 ? 'Long' : 'Short',
        notional,
        pnl: unrealizedPnl,
      });
    }
  } catch (e) {
    console.warn('Binance futures positions failed:', e.message);
  }

  return { assets: [...assets, ...positions], exchange: 'Binance' };
}

// ---------------------------------------------------------------------------
// Bybit data fetching
// ---------------------------------------------------------------------------

async function fetchBybitNAV(env, apiKey = null, secretKey = null) {
  const _bybitReq = (path, params) => bybitRequest(env, path, params, apiKey, secretKey);
  const STABLECOINS = new Set(['USDT', 'USDC', 'DAI', 'FDUSD']);
  const assets = [];
  const positions = [];

  // Wallet balance (unified account)
  const walletData = await _bybitReq('/v5/account/wallet-balance', { accountType: 'UNIFIED' });
  const walletList = walletData?.result?.list || [];

  // Also fetch funding wallet
  let fundingCoins = [];
  try {
    const fundData = await _bybitReq('/v5/account/wallet-balance', { accountType: 'FUND' });
    fundingCoins = fundData?.result?.list?.[0]?.coin || [];
  } catch { /* ignore */ }

  const allCoins = [
    ...(walletList[0]?.coin || []),
    ...fundingCoins,
  ];

  const priceSymbols = allCoins
    .filter(c => !STABLECOINS.has(c.coin) && parseFloat(c.walletBalance || 0) > 0)
    .map(c => c.coin);
  const prices = await fetchPrices(priceSymbols);

  // Track seen coins to avoid duplicates
  const seen = new Map();
  for (const coin of allCoins) {
    const asset = coin.coin;
    const total = parseFloat(coin.walletBalance || 0);
    if (total <= 0) continue;

    let price;
    if (STABLECOINS.has(asset)) {
      price = 1.0;
    } else {
      price = prices[asset] || 0;
      if (!price) continue;
    }

    const navValue = total * price;
    if (navValue < 1) continue;

    const freeAmount = parseFloat(coin.availableToWithdraw || coin.availableToBorrow || total);
    const displayAmount = STABLECOINS.has(asset) ? freeAmount : total;
    const displayValue = displayAmount * price;

    if (seen.has(asset)) {
      // merge: add to existing
      const existing = seen.get(asset);
      existing.amount += displayAmount;
      existing.value += displayValue;
      existing.navValue += navValue;
      existing.notional += displayValue;
    } else {
      const entry = {
        asset,
        amount: displayAmount,
        price,
        value: displayValue,
        navValue,
        positionType: 'Spot',
        direction: '-',
        notional: displayValue,
        pnl: null,
      };
      seen.set(asset, entry);
      assets.push(entry);
    }
  }

  // Futures positions
  try {
    let cursor = null;
    let page = 0;
    while (page < 5) {
      const params = { category: 'linear', settleCoin: 'USDT', limit: '200' };
      if (cursor) params.cursor = cursor;
      const posData = await _bybitReq('/v5/position/list', params);
      const rows = posData?.result?.list || [];
      for (const pos of rows) {
        const contracts = parseFloat(pos.size || 0);
        if (contracts <= 0) continue;
        const markPrice = parseFloat(pos.markPrice || 0);
        if (markPrice <= 0) continue;
        const unrealizedPnl = parseFloat(pos.unrealisedPnl || 0);
        const notional = contracts * markPrice;
        const symbol = pos.symbol || '';
        const base = symbol.replace(/USDT$|USDC$/, '');
        const side = pos.side || 'Buy';
        positions.push({
          asset: base,
          amount: contracts,
          price: markPrice,
          value: notional,
          navValue: unrealizedPnl,
          positionType: 'Futures',
          direction: side === 'Buy' ? 'Long' : 'Short',
          notional,
          pnl: unrealizedPnl,
        });
      }
      cursor = posData?.result?.nextPageCursor;
      if (!cursor || !rows.length) break;
      page++;
    }
  } catch (e) {
    console.warn('Bybit futures positions failed:', e.message);
  }

  return { assets: [...assets, ...positions], exchange: 'Bybit' };
}

// ---------------------------------------------------------------------------
// NAV history helpers — D1 primary, KV fallback
// ---------------------------------------------------------------------------

function todayCSTString() {
  const now = new Date();
  const cst = new Date(now.getTime() + 8 * 3600000);
  return cst.toISOString().slice(0, 10);
}

async function loadSnapshots(env) {
  // D1 优先
  if (env.NAV_DB) {
    try {
      const { results } = await env.NAV_DB.prepare(
        'SELECT date, nav, binance_nav, bybit_nav, per_account, ts FROM nav_snapshots ORDER BY date ASC'
      ).all();
      const out = {};
      for (const row of results) {
        let perAccount = {};
        try { perAccount = JSON.parse(row.per_account || '{}'); } catch {}
        out[row.date] = {
          nav: row.nav,
          exchanges: { Binance: row.binance_nav || 0, Bybit: row.bybit_nav || 0 },
          perAccount,
          ts: row.ts,
        };
      }
      return out;
    } catch (e) {
      console.warn('D1 loadSnapshots failed:', e.message);
    }
  }
  // KV 回退
  if (env.NAV_KV) {
    try {
      const raw = await env.NAV_KV.get('nav_snapshots', { type: 'json' });
      return raw || {};
    } catch { return {}; }
  }
  return {};
}

async function saveSnapshot(env, date, navValue, perExchange, perAccount) {
  const ts = new Date(Date.now() + 8 * 3600000).toISOString();
  const binanceNav = perExchange?.Binance || 0;
  const bybitNav   = perExchange?.Bybit   || 0;
  const perAccStr  = JSON.stringify(perAccount || {});

  if (env.NAV_DB) {
    await env.NAV_DB.prepare(
      `INSERT INTO nav_snapshots (date, nav, binance_nav, bybit_nav, per_account, ts)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(date) DO UPDATE SET
         nav=?2, binance_nav=?3, bybit_nav=?4, per_account=?5, ts=?6`
    ).bind(date, navValue, binanceNav, bybitNav, perAccStr, ts).run();
  }
}

async function maybeSaveSnapshot(env, navValue, perExchange, perAccount) {
  const now = new Date();
  const cstHour = new Date(now.getTime() + 8 * 3600000).getUTCHours();
  if (cstHour < 17) return { saved: false, reason: 'Before 17:00 CST' };

  const today = todayCSTString();

  // 检查今天是否已存
  if (env.NAV_DB) {
    try {
      const row = await env.NAV_DB.prepare(
        'SELECT date FROM nav_snapshots WHERE date = ?1'
      ).bind(today).first();
      if (row) return { saved: false, reason: 'Already saved today' };
    } catch {}
  }

  await saveSnapshot(env, today, navValue, perExchange, perAccount);
  return { saved: true, date: today };
}

// ---------------------------------------------------------------------------
// LP Metrics calculation (mirrors the Python logic)
// ---------------------------------------------------------------------------

function calculateLPMetrics(snapshots, principalUSD, strategyStartDate) {
  const entries = Object.entries(snapshots).sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length < 2) return null;

  // Anchor: inject principal at day-0 if not already present
  const earliestDate = entries[0][0];
  const firstNav = entries[0][1].nav;
  let allEntries = entries;
  if (Math.abs(firstNav - principalUSD) > 0.01) {
    const anchorDate = new Date(new Date(earliestDate).getTime() - 86400000)
      .toISOString().slice(0, 10);
    allEntries = [[anchorDate, { nav: principalUSD, exchanges: {}, ts: anchorDate + 'T00:00:00' }], ...entries];
  }

  const sortedDates = allEntries.map(e => e[0]);
  const navs = allEntries.map(e => parseFloat(e[1].nav));

  // Strategy-period subset (after STRATEGY_START_DATE)
  const riskEntries = allEntries.filter(e => e[0] >= strategyStartDate);
  const riskDates = riskEntries.map(e => e[0]);
  const riskNavs = riskEntries.map(e => parseFloat(e[1].nav));
  const riskReturns = riskNavs.slice(1).map((n, i) => n / riskNavs[i] - 1);

  const latestNav = navs[navs.length - 1];
  const ms0 = new Date(sortedDates[0]).getTime();
  const msN = new Date(sortedDates[sortedDates.length - 1]).getTime();
  const days = Math.max((msN - ms0) / 86400000, 1);

  const cumulativeReturn = (latestNav / principalUSD - 1) * 100;
  const annReturn = (Math.pow(latestNav / principalUSD, 365 / days) - 1) * 100;

  let sharpe = 0, sortino = 0, maxDrawdown = 0;
  const drawdownSeries = [];

  if (riskReturns.length >= 2) {
    const mean = riskReturns.reduce((a, b) => a + b, 0) / riskReturns.length;
    const variance = riskReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / riskReturns.length;
    const std = Math.sqrt(variance);
    sharpe = std > 0 ? (mean / std) * Math.sqrt(365) : 0;

    const negReturns = riskReturns.filter(r => r < 0);
    if (negReturns.length > 0) {
      const downVar = negReturns.reduce((a, b) => a + b ** 2, 0) / negReturns.length;
      const downStd = Math.sqrt(downVar);
      sortino = downStd > 0 ? (mean / downStd) * Math.sqrt(365) : 0;
    }

    let peak = riskNavs[0];
    for (const n of riskNavs) {
      if (n >= peak) peak = n;
      const dd = (n - peak) / peak * 100;
      if (dd < maxDrawdown) maxDrawdown = dd;
      drawdownSeries.push(dd);
    }
  }

  // Rolling annualized
  let annual7d = null, annual30d = null;
  if (navs.length > 7) {
    annual7d = (Math.pow(navs[navs.length - 1] / navs[navs.length - 8], 365 / 7) - 1) * 100;
  }
  if (navs.length > 30) {
    annual30d = (Math.pow(navs[navs.length - 1] / navs[navs.length - 31], 365 / 30) - 1) * 100;
  }

  // Monthly returns
  const monthly = {};
  let prevLast = null;
  for (const [d, data] of allEntries) {
    const ym = d.slice(0, 7);
    const nav = parseFloat(data.nav);
    if (!monthly[ym]) monthly[ym] = { first: nav, last: nav };
    else monthly[ym].last = nav;
  }
  const monthlyReturns = {};
  const sortedYMs = Object.keys(monthly).sort();
  for (const ym of sortedYMs) {
    const start = prevLast !== null ? prevLast : monthly[ym].first;
    const end = monthly[ym].last;
    monthlyReturns[ym] = start > 0 ? (end / start - 1) * 100 : 0;
    prevLast = end;
  }

  // Top drawdowns (strategy period)
  const topDrawdowns = calculateTopDrawdowns(riskDates, riskNavs);

  return {
    cumulativeReturn,
    annReturn,
    sharpe,
    sortino,
    maxDrawdown,
    annual7d,
    annual30d,
    days: Math.round(days),
    snapshots: allEntries.length,
    latestDate: sortedDates[sortedDates.length - 1],
    latestNav,
    sortedDates: riskDates,
    navs,
    allDates: sortedDates,
    drawdownSeries,
    monthlyReturns,
    topDrawdowns,
  };
}

function calculateTopDrawdowns(dates, navs) {
  const periods = [];
  let peak = navs[0];
  let inDD = false;
  let ddStartIdx = 0;

  for (let i = 0; i < navs.length; i++) {
    if (navs[i] >= peak) {
      if (inDD) {
        let worst = 0;
        const refNav = ddStartIdx > 0 ? navs[ddStartIdx - 1] : navs[0];
        for (let j = ddStartIdx; j <= i; j++) {
          const dd = (navs[j] / refNav - 1) * 100;
          if (dd < worst) worst = dd;
        }
        periods.push({
          started: dates[ddStartIdx],
          recovered: dates[i],
          drawdown: worst,
          days: i - ddStartIdx,
        });
        inDD = false;
      }
      peak = navs[i];
    } else {
      if (!inDD) { inDD = true; ddStartIdx = i; }
    }
  }
  if (inDD) {
    let worst = 0;
    const refNav = ddStartIdx > 0 ? navs[ddStartIdx - 1] : navs[0];
    for (let j = ddStartIdx; j < navs.length; j++) {
      const dd = (navs[j] / refNav - 1) * 100;
      if (dd < worst) worst = dd;
    }
    periods.push({
      started: dates[ddStartIdx],
      recovered: '—',
      drawdown: worst,
      days: navs.length - ddStartIdx,
    });
  }
  return periods.sort((a, b) => a.drawdown - b.drawdown).slice(0, 10);
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function getValidPasswords(env) {
  const raw = env.LP_PASSWORDS || '';
  return new Set(raw.split(',').map(p => p.trim()).filter(Boolean));
}

function verifySessionToken(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/ksl_session=([^;]+)/);
  if (!match) return false;
  // Simple validation: token is in KV or just non-empty for now
  // In production, you'd validate HMAC. Here we trust the presence + check env secret.
  return match[1].length > 10;
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

async function handleLogin(request, env) {
  const body = await request.json();
  const { password } = body || {};
  const valid = getValidPasswords(env);

  if (!valid.size) {
    return json({ ok: false, error: 'LP_PASSWORDS not configured on the server.' });
  }
  if (!valid.has(password)) {
    return json({ ok: false, error: 'Invalid access code' });
  }

  // Issue a simple session token
  const token = await hmacSha256Hex(env.LP_PASSWORDS || 'secret', password + Date.now().toString().slice(0, -3));
  const resp = json({ ok: true });
  resp.headers.set('Set-Cookie',
    `ksl_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`
  );
  return resp;
}

async function handleNAV(env) {
  const errors = [];
  // accounts[label] = { assets: [...], exchange: 'Binance'|'Bybit' }
  const accounts = {};

  // Fetch all 6 accounts in parallel
  const tasks = ACCOUNT_DEFS.map(async ({ envPrefix, label, exchange }) => {
    const apiKey    = env[`${envPrefix}_API_KEY`];
    const secretKey = env[`${envPrefix}_SECRET_KEY`];
    if (!apiKey || !secretKey) {
      // 未配置的账户静默跳过（不报错）
      return;
    }

    try {
      let data;
      if (exchange === 'Binance') {
        data = await fetchBinanceNAV(env, apiKey, secretKey);
      } else {
        data = await fetchBybitNAV(env, apiKey, secretKey);
      }
      // tag each asset with account label
      data.assets = data.assets.map(a => ({ ...a, account: label, exchange }));
      accounts[label] = data;
    } catch (e) {
      const msg = e.message || '';
      // IP 白名单错误给出明确提示
      if (msg.includes('-2015') || msg.includes('Invalid API-key, IP')) {
        errors.push(`${label}: IP未授权 (${exchange === 'Binance' ? '请在Binance API管理页取消IP限制，或添加Cloudflare Worker IP' : '请检查Bybit API IP设置'})`);
      } else {
        errors.push(`${label}: ${msg.slice(0, 120)}`);
      }
    }
  });
  await Promise.all(tasks);

  // Per-exchange NAV (equity method)
  const perExchange = { Binance: 0, Bybit: 0 };
  const perAccount  = {};
  let totalNAV = 0;

  for (const [label, data] of Object.entries(accounts)) {
    const nav = data.assets.reduce((s, a) => s + (a.navValue || 0), 0);
    perAccount[label] = nav;
    const ex = data.assets[0]?.exchange || '';
    if (ex === 'Binance') perExchange.Binance += nav;
    else if (ex === 'Bybit') perExchange.Bybit += nav;
    totalNAV += nav;
  }

  return json({ totalNAV, perExchange, perAccount, accounts, errors });
}

async function handleSnapshots(env) {
  const snapshots = await loadSnapshots(env);
  const principalUSD = parseFloat(env.PRINCIPAL_USD || '1000000');
  const strategyStart = env.STRATEGY_START_DATE || '2026-03-22';
  const metrics = calculateLPMetrics(snapshots, principalUSD, strategyStart);
  return json({ snapshots, metrics });
}

async function handleSaveSnapshot(request, env) {
  const body = await request.json();
  const { nav, perExchange, perAccount } = body || {};
  if (!nav || nav <= 0) return json({ ok: false, error: 'Invalid NAV value' });
  const result = await maybeSaveSnapshot(env, nav, perExchange || {}, perAccount || {});
  return json({ ok: true, ...result });
}

async function handleBackfill(request, env) {
  // Simplified backfill using income history
  // This is a best-effort operation — builds historical NAV from income data
  const body = await request.json().catch(() => ({}));
  const { currentNAV, perExchange } = body || {};
  if (!currentNAV || currentNAV <= 0) return json({ ok: false, error: 'Invalid NAV' });

  const snapshots = await loadSnapshots(env);

  // Check if already backfilled
  const keys = Object.keys(snapshots);
  if (keys.length >= 5) {
    // Check for flat (failed) snapshots
    const navVals = keys.map(k => parseFloat(snapshots[k].nav)).filter(v => !isNaN(v));
    const range = Math.max(...navVals) - Math.min(...navVals);
    if (range > 1) {
      return json({ ok: false, reason: 'Already backfilled', count: keys.length });
    }
  }

  // Fetch income history from both exchanges
  const combined = {};
  const now = Date.now();
  const startMs = new Date('2026-03-02T00:00:00+08:00').getTime();

  // Iterate all configured Binance accounts for income
  const binancePrefixes = ['BINANCE_MAIN', 'BINANCE_SUB1', 'BINANCE_SUB2'];
  for (const prefix of binancePrefixes) {
    const apiKey = env[`${prefix}_API_KEY`] || (prefix === 'BINANCE_MAIN' ? env.BINANCE_API_KEY : null);
    const secretKey = env[`${prefix}_SECRET_KEY`] || (prefix === 'BINANCE_MAIN' ? env.BINANCE_SECRET_KEY : null);
    if (!apiKey || !secretKey) continue;

    try {
      let fetchStart = startMs;
      while (true) {
        const items = await binanceRequest(env, '/papi/v1/um/income', {
          startTime: fetchStart,
          endTime: now,
          limit: 1000,
        }, apiKey, secretKey);
        if (!items?.length) break;
        for (const item of items) {
          const incType = item.incomeType;
          if (!['FUNDING_FEE', 'REALIZED_PNL', 'COMMISSION'].includes(incType)) continue;
          const asset = item.asset || 'USDT';
          if (!['USDT', 'USDC', 'BUSD'].includes(asset)) continue;
          const amount = parseFloat(item.income || 0);
          const ts = parseInt(item.time || 0);
          const dt = new Date(ts + 8 * 3600000);
          const dateStr = dt.toISOString().slice(0, 10);
          combined[dateStr] = (combined[dateStr] || 0) + amount;
        }
        if (items.length < 1000) break;
        fetchStart = parseInt(items[items.length - 1].time) + 1;
      }
    } catch (e) {
      console.warn('Backfill Binance income failed:', e.message);
    }
  }

  // Iterate all configured Bybit accounts for income
  const bybitPrefixes = ['BYBIT_MAIN', 'BYBIT_SUB1', 'BYBIT_SUB2'];
  for (const prefix of bybitPrefixes) {
    const apiKey = env[`${prefix}_API_KEY`] || (prefix === 'BYBIT_MAIN' ? env.BYBIT_API_KEY : null);
    const secretKey = env[`${prefix}_SECRET_KEY`] || (prefix === 'BYBIT_MAIN' ? env.BYBIT_SECRET_KEY : null);
    if (!apiKey || !secretKey) continue;

    try {
      let cursor = null;
      for (let page = 0; page < 20; page++) {
        const params = {
          accountType: 'UNIFIED',
          startTime: String(startMs),
          endTime: String(now),
          limit: '50',
        };
        if (cursor) params.cursor = cursor;
        const resp = await bybitRequest(env, '/v5/account/transaction-log', params, apiKey, secretKey);
        const result = resp?.result || {};
        const rows = result.list || [];
        for (const item of rows) {
          const txType = item.type;
          if (!['TRADE', 'SETTLEMENT'].includes(txType)) continue;
          const currency = item.currency || 'USDT';
          if (!['USDT', 'USDC'].includes(currency)) continue;
          const amount = parseFloat(item.cashFlow || 0);
          const tsMs = parseInt(item.transactionTime || 0);
          if (tsMs <= 0) continue;
          const dt = new Date(tsMs + 8 * 3600000);
          const dateStr = dt.toISOString().slice(0, 10);
          combined[dateStr] = (combined[dateStr] || 0) + amount;
        }
        cursor = result.nextPageCursor;
        if (!cursor || !rows.length) break;
      }
    } catch (e) {
      console.warn(`Backfill ${prefix} income failed:`, e.message);
    }
  }

  if (!Object.keys(combined).length) {
    return json({ ok: false, reason: 'No income data fetched' });
  }

  // Reconstruct daily NAV backwards from currentNAV
  const startDate = new Date('2026-03-02T00:00:00+08:00');
  const todayDate = new Date(now + 8 * 3600000);
  const allDates = [];
  let d = new Date(startDate);
  while (d <= todayDate) {
    allDates.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86400000);
  }

  let runningNAV = currentNAV;
  const dailyNavs = {};
  const totalNow = Object.values(perExchange || {}).reduce((a, b) => a + b, 0) || 1;

  for (const dateStr of [...allDates].reverse()) {
    dailyNavs[dateStr] = runningNAV;
    const income = combined[dateStr] || 0;
    runningNAV = runningNAV - income;
  }

  // 写入 D1（不覆盖已有快照）
  const existing = await loadSnapshots(env);
  let written = 0;
  for (const [dateStr, navVal] of Object.entries(dailyNavs)) {
    if (existing[dateStr]) continue;
    const perEx = {};
    for (const [ex, navNow] of Object.entries(perExchange || {})) {
      perEx[ex] = navVal * (navNow / totalNow);
    }
    await saveSnapshot(env, dateStr, navVal, perEx, {});
    written++;
  }

  return json({ ok: true, written, totalDates: allDates.length });
}

async function handleDiag(env) {
  const ALL_SECRETS = [
    'BINANCE_MAIN_API_KEY', 'BINANCE_MAIN_SECRET_KEY',
    'BINANCE_SUB1_API_KEY', 'BINANCE_SUB1_SECRET_KEY',
    'BINANCE_SUB2_API_KEY', 'BINANCE_SUB2_SECRET_KEY',
    'BYBIT_MAIN_API_KEY',   'BYBIT_MAIN_SECRET_KEY',
    'BYBIT_SUB1_API_KEY',   'BYBIT_SUB1_SECRET_KEY',
    'BYBIT_SUB2_API_KEY',   'BYBIT_SUB2_SECRET_KEY',
    'LP_PASSWORDS',
  ];
  const status = {};
  for (const key of ALL_SECRETS) {
    const val = env[key];
    status[key] = val ? `✅ 已配置 (${val.slice(0,4)}***${val.slice(-2)})` : '❌ 未配置';
  }
  // Account pairs summary
  const accounts = {};
  for (const def of ACCOUNT_DEFS) {
    const k = env[`${def.envPrefix}_API_KEY`];
    const s = env[`${def.envPrefix}_SECRET_KEY`];
    accounts[def.label] = (k && s) ? '✅ 已配置' : '❌ 未配置';
  }
  return json({ secrets: status, accounts });
}



const THEME_COLOR = '#0047AB';
const THEME_ACCENT = '#00D4AA';

function renderHTML() {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>10K Ventures | Crypto Portal</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{font-family:'Inter',sans-serif;background:#F8F9FA;color:#1E2329;min-height:100vh}
body{padding:0}
/* Login */
#login-screen{display:flex;align-items:center;justify-content:center;min-height:100vh;background:#F8F9FA}
.login-card{background:#fff;border-radius:16px;padding:40px;max-width:380px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.08);border:1px solid #EAECEF;text-align:center}
.login-card img{width:120px;margin-bottom:16px}
.login-card h2{font-size:20px;font-weight:600;color:#1E2329;margin-bottom:6px}
.login-card p{font-size:13px;color:#6B7280;margin-bottom:24px}
.login-card input{width:100%;padding:12px 16px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px;outline:none;transition:.2s;font-family:inherit}
.login-card input:focus{border-color:${THEME_COLOR};box-shadow:0 0 0 3px rgba(0,71,171,.12)}
.login-card button{width:100%;margin-top:12px;padding:12px;background:${THEME_COLOR};color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:.2s;font-family:inherit}
.login-card button:hover{background:#0039a0}
.login-card .error{color:#EF4444;font-size:13px;margin-top:8px}
/* App */
#app{display:none;padding:20px;max-width:1440px;margin:0 auto}
/* Topbar */
.topbar{display:flex;align-items:center;gap:10px;margin-bottom:20px;flex-wrap:wrap}
.topbar img{height:36px}
.topbar h1{font-size:18px;font-weight:700;color:#1E2329;margin-right:8px}
.btn-group{display:flex;gap:6px;margin-left:auto}
.btn{padding:6px 18px;border:1px solid #E0E0E0;background:#fff;color:#5E6673;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:.2s;font-family:inherit}
.btn:hover,.btn.active{border-color:${THEME_COLOR};color:${THEME_COLOR};background:#EBF0FA}
.btn.active{background:${THEME_COLOR};color:#fff}
.btn-refresh{border-color:#E0E0E0}
/* Cards */
.card{background:#fff;border-radius:16px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.04);border:1px solid #EAECEF;margin-bottom:20px}
.section-header{font-size:16px;font-weight:600;color:#1E2329;border-left:3px solid ${THEME_COLOR};padding-left:12px;margin-bottom:16px}
/* NAV hero */
.nav-value{font-size:44px;font-weight:700;color:#1E2329;letter-spacing:-1.5px;font-variant-numeric:tabular-nums}
.nav-caption{font-size:12px;color:#6B7280;margin-top:4px}
.exchange-breakdown{display:flex;gap:14px;margin-top:14px;flex-wrap:wrap}
.exchange-card{flex:1;min-width:160px;background:#F8F9FB;border:1px solid #E5E7EB;border-radius:12px;padding:14px 18px}
.exchange-card .label{font-size:12px;font-weight:500;color:#6B7280;margin-bottom:3px}
.exchange-card .value{font-size:20px;font-weight:700;color:#1E2329;font-variant-numeric:tabular-nums}
.exchange-card .pct{font-size:11px;color:#6B7280;margin-top:2px}
/* Metrics row */
.metrics-row{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:16px}
.metric-card{flex:1;min-width:140px;background:#F8F9FB;border:1px solid #E5E7EB;border-radius:12px;padding:14px 16px}
.metric-card .m-label{font-size:11px;font-weight:500;color:#6B7280;margin-bottom:5px}
.metric-card .m-value{font-size:22px;font-weight:700;color:#1E2329;font-variant-numeric:tabular-nums}
.metric-card .m-value.pos{color:#10B981}
.metric-card .m-value.neg{color:#EF4444}
/* Time range tabs */
.time-tabs{display:flex;gap:6px;justify-content:flex-end;margin-bottom:10px}
.time-tab{padding:4px 14px;border:1px solid #E0E0E0;background:#fff;color:#6B7280;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;transition:.2s;font-family:inherit}
.time-tab.active,.time-tab:hover{border-color:${THEME_COLOR};color:${THEME_COLOR};background:#EBF0FA}
.time-tab.active{background:${THEME_COLOR};color:#fff}
/* Period return badge */
.period-return{display:inline-block;font-size:13px;font-weight:600;padding:4px 12px;border-radius:6px;margin-bottom:8px}
/* Charts layout */
.charts-row{display:flex;gap:20px;flex-wrap:wrap}
.charts-row .card{flex:1;min-width:300px}
/* Table */
.holdings-table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:8px 10px;color:#6B7280;font-weight:500;border-bottom:2px solid #EAECEF;font-size:11px;white-space:nowrap}
td{padding:8px 10px;border-bottom:1px solid #F5F5F5;color:#1E2329;white-space:nowrap}
tr:hover td{background:#FAFAFA}
td.pos{color:#10B981}
td.neg{color:#EF4444}
.prog-bar{height:6px;background:#E5E7EB;border-radius:3px;margin-top:3px}
.prog-bar-fill{height:6px;background:${THEME_COLOR};border-radius:3px}
/* Monthly returns table */
.monthly-table th,.monthly-table td{padding:6px 8px;font-size:12px}
.monthly-table td.pos{background:#ECFDF5;color:#059669;font-weight:500}
.monthly-table td.neg{background:#FEF2F2;color:#DC2626;font-weight:500}
/* Tabs */
.tab-bar{display:flex;gap:0;border-bottom:2px solid #EAECEF;margin-bottom:16px}
.tab-btn{padding:8px 20px;border:none;background:none;font-size:13px;font-weight:500;color:#6B7280;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;font-family:inherit;transition:.2s}
.tab-btn.active{color:${THEME_COLOR};border-bottom-color:${THEME_COLOR}}
.tab-pane{display:none}
.tab-pane.active{display:block}
/* Liquidity badge */
.liquidity-badge{margin-top:14px;background:linear-gradient(135deg,#EBF5FF,#E0F2FE);padding:10px 14px;border-radius:10px;color:${THEME_COLOR};font-size:13px;text-align:center;font-weight:600;border:1px solid #BFDBFE}
/* Loading / error */
.loading{color:#6B7280;font-size:14px;text-align:center;padding:32px}
.error-msg{color:#EF4444;background:#FEF2F2;border:1px solid #FCA5A5;border-radius:8px;padding:12px 16px;font-size:13px;margin-bottom:12px}
.info-msg{color:#0047AB;background:#EBF0FA;border:1px solid #BFDBFE;border-radius:8px;padding:12px 16px;font-size:13px;margin-bottom:12px}
/* Spinner */
.spinner{display:inline-block;width:20px;height:20px;border:2px solid #E5E7EB;border-top-color:${THEME_COLOR};border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:8px}
@keyframes spin{to{transform:rotate(360deg)}}
/* Drawdown chart */
canvas{width:100%!important}
</style>
</head>
<body>

<!-- LOGIN SCREEN -->
<div id="login-screen">
  <div class="login-card">
    <h2>Fund Portal</h2>
    <p>Enter your access code to continue</p>
    <input type="password" id="pwd-input" placeholder="Access Code" autocomplete="current-password">
    <button onclick="doLogin()">Sign In</button>
    <div class="error" id="login-error"></div>
  </div>
</div>

<!-- APP SCREEN -->
<div id="app">
  <div class="topbar">
    <h1>10K Ventures</h1>
    <div class="btn-group">
      <button class="btn active" id="btn-all" onclick="selectExchange('All')">All</button>
      <button class="btn" id="btn-binance" onclick="selectExchange('Binance')">Binance</button>
      <button class="btn" id="btn-bybit" onclick="selectExchange('Bybit')">Bybit</button>
      <button class="btn btn-refresh" onclick="refreshAll()">⟳ Refresh</button>
    </div>
  </div>

  <!-- Errors -->
  <div id="errors-container"></div>

  <!-- Loading indicator -->
  <div id="loading-indicator" class="loading"><span class="spinner"></span>Connecting to exchanges…</div>

  <!-- NAV Hero -->
  <div class="card" id="nav-card" style="display:none">
    <div class="section-header">Total Net Asset Value</div>
    <div class="nav-value" id="nav-value-display">—</div>
    <div class="nav-caption" id="nav-caption"></div>
    <div class="exchange-breakdown" id="exchange-breakdown"></div>
  </div>

  <!-- LP Dashboard (All mode only) -->
  <div id="lp-dashboard" style="display:none">
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <div class="section-header" style="margin-bottom:0">NAV Curve</div>
        <div class="time-tabs">
          <button class="time-tab" onclick="selectTimeRange('24H')">24H</button>
          <button class="time-tab" onclick="selectTimeRange('7D')">7D</button>
          <button class="time-tab active" onclick="selectTimeRange('30D')">30D</button>
          <button class="time-tab" onclick="selectTimeRange('3M')">3M</button>
        </div>
      </div>
      <div id="period-return-badge" style="margin-top:10px"></div>
      <canvas id="nav-chart" height="120"></canvas>
    </div>

    <div class="card">
      <div class="section-header">历史表现</div>
      <div class="metrics-row" id="perf-metrics"></div>
      <div style="font-size:11px;color:#9CA3AF;margin-top:4px" id="tracking-info"></div>

      <div style="margin-top:16px">
        <div class="section-header" style="font-size:14px">近期趋势</div>
        <div class="metrics-row" id="trend-metrics"></div>
      </div>
    </div>

    <div class="card" id="monthly-card">
      <div class="section-header">Monthly Returns (%)</div>
      <div class="holdings-table-wrap" id="monthly-table-container"></div>
    </div>

    <div class="card" id="drawdown-card">
      <div class="section-header">Drawdown Curve</div>
      <div style="font-size:11px;color:#9CA3AF;margin-bottom:6px" id="drawdown-caption"></div>
      <canvas id="drawdown-chart" height="70"></canvas>
    </div>

    <div class="card" id="top-dd-card">
      <div class="section-header">Top 10 Worst Drawdowns</div>
      <div class="holdings-table-wrap" id="top-dd-table"></div>
    </div>
  </div>

  <!-- Charts (single exchange mode) -->
  <div id="charts-section" style="display:none">
    <div class="charts-row">
      <div class="card" style="min-width:300px">
        <div class="section-header">Asset Distribution</div>
        <canvas id="pie-chart" height="260"></canvas>
      </div>
      <div class="card" style="min-width:300px">
        <div class="section-header">Allocation Overview</div>
        <div id="allocation-list"></div>
      </div>
    </div>
  </div>

  <!-- Holdings Table -->
  <div class="card" id="holdings-card" style="display:none">
    <div class="section-header">Detailed Holdings</div>
    <div class="tab-bar" id="holdings-tabs"></div>
    <div id="holdings-panes"></div>
  </div>
</div>

<script>
// ============================================================
// State
// ============================================================
let state = {
  exchange: 'All',
  timeRange: '30D',
  navData: null,
  snapshotData: null,
  navChart: null,
  ddChart: null,
  pieChart: null,
};

const CHART_COLORS = [
  '#0047AB','#00D4AA','#6366F1','#F59E0B','#EF4444',
  '#8B5CF6','#EC4899','#14B8A6','#F97316','#6B7280',
];
const STABLECOINS = new Set(['USDT','USDC','DAI','FDUSD','BUSD']);

// ============================================================
// Login
// ============================================================
document.getElementById('pwd-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

async function doLogin() {
  const pwd = document.getElementById('pwd-input').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ password: pwd }),
    });
    const data = await res.json();
    if (data.ok) {
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('app').style.display = 'block';
      loadAll();
    } else {
      errEl.textContent = data.error || 'Invalid access code';
    }
  } catch(e) {
    errEl.textContent = 'Network error. Please try again.';
  }
}

// ============================================================
// Exchange / Time range selection
// ============================================================
function selectExchange(ex) {
  state.exchange = ex;
  ['All','Binance','Bybit'].forEach(e => {
    document.getElementById('btn-' + e.toLowerCase()).classList.toggle('active', e === ex);
  });
  renderData();
}

function selectTimeRange(tr) {
  state.timeRange = tr;
  document.querySelectorAll('.time-tab').forEach(el => {
    el.classList.toggle('active', el.textContent === tr);
  });
  renderNavChart();
}

function refreshAll() {
  state.navData = null;
  state.snapshotData = null;
  loadAll();
}

// ============================================================
// Data loading
// ============================================================
async function loadAll() {
  document.getElementById('loading-indicator').style.display = 'block';
  document.getElementById('nav-card').style.display = 'none';
  document.getElementById('holdings-card').style.display = 'none';
  document.getElementById('errors-container').innerHTML = '';

  try {
    const [navRes, snapRes] = await Promise.all([
      fetch('/api/nav').then(r => r.json()),
      fetch('/api/snapshots').then(r => r.json()),
    ]);
    state.navData = navRes;
    state.snapshotData = snapRes;

    // Auto-save snapshot if All mode and after 17:00 CST
    if (navRes.totalNAV > 0) {
      fetch('/api/snapshot', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ nav: navRes.totalNAV, perExchange: navRes.perExchange, perAccount: navRes.perAccount }),
      }).catch(() => {});

      // Trigger backfill if no history
      const snapCount = Object.keys(snapRes.snapshots || {}).length;
      if (snapCount < 3) {
        fetch('/api/backfill', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ currentNAV: navRes.totalNAV, perExchange: navRes.perExchange }),
        }).then(() => fetch('/api/snapshots').then(r => r.json()).then(d => {
          state.snapshotData = d;
          renderLPDashboard();
        })).catch(() => {});
      }
    }
  } catch(e) {
    showError('Failed to load data: ' + e.message);
  }

  document.getElementById('loading-indicator').style.display = 'none';
  renderData();
}

// ============================================================
// Rendering
// ============================================================
function renderData() {
  const navData = state.navData;
  if (!navData) return;

  const ex = state.exchange;
  const isUnified = ex === 'All';

  // Errors
  const errContainer = document.getElementById('errors-container');
  errContainer.innerHTML = '';
  for (const err of (navData.errors || [])) {
    errContainer.innerHTML += \`<div class="error-msg">⚠ \${err}</div>\`;
  }

  // Compute display NAV
  let displayNAV = 0;
  let assets = [];

  if (isUnified) {
    displayNAV = navData.totalNAV || 0;
    // Flatten all accounts into one asset list
    assets = Object.values(navData.accounts || {}).flatMap(d => d.assets || []);
  } else {
    // Single exchange: combine assets from accounts matching this exchange
    const matchingAccounts = Object.values(navData.accounts || {})
      .filter(d => (d.assets?.[0]?.exchange || '') === ex);
    assets = matchingAccounts.flatMap(d => d.assets || []);
    displayNAV = assets.reduce((s, a) => s + (a.navValue || 0), 0);
  }

  // Show NAV card
  const navCard = document.getElementById('nav-card');
  navCard.style.display = 'block';
  document.getElementById('nav-value-display').textContent = '$' + fmt(displayNAV);
  document.getElementById('nav-caption').textContent =
    \`Source: \${isUnified ? 'All Exchanges' : ex} | \${new Date().toLocaleTimeString()}\`;

  // Exchange + account breakdown
  const breakdownEl = document.getElementById('exchange-breakdown');
  if (isUnified && navData.perExchange) {
    // Exchange totals
    let html = Object.entries(navData.perExchange).map(([label, nav]) => {
      const pct = displayNAV > 0 ? (nav / displayNAV * 100).toFixed(1) : '0';
      return nav > 0
        ? \`<div class="exchange-card"><div class="label">\${label}</div>
            <div class="value">$\${fmt(nav)}</div>
            <div class="pct">\${pct}% of portfolio</div></div>\`
        : \`<div class="exchange-card" style="opacity:.5"><div class="label">\${label}</div>
            <div class="value" style="color:#9CA3AF">Unavailable</div>
            <div class="pct">—</div></div>\`;
    }).join('');
    breakdownEl.innerHTML = html;

    // Per-account sub-breakdown (smaller row below)
    if (navData.perAccount && Object.keys(navData.perAccount).length > 2) {
      const subHtml = Object.entries(navData.perAccount)
        .filter(([,v]) => v > 0)
        .map(([label, nav]) => {
          const pct = displayNAV > 0 ? (nav / displayNAV * 100).toFixed(1) : '0';
          return \`<div style="flex:1;min-width:140px;background:#F0F4FF;border:1px solid #DBEAFE;border-radius:10px;padding:10px 14px">
            <div style="font-size:11px;color:#6B7280;margin-bottom:2px">\${label}</div>
            <div style="font-size:16px;font-weight:700;color:#1E2329">$\${fmt(nav)}</div>
            <div style="font-size:11px;color:#6B7280">\${pct}%</div>
          </div>\`;
        }).join('');
      breakdownEl.innerHTML += \`<div style="flex-basis:100%;margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">\${subHtml}</div>\`;
    }
  } else {
    breakdownEl.innerHTML = '';
  }

  // LP Dashboard
  const lpDash = document.getElementById('lp-dashboard');
  if (isUnified) {
    lpDash.style.display = 'block';
    renderLPDashboard();
  } else {
    lpDash.style.display = 'none';
  }

  // Charts section (single exchange)
  const chartsSection = document.getElementById('charts-section');
  if (!isUnified && assets.length) {
    chartsSection.style.display = 'block';
    renderPieChart(assets, displayNAV);
    renderAllocationList(assets, displayNAV);
  } else {
    chartsSection.style.display = 'none';
  }

  // Holdings
  renderHoldings(assets, displayNAV, isUnified);
  document.getElementById('holdings-card').style.display = 'block';
}

// ============================================================
// LP Dashboard
// ============================================================
function renderLPDashboard() {
  const snap = state.snapshotData;
  const metrics = snap?.metrics;
  if (!metrics) {
    const snapCount = Object.keys(snap?.snapshots || {}).length;
    const msg = snapCount < 2
      ? 'No NAV history yet. Data will appear after 17:00 CST today.'
      : 'Accumulating data — metrics will appear after more daily snapshots.';
    document.getElementById('perf-metrics').innerHTML = \`<div class="info-msg">\${msg}</div>\`;
    return;
  }

  renderNavChart();
  renderPerfMetrics(metrics);
  renderMonthlyTable(metrics.monthlyReturns);
  renderTopDrawdowns(metrics.topDrawdowns);
  renderDrawdownChart(metrics.sortedDates, metrics.drawdownSeries);
}

function renderNavChart() {
  const snap = state.snapshotData;
  const metrics = snap?.metrics;
  if (!metrics) return;

  const navData = state.navData;
  const currentNAV = navData?.totalNAV || 0;

  // Filter by time range
  const daysMap = {'24H':1,'7D':7,'30D':30,'3M':90};
  const cutoffDays = daysMap[state.timeRange] || 30;
  const cutoff = new Date(Date.now() - cutoffDays * 86400000);

  // Build full date series (allDates + navs)
  const snapshots = snap.snapshots || {};
  const entries = Object.entries(snapshots).sort((a,b) => a[0].localeCompare(b[0]));

  let points = entries
    .map(([d, v]) => ({ date: new Date(d + 'T17:00:00+08:00'), nav: parseFloat(v.nav) }))
    .filter(p => p.date >= cutoff);

  // Append current live NAV
  if (currentNAV > 0) {
    const now = new Date();
    const last = points[points.length - 1];
    if (!last || (now - last.date) > 3600000) {
      points.push({ date: now, nav: currentNAV });
    }
  }

  if (points.length < 2) {
    document.getElementById('period-return-badge').innerHTML =
      '<span style="color:#6B7280;font-size:13px">Not enough data for this range</span>';
    return;
  }

  // Normalize to 1.0000
  const baseNav = points[0].nav;
  const normalized = points.map(p => p.nav / baseNav);
  const labels = points.map(p => p.date);

  const periodReturn = (points[points.length-1].nav / points[0].nav - 1) * 100;
  const sign = periodReturn >= 0 ? '+' : '';
  const color = periodReturn >= 0 ? '#10B981' : '#EF4444';
  document.getElementById('period-return-badge').innerHTML =
    \`<span class="period-return" style="color:\${color};background:\${color}15">\${sign}\${periodReturn.toFixed(2)}% (\${state.timeRange})</span>\`;

  const ctx = document.getElementById('nav-chart').getContext('2d');
  if (state.navChart) state.navChart.destroy();
  state.navChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: normalized,
        borderColor: '#0047AB',
        borderWidth: 2.5,
        backgroundColor: 'rgba(0,71,171,0.08)',
        fill: true,
        tension: 0.2,
        pointRadius: 0,
        pointHoverRadius: 4,
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            title: items => {
              const d = new Date(items[0].parsed.x);
              return d.toLocaleDateString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
            },
            label: item => 'NAV: ' + item.parsed.y.toFixed(4),
          }
        }
      },
      scales: {
        x: {
          type: 'time',
          time: { unit: cutoffDays <= 1 ? 'hour' : 'day', displayFormats: { hour:'HH:mm', day:'MM-DD' } },
          grid: { display: false },
          ticks: { color: '#848E9C', font: { size: 11 } },
        },
        y: {
          position: 'right',
          ticks: { color: '#848E9C', font: { size: 11 }, callback: v => v.toFixed(4) },
          grid: { color: '#F0F0F0' },
        }
      },
      interaction: { mode: 'index', intersect: false },
    }
  });
}

function renderPerfMetrics(m) {
  const cum = m.cumulativeReturn || 0;
  const ann = m.annReturn || 0;
  const sharpe = m.sharpe || 0;
  const sortino = m.sortino || 0;
  const mdd = m.maxDrawdown || 0;

  document.getElementById('perf-metrics').innerHTML = [
    metricCard('Cumulative Return', fmtPct(cum, 3), cum >= 0),
    metricCard('Ann. Return', fmtPct(ann, 2), ann >= 0),
    metricCard('Sharpe', sharpe ? sharpe.toFixed(2) : '—', sharpe >= 0),
    metricCard('Sortino', sortino ? sortino.toFixed(1) : '—', sortino >= 0),
    metricCard('Max Drawdown', mdd ? mdd.toFixed(4)+'%' : '—', mdd >= 0),
  ].join('');

  const r7 = m.annual7d;
  const r30 = m.annual30d;
  document.getElementById('trend-metrics').innerHTML = [
    metricCard('Ann. 7D', r7 != null ? fmtPct(r7, 2) : '—', (r7||0) >= 0),
    metricCard('Ann. 30D', r30 != null ? fmtPct(r30, 2) : '—', (r30||0) >= 0),
  ].join('');

  document.getElementById('tracking-info').textContent =
    \`Last: \${m.latestDate || '—'} · \${m.snapshots || 0} snapshots · Tracking \${m.days || 0} days\`;
}

function metricCard(label, value, isPos) {
  const cls = value === '—' ? '' : (isPos ? 'pos' : 'neg');
  return \`<div class="metric-card"><div class="m-label">\${label}</div>
    <div class="m-value \${cls}">\${value}</div></div>\`;
}

function renderMonthlyTable(monthlyReturns) {
  if (!monthlyReturns || !Object.keys(monthlyReturns).length) return;
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const years = {};
  for (const [ym, ret] of Object.entries(monthlyReturns)) {
    const [y, m] = ym.split('-');
    if (!years[y]) years[y] = {};
    years[y][parseInt(m)-1] = ret;
  }
  let html = '<table class="monthly-table"><thead><tr><th>Year</th>';
  for (const m of months) html += \`<th>\${m}</th>\`;
  html += '</tr></thead><tbody>';
  for (const year of Object.keys(years).sort()) {
    html += \`<tr><td>\${year}</td>\`;
    for (let i = 0; i < 12; i++) {
      const v = years[year][i];
      if (v == null) { html += '<td>—</td>'; continue; }
      const cls = v >= 0 ? 'pos' : 'neg';
      html += \`<td class="\${cls}">\${v >= 0 ? '+' : ''}\${v.toFixed(3)}</td>\`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  document.getElementById('monthly-table-container').innerHTML = html;
}

function renderTopDrawdowns(topDDs) {
  if (!topDDs?.length) { document.getElementById('top-dd-card').style.display='none'; return; }
  document.getElementById('top-dd-card').style.display = 'block';
  let html = '<div class="holdings-table-wrap"><table><thead><tr>'
    + '<th>Started</th><th>Recovered</th><th>Drawdown</th><th>Days</th></tr></thead><tbody>';
  for (const dd of topDDs) {
    html += \`<tr><td>\${dd.started}</td><td>\${dd.recovered}</td>
      <td class="neg">\${dd.drawdown.toFixed(4)}%</td><td>\${dd.days}</td></tr>\`;
  }
  html += '</tbody></table></div>';
  document.getElementById('top-dd-table').innerHTML = html;
}

function renderDrawdownChart(dates, series) {
  if (!dates?.length || !series?.length) return;
  const snap = state.snapshotData;
  const stratDate = snap?.metrics?.sortedDates?.[0] || '2026-03-22';
  document.getElementById('drawdown-caption').textContent =
    \`回撤/风险指标自 \${stratDate} 起算（建仓期已完成）\`;

  const ctx = document.getElementById('drawdown-chart').getContext('2d');
  if (state.ddChart) state.ddChart.destroy();
  state.ddChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: dates,
      datasets: [{
        data: series,
        borderColor: '#EF4444',
        borderWidth: 1.8,
        backgroundColor: 'rgba(239,68,68,0.10)',
        fill: true,
        tension: 0.2,
        pointRadius: 0,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: i => 'Drawdown: ' + i.parsed.y.toFixed(4) + '%' } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#848E9C', font: { size: 10 } } },
        y: { grid: { color: '#F5F5F5' }, ticks: { color: '#848E9C', font: { size: 10 }, callback: v => v.toFixed(3)+'%' } },
      },
    }
  });
}

// ============================================================
// Pie chart + allocation list
// ============================================================
function renderPieChart(assets, totalNAV) {
  const spotAssets = assets.filter(a => a.positionType === 'Spot');
  const grouped = {};
  for (const a of spotAssets) {
    grouped[a.asset] = (grouped[a.asset] || 0) + (a.value || 0);
  }
  const sorted = Object.entries(grouped).sort((a,b) => b[1]-a[1]);
  const major = sorted.filter(([,v]) => v / totalNAV >= 0.002);
  const othersVal = sorted.filter(([,v]) => v / totalNAV < 0.002).reduce((s,[,v]) => s+v, 0);
  const data = othersVal > 0 ? [...major, ['Others', othersVal]] : major;

  const ctx = document.getElementById('pie-chart').getContext('2d');
  if (state.pieChart) state.pieChart.destroy();
  state.pieChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: data.map(d => d[0]),
      datasets: [{ data: data.map(d => d[1]), backgroundColor: CHART_COLORS, borderWidth: 2, borderColor: '#fff' }]
    },
    options: {
      cutout: '70%',
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 }, boxWidth: 12 } },
        tooltip: { callbacks: { label: i => \` \${i.label}: $\${fmt(i.parsed)} (\${(i.parsed/totalNAV*100).toFixed(1)}%)\` } }
      }
    }
  });
}

function renderAllocationList(assets, totalNAV) {
  const spotAssets = assets.filter(a => a.positionType === 'Spot');
  const grouped = {};
  for (const a of spotAssets) {
    if (!grouped[a.asset]) grouped[a.asset] = { value: 0, amount: 0 };
    grouped[a.asset].value += a.value || 0;
    grouped[a.asset].amount += a.amount || 0;
  }
  const sorted = Object.entries(grouped).sort((a,b) => b[1].value - a[1].value).slice(0,8);
  let html = '';
  sorted.forEach(([asset, d], i) => {
    const pct = totalNAV > 0 ? d.value / totalNAV * 100 : 0;
    const price = d.amount > 0 ? d.value / d.amount : 0;
    const dot = CHART_COLORS[i % CHART_COLORS.length];
    html += \`<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #F0F0F0">
      <span style="color:\${dot};font-size:10px">●</span>
      <span style="font-weight:600;min-width:60px">\${asset}</span>
      <span style="color:#9FA2B4;font-size:12px">(\${pct.toFixed(1)}%)</span>
      <span style="margin-left:auto;font-size:13px">$\${fmt(d.value)}</span>
      <span style="color:#6B7280;font-size:12px;min-width:80px;text-align:right">$\${price < 10 ? price.toFixed(4) : fmt(price)}</span>
    </div>\`;
  });

  // Liquidity reserve
  const cashVal = assets
    .filter(a => a.positionType === 'Spot' && STABLECOINS.has(a.asset))
    .reduce((s, a) => s + (a.value || 0), 0);
  const cashRatio = totalNAV > 0 ? cashVal / totalNAV * 100 : 0;
  html += \`<div class="liquidity-badge">Liquidity Reserve: \${cashRatio.toFixed(1)}%</div>\`;

  document.getElementById('allocation-list').innerHTML = html;
}

// ============================================================
// Holdings table
// ============================================================
function renderHoldings(assets, totalNAV, isUnified) {
  const tabBar = document.getElementById('holdings-tabs');
  const panesEl = document.getElementById('holdings-panes');
  const navData = state.navData;

  if (isUnified) {
    // Build tabs: Combined + Binance + Bybit + each account
    const accountLabels = Object.keys(navData.accounts || {});
    let tabs = \`<button class="tab-btn active" onclick="switchTab('combined')">Combined</button>
      <button class="tab-btn" onclick="switchTab('binance-all')">Binance</button>
      <button class="tab-btn" onclick="switchTab('bybit-all')">Bybit</button>\`;
    accountLabels.forEach((lbl, i) => {
      const id = 'acct-' + i;
      tabs += \`<button class="tab-btn" onclick="switchTab('\${id}')">\${lbl}</button>\`;
    });
    tabBar.innerHTML = tabs;

    let panes = \`<div class="tab-pane active" id="tab-combined">\${holdingsTable(assets, totalNAV, true)}</div>
      <div class="tab-pane" id="tab-binance-all">\${holdingsTable(assets.filter(a=>a.exchange==='Binance'), totalNAV, true)}</div>
      <div class="tab-pane" id="tab-bybit-all">\${holdingsTable(assets.filter(a=>a.exchange==='Bybit'), totalNAV, true)}</div>\`;
    accountLabels.forEach((lbl, i) => {
      const acctAssets = (navData.accounts[lbl]?.assets || []);
      panes += \`<div class="tab-pane" id="tab-acct-\${i}">\${holdingsTable(acctAssets, totalNAV, false)}</div>\`;
    });
    panesEl.innerHTML = panes;
  } else {
    tabBar.innerHTML = '';
    panesEl.innerHTML = \`<div class="tab-pane active">\${holdingsTable(assets, totalNAV, false)}</div>\`;
  }
}

function switchTab(id) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('onclick').includes(id));
  });
  document.querySelectorAll('.tab-pane').forEach(p => {
    p.classList.toggle('active', p.id === 'tab-' + id);
  });
}

function holdingsTable(assets, totalNAV, showExchange) {
  if (!assets.length) return '<div class="info-msg">No holdings found.</div>';
  const sorted = [...assets].sort((a,b) => (b.notional||0) - (a.notional||0));
  let html = '<div class="holdings-table-wrap"><table><thead><tr>';
  if (showExchange) html += '<th>Exchange</th>';
  html += '<th>Asset</th><th>Type</th><th>Direction</th><th>Amount</th><th>Price</th><th>Notional</th><th>Unrealized PnL</th><th>Portfolio %</th></tr></thead><tbody>';

  for (const a of sorted) {
    const pct = totalNAV > 0 ? (a.notional || 0) / totalNAV * 100 : 0;
    const pnlVal = a.pnl != null ? a.pnl : 0;
    const pnlCls = pnlVal >= 0 ? 'pos' : 'neg';
    const pnlStr = a.pnl != null ? (pnlVal >= 0 ? '+' : '') + '$' + fmt(pnlVal) : '—';
    html += '<tr>';
    if (showExchange) html += \`<td>\${a.exchange||'—'}</td>\`;
    html += \`<td><strong>\${a.asset}</strong></td>
      <td>\${a.positionType||'Spot'}</td>
      <td>\${a.direction||'—'}</td>
      <td>\${fmtAmt(a.amount)}</td>
      <td>$\${a.price < 10 ? (a.price||0).toFixed(4) : fmt(a.price)}</td>
      <td>$\${fmt(a.notional)}</td>
      <td class="\${pnlCls}">\${pnlStr}</td>
      <td><div>\${pct.toFixed(2)}%</div><div class="prog-bar"><div class="prog-bar-fill" style="width:\${Math.min(pct,100)}%"></div></div></td>
    </tr>\`;
  }
  html += '</tbody></table></div>';
  return html;
}

// ============================================================
// Formatters
// ============================================================
function fmt(n) {
  if (n == null || isNaN(n)) return '0';
  return Math.abs(n) >= 1000
    ? n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
    : n.toFixed(2);
}
function fmtAmt(n) {
  if (n == null || isNaN(n)) return '0';
  return n >= 1000 ? n.toLocaleString('en-US',{maximumFractionDigits:2}) : n.toFixed(4);
}
function fmtPct(n, decimals=2) {
  const sign = n >= 0 ? '+' : '';
  return sign + n.toFixed(decimals) + '%';
}

function showError(msg) {
  document.getElementById('errors-container').innerHTML += \`<div class="error-msg">⚠ \${msg}</div>\`;
}

// Chart.js date adapter (use native Date objects as labels)
// We need the luxon or date-fns adapter for 'time' scale — load it
</script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requireAuth(request, env) {
  // Check session cookie
  if (verifySessionToken(request, env)) return null;
  return json({ error: 'Unauthorized' }, 401);
}

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Public routes
    if (path === '/') {
      return new Response(renderHTML(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (path === '/api/login' && method === 'POST') {
      return handleLogin(request, env);
    }

    // Protected routes
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    if (path === '/api/nav' && method === 'GET') {
      return handleNAV(env);
    }

    if (path === '/api/snapshots' && method === 'GET') {
      return handleSnapshots(env);
    }

    if (path === '/api/snapshot' && method === 'POST') {
      return handleSaveSnapshot(request, env);
    }

    if (path === '/api/backfill' && method === 'POST') {
      return handleBackfill(request, env);
    }

    if (path === '/api/diag' && method === 'GET') {
      return handleDiag(env);
    }

    return new Response('Not Found', { status: 404 });
  },
};
