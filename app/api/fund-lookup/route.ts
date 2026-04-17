import { NextRequest, NextResponse } from "next/server";
import { FundInfo } from "@/lib/types";

// In-memory cache výsledků — zabraňuje duplicitním Gemini voláním pro stejný ISIN
// TTL 5 minut; v Next.js dev mode sdíleno přes hot-reload
const resultCache = new Map<string, { data: Partial<FundInfo>; ts: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minut

function getCached(key: string): Partial<FundInfo> | null {
  const entry = resultCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { resultCache.delete(key); return null; }
  return entry.data;
}
function setCached(key: string, data: Partial<FundInfo>) {
  resultCache.set(key, { data, ts: Date.now() });
}

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/html, */*",
  "Accept-Language": "en-US,en;q=0.9,cs;q=0.8",
};

async function safeFetch(url: string, extraHeaders?: Record<string, string>, timeoutMs = 8000) {
  try {
    const res = await fetch(url, {
      headers: { ...HEADERS, ...extraHeaders },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

// ── Pomocné regex TER extraktory ─────────────────────────────────
function extractTerFromHtml(html: string): number | undefined {
  // Strip HTML tags so patterns work across separate <td>/<span> elements
  // Also decode common HTML entities (especially &nbsp; which Conseq uses before %)
  const stripped = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#160;/g, " ")
    .replace(/&#x[0-9a-f]+;/gi, " ")
    .replace(/\s+/g, " ");

  const patterns: RegExp[] = [
    // Czech labels — Conseq a jiní používají "poplatky za správu" (plurál!)
    // {0,300} je nutné protože Conseq vkládá dlouhý vysvětlující text mezi label a hodnotu
    /poplatky\s+za\s+(?:správu|obhospodařování)[^%\d]{0,300}([\d]+[,.][\d]+)\s*%/gi,
    /poplatek\s+za\s+(?:správu|obhospodařování)[^%\d]{0,300}([\d]+[,.][\d]+)\s*%/gi,
    /správcovsk[ýý]\s+poplatek[^%\d]{0,300}([\d]+[,.][\d]+)\s*%/gi,
    /průběžné\s+(?:výdaje|poplatky|náklady)[^%\d]{0,300}([\d]+[,.][\d]+)\s*%/gi,
    /ongoing\s+charges?[^%\d]{0,300}([\d]+[,.][\d]+)\s*%/gi,
    /total\s+expense\s+ratio[^%\d]{0,300}([\d]+[,.][\d]+)\s*%/gi,
    /roční\s+(?:náklady|poplatky)[^%\d]{0,300}([\d]+[,.][\d]+)\s*%/gi,
    /celkové\s+(?:roční\s+)?náklady[^%\d]{0,300}([\d]+[,.][\d]+)\s*%/gi,
    /náklady\s+(?:fondu|na\s+fond)[^%\d]{0,300}([\d]+[,.][\d]+)\s*%/gi,
    /celkové\s+poplatky[^%\d]{0,300}([\d]+[,.][\d]+)\s*%/gi,
    /management\s+fee[^%\d]{0,300}([\d]+[,.][\d]+)\s*%/gi,
    /expense\s+ratio[^%\d]{0,300}([\d]+[,.][\d]+)\s*%/gi,
    /TER[^%\d]{0,300}([\d]+[,.][\d]+)\s*%/gi,
    // JSON fields
    /"ongoingCharge"\s*:\s*"?([\d.]+)"?/i,
    /"ter"\s*:\s*"?([\d.]+)"?/i,
    /"totalExpenseRatio"\s*:\s*"?([\d.]+)"?/i,
    /"managementFee"\s*:\s*"?([\d.]+)"?/i,
    /"poplatkyZaSpravu"\s*:\s*"?([\d.]+)"?/i,
  ];

  // Search in plain-text (stripped) FIRST — handles cross-element patterns
  // then fall back to raw HTML (for JSON blocks etc.)
  for (const text of [stripped, html]) {
    for (const pattern of patterns) {
      const gp = new RegExp(pattern.source, "gi");
      let m: RegExpExecArray | null;
      while ((m = gp.exec(text)) !== null) {
        const val = parseFloat((m[1] || "").replace(",", "."));
        if (val > 0 && val < 15) return Math.round(val * 100) / 100;
      }
    }
  }
  return undefined;
}

// Extrahuje historickou výkonnost (p.a.) z HTML stránky fondu
function extractReturnsFromHtml(html: string): { oneYearReturn?: number; threeYearReturn?: number; fiveYearReturn?: number } {
  const stripped = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ");

  const parse = (val: string) => {
    const n = parseFloat(val.replace(",", "."));
    return !isNaN(n) && n > -50 && n < 100 ? Math.round(n * 100) / 100 : undefined;
  };

  const find = (patterns: RegExp[]): number | undefined => {
    for (const p of patterns) {
      const m = stripped.match(p);
      if (m?.[1]) { const v = parse(m[1]); if (v !== undefined) return v; }
    }
    return undefined;
  };

  return {
    oneYearReturn: find([
      /(?:výkonnost|výnos|zhodnocení)\s+za\s+1\s+rok[^%\d-]{0,60}(-?[\d]+[,.][\d]+)\s*%/i,
      /1\s*(?:rok|year|yr)[^%\d-]{0,60}(-?[\d]+[,.][\d]+)\s*%/i,
      /1Y[^%\d-]{0,30}(-?[\d]+[,.][\d]+)\s*%/i,
    ]),
    threeYearReturn: find([
      /(?:výkonnost|výnos|zhodnocení)\s+za\s+3\s+rok[^%\d-]{0,60}(-?[\d]+[,.][\d]+)\s*%/i,
      /3\s*(?:roky|roků|years?|yr)[^%\d-]{0,60}(-?[\d]+[,.][\d]+)\s*%/i,
      /3Y[^%\d-]{0,30}(-?[\d]+[,.][\d]+)\s*%/i,
    ]),
    fiveYearReturn: find([
      /(?:výkonnost|výnos|zhodnocení)\s+za\s+5\s+let[^%\d-]{0,60}(-?[\d]+[,.][\d]+)\s*%/i,
      /5\s*(?:let|years?|yr)[^%\d-]{0,60}(-?[\d]+[,.][\d]+)\s*%/i,
      /5Y[^%\d-]{0,30}(-?[\d]+[,.][\d]+)\s*%/i,
      /průměrn[ýá]\s+roční[^%\d-]{0,60}(-?[\d]+[,.][\d]+)\s*%/i,
    ]),
  };
}

// Slova která se vyskytují v názvech stránek / UI, nikoli v názvech fondů
const BOGUS_NAME_PATTERNS = [
  "hledání", "search", "výsledky", "results", "burza", "nenalezeno", "not found",
  "akcie cz online", "podílové fondy", "podilove fondy", "kurzy měn", "hlavní stránka",
  "homepage", "error", "404", "přihlásit", "registrace", "cookie",
];

function isValidFundName(name: string): boolean {
  if (!name || name.length < 4 || name.length > 200) return false;
  const lower = name.toLowerCase();
  return !BOGUS_NAME_PATTERNS.some((p) => lower.includes(p));
}

function extractNameFromHtml(html: string): string | undefined {
  const h1 = html.match(/<h1[^>]*>\s*([^<]{5,}?)\s*<\/h1>/i);
  const title = html.match(/<title>\s*([^|<\-]{5,}?)\s*[|<\-]/i);
  const og = html.match(/property="og:title"\s+content="([^"]+)"/i) ||
             html.match(/content="([^"]+)"\s+property="og:title"/i);
  const raw = (h1?.[1] || og?.[1] || title?.[1] || "").trim();
  return isValidFundName(raw) ? raw : undefined;
}

// ── Yahoo Finance ─────────────────────────────────────────────────
async function yahooSearch(query: string): Promise<string | null> {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&lang=en-US&region=US&quotesCount=5&newsCount=0`;
  const res = await safeFetch(url);
  if (!res) return null;
  try {
    const data = await res.json();
    const quotes: { quoteType: string; symbol: string }[] = data?.quotes ?? [];
    const best = quotes.find((q) => ["ETF", "MUTUALFUND"].includes(q.quoteType)) || quotes[0];
    return best?.symbol ?? null;
  } catch { return null; }
}

async function yahooDetail(ticker: string): Promise<Partial<FundInfo>> {
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=summaryDetail,price,defaultKeyStatistics`;
  const res = await safeFetch(url);
  if (!res) return {};
  try {
    const r = (await res.json())?.quoteSummary?.result?.[0];
    if (!r) return {};
    const sd = r.summaryDetail ?? {};
    const price = r.price ?? {};
    const rawTer = sd.annualReportExpenseRatio?.raw ?? sd.totalExpenseRatio?.raw ?? null;
    return {
      name: price.longName || price.shortName || ticker,
      currency: price.currency,
      ter: rawTer != null ? Math.round(rawTer * 10000) / 100 : undefined,
    };
  } catch { return {}; }
}

async function yahooReturns(ticker: string): Promise<Partial<FundInfo>> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5y&interval=1mo`;
  const res = await safeFetch(url);
  if (!res) return {};
  try {
    const closes: number[] = (await res.json())?.chart?.result?.[0]?.indicators?.adjclose?.[0]?.adjclose ?? [];
    const valid = closes.filter((v) => v != null && !isNaN(v));
    if (valid.length < 2) return {};
    const latest = valid[valid.length - 1];
    const calc = (from: number, yrs: number) => Math.round((Math.pow(latest / from, 1 / yrs) - 1) * 1000) / 10;
    return {
      oneYearReturn:   valid.length >= 13 ? calc(valid[valid.length - 13], 1) : undefined,
      threeYearReturn: valid.length >= 37 ? calc(valid[valid.length - 37], 3) : undefined,
      fiveYearReturn:  valid.length >= 60 ? calc(valid[valid.length - 60], 5) : undefined,
    };
  } catch { return {}; }
}

// ── justetf.com ───────────────────────────────────────────────────
async function justEtfLookup(isin: string): Promise<Partial<FundInfo>> {
  const url = `https://www.justetf.com/api/etfs?isin=${isin}&locale=en&valutaId=EUR`;
  const res = await safeFetch(url, { Referer: "https://www.justetf.com/" });
  if (!res) return {};
  try {
    const data = await res.json();
    const etf = data?.etfs?.[0] ?? data?.[0];
    if (!etf) return {};
    const ter = etf?.ter ?? etf?.totalExpenseRatio ?? etf?.ongoingCharges;
    return {
      name: etf?.name || etf?.fundName,
      currency: etf?.currency,
      ter: ter != null ? Math.round(Number(ter) * 100) / 100 : undefined,
    };
  } catch { return {}; }
}

// ── Morningstar screener (vrací SecId i TER) ──────────────────────
interface MsScreenerResult extends Partial<FundInfo> { secId?: string }

async function morningstarScreener(isin: string, locale = "en-GB", currencyId = "EUR"): Promise<MsScreenerResult> {
  const fields = "SecId,Name,Ticker,iSIN,OngoingCharge,Currency,ReturnM12,ReturnM36,ReturnM60,ReturnAnnualizedM36,ReturnAnnualizedM60";
  const url = `https://lt.morningstar.com/api/rest.svc/klr5zyak8x/security/screener?page=1&pageSize=10&outputType=json&version=1&languageId=${locale}&localeId=${locale}&currencyId=${currencyId}&securityDataPoints=${fields}&term=${encodeURIComponent(isin)}`;
  try {
    const res = await safeFetch(url, { Referer: "https://www.morningstar.co.uk/", "X-Requested-With": "XMLHttpRequest" });
    if (!res) { console.log(`[fund-lookup] msScreener(${locale}): no response`); return {}; }
    const data = await res.json();
    const rows: Record<string, unknown>[] = data?.rows ?? [];
    console.log(`[fund-lookup] msScreener(${locale}): status=${res.status} rows=${rows.length}`);
    const hit = rows.find((r) => String(r.iSIN).toUpperCase() === isin.toUpperCase()) ?? rows[0];
    if (!hit) return {};
    const rawTer = hit.OngoingCharge as string | null | undefined;
    const terNum = rawTer != null && rawTer !== "" ? parseFloat(String(rawTer)) : NaN;
    const parseRet = (v: unknown) => {
      if (v == null || v === "") return undefined;
      const n = parseFloat(String(v));
      return !isNaN(n) && n > -50 && n < 100 ? Math.round(n * 100) / 100 : undefined;
    };
    const r1  = parseRet(hit.ReturnM12);
    const r3  = parseRet(hit.ReturnAnnualizedM36 ?? hit.ReturnM36);
    const r5  = parseRet(hit.ReturnAnnualizedM60 ?? hit.ReturnM60);
    console.log(`[fund-lookup] msScreener(${locale}): 1Y=${r1} 3Y=${r3} 5Y=${r5}`);
    return {
      name: hit.Name as string | undefined,
      currency: hit.Currency as string | undefined,
      ter: !isNaN(terNum) ? Math.round(terNum * 100) / 100 : undefined,
      secId: hit.SecId as string | undefined,
      oneYearReturn: r1,
      threeYearReturn: r3,
      fiveYearReturn: r5,
    };
  } catch (e) { console.log(`[fund-lookup] msScreener(${locale}): error ${e}`); return {}; }
}

// ── Morningstar fund detail page (používá SecId) ─────────────────
async function morningstarFundPage(secId: string): Promise<Partial<FundInfo>> {
  const urls = [
    `https://www.morningstar.cz/cz/funds/snapshot/snapshot.aspx?id=${secId}`,
    `https://www.morningstar.co.uk/uk/funds/snapshot/snapshot.aspx?id=${secId}`,
  ];
  for (const url of urls) {
    const res = await safeFetch(url, { Referer: "https://www.morningstar.cz/" }, 10000);
    if (!res) continue;
    try {
      const html = await res.text();
      const ter = extractTerFromHtml(html);
      const returns = extractReturnsFromHtml(html);
      // Morningstar tabulka výkonnosti: hledáme hodnoty ve formátu "1 rok", "3 roky", "5 let"
      // nebo sloupce s procenty p.a.
      const stripped = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      // Zkusíme ještě Morningstar-specifické vzory pro výkonnost
      const msReturnPatterns = [
        { key: "oneYearReturn",   re: /(?:1\s*rok|1\s*year|YTD\s*\+\s*1)[^%\d-]{0,30}(-?[\d]+[,.][\d]+)\s*%/i },
        { key: "threeYearReturn", re: /(?:3\s*rok[uy]?|3\s*year)[^%\d-]{0,30}(-?[\d]+[,.][\d]+)\s*%/i },
        { key: "fiveYearReturn",  re: /(?:5\s*let|5\s*year)[^%\d-]{0,30}(-?[\d]+[,.][\d]+)\s*%/i },
      ];
      const msReturns: Partial<FundInfo> = {};
      for (const { key, re } of msReturnPatterns) {
        const m = stripped.match(re);
        if (m?.[1]) {
          const v = parseFloat(m[1].replace(",", "."));
          if (!isNaN(v) && v > -50 && v < 100) (msReturns as Record<string, number>)[key] = Math.round(v * 100) / 100;
        }
      }
      const combinedReturns = { ...msReturns, ...returns }; // returns z extractReturnsFromHtml přepíše
      if (ter !== undefined || Object.keys(combinedReturns).length > 0) {
        return { ter, ...combinedReturns, source: "Morningstar" };
      }
    } catch { continue; }
  }
  return {};
}

// ── Morningstar lokální widget (CZ i SK) → SecId ────────────────
async function morningstarLocalSearch(isin: string, locale: "cz" | "sk"): Promise<MsScreenerResult> {
  const domain = locale === "sk" ? "www.morningstar.sk" : "www.morningstar.cz";
  const widgetUrls = [
    `https://${domain}/${locale}/util/SecuritySearch.ashx?q=${encodeURIComponent(isin)}&t=fo&limit=10`,
    `https://${domain}/${locale}/util/SecuritySearch.ashx?q=${encodeURIComponent(isin)}&type=fo&limit=10`,
    `https://${domain}/${locale}/util/SecuritySearch.ashx?q=${encodeURIComponent(isin)}&limit=10`,
    `https://${domain}/${locale}/aj.ashx?action=usearch&term=${encodeURIComponent(isin)}`,
  ];
  for (const url of widgetUrls) {
    try {
      const res = await safeFetch(url, {
        Referer: `https://${domain}/`,
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json, text/javascript, */*",
      });
      if (!res) { console.log(`[fund-lookup] morningstarLocal(${locale}): ${url} — no response`); continue; }
      const text = await res.text();
      const trimmed = text.trim();
      console.log(`[fund-lookup] morningstarLocal(${locale}): ${url} — status=${res.status} len=${trimmed.length} preview=${trimmed.slice(0,100)}`);
      if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) continue;
      const data = JSON.parse(trimmed);
      const results: Record<string, unknown>[] = Array.isArray(data) ? data : (data?.r ?? data?.results ?? data?.hits ?? []);
      if (!results.length) continue;
      const hit = results[0];
      // Morningstar CZ používá "i" pro SecId a "n" pro název (ne "id"/"name")
      const secId = String(hit.i ?? hit.id ?? hit.secId ?? hit.SecId ?? "");
      const name  = String(hit.n ?? hit.name ?? hit.Name ?? "");
      const currency = String(hit.currency ?? hit.Currency ?? (locale === "sk" ? "EUR" : "CZK"));
      console.log(`[fund-lookup] morningstarLocal(${locale}): secId=${secId} name=${name}`);
      if (secId || name) return { name: name || undefined, currency: currency || undefined, secId: secId || undefined };
    } catch (e) { console.log(`[fund-lookup] morningstarLocal(${locale}): error ${e}`); continue; }
  }

  // Fallback: HTML stránka s výsledky hledání → extrahuj SecId z URL snapshotu
  try {
    const searchHtmlUrl = `https://${domain}/${locale}/funds/SecuritySearchResults.aspx?q=${encodeURIComponent(isin)}`;
    const res = await safeFetch(searchHtmlUrl, { Referer: `https://${domain}/` }, 10000);
    if (res) {
      const html = await res.text();
      const secIdMatch = html.match(/snapshot\.aspx\?id=([A-Z0-9]+)/i);
      if (secIdMatch) {
        const secId = secIdMatch[1];
        const name = extractNameFromHtml(html);
        console.log(`[fund-lookup] morningstarLocal(${locale}) htmlPage: secId=${secId} name=${name}`);
        return { secId, name: name || undefined, currency: locale === "sk" ? "EUR" : "CZK" };
      }
    }
  } catch { /* ignore */ }

  return {};
}
// Zkratky pro zpětnou kompatibilitu
const morningstarCzSearch = (isin: string) => morningstarLocalSearch(isin, "cz");
const morningstarSkSearch  = (isin: string) => morningstarLocalSearch(isin, "sk");

