// Vercel Serverless Function: /api/fundamentals/[symbol]
// Handles US (stockanalysis.com), India/UAE (Yahoo Finance quoteSummary)

import https from "node:https";
import zlib from "node:zlib";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── HTTP helper (raw Node https for cookie handling) ─────────────────────────
function httpsGet(options) {
  return new Promise((resolve, reject) => {
    const req = https.request({ ...options, maxHeaderSize: 512 * 1024 }, res => {
      const rawCookies = res.headers["set-cookie"] ?? [];
      const chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => {
        let buf = Buffer.concat(chunks);
        const enc = res.headers["content-encoding"];
        try {
          if (enc === "gzip" || enc === "x-gzip") buf = zlib.gunzipSync(buf);
          else if (enc === "br") buf = zlib.brotliDecompressSync(buf);
        } catch { /* raw */ }
        resolve({ status: res.statusCode ?? 0, rawCookies, body: buf.toString("utf8") });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(20000, () => req.destroy(new Error("TIMEOUT")));
    req.end();
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Yahoo Finance Crumb Auth ─────────────────────────────────────────────────
async function fetchYahooCrumb() {
  const cookieRes = await httpsGet({
    hostname: "finance.yahoo.com",
    path: "/quote/SPY/",
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, br",
    },
  });
  const cookie = cookieRes.rawCookies.map(c => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("No cookies from Yahoo Finance");

  await delay(1500);

  // Try query1 first (different rate limit bucket)
  for (const hostname of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    const res = await httpsGet({
      hostname,
      path: "/v1/test/getcrumb",
      headers: { "User-Agent": UA, Accept: "text/plain, */*", Cookie: cookie, Referer: "https://finance.yahoo.com/" },
    });
    if (res.status === 200 && res.body.trim().length >= 4) {
      return { crumb: res.body.trim(), cookie };
    }
    if (hostname === "query1.finance.yahoo.com") await delay(1000);
  }
  throw new Error("Could not obtain Yahoo Finance crumb");
}

async function yahooQuoteSummary(symbol, modules) {
  const { crumb, cookie } = await fetchYahooCrumb();
  const mod = modules.join(",");
  const res = await httpsGet({
    hostname: "query2.finance.yahoo.com",
    path: `/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${encodeURIComponent(mod)}&crumb=${encodeURIComponent(crumb)}&formatted=false`,
    headers: { "User-Agent": UA, Accept: "application/json", Cookie: cookie, Referer: "https://finance.yahoo.com/" },
  });
  if (res.status === 429) throw new Error("RATE_LIMITED");
  if (res.status >= 400) throw new Error(`HTTP_${res.status}`);
  const data = JSON.parse(res.body);
  const qs = data.quoteSummary;
  if (qs?.error) throw new Error(`Yahoo API error: ${JSON.stringify(qs.error)}`);
  const row = qs?.result?.[0];
  if (!row) throw new Error(`Empty result for ${symbol}`);
  return row;
}

// ── stockanalysis.com scraper (US stocks) ────────────────────────────────────
async function fetchSaPage(slug) {
  try {
    const res = await httpsGet({
      hostname: "stockanalysis.com",
      path: `/stocks/${slug}/__data.json?x-sveltekit-invalidated=001`,
      headers: { "User-Agent": UA, Accept: "application/json, */*", "Accept-Encoding": "gzip, br", "Accept-Language": "en-US,en;q=0.9" },
    });
    if (res.status >= 400) return null;
    const json = JSON.parse(res.body);
    if (json.type !== "data" || !Array.isArray(json.nodes)) return null;
    const node = json.nodes.find(n => n.type === "data" && Array.isArray(n.data));
    if (!node?.data) return null;
    const data = node.data;
    const top = data[0];
    if (typeof top !== "object" || !top) return null;
    return { data, top };
  } catch { return null; }
}

function saNum(page, field) {
  const idx = page.top[field];
  if (idx === undefined) return null;
  const v = page.data[idx];
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") { const n = parseFloat(v.replace(/[^0-9.-]/g, "")); return isFinite(n) ? n : null; }
  return null;
}

function saFinVal(data, fdMap, field, period = 0) {
  const arrIdx = fdMap[field];
  if (arrIdx === undefined) return null;
  const arr = data[arrIdx];
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const valIdx = arr[period];
  const val = data[valIdx];
  if (typeof val === "number" && isFinite(val)) return val;
  if (typeof val === "string") { const n = parseFloat(val.replace(/[^0-9.-]/g, "")); return isFinite(n) ? n : null; }
  return null;
}

function saField(page, field) {
  const idx = page.top[field];
  if (idx === undefined) return null;
  return page.data[idx];
}

// ── Finviz: EPS Growth Rate ─────────────────────────────────────────────────
async function fetchFinvizEpsGrowth(symbol) {
  if (/\.(NS|BO|DU|AE)$/i.test(symbol)) return null;
  try {
    // Step 1: visit homepage to get cookies (helps bypass Cloudflare)
    const baseHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, br",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Cache-Control": "max-age=0",
    };
    const homeRes = await httpsGet({
      hostname: "finviz.com",
      path: "/",
      headers: baseHeaders,
    });
    const cookie = homeRes.rawCookies.map(c => c.split(";")[0]).join("; ");
    await delay(800);

    // Step 2: fetch the stock page with the cookie
    const res = await httpsGet({
      hostname: "finviz.com",
      path: `/quote.ashx?t=${encodeURIComponent(symbol.toUpperCase())}&p=d`,
      headers: {
        ...baseHeaders,
        Referer: "https://finviz.com/",
        "Sec-Fetch-Site": "same-origin",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    if (res.status !== 200) return null;
    const html = res.body;
    // Bail if Cloudflare served a challenge page (no stock data)
    if (!html.includes("EPS next 5Y") && !html.includes("EPS next Y")) return null;

    // Tight regex: label</td> <td><b>[<span>]VALUE%
    function finvizPct(label) {
      const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(esc + "<\/td>\\s*<td[^>]*>\\s*<b>\\s*(?:<span[^>]*>\\s*)?([-\\d.]+)%");
      const m = html.match(re);
      return m ? (isFinite(+m[1]) ? +m[1] : null) : null;
    }
    // Loose fallback: find label, grab nearest % value within 200 chars
    function finvizLoose(label) {
      const idx = html.indexOf(label);
      if (idx === -1) return null;
      const m = html.slice(idx, idx + 200).match(/([-\d.]+)%/);
      return m ? (isFinite(+m[1]) ? +m[1] : null) : null;
    }

    // Priority 1: Finviz “EPS next 5Y”
    const next5Y = finvizPct("EPS next 5Y") ?? finvizLoose("EPS next 5Y");
    if (next5Y !== null) return next5Y;

    // Priority 2: Finviz “EPS next Y” %
    const nextY = finvizPct("EPS next Y") ?? finvizLoose("EPS next Y");
    if (nextY !== null) return nextY;

    return null;
  } catch { return null; }
}

// ── Yahoo Finance: EPS Growth from earningsTrend (fallback for all stocks) ──
async function fetchYahooEpsGrowth(symbol) {
  try {
    const result = await yahooQuoteSummary(symbol, ["earningsTrend"]);
    const et = result.earningsTrend;
    if (!et?.trend?.length) return null;
    // Priority: 5Y estimate → Next Year → Current Year
    const priority = ["5y", "+1y", "0y"];
    for (const period of priority) {
      const entry = et.trend.find(t => t.period === period);
      if (entry?.growth !== undefined) {
        const g = raw(entry.growth);
        if (g !== null && isFinite(g)) return +(g * 100).toFixed(2);
      }
    }
    return null;
  } catch { return null; }
}

// ── Yahoo Finance result builder ─────────────────────────────────────────────
function raw(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  return v.raw ?? null;
}
function str(v) {
  if (!v) return null;
  if (typeof v === "string") return v;
  return v.raw ?? null;
}

function buildResultFromYahoo(symbol, result) {
  const ks = result.defaultKeyStatistics ?? {};
  const fd = result.financialData ?? {};
  const sd = result.summaryDetail ?? {};
  const pr = result.price ?? {};
  const eps = raw(ks.trailingEps);
  const pe = raw(sd.trailingPE) ?? raw(sd.forwardPE);
  const pegRaw = raw(ks.pegRatio);
  const peg = pegRaw && pegRaw !== 0 ? pegRaw : null;
  const operatingCashFlow = raw(fd.operatingCashflow);
  const totalDebt = raw(fd.totalDebt);
  const totalCash = raw(fd.totalCash);
  const ebitda = raw(fd.ebitda);
  const price = raw(pr.regularMarketPrice);
  const sharesOutstanding = raw(ks.sharesOutstanding) ?? raw(pr.sharesOutstanding);
  const bookValue = raw(ks.bookValue);

  let ebit = raw(fd.ebit);
  if (ebit === null) {
    const revenue = raw(fd.totalRevenue);
    const opMargin = raw(fd.operatingMargins);
    const ebitdaMargin = raw(fd.ebitdaMargins);
    if (revenue !== null && opMargin !== null) {
      const computed = revenue * opMargin;
      if (ebitda !== null && ebitdaMargin && ebitdaMargin > 0) {
        ebit = ebitda * (opMargin / ebitdaMargin);
        if (ebit > ebitda) ebit = computed < ebitda ? computed : ebitda * 0.92;
      } else ebit = ebitda !== null ? Math.min(computed, ebitda) : computed;
    } else if (ebitda !== null) ebit = ebitda * 0.88;
  }

  let epsGrowthRate = null;
  const et = result.earningsTrend;
  if (et?.trend?.length) {
    const entry = et.trend.find(t => t.period === "+1y") ?? et.trend.find(t => t.period === "0y");
    if (entry?.growth !== undefined) { const g = raw(entry.growth); if (g !== null) epsGrowthRate = g * 100; }
  }

  let netDebtEquity = null;
  if (totalDebt !== null && totalCash !== null && bookValue !== null && sharesOutstanding) {
    const equity = bookValue * sharesOutstanding;
    if (equity !== 0) netDebtEquity = (totalDebt - totalCash) / equity;
  }
  if (netDebtEquity === null) {
    const de = raw(fd.debtToEquity);
    if (de !== null && totalDebt !== null && totalCash !== null && de > 0) {
      const equity = totalDebt / (de / 100);
      netDebtEquity = (totalDebt - totalCash) / equity;
    } else if (de !== null) netDebtEquity = de / 100;
  }

  const operatingProfitToCash = (ebit !== null && operatingCashFlow && operatingCashFlow !== 0)
    ? ebit / operatingCashFlow : null;
  const epsG = epsGrowthRate;
  const companyName = str(pr.longName) ?? str(pr.shortName) ?? symbol;
  const currency = str(pr.currency) ?? str(fd.financialCurrency) ?? "USD";
  const peg2 = peg ?? ((pe !== null && epsG && epsG > 0) ? pe / epsG : null);

  return { symbol, companyName, currency, price, eps, pe, epsGrowthRate: epsG, peg: peg2, operatingCashFlow, netDebtEquity, operatingProfitToCash, ebit, ebitda };
}

// ── fetchViaStockAnalysis (US only) ─────────────────────────────────────────
async function fetchViaStockAnalysis(symbol) {
  if (/\.(NS|BO|DU|AE)$/i.test(symbol)) return null;
  const slug = symbol.toLowerCase();
  const [overview, income, cashflow, balance, finvizGrowth] = await Promise.all([
    fetchSaPage(slug),
    fetchSaPage(`${slug}/financials`),
    fetchSaPage(`${slug}/financials/cash-flow-statement`),
    fetchSaPage(`${slug}/financials/balance-sheet`),
    fetchFinvizEpsGrowth(symbol),
  ]);
  if (!overview) return null;

  const eps = saNum(overview, "eps");
  const peStrRaw = saField(overview, "peRatio");
  const pe = typeof peStrRaw === "string" ? (parseFloat(peStrRaw) || null) : (typeof peStrRaw === "number" ? peStrRaw : null);
  let epsGrowthRate = finvizGrowth;

  const peg = (pe !== null && epsGrowthRate !== null && epsGrowthRate > 0) ? pe / epsGrowthRate : null;

  let price = null;
  const targetStr = saField(overview, "target");
  if (typeof targetStr === "string") {
    const m = targetStr.match(/^([\d.]+)\s*\(([+-]?[\d.]+)%\)/);
    if (m) { const tp = parseFloat(m[1]); const pct = parseFloat(m[2]); if (isFinite(tp) && isFinite(pct)) price = tp / (1 + pct / 100); }
  }
  if (!price || price <= 0) price = (pe !== null && eps !== null) ? pe * eps : null;

  let ebitda = null, ebit = null, operatingCashFlow = null, totalCash = null, totalDebt = null, equity = null;

  if (income) {
    const fdMap = income.data[income.top.financialData] ?? {};
    ebitda = saFinVal(income.data, fdMap, "ebitda");
    ebit = saFinVal(income.data, fdMap, "ebit") ?? saFinVal(income.data, fdMap, "operatingIncome");
  }
  if (cashflow) {
    const fdMap = cashflow.data[cashflow.top.financialData] ?? {};
    operatingCashFlow = saFinVal(cashflow.data, fdMap, "ncfo");
  }
  if (balance) {
    const fdMap = balance.data[balance.top.financialData] ?? {};
    totalCash = saFinVal(balance.data, fdMap, "totalcash");
    totalDebt = saFinVal(balance.data, fdMap, "debt");
    equity = saFinVal(balance.data, fdMap, "equity");
  }

  const netDebtEquity = (totalDebt !== null && totalCash !== null && equity !== null && equity !== 0)
    ? (totalDebt - totalCash) / equity : null;
  const operatingProfitToCash = (ebit !== null && operatingCashFlow && operatingCashFlow !== 0)
    ? ebit / operatingCashFlow : null;

  // Company name from description
  let companyName = symbol;
  const desc = saField(overview, "description");
  if (typeof desc === "string" && desc.length > 10) {
    const match = desc.match(/^([A-Z][^.]{3,80}?)\s+(?:engages|is a|is an|provides|operates|manufactures|designs|offers|develops|conducts|focuses|serves|manages)\b/i);
    if (match) companyName = match[1].trim();
    else { const clause = desc.split(/[,.]/)[0]; if (clause && clause.length < 80) companyName = clause.trim(); }
  }

  return { symbol, companyName, currency: "USD", price, eps, pe, epsGrowthRate, peg, operatingCashFlow, netDebtEquity, operatingProfitToCash, ebit, ebitda };
}

// ── fetchViaCrumb (India/UAE) ────────────────────────────────────────────────
async function fetchViaCrumb(symbol) {
  const modules = ["defaultKeyStatistics", "financialData", "summaryDetail", "price", "earningsTrend"];
  const result = await yahooQuoteSummary(symbol, modules);
  return buildResultFromYahoo(symbol, result);
}

// ── Live price via Spark ─────────────────────────────────────────────────────
async function fetchLivePrice(symbol) {
  try {
    const res = await httpsGet({
      hostname: "query1.finance.yahoo.com",
      path: `/v8/finance/spark?symbols=${encodeURIComponent(symbol)}&range=1d&interval=5m`,
      headers: { "User-Agent": UA },
    });
    if (res.status !== 200) return null;
    const json = JSON.parse(res.body);
    const entry = json[symbol];
    if (!entry) return null;
    const closes = entry.close ?? [];
    const p = closes.length > 0 ? closes[closes.length - 1] : (entry.previousClose ?? null);
    return typeof p === "number" && p > 0 ? p : null;
  } catch { return null; }
}

// ── Main orchestrator ────────────────────────────────────────────────────────
async function fetchFundamentals(symbol) {
  const isInternational = /\.(NS|BO|DU|AE)$/i.test(symbol);
  if (!isInternational) {
    const saResult = await fetchViaStockAnalysis(symbol);
    if (saResult) {
      // EPS Growth fallback chain: Finviz 5Y → Finviz Next Y → Yahoo earningsTrend
      if (saResult.epsGrowthRate === null) {
        console.log(`[${symbol}] Finviz blocked or returned null — trying Yahoo earningsTrend`);
        const yahooGrowth = await fetchYahooEpsGrowth(symbol);
        if (yahooGrowth !== null) {
          saResult.epsGrowthRate = yahooGrowth;
          // Recalculate PEG with the newly found growth rate
          if (saResult.pe !== null && yahooGrowth > 0) {
            saResult.peg = +(saResult.pe / yahooGrowth).toFixed(2);
          }
        }
      }
      return saResult;
    }
    // Full Yahoo fallback for unknown US tickers
    try { return await fetchViaCrumb(symbol); } catch { return null; }
  }
  // International: Yahoo quoteSummary + live price
  const [crumbResult, livePrice] = await Promise.allSettled([
    fetchViaCrumb(symbol),
    fetchLivePrice(symbol),
  ]);
  const data = crumbResult.status === "fulfilled" ? crumbResult.value : null;
  if (!data) {
    if (crumbResult.status === "rejected") throw crumbResult.reason;
    return null;
  }
  if (livePrice.status === "fulfilled" && livePrice.value) {
    data.price = livePrice.value;
  }
  return data;
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const symbol = (req.query.symbol ?? "").trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: "Symbol is required" });

  try {
    const data = await fetchFundamentals(symbol);
    if (!data) {
      return res.status(404).json({ error: `No data found for ${symbol}. Check ticker and add .NS for NSE, .DU for DFM, .AE for ADX.` });
    }
    return res.status(200).json(data);
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (msg === "RATE_LIMITED" || msg.includes("rate-limit") || msg.includes("429")) {
      return res.status(503).json({ error: "Data provider rate-limited. Please try again in a minute." });
    }
    if (msg === "TIMEOUT") return res.status(504).json({ error: "Request timed out. Please try again." });
    console.error("Fundamentals error:", symbol, msg);
    return res.status(500).json({ error: `Could not fetch data for ${symbol}.` });
  }
}
