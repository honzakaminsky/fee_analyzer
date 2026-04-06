"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2, ChevronRight, CheckCircle, AlertCircle,
  ChevronDown, ChevronUp, TrendingUp, Search, ArrowLeft, HelpCircle,
} from "lucide-react";
import { ContractData, FundInfo, EntryFeeMode } from "@/lib/types";
import { defaultContract } from "@/lib/calculations";
import DatePicker from "@/app/components/DatePicker";

// ─────────────────────────────────────────────────────────────────
// Pomocné komponenty
// ─────────────────────────────────────────────────────────────────

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{children}</p>;
}

function AutoBadge() {
  return <span className="ml-1.5 text-xs bg-green-100 text-green-700 font-semibold px-1.5 py-0.5 rounded-full normal-case tracking-normal">✓ auto</span>;
}

function NumInput({
  value, onChange, suffix, placeholder = "0", step = 1, min = 0, max,
  highlight = false,
}: {
  value: number; onChange: (v: number) => void;
  suffix?: string; placeholder?: string; step?: number;
  min?: number; max?: number; highlight?: boolean;
}) {
  return (
    <div className="relative">
      <input
        type="number"
        value={value === 0 ? "" : value}
        min={min} max={max} step={step}
        placeholder={placeholder}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className={`w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 ${suffix ? "pr-12" : ""} ${
          highlight ? "border-green-300 bg-green-50" : "border-gray-200 bg-white"
        }`}
      />
      {suffix && (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none font-medium">
          {suffix}
        </span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Hlavní stránka — 2-krokový wizard
// ─────────────────────────────────────────────────────────────────

export default function ManualPage() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [contract, setContract] = useState<ContractData>(defaultContract());
  const [fundInfo, setFundInfo] = useState<FundInfo | null>(null);
  const [autoFields, setAutoFields] = useState<Set<string>>(new Set());
  const [isinStatus, setIsinStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [selectedProvider, setSelectedProvider] = useState("");
  const [showOptional, setShowOptional] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const lookupTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const up = <K extends keyof ContractData>(key: K, val: ContractData[K]) => {
    setContract((p) => ({ ...p, [key]: val }));
    setErrors((p) => { const n = { ...p }; delete n[key]; return n; });
  };

  // ── Auto-detekce poskytovatele z názvu ───────────────────────
  const detectProviderKey = (providerName: string, isin: string): string => {
    const p = (providerName + " " + isin).toLowerCase();
    if (p.includes("čsob") || p.includes("csob") || p.includes("kbc")) return isin.startsWith("SK") ? "csobsk" : "csob";
    if (p.includes("generali") || p.includes("čp invest") || p.includes("cp invest")) return "generali";
    if (p.includes("erste") || p.includes("isčs") || p.includes("česká spořitelna")) return isin.startsWith("SK") ? "erstesk" : "iscs";
    if (p.includes("reico")) return "reico";
    if (p.includes("amundi") && (p.includes("kb") || p.includes("komerční"))) return "kbam";
    if (p.includes("amundi") || p.includes("lyxor") || p.includes("pioneer")) return "amundi";
    if (p.includes("conseq")) return "conseq";
    if (p.includes("goldman") || p.includes("nn investment")) return "nn";
    if (p.includes("j&t") || p.includes("jtinvest")) return "jtinvest";
    if (p.includes("raiffeisen")) return "raiffeisen";
    if (p.includes("partners")) return "partners";
    if (p.includes("iad")) return "iad";
    if (p.includes("eurizon") || p.includes("vúb") || p.includes("vub")) return "vubam";
    if (p.includes("tatra")) return "tatram";
    if (p.includes("ishares") || p.includes("blackrock")) return "ishares";
    return "";
  };

  // ── ISIN lookup ───────────────────────────────────────────────
  const runLookup = (isin: string, provider: string) => {
    if (lookupTimeout.current) clearTimeout(lookupTimeout.current);
    if (isin.length !== 12) return;
    setIsinStatus("loading");
    lookupTimeout.current = setTimeout(async () => {
      try {
        const prov = provider ? `&provider=${encodeURIComponent(provider)}` : "";
        const res = await fetch(`/api/fund-lookup?q=${encodeURIComponent(isin)}${prov}`);
        const data: FundInfo = await res.json();
        if (!res.ok) { setIsinStatus("error"); return; }
        setFundInfo(data);
        setIsinStatus("ok");
        const filled = new Set<string>();

        if (data.name && data.name !== isin) {
          up("fundName", data.name); filled.add("fundName");
        }
        if (data.provider) {
          up("providerName", data.provider); filled.add("providerName");
          const key = detectProviderKey(data.provider, isin);
          if (key && !provider) setSelectedProvider(key);
        }
        if (data.currency && ["CZK","EUR","USD"].includes(data.currency)) {
          up("currency", data.currency as "CZK"|"EUR"|"USD"); filled.add("currency");
        }
        if (data.ter != null && data.ter > 0) {
          up("annualFeePercent", data.ter); filled.add("annualFeePercent");
        }
        if (data.entryFee != null) {
          up("entryFeePercent", data.entryFee); filled.add("entryFeePercent");
        }
        if (data.exitFee != null) {
          up("exitFeePercent", data.exitFee); filled.add("exitFeePercent");
        }
        if (data.performanceFee != null) {
          up("performanceFeePercent", data.performanceFee); filled.add("performanceFeePercent");
        }
        if (data.custodyFee != null) {
          up("custodyFeePercent", data.custodyFee); filled.add("custodyFeePercent");
        }
        const bestReturn = data.fiveYearReturn ?? data.threeYearReturn ?? data.oneYearReturn;
        if (bestReturn != null) {
          up("assumedAnnualReturn" as keyof ContractData, bestReturn as never);
          filled.add("assumedAnnualReturn");
        }
        setAutoFields(filled);
      } catch {
        setIsinStatus("error");
      }
    }, 600);
  };

  const handleIsinChange = (raw: string) => {
    const val = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    up("isin", val);
    setIsinStatus("idle");
    setFundInfo(null);
    setAutoFields(new Set());
    runLookup(val, selectedProvider);
  };

  const handleProviderChange = (provider: string) => {
    setSelectedProvider(provider);
    if (contract.isin?.length === 12) {
      setFundInfo(null); setAutoFields(new Set());
      runLookup(contract.isin, provider);
    }
  };

  // ── Validace + submit ─────────────────────────────────────────
  const validate = () => {
    const e: Record<string, string> = {};
    if (!contract.contractStartDate) e.contractStartDate = "Zadej datum";
    if (contract.initialInvestment === 0 && contract.monthlyContribution === 0)
      e.investment = "Zadej alespoň jednu z investic";
    if (contract.annualFeePercent <= 0) e.annualFeePercent = "TER musí být > 0";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = () => {
    if (!validate()) return;
    const fiveYr = (contract as ContractData & { assumedAnnualReturn?: number }).assumedAnnualReturn;
    if (fundInfo || fiveYr) {
      const perfPayload: Record<string, unknown> = {
        name: fundInfo?.name ?? contract.fundName,
        isin: contract.isin,
        source: fundInfo?.source ?? "ručně",
      };
      if (fundInfo?.oneYearReturn !== undefined && fundInfo.oneYearReturn !== null) perfPayload.oneYearReturn = fundInfo.oneYearReturn;
      if (fundInfo?.threeYearReturn !== undefined && fundInfo.threeYearReturn !== null) perfPayload.threeYearReturn = fundInfo.threeYearReturn;
      const fy = fundInfo?.fiveYearReturn ?? fiveYr;
      if (fy !== undefined && fy !== null) perfPayload.fiveYearReturn = fy;
      localStorage.setItem("fundPerformance", JSON.stringify(perfPayload));
    } else {
      localStorage.removeItem("fundPerformance");
    }
    localStorage.setItem("contractData", JSON.stringify(contract));
    router.push("/results");
  };

  const [showTerTooltip, setShowTerTooltip] = useState(false);
  const entryMode = contract.entryFeeMode;
  const auto = (k: string) => autoFields.has(k);
  const fiveYrReturn = (contract as ContractData & { assumedAnnualReturn?: number }).assumedAnnualReturn ?? 0;

  // ─────────────────────────────────────────────────────────────
  // KROK 1 — Vyhledání fondu
  // ─────────────────────────────────────────────────────────────
  if (step === 1) {
    return (
      <div className="animate-fade-in max-w-xl mx-auto">
        <button onClick={() => router.push("/")}
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-6">
          ← Zpět
        </button>

        <h1 className="text-2xl font-bold text-gray-900 mb-1">Analyzovat fond</h1>
        <p className="text-sm text-gray-500 mb-6">
          Zadej ISIN fondu — automaticky dohledáme poplatky a výkonnost.
        </p>

        <div className="space-y-4">
          {/* ISIN vstup */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 space-y-4">

            <div>
              <FieldLabel>ISIN kód fondu</FieldLabel>
              <div className="relative">
                <input
                  type="text"
                  value={contract.isin ?? ""}
                  onChange={(e) => handleIsinChange(e.target.value)}
                  placeholder="napr. CZ0008474194"
                  maxLength={12}
                  autoFocus
                  className="w-full border border-gray-200 bg-white rounded-xl px-3 py-3 text-base font-mono focus:outline-none focus:ring-2 focus:ring-green-500 pr-10"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2">
                  {isinStatus === "loading" && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
                  {isinStatus === "ok" && <CheckCircle className="w-4 h-4 text-green-500" />}
                  {isinStatus === "error" && <AlertCircle className="w-4 h-4 text-amber-500" />}
                  {isinStatus === "idle" && <Search className="w-4 h-4 text-gray-300" />}
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-1.5">
                Najdeš ho ve smlouvě nebo na webu správce fondu.
              </p>
            </div>

            {/* Poskytovatel — volitelný hint pro přesnější výsledky */}
            <div>
              <FieldLabel>Poskytovatel <span className="normal-case font-normal text-gray-400">(volitelné — zrychlí hledání)</span></FieldLabel>
              <select value={selectedProvider} onChange={(e) => handleProviderChange(e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-green-500 bg-white">
                <option value="">— Automaticky detekovat —</option>
                <optgroup label="Čeští poskytovatelé">
                  <option value="generali">Generali Investments (dříve ČP Invest)</option>
                  <option value="csob">ČSOB Asset Management</option>
                  <option value="iscs">Erste Asset Management (dříve ISČS)</option>
                  <option value="reico">REICO (Česká spořitelna, nemovitostní)</option>
                  <option value="kbam">Amundi KB (dříve KB Asset Management)</option>
                  <option value="conseq">Conseq</option>
                  <option value="nn">Goldman Sachs AM (dříve NN Investment Partners)</option>
                  <option value="jtinvest">J&amp;T Investiční společnost</option>
                  <option value="raiffeisen">Raiffeisen Capital Management</option>
                  <option value="partners">Partners investiční společnost</option>
                </optgroup>
                <optgroup label="Slovenští poskytovatelé">
                  <option value="iad">IAD Investments</option>
                  <option value="vubam">Eurizon AM Slovakia (dříve VÚB AM)</option>
                  <option value="tatram">Tatra Asset Management</option>
                  <option value="erstesk">Erste AM / Slovenská sporiteľňa</option>
                  <option value="csobsk">ČSOB AM Slovakia</option>
                </optgroup>
                <optgroup label="Zahraniční fondy">
                  <option value="amundi">Amundi / Lyxor / Pioneer (LU)</option>
                  <option value="ishares">iShares / BlackRock (IE)</option>
                </optgroup>
              </select>
            </div>
          </div>

          {/* Výsledek vyhledávání */}
          {isinStatus === "ok" && fundInfo && (
            <div className="bg-white rounded-2xl border border-green-200 shadow-sm p-5 space-y-4">
              {/* Název + metadata */}
              <div>
                <p className="font-semibold text-gray-900 text-base leading-snug">{fundInfo.name}</p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {fundInfo.fundCategory && (
                    <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{fundInfo.fundCategory}</span>
                  )}
                  {fundInfo.riskLevel != null && (
                    <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">SRI {fundInfo.riskLevel}/7</span>
                  )}
                  {fundInfo.currency && (
                    <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{fundInfo.currency}</span>
                  )}
                </div>
              </div>

              {/* Nalezené poplatky */}
              {(fundInfo.ter != null || fundInfo.entryFee != null || fundInfo.exitFee != null) && (
                <div>
                  <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Nalezené poplatky</p>
                  <div className="grid grid-cols-3 gap-2">
                    {fundInfo.ter != null && (
                      <div className="bg-green-50 rounded-xl p-3 text-center">
                        <p className="text-lg font-bold text-green-700">{fundInfo.ter} %</p>
                        <p className="text-xs text-gray-500 mt-0.5">TER ročně</p>
                      </div>
                    )}
                    {fundInfo.entryFee != null && (
                      <div className="bg-green-50 rounded-xl p-3 text-center">
                        <p className="text-lg font-bold text-green-700">{fundInfo.entryFee} %</p>
                        <p className="text-xs text-gray-500 mt-0.5">Vstupní</p>
                      </div>
                    )}
                    {fundInfo.exitFee != null && (
                      <div className="bg-green-50 rounded-xl p-3 text-center">
                        <p className="text-lg font-bold text-green-700">{fundInfo.exitFee} %</p>
                        <p className="text-xs text-gray-500 mt-0.5">Výstupní</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Historická výkonnost */}
              {(fundInfo.oneYearReturn != null || fundInfo.threeYearReturn != null || fundInfo.fiveYearReturn != null) && (
                <div>
                  <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2 flex items-center gap-1">
                    <TrendingUp className="w-3.5 h-3.5" /> Historická výkonnost p.a.
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { label: "1 rok",  val: fundInfo.oneYearReturn },
                      { label: "3 roky", val: fundInfo.threeYearReturn },
                      { label: "5 let",  val: fundInfo.fiveYearReturn },
                    ].map(({ label, val }) => val != null && (
                      <div key={label} className="bg-blue-50 rounded-xl p-3 text-center">
                        <p className={`text-lg font-bold ${val >= 0 ? "text-blue-700" : "text-red-600"}`}>
                          {val > 0 ? "+" : ""}{val} %
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">{label}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {fundInfo.source && (
                <p className="text-xs text-gray-400">Zdroj: {fundInfo.source}</p>
              )}

              {/* CTA — přejít na krok 2 */}
              <button
                onClick={() => setStep(2)}
                className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-3.5 px-6 rounded-xl transition-colors flex items-center justify-center gap-2 mt-2">
                Zadat parametry investice
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          )}

          {/* Fond nenalezen — přesto pokračovat */}
          {isinStatus === "error" && (
            <div className="bg-amber-50 rounded-2xl border border-amber-200 p-5 space-y-3">
              <p className="text-sm text-amber-800 font-semibold">Fond nebyl automaticky nalezen</p>
              <p className="text-xs text-amber-700">Můžeš zadat poplatky ručně v dalším kroku.</p>
              <button
                onClick={() => setStep(2)}
                className="w-full bg-amber-500 hover:bg-amber-600 text-white font-semibold py-3 px-6 rounded-xl transition-colors flex items-center justify-center gap-2">
                Zadat poplatky ručně
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────
  // KROK 2 — Parametry investice + poplatky
  // ─────────────────────────────────────────────────────────────
  return (
    <div className="animate-fade-in max-w-xl mx-auto">
      <button onClick={() => setStep(1)}
        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-6">
        <ArrowLeft className="w-4 h-4" /> Zpět na hledání
      </button>

      {/* Shrnutí fondu nahoře */}
      {fundInfo?.name && (
        <div className="bg-green-50 border border-green-200 rounded-2xl px-4 py-3 mb-5 flex items-center gap-3">
          <CheckCircle className="w-5 h-5 text-green-600 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-green-900 leading-tight">{fundInfo.name}</p>
            {contract.isin && <p className="text-xs text-green-700 mt-0.5">{contract.isin}</p>}
          </div>
        </div>
      )}

      <div className="space-y-3">

        {/* ── Investice ──────────────────────────────────────── */}
        <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 space-y-4">
          <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Parametry investice</p>

          <div>
            <FieldLabel>Datum začátku</FieldLabel>
            <DatePicker value={contract.contractStartDate}
              onChange={(v) => up("contractStartDate", v)}
              hasError={!!errors.contractStartDate}
              placeholder="Vyber datum" />
            {errors.contractStartDate && <p className="text-xs text-red-500 mt-1">{errors.contractStartDate}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel>Počáteční investice</FieldLabel>
              <NumInput value={contract.initialInvestment}
                onChange={(v) => up("initialInvestment", v)}
                suffix={contract.currency} step={1000} placeholder="0" />
            </div>
            <div>
              <FieldLabel>Pravidelný vklad / měs.</FieldLabel>
              <NumInput value={contract.monthlyContribution}
                onChange={(v) => up("monthlyContribution", v)}
                suffix={contract.currency} step={500} placeholder="0" />
            </div>
          </div>
          {errors.investment && <p className="text-xs text-red-500">{errors.investment}</p>}

          <div>
            <FieldLabel>Měna</FieldLabel>
            <div className="flex gap-2">
              {(["CZK","EUR","USD"] as const).map((c) => (
                <button key={c} type="button" onClick={() => up("currency", c)}
                  className={`flex-1 py-2 rounded-xl text-sm font-semibold border-2 transition-colors ${
                    contract.currency === c
                      ? "border-green-500 bg-green-50 text-green-800"
                      : "border-gray-200 text-gray-600 hover:border-gray-300"
                  }`}>{c}</button>
              ))}
            </div>
          </div>

          {/* Výnos — zobrazí se jen pokud nebyl dohledán automaticky */}
          {!auto("assumedAnnualReturn") && (
            <div>
              <FieldLabel>Průměrný roční výnos za posledních 5 let</FieldLabel>
              <NumInput
                value={fiveYrReturn}
                onChange={(v) => setContract((p) => ({ ...p, assumedAnnualReturn: v } as ContractData & { assumedAnnualReturn: number }))}
                suffix="% p.a." step={0.1} min={-30} max={50} placeholder="napr. 7"
              />
              <p className="text-xs text-gray-400 mt-1">Najdeš v KIID dokumentu nebo na webu správce fondu.</p>
            </div>
          )}
          {auto("assumedAnnualReturn") && (
            <div className="bg-blue-50 rounded-xl px-4 py-3 flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-blue-600 shrink-0" />
              <p className="text-sm text-blue-800">
                Průměrný roční výnos <strong>{fiveYrReturn} % p.a.</strong> dohledán automaticky.
              </p>
            </div>
          )}
        </section>

        {/* ── Poplatky ───────────────────────────────────────── */}
        <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 space-y-4">
          <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Poplatky</p>

          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Roční poplatek za správu (TER) {auto("annualFeePercent") && <AutoBadge />}
              </p>
              <button
                type="button"
                onClick={() => setShowTerTooltip(v => !v)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <HelpCircle className="w-3.5 h-3.5" />
              </button>
            </div>
            {showTerTooltip && (
              <div className="mb-2 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-xs text-gray-600 leading-relaxed">
                <strong>TER (Total Expense Ratio)</strong> — celkové roční náklady fondu vyjádřené v procentech.
                Zahrnují poplatek za správu, depozitářský poplatek a další provozní náklady.
                <br />Například TER 1,5 % znamená, že fond ročně "stojí" 1,5 % z investované částky — automaticky se odečítá z hodnoty fondu a neplatíš ho zvlášť.
              </div>
            )}
            <NumInput value={contract.annualFeePercent}
              onChange={(v) => up("annualFeePercent", v)}
              suffix="%" step={0.01} max={10} placeholder="napr. 1.5"
              highlight={auto("annualFeePercent")} />
            {errors.annualFeePercent && <p className="text-xs text-red-500 mt-1">{errors.annualFeePercent}</p>}
          </div>

          {/* Vstupní poplatek */}
          <div>
            <FieldLabel>Vstupní poplatek {auto("entryFeePercent") && <AutoBadge />}</FieldLabel>
            <div className="grid grid-cols-3 gap-1.5 mb-3">
              {([
                ["upfront_fixed",        "Fixní částka",    "zaplacena jednorázově"],
                ["per_contribution_pct", "% z vkladu",      "z každého vkladu"],
                ["target_pct",           "% z cíle",        "z cílové částky"],
              ] as [EntryFeeMode, string, string][]).map(([mode, title, sub]) => (
                <button key={mode} type="button" onClick={() => up("entryFeeMode", mode)}
                  className={`rounded-xl p-2.5 text-left border-2 transition-all ${
                    entryMode === mode ? "border-green-500 bg-green-50" : "border-gray-200 hover:border-gray-300"
                  }`}>
                  <p className={`text-xs font-bold ${entryMode === mode ? "text-green-800" : "text-gray-700"}`}>{title}</p>
                  <p className="text-xs text-gray-400 mt-0.5 leading-tight">{sub}</p>
                </button>
              ))}
            </div>
            {entryMode === "upfront_fixed" && (
              <NumInput value={contract.entryFeeFixedAmount}
                onChange={(v) => up("entryFeeFixedAmount", v)}
                suffix={contract.currency} step={100} placeholder="napr. 5 000" />
            )}
            {entryMode === "per_contribution_pct" && (
              <NumInput value={contract.entryFeePercent}
                onChange={(v) => up("entryFeePercent", v)}
                suffix="%" step={0.1} max={20} placeholder="napr. 3"
                highlight={auto("entryFeePercent")} />
            )}
            {entryMode === "target_pct" && (
              <div className="space-y-2">
                <NumInput value={contract.targetAmount}
                  onChange={(v) => up("targetAmount", v)}
                  suffix={contract.currency} step={10000} placeholder="Cílová částka" />
                <NumInput value={contract.entryFeePercent}
                  onChange={(v) => up("entryFeePercent", v)}
                  suffix="%" step={0.1} max={20} placeholder="napr. 5"
                  highlight={auto("entryFeePercent")} />
                {contract.targetAmount > 0 && contract.entryFeePercent > 0 && (
                  <p className="text-xs text-green-700 font-semibold">
                    = {new Intl.NumberFormat("cs-CZ").format(Math.round(contract.targetAmount * contract.entryFeePercent / 100))} {contract.currency}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Volitelné poplatky */}
          <div className="border-t border-gray-100 pt-3">
            <button type="button" onClick={() => setShowOptional((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 font-semibold">
              {showOptional ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              Výstupní poplatek a poplatek za výkonnost
            </button>
            {showOptional && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <FieldLabel>Výstupní poplatek {auto("exitFeePercent") && <AutoBadge />}</FieldLabel>
                  <NumInput value={contract.exitFeePercent}
                    onChange={(v) => up("exitFeePercent", v)}
                    suffix="%" step={0.1} max={10} placeholder="0"
                    highlight={auto("exitFeePercent")} />
                </div>
                <div>
                  <FieldLabel>Poplatek za výkonnost {auto("performanceFeePercent") && <AutoBadge />}</FieldLabel>
                  <NumInput value={contract.performanceFeePercent}
                    onChange={(v) => up("performanceFeePercent", v)}
                    suffix="%" step={1} max={50} placeholder="0"
                    highlight={auto("performanceFeePercent")} />
                </div>
                {contract.performanceFeePercent > 0 && (
                  <div className="col-span-2">
                    <FieldLabel>Benchmark (hurdle rate)</FieldLabel>
                    <NumInput value={contract.performanceFeeBenchmark}
                      onChange={(v) => up("performanceFeeBenchmark", v)}
                      suffix="%" step={0.5} max={30} placeholder="5" />
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* ── Submit ─────────────────────────────────────────── */}
        <button onClick={handleSubmit}
          className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-4 px-6 rounded-2xl transition-colors flex items-center justify-center gap-2 shadow-sm">
          Zobrazit analýzu poplatků
          <ChevronRight className="w-5 h-5" />
        </button>

        <p className="text-xs text-center text-gray-400 pb-8">Data jsou uložena pouze v tvém prohlížeči.</p>
      </div>
    </div>
  );
}