// ── Morningstar alternativní screener (více univerz) ─────────────
async function morningstarMultiUniverse(isin: string): Promise<MsScreenerResult> {
  const configs = [
    { locale: "cs-CZ", currency: "CZK", universes: "FOCZZ%24%24ALL" },
    { locale: "en-GB", currency: "EUR", universes: "FOLVZ%24%24ALL" }, // Luxembourg
    { locale: "en-GB", currency: "EUR", universes: "FOEUR%24%24ALL" }, // EU
    { locale: "en-IE", currency: "EUR", universes: "FOIS%24%24ALL" },  // Ireland
    { locale: "de-DE", currency: "EUR", universes: "FOEZZ%24%24ALL" }, // Europe
  ];
  for (const cfg of configs) {
    const url = `https://lt.morningstar.com/api/rest.svc/klr5zyak8x/security/screener?page=1&pageSize=10&outputType=json&version=1&languageId=${cfg.locale}&localeId=${cfg.locale}&currencyId=${cfg.currency}&universeIds=${cfg.universes}&securityDataPoints=SecId,Name,Ticker,iSIN,OngoingCharge,Currency,ReturnM12,ReturnAnnualizedM36,ReturnAnnualizedM60&term=${encodeURIComponent(isin)}`;
    try {
      const res = await safeFetch(url, { Referer: "https://www.morningstar.cz/", "X-Requested-With": "XMLHttpRequest" });
      if (!res) continue;
      const data = await res.json();
      const rows: Record<string, unknown>[] = data?.rows ?? [];
      const hit = rows.find((r) => String(r.iSIN).toUpperCase() === isin.toUpperCase()) ?? rows[0];
      if (!hit) continue;
      const rawTer = hit.OngoingCharge as string | null | undefined;
      const terNum = rawTer != null && rawTer !== "" ? parseFloat(String(rawTer)) : NaN;
      const parseRet = (v: unknown) => {
        if (v == null || v === "") return undefined;
        const n = parseFloat(String(v));
        return !isNaN(n) && n > -50 && n < 100 ? Math.round(n * 100) / 100 : undefined;
      };
      if (hit.Name || !isNaN(terNum)) {
        return {
          name: hit.Name as string | undefined,
          currency: hit.Currency as string | undefined,
          ter: !isNaN(terNum) ? Math.round(terNum * 100) / 100 : undefined,
          secId: hit.SecId as string | undefined,
          oneYearReturn: parseRet(hit.ReturnM12),
          threeYearReturn: parseRet(hit.ReturnAnnualizedM36 ?? hit.ReturnM36),
          fiveYearReturn: parseRet(hit.ReturnAnnualizedM60 ?? hit.ReturnM60),
        };
      }
    } catch { continue; }
  }
  return {};
}

// ── Morningstar.com nový globální search API ──────────────────────
// Alternativa k lt.morningstar.com — používá modernější endpoint
async function morningstarComSearch(isin: string): Promise<MsScreenerResult> {
  // Nový endpoint z morningstar.com — funguje bez site-specific klíče
  const urls = [
    `https://www.morningstar.com/api/v2/search/securities?term=${encodeURIComponent(isin)}&securityType=FO&defaultPage=0&defaultPageSize=10&languageId=cs`,
    `https://www.morningstar.com/api/v2/search/securities?term=${encodeURIComponent(isin)}&securityType=all&defaultPage=0&defaultPageSize=10`,
    // Zkusíme i starší screener s jiným siteId
    `https://lt.morningstar.com/api/rest.svc/y5mi6d9w1k/security/screener?page=1&pageSize=10&outputType=json&version=1&languageId=cs-CZ&localeId=cs-CZ&currencyId=CZK&securityDataPoints=SecId,Name,iSIN,OngoingCharge,Currency&term=${encodeURIComponent(isin)}`,
    `https://lt.morningstar.com/api/rest.svc/ilovekefir/security/screener?page=1&pageSize=10&outputType=json&version=1&languageId=de-DE&localeId=de-DE&currencyId=EUR&securityDataPoints=SecId,Name,iSIN,OngoingCharge,Currency&term=${encodeURIComponent(isin)}`,
  ];
  for (const url of urls) {
    try {
      const res = await safeFetch(url, {
        Referer: "https://www.morningstar.com/",
        "X-Requested-With": "XMLHttpRequest",
      });
      if (!res) continue;
      const data = await res.json();
      // Nový API vrací { results: [...] } nebo { hits: [...] }
      const items: Record<string, unknown>[] = data?.results ?? data?.rows ?? data?.hits ?? [];
      const hit = items.find((r) => String(r.isin ?? r.iSIN ?? "").toUpperCase() === isin.toUpperCase()) ?? items[0];
      if (!hit) continue;
      const rawTer = hit.ongoingCharge ?? hit.OngoingCharge ?? hit.ter;
      const terNum = rawTer != null ? parseFloat(String(rawTer)) : NaN;
      const name = String(hit.name ?? hit.Name ?? hit.securityName ?? "");
      const secId = String(hit.secId ?? hit.SecId ?? hit.id ?? "");
      console.log(`[fund-lookup] morningstarCom: secId=${secId} name=${name} ter=${terNum}`);
      if (name || secId || !isNaN(terNum)) {
        return {
          name: name || undefined,
          currency: String(hit.currency ?? hit.Currency ?? "") || undefined,
          ter: !isNaN(terNum) ? Math.round(terNum * 100) / 100 : undefined,
          secId: secId || undefined,
        };
      }
    } catch (e) {
      console.log(`[fund-lookup] morningstarCom error: ${e}`);
    }
  }
  return {};
}

// ── Kurzy.cz — agregátor pro CZ fondy ────────────────────────────
async function kurzyCzLookup(isin: string): Promise<Partial<FundInfo>> {
  // Strategie: (1) zkusíme vyhledávací URL na kurzy.cz, (2) direct ISIN URL
  const searchUrls = [
    `https://akcie-cz.kurzy.cz/hledani/?q=${encodeURIComponent(isin)}`,
    `https://akcie-cz.kurzy.cz/podilove-fondy/?isin=${encodeURIComponent(isin)}`,
  ];

  for (const searchUrl of searchUrls) {
    const searchRes = await safeFetch(searchUrl, { Referer: "https://akcie-cz.kurzy.cz/" }, 10000);
    if (!searchRes) continue;
    try {
      const html = await searchRes.text();
      if (!html) continue;

      // Případ A: Stránka obsahuje ISIN → jsme přímo na stránce fondu nebo přesměrování
      if (html.includes(isin)) {
        const ter = extractTerFromHtml(html);
        const name = extractNameFromHtml(html);
        // Hledáme také odkaz na konkrétní stránku fondu
        const isinIdx = html.indexOf(isin);
        const snippet = html.slice(Math.max(0, isinIdx - 500), isinIdx + 300);
        const hrefMatch = snippet.match(/href="((?:https:\/\/akcie-cz\.kurzy\.cz)?\/podilove-fondy\/[^"]+)"/i);
        if (hrefMatch) {
          const fundPath = hrefMatch[1].startsWith("http") ? hrefMatch[1] : `https://akcie-cz.kurzy.cz${hrefMatch[1]}`;
          const fundRes = await safeFetch(fundPath, { Referer: "https://akcie-cz.kurzy.cz/" }, 10000);
          if (fundRes) {
            const fundHtml = await fundRes.text();
            const fTer = extractTerFromHtml(fundHtml);
            const fName = extractNameFromHtml(fundHtml);
            if (fTer !== undefined || fName) return { name: fName, ter: fTer, source: "kurzy.cz" };
          }
        }
        if (ter !== undefined || name) return { name, ter, source: "kurzy.cz" };
      }

      // Případ B: Stránka výsledků hledání — najdeme link na fond
      const fundLinkMatch = html.match(/href="(\/podilove-fondy\/[^"]+)"/i);
      if (fundLinkMatch) {
        const fundUrl = `https://akcie-cz.kurzy.cz${fundLinkMatch[1]}`;
        const fundRes = await safeFetch(fundUrl, { Referer: "https://akcie-cz.kurzy.cz/" }, 10000);
        if (fundRes) {
          const fundHtml = await fundRes.text();
          const ter = extractTerFromHtml(fundHtml);
          const name = extractNameFromHtml(fundHtml);
          if (ter !== undefined || name) return { name, ter, source: "kurzy.cz" };
        }
      }
    } catch { continue; }
  }
  return {};
}

// ── Fondshop.cz — český distributor fondů s TER daty ─────────────
async function fondshopLookup(isin: string): Promise<Partial<FundInfo>> {
  const urls = [
    `https://www.fondshop.cz/srovnavac/?isin=${isin}`,
    `https://www.fondshop.cz/fond/?isin=${isin}`,
  ];
  for (const url of urls) {
    const res = await safeFetch(url, { Referer: "https://www.fondshop.cz/" }, 10000);
    if (!res) continue;
    try {
      const html = await res.text();
      if (!html.includes(isin)) continue;
      const ter = extractTerFromHtml(html);
      const name = extractNameFromHtml(html);
      if (ter !== undefined || name) return { name, ter, source: "fondshop.cz" };
    } catch { continue; }
  }
  return {};
}

// ── Amundi ────────────────────────────────────────────────────────
async function amundiScrape(isin: string): Promise<Partial<FundInfo>> {
  const urls = [
    `https://www.amundi.lu/retail/product/view/${isin}`,
    `https://www.amundi.lu/professional/product/view/${isin}`,
    `https://www.amundi.cz/retail/product/view/${isin}`,
  ];
  for (const url of urls) {
    const res = await safeFetch(url, { Referer: "https://www.amundi.lu/", Accept: "text/html,*/*" }, 12000);
    if (!res) continue;
    try {
      const html = await res.text();
      const ter = extractTerFromHtml(html);
      const name = extractNameFromHtml(html);
      if (ter !== undefined || name) return { name, ter, source: "amundi.lu" };
    } catch { continue; }
  }
  return {};
}

// ── iShares / BlackRock ───────────────────────────────────────────
async function iSharesLookup(isin: string): Promise<Partial<FundInfo>> {
  // Zkus EU API
  const apiUrl = `https://www.ishares.com/us/products/etf-investments.do?action=ajaxSearch&searchTerm=${isin}&locale=en`;
  const res = await safeFetch(apiUrl, { Referer: "https://www.ishares.com/" });
  if (res) {
    try {
      const data = await res.json();
      const fund = data?.result?.[0];
      if (fund) {
        const rawTer = fund.productView?.[0]?.totalExpRatio ?? fund.expenseRatio;
        return {
          name: fund.fundName,
          ter: rawTer != null ? parseFloat(String(rawTer).replace("%", "").trim()) : undefined,
          source: "ishares.com",
        };
      }
    } catch { /* fallthrough */ }
  }

  // Scrape EU iShares stránku
  const pageUrl = `https://www.ishares.com/uk/individual/en/products/etf-investments.do?action=ajaxSearch&searchTerm=${isin}&locale=en_GB`;
  const res2 = await safeFetch(pageUrl, { Referer: "https://www.ishares.com/uk/" });
  if (res2) {
    try {
      const data = await res2.json();
      const fund = data?.result?.[0];
      if (fund) {
        const rawTer = fund.productView?.[0]?.totalExpRatio ?? fund.expenseRatio;
        return {
          name: fund.fundName,
          ter: rawTer != null ? parseFloat(String(rawTer).replace("%", "").trim()) : undefined,
          source: "ishares.com",
        };
      }
    } catch { /* ignore */ }
  }
  return {};
}

// ── fundinfo.com ──────────────────────────────────────────────────
async function fundinfoLookup(isin: string): Promise<Partial<FundInfo>> {
  const urls = [
    `https://fundinfo.com/cs/isin/${isin}`,
    `https://fundinfo.com/en/isin/${isin}`,
  ];
  for (const url of urls) {
    const res = await safeFetch(url, { Referer: "https://fundinfo.com/" }, 10000);
    if (!res) continue;
    try {
      const html = await res.text();
      if (!html.includes(isin)) continue; // ověř že stránka skutečně obsahuje ISIN
      const ter = extractTerFromHtml(html);
      const name = extractNameFromHtml(html); // používá isValidFundName() check
      if (ter !== undefined || name) return { name, ter, source: "fundinfo.com" };
    } catch { continue; }
  }
  return {};
}

// ── Generali Investments (dříve ČP Invest) ───────────────────────
// ČP Invest se přejmenoval na Generali Investments CZ v 2020.
// cpinvest deleguje na generaliScrape.
async function cpinvestScrape(isin: string): Promise<Partial<FundInfo>> {
  return generaliScrape(isin);
}

// ── ČSOB Asset Management ─────────────────────────────────────────
// csob.cz (banka) má detail fondu s výnosy — zkusíme jako první!
async function csobamScrape(isin: string): Promise<Partial<FundInfo>> {
  // 0) csob.cz bankovní web — může mít SSR obsah s výnosy
  const csobBankUrl = `https://www.csob.cz/lide/investicni-produkty/nabidka-investic/detail/isin/${isin}/1`;
  const bankRes = await safeFetch(csobBankUrl, { Referer: "https://www.csob.cz/" }, 12000);
  if (bankRes) {
    try {
      const html = await bankRes.text();
      const ter = extractTerFromHtml(html);
      const name = extractNameFromHtml(html);
      const returns = extractReturnsFromHtml(html);
      console.log(`[fund-lookup] csob.cz bank: name="${name}" ter=${ter} returns=${JSON.stringify(returns)} isinInHtml=${html.toLowerCase().includes(isin.toLowerCase())}`);
      if (ter !== undefined || name || Object.keys(returns).length > 0) {
        return { name, ter, ...returns, source: "csob.cz" };
      }
    } catch { /* ignore */ }
  }

  // 1) Přímé API pokusy — ČSOB AM je Liferay SPA, ale někdy exponuje JSON endpointy
  const apiUrls = [
    // Liferay headless delivery API (standardní endpoint)
    `https://www.csobam.cz/o/headless-delivery/v1.0/structured-contents?filter=externalReferenceCode+eq+'${isin}'`,
    // Možné custom REST API (ne-standardní, ale časté u Liferay portálů)
    `https://www.csobam.cz/api/v1/funds/${isin}`,
    `https://www.csobam.cz/api/funds?isin=${isin}`,
    `https://www.csobam.cz/o/api/funds/${isin}`,
  ];
  for (const url of apiUrls) {
    try {
      const res = await safeFetch(url, { Referer: "https://www.csobam.cz/", Accept: "application/json" }, 8000);
      if (!res || !res.headers.get("content-type")?.includes("json")) continue;
      const data = await res.json();
      console.log(`[fund-lookup] csobam API hit: ${url} → ${JSON.stringify(data).slice(0, 200)}`);
      // Zkus extrahovat TER a název z libovolné JSON struktury
      const str = JSON.stringify(data);
      const ter = extractTerFromHtml(str);
      const name = extractNameFromHtml(str);
      if (ter !== undefined || name) return { name, ter, source: "csobam.cz (API)" };
    } catch { /* ignore */ }
  }

  // 2) KID/KIID PDF dokumenty — ČSOB AM musí ze zákona publikovat
  //    Vyzkoušíme předvídatelné URL patterny pro KID PDFka
  const kidUrls = [
    `https://www.csobam.cz/documents/kid/${isin}.pdf`,
    `https://www.csobam.cz/documents/kid/${isin}_cs.pdf`,
    `https://www.csobam.cz/documents/kid/cs/${isin}.pdf`,
    `https://www.csobam.cz/documents/sdz/${isin}.pdf`,   // SDZ = Sdělení klíčových informací
    `https://www.csobam.cz/documents/kiid/${isin}.pdf`,
    `https://www.csobam.cz/documents/${isin}.pdf`,
  ];
  for (const kidUrl of kidUrls) {
    try {
      const res = await safeFetch(kidUrl, { Referer: "https://www.csobam.cz/" }, 10000);
      if (!res || !res.headers.get("content-type")?.includes("pdf")) continue;
      console.log(`[fund-lookup] csobam KID PDF nalezeno: ${kidUrl}`);
      // Pokud máme PDF, zkus extrahovat TER přes text (browser PDF parsing)
      // Poznámka: přímo číst PDF binárně tady nelze — předáme URL extractoru
      const ter = await extractTerFromKidPdf("", kidUrl);
      if (ter !== undefined) return { ter, source: "csobam.cz (KID PDF)" };
    } catch { /* ignore */ }
  }

  // 3) Stránka fondu — SPA, ISIN obvykle není v static HTML, ale zkusíme
  const directUrls = [
    `https://www.csobam.cz/portal/podilove-fondy/detail-fondu/-/isin/${isin}/1`,
    `https://www.csobam.cz/portal/podilove-fondy/detail-fondu/-/isin/${isin.toLowerCase()}/1`,
  ];
  for (const directUrl of directUrls) {
    const res = await safeFetch(directUrl, { Referer: "https://www.csobam.cz/" }, 12000);
    if (!res) continue;
    try {
      const html = await res.text();
      // I když ISIN není přímo v HTML, někdy je název nebo TER přítomný
      const ter = extractTerFromHtml(html) ?? extractTerFromNextData(html, isin);
      const name = extractNameFromHtml(html);
      const returns = extractReturnsFromHtml(html);
      console.log(`[fund-lookup] csobam direct: name="${name}" ter=${ter} isinInHtml=${html.toLowerCase().includes(isin.toLowerCase())}`);
      // Vrátíme i bez ISIN v HTML pokud máme TER nebo validní název
      if (ter !== undefined || (name && name !== isin && name.length > 5)) {
        return { name, ter, ...returns, source: "csobam.cz" };
      }
    } catch { /* ignore */ }
  }

  // 4) Listing stránka
  const listRes = await safeFetch("https://www.csobam.cz/podilove-fondy/", { Referer: "https://www.csobam.cz/" }, 12000);
  if (listRes) {
    try {
      const listHtml = await listRes.text();
      if (listHtml.includes(isin)) {
        const idx = listHtml.indexOf(isin);
        const ctx = listHtml.slice(Math.max(0, idx - 1000), idx + 500);
        const hm = ctx.match(/href="([^"]+(?:portal\/podilove|detail)[^"]+)"/i);
        if (hm) {
          const detailUrl = hm[1].startsWith("http") ? hm[1] : `https://www.csobam.cz${hm[1]}`;
          const dr = await safeFetch(detailUrl, { Referer: "https://www.csobam.cz/" }, 12000);
          if (dr) {
            const dhtml = await dr.text();
            const ter = extractTerFromHtml(dhtml) ?? extractTerFromNextData(dhtml, isin);
            const name = extractNameFromHtml(dhtml);
            const returns = extractReturnsFromHtml(dhtml);
            if (ter !== undefined || name) return { name, ter, ...returns, source: "csobam.cz" };
          }
        }
      }
    } catch { /* ignore */ }
  }
  return kurzyCzLookup(isin);
}

