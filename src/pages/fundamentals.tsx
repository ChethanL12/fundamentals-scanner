import { useState, useEffect, useRef, FormEvent } from "react";

type Market = "us" | "india" | "uae";
type UAEExchange = "dfm" | "adx";

interface FundamentalsResult {
  symbol: string;
  companyName: string;
  currency: string;
  price: number | null;
  eps: number | null;
  pe: number | null;
  epsGrowthRate: number | null;
  peg: number | null;
  operatingCashFlow: number | null;
  netDebtEquity: number | null;
  operatingProfitToCash: number | null;
  ebit: number | null;
  ebitda: number | null;
}

interface StockEntry {
  symbol: string;
  status: "loading" | "done" | "error";
  data: FundamentalsResult | null;
  error: string | null;
}

const API_BASE = "/api";

function formatNumber(
  val: number | null,
  opts?: { prefix?: string; suffix?: string; decimals?: number; isLarge?: boolean }
): string {
  if (val === null || val === undefined || isNaN(val)) return "—";
  const { prefix = "", suffix = "", decimals = 2, isLarge = false } = opts ?? {};
  if (isLarge) {
    const abs = Math.abs(val);
    const sign = val < 0 ? "-" : "";
    if (abs >= 1e12) return `${sign}${prefix}${(abs / 1e12).toFixed(decimals)}T${suffix}`;
    if (abs >= 1e9) return `${sign}${prefix}${(abs / 1e9).toFixed(decimals)}B${suffix}`;
    if (abs >= 1e6) return `${sign}${prefix}${(abs / 1e6).toFixed(decimals)}M${suffix}`;
    return `${sign}${prefix}${abs.toFixed(decimals)}${suffix}`;
  }
  return `${prefix}${val.toFixed(decimals)}${suffix}`;
}

function getColorClass(val: number | null, positiveIsGood = true): string {
  if (val === null) return "text-gray-500";
  if (positiveIsGood) return val >= 0 ? "text-emerald-400" : "text-red-400";
  return val <= 0 ? "text-emerald-400" : "text-red-400";
}

function currSym(currency: string) {
  return currency === "INR" ? "₹" : currency === "AED" ? "د.إ" : "$";
}

const METRICS: {
  key: keyof FundamentalsResult;
  label: string;
  description: string;
  format: (v: number | null, currency: string) => string;
  colorFn: (v: number | null) => string;
}[] = [
  {
    key: "eps",
    label: "EPS",
    description: "Earnings Per Share (TTM)",
    format: (v, c) => formatNumber(v, { prefix: currSym(c), decimals: 2 }),
    colorFn: (v) => getColorClass(v, true),
  },
  {
    key: "pe",
    label: "P/E",
    description: "Price-to-Earnings (trailing)",
    format: (v) => formatNumber(v, { decimals: 2, suffix: "x" }),
    colorFn: () => "text-sky-300",
  },
  {
    key: "epsGrowthRate",
    label: "EPS Growth (5Y)",
    description: "Next year EPS growth estimate (Yahoo Finance Analysis → Growth Estimates)",
    format: (v) => formatNumber(v, { decimals: 2, suffix: "%" }),
    colorFn: (v) => getColorClass(v, true),
  },
  {
    key: "peg",
    label: "PEG",
    description: "Price/Earnings-to-Growth",
    format: (v) => formatNumber(v, { decimals: 2 }),
    colorFn: (v) => {
      if (v === null) return "text-gray-500";
      if (v < 1) return "text-emerald-400";
      if (v < 2) return "text-yellow-400";
      return "text-red-400";
    },
  },
  {
    key: "operatingCashFlow",
    label: "Op. Cash Flow",
    description: "Annual operating cash flow",
    format: (v, c) => formatNumber(v, { prefix: currSym(c), isLarge: true, decimals: 2 }),
    colorFn: (v) => getColorClass(v, true),
  },
  {
    key: "netDebtEquity",
    label: "Net Debt/Eq",
    description: "Net debt ÷ shareholders' equity",
    format: (v) => formatNumber(v, { decimals: 2, suffix: "x" }),
    colorFn: (v) => getColorClass(v, false),
  },
  {
    key: "operatingProfitToCash",
    label: "Op Profit/Cash",
    description: "EBIT ÷ Operating Cash Flow",
    format: (v) => formatNumber(v, { decimals: 2, suffix: "x" }),
    colorFn: (v) => getColorClass(v, true),
  },
  {
    key: "ebit",
    label: "EBIT",
    description: "Earnings Before Interest & Taxes",
    format: (v, c) => formatNumber(v, { prefix: currSym(c), isLarge: true, decimals: 2 }),
    colorFn: (v) => getColorClass(v, true),
  },
  {
    key: "ebitda",
    label: "EBITDA",
    description: "Earnings Before Interest, Taxes, D&A",
    format: (v, c) => formatNumber(v, { prefix: currSym(c), isLarge: true, decimals: 2 }),
    colorFn: (v) => getColorClass(v, true),
  },
];

