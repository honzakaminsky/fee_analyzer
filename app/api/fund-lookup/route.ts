import { NextRequest, NextResponse } from "next/server";
import { FundInfo } from "@/lib/types";

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
  const patterns: RegExp[] = [
    /ongoing charges[^%\d]{0,60}([\d]+[,.][\d]+)\s*%/gi,
    /total expense ratio[^%\d]{0,60}([\d]+[,.][\d]+)\s*%/gi,
    /roční náklady[^%\d]{0,60}([\d]+[,.][\d]+)\s*%/gi,
    /celkové náklady[^%\d]{0,60}([\d]+[,.][\d]+)\s*%/gi,
    /náklady fondu[^%\d]{0,60}([\d]+[,.][\d]+)\s*%/gi,
    /"ongoingCharge"\s*:\s*"?([\d.]+)"?/i,
    /"ter"\s*:\s*"?([\d.]+)"?/i,
    /TER[^%\d]{0,30}([\d]+[,.][\d]+)\s*%/gi,
    /management fee[^%\d]{0,30}([\d]+[,.][\d]+)\s*%/gi,
    /expense ratio[^%\d]{0,30}([\d]+[,.][\d]+)\s*%/gi,
    /poplatek za správu[^%\d]{0,40}([\d]+[,.][\d]+)\s*%/gi,
  ];

  for (const pattern of patterns) {
    const gp = new RegExp(pattern.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = gp.exec(html)) !== null) {
      const val = parseFloat((m[1] || "").replace(",", "."));
      if (val > 0 && val < 15) return Math.round(val * 100) / 100;
    }
  }
  return undefined;
}

function extractNameFromHtml(html: string): string | undefined {
  const h1 = html.match(/<h1[^>]*>\s*([^<]{5,}?)\s*<\/h1>/i);
  const title = html.match(/<title>\s*([^|<\-]{5,}?)\s*[|<\-]/i);
  const og = html.match(/property="og:title"\s+content="([^"]+)"/i) ||
             html.match(/content="([^"]+)"\s+property="og:title"/i);
  const raw = (h1?.[1] || og?.[1] || title?.[1] || "").trim();
  return raw.length > 3 ? raw : undefined;
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
      oneYearReturn:   valid.length >= 13 ? calc(valid[valid.length - 13], 1)  : undefined,
      threeYearReturn: valid.length >= 37 ? calc(valid[valid.length - 37], 3)  : undefined,
      fiveYearReturn:  valid.length >= 60 ? calc(valid[valid.length - 60], 5)  : undefined,
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
  const url = `https://lt.morningstar.com/api/rest.svc/klr5zyak8x/security/screener?page=1&pageSize=10&outputType=json&version=1&languageId=${locale}&localeId=${locale}&currencyId=${currencyId}&securityDataPoints=SecId,Name,Ticker,iSIN,OngoingCharge,Currency&term=${encodeURIComponent(isin)}`;
  try {
    const res = await safeFetch(url, { Referer: "https://www.morningstar.co.uk/", "X-Requested-With": "XMLHttpRequest" });
    if (!res) return {};
    const data = await res.json();
    const rows: Record<string, unknown>[] = data?.rows ?? [];
    const hit = rows.find((r) => String(r.iSIN).toUpperCase() === isin.toUpperCase()) ?? rows[0];
    if (!hit) return {};
    const rawTer = hit.OngoingCharge as string | null | undefined;
    const terNum = rawTer != null && rawTer !== "" ? parseFloat(String(rawTer)) : NaN;
    return {
      name: hit.Name as string | undefined,
      currency: hit.Currency as string | undefined,
      ter: !isNaN(terNum) ? Math.round(terNum * 100) / 100 : undefined,
      secId: hit.SecId as string | undefined,
    };
  } catch { return {}; }
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
      if (ter !== undefined) return { ter, source: "Morningstar" };
    } catch { continue; }
  }
  return {};
}

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
    const url = `https://lt.morningstar.com/api/rest.svc/klr5zyak8x/security/screener?page=1&pageSize=10&outputType=json&version=1&languageId=${cfg.locale}&localeId=${cfg.locale}&currencyId=${cfg.currency}&universeIds=${cfg.universes}&securityDataPoints=SecId,Name,Ticker,iSIN,OngoingCharge,Currency&term=${encodeURIComponent(isin)}`;
    try {
      const res = await safeFetch(url, { Referer: "https://www.morningstar.cz/", "X-Requested-With": "XMLHttpRequest" });
      if (!res) continue;
      const data = await res.json();
      const rows: Record<string, unknown>[] = data?.rows ?? [];
      const hit = rows.find((r) => String(r.iSIN).toUpperCase() === isin.toUpperCase()) ?? rows[0];
      if (!hit) continue;
      const rawTer = hit.OngoingCharge as string | null | undefined;
      const terNum = rawTer != null && rawTer !== "" ? parseFloat(String(rawTer)) : NaN;
      if (hit.Name || !isNaN(terNum)) {
        return {
          name: hit.Name as string | undefined,
          currency: hit.Currency as string | undefined,
          ter: !isNaN(terNum) ? Math.round(terNum * 100) / 100 : undefined,
          secId: hit.SecId as string | undefined,
        };
      }
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
    `https://fundinfo.com/en/isin/${isin}`,
    `https://fundinfo.com/cs/isin/${isin}`,
  ];
  for (const url of urls) {
    const res = await safeFetch(url, { Referer: "https://fundinfo.com/" }, 10000);
    if (!res) continue;
    try {
      const html = await res.text();
      const ter = extractTerFromHtml(html);
      const nameMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i) || html.match(/<title>\s*([^|<\-]+)/i);
      const name = nameMatch ? nameMatch[1].trim() : undefined;
      if (ter !== undefined || name) return { name, ter, source: "fundinfo.com" };
    } catch { continue; }
  }
  return {};
}