// ── REICO (Česká spořitelna) ──────────────────────────────────────
async function reicoScrape(isin: string): Promise<Partial<FundInfo>> {
  const urls = [
    `https://www.reico.cz/cs/fondy/?isin=${isin}`,
    `https://www.reico.cz/cs/produkty/fondy/`,
  ];
  for (const url of urls) {
    const res = await safeFetch(url, { Referer: "https://www.reico.cz/" }, 10000);
    if (!res) continue;
    try {
      const html = await res.text();
      if (!html.toLowerCase().includes(isin.toLowerCase()) && !html.includes("reico")) continue;
      const ter = extractTerFromHtml(html);
      const name = extractNameFromHtml(html);
      if (ter !== undefined || name) return { name, ter, source: "reico.cz" };
    } catch { continue; }
  }
  return {};
}

// ── Extrakce TER z KID/KIID PDF dokumentu ────────────────────────
async function extractTerFromKidPdf(pageHtml: string, baseUrl: string): Promise<number | undefined> {
  // Najdi odkaz na KID / KIID PDF na stránce fondu
  const kidPatterns = [
    /href="([^"]+\.pdf[^"]*)"/gi,
  ];
  const kidKeywords = ["kid", "kiid", "klíčov", "kličov", "key investor", "sdělení"];
  const pdfLinks: string[] = [];

  for (const pattern of kidPatterns) {
    let m: RegExpExecArray | null;
    const re = new RegExp(pattern.source, "gi");
    while ((m = re.exec(pageHtml)) !== null) {
      const href = m[1];
      const context = pageHtml.slice(Math.max(0, m.index - 200), m.index + 200).toLowerCase();
      if (kidKeywords.some(k => context.includes(k))) {
        pdfLinks.push(href.startsWith("http") ? href : new URL(href, baseUrl).href);
      }
    }
  }

  for (const pdfUrl of pdfLinks.slice(0, 3)) {
    try {
      const res = await safeFetch(pdfUrl, { Referer: baseUrl, Accept: "application/pdf,*/*" }, 15000);
      if (!res) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require("pdf-parse");
      const data = await pdfParse(buf);
      const text = data.text || "";
      console.log(`[fund-lookup] KID PDF (${pdfUrl}) text snippet: "${text.slice(0, 300)}"`);
      const ter = extractTerFromHtml(text); // funguje i na plain text
      if (ter !== undefined) {
        console.log(`[fund-lookup] KID PDF TER found: ${ter}`);
        return ter;
      }
    } catch { continue; }
  }
  return undefined;
}

// ── Extrakce TER z __NEXT_DATA__ (Next.js stránky) ────────────────
function extractTerFromNextData(html: string, isin?: string): number | undefined {
  const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/i);
  if (!nextDataMatch) return undefined;
  try {
    const str = nextDataMatch[1];
    if (isin && !str.includes(isin)) return undefined;
    // Hledej poplatky v JSON — zkus různé klíče
    const feeKeys = [
      "ongoingCharge", "ter", "TER", "totalExpenseRatio", "managementFee",
      "spravcovskyPoplatek", "prubezneNaklady", "prubeznePoplatky", "celkoveNaklady",
      "fee", "annualFee", "charge", "expense",
    ];
    for (const key of feeKeys) {
      const re = new RegExp(`"${key}"\\s*:\\s*"?([\\d]+[,.]?[\\d]*)\\s*%?"?`, "i");
      const m = str.match(re);
      if (m) {
        const val = parseFloat(m[1].replace(",", "."));
        if (val > 0 && val < 15) return Math.round(val * 100) / 100;
      }
    }
    // Fallback: hledej čísla za % nebo v kontextu fee slova
    const stripped = str.replace(/\\n|\\t|\\r/g, " ");
    return extractTerFromHtml(stripped);
  } catch { return undefined; }
}

// ── Pomocná funkce: hledá TER v libovolném JSON objektu fondu ─────
function findTerInObject(obj: Record<string, unknown>): number | undefined {
  const feeKeys = [
    "ter", "TER", "ongoingCharge", "ongoingCharges", "managementFee", "totalFee",
    "poplatkyZaSpravu", "poplatky", "celkoveNaklady", "prubeznePoplatky",
    "spravcovskyPoplatek", "charge", "fee", "annualFee", "totalExpenseRatio",
  ];
  for (const k of feeKeys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") {
      const n = parseFloat(String(v).replace(",", ".").replace("%", "").trim());
      if (n > 0 && n < 15) return Math.round(n * 100) / 100;
    }
  }
  // Projdi rekurzivně zanořené objekty (max 1 úroveň)
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = findTerInObject(v as Record<string, unknown>);
      if (inner !== undefined) return inner;
    }
  }
  return undefined;
}

// ── Conseq ────────────────────────────────────────────────────────
async function conseqScrape(isin: string): Promise<Partial<FundInfo>> {
  // 1) Morningstar CZ widget
  const msCz = await morningstarCzSearch(isin);
  if (msCz.secId) {
    const page = await morningstarFundPage(msCz.secId);
    if (page.ter !== undefined) return { name: msCz.name, currency: msCz.currency, ter: page.ter, source: "Morningstar CZ" };
  }
  if (msCz.name) return { name: msCz.name, currency: msCz.currency, source: "Morningstar CZ" };

  // 2) Výpisová stránka Conseq — HTML, hledáme ISIN v plain textu nebo __NEXT_DATA__
  try {
    const listRes = await safeFetch("https://www.conseq.cz/investice/prehled-fondu/", {
      Referer: "https://www.conseq.cz/",
      Accept: "text/html,*/*",
    }, 12000);
    if (listRes) {
      const listHtml = await listRes.text();
      console.log(`[fund-lookup] conseq listing: ${listHtml.length} znaků, __NEXT_DATA__=${listHtml.includes("__NEXT_DATA__")}, isin=${listHtml.includes(isin)}`);

      // Pokud ISIN není přímo v HTML, zkus __NEXT_DATA__ JSON (Next.js SSR data)
      if (!listHtml.includes(isin)) {
        const ndMatch = listHtml.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
        if (ndMatch) {
          try {
            const nd = JSON.parse(ndMatch[1]);
            const ndStr = JSON.stringify(nd);
            // Ukáž první klíče v __NEXT_DATA__ pro diagnostiku
            const topKeys = Object.keys(nd).join(", ");
            console.log(`[fund-lookup] conseq __NEXT_DATA__ top keys: ${topKeys}, délka: ${ndStr.length}`);

            if (ndStr.includes(isin)) {
              // ISIN přímo v __NEXT_DATA__ — najdi slug nejblíže
              const isinPos = ndStr.indexOf(isin);
              const ctx = ndStr.slice(Math.max(0, isinPos - 500), isinPos + 500);
              const slugM = ctx.match(/"slug"\s*:\s*"([^"]+)"/i) ||
                            ctx.match(/"url"\s*:\s*"([^"]+prehled-fondu\/[^"]+)"/i);
              if (slugM) {
                const slug = slugM[1];
                const detailUrl = slug.startsWith("http") ? slug : `https://www.conseq.cz/investice/prehled-fondu/${slug}`;
                console.log(`[fund-lookup] conseq __NEXT_DATA__ detail URL: ${detailUrl}`);
                const detailRes = await safeFetch(detailUrl, { Referer: "https://www.conseq.cz/" }, 12000);
                if (detailRes) {
                  const detailHtml = await detailRes.text();
                  const name = extractNameFromHtml(detailHtml);
                  let ter = extractTerFromHtml(detailHtml) ?? extractTerFromNextData(detailHtml, isin);
                  if (ter === undefined) ter = await extractTerFromKidPdf(detailHtml, detailUrl);
                  if (ter !== undefined || name) return { name, ter, source: "conseq.cz" };
                }
              }
            } else {
              // ISIN není v __NEXT_DATA__ — vytáhni VŠECHNY slugy fondů a prohledej paralelně
              const allSlugs = new Set<string>();
              // Hledáme /investice/prehled-fondu/ v jakémkoliv stringu v JSON
              const pathRe = /\/investice\/prehled-fondu\/([\w-]+)/gi;
              // Hledáme "slug": "..."
              const slugRe = /"(?:slug|fundSlug|pageSlug|urlSlug)"\s*:\s*"([a-z0-9][\w-]{3,80})"/gi;
              let sm: RegExpExecArray | null;
              while ((sm = pathRe.exec(ndStr)) !== null) allSlugs.add(sm[1]);
              while ((sm = slugRe.exec(ndStr)) !== null) allSlugs.add(sm[1]);
              // Pokud stále 0, zkus najít slugy přímo v HTML (href)
              if (allSlugs.size === 0) {
                const htmlHrefRe = /href="\/investice\/prehled-fondu\/([\w-]+)"/gi;
                while ((sm = htmlHrefRe.exec(listHtml)) !== null) allSlugs.add(sm[1]);
              }
              console.log(`[fund-lookup] conseq __NEXT_DATA__ slugy: ${allSlugs.size} nalezeno (${Array.from(allSlugs).slice(0,5).join(", ")})`);

              if (allSlugs.size > 0) {
                const slugArr = Array.from(allSlugs);
                const BATCH = 8;
                for (let i = 0; i < slugArr.length; i += BATCH) {
                  const batch = slugArr.slice(i, i + BATCH);
                  const results = await Promise.all(batch.map(async (slug) => {
                    const url = slug.startsWith("/") ? `https://www.conseq.cz${slug}`
                      : `https://www.conseq.cz/investice/prehled-fondu/${slug}`;
                    const r = await safeFetch(url, { Referer: "https://www.conseq.cz/" }, 10000);
                    if (!r) return null;
                    const html = await r.text();
                    const nd2 = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? "";
                    if (!html.includes(isin) && !nd2.includes(isin)) return null;
                    const name = extractNameFromHtml(html);
                    let ter = extractTerFromHtml(html) ?? extractTerFromNextData(html, isin);
                    if (ter === undefined) ter = await extractTerFromKidPdf(html, url);
                    console.log(`[fund-lookup] conseq slug hit: ${url} name="${name}" ter=${ter}`);
                    return { name, ter, source: "conseq.cz" };
                  }));
                  const hit = results.find((r) => r !== null);
                  if (hit) return hit;
                }
              }
            }
          } catch { /* JSON parse failed */ }
        }
      }

      if (listHtml.includes(isin)) {
        // Najdi odkaz na detail stránku NEJBLÍŽE k pozici ISIN (v obou směrech)
        const isinIdx = listHtml.indexOf(isin);
        const windowStart = Math.max(0, isinIdx - 2000);
        const windowEnd = Math.min(listHtml.length, isinIdx + 2000);
        const ctx = listHtml.slice(windowStart, windowEnd);
        const isinInCtx = isinIdx - windowStart;

        // Procházíme všechny href shody v okně a hledáme tu nejbližší k ISIN
        const hrefRe = /href="((?:https:\/\/www\.conseq\.cz)?\/investice\/prehled-fondu\/[^"#?]+)"/gi;
        let bestSlug: string | undefined;
        let bestDist = Infinity;
        let hm: RegExpExecArray | null;
        while ((hm = hrefRe.exec(ctx)) !== null) {
          const dist = Math.abs(hm.index - isinInCtx);
          if (dist < bestDist) {
            bestDist = dist;
            bestSlug = hm[1];
          }
        }

        if (bestSlug) {
          const detailUrl = bestSlug.startsWith("http") ? bestSlug : `https://www.conseq.cz${bestSlug}`;
          console.log(`[fund-lookup] conseq detail URL: ${detailUrl}`);
          const detailRes = await safeFetch(detailUrl, { Referer: "https://www.conseq.cz/" }, 12000);
          if (detailRes) {
            const detailHtml = await detailRes.text();
            const detailStripped = detailHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
            // Diagnostika co je na stránce
            const piA = detailStripped.toLowerCase().indexOf("poplatky za správu");
            const piB = detailStripped.toLowerCase().indexOf("poplatek");
            const pi = piA >= 0 ? piA : piB;
            if (pi >= 0) console.log(`[fund-lookup] conseq detail fee ctx: "${detailStripped.slice(Math.max(0,pi-20),pi+350)}"`);
            const name = extractNameFromHtml(detailHtml);
            let ter = extractTerFromHtml(detailHtml) ?? extractTerFromNextData(detailHtml, isin);
            if (ter === undefined) ter = await extractTerFromKidPdf(detailHtml, detailUrl);
            const returns = extractReturnsFromHtml(detailHtml);
            // Debug: ukaž všechna procenta z HTML abychom mohli ladit regex
            const stripped4debug = detailHtml.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ");
            const pctMatches = stripped4debug.match(/.{0,60}[\+\-]?\d+[,.]\d+\s*%.{0,60}/g) ?? [];
            console.log(`[fund-lookup] conseq detail % values (${pctMatches.length}):`);
            pctMatches.slice(0, 15).forEach(m => console.log(`  >> ${m.trim()}`));
            console.log(`[fund-lookup] conseq detail result: name="${name}" ter=${ter} returns=${JSON.stringify(returns)}`);
            if (ter !== undefined || name) return { name, ter, ...returns, source: "conseq.cz" };
          }
        }

        // Nenašli jsme odkaz — zkus vytáhnout název z HTML blízkosti ISIN
        const nameCtx = listHtml.slice(Math.max(0, isinIdx - 800), isinIdx);
        const nameM = nameCtx.match(/>([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][^<]{4,80})</);
        if (nameM?.[1]) return { name: nameM[1].trim(), source: "conseq.cz" };
      } else {
        // ISIN není v listing HTML — vytáhni VŠECHNY fund hrefs a prohledej paralelně
        const allHrefs = new Set<string>();
        const hrefAllRe = /href="((?:https:\/\/www\.conseq\.cz)?\/investice\/prehled-fondu\/[^"#?]{5,})"/gi;
        let hm2: RegExpExecArray | null;
        while ((hm2 = hrefAllRe.exec(listHtml)) !== null) {
          const h = hm2[1].startsWith("http") ? hm2[1] : `https://www.conseq.cz${hm2[1]}`;
          allHrefs.add(h);
        }
        console.log(`[fund-lookup] conseq href scan: ${allHrefs.size} unikátních fund URL`);
        if (allHrefs.size > 0) {
          const BATCH = 8;
          const hrefArr = Array.from(allHrefs);
          for (let i = 0; i < hrefArr.length; i += BATCH) {
            const batch = hrefArr.slice(i, i + BATCH);
            const results = await Promise.all(batch.map(async (url) => {
              const r = await safeFetch(url, { Referer: "https://www.conseq.cz/" }, 10000);
              if (!r) return null;
              const html = await r.text();
              const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? "";
              if (!html.includes(isin) && !nd.includes(isin)) return null;
              const name = extractNameFromHtml(html);
              let ter = extractTerFromHtml(html) ?? extractTerFromNextData(html, isin);
              if (ter === undefined) ter = await extractTerFromKidPdf(html, url);
              console.log(`[fund-lookup] conseq href scan hit: ${url} name="${name}" ter=${ter}`);
              return { name, ter, source: "conseq.cz" };
            }));
            const hit = results.find((r) => r !== null);
            if (hit) return hit;
          }
        }
      }
    }
  } catch (e) {
    console.log(`[fund-lookup] conseqScrape error: ${e}`);
  }

  // 3) Zkus Conseq search a další listing stránky — zachytí i institucionální třídy
  try {
    const extraListings = [
      `https://www.conseq.cz/investice/prehled-fondu/?search=${isin}`,
      `https://www.conseq.cz/investice/prehled-fondu/?q=${isin}`,
      `https://www.conseq.cz/investice/`,
      `https://www.conseq.cz/fondy/`,
    ];
    for (const url of extraListings) {
      const res = await safeFetch(url, { Referer: "https://www.conseq.cz/", Accept: "text/html,*/*" }, 10000);
      if (!res) continue;
      const html = await res.text();
      if (!html.includes(isin)) continue;
      // Našli ISIN — najdi nejbližší href
      const idx = html.indexOf(isin);
      const ctx = html.slice(Math.max(0, idx - 2000), Math.min(html.length, idx + 2000));
      const hm = ctx.match(/href="((?:https:\/\/www\.conseq\.cz)?\/investice\/prehled-fondu\/[^"#?]+)"/i);
      if (hm) {
        const detailUrl = hm[1].startsWith("http") ? hm[1] : `https://www.conseq.cz${hm[1]}`;
        const dr = await safeFetch(detailUrl, { Referer: "https://www.conseq.cz/" }, 12000);
        if (dr) {
          const dhtml = await dr.text();
          const name = extractNameFromHtml(dhtml);
          let ter = extractTerFromHtml(dhtml) ?? extractTerFromNextData(dhtml, isin);
          if (ter === undefined) ter = await extractTerFromKidPdf(dhtml, detailUrl);
          const returns = extractReturnsFromHtml(dhtml);
          console.log(`[fund-lookup] conseq search hit: ${detailUrl} name="${name}" ter=${ter}`);
          if (ter !== undefined || name) return { name, ter, ...returns, source: "conseq.cz" };
        }
      }
    }
  } catch (e) {
    console.log(`[fund-lookup] conseq search error: ${e}`);
  }

  // 3b) Zkus Next.js JSON API endpoint který Conseq web může mít
  try {
    const apiUrls = [
      `https://www.conseq.cz/api/funds?isin=${isin}`,
      `https://www.conseq.cz/api/investice/fondy?isin=${isin}`,
    ];
    for (const apiUrl of apiUrls) {
      const apiRes = await safeFetch(apiUrl, { Referer: "https://www.conseq.cz/", Accept: "application/json" }, 6000);
      if (!apiRes) continue;
      try {
        const data = await apiRes.json();
        const dataStr = JSON.stringify(data);
        if (!dataStr.includes(isin)) continue;
        // Najdi slug nebo URL
        const slugM = dataStr.match(/"slug"\s*:\s*"([^"]+)"/i);
        if (slugM) {
          const detailUrl = `https://www.conseq.cz/investice/prehled-fondu/${slugM[1]}`;
          const detailRes = await safeFetch(detailUrl, { Referer: "https://www.conseq.cz/" }, 12000);
          if (detailRes) {
            const detailHtml = await detailRes.text();
            const name = extractNameFromHtml(detailHtml);
            const ter = extractTerFromHtml(detailHtml) ?? extractTerFromNextData(detailHtml, isin);
            if (ter !== undefined || name) return { name, ter, source: "conseq.cz" };
          }
        }
      } catch { continue; }
    }
  } catch { /* API nedostupné */ }

  // 4) Sitemap fallback — prohledej všechny stránky fondů přes sitemap
  try {
    // Pomocná funkce: stáhni sitemap XML a vrať všechny <loc> URL fondů
    const extractFundUrlsFromSitemap = async (url: string): Promise<string[]> => {
      const res = await safeFetch(url, { Referer: "https://www.conseq.cz/" }, 8000);
      if (!res) return [];
      const xml = await res.text();
      const urls: string[] = [];
      // Hledáme buď sitemap index (<sitemap><loc>...) nebo přímé stránky (<url><loc>...)
      const locRe = /<loc>([^<]+)<\/loc>/gi;
      let lm: RegExpExecArray | null;
      while ((lm = locRe.exec(xml)) !== null) {
        const loc = lm[1].trim();
        if (loc.includes("/investice/prehled-fondu/")) urls.push(loc);
      }
      // Pokud sitemap je index, vrátíme URL sub-sitemapů ke dalšímu zpracování
      if (urls.length === 0 && xml.includes("<sitemapindex")) {
        const subRe = /<loc>([^<]+)<\/loc>/gi;
        const subUrls: string[] = [];
        let sm: RegExpExecArray | null;
        while ((sm = subRe.exec(xml)) !== null) {
          if (sm[1].includes("sitemap")) subUrls.push(sm[1].trim());
        }
        for (const sub of subUrls.slice(0, 10)) {
          const subFundUrls = await extractFundUrlsFromSitemap(sub);
          urls.push(...subFundUrls);
          if (urls.length > 0) break;
        }
      }
      return urls;
    };

    let fundPageUrls = await extractFundUrlsFromSitemap("https://www.conseq.cz/sitemap.xml");
    console.log(`[fund-lookup] conseq sitemap: nalezeno ${fundPageUrls.length} URL fondů`);

    if (fundPageUrls.length > 0) {
      const BATCH = 8;
      for (let i = 0; i < fundPageUrls.length; i += BATCH) {
        const batch = fundPageUrls.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(async (pageUrl) => {
          const res = await safeFetch(pageUrl, { Referer: "https://www.conseq.cz/" }, 10000);
          if (!res) return null;
          const html = await res.text();
          // Hledej ISIN i v __NEXT_DATA__
          const nextData = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? "";
          if (!html.includes(isin) && !nextData.includes(isin)) return null;
          const name = extractNameFromHtml(html);
          let ter = extractTerFromHtml(html) ?? extractTerFromNextData(html, isin);
          if (ter === undefined) ter = await extractTerFromKidPdf(html, pageUrl);
          console.log(`[fund-lookup] conseq sitemap hit: ${pageUrl} name="${name}" ter=${ter}`);
          return { name, ter, source: "conseq.cz" };
        }));
        const hit = results.find((r) => r !== null);
        if (hit) return hit;
      }
    }
  } catch (e) {
    console.log(`[fund-lookup] conseq sitemap error: ${e}`);
  }

  // 5) DuckDuckGo search — najdi URL stránky fondu na conseq.cz
  try {
    const searchUrl = `https://html.duckduckgo.com/html/?q=site%3Aconseq.cz+${encodeURIComponent(isin)}`;
    const searchRes = await safeFetch(searchUrl, {
      Referer: "https://duckduckgo.com/",
      Accept: "text/html,*/*",
    }, 10000);
    if (searchRes) {
      const searchHtml = await searchRes.text();
      // Hledáme href na stránky fondu v search výsledcích
      const hrefRe = /href="(https?:\/\/www\.conseq\.cz\/investice\/prehled-fondu\/[^"&?]+)"/gi;
      let hm: RegExpExecArray | null;
      const foundUrls = new Set<string>();
      while ((hm = hrefRe.exec(searchHtml)) !== null) foundUrls.add(hm[1]);
      // Odfiltruj příliš generické URL (jen sekce, ne konkrétní fond)
      const fundUrls = Array.from(foundUrls).filter(u => u.split("/").length > 5);
      console.log(`[fund-lookup] conseq DDG search: nalezeny URL: ${fundUrls.join(", ") || "žádné"}`);
      for (const url of fundUrls.slice(0, 5)) {
        const res = await safeFetch(url, { Referer: "https://www.conseq.cz/" }, 12000);
        if (!res) continue;
        const html = await res.text();
        const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? "";
        if (!html.includes(isin) && !nd.includes(isin)) continue;
        const name = extractNameFromHtml(html);
        let ter = extractTerFromHtml(html) ?? extractTerFromNextData(html, isin);
        if (ter === undefined) ter = await extractTerFromKidPdf(html, url);
        console.log(`[fund-lookup] conseq DDG hit: ${url} name="${name}" ter=${ter}`);
        if (ter !== undefined || name) return { name, ter, source: "conseq.cz" };
      }
    }
  } catch (e) {
    console.log(`[fund-lookup] conseq DDG error: ${e}`);
  }

  // 6) Fallback: kurzy.cz
  const kurzy = await kurzyCzLookup(isin);
  if (kurzy.ter !== undefined || kurzy.name) return kurzy;

  return {};
}