function exportCSV(entries: StockEntry[]) {
  const done = entries.filter((e) => e.status === "done" && e.data);
  if (!done.length) return;

  const headers = ["Symbol", "Company", "Currency", "Price", ...METRICS.map((m) => m.label)];
  const rows = done.map((e) => {
    const d = e.data!;
    const price = d.price !== null ? d.price.toFixed(2) : "";
    const metricVals = METRICS.map((m) => {
      const v = d[m.key] as number | null;
      return v !== null ? String(v) : "";
    });
    return [d.symbol, `"${d.companyName}"`, d.currency, price, ...metricVals];
  });

  const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `fundamentals_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function FundamentalsPage() {
  const [tickerInput, setTickerInput] = useState("");
  const [market, setMarket] = useState<Market>("us");
  const [uaeExchange, setUaeExchange] = useState<UAEExchange>("dfm");
  const [entries, setEntries] = useState<StockEntry[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const retryTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return () => retryTimers.current.forEach((t) => clearTimeout(t));
  }, []);

  function buildSymbol(t: string): string {
    const s = t.trim().toUpperCase();
    if (market === "india") {
      return s.endsWith(".NS") || s.endsWith(".BO") ? s : `${s}.NS`;
    }
    if (market === "uae") {
      if (s.endsWith(".DU") || s.endsWith(".AE")) return s;
      return uaeExchange === "dfm" ? `${s}.DU` : `${s}.AE`;
    }
    return s;
  }

  function parseTickers(): string[] {
    return tickerInput
      .split(/[\s,;]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => buildSymbol(t))
      .filter((v, i, a) => a.indexOf(v) === i); // deduplicate
  }

  async function fetchOne(symbol: string): Promise<{ data: FundamentalsResult | null; error: string | null; rateLimitSec?: number }> {
    try {
      const resp = await fetch(`${API_BASE}/fundamentals/${encodeURIComponent(symbol)}`);
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ error: `Error ${resp.status}` }));
        const msg = (body as { error?: string }).error ?? `Error ${resp.status}`;
        let rateLimitSec: number | undefined;
        if (resp.status === 503) {
          const m = msg.match(/~?(\d+)s/);
          rateLimitSec = m ? Math.min(parseInt(m[1]), 120) : 90;
        }
        return { data: null, error: msg, rateLimitSec };
      }
      const data = (await resp.json()) as FundamentalsResult;
      return { data, error: null };
    } catch {
      return { data: null, error: "Network error — please try again." };
    }
  }

  function scheduleRetry(symbol: string) {
    const timer = setTimeout(() => {
      retryTimers.current.delete(symbol);
      void refetchOne(symbol);
    }, 90_000);
    retryTimers.current.set(symbol, timer);
  }

  async function refetchOne(symbol: string) {
    setEntries((prev) =>
      prev.map((e) => (e.symbol === symbol ? { ...e, status: "loading", error: null } : e))
    );
    const result = await fetchOne(symbol);
    setEntries((prev) =>
      prev.map((e) =>
        e.symbol === symbol
          ? {
              ...e,
              status: result.data ? "done" : "error",
              data: result.data,
              error: result.error,
            }
          : e
      )
    );
    if (!result.data && result.rateLimitSec) scheduleRetry(symbol);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const symbols = parseTickers();
    if (!symbols.length) return;

    retryTimers.current.forEach((t) => clearTimeout(t));
    retryTimers.current.clear();

    // Seed entries as loading
    const initial: StockEntry[] = symbols.map((sym) => ({
      symbol: sym,
      status: "loading",
      data: null,
      error: null,
    }));
    setEntries(initial);
    setIsSearching(true);

    // Fetch all in parallel
    await Promise.all(
      symbols.map(async (symbol) => {
        const result = await fetchOne(symbol);
        setEntries((prev) =>
          prev.map((e) =>
            e.symbol === symbol
              ? {
                  ...e,
                  status: result.data ? "done" : "error",
                  data: result.data,
                  error: result.error,
                }
              : e
          )
        );
        if (!result.data && result.rateLimitSec) scheduleRetry(symbol);
      })
    );

    setIsSearching(false);
  }

  const doneEntries = entries.filter((e) => e.status === "done" && e.data);
  const isMulti = entries.length > 1;
  const singleDone = !isMulti && doneEntries.length === 1 ? doneEntries[0].data! : null;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-mono">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/80 backdrop-blur px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center gap-4">
          <div className="text-2xl">📊</div>
          <div>
            <h1 className="text-lg font-bold text-white tracking-tight leading-none">
              Stock Fundamentals
            </h1>
            <p className="text-xs text-gray-400 mt-0.5">
              EPS · P/E · PEG · EBIT · EBITDA · Cash Flow · Net Debt
            </p>
          </div>
          <div className="ml-auto flex gap-2">
            <span className="text-[10px] px-2 py-0.5 rounded border border-blue-700 text-blue-400 bg-blue-950/40 font-sans">NYSE·NASDAQ</span>
            <span className="text-[10px] px-2 py-0.5 rounded border border-orange-700 text-orange-400 bg-orange-950/40 font-sans">NSE</span>
            <span className="text-[10px] px-2 py-0.5 rounded border border-green-700 text-green-400 bg-green-950/40 font-sans">DFM·ADX</span>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        {/* Search Panel */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-8">
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Market Selector */}
            <div className="flex gap-2">
              {(["us", "india", "uae"] as Market[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => { setMarket(m); setEntries([]); }}
                  className={`px-4 py-2 rounded-lg text-sm font-sans font-medium transition-all border ${
                    market === m
                      ? m === "us"
                        ? "bg-blue-600 border-blue-500 text-white"
                        : m === "india"
                        ? "bg-orange-600 border-orange-500 text-white"
                        : "bg-green-700 border-green-600 text-white"
                      : "bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600"
                  }`}
                >
                  {m === "us" ? "🇺🇸 US" : m === "india" ? "🇮🇳 India" : "🇦🇪 UAE"}
                </button>
              ))}
            </div>

            {/* UAE Exchange sub-selector */}
            {market === "uae" && (
              <div className="flex gap-2 pl-1">
                <span className="text-xs text-gray-500 self-center font-sans">Exchange:</span>
                {(["dfm", "adx"] as UAEExchange[]).map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => setUaeExchange(ex)}
                    className={`px-3 py-1 rounded text-xs font-sans font-medium border transition-all ${
                      uaeExchange === ex
                        ? "bg-green-800 border-green-600 text-green-200"
                        : "bg-gray-800 border-gray-700 text-gray-500 hover:text-gray-300"
                    }`}
                  >
                    {ex === "dfm" ? "DFM (.DU)" : "ADX (.AE)"}
                  </button>
                ))}
              </div>
            )}

            {/* Symbol Input */}
            <div className="flex gap-3">
              <div className="flex-1 relative">
                <input
                  type="text"
                  value={tickerInput}
                  onChange={(e) => setTickerInput(e.target.value.toUpperCase())}
                  placeholder={
                    market === "us"
                      ? "e.g. AAPL, MSFT, TSLA, NVDA"
                      : market === "india"
                      ? "e.g. RELIANCE, TCS, INFY, HDFC"
                      : uaeExchange === "dfm"
                      ? "e.g. EMAAR, DU, DIB"
                      : "e.g. FAB, ADNOC, EAND"
                  }
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 text-sm font-mono uppercase transition-all"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <button
                type="submit"
                disabled={isSearching || !tickerInput.trim()}
                className="px-6 py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-sm font-sans font-semibold transition-all flex items-center gap-2 whitespace-nowrap"
              >
                {isSearching ? (
                  <>
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Fetching…
                  </>
                ) : (
                  <>🔍 Look Up</>
                )}
              </button>
              {doneEntries.length > 0 && (
                <button
                  type="button"
                  onClick={() => exportCSV(entries)}
                  className="px-4 py-3 bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-gray-500 text-gray-300 hover:text-white rounded-lg text-sm font-sans font-semibold transition-all flex items-center gap-2 whitespace-nowrap"
                >
                  ⬇ Export CSV
                </button>
              )}
            </div>

            <p className="text-xs text-gray-600 font-sans">
              {market === "india"
                ? "Enter one or more symbols separated by commas. .NS suffix is added automatically."
                : market === "uae"
                ? "Enter one or more symbols separated by commas. Exchange suffix added automatically."
                : "Enter one or more US ticker symbols separated by commas."}
            </p>
          </form>
        </div>

        {/* Progress bar when fetching multiple */}
        {entries.length > 1 && isSearching && (
          <div className="mb-6">
            <div className="flex justify-between text-xs text-gray-500 font-sans mb-2">
              <span>Fetching {entries.length} stocks in parallel…</span>
              <span>{entries.filter((e) => e.status !== "loading").length} / {entries.length} done</span>
            </div>
            <div className="w-full bg-gray-800 rounded-full h-1.5">
              <div
                className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
                style={{ width: `${(entries.filter((e) => e.status !== "loading").length / entries.length) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* ── SINGLE STOCK: Card Grid View ── */}
        {singleDone && (
          <div className="space-y-6">
            {/* Company Header */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl px-6 py-5 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-3 mb-1">
                  <span className="text-2xl font-bold text-white tracking-widest">{singleDone.symbol}</span>
                  <span className={`text-xs px-2 py-0.5 rounded border font-sans ${
                    singleDone.currency === "INR"
                      ? "border-orange-700 text-orange-400 bg-orange-950/40"
                      : singleDone.currency === "AED"
                      ? "border-green-700 text-green-400 bg-green-950/40"
                      : "border-blue-700 text-blue-400 bg-blue-950/40"
                  }`}>{singleDone.currency}</span>
                </div>
                <p className="text-gray-300 font-sans text-base">{singleDone.companyName}</p>
              </div>
              {singleDone.price !== null && (
                <div className="text-right">
                  <p className="text-xs text-gray-500 font-sans mb-1">Current Price</p>
                  <p className="text-3xl font-bold text-white">
                    {currSym(singleDone.currency)}{singleDone.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                </div>
              )}
            </div>

            {/* Metrics Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {METRICS.map((metric) => {
                const val = singleDone[metric.key] as number | null;
                return (
                  <div key={metric.key} className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-4 hover:border-gray-700 transition-colors">
                    <p className="text-xs text-gray-500 font-sans font-medium uppercase tracking-wider mb-1">{metric.label}</p>
                    <p className={`text-2xl font-bold font-mono ${metric.colorFn(val)}`}>
                      {metric.format(val, singleDone.currency)}
                    </p>
                    <p className="text-xs text-gray-600 font-sans mt-1.5 leading-relaxed">{metric.description}</p>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-gray-700 font-sans text-center pt-2">
              Data via stockanalysis.com & Yahoo Finance · Trailing 12-month figures · Updated with each lookup
            </p>
          </div>
        )}

        {/* Single stock error */}
        {!isMulti && entries.length === 1 && entries[0].status === "error" && (
          <div className="bg-red-950/40 border border-red-800 text-red-300 rounded-xl px-5 py-4 text-sm font-sans flex items-start gap-3">
            <span className="text-red-400 mt-0.5">⚠</span>
            <div>
              <p className="font-semibold">Could not retrieve data for {entries[0].symbol}</p>
              <p className="text-red-400 mt-1">{entries[0].error}</p>
            </div>
          </div>
        )}

        {/* ── MULTI STOCK: Comparison Table ── */}
        {isMulti && entries.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500 font-sans">
                {doneEntries.length} of {entries.length} loaded
                {entries.some(e => e.status === "error") && (
                  <span className="text-red-400 ml-2">· {entries.filter(e => e.status === "error").length} failed</span>
                )}
              </p>
            </div>

            <div className="overflow-x-auto rounded-xl border border-gray-800">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-900 border-b border-gray-800">
                    <th className="text-left px-4 py-3 text-xs text-gray-500 font-sans font-semibold uppercase tracking-wider whitespace-nowrap sticky left-0 bg-gray-900 z-10 min-w-[160px]">
                      Stock
                    </th>
                    <th className="text-right px-3 py-3 text-xs text-gray-500 font-sans font-semibold uppercase tracking-wider whitespace-nowrap">
                      Price
                    </th>
                    {METRICS.map((m) => (
                      <th key={m.key} className="text-right px-3 py-3 text-xs text-gray-500 font-sans font-semibold uppercase tracking-wider whitespace-nowrap">
                        {m.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry, idx) => {
                    const d = entry.data;
                    const isLoading = entry.status === "loading";
                    const isError = entry.status === "error";
                    return (
                      <tr
                        key={entry.symbol}
                        className={`border-b border-gray-800/60 transition-colors ${idx % 2 === 0 ? "bg-gray-950" : "bg-gray-900/40"} hover:bg-gray-800/40`}
                      >
                        {/* Stock Name */}
                        <td className={`px-4 py-3 sticky left-0 z-10 ${idx % 2 === 0 ? "bg-gray-950" : "bg-gray-900/40"}`}>
                          <div className="flex items-center gap-2">
                            <div>
                              <p className="font-bold text-white font-mono text-xs tracking-widest">{entry.symbol.replace(/\.(NS|BO|DU|AE)$/i, "")}</p>
                              {d && <p className="text-xs text-gray-500 font-sans truncate max-w-[130px]">{d.companyName}</p>}
                              {isError && <p className="text-xs text-red-400 font-sans">Failed</p>}
                            </div>
                          </div>
                        </td>

                        {/* Price */}
                        <td className="px-3 py-3 text-right">
                          {isLoading ? (
                            <span className="inline-block w-12 h-3 bg-gray-700 rounded animate-pulse" />
                          ) : isError ? (
                            <span className="text-gray-600">—</span>
                          ) : d?.price !== null && d?.price !== undefined ? (
                            <span className="text-white font-mono font-semibold">
                              {currSym(d.currency)}{d.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          ) : (
                            <span className="text-gray-600">—</span>
                          )}
                        </td>

                        {/* Metrics */}
                        {METRICS.map((metric) => {
                          const val = d ? (d[metric.key] as number | null) : null;
                          return (
                            <td key={metric.key} className="px-3 py-3 text-right whitespace-nowrap">
                              {isLoading ? (
                                <span className="inline-block w-10 h-3 bg-gray-800 rounded animate-pulse" />
                              ) : isError ? (
                                <span className="text-gray-700">—</span>
                              ) : (
                                <span className={`font-mono text-xs font-semibold ${metric.colorFn(val)}`}>
                                  {metric.format(val, d?.currency ?? "USD")}
                                </span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <p className="text-xs text-gray-700 font-sans text-center pt-1">
              Data via stockanalysis.com & Yahoo Finance · Trailing 12-month figures · Updated with each lookup
            </p>
          </div>
        )}

        {/* Empty state */}
        {entries.length === 0 && (
          <div className="text-center py-16">
            <div className="text-5xl mb-4">📈</div>
            <h2 className="text-lg font-semibold text-gray-300 font-sans mb-2">
              Look up any stock's fundamentals
            </h2>
            <p className="text-sm text-gray-500 font-sans max-w-md mx-auto">
              Enter one or more ticker symbols (comma-separated) to compare EPS, P/E, PEG, EBIT, EBITDA, Cash Flow, and more side by side.
            </p>
            <div className="mt-8 grid grid-cols-3 gap-4 max-w-lg mx-auto text-left">
              {[
                { flag: "🇺🇸", market: "US Stocks", examples: "AAPL · MSFT · NVDA" },
                { flag: "🇮🇳", market: "India (NSE)", examples: "RELIANCE · TCS · HDFC" },
                { flag: "🇦🇪", market: "UAE (DFM/ADX)", examples: "EMAAR · FAB · ADNOC" },
              ].map((item) => (
                <div key={item.market} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                  <div className="text-2xl mb-2">{item.flag}</div>
                  <p className="text-sm font-sans font-semibold text-gray-200">{item.market}</p>
                  <p className="text-xs text-gray-500 font-mono mt-1">{item.examples}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