// ── ČP Invest ─────────────────────────────────────────────────────
async function cpinvestScrape(isin: string): Promise<Partial<FundInfo>> {
  const urls = [
    `https://www.cpinvest.cz/podilove-fondy/?isin=${isin}`,
    `https://www.cpinvest.cz/fondy/?isin=${isin}`,
  ];
  for (const url of urls) {
    const res = await safeFetch(url, { Referer: "https://www.cpinvest.cz/" }, 10000);
    if (!res) continue;
    try {
      const html = await res.text();
      const ter = extractTerFromHtml(html);
      const name = extractNameFromHtml(html);
      if (ter !== undefined || name) return { name, ter, source: "cpinvest.cz" };
    } catch { continue; }
  }
  return {};
}

// ── ČSOB Asset Management ─────────────────────────────────────────
async function csobamScrape(isin: string): Promise<Partial<FundInfo>> {
  const urls = [
    `https://www.csobam.cz/podilove-fondy/?isin=${isin}`,
    `https://www.csobam.cz/fondy/?search=${isin}`,
  ];
  for (const url of urls) {
    const res = await safeFetch(url, { Referer: "https://www.csobam.cz/" }, 10000);
    if (!res) continue;
    try {
      const html = await res.text();
      const ter = extractTerFromHtml(html);
      const name = extractNameFromHtml(html);
      if (ter !== undefined || name) return { name, ter, source: "csobam.cz" };
    } catch { continue; }
  }
  return {};
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

// ── Conseq ────────────────────────────────────────────────────────
async function conseqScrape(isin: string): Promise<Partial<FundInfo>> {
  const urls = [
    `https://www.conseq.cz/cs/fondy-a-produkty/podilove-fondy/?isin=${isin}`,
    `https://www.conseq.cz/cs/fondy-a-produkty/investicni-fondy/?isin=${isin}`,
  ];
  for (const url of urls) {
    const res = await safeFetch(url, { Referer: "https://www.conseq.cz/" }, 10000);
    if (!res) continue;
    try {
      const html = await res.text();
      const ter = extractTerFromHtml(html);
      const name = extractNameFromHtml(html);
      if (ter !== undefined || name) return { name, ter, source: "conseq.cz" };
    } catch { continue; }
  }
  return {};
}

// ── KB Asset Management ───────────────────────────────────────────
async function kbamScrape(isin: string): Promise<Partial<FundInfo>> {
  const urls = [
    `https://www.kb-am.cz/fondy/?isin=${isin}`,
    `https://www.kb.cz/cs/fondy-kb/?isin=${isin}`,
  ];
  for (const url of urls) {
    const res = await safeFetch(url, { Referer: "https://www.kb-am.cz/" }, 10000);
    if (!res) continue;
    try {
      const html = await res.text();
      const ter = extractTerFromHtml(html);
      const name = extractNameFromHtml(html);
      if (ter !== undefined || name) return { name, ter, source: "kb-am.cz" };
    } catch { continue; }
  }
  return {};
}

// ── NN Investment Partners / Goldman Sachs AM ────────────────────
async function nnGsamScrape(isin: string): Promise<Partial<FundInfo>> {
  const urls = [
    `https://www.nninvestmentpartners.cz/investment-products/${isin}`,
    `https://www.gsam.com/content/gsam/cz/cs/advisors/products/mutual-funds.html?isin=${isin}`,
    `https://www.nninvestmentpartners.cz/producten/?isin=${isin}`,
  ];
  for (const url of urls) {
    const res = await safeFetch(url, { Referer: "https://www.nninvestmentpartners.cz/" }, 10000);
    if (!res) continue;
    try {
      const html = await res.text();
      const ter = extractTerFromHtml(html);
      const name = extractNameFromHtml(html);
      if (ter !== undefined || name) return { name, ter, source: "NN/GSAM" };
    } catch { continue; }
  }
  return {};
}

// ── Generali Investments ──────────────────────────────────────────
async function generaliScrape(isin: string): Promise<Partial<FundInfo>> {
  const urls = [
    `https://www.generali-investments.cz/fondy/?isin=${isin}`,
    `https://www.generali-investments.cz/produkty/fondy/`,
  ];
  for (const url of urls) {
    const res = await safeFetch(url, { Referer: "https://www.generali-investments.cz/" }, 10000);
    if (!res) continue;
    try {
      const html = await res.text();
      if (!html.toLowerCase().includes(isin.toLowerCase()) && url.endsWith("/")) continue;
      const ter = extractTerFromHtml(html);
      const name = extractNameFromHtml(html);
      if (ter !== undefined || name) return { name, ter, source: "generali-investments.cz" };
    } catch { continue; }
  }
  return {};
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
  if (n.includes("kb asset") || n.includes("kb am") || n.includes("komerční banka")) return "kbam";
  if (n.includes("nn investment") || n.includes("nn invest") || n.includes("goldman sachs am")) return "nn";
  if (n.includes("generali")) return "generali";
  if (isin.startsWith("LU")) return "amundi";
  if (isin.startsWith("IE")) return "ishares";
  if (isin.startsWith("CZ")) return "czech";
  return "other";
}

// ── Mapování explicitního parametru poskytovatele ────────────────
function getProviderScraper(provider: string, isin: string): Promise<Partial<FundInfo>> {
  switch (provider.toLowerCase()) {
    case "amundi":    return amundiScrape(isin);
    case "ishares":   return iSharesLookup(isin);
    case "conseq":    return conseqScrape(isin);
    case "cpinvest":  return cpinvestScrape(isin);
    case "csob":      return csobamScrape(isin);
    case "reico":     return reicoScrape(isin);
    case "kbam":      return kbamScrape(isin);
    case "nn":        return nnGsamScrape(isin);
    case "generali":  return generaliScrape(isin);
    default:          return Promise.resolve({});
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

  try {
    // ── Fáze 1: Morningstar screener (EN) + Yahoo search + justetf — paralelně ──
    const [msEN, ticker, justEtf] = await Promise.all([
      isIsin ? morningstarScreener(isin, "en-GB", "EUR") : Promise.resolve<MsScreenerResult>({}),
      yahooSearch(query),
      isIsin ? justEtfLookup(isin) : Promise.resolve({}),
    ]);
    console.log(`[fund-lookup] phase1: msEN=${JSON.stringify(msEN)} ticker=${ticker}`);

    const msName = msEN.name || "";
    const autoProvider = detectProvider(isin, msName || ticker || "");
    const effectiveProvider = providerParam || autoProvider;

    // ── Fáze 2: Paralelně — Yahoo detail, CZ Morningstar, provider scraper ──
    const needCzMorningstar = isIsin && !msEN.ter;
    const needProviderScrape = isIsin && effectiveProvider !== "other";

    const [yahooSum, yahooRet, msCZ, providerData] = await Promise.all([
      ticker ? yahooDetail(ticker) : Promise.resolve({}),
      ticker ? yahooReturns(ticker) : Promise.resolve({}),
      needCzMorningstar ? morningstarMultiUniverse(isin) : Promise.resolve<MsScreenerResult>({}),
      needProviderScrape ? getProviderScraper(effectiveProvider, isin) : Promise.resolve({}),
    ]);
    console.log(`[fund-lookup] phase2: provider=${effectiveProvider} providerData=${JSON.stringify(providerData)} msCZ=${JSON.stringify(msCZ)}`);

    // ── Fáze 3: pokud stále nemáme TER a máme SecId, zkusíme fund page ──
    const secId = msEN.secId || (msCZ as MsScreenerResult).secId;
    const hasTer = validTer(msEN.ter) || validTer((msCZ as Partial<FundInfo>).ter) ||
                   validTer((providerData as Partial<FundInfo>).ter) || validTer((justEtf as Partial<FundInfo>).ter);
    const msFundPage = (!hasTer && secId)
      ? await morningstarFundPage(secId)
      : {};

    // ── Sestavíme výsledek ───────────────────────────────────────────
    const terSources = [
      { src: (providerData as Partial<FundInfo>).source ?? effectiveProvider, val: validTer((providerData as Partial<FundInfo>).ter) },
      { src: "Morningstar",     val: validTer(msEN.ter) },
      { src: "Morningstar CZ",  val: validTer((msCZ as Partial<FundInfo>).ter) },
      { src: "Morningstar page", val: validTer((msFundPage as Partial<FundInfo>).ter) },
      { src: "justetf.com",     val: validTer((justEtf as Partial<FundInfo>).ter) },
      { src: "Yahoo Finance",   val: validTer((yahooSum as Partial<FundInfo>).ter) },
    ];

    const bestTer = terSources.find((t) => t.val !== undefined);
    const ter = bestTer?.val;

    const name =
      (providerData as Partial<FundInfo>).name ||
      msEN.name ||
      (msCZ as Partial<FundInfo>).name ||
      (msFundPage as Partial<FundInfo>).name ||
      (justEtf as Partial<FundInfo>).name ||
      (yahooSum as Partial<FundInfo>).name ||
      ticker || query;

    const currency =
      msEN.currency ||
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

    const result: FundInfo = {
      name,
      ticker: ticker || undefined,
      isin: isIsin ? isin : undefined,
      currency,
      ter,
      source: sources.join(" + ") || "veřejné zdroje",
      ...(yahooRet as Partial<FundInfo>),
    };

    return NextResponse.json(result);
  } catch (err) {
    console.error("[fund-lookup] error:", err);
    return NextResponse.json({ error: "Chyba při hledání fondu" }, { status: 500 });
  }
}