// ── IAD Investments (SK) ──────────────────────────────────────────
// Listing stránka na iad.sk/podielove-fondy/ — hledáme ISIN, sledujeme link
async function iadScrape(isin: string): Promise<Partial<FundInfo>> {
  const listingUrls = [
    "https://www.iad.sk/podielove-fondy/",
    "https://www.iad.sk/mutual-funds/",
  ];
  for (const listUrl of listingUrls) {
    const res = await safeFetch(listUrl, { Referer: "https://www.iad.sk/" }, 12000);
    if (!res) continue;
    try {
      const html = await res.text();
      if (!html.includes(isin)) continue;
      const idx = html.indexOf(isin);
      const ctx = html.slice(Math.max(0, idx - 1000), idx + 500);
      const hm = ctx.match(/href="([^"]+(?:podielove-fondy|mutual-fund)[^"]+)"/i) ||
                 ctx.match(/href="(\/[^"]{5,100})"/i);
      if (hm) {
        const detailUrl = hm[1].startsWith("http") ? hm[1] : `https://www.iad.sk${hm[1]}`;
        console.log(`[fund-lookup] iad detail URL: ${detailUrl}`);
        const dr = await safeFetch(detailUrl, { Referer: listUrl }, 12000);
        if (dr) {
          const dhtml = await dr.text();
          const ter = extractTerFromHtml(dhtml) ?? extractTerFromNextData(dhtml, isin);
          const name = extractNameFromHtml(dhtml);
          const returns = extractReturnsFromHtml(dhtml);
          if (ter !== undefined || name) return { name, ter, ...returns, source: "iad.sk" };
        }
      }
      const ter = extractTerFromHtml(html);
      const name = extractNameFromHtml(html);
      if (ter !== undefined || name) return { name, ter, source: "iad.sk" };
    } catch { continue; }
  }
  return skFundFallback(isin);
}

// ── Eurizon AM Slovakia (dříve VÚB Asset Management) ─────────────
// VÚB AM sa premenoval na Eurizon Asset Management Slovakia
async function vubamScrape(isin: string): Promise<Partial<FundInfo>> {
  const listingUrls = [
    "https://www.eurizonslovakia.com/sk-SK/fondy-a-produkty/fondy-sk",
    "https://www.eurizonslovakia.com/sk-SK/fondy-a-produkty/",
  ];
  for (const listUrl of listingUrls) {
    const res = await safeFetch(listUrl, { Referer: "https://www.eurizonslovakia.com/" }, 12000);
    if (!res) continue;
    try {
      const html = await res.text();
      if (!html.includes(isin)) continue;
      const idx = html.indexOf(isin);
      const ctx = html.slice(Math.max(0, idx - 1000), idx + 500);
      const hm = ctx.match(/href="([^"]+(?:fond|sk-SK)[^"]+)"/i) ||
                 ctx.match(/href="(\/sk-SK\/[^"]+)"/i);
      if (hm) {
        const detailUrl = hm[1].startsWith("http") ? hm[1] : `https://www.eurizonslovakia.com${hm[1]}`;
        console.log(`[fund-lookup] eurizon detail URL: ${detailUrl}`);
        const dr = await safeFetch(detailUrl, { Referer: listUrl }, 12000);
        if (dr) {
          const dhtml = await dr.text();
          const ter = extractTerFromHtml(dhtml) ?? extractTerFromNextData(dhtml, isin);
          const name = extractNameFromHtml(dhtml);
          const returns = extractReturnsFromHtml(dhtml);
          if (ter !== undefined || name) return { name, ter, ...returns, source: "eurizonslovakia.com" };
        }
      }
      const ter = extractTerFromHtml(html);
      const name = extractNameFromHtml(html);
      if (ter !== undefined || name) return { name, ter, source: "eurizonslovakia.com" };
    } catch { continue; }
  }
  return skFundFallback(isin);
}

// ── Tatra Asset Management (SK) ───────────────────────────────────
// TAM fondy sú na tatrabanka.sk/sk/tam/ — listing + ISIN search
async function tatramScrape(isin: string): Promise<Partial<FundInfo>> {
  const listingUrls = [
    "https://www.tatrabanka.sk/sk/tam/",
    "https://www.tatrabanka.sk/sk/osobne/investovanie/podielove-fondy/",
  ];
  for (const listUrl of listingUrls) {
    const res = await safeFetch(listUrl, { Referer: "https://www.tatrabanka.sk/" }, 12000);
    if (!res) continue;
    try {
      const html = await res.text();
      if (!html.includes(isin)) continue;
      const idx = html.indexOf(isin);
      const ctx = html.slice(Math.max(0, idx - 1000), idx + 500);
      const hm = ctx.match(/href="([^"]+(?:tam|fond|podielove)[^"]+)"/i) ||
                 ctx.match(/href="(\/sk\/[^"]{5,100})"/i);
      if (hm) {
        const detailUrl = hm[1].startsWith("http") ? hm[1] : `https://www.tatrabanka.sk${hm[1]}`;
        console.log(`[fund-lookup] tatram detail URL: ${detailUrl}`);
        const dr = await safeFetch(detailUrl, { Referer: listUrl }, 12000);
        if (dr) {
          const dhtml = await dr.text();
          const ter = extractTerFromHtml(dhtml) ?? extractTerFromNextData(dhtml, isin);
          const name = extractNameFromHtml(dhtml);
          const returns = extractReturnsFromHtml(dhtml);
          if (ter !== undefined || name) return { name, ter, ...returns, source: "tatrabanka.sk" };
        }
      }
      const ter = extractTerFromHtml(html);
      const name = extractNameFromHtml(html);
      if (ter !== undefined || name) return { name, ter, source: "tatrabanka.sk" };
    } catch { continue; }
  }
  return skFundFallback(isin);
}

// ── Erste Asset Management SK / Slovenská sporiteľňa ─────────────
// URL pattern: erste-am.sk/sk/amslsp/fondy-sk/{slug}/{ISIN}
async function ersteSkScrape(isin: string): Promise<Partial<FundInfo>> {
  // Zkus listing stránku (ISIN je v URL detailu)
  const listingUrls = [
    "https://www.erste-am.sk/sk/amslsp/fondy-sk/",
    "https://www.erste-am.sk/sk/fondy/",
  ];
  for (const listUrl of listingUrls) {
    const listRes = await safeFetch(listUrl, { Referer: "https://www.erste-am.sk/" }, 12000);
    if (!listRes) continue;
    try {
      const listHtml = await listRes.text();
      if (!listHtml.includes(isin)) continue;
      const idx = listHtml.indexOf(isin);
      const ctx = listHtml.slice(Math.max(0, idx - 1500), idx + 600);
      const hm = ctx.match(/href="([^"]+fondy-sk\/[^"]+)"/i) ||
                 ctx.match(/href="([^"]+\/[^"]+\/[^"]+)"/i);
      if (hm) {
        const detailUrl = hm[1].startsWith("http") ? hm[1] : `https://www.erste-am.sk${hm[1]}`;
        console.log(`[fund-lookup] erste-am.sk detail URL: ${detailUrl}`);
        const dr = await safeFetch(detailUrl, { Referer: listUrl }, 12000);
        if (dr) {
          const dhtml = await dr.text();
          const ter = extractTerFromHtml(dhtml) ?? extractTerFromNextData(dhtml, isin);
          const name = extractNameFromHtml(dhtml);
          const returns = extractReturnsFromHtml(dhtml);
          if (ter !== undefined || name) return { name, ter, ...returns, source: "erste-am.sk" };
        }
      }
      const ter = extractTerFromHtml(listHtml);
      const name = extractNameFromHtml(listHtml);
      if (ter !== undefined || name) return { name, ter, source: "erste-am.sk" };
    } catch { continue; }
  }
  return skFundFallback(isin);
}

// ── Slovenská sporiteľňa / SLSP (SK) ─────────────────────────────
// Fallback pro SK ISINy: Morningstar SK widget + kurzy.sk
async function skFundFallback(isin: string): Promise<Partial<FundInfo>> {
  const msSk = await morningstarSkSearch(isin);
  if (msSk.secId) {
    const page = await morningstarFundPage(msSk.secId);
    if (page.ter !== undefined) return { name: msSk.name, currency: msSk.currency, ter: page.ter, source: "Morningstar SK" };
  }
  if (msSk.name) return { name: msSk.name, currency: msSk.currency, source: "Morningstar SK" };
  return {};
}

// ── Penize.cz — český finanční portál ────────────────────────────
async function penizeLookup(isin: string): Promise<Partial<FundInfo>> {
  const urls = [
    `https://www.penize.cz/fondy/${isin}`,
    `https://www.penize.cz/investice/fondy/hledani?q=${encodeURIComponent(isin)}`,
  ];
  for (const url of urls) {
    const res = await safeFetch(url, { Referer: "https://www.penize.cz/" }, 10000);
    if (!res) continue;
    try {
      const html = await res.text();
      if (!html.includes(isin)) continue;
      const ter = extractTerFromHtml(html);
      const name = extractNameFromHtml(html);
      if (ter !== undefined || name) return { name, ter, source: "penize.cz" };
    } catch { continue; }
  }
  return {};
}

