"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Search, Loader2, ChevronRight, Info,
  TrendingUp, AlertCircle, CheckCircle, Sparkles, ChevronDown
} from "lucide-react";
import { ContractData, FundInfo } from "@/lib/types";
import { defaultContract } from "@/lib/calculations";
import DatePicker from "@/app/components/DatePicker";

export default function ManualPage() {
  const router = useRouter();
  const [contract, setContract] = useState<ContractData>(defaultContract());
  const [isinQuery, setIsinQuery] = useState("");
  const [fundInfo, setFundInfo] = useState<FundInfo | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [autoFilledFields, setAutoFilledFields] = useState<string[]>([]);
  const [errors, setErrors] = useState<Partial<Record<keyof ContractData, string>>>({});
  const [entryFeeMode, setEntryFeeMode] = useState<"percent" | "amount">("percent");
  const [entryFeeAmount, setEntryFeeAmount] = useState(0);
  const [entryFeeCurrency, setEntryFeeCurrency] = useState<"CZK" | "EUR" | "USD">("CZK");
  const [selectedProvider, setSelectedProvider] = useState("");
  // Zda zobrazit zbytek formuláře — true po kliknutí na Hledat nebo "Přeskočit"
  const [formRevealed, setFormRevealed] = useState(false);

  const update = (key: keyof ContractData, value: string | number) => {
    setContract((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const handleLookup = async () => {
    const query = isinQuery.trim();
    setLookupLoading(true);
    setLookupError(null);
    setFundInfo(null);
    setAutoFilledFields([]);

    if (!query) {
      // Prázdný dotaz — jen zobraz formulář
      setFormRevealed(true);
      setLookupLoading(false);
      return;
    }

    try {
      const providerParam = selectedProvider ? `&provider=${encodeURIComponent(selectedProvider)}` : "";
      const res = await fetch(`/api/fund-lookup?q=${encodeURIComponent(query)}${providerParam}`);
      const data = await res.json();

      if (!res.ok) {
        setLookupError(data.error || "Fond nenalezen");
      } else {
        setFundInfo(data as FundInfo);
        const filled: string[] = [];
        if (data.name)     { update("fundName", data.name); filled.push("fundName"); }
        if (data.isin)     { update("isin", data.isin); }
        if (data.currency && ["CZK", "EUR", "USD"].includes(data.currency)) {
          update("currency", data.currency); filled.push("currency");
        }
        if (data.ter)      { update("annualFeePercent", data.ter); filled.push("annualFeePercent"); }
        setAutoFilledFields(filled);
      }
    } catch {
      setLookupError("Chyba při vyhledávání. Zkus to znovu.");
    } finally {
      setLookupLoading(false);
      setFormRevealed(true); // Vždy zobraz formulář — ať již nalezen nebo ne
    }
  };

  const validate = (): boolean => {
    const e: Partial<Record<keyof ContractData, string>> = {};
    if (!contract.fundName.trim()) e.fundName = "Zadej název fondu";
    if (!contract.contractStartDate) e.contractStartDate = "Zadej datum začátku investice";
    if (contract.initialInvestment < 0) e.initialInvestment = "Investice nesmí být záporná";
    if (contract.initialInvestment === 0 && contract.monthlyContribution === 0)
      e.initialInvestment = "Zadej alespoň počáteční investici nebo měsíční vklad";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = () => {
    if (!validate()) return;
    localStorage.setItem("contractData", JSON.stringify(contract));
    if (fundInfo) {
      localStorage.setItem("fundPerformance", JSON.stringify({
        name: fundInfo.name,
        isin: fundInfo.isin,
        ticker: fundInfo.ticker,
        oneYearReturn: fundInfo.oneYearReturn,
        threeYearReturn: fundInfo.threeYearReturn,
        fiveYearReturn: fundInfo.fiveYearReturn,
        source: fundInfo.source,
      }));
    } else {
      localStorage.removeItem("fundPerformance");
    }
    router.push("/results");
  };

  const isAutoFilled = (key: string) => autoFilledFields.includes(key);

  const switchEntryFeeMode = (newMode: "percent" | "amount") => {
    if (newMode === entryFeeMode) return;
    if (newMode === "amount") {
      setEntryFeeAmount(Math.round(contract.initialInvestment * contract.entryFeePercent / 100));
    } else {
      if (contract.initialInvestment > 0) {
        const pct = Math.round((entryFeeAmount / contract.initialInvestment) * 10000) / 100;
        update("entryFeePercent", pct);
      }
    }
    setEntryFeeMode(newMode);
  };

  const handleEntryFeeAmountChange = (val: number) => {
    setEntryFeeAmount(val);
    if (contract.initialInvestment > 0) {
      const pct = Math.round((val / contract.initialInvestment) * 10000) / 100;
      update("entryFeePercent", pct);
    }
  };

  const providerLabel: Record<string, string> = {
    cpinvest: "ČP Invest", csob: "ČSOB Asset Management", reico: "REICO / Česká spořitelna",
    kbam: "KB Asset Management", conseq: "Conseq", nn: "NN Investment Partners / Goldman Sachs AM",
    generali: "Generali Investments", amundi: "Amundi / Lyxor / Pioneer", ishares: "iShares / BlackRock",
  };

  return (
    <div className="animate-fade-in max-w-2xl mx-auto">
      <button onClick={() => router.push("/")}
        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-6">
        ← Zpět
      </button>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">Zadat fond ručně</h1>
      <p className="text-sm text-gray-500 mb-8">
        Zadej ISIN a poskytovatele — zbytek vyplníme automaticky.
      </p>

      {/* ── KROK 1: ISIN + Poskytovatel ─────────────────────── */}
      <div className={`bg-white rounded-2xl shadow-sm p-6 mb-6 transition-all ${
        formRevealed
          ? "border border-gray-200"
          : "border-2 border-green-200"
      }`}>
        <h2 className="font-semibold text-gray-900 mb-1 flex items-center gap-2">
          <Sparkles className={`w-4 h-4 ${formRevealed ? "text-gray-400" : "text-green-600"}`} />
          {formRevealed ? "Vyhledávání fondu" : "Krok 1 — Zadej ISIN a poskytovatele"}
        </h2>

        {!formRevealed && (
          <p className="text-xs text-gray-500 mb-5">
            12místný kód ze smlouvy (napr. <span className="font-mono">LU1829218749</span>).
            Vyhledáme za tebe název, TER a historickou výkonnost.
          </p>
        )}

        <div className="space-y-3">
          {/* ISIN */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">ISIN</label>
            <input
              type="text"
              value={isinQuery}
              onChange={(e) => setIsinQuery(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && !formRevealed && handleLookup()}
              placeholder="napr. LU1829218749"
              maxLength={12}
              disabled={formRevealed}
              className={`w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-500 ${
                formRevealed ? "bg-gray-50 text-gray-500" : ""
              }`}
            />
            <p className="text-xs text-gray-400 mt-1">
              Nemáš ISIN? Nech pole prázdné a vyplň vše ručně.
            </p>
          </div>

          {/* Poskytovatel */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1 flex items-center gap-1">
              <Info className="w-3 h-3" /> Poskytovatel
              <span className="font-normal text-gray-400 ml-1">(nepovinné — zlepší nalezení poplatků)</span>
            </label>
            <select
              value={selectedProvider}
              onChange={(e) => setSelectedProvider(e.target.value)}
              disabled={formRevealed}
              className={`w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-green-500 ${
                formRevealed ? "bg-gray-50 text-gray-500" : "bg-white"
              }`}
            >
              <option value="">— Nevím / automaticky rozpoznat —</option>
              <optgroup label="Čeští poskytovatelé">
                <option value="cpinvest">ČP Invest (Česká pojišťovna)</option>
                <option value="csob">ČSOB Asset Management</option>
                <option value="reico">REICO / Česká spořitelna</option>
                <option value="kbam">KB Asset Management</option>
                <option value="conseq">Conseq</option>
                <option value="nn">NN Investment Partners / Goldman Sachs AM</option>
                <option value="generali">Generali Investments</option>
              </optgroup>
              <optgroup label="Zahraniční fondy">
                <option value="amundi">Amundi / Lyxor / Pioneer (LU ISINs)</option>
                <option value="ishares">iShares / BlackRock (IE ISINs)</option>
              </optgroup>
            </select>
          </div>
        </div>

        {/* Tlačítko Hledat — jen v kroku 1 */}
        {!formRevealed && (
          <div className="mt-5 flex items-center gap-3">
            <button
              onClick={handleLookup}
              disabled={lookupLoading}
              className="bg-gray-900 hover:bg-gray-800 disabled:bg-gray-200 disabled:text-gray-400 text-white font-semibold px-6 py-2.5 rounded-lg text-sm flex items-center gap-2 transition-colors"
            >
              {lookupLoading
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Hledám...</>
                : <><Search className="w-4 h-4" /> Hledat</>}
            </button>
            <button
              type="button"
              onClick={() => setFormRevealed(true)}
              className="text-sm text-gray-400 hover:text-gray-600 underline underline-offset-2 transition-colors"
            >
              Přeskočit a vyplnit ručně →
            </button>
          </div>
        )}

        {/* Výsledek hledání — shrnutí (po odhalení formuláře) */}
        {formRevealed && (
          <div className="mt-4">
            {/* Úspěch */}
            {fundInfo && (
              <div className="bg-green-50 border border-green-200 rounded-xl p-4">
                <div className="flex items-start gap-2 mb-3">
                  <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-gray-900 text-sm">{fundInfo.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {[
                        fundInfo.ticker,
                        fundInfo.currency,
                        selectedProvider ? providerLabel[selectedProvider] : null,
                        `zdroj: ${fundInfo.source}`,
                      ].filter(Boolean).join(" · ")}
                    </p>
                    {fundInfo.ter !== undefined && (
                      <p className="text-xs text-green-700 font-semibold mt-1">
                        TER: {fundInfo.ter} % ročně — automaticky vyplněno níže ✓
                      </p>
                    )}
                  </div>
                </div>
                {/* Historická výkonnost */}
                {(fundInfo.oneYearReturn !== undefined || fundInfo.threeYearReturn !== undefined || fundInfo.fiveYearReturn !== undefined) && (
                  <div>
                    <p className="text-xs font-medium text-gray-600 mb-2 flex items-center gap-1">
                      <TrendingUp className="w-3 h-3" /> Historická výkonnost (p.a.)
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { label: "1 rok", val: fundInfo.oneYearReturn },
                        { label: "3 roky", val: fundInfo.threeYearReturn },
                        { label: "5 let", val: fundInfo.fiveYearReturn },
                      ].map(({ label, val }) => val !== undefined && (
                        <div key={label} className="bg-white rounded-lg p-2 text-center border border-green-100">
                          <p className={`text-lg font-bold ${val >= 0 ? "text-green-700" : "text-red-600"}`}>
                            {val > 0 ? "+" : ""}{val} %
                          </p>
                          <p className="text-xs text-gray-500">{label}</p>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-gray-400 mt-2">Minulá výkonnost není zárukou budoucích výnosů.</p>
                  </div>
                )}
              </div>
            )}

            {/* Chyba — nenalezeno */}
            {lookupError && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-2">
                <div className="flex items-center gap-2 text-amber-800 text-sm font-semibold">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  Fond nebyl nalezen — vyplň poplatky ručně
                </div>
                <p className="text-xs text-amber-700 ml-6">
                  Poplatky najdeš v dokumentu <strong>KIID</strong> — hledej
                  řádek <strong>&quot;Ongoing charges&quot;</strong> nebo <strong>&quot;Roční náklady&quot;</strong>.
                </p>
                <div className="ml-6 flex flex-wrap gap-2 mt-1">
                  {[
                    { label: "Morningstar →", href: `https://www.morningstar.cz/cz/funds/snapshot/snapshot.aspx?query=${isinQuery}` },
                    { label: "fundinfo.com →", href: `https://fundinfo.com/en/isin/${isinQuery}` },
                    { label: "Amundi.lu →", href: `https://www.amundi.lu/retail/product/view/${isinQuery}` },
                  ].map(({ label, href }) => (
                    <a key={label} href={href} target="_blank" rel="noopener noreferrer"
                      className="text-xs bg-white border border-amber-300 text-amber-800 px-3 py-1.5 rounded-lg hover:bg-amber-50 transition-colors">
                      {label}
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* Přeskočeno bez hledání */}
            {!fundInfo && !lookupError && (
              <p className="text-xs text-gray-400 flex items-center gap-1">
                <Info className="w-3 h-3" /> Vyhledávání přeskočeno — vyplň údaje ručně níže.
              </p>
            )}

            {/* Tlačítko pro nové hledání */}
            <button
              type="button"
              onClick={() => { setFormRevealed(false); setFundInfo(null); setLookupError(null); }}
              className="mt-3 text-xs text-green-700 hover:text-green-900 underline underline-offset-2"
            >
              ← Hledat znovu s jiným ISIN
            </button>
          </div>
        )}
      </div>

      {/* ── KROK 2: Zbytek formuláře — skrytý dokud se neobjeví ── */}
      {formRevealed && (
        <>
          {/* Indikátor přechodu */}
          <div className="flex items-center gap-2 mb-4 text-sm text-gray-500">
            <ChevronDown className="w-4 h-4 text-green-600" />
            <span className="font-medium text-gray-700">Krok 2 — Doplň zbývající údaje</span>
          </div>

          {/* ── Základní info ─────────────────────────────────── */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm mb-6 divide-y divide-gray-100">
            <div className="px-6 py-4 bg-gray-50 rounded-t-2xl">
              <h2 className="font-semibold text-gray-900">Základní informace</h2>
            </div>

            {/* Název */}
            <div className="p-6">
              <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-2">
                Název fondu <span className="text-red-500">*</span>
                {isAutoFilled("fundName") && <AutoBadge />}
              </label>
              <input type="text" value={contract.fundName}
                onChange={(e) => update("fundName", e.target.value)}
                placeholder="napr. Amundi Funds Global Equity"
                className={`w-full border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 ${errors.fundName ? "border-red-400" : "border-gray-300"}`}
              />
              {errors.fundName && <p className="text-xs text-red-600 mt-1">{errors.fundName}</p>}
            </div>

            {/* Datum */}
            <div className="p-6">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Datum začátku investice <span className="text-red-500">*</span>
              </label>
              <p className="text-xs text-gray-500 mb-2 flex gap-1">
                <Info className="w-3 h-3 mt-0.5 flex-shrink-0 text-gray-400" />
                Kdy jsi začal/a investovat — použijeme k výpočtu co jsi už zaplatil/a.
                Klikni na <strong>název měsíce a roku</strong> pro rychlý výběr.
              </p>
              <DatePicker
                value={contract.contractStartDate}
                onChange={(v) => update("contractStartDate", v)}
                hasError={!!errors.contractStartDate}
                placeholder="Vyber datum začátku"
              />
              {errors.contractStartDate && <p className="text-xs text-red-600 mt-1">{errors.contractStartDate}</p>}
            </div>

            {/* Investice + měna */}
            <div className="p-6">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Počáteční investice <span className="text-red-500">*</span>
              </label>
              <div className="flex gap-2">
                <input type="number" value={contract.initialInvestment} min={0} step={1000}
                  onChange={(e) => update("initialInvestment", parseFloat(e.target.value) || 0)}
                  className={`flex-1 border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 ${errors.initialInvestment ? "border-red-400" : "border-gray-300"}`}
                />
                <select value={contract.currency} onChange={(e) => update("currency", e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500">
                  <option value="CZK">CZK</option>
                  <option value="EUR">EUR</option>
                  <option value="USD">USD</option>
                </select>
              </div>
              {errors.initialInvestment && <p className="text-xs text-red-600 mt-1">{errors.initialInvestment}</p>}
            </div>

            {/* Pravidelná investice */}
            <div className="p-6 bg-green-50">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Pravidelná měsíční investice
                <span className="ml-2 text-xs text-gray-400 font-normal">(nepovinné)</span>
              </label>
              <p className="text-xs text-gray-500 mb-3 flex gap-1">
                <Info className="w-3 h-3 mt-0.5 flex-shrink-0 text-gray-400" />
                Zasíláš každý měsíc pravidelnou platbu? Zahrne se do výpočtu poplatků.
              </p>
              <input type="number" value={contract.monthlyContribution} min={0} step={500}
                placeholder="napr. 2 000"
                onChange={(e) => update("monthlyContribution", parseFloat(e.target.value) || 0)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white mb-2"
              />
              <input type="range" min={0} max={50000} step={500}
                value={contract.monthlyContribution}
                onChange={(e) => update("monthlyContribution", Number(e.target.value))}
                className="w-full accent-green-600"
              />
              <div className="flex justify-between text-xs text-gray-400 mt-0.5">
                <span>0</span>
                <span className="font-semibold text-gray-700">
                  {new Intl.NumberFormat("cs-CZ").format(contract.monthlyContribution)} {contract.currency}/měs.
                </span>
                <span>50 000</span>
              </div>
            </div>
          </div>

          {/* ── Poplatky ───────────────────────────────────────── */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm mb-6 divide-y divide-gray-100">
            <div className="px-6 py-4 bg-gray-50 rounded-t-2xl">
              <h2 className="font-semibold text-gray-900">Poplatky</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Hodnoty označené <AutoBadge inline /> byly vyplněny automaticky — zkontroluj je.
                Zbytek najdeš ve smlouvě nebo v dokumentu KIID.
              </p>
            </div>

            {/* Vstupní poplatek — s přepínačem % / částka */}
            <div className="p-6">
              <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-2">
                Vstupní poplatek
                {isAutoFilled("entryFeePercent") && <AutoBadge />}
              </label>
              <p className="text-xs text-gray-500 mb-3 flex gap-1">
                <Info className="w-3 h-3 mt-0.5 flex-shrink-0 text-gray-400" />
                Jednorázový poplatek při nákupu. Hledej &quot;vstupní poplatek&quot; nebo &quot;subscription fee&quot;.
              </p>
              <div className="flex gap-2 mb-2">
                <button type="button" onClick={() => switchEntryFeeMode("percent")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${entryFeeMode === "percent" ? "bg-green-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                  v procentech (%)
                </button>
                <button type="button" onClick={() => switchEntryFeeMode("amount")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${entryFeeMode === "amount" ? "bg-green-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                  pevná částka
                </button>
              </div>
              {entryFeeMode === "percent" ? (
                <div className="relative">
                  <input type="number" value={contract.entryFeePercent} min={0} max={20} step={0.01}
                    placeholder="napr. 3"
                    onChange={(e) => update("entryFeePercent", parseFloat(e.target.value) || 0)}
                    className={`w-full border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 pr-8 ${isAutoFilled("entryFeePercent") ? "border-green-300 bg-green-50" : "border-gray-300"}`}
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">%</span>
                </div>
              ) : (
                <div>
                  <div className="flex gap-2">
                    <input type="number" value={entryFeeAmount} min={0} step={100}
                      placeholder="napr. 5000"
                      onChange={(e) => handleEntryFeeAmountChange(parseFloat(e.target.value) || 0)}
                      className="flex-1 border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                    />
                    <select value={entryFeeCurrency}
                      onChange={(e) => setEntryFeeCurrency(e.target.value as "CZK" | "EUR" | "USD")}
                      className="border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500">
                      <option value="CZK">CZK</option>
                      <option value="EUR">EUR</option>
                      <option value="USD">USD</option>
                    </select>
                  </div>
                  {contract.initialInvestment > 0 && (
                    <p className="text-xs text-gray-500 mt-1">
                      = {Math.round((entryFeeAmount / contract.initialInvestment) * 10000) / 100} % z počáteční investice
                      {entryFeeCurrency !== contract.currency && (
                        <span className="text-amber-600 ml-1">(pozor — jiná měna než investice)</span>
                      )}
                    </p>
                  )}
                  {contract.initialInvestment === 0 && entryFeeAmount > 0 && (
                    <p className="text-xs text-amber-600 mt-1">
                      Zadej počáteční investici pro přepočet na %. Nebo přepni na % a zadej přímo.
                    </p>
                  )}
                </div>
              )}
            </div>

            {[
              { key: "annualFeePercent" as const, label: "Roční poplatek za správu (TER)", desc: 'Každoroční poplatek. Hledej "TER", "ongoing charges", "management fee".', placeholder: "napr. 1.5" },
              { key: "performanceFeePercent" as const, label: "Poplatek za výkonnost", desc: 'Procento ze zisku nad benchmark. Hledej "performance fee". U pasivních fondů bývá 0.', placeholder: "napr. 20", optional: true },
              { key: "custodyFeePercent" as const, label: "Poplatek za úschovu / platformu", desc: "Roční poplatek za vedení účtu. U mnoha fondů je 0 nebo zahrnut v TER.", placeholder: "napr. 0.3", optional: true },
              { key: "exitFeePercent" as const, label: "Výstupní poplatek", desc: "Poplatek při prodeji. U ETF většinou 0.", placeholder: "napr. 1", optional: true },
            ].map((field) => (
              <div key={field.key} className="p-6">
                <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-2">
                  {field.label}
                  <span className="text-gray-400 font-normal text-xs">%</span>
                  {field.optional && <span className="text-gray-400 font-normal text-xs">(nepovinné)</span>}
                  {isAutoFilled(field.key) && <AutoBadge />}
                </label>
                <p className="text-xs text-gray-500 mb-2 flex gap-1">
                  <Info className="w-3 h-3 mt-0.5 flex-shrink-0 text-gray-400" />
                  {field.desc}
                </p>
                <input type="number" value={Number(contract[field.key])} min={0} step={0.01}
                  placeholder={field.placeholder}
                  onChange={(e) => update(field.key, parseFloat(e.target.value) || 0)}
                  className={`w-full border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 ${isAutoFilled(field.key) ? "border-green-300 bg-green-50" : "border-gray-300"}`}
                />
              </div>
            ))}
          </div>

          {/* Tlačítko */}
          <button onClick={handleSubmit}
            className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-4 px-6 rounded-xl transition-colors flex items-center justify-center gap-2">
            Zobrazit analýzu poplatků
            <ChevronRight className="w-5 h-5" />
          </button>
          <p className="text-xs text-center text-gray-400 mt-3">Data jsou uložena pouze v tvém prohlížeči</p>
        </>
      )}
    </div>
  );
}

function AutoBadge({ inline }: { inline?: boolean }) {
  void inline;
  return (
    <span className="text-xs bg-green-100 text-green-700 font-semibold px-1.5 py-0.5 rounded-full">✓ auto</span>
  );
}
