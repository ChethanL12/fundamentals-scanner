"""
Finviz EPS Growth Scraper
Run by GitHub Actions on a schedule to keep finviz_cache.json up to date.
Priority: "EPS next 5Y" → fallback "EPS next Y"
"""

import requests
import re
import json
import time
import os
from datetime import datetime, timezone

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",  # No 'br' — requests can't decode brotli without extra package
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
}

# All tickers to cache (from fetch_sa3.py + common extras)
TICKERS = [
    # Core 123
    "SNDK","WDC","TCEHY","STX","MU","BABA","AVGO","LRCX","BE","ONDS",
    "NBIS","APLD","CRWV","IREN","FISV","ENVX","AXON","PYPL",
    "TXN","APP","MELI","APPS","PLMR","ARRY","NIO","IBM","LMT","PGY",
    "ALGM","CSCO","RIG","ASML","SE","SNAP","INDI","ARM","QCOM","AMD",
    "NVDA","META","GOOG","MSFT","AAPL","AMZN","TSLA","NVTS","OKLO","PTON",
    "BLK","PLTR","OUST","COIN","HOOD","SOFI","TEM","SNOW","SMCI","DELL",
    "CPNG","ORCL","FIG","NVO","DKNG","SBUX","RKT","INTC","PLUG","EOSE",
    "AMKR","ARBE","RDDT","QS","ARQQ","QUBT","RGTI","QBTS","IONQ","ADBE",
    "RUM","PANW","TSM","SYM","MRNA","HIMS","OSCR","SMMT","IVVD","LNTH",
    "PFE","RVPH","DFTX","UNH","ISRG","LITE","COHR","VRT","AEHR","AAOI",
    "GLW","DAVE","NOW","NFLX","PSKY","OKE","BEPC","FSLR","WYFI","JOBY",
    "ACHR","MRVL","KTOS","LUNR","FRSH","AFRM","MSTR","BULL","RKLB","APH",
    "PATH","AIP","RIVN",
    # Semiconductors
    "KLAC","AMAT","MPWR","WOLF","ON","SWKS","NXPI","MCHP","ADI","TER",
    "ENTG","ACLS",
    # Enterprise Software
    "CRM","WDAY","DDOG","MDB","NET","TWLO","ZS","FTNT","OKTA","S","GTLB",
    # AI / Data
    "SOUN","BBAI","AI",
    # Fintech / Payments
    "V","MA","NU","FLYW","GLBE","BILL","RELY",
    # E-commerce / Consumer
    "SHOP","ETSY","DUOL","PINS","ROKU","TTD",
    # EV / Auto
    "LI","XPEV","LCID","BLNK",
    # Defense
    "NOC","RTX","GD","RCAT",
    # Space
    "ASTS","PL",
    # Healthcare / Biotech
    "LLY","REGN","VRTX","GILD","ABBV","DXCM","GEHC","RXRX","NTRA","BFLY",
    # Energy / Clean
    "ENPH","SEDG","RUN","NEE","VST","CEG",
    # Networking
    "ANET","CRDO",
    # Crypto Mining
    "MARA","CLSK","RIOT",
    # Gaming / Entertainment
    "RBLX","U","EA","TTWO","SPOT","DIS",
    # Common large-caps not above
    "JPM","BAC","GS","WFC","C","SCHW","MS","SPGI","MCO","AXP",
    "JNJ","MRK","ABBV","BMY","CVS","CI","HUM","MOH",
    "XOM","CVX","COP","SLB","HAL","OXY",
    "WMT","COST","TGT","HD","LOW","AMZN",
    "DIS","NFLX","CMCSA","CHTR","PARA","WBD",
    "CAT","DE","HON","MMM","GE","BA","LMT","RTX","NOC","GD",
    "GOOGL","GOOG","META","MSFT","AAPL","AMZN","TSLA","NVDA",
    "UNP","CSX","NSC","UPS","FDX","JBHT",
    "SPY","QQQ","IWM",  # ETFs (will return N/A, harmless)
]

# Deduplicate preserving order
seen = set()
TICKERS = [t for t in TICKERS if t not in seen and not seen.add(t)]


def get_eps_growth(ticker):
    """
    Returns (value, source) where value is float % (e.g. 11.09) or None.
    Source is '5Y' or 'nextY'.
    """
    try:
        url = f"https://finviz.com/quote.ashx?t={ticker.upper()}&p=d"
        r = requests.get(url, headers=HEADERS, timeout=25)
        if r.status_code != 200:
            return None, None
        html = r.text

        # Must contain actual stock data (not a Cloudflare challenge)
        if "EPS next 5Y" not in html and "EPS next Y" not in html:
            return None, None

        # Priority 1: EPS next 5Y
        m = re.search(r"EPS next 5Y.{0,400}?<b>([-\d.]+)%</b>", html, re.DOTALL)
        if m:
            try:
                return round(float(m.group(1)), 2), "5Y"
            except ValueError:
                pass

        # Priority 2: EPS next Y
        m = re.search(r"EPS next Y\b.{0,400}?<b>([-\d.]+)%</b>", html, re.DOTALL)
        if m:
            try:
                return round(float(m.group(1)), 2), "nextY"
            except ValueError:
                pass

        return None, None
    except Exception as e:
        print(f"  [ERROR] {ticker}: {e}")
        return None, None


def main():
    cache_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "finviz_cache.json")

    # Load existing cache to merge with (so we don't lose stale data)
    existing = {}
    if os.path.exists(cache_path):
        try:
            with open(cache_path, "r") as f:
                old = json.load(f)
                existing = old.get("data", {})
            print(f"Loaded {len(existing)} existing entries from cache")
        except Exception:
            pass

    updated = dict(existing)  # Start with existing, overwrite with fresh data
    success = 0
    fail = 0

    print(f"Scraping {len(TICKERS)} tickers from Finviz...\n")
    print(f"{'#':>4} {'Ticker':8} {'EPS Growth':>12} {'Source':>8}")
    print("-" * 40)

    for i, ticker in enumerate(TICKERS, 1):
        value, source = get_eps_growth(ticker)
        if value is not None:
            updated[ticker] = value
            success += 1
            print(f"{i:4d} {ticker:8} {value:>11.2f}% {source:>8}")
        else:
            fail += 1
            print(f"{i:4d} {ticker:8} {'N/A':>12} {'':>8}")

        time.sleep(0.6)  # Be polite to Finviz

    cache_obj = {
        "updated": datetime.now(timezone.utc).isoformat(),
        "count": len(updated),
        "data": updated,
    }

    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(cache_obj, f, indent=2)

    print(f"\nDONE: {success} scraped, {fail} failed/N/A")
    print(f"Total cached: {len(updated)} tickers")
    print(f"Saved to: {cache_path}")


if __name__ == "__main__":
    main()