// ── Patria.cz — český finanční portál ────────────────────────────
async function patriaLookup(isin: string): Promise<Partial<FundInfo>> {
  const urls = [
    `https://www.patria.cz/akcie/${isin}/overview.html`,
    `https://www.patria.cz/akcie/${isin}/prehled.html`,
  ];
  for (const url of urls) {
    const res = await safeFetch(url, { Referer: "https://www.patria.cz/" }, 10000);
    if (!res) continue;
    try {
      const html = await res.text();
      if (!html.includes(isin)) continue;
      const ter = extractTerFromHtml(html);
      const name = extractNameFromHtml(html);
      if (ter !== undefined || name) return { name, ter, source: "patria.cz" };
    } catch { continue; }
  }
  return {};
}

// ── Amundi KB (dříve KB Asset Management) ────────────────────────
// KB AM se přejmenoval na Amundi KB. Přímá URL s ISIN.
async function kbamScrape(isin: string): Promise<Partial<FundInfo>> {
  // Amundi KB má přímou URL s ISIN
  const directUrl = `https://www.amundi-kb.cz/fondy/detail/${isin}`;
  const res = await safeFetch(directUrl, { Referer: "https://www.amundi-kb.cz/" }, 12000);
  if (res) {
    try {
      const html = await res.text();
      const ter = extractTerFromHtml(html) ?? extractTerFromNextData(html, isin);
      const name = extractNameFromHtml(html);
      const returns = extractReturnsFromHtml(html);
      if (ter !== undefined || name) return { name, ter, ...returns, source: "amundi-kb.cz" };
    } catch { /* ignore */ }
  }
  // Fallback: listing stránka
  const listRes = await safeFetch("https://www.amundi-kb.cz/fondy/", { Referer: "https://www.amundi-kb.cz/" }, 12000);
  if (listRes) {
    try {
      const listHtml = await listRes.text();
      if (listHtml.includes(isin)) {
        const idx = listHtml.indexOf(isin);
        const ctx = listHtml.slice(Math.max(0, idx - 1000), idx + 500);
        const hm = ctx.match(/href="([^"]+fondy\/detail\/[^"]+)"/i) ||
                   ctx.match(/href="([^"]+fondy\/[^"]+)"/i);
        if (hm) {
          const detailUrl = hm[1].startsWith("http") ? hm[1] : `https://www.amundi-kb.cz${hm[1]}`;
          const dr = await safeFetch(detailUrl, { Referer: "https://www.amundi-kb.cz/" }, 12000);
          if (dr) {
            const dhtml = await dr.text();
            const ter = extractTerFromHtml(dhtml) ?? extractTerFromNextData(dhtml, isin);
            const name = extractNameFromHtml(dhtml);
            const returns = extractReturnsFromHtml(dhtml);
            if (ter !== undefined || name) return { name, ter, ...returns, source: "amundi-kb.cz" };
          }
        }
      }
    } catch { /* ignore */ }
  }
  return kurzyCzLookup(isin);
}

// ── Goldman Sachs AM CZ (dříve NN Investment Partners) ───────────
// Hlavní stránka: czfondy.gs.com — přehled fondů a detail
async function nnGsamScrape(isin: string): Promise<Partial<FundInfo>> {
  // Zkus přímé URL na Goldman Sachs CZ portálu
  const directUrls = [
    `https://czfondy.gs.com/cs/CZ/Institutional/fund/${isin}`,
    `https://czfondy.gs.com/cs/CZ/Retail/fund/${isin}`,
    `https://czfondy.gs.com/cs/CZ/Wholesale/fund/${isin}`,
  ];
  for (const url of directUrls) {
    const res = await safeFetch(url, { Referer: "https://czfondy.gs.com/" }, 12000);
    if (!res) continue;
    try {
      const html = await res.text();
      if (!html.toLowerCase().includes(isin.toLowerCase())) continue;
      const ter = extractTerFromHtml(html) ?? extractTerFromNextData(html, isin);
      const name = extractNameFromHtml(html);
      const returns = extractReturnsFromHtml(html);
      if (ter !== undefined || name) return { name, ter, ...returns, source: "czfondy.gs.com" };
    } catch { continue; }
  }
  // Listing stránka
  const listRes = await safeFetch("https://czfondy.gs.com/prehled-fondu", { Referer: "https://czfondy.gs.com/" }, 12000);
  if (listRes) {
    try {
      const listHtml = await listRes.text();
      if (listHtml.includes(isin)) {
        const idx = listHtml.indexOf(isin);
        const ctx = listHtml.slice(Math.max(0, idx - 1000), idx + 500);
        const hm = ctx.match(/href="([^"]+(?:fund|fond)[^"]+)"/i);
        if (hm) {
          const detailUrl = hm[1].startsWith("http") ? hm[1] : `https://czfondy.gs.com${hm[1]}`;
          const dr = await safeFetch(detailUrl, { Referer: "https://czfondy.gs.com/" }, 12000);
          if (dr) {
            const dhtml = await dr.text();
            const ter = extractTerFromHtml(dhtml) ?? extractTerFromNextData(dhtml, isin);
            const name = extractNameFromHtml(dhtml);
            const returns = extractReturnsFromHtml(dhtml);
            if (ter !== undefined || name) return { name, ter, ...returns, source: "czfondy.gs.com" };
          }
        }
      }
    } catch { /* ignore */ }
  }
  return kurzyCzLookup(isin);
}

// ── Generali Investments (dříve ČP Invest) ───────────────────────
// Stránka přehledu fondů: /produkty/uplny-prehled-fondu.html
// Detail fondu je slug-based, ISIN hledáme v listing HTML
async function generaliScrape(isin: string): Promise<Partial<FundInfo>> {
  const listingUrls = [
    "https://www.generali-investments.cz/produkty/uplny-prehled-fondu.html",
    "https://www.generali-investments.cz/produkty/fondy/",
  ];
  for (const listUrl of listingUrls) {
    const listRes = await safeFetch(listUrl, { Referer: "https://www.generali-investments.cz/" }, 12000);
    if (!listRes) continue;
    try {
      const listHtml = await listRes.text();
      if (!listHtml.includes(isin)) continue;
      const idx = listHtml.indexOf(isin);
      const ctx = listHtml.slice(Math.max(0, idx - 1500), idx + 600);
      // Hledej odkaz na detail fondu v okolí ISIN
      const hm = ctx.match(/href="([^"]+(?:produkty|fondy)\/[^"]+)"/) ||
                 ctx.match(/href="(\/[^"]+\/[^"]+)"/) ;
      if (hm) {
        const detailUrl = hm[1].startsWith("http") ? hm[1] : `https://www.generali-investments.cz${hm[1]}`;
        console.log(`[fund-lookup] generali detail URL: ${detailUrl}`);
        const dr = await safeFetch(detailUrl, { Referer: listUrl }, 12000);
        if (dr) {
          const dhtml = await dr.text();
          const ter = extractTerFromHtml(dhtml) ?? extractTerFromNextData(dhtml, isin);
          const name = extractNameFromHtml(dhtml);
          const returns = extractReturnsFromHtml(dhtml);
          if (ter !== undefined || name) return { name, ter, ...returns, source: "generali-investments.cz" };
        }
      }
      // Odkaz nenalezen — zkus extrahovat přímo z listingu
      const ter = extractTerFromHtml(listHtml);
      const name = extractNameFromHtml(listHtml);
      if (ter !== undefined || name) return { name, ter, source: "generali-investments.cz" };
    } catch { continue; }
  }
  return kurzyCzLookup(isin);
}

// ── J&T Investiční společnost ─────────────────────────────────────
// J&T Bank má fondy na jtbank.cz/produkty/fondy/{ISIN}
async function jtinvestScrape(isin: string): Promise<Partial<FundInfo>> {
  // Přímé URL s ISIN (jtbank.cz používá ISIN jako suffix)
  const directUrls = [
    `https://www.jtbank.cz/produkty/fondy/${isin}`,
    `https://www.jtbank.cz/cs/produkty/investicni-fondy/${isin}`,
  ];
  for (const url of directUrls) {
    const res = await safeFetch(url, { Referer: "https://www.jtbank.cz/" }, 12000);
    if (!res) continue;
    try {
      const html = await res.text();
      if (!html.toLowerCase().includes(isin.toLowerCase())) continue;
      const ter = extractTerFromHtml(html) ?? extractTerFromNextData(html, isin);
      const name = extractNameFromHtml(html);
      const returns = extractReturnsFromHtml(html);
      if (ter !== undefined || name) return { name, ter, ...returns, source: "jtbank.cz" };
    } catch { continue; }
  }
  // Listing stránka
  const listingUrls = [
    "https://www.jtbank.cz/produkty/fondy/",
    "https://www.jtbank.cz/cs/produkty/investicni-fondy/",
  ];
  for (const listUrl of listingUrls) {
    const res = await safeFetch(listUrl, { Referer: "https://www.jtbank.cz/" }, 12000);
    if (!res) continue;
    try {
      const html = await res.text();
      if (!html.includes(isin)) continue;
      const idx = html.indexOf(isin);
      const ctx = html.slice(Math.max(0, idx - 1000), idx + 500);
      const hm = ctx.match(/href="([^"]+(?:fond|fund|investicni)[^"]+)"/i);
      if (hm) {
        const detailUrl = hm[1].startsWith("http") ? hm[1] : `https://www.jtbank.cz${hm[1]}`;
        const dr = await safeFetch(detailUrl, { Referer: listUrl }, 12000);
        if (dr) {
          const dhtml = await dr.text();
          const ter = extractTerFromHtml(dhtml) ?? extractTerFromNextData(dhtml, isin);
          const name = extractNameFromHtml(dhtml);
          const returns = extractReturnsFromHtml(dhtml);
          if (ter !== undefined || name) return { name, ter, ...returns, source: "jtbank.cz" };
        }
      }
    } catch { continue; }
  }
  return kurzyCzLookup(isin);
}

// ── Raiffeisen Capital Management CZ ─────────────────────────────
// Raiffeisen používá slug-based URL; listing stránka obsahuje ISIN
async function raiffeisenScrape(isin: string): Promise<Partial<FundInfo>> {
  const listingUrls = [
    "https://www.rb.cz/osobni/zhodnoceni-uspor/investicni-fondy/prehled-fondu",
    "https://www.raiffeisen.cz/cz/fondy/",
    "https://www.rcm.cz/fondy/",
  ];
  for (const listUrl of listingUrls) {
    const res = await safeFetch(listUrl, { Referer: "https://www.rb.cz/" }, 12000);
    if (!res) continue;
    try {
      const html = await res.text();
      if (!html.includes(isin)) continue;
      const idx = html.indexOf(isin);
      const ctx = html.slice(Math.max(0, idx - 1000), idx + 500);
      const hm = ctx.match(/href="([^"]+(?:fond|fund|detail)[^"]+)"/i) ||
                 ctx.match(/href="(\/[^"]{5,100})"/i);
      if (hm) {
        const base = new URL(listUrl).origin;
        const detailUrl = hm[1].startsWith("http") ? hm[1] : `${base}${hm[1]}`;
        console.log(`[fund-lookup] raiffeisen detail URL: ${detailUrl}`);
        const dr = await safeFetch(detailUrl, { Referer: listUrl }, 12000);
        if (dr) {
          const dhtml = await dr.text();
          const ter = extractTerFromHtml(dhtml) ?? extractTerFromNextData(dhtml, isin);
          const name = extractNameFromHtml(dhtml);
          const returns = extractReturnsFromHtml(dhtml);
          if (ter !== undefined || name) return { name, ter, ...returns, source: "rb.cz" };
        }
      }
      // Listing sám obsahuje data
      const ter = extractTerFromHtml(html);
      const name = extractNameFromHtml(html);
      if (ter !== undefined || name) return { name, ter, source: "rb.cz" };
    } catch { continue; }
  }
  return kurzyCzLookup(isin);
}

// ── Erste Asset Management CZ (dříve ISČS / Česká spořitelna) ────
// Erste AM CZ: erste-am.cz/cs/privatni-investori/funds/{slug}/{ISIN}
async function iscsScrape(isin: string): Promise<Partial<FundInfo>> {
  // Zkus přímé URL s ISIN
  const directUrls = [
    `https://www.erste-am.cz/cs/privatni-investori/funds/${isin}`,
    `https://www.csas.cz/cs/fondy/${isin}`,
  ];
  for (const url of directUrls) {
    const res = await safeFetch(url, { Referer: "https://www.erste-am.cz/" }, 12000);
    if (!res) continue;
    try {
      const html = await res.text();
      if (!html.toLowerCase().includes(isin.toLowerCase())) continue;
      const ter = extractTerFromHtml(html) ?? extractTerFromNextData(html, isin);
      const name = extractNameFromHtml(html);
      const returns = extractReturnsFromHtml(html);
      if (ter !== undefined || name) return { name, ter, ...returns, source: "erste-am.cz" };
    } catch { continue; }
  }
  // Listing stránka — hledáme ISIN a sledujeme link
  const listingUrls = [
    "https://www.erste-am.cz/cs/privatni-investori/funds/",
    "https://www.erste-am.cz/cs/privatni-investori/fondy/",
  ];
  for (const listUrl of listingUrls) {
    const listRes = await safeFetch(listUrl, { Referer: "https://www.erste-am.cz/" }, 12000);
    if (!listRes) continue;
    try {
      const listHtml = await listRes.text();
      if (!listHtml.includes(isin)) continue;
      const idx = listHtml.indexOf(isin);
      const ctx = listHtml.slice(Math.max(0, idx - 1500), idx + 600);
      const hm = ctx.match(/href="([^"]+(?:funds|fondy)\/[^"]+)"/i) ||
                 ctx.match(/href="(\/cs\/[^"]+\/[^"]+)"/) ;
      if (hm) {
        const detailUrl = hm[1].startsWith("http") ? hm[1] : `https://www.erste-am.cz${hm[1]}`;
        console.log(`[fund-lookup] erste-am.cz detail URL: ${detailUrl}`);
        const dr = await safeFetch(detailUrl, { Referer: listUrl }, 12000);
        if (dr) {
          const dhtml = await dr.text();
          const ter = extractTerFromHtml(dhtml) ?? extractTerFromNextData(dhtml, isin);
          const name = extractNameFromHtml(dhtml);
          const returns = extractReturnsFromHtml(dhtml);
          if (ter !== undefined || name) return { name, ter, ...returns, source: "erste-am.cz" };
        }
      }
    } catch { continue; }
  }
  return kurzyCzLookup(isin);
}

// ── Partners investiční společnost ───────────────────────────────
// Listing: partnersis.cz/nase-fondy/ — hledáme ISIN, sledujeme odkaz
async function partnersScrape(isin: string): Promise<Partial<FundInfo>> {
  const listingUrls = [
    "https://www.partnersis.cz/nase-fondy/",
    "https://www.partnersis.cz/fondy/",
  ];
  for (const listUrl of listingUrls) {
    const listRes = await safeFetch(listUrl, { Referer: "https://www.partnersis.cz/" }, 12000);
    if (!listRes) continue;
    try {
      const listHtml = await listRes.text();
      if (!listHtml.includes(isin)) continue;
      const idx = listHtml.indexOf(isin);
      const ctx = listHtml.slice(Math.max(0, idx - 1500), idx + 600);
      const hm = ctx.match(/href="([^"]+(?:fond|nase-fondy)[^"]+)"/i) ||
                 ctx.match(/href="(\/[^"]{5,100})"/i);
      if (hm) {
        const detailUrl = hm[1].startsWith("http") ? hm[1] : `https://www.partnersis.cz${hm[1]}`;
        console.log(`[fund-lookup] partners detail URL: ${detailUrl}`);
        const dr = await safeFetch(detailUrl, { Referer: listUrl }, 12000);
        if (dr) {
          const dhtml = await dr.text();
          const ter = extractTerFromHtml(dhtml) ?? extractTerFromNextData(dhtml, isin);
          const name = extractNameFromHtml(dhtml);
          const returns = extractReturnsFromHtml(dhtml);
          if (ter !== undefined || name) return { name, ter, ...returns, source: "partnersis.cz" };
        }
      }
      // Listing sám
      const ter = extractTerFromHtml(listHtml);
      const name = extractNameFromHtml(listHtml);
      if (ter !== undefined || name) return { name, ter, source: "partnersis.cz" };
    } catch { continue; }
  }
  return kurzyCzLookup(isin);
}

// ── ČSOB AM Slovakia ─────────────────────────────────────────────
// ČSOB AM SK — priama URL s ISIN podobne ako CZ verzia
async function csobSkScrape(isin: string): Promise<Partial<FundInfo>> {
  // Skus priamu URL (rovnaký vzor ako CZ: /podielove-fondy/detail/isin/{isin}/1)
  const directUrl = `https://www.csobam.sk/podielove-fondy/detail/isin/${isin.toLowerCase()}/1`;
  const res = await safeFetch(directUrl, { Referer: "https://www.csobam.sk/" }, 12000);
  if (res) {
    try {
      const html = await res.text();
      const ter = extractTerFromHtml(html) ?? extractTerFromNextData(html, isin);
      const name = extractNameFromHtml(html);
      const returns = extractReturnsFromHtml(html);
      if (ter !== undefined || name) return { name, ter, ...returns, source: "csobam.sk" };
    } catch { /* ignore */ }
  }
  // Listing stránka
  const listRes = await safeFetch("https://www.csobam.sk/podielove-fondy/", { Referer: "https://www.csobam.sk/" }, 12000);
  if (listRes) {
    try {
      const listHtml = await listRes.text();
      if (listHtml.includes(isin)) {
        const idx = listHtml.indexOf(isin);
        const ctx = listHtml.slice(Math.max(0, idx - 1000), idx + 500);
        const hm = ctx.match(/href="([^"]+podielove-fondy\/detail[^"]+)"/i) ||
                   ctx.match(/href="([^"]+podielove-fondy\/[^"]+)"/i);
        if (hm) {
          const detailUrl = hm[1].startsWith("http") ? hm[1] : `https://www.csobam.sk${hm[1]}`;
          const dr = await safeFetch(detailUrl, { Referer: "https://www.csobam.sk/" }, 12000);
          if (dr) {
            const dhtml = await dr.text();
            const ter = extractTerFromHtml(dhtml) ?? extractTerFromNextData(dhtml, isin);
            const name = extractNameFromHtml(dhtml);
            const returns = extractReturnsFromHtml(dhtml);
            if (ter !== undefined || name) return { name, ter, ...returns, source: "csobam.sk" };
          }
        }
      }
    } catch { /* ignore */ }
  }
  return skFundFallback(isin);
}

// ── Detekce poskytovatele z ISIN a názvu ─────────────────────────
function detectProvider(isin: string, name: string): string {
  const n = (name || "").toLowerCase();
  if (n.includes("amundi") || n.includes("lyxor") || n.includes("pioneer")) return "amundi";
  if (n.includes("ishares") || n.includes("blackrock") || n.includes("i shares")) return "ishares";
  if (n.includes("conseq")) return "conseq";
  if (n.includes("cp invest") || n.includes("čp invest") || n.includes("česká pojišťovna")) return "cpinvest";
  if (n.includes("čsob") || n.includes("csob")) return "csob";
  if (n.includes("reico") || n.includes("česká spořitelna") || n.includes("ceska sporitelna")) return "reico";
  if (n.includes("amundi kb") || n.includes("kb asset") || n.includes("kb am") || n.includes("komerční banka")) return "kbam";
  if (n.includes("nn investment") || n.includes("nn invest") || n.includes("goldman sachs am") || n.includes("czfondy")) return "nn";
  if (n.includes("generali")) return "generali";
  if (n.includes("j&t") || n.includes("jt invest") || n.includes("jt bond") || n.includes("jt money")) return "jtinvest";
  if (n.includes("raiffeisen") || n.includes("rcm fond")) return "raiffeisen";
  if (n.includes("isčs") || n.includes("iscs") || n.includes("investiční společnost české spořitelny") || n.includes("sporoinvest") || n.includes("sporobond") || n.includes("erste asset management")) return "iscs";
  if (n.includes("partners invest") || n.includes("partnersis")) return "partners";
  // Slovak providers
  if (n.includes("iad invest") || n.includes("iad fond")) return "iad";
  if (n.includes("vúb") || n.includes("vub asset") || n.includes("vubamanet") || n.includes("eurizon")) return "vubam";
  if (n.includes("tatra asset") || n.includes("tatram") || n.includes("tam fond")) return "tatram";
  if (n.includes("erste") || n.includes("slovenská sporiteľňa")) return "erstesk";
  if (n.includes("čsob") && (isin.startsWith("SK") || n.includes("sk") || n.includes("slovensko"))) return "csobsk";
  if (isin.startsWith("LU")) return "amundi";
  if (isin.startsWith("IE")) return "ishares";
  if (isin.startsWith("CZ")) return "czech";
  if (isin.startsWith("SK")) return "slovak";
  return "other";
}

// ── Claude (Anthropic) AI — primární AI backend ───────────────────
// Pokud je nastaven ANTHROPIC_API_KEY, Claude se použije přednostně před Gemini.
// Claude haiku je rychlý a levný; Sonnet pro složitější dotazy.

// Sonnet první — lepší znalosti CZ fondů, haiku jako záloha
const CLAUDE_MODELS = [
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
];

async function callClaude(prompt: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  for (const model of CLAUDE_MODELS) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 512,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(20000),
      });

      if (res.status === 429 || res.status === 529) {
        console.log(`[fund-lookup] Claude ${model}: ${res.status} přetíženo, zkouším další`);
        continue;
      }
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        console.log(`[fund-lookup] Claude ${model}: ${res.status} ${t.slice(0, 150)}`);
        continue;
      }

      const json = await res.json();
      const text: string = json?.content?.[0]?.text ?? "";
      if (text) {
        console.log(`[fund-lookup] Claude: použit model ${model}`);
        return text;
      }
    } catch (e) {
      console.log(`[fund-lookup] Claude ${model} error: ${e}`);
    }
  }
  return null;
}

// ── Claude s built-in web_search nástrojem (Anthropic beta) ─────
// Claude dostane Anthropicův vlastní web_search nástroj — prohledá internet.
// Mnohem lepší než fetch_url na SPA stránky — Claude sám vyhledá relevantní zdroje.
async function callClaudeWithWebSearch(isin: string, providerName = ""): Promise<Partial<FundInfo>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return {};

  const providerCtx = providerName ? `Fond spravuje: ${providerName}.` : "Jde o český nebo slovenský podílový fond.";

  const prompt = `Fond ISIN ${isin}. ${providerCtx}
Vyhledej název fondu, TER/ongoing charges, vstupní poplatek, výstupní poplatek, poplatek za výkonnost, průměrný roční výnos p.a. za 1 rok, 3 roky a 5 let.
Hledej na finex.cz, penize.cz, fondshop.cz, kurzy.cz nebo fondmarket.cz.
Odpověz POUZE jako JSON: ${AI_JSON_SCHEMA}
Pokud hodnotu nenajdeš, použij null.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001", // haiku = ~10× levnější než sonnet
        max_tokens: 512,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.log(`[fund-lookup] ClaudeWebSearch: ${res.status} ${t.slice(0, 200)}`);
      return {};
    }

    const json = await res.json();
    // Prohledej všechny content bloky — Claude vrátí text po tool_use cyklu
    const content: Array<{ type: string; text?: string }> = json?.content ?? [];
    const textBlock = content.find(b => b.type === "text");
    if (textBlock?.text) {
      console.log(`[fund-lookup] ClaudeWebSearch: odpověď="${textBlock.text.slice(0, 300)}"`);
      return parseAiJson(textBlock.text, "Claude web search");
    }
  } catch (e) {
    console.log(`[fund-lookup] ClaudeWebSearch error: ${e}`);
  }
  return {};
}

// ── Claude web search — CZK výnosy pro BE/zahraniční fondy prodávané v ČR ──
// Volá se když Morningstar vrátí EUR výnosy ale fond je CZK-denominovaný (BE ISINy, ČSOB/KBC).
async function callClaudeForCzkReturns(isin: string, fundName = ""): Promise<Partial<FundInfo>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return {};

  const nameCtx = fundName ? ` (${fundName})` : "";
  const prompt = `Fond ISIN ${isin}${nameCtx} je prodáván v České republice přes ČSOB.
Najdi historickou výkonnost tohoto fondu v CZK (korunách) — průměrný roční výnos p.a. za 1 rok, 3 roky a 5 let.
Hledej VÝHRADNĚ na těchto stránkách (zobrazují CZK výnosy):
- https://www.csob.cz/lide/investicni-produkty/nabidka-investic/detail/isin/${isin}/1
- https://www.csobam.cz/portal/podilove-fondy/detail-fondu/-/isin/${isin}/1
Chci výnosy V KORUNÁCH (CZK), ne v EUR.
Odpověz POUZE jako JSON: ${AI_JSON_SCHEMA}
Pokud hodnotu nenajdeš, použij null. Nevymýšlej si čísla.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) { console.log(`[fund-lookup] ClaudeCzkReturns: ${res.status}`); return {}; }
    const json = await res.json();
    const content: Array<{ type: string; text?: string }> = json?.content ?? [];
    const textBlock = content.find(b => b.type === "text");
    if (textBlock?.text) {
      console.log(`[fund-lookup] ClaudeCzkReturns: ${textBlock.text.slice(0, 300)}`);
      const parsed = parseAiJson(textBlock.text, "Claude CZK returns");
      // Vrátíme pouze výnosy (ne TER/poplatky — ty jsou v EUR z Morningstar přesnější)
      return {
        oneYearReturn:   parsed.oneYearReturn,
        threeYearReturn: parsed.threeYearReturn,
        fiveYearReturn:  parsed.fiveYearReturn,
        source: "csob.cz (CZK)",
      };
    }
  } catch (e) { console.log(`[fund-lookup] ClaudeCzkReturns error: ${e}`); }
  return {};
}

// ── Claude s nástrojem pro načítání stránek (tool use) ───────────
// Starý přístup — fetch_url na předpřipravené URL. Ponecháno pro mezinárodní ISINy.
async function callClaudeWithTools(isin: string, providerName = ""): Promise<Partial<FundInfo>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return {};

  const providerCtx = providerName ? `Fond spravuje: ${providerName}.` : "";

  // Připravíme URL kandidáty které Claude může načíst
  const candidateUrls = [
    `https://www.morningstar.cz/cz/funds/SecuritySearchResults.aspx?q=${isin}`,
    `https://fundinfo.com/cs/isin/${isin}`,
    `https://akcie-cz.kurzy.cz/isin/${isin}/`,
    `https://www.fondshop.cz/srovnavac/?isin=${isin}`,
    `https://stooq.pl/q/?s=${isin}`,
  ];

  const tools = [{
    name: "fetch_url",
    description: "Načte obsah webové stránky jako text. Použij pro získání dat o fondu.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL stránky k načtení" },
      },
      required: ["url"],
    },
  }];

  const systemPrompt = `Jsi expert na české a slovenské investiční fondy.
Tvým úkolem je zjistit TER (celkové roční náklady) a výkonnost fondu s ISIN ${isin}.
${providerCtx}

Dostupné URL ke kontrole: ${candidateUrls.join(", ")}

Použij tool fetch_url pro načtení relevantních stránek. Po získání dat vrať POUZE JSON:
{"fundName":"...","provider":"...","fundCategory":"smíšený","riskLevel":3,"ter":1.45,"entryFee":3.0,"exitFee":0,"performanceFee":null,"custodyFee":null,"oneYearReturn":4.5,"threeYearReturn":6.2,"fiveYearReturn":5.8}
Pokud hodnotu nevíš, použij null. Nevymýšlej si čísla.`;

  const messages: Array<{ role: string; content: unknown }> = [
    { role: "user", content: `Jaké jsou poplatky (TER) a výkonnost fondu s ISIN ${isin}? ${providerCtx} Použij dostupné nástroje pro načtení dat a vrať JSON.` },
  ];

  // Agentic loop — max 4 iterace (Claude může načíst více stránek)
  for (let iter = 0; iter < 4; iter++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001", // haiku pro tool use — rychlý a levný
          max_tokens: 1024,
          system: systemPrompt,
          tools,
          messages,
        }),
        signal: AbortSignal.timeout(25000),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        console.log(`[fund-lookup] ClaudeTools iter=${iter}: ${res.status} ${t.slice(0, 150)}`);
        break;
      }

      const json = await res.json();
      const stopReason: string = json.stop_reason ?? "";
      const content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> = json.content ?? [];

      // Claude skončil — extrahuj JSON z textu
      if (stopReason === "end_turn") {
        const textBlock = content.find(b => b.type === "text");
        if (textBlock?.text) {
          console.log(`[fund-lookup] ClaudeTools: odpověď="${textBlock.text.slice(0, 200)}"`);
          return parseAiJson(textBlock.text, "Claude tools");
        }
        break;
      }

      // Claude chce volat tool
      if (stopReason === "tool_use") {
        const toolUseBlocks = content.filter(b => b.type === "tool_use");
        messages.push({ role: "assistant", content });

        const toolResults: Array<{ type: string; tool_use_id: string; content: string }> = [];
        for (const block of toolUseBlocks) {
          if (block.name === "fetch_url" && block.input?.url) {
            const url = String(block.input.url);
            console.log(`[fund-lookup] ClaudeTools: načítám ${url}`);
            try {
              const pageRes = await safeFetch(url, { Referer: new URL(url).origin + "/" }, 12000);
              const pageHtml = pageRes ? await pageRes.text() : "";
              const pageText = pageHtml
                .replace(/<script[\s\S]*?<\/script>/gi, " ")
                .replace(/<style[\s\S]*?<\/style>/gi, " ")
                .replace(/<[^>]+>/g, " ")
                .replace(/\s+/g, " ")
                .slice(0, 8000);
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id ?? "",
                content: pageText || "(stránka nedostupná)",
              });
            } catch {
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id ?? "",
                content: "(chyba při načítání)",
              });
            }
          }
        }
        messages.push({ role: "user", content: toolResults });
        continue; // další iterace
      }

      break; // neznámý stop reason
    } catch (e) {
      console.log(`[fund-lookup] ClaudeTools error: ${e}`);
      break;
    }
  }
  return {};
}

// Společné JSON schéma pro všechny AI prompty
const AI_JSON_SCHEMA = `{"fundName":"...","provider":"správce fondu","fundCategory":"akciový/dluhopisový/smíšený/peněžní","riskLevel":3,"ter":1.45,"entryFee":3.0,"exitFee":0,"performanceFee":null,"custodyFee":null,"oneYearReturn":4.5,"threeYearReturn":6.2,"fiveYearReturn":5.8}`;

// Extrakce dat ze stránky přes Claude
async function callClaudeExtract(pageText: string, isin: string): Promise<Partial<FundInfo>> {
  const trimmed = pageText.slice(0, 6000);
  const prompt = `Zodpověz otázku: Jaké jsou VŠECHNY poplatky a výkonnost fondu s ISIN ${isin}?

Níže je text webové stránky. Extrahuj z něj:
1. fundName — celý název fondu
2. provider — název správce/investiční společnosti
3. fundCategory — typ fondu (akciový, dluhopisový, smíšený, peněžní trh...)
4. riskLevel — SRI rizikový profil 1–7
5. ter — TER / Ongoing charges / průběžné náklady v % ročně
6. entryFee — vstupní poplatek v % (subscription fee, sales charge)
7. exitFee — výstupní poplatek v % (redemption fee)
8. performanceFee — poplatek za výkonnost v %
9. custodyFee — poplatek za úschovu / platformu v % ročně
10. oneYearReturn, threeYearReturn, fiveYearReturn — průměrný roční výnos p.a. v %

Odpověz POUZE jako JSON (bez markdown): ${AI_JSON_SCHEMA}
Pokud hodnotu v textu nenajdeš, použij null.

TEXT:
${trimmed}`;

  const raw = await callClaude(prompt);
  if (!raw) return {};
  return parseAiJson(raw, "Claude extract");
}

// Přímý dotaz na Claude z jeho tréninku (bez scrapování)
async function callClaudeDirect(isin: string, providerName = ""): Promise<Partial<FundInfo>> {
  const providerCtx = providerName
    ? `Fond spravuje: ${providerName}.`
    : "Jde o český nebo slovenský podílový fond.";

  const prompt = `Jaké jsou VŠECHNY poplatky a výkonnost fondu s ISIN ${isin}?

${providerCtx}

Uveď vše co víš o tomto fondu:
1. fundName — celý název fondu
2. provider — investiční společnost / správce
3. fundCategory — typ fondu (akciový, dluhopisový, smíšený, peněžní trh)
4. riskLevel — SRI rizikový profil 1–7
5. ter — TER / ongoing charges / průběžné roční náklady v %
6. entryFee — vstupní poplatek v % (typicky 3–5 % u CZ fondů, 0 % u ETF)
7. exitFee — výstupní poplatek v %
8. performanceFee — poplatek za výkonnost v % (pokud existuje)
9. custodyFee — poplatek za úschovu / platformu v % ročně
10. oneYearReturn, threeYearReturn, fiveYearReturn — průměrný roční výnos p.a. v %

Odpověz POUZE jako JSON (bez markdown): ${AI_JSON_SCHEMA}
Pokud hodnotu s jistotou neznáš, použij null — NEVYMÝŠLEJ si čísla.`;

  const raw = await callClaude(prompt);
  if (!raw) return {};
  return parseAiJson(raw, "Claude direct");
}

// Sdílená logika parsování JSON z AI odpovědi — mapuje všechna pole FundInfo
function parseAiJson(raw: string, label: string): Partial<FundInfo> {
  try {
    // Vyber největší JSON objekt v odpovědi (AI někdy přidá text kolem)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { console.log(`[fund-lookup] ${label}: žádný JSON`); return {}; }
    const parsed = JSON.parse(jsonMatch[0]);
    console.log(`[fund-lookup] ${label}: ${JSON.stringify(parsed)}`);

    const parseFee = (v: unknown, max = 15) => {
      if (v == null) return undefined;
      const n = parseFloat(String(v));
      return !isNaN(n) && n >= 0 && n < max ? Math.round(n * 100) / 100 : undefined;
    };
    const parseRet = (v: unknown) => {
      if (v == null) return undefined;
      const n = parseFloat(String(v));
      return !isNaN(n) && n > -50 && n < 100 ? Math.round(n * 100) / 100 : undefined;
    };
    const parseRisk = (v: unknown) => {
      if (v == null) return undefined;
      const n = parseInt(String(v));
      return !isNaN(n) && n >= 1 && n <= 7 ? n : undefined;
    };

    return {
      name:             parsed?.fundName || parsed?.name || undefined,
      provider:         parsed?.provider || parsed?.fundManager || undefined,
      fundCategory:     parsed?.fundCategory || parsed?.category || parsed?.type || undefined,
      riskLevel:        parseRisk(parsed?.riskLevel ?? parsed?.sri ?? parsed?.risk),
      // Poplatky
      ter:              parseFee(parsed?.ter ?? parsed?.ongoingCharges ?? parsed?.managementFee),
      entryFee:         parseFee(parsed?.entryFee ?? parsed?.subscriptionFee ?? parsed?.vstupniPoplatek, 10),
      exitFee:          parseFee(parsed?.exitFee ?? parsed?.redemptionFee ?? parsed?.vystupniPoplatek, 10),
      performanceFee:   parseFee(parsed?.performanceFee ?? parsed?.poplatekZaVykonnost, 50),
      custodyFee:       parseFee(parsed?.custodyFee ?? parsed?.platformFee, 5),
      // Výkonnost
      oneYearReturn:    parseRet(parsed?.oneYearReturn ?? parsed?.return1Y ?? parsed?.vynosZa1Rok),
      threeYearReturn:  parseRet(parsed?.threeYearReturn ?? parsed?.return3Y ?? parsed?.vynosZa3Roky),
      fiveYearReturn:   parseRet(parsed?.fiveYearReturn ?? parsed?.return5Y ?? parsed?.vynosZa5Let),
    };
  } catch (e) {
    console.log(`[fund-lookup] ${label} parse failed: ${e}`);
    return {};
  }
}

// ── Gemini AI fallback (pokud ANTHROPIC_API_KEY není nastaven) ────
// Spouští se jen pokud Claude selže nebo není k dispozici.
// Načte text stránky a požádá Gemini o extrakci strukturovaných dat.

// Zkusí Gemini modely v pořadí — vrátí první úspěšnou odpověď
// Všechny modely používají v1beta endpoint (v1 byl zrušen/migrován na v1beta)
// Modely jsou seřazeny od nejrychlejšího/nejlevnějšího po nejschopnější
// Každý model má vlastní kvótu — pokud jeden dostane 429, další má svou vlastní kvótu
// Aktuální modely platné v 2026 — 1.5 série je deprecated a vrací 404
// Každý model má VLASTNÍ minutovou kvótu na free tier
const GEMINI_MODELS: { model: string; apiVersion: string }[] = [
  { model: "gemini-2.0-flash-lite",           apiVersion: "v1beta" }, // 30 RPM free
  { model: "gemini-2.0-flash",                apiVersion: "v1beta" }, // 15 RPM free
  // gemini-2.5-flash-preview-04-17 — 404 na v1beta, vynecháno
  { model: "gemini-2.5-pro",                  apiVersion: "v1beta" }, // 2.5 Pro alias
  { model: "gemini-2.5-pro-preview-03-25",    apiVersion: "v1beta" }, // 2.5 Pro versioned
];

async function callGemini(apiKey: string, prompt: string): Promise<string | null> {
  for (const { model, apiVersion } of GEMINI_MODELS) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0 },
          }),
          signal: AbortSignal.timeout(15000),
        }
      );
      if (res.status === 404) { console.log(`[fund-lookup] Gemini model ${model}: 404, zkouším další`); continue; }
      if (res.status === 429) {
        // Každý model má vlastní kvótu — ihned zkoušíme další, nečekáme
        console.log(`[fund-lookup] Gemini model ${model}: 429 kvóta vyčerpána, zkouším další model`);
        continue;
      }
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        console.log(`[fund-lookup] Gemini model ${model}: ${res.status} ${t.slice(0, 150)}`);
        continue;
      }
      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      if (text) { console.log(`[fund-lookup] Gemini: použit model ${model} (${apiVersion})`); return text; }
    } catch (e) {
      console.log(`[fund-lookup] Gemini model ${model} error: ${e}`);
    }
  }
  return null;
}

async function callGeminiExtract(pageText: string, isin: string): Promise<Partial<FundInfo>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return {};

  // Ořezáme text na 6 000 znaků — stačí pro poplatky, ušetří tokeny
  const trimmed = pageText.slice(0, 6000);

  const prompt = `Zodpověz otázku: Jaké jsou VŠECHNY poplatky a výkonnost fondu s ISIN ${isin}?

Níže je text webové stránky. Extrahuj:
1. fundName — celý název fondu
2. provider — správce/investiční společnost
3. fundCategory — typ (akciový, dluhopisový, smíšený, peněžní)
4. riskLevel — SRI 1–7
5. ter — TER/Ongoing charges/průběžné náklady v %
6. entryFee — vstupní poplatek v % (subscription fee, sales charge, vstupní poplatek)
7. exitFee — výstupní poplatek v % (redemption fee, výstupní poplatek)
8. performanceFee — poplatek za výkonnost v %
9. custodyFee — poplatek za úschovu/platformu v % ročně
10. oneYearReturn, threeYearReturn, fiveYearReturn — průměrný roční výnos p.a. v %

Výstup POUZE jako JSON (bez markdown): ${AI_JSON_SCHEMA}
Pokud hodnotu v textu nenajdeš, použij null. Neodhaduj.

TEXT STRÁNKY:
${trimmed}`;

  const rawText = await callGemini(apiKey, prompt);
  if (!rawText) return {};
  return parseAiJson(rawText, "Gemini extract");
}

// Vrátí seznam URL ke scrapování pro Gemini — nejdřív stránky poskytovatele, pak obecné zdroje
function geminiUrlsForProvider(provider: string, isin: string): string[] {
  const p = provider.toLowerCase();
  const providerUrls: string[] = [];

  if (p.includes("conseq")) {
    // Listing stránka Consequ nenačítá ISINy staticky (JavaScript) — použijeme sitemap nebo přímý dotaz
    // Sitemap obsahuje všechny slug URL fondů a bývá statická
    providerUrls.push("https://www.conseq.cz/sitemap.xml");
    providerUrls.push("https://www.conseq.cz/sitemap_index.xml");
  } else if (p.includes("amundi") || p.includes("pioneer")) {
    providerUrls.push(`https://www.amundi.cz/retail/product/view/${isin}`);
    providerUrls.push(`https://www.amundi.lu/professional/product/view/${isin}`);
  } else if (p.includes("csas") || p.includes("erste") || p.includes("sporitelna")) {
    providerUrls.push(`https://www.csas.cz/cs/fondy/${isin}`);
    providerUrls.push(`https://www.erste-am.cz/cs/produkty/fondy/${isin}`);
  } else if (p.includes("csob") && !p.includes("sk")) {
    // csob.cz (banka) má detail fondu s výnosy, csobam.cz je SPA
    providerUrls.push(`https://www.csob.cz/lide/investicni-produkty/nabidka-investic/detail/isin/${isin}/1`);
    providerUrls.push(`https://www.csobam.cz/portal/podilove-fondy/detail-fondu/-/isin/${isin}/1`);
    providerUrls.push(`https://www.csobam.cz/portal/podilove-fondy/detail-fondu/-/isin/${isin.toLowerCase()}/1`);
  } else if (p.includes("kbam") || p.includes("kb") || p.includes("komercni")) {
    providerUrls.push(`https://www.amundi-kb.cz/fondy/detail/${isin}`);
  } else if (p.includes("nn") || p.includes("investment") || p.includes("goldman")) {
    providerUrls.push(`https://czfondy.gs.com/cs/CZ/Institutional/fund/${isin}`);
    providerUrls.push(`https://czfondy.gs.com/cs/CZ/Retail/fund/${isin}`);
  } else if (p.includes("generali")) {
    providerUrls.push("https://www.generali-investments.cz/produkty/uplny-prehled-fondu.html");
  } else if (p.includes("partners")) {
    providerUrls.push("https://www.partnersis.cz/nase-fondy/");
  } else if (p.includes("jtinvest") || p.includes("j&t")) {
    providerUrls.push(`https://www.jtbank.cz/produkty/fondy/${isin}`);
  } else if (p.includes("raiffeisen")) {
    providerUrls.push("https://www.rb.cz/osobni/zhodnoceni-uspor/investicni-fondy/prehled-fondu");
  } else if (p.includes("iscs") || p.includes("erste") || p.includes("sporitelna")) {
    providerUrls.push(`https://www.erste-am.cz/cs/privatni-investori/funds/${isin}`);
  }

  // Obecné záložní zdroje
  return [
    ...providerUrls,
    `https://stooq.pl/q/?s=${isin}`,           // stooq — má SSR data pro mnohé CZ fondy
    `https://www.kurzy.cz/isin/${isin}/`,
    `https://akcie-cz.kurzy.cz/isin/${isin}/`,
    `https://fundinfo.com/cs/isin/${isin}`,
  ];
}

// Mapování klíče poskytovatele na lidsky čitelný název pro Gemini kontext
function providerHint(provider: string): string {
  const map: Record<string, string> = {
    csob:        "ČSOB Asset Management (Československá obchodní banka)",
    kbam:        "Amundi KB (dříve KB Asset Management / Komerční banka)",
    nn:          "Goldman Sachs Asset Management CZ (dříve NN Investment Partners CZ)",
    generali:    "Generali Investments CZ (dříve ČP Invest / Česká pojišťovna)",
    cpinvest:    "Generali Investments CZ (dříve ČP Invest / Česká pojišťovna)",
    iscs:        "Erste Asset Management CZ (dříve ISČS — Investiční společnost České spořitelny)",
    reico:       "REICO investiční společnost České spořitelny (nemovitostní fondy)",
    raiffeisen:  "Raiffeisen Capital Management CZ (Raiffeisen Bank)",
    jtinvest:    "J&T Investiční společnost (J&T Banka)",
    partners:    "Partners investiční společnost",
    conseq:      "Conseq Investment Management",
    iad:         "IAD Investments (slovenský správce fondů)",
    vubam:       "Eurizon Asset Management Slovakia (dříve VÚB Asset Management)",
    tatram:      "Tatra Asset Management (Tatra banka, Slovensko)",
    erstesk:     "Erste Asset Management Slovakia / Slovenská sporiteľňa",
    csobsk:      "ČSOB Asset Management Slovakia",
    czech:       "český podílový fond",
    slovak:      "slovenský podielový fond",
  };
  return map[provider.toLowerCase()] ?? "";
}

// ── Gemini se Search Groundingem — Gemini opravdu vyhledá na Googlu ──
// Google Search grounding je dostupné jen v v1beta a jen pro 2.x modely.
// Vrátí strukturovaná data z textu odpovědi (JSON blok).
async function callGeminiWithSearch(isin: string, providerName = ""): Promise<Partial<FundInfo>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return {};

  const providerCtx = providerName
    ? `Fond spravuje: ${providerName}.`
    : "Jde o český nebo slovenský podílový fond.";

  const prompt = `Vyhledej na internetu aktuální informace o fondu s ISIN ${isin}.

${providerCtx}

Zjisti VŠECHNY dostupné informace:
1. fundName — celý název fondu
2. provider — správce / investiční společnost
3. fundCategory — typ fondu (akciový, dluhopisový, smíšený, peněžní)
4. riskLevel — SRI rizikový profil 1–7
5. ter — TER / Ongoing charges / průběžné roční náklady v %
6. entryFee — vstupní poplatek v %
7. exitFee — výstupní poplatek v %
8. performanceFee — poplatek za výkonnost v %
9. custodyFee — poplatek za úschovu v % ročně
10. oneYearReturn, threeYearReturn, fiveYearReturn — průměrný roční výnos p.a. v %

Hledej zejména na stránkách správce fondu, srovnávačích fondů, nebo v dokumentu KID/KIID.
Odpověz VÝHRADNĚ jako JSON (bez markdown): ${AI_JSON_SCHEMA}
Pokud hodnotu nevíš, použij null. Neodhaduj.`;

  // Modely podporující Google Search grounding — jen 2.x modely, jen v1beta
  const searchModels = [
    "gemini-2.0-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.5-pro",
  ];

  for (const model of searchModels) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            tools: [{ google_search: {} }],
            generationConfig: { temperature: 0 },
          }),
          signal: AbortSignal.timeout(25000),
        }
      );

      if (res.status === 429) {
        // Ihned zkusíme další model — každý má vlastní kvótu
        console.log(`[fund-lookup] GeminiSearch ${model}: 429, zkouším další model`);
        continue;
      }
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        console.log(`[fund-lookup] GeminiSearch ${model}: ${res.status} ${t.slice(0, 150)}`);
        continue;
      }

      const json = await res.json();
      const text: string = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      if (!text) continue;

      console.log(`[fund-lookup] GeminiSearch ${model}: odpověď="${text.slice(0, 300)}"`);
      const result = parseAiJson(text, `GeminiSearch(${model})`);

      if (result.name || result.ter !== undefined || result.oneYearReturn !== undefined) {
        console.log(`[fund-lookup] GeminiSearch HIT: model=${model} ${JSON.stringify(result)}`);
        return result;
      }
      // Odpověď přišla ale neobsahovala data — zkus další model
    } catch (e) {
      console.log(`[fund-lookup] GeminiSearch ${model} error: ${e}`);
    }
  }
  return {};
}

// Zeptá se Gemini přímo na fond podle ISIN — bez scrapování, z tréninku modelu
// providerName = nápověda odkud fond pochází (zlepšuje přesnost)
async function callGeminiDirect(isin: string, providerName = ""): Promise<Partial<FundInfo>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return {};

  const providerCtx = providerName
    ? `Fond je spravován společností: ${providerName}.`
    : "Fond je z České republiky nebo Slovenska.";

  const prompt = `Jaké jsou VŠECHNY poplatky a výkonnost fondu s ISIN ${isin}?

${providerCtx}

Identifikuj fond a uveď:
1. fundName — celý název, provider — správce, fundCategory — typ, riskLevel — SRI 1–7
2. ter — TER/ongoing charges v %, entryFee — vstupní poplatek %, exitFee — výstupní %
3. performanceFee — poplatek za výkonnost %, custodyFee — poplatek za úschovu %
4. oneYearReturn, threeYearReturn, fiveYearReturn — průměrný roční výnos p.a. v %

Výstup POUZE jako JSON: ${AI_JSON_SCHEMA}
Pokud hodnotu neznáš, použij null. Preferuj data 2023–2025. NEVYMÝŠLEJ si čísla.`;

  const rawText = await callGemini(apiKey, prompt);
  if (!rawText) return {};
  return parseAiJson(rawText, "Gemini direct");
}

// Zkusí stáhnout stránky a předat text AI (Claude nebo Gemini);
// pokud stránky nepomůžou, zeptá se AI přímo z tréninku.
async function geminiLookup(isin: string, provider = ""): Promise<Partial<FundInfo>> {
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
  const hasGeminiKey = !!process.env.GEMINI_API_KEY;

  if (!hasAnthropicKey && !hasGeminiKey) {
    console.log("[fund-lookup] AI: žádný API klíč (ANTHROPIC_API_KEY ani GEMINI_API_KEY) — přeskakuji");
    return {};
  }

  const hint = providerHint(provider);
  const isCzSk = isin.startsWith("CZ") || isin.startsWith("SK");

  console.log(`[fund-lookup] AI: spouštím fallback pro ${isin} (provider="${provider}" isCzSk=${isCzSk})`);

  // ── Pro CZ/SK ISINy: přeskočíme scraping (weby jsou SPA, vrátí prázdné HTML) ──
  // Pořadí: Claude Web Search → Gemini Search Grounding → přímé dotazy
  if (isCzSk) {
    // Krok 1: Claude s built-in web_search (Anthropic beta) — nejlepší volba s placeným API
    if (hasAnthropicKey) {
      console.log(`[fund-lookup] Claude Web Search: hledám ${isin}`);
      const webResult = await callClaudeWithWebSearch(isin, hint);
      if (webResult.ter !== undefined || webResult.oneYearReturn !== undefined ||
          (webResult.name && webResult.entryFee !== undefined)) {
        console.log(`[fund-lookup] Claude Web Search HIT: ${JSON.stringify(webResult)}`);
        return { ...webResult, source: "Claude AI (web search)" };
      }
      // Pokud našel jen jméno bez čísel, uložíme pro merge níže
      if (webResult.name) {
        console.log(`[fund-lookup] Claude Web Search: pouze název, zkouším Gemini Search pro poplatky`);
      }
    }

    // Krok 2: Gemini Search Grounding — prohledá Google
    if (hasGeminiKey) {
      console.log(`[fund-lookup] Gemini Search: hledám ${isin} na Googlu`);
      const searchResult = await callGeminiWithSearch(isin, hint);
      if (searchResult.ter !== undefined || searchResult.name || searchResult.oneYearReturn !== undefined) {
        console.log(`[fund-lookup] Gemini Search HIT: ${JSON.stringify(searchResult)}`);
        return { ...searchResult, source: "Gemini AI (Google Search)" };
      }
    }

    // Krok 3: Claude přímý dotaz z tréninku — záloha
    if (hasAnthropicKey) {
      console.log(`[fund-lookup] Claude přímý dotaz: ${isin} (hint="${hint}")`);
      const claudeDirect = await callClaudeDirect(isin, hint);
      if (claudeDirect.ter !== undefined || claudeDirect.name || claudeDirect.oneYearReturn !== undefined) {
        return { ...claudeDirect, source: "Claude AI (přímý dotaz)" };
      }
    }

    // Krok 4: Gemini přímý dotaz z tréninku (záloha)
    if (hasGeminiKey) {
      console.log(`[fund-lookup] Gemini přímý dotaz: ${isin}`);
      const direct = await callGeminiDirect(isin, hint);
      if (direct.ter !== undefined || direct.name || direct.oneYearReturn !== undefined) {
        return { ...direct, source: "Gemini AI (přímý dotaz)" };
      }
    }

    return {};
  }

  // ── Pro mezinárodní ISINy (LU, IE, US...): scraping může fungovat ──
  const urlsToTry = geminiUrlsForProvider(provider, isin);

  for (const url of urlsToTry) {
    try {
      const res = await safeFetch(url, { Referer: new URL(url).origin + "/" }, 8000);
      if (!res) { console.log(`[fund-lookup] AI scrape: ${url} — nedostupné`); continue; }
      const html = await res.text();
      if (!html.toLowerCase().includes(isin.toLowerCase())) {
        console.log(`[fund-lookup] AI scrape: ${url} — ISIN nenalezeno`);
        continue;
      }
      console.log(`[fund-lookup] AI scrape: ${url} — zpracovávám (${html.length} znaků)`);

      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/\s+/g, " ")
        .trim();

      const hostname = new URL(url).hostname;
      if (hasAnthropicKey) {
        const claudeResult = await callClaudeExtract(text, isin);
        if (claudeResult.ter !== undefined || claudeResult.name || claudeResult.oneYearReturn !== undefined) {
          return { ...claudeResult, source: `Claude AI (${hostname})` };
        }
      }
      if (hasGeminiKey) {
        const geminiResult = await callGeminiExtract(text, isin);
        if (geminiResult.ter !== undefined || geminiResult.name || geminiResult.oneYearReturn !== undefined) {
          return { ...geminiResult, source: `Gemini AI (${hostname})` };
        }
      }
    } catch { continue; }
  }

  // Přímý dotaz pro mezinárodní ISINy
  if (hasAnthropicKey) {
    const claudeDirect = await callClaudeDirect(isin, hint);
    if (claudeDirect.ter !== undefined || claudeDirect.name || claudeDirect.oneYearReturn !== undefined) {
      return { ...claudeDirect, source: "Claude AI (přímý dotaz)" };
    }
  }
  if (hasGeminiKey) {
    const searchResult = await callGeminiWithSearch(isin, hint);
    if (searchResult.ter !== undefined || searchResult.name || searchResult.oneYearReturn !== undefined) {
      return { ...searchResult, source: "Gemini AI (Google Search)" };
    }
    const direct = await callGeminiDirect(isin, hint);
    if (direct.ter !== undefined || direct.name || direct.oneYearReturn !== undefined) {
      return { ...direct, source: "Gemini AI (přímý dotaz)" };
    }
  }

  return {};
}

// ── Mapování explicitního parametru poskytovatele ────────────────
function getProviderScraper(provider: string, isin: string): Promise<Partial<FundInfo>> {
  switch (provider.toLowerCase()) {
    // Czech
    case "amundi":    return amundiScrape(isin);
    case "ishares":   return iSharesLookup(isin);
    case "conseq":    return conseqScrape(isin);
    case "cpinvest":  return cpinvestScrape(isin);
    case "csob":      return csobamScrape(isin);
    case "reico":     return reicoScrape(isin);
    case "kbam":      return kbamScrape(isin);
    case "nn":        return nnGsamScrape(isin);
    case "generali":    return generaliScrape(isin);
    case "jtinvest":    return jtinvestScrape(isin);
    case "raiffeisen":  return raiffeisenScrape(isin);
    case "iscs":        return iscsScrape(isin);
    case "partners":    return partnersScrape(isin);
    // Slovak
    case "iad":         return iadScrape(isin);
    case "vubam":       return vubamScrape(isin);
    case "tatram":      return tatramScrape(isin);
    case "erstesk":     return ersteSkScrape(isin);
    case "csobsk":      return csobSkScrape(isin);
    case "slovak":      return skFundFallback(isin);
    default:            return Promise.resolve({});
  }
}

function validTer(v: number | undefined): number | undefined {
  return v != null && !isNaN(v) && v > 0 && v < 15 ? v : undefined;
}

// ── Hlavní handler ───────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("q")?.trim();
  const providerParam = req.nextUrl.searchParams.get("provider")?.trim() ?? "";

  if (!query || query.length < 2) {
    return NextResponse.json({ error: "Zadej ISIN nebo název fondu" }, { status: 400 });
  }

  const isIsin = /^[A-Z]{2}[A-Z0-9]{10}$/i.test(query);
  const isin = isIsin ? query.toUpperCase() : "";
  console.log(`[fund-lookup] query="${query}" isIsin=${isIsin} provider="${providerParam}"`);

  // Cache: klíč = ISIN (provider se ignoruje — výsledek se sdílí)
  const cacheKey = isin || query;
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[fund-lookup] cache HIT pro ${cacheKey}`);
    return NextResponse.json(cached);
  }

  try {
    // ── Fáze 1: Morningstar screener + CZ/SK widget + Yahoo + justetf — paralelně ──
    const isCzIsin = isin.startsWith("CZ");
    const isSkIsin = isin.startsWith("SK");
    const isLocalIsin = isCzIsin || isSkIsin;
    // BE ISINy jsou belgické fondy prodávané v ČR — typicky denominované v CZK (KBC/ČSOB)
    const isBelgianIsin = isin.startsWith("BE");
    const [msEN, msLocalWidget, msCzScreener, msCzkScreener, ticker, justEtf] = await Promise.all([
      // Pro mezinárodní ISINy (LU, IE...) použij globální screener v EUR
      isIsin && !isLocalIsin ? morningstarScreener(isin, "en-GB", "EUR") : Promise.resolve<MsScreenerResult>({}),
      // CZ/SK ISINy → lokální Morningstar widget (má SecId pro detail stránku)
      isIsin && isCzIsin ? morningstarCzSearch(isin)
        : isIsin && isSkIsin ? morningstarSkSearch(isin)
        : Promise.resolve<MsScreenerResult>({}),
      // CZ ISINy → Morningstar screener s českou lokalizací (cs-CZ, CZK)
      isIsin && isCzIsin ? morningstarScreener(isin, "cs-CZ", "CZK")
        : isIsin && isSkIsin ? morningstarScreener(isin, "sk-SK", "EUR")
        : Promise.resolve<MsScreenerResult>({}),
      // BE ISINy (ČSOB/KBC fondy) → screener en-GB ale s CZK měnou pro správné korunové výnosy
      isIsin && isBelgianIsin ? morningstarScreener(isin, "en-GB", "CZK") : Promise.resolve<MsScreenerResult>({}),
      yahooSearch(query),
      isIsin && !isLocalIsin ? justEtfLookup(isin) : Promise.resolve({}),
    ]);
    console.log(`[fund-lookup] phase1: msEN=${JSON.stringify(msEN)} msLocal=${JSON.stringify(msLocalWidget)} msCZK=${JSON.stringify(msCzkScreener)} ticker=${ticker}`);

    const msName = msEN.name || msCzkScreener.name || msLocalWidget.name || msCzScreener.name || "";
    const autoProvider = detectProvider(isin, msName || ticker || "");
    const effectiveProvider = providerParam || autoProvider;

    // ── Fáze 2: Yahoo detail, výkonnost, provider scraper, kurzy.cz, multi-universe ──
    // morningstarMultiUniverse se teď volá i pro CZ/SK ISINy — má český universe FOCZZ$$ALL
    const needMultiUniverse = isIsin && !msLocalWidget.ter;
    const needProviderScrape = isIsin && effectiveProvider !== "other" && effectiveProvider !== "czech" && effectiveProvider !== "slovak";

    const [yahooSum, yahooRet, msCZ, providerData, kurzyData] = await Promise.all([
      ticker ? yahooDetail(ticker) : Promise.resolve({}),
      ticker ? yahooReturns(ticker) : Promise.resolve({}),
      // Pokud nemáme TER z lokálního widgetu, zkusíme multi-universe + nový morningstar.com search paralelně
      needMultiUniverse
        ? Promise.all([morningstarMultiUniverse(isin), morningstarComSearch(isin)])
            .then(([multi, com]) => {
              console.log(`[fund-lookup] msMulti=${JSON.stringify(multi)} msCom=${JSON.stringify(com)}`);
              // Preferuj multi pokud má TER nebo secId, jinak com
              if (multi.ter !== undefined || multi.secId || multi.name) return multi;
              return com;
            })
        : Promise.resolve<MsScreenerResult>({}),
      needProviderScrape ? getProviderScraper(effectiveProvider, isin) : Promise.resolve({}),
      // Pro CZ/SK ISINy zkus kurzy.cz + fondshop + fundinfo + patria + penize paralelně
      isLocalIsin && !msLocalWidget.ter
        ? Promise.all([
            kurzyCzLookup(isin),
            fondshopLookup(isin),
            fundinfoLookup(isin),
            isCzIsin ? patriaLookup(isin) : Promise.resolve({}),
            isCzIsin ? penizeLookup(isin) : Promise.resolve({}),
          ]).then((sources) => {
            // Preferuj zdroj s TER, pak s názvem
            for (const src of sources) {
              if ((src as Partial<FundInfo>).ter !== undefined) return src;
            }
            for (const src of sources) {
              if ((src as Partial<FundInfo>).name) return src;
            }
            return {};
          })
        : Promise.resolve({}),
    ]);
    console.log(`[fund-lookup] phase2: provider=${effectiveProvider} providerData=${JSON.stringify(providerData)} msCZ=${JSON.stringify(msCZ)} msLocalWidget=${JSON.stringify(msLocalWidget)} kurzy=${JSON.stringify(kurzyData)}`);

    // ── Fáze 3: pokud stále nemáme TER a máme SecId, zkusíme fund page ──
    const secId = msLocalWidget.secId || msCzScreener.secId || msCzkScreener.secId || msEN.secId || (msCZ as MsScreenerResult).secId;
    const hasTer = validTer(msEN.ter) || validTer(msCzkScreener.ter) || validTer(msLocalWidget.ter) ||
                   validTer(msCzScreener.ter) ||
                   validTer((msCZ as Partial<FundInfo>).ter) ||
                   validTer((providerData as Partial<FundInfo>).ter) ||
                   validTer((justEtf as Partial<FundInfo>).ter) ||
                   validTer((kurzyData as Partial<FundInfo>).ter);
    // Načti Morningstar detail stránku pokud máme secId a chybí TER NEBO výnosy
    const hasYahooReturns = [yahooRet].some(s => (s as Partial<FundInfo>).oneYearReturn !== undefined);
    const msFundPage = (secId && (!hasTer || !hasYahooReturns)) ? await morningstarFundPage(secId) : {};

    // ── Fáze 4: Gemini AI fallback pro CZ/SK ISINy ───────────────────
    const hasTerAfterP3 = hasTer || validTer((msFundPage as Partial<FundInfo>).ter);
    // Zkontroluj jestli máme výnosy z dosavadních zdrojů
    const hasReturns = [msCzkScreener, msEN, providerData, msFundPage, msLocalWidget, msCZ]
      .some(s => (s as Partial<FundInfo>).oneYearReturn !== undefined ||
                 (s as Partial<FundInfo>).threeYearReturn !== undefined ||
                 (s as Partial<FundInfo>).fiveYearReturn !== undefined);
    // Gemini spustíme pokud chybí TER NEBO výnosy — české fondy nejsou na Yahoo
    // Gemini dostane nápovědu o poskytovateli (providerHint) pro lepší výsledky
    const needGemini = isIsin && (isin.startsWith("CZ") || isin.startsWith("SK")) &&
                       (!hasTerAfterP3 || !hasReturns);
    const geminiData = needGemini
      ? await geminiLookup(isin, effectiveProvider)
      : {};

    // ── Fáze 4b: Claude Web Search pro CZK výnosy u BE fondů prodávaných v ČR ──
    // Morningstar vrací EUR výnosy pro BE ISINy. Fond s currency=CZK potřebuje výnosy v CZK.
    // Claude prohledá csob.cz a csobam.cz přímo.
    const fundCurrency = msEN.currency || msCzkScreener.currency || (msCZ as Partial<FundInfo>).currency;
    const hasAnthropicKeyLocal = !!process.env.ANTHROPIC_API_KEY;
    const needCzkReturns = isIsin && isBelgianIsin && fundCurrency === "CZK" && hasAnthropicKeyLocal;
    console.log(`[fund-lookup] needCzkReturns=${needCzkReturns} (isBE=${isBelgianIsin} currency=${fundCurrency} hasKey=${hasAnthropicKeyLocal})`);
    const czkReturnsData = needCzkReturns
      ? await callClaudeForCzkReturns(isin, msEN.name || msCzkScreener.name || "")
      : {};

    // ── Sestavíme výsledek ───────────────────────────────────────────
    const terSources = [
      { src: (providerData as Partial<FundInfo>).source ?? effectiveProvider, val: validTer((providerData as Partial<FundInfo>).ter) },
      { src: "Morningstar CZ",      val: validTer(msLocalWidget.ter) },
      { src: "Morningstar screener", val: validTer(msCzScreener.ter) },
      { src: "Morningstar",         val: validTer(msEN.ter) },
      { src: "Morningstar page",    val: validTer((msFundPage as Partial<FundInfo>).ter) },
      { src: "Morningstar multi",   val: validTer((msCZ as Partial<FundInfo>).ter) },
      { src: (kurzyData as Partial<FundInfo>).source ?? "kurzy.cz", val: validTer((kurzyData as Partial<FundInfo>).ter) },
      { src: "justetf.com",         val: validTer((justEtf as Partial<FundInfo>).ter) },
      { src: "Yahoo Finance",       val: validTer((yahooSum as Partial<FundInfo>).ter) },
      { src: (geminiData as Partial<FundInfo>).source ?? "Gemini AI", val: validTer((geminiData as Partial<FundInfo>).ter) },
    ];

    const bestTer = terSources.find((t) => t.val !== undefined);
    const ter = bestTer?.val;

    const name =
      (providerData as Partial<FundInfo>).name ||
      msLocalWidget.name ||
      msCzScreener.name ||
      msCzkScreener.name ||
      msEN.name ||
      (msCZ as Partial<FundInfo>).name ||
      (kurzyData as Partial<FundInfo>).name ||
      (msFundPage as Partial<FundInfo>).name ||
      (justEtf as Partial<FundInfo>).name ||
      (yahooSum as Partial<FundInfo>).name ||
      (geminiData as Partial<FundInfo>).name ||
      ticker || query;

    const currency =
      msLocalWidget.currency ||
      msCzkScreener.currency ||
      msEN.currency ||
      msCzScreener.currency ||
      (msCZ as Partial<FundInfo>).currency ||
      (justEtf as Partial<FundInfo>).currency ||
      (yahooSum as Partial<FundInfo>).currency;

    if (!name && ter === undefined) {
      return NextResponse.json(
        {
          error: "Fond nenalezen ani v jednom zdroji",
          hint: "Fond pravděpodobně není ve veřejných databázích. Poplatky najdeš v dokumentu KIID (Key Investor Information Document) — hledej řádek 'Ongoing charges' nebo 'Roční náklady'.",
        },
        { status: 404 }
      );
    }

    const sources = terSources.filter((t) => t.val !== undefined).map((t) => t.src);
    if (ticker && !sources.includes("Yahoo Finance")) sources.push("Yahoo Finance");

    console.log(`[fund-lookup] RESULT: name="${name}" ter=${ter} sources=${sources.join(", ")}`);

    // Výkonnost a poplatky: priorita: czkReturnsData (ČSOB CZK) > msCzkScreener > Yahoo > msEN (EUR) > provider > Morningstar detail > Gemini/Claude AI
    const allSources = [czkReturnsData, msCzkScreener, yahooRet, msEN, providerData, msFundPage, geminiData, msLocalWidget, msCzScreener, msCZ, kurzyData];

    const pickNum = (key: keyof FundInfo) => {
      for (const s of allSources) {
        const v = (s as Partial<FundInfo>)[key];
        if (v !== undefined && v !== null && !isNaN(v as number)) return v as number;
      }
      return undefined;
    };

    const pickStr = (key: keyof FundInfo) => {
      for (const s of allSources) {
        const v = (s as Partial<FundInfo>)[key];
        if (v) return v as string;
      }
      return undefined;
    };

    const result: FundInfo = {
      name,
      ticker: ticker || undefined,
      isin: isIsin ? isin : undefined,
      currency,
      ter,
      source: sources.join(" + ") || "veřejné zdroje",
      // Poplatky — primárně z Claude/Gemini AI pro CZ/SK fondy
      entryFee:       pickNum("entryFee"),
      exitFee:        pickNum("exitFee"),
      performanceFee: pickNum("performanceFee"),
      custodyFee:     pickNum("custodyFee"),
      // Metadata
      provider:       pickStr("provider"),
      fundCategory:   pickStr("fundCategory"),
      riskLevel:      pickNum("riskLevel"),
      // Výkonnost
      oneYearReturn:   pickNum("oneYearReturn"),
      threeYearReturn: pickNum("threeYearReturn"),
      fiveYearReturn:  pickNum("fiveYearReturn"),
    };

    setCached(cacheKey, result);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[fund-lookup] error:", err);
    return NextResponse.json({ error: "Chyba při hledání fondu" }, { status: 500 });
  }
}
