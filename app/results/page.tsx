"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ReferenceLine, ResponsiveContainer,
} from "recharts";
import {
  ArrowLeft, TrendingDown, TrendingUp, Calendar, Wallet,
  AlertTriangle, History,
} from "lucide-react";
import { ContractData, FundInfo } from "@/lib/types";
import { calculateFees, calcEntryFee, formatCurrency, getDefaultProjectionEnd } from "@/lib/calculations";

// ── Tooltip ─────────────────────────────────────────────────────
const CustomTooltip = ({ active, payload, label, currency }: {
  active?: boolean;
  payload?: { value: number; name: string; color: string; dataKey: string }[];
  label?: string;
  currency: string;
}) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-lg p-4 text-sm min-w-[180px]">
      <p className="font-semibold text-gray-800 mb-2">{label}</p>
      {payload.map((e) => (
        <div key={e.dataKey} className="flex items-center gap-2 mb-1">
          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: e.color }} />
          <span className="text-gray-600 flex-1">{e.name}:</span>
          <span className="font-semibold">{formatCurrency(e.value, currency)}</span>
        </div>
      ))}
    </div>
  );
};

// ── StatCard ─────────────────────────────────────────────────────
const StatCard = ({ label, value, sub, color = "gray" }: {
  label: string; value: string; sub?: string; color?: "red" | "green" | "gray" | "amber" | "blue";
}) => {
  const colors = {
    red:   "bg-red-50 border-red-200",
    green: "bg-green-50 border-green-200",
    gray:  "bg-gray-50 border-gray-200",
    amber: "bg-amber-50 border-amber-200",
    blue:  "bg-blue-50 border-blue-200",
  };
  return (
    <div className={`rounded-xl border p-5 ${colors[color]}`}>
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  );
};

// ── SliderWithInput — slider + ruční vstup ────────────────────────
const SliderWithInput = ({
  label, value, onChange, min, max, step, unit, formatDisplay,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number; max: number; step: number;
  unit?: string;
  formatDisplay: (v: number) => string;
}) => {
  const [inputVal, setInputVal] = useState(String(value));

  // Sync inputVal when value changes externally (e.g. slider)
  useEffect(() => { setInputVal(String(value)); }, [value]);

  const commit = (raw: string) => {
    const n = parseFloat(raw.replace(/\s/g, "").replace(",", "."));
    if (!isNaN(n)) onChange(Math.max(min, Math.min(max, n)));
    else setInputVal(String(value)); // reset on invalid
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2 gap-2">
        <label className="text-xs font-medium text-gray-600 flex-1">{label}</label>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <input
            type="text"
            inputMode="numeric"
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && commit(inputVal)}
            className="w-24 text-right border border-gray-200 rounded-lg px-2 py-1 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
          />
          {unit && <span className="text-xs text-gray-400">{unit}</span>}
        </div>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-green-600" />
      <div className="flex justify-between text-xs text-gray-400 mt-0.5">
        <span>{formatDisplay(min)}</span>
        <span>{formatDisplay(max)}</span>
      </div>
    </div>
  );
};

// ── Hlavní stránka ────────────────────────────────────────────────
export default function ResultsPage() {
  const router = useRouter();
  const [contract, setContract] = useState<ContractData | null>(null);
  const [fundPerf, setFundPerf] = useState<Partial<FundInfo> | null>(null);
  const [showAssumptions, setShowAssumptions] = useState(false);
  const [projectionYears, setProjectionYears] = useState(10);
  const [customYearsInput, setCustomYearsInput] = useState("10");
  const [monthlyContribution, setMonthlyContribution] = useState(0);
  const [investmentOverride, setInvestmentOverride] = useState<number | null>(null);
  const [assumedReturn, setAssumedReturn] = useState(6);

  useEffect(() => {
    const stored = localStorage.getItem("contractData");
    if (!stored) { router.push("/"); return; }
    const parsed: ContractData = JSON.parse(stored);
    // Zpětná kompatibilita — starší data nemusí mít entryFeeMode
    if (!parsed.entryFeeMode) {
      parsed.entryFeeMode = "upfront_fixed";
      parsed.entryFeeFixedAmount = parsed.initialInvestment * (parsed.entryFeePercent / 100);
      parsed.targetAmount = 0;
    }
    setContract(parsed);
    setInvestmentOverride(parsed.initialInvestment);
    if (parsed.monthlyContribution) setMonthlyContribution(parsed.monthlyContribution);

    // Výchozí výnos pro projekci: priorita — ručně zadaný → 5Y historický → 6 %
    const savedReturn = (parsed as ContractData & { assumedAnnualReturn?: number }).assumedAnnualReturn;
    let defaultReturn = 6;
    if (savedReturn && savedReturn > 0) {
      defaultReturn = savedReturn;
    } else {
      const perfRaw = localStorage.getItem("fundPerformance");
      if (perfRaw) {
        try {
          const perf: Partial<FundInfo> = JSON.parse(perfRaw);
          setFundPerf(perf);
          if (perf.fiveYearReturn !== undefined && perf.fiveYearReturn > 0) {
            defaultReturn = perf.fiveYearReturn;
          }
        } catch { /* ignore */ }
      }
    }
    setAssumedReturn(defaultReturn);

    // Pokud jsme perfRaw ještě nenačetli (výše v else větvi), načteme ho teď
    if (savedReturn && savedReturn > 0) {
      const perfRaw = localStorage.getItem("fundPerformance");
      if (perfRaw) {
        try { setFundPerf(JSON.parse(perfRaw)); } catch { /* ignore */ }
      }
    }
  }, [router]);

  const projectionEndDate = useMemo(() => {
    if (!contract) return getDefaultProjectionEnd();
    const d = new Date(contract.contractStartDate);
    d.setFullYear(d.getFullYear() + projectionYears);
    return d.toISOString().split("T")[0];
  }, [contract, projectionYears]);

  const result = useMemo(() => {
    if (!contract) return null;
    const effectiveContract: ContractData = {
      ...contract,
      initialInvestment: investmentOverride ?? contract.initialInvestment,
    };
    const maxEnd = new Date();
    maxEnd.setFullYear(maxEnd.getFullYear() + 50);
    const chosenEnd = new Date(projectionEndDate);
    return calculateFees({
      contract: effectiveContract,
      projectionEndDate: (chosenEnd > maxEnd ? maxEnd : chosenEnd).toISOString().split("T")[0],
      monthlyContribution,
      assumedAnnualReturn: assumedReturn,
    });
  }, [contract, projectionEndDate, monthlyContribution, investmentOverride, assumedReturn]);

  // Decimace dat pro graf
  const chartData = useMemo(() => {
    if (!result) return [];
    const len = result.dataPoints.length;
    const step = len > 300 ? 6 : len > 120 ? 3 : 1;
    return result.dataPoints.filter((_, i) => i % step === 0 || i === len - 1);
  }, [result]);

  if (!contract || !result) return null;

  const currency = contract.currency;
  const todayLabel = new Date().toLocaleDateString("cs-CZ", { month: "short", year: "numeric" });
  const startYear = new Date(contract.contractStartDate).getFullYear();
  const endYear   = new Date(projectionEndDate).getFullYear();

  const yearsInvested = Math.max(0,
    (new Date().getTime() - new Date(contract.contractStartDate).getTime()) /
    (365.25 * 24 * 60 * 60 * 1000)
  );

  const PRESET_YEARS = [1, 3, 5, 10, 20, 30];
  const handleYearsChange = (y: number) => {
    const c = Math.max(1, Math.min(50, y));
    setProjectionYears(c);
    setCustomYearsInput(String(c));
  };

  const fmt = (v: number) => new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 0 }).format(v);

  return (
    <div className="animate-fade-in">
      <button onClick={() => router.back()} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-6">
        <ArrowLeft className="w-4 h-4" /> Zpět
      </button>

      {/* Nadpis */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-1">
          {contract.fundName || "Analýza poplatků"}
        </h1>
        <p className="text-gray-500 text-sm">
          {contract.isin && <span className="font-mono mr-3">{contract.isin}</span>}
          TER {contract.annualFeePercent} %
          {calcEntryFee(contract) > 0 && (() => {
            const fee = calcEntryFee(contract);
            return contract.entryFeeMode === "upfront_fixed"
              ? ` · vstupní ${formatCurrency(fee, contract.currency)}`
              : ` · vstupní ${contract.entryFeePercent} %`;
          })()}
          {contract.performanceFeePercent > 0 && ` · výkonnostní ${contract.performanceFeePercent} %`}
          {contract.custodyFeePercent > 0 && ` · úschova ${contract.custodyFeePercent} %`}
        </p>
      </div>

      {/* ── Historická výkonnost ─────────────────────────────────── */}
      {fundPerf && (fundPerf.oneYearReturn !== undefined || fundPerf.threeYearReturn !== undefined || fundPerf.fiveYearReturn !== undefined) && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 mb-6">
          <h2 className="font-semibold text-gray-900 mb-1 flex items-center gap-2">
            <History className="w-4 h-4 text-blue-500" /> Historická výkonnost fondu
          </h2>
          <p className="text-xs text-gray-500 mb-4">
            Průměrné roční zhodnocení (p.a.) · zdroj: {fundPerf.source || "Yahoo Finance"}
          </p>
          <div className="grid grid-cols-3 gap-3 mb-3">
            {[
              { label: "1 rok",  val: fundPerf.oneYearReturn },
              { label: "3 roky", val: fundPerf.threeYearReturn },
              { label: "5 let",  val: fundPerf.fiveYearReturn },
            ].map(({ label, val }) => val !== undefined && val !== null ? (
              <div key={label} className={`rounded-xl p-4 text-center border ${val >= 0 ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"}`}>
                <p className={`text-2xl font-bold ${val >= 0 ? "text-green-700" : "text-red-600"}`}>
                  {val > 0 ? "+" : ""}{val} %
                </p>
                <p className="text-xs text-gray-500 mt-1">{label} p.a.</p>
              </div>
            ) : (
              <div key={label} className="rounded-xl p-4 text-center border border-gray-100 bg-gray-50">
                <p className="text-2xl font-bold text-gray-300">—</p>
                <p className="text-xs text-gray-400 mt-1">{label}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-400">Minulá výkonnost není zárukou budoucích výnosů.</p>
        </div>
      )}

      {/* ══ SEKCE 1: SKUTEČNOST ════════════════════════════════════ */}
      <div className="mb-2">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-amber-500" />
            <span className="text-xs font-semibold text-amber-700 uppercase tracking-wider">Skutečnost — zaplaceno dosud</span>
          </div>
          <div className="flex-1 h-px bg-amber-200" />
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 mb-8">
          <h2 className="font-semibold text-gray-900 mb-1 flex items-center gap-2">
            <TrendingDown className="w-4 h-4 text-amber-600" /> Co jsi už zaplatil/a na poplatcích
          </h2>
          <p className="text-xs text-gray-500 mb-4">
            Reálná čísla od {new Date(contract.contractStartDate).toLocaleDateString("cs-CZ")} do dnes
            ({yearsInvested < 1 ? "méně než rok" : `${yearsInvested.toFixed(1)} let`})
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Celkem zaplaceno</p>
              <p className="text-2xl font-bold text-amber-800">{formatCurrency(result.totalPaidSoFar, currency)}</p>
              <p className="text-xs text-gray-400">vstupní + správa + ostatní</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Z toho vstupní</p>
              <p className="text-xl font-bold text-orange-700">{formatCurrency(result.entryFeePaid, currency)}</p>
              <p className="text-xs text-gray-400">jednorázově při nákupu</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Roční správa dosud</p>
              <p className="text-xl font-bold text-red-700">{formatCurrency(result.annualFeesPaid, currency)}</p>
              <p className="text-xs text-gray-400">TER za dosavadní dobu</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Navíc vs. ETF (0,22 %)</p>
              <p className="text-xl font-bold text-red-800">
                {formatCurrency(
                  result.totalPaidSoFar -
                  (result.dataPoints.filter((d) => d.isHistorical).slice(-1)[0]?.etfCumulativeFees ?? 0),
                  currency
                )}
              </p>
              <p className="text-xs text-gray-400">oproti ETF dosud</p>
            </div>
          </div>
        </div>
      </div>

      {/* ══ SEKCE 2: PROJEKCE ═════════════════════════════════════ */}
      <div className="mb-2">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-blue-500" />
            <span className="text-xs font-semibold text-blue-700 uppercase tracking-wider">Projekce — odhad do budoucna</span>
          </div>
          <div className="flex-1 h-px bg-blue-200" />
          <span className="text-xs text-gray-400 whitespace-nowrap">
            {startYear} → {endYear} ({projectionYears} let celkem)
          </span>
        </div>

        <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 mb-5 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-blue-700">
            Hodnoty níže jsou <strong>orientační odhad</strong> — předpokládají stejnou výši investice a poplatků po celou dobu.
            Předpokládaný výnos slouží <strong>pouze pro výpočet výkonnostního poplatku</strong>, nikoli jako prognóza zhodnocení.
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
          <StatCard label={`Celkem poplatky do ${endYear}`} value={formatCurrency(result.projectedTotalFees, currency)} sub={`Odhad za ${projectionYears} let od startu`} color="red" />
          <StatCard label="ETF by stálo (0,22 %)" value={formatCurrency(result.etfTotalFees, currency)} sub="Vanguard VWCE / iShares IWDA" color="green" />
          <StatCard
            label={result.potentialSavings >= 0 ? "Přeplatíš vs ETF" : "ETF by bylo dražší"}
            value={formatCurrency(Math.abs(result.potentialSavings), currency)}
            sub={result.potentialSavings >= 0 ? `Odhad za ${projectionYears} let navíc` : `Tvůj fond je levnější o tuto částku`}
            color={result.potentialSavings >= 0 ? "red" : "green"}
          />
        </div>
      </div>

      {/* ── Graf: poplatky + hodnota portfolia ──────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 mb-6">
        <h2 className="font-semibold text-gray-900 mb-1">Vývoj poplatků a hodnoty portfolia</h2>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mb-1 text-xs text-gray-500">
          <span>Svislá čára = dnes &nbsp;·&nbsp; vlevo = <strong>skutečnost</strong>, vpravo = <strong>odhad</strong></span>
        </div>
        <p className="text-xs text-amber-600 mb-2">
          ⚠ Hodnota portfolia je orientační — počítá s konstantním výnosem {assumedReturn} % p.a. Slouží pouze pro srovnání, není to prognóza.
        </p>

        {/* Legenda os */}
        <div className="flex gap-4 mb-4 text-xs">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-0.5 bg-red-400 inline-block" />
            <span className="text-gray-500">Poplatky — tvůj fond (levá osa)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-0.5 bg-green-500 inline-block" />
            <span className="text-gray-500">Poplatky — ETF 0,22 % (levá osa)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-0.5 bg-blue-500 inline-block rounded" style={{borderTop: "2px solid #3b82f6"}} />
            <span className="text-gray-500">Hodnota portfolia (pravá osa)</span>
          </div>
        </div>

        <ResponsiveContainer width="100%" height={380}>
          <ComposedChart data={chartData} margin={{ top: 10, right: 60, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="feeGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#ef4444" stopOpacity={0.15} />
                <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="etfGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#22c55e" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#9ca3af" }} interval="preserveStartEnd" tickLine={false} />
            {/* Levá osa — poplatky */}
            <YAxis yAxisId="fees"
              tickFormatter={(v) => fmt(v)}
              tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false}
              width={70}
            />
            {/* Pravá osa — hodnota portfolia */}
            <YAxis yAxisId="portfolio" orientation="right"
              tickFormatter={(v) => fmt(v)}
              tick={{ fontSize: 10, fill: "#93c5fd" }} tickLine={false} axisLine={false}
              width={70}
            />
            <Tooltip content={<CustomTooltip currency={currency} />} />
            <Legend iconType="circle" wrapperStyle={{ paddingTop: 12, fontSize: 12 }} />
            <ReferenceLine yAxisId="fees" x={todayLabel} stroke="#6b7280" strokeDasharray="4 4"
              label={{ value: "Dnes", position: "top", fill: "#6b7280", fontSize: 11 }} />
            <Area yAxisId="fees" type="monotone" dataKey="cumulativeFees" name="Poplatky — fond" stroke="#ef4444" strokeWidth={2} fill="url(#feeGrad)" dot={false} />
            <Area yAxisId="fees" type="monotone" dataKey="etfCumulativeFees" name="Poplatky — ETF" stroke="#22c55e" strokeWidth={2} fill="url(#etfGrad)" dot={false} />
            <Line yAxisId="portfolio" type="monotone" dataKey="portfolioValue" name="Hodnota portfolia" stroke="#3b82f6" strokeWidth={2} dot={false} strokeDasharray="5 3" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* ── Interaktivní ovládače ─────────────────────────────────── */}
      <div className="grid md:grid-cols-2 gap-6 mb-8">

        {/* Délka projekce */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <h3 className="font-semibold text-gray-900 mb-1 flex items-center gap-2">
            <Calendar className="w-4 h-4 text-green-600" /> Délka projekce
          </h3>
          <p className="text-xs text-gray-500 mb-3">
            Smlouva od {new Date(contract.contractStartDate).toLocaleDateString("cs-CZ")} →{" "}
            <strong>{new Date(projectionEndDate).toLocaleDateString("cs-CZ", { year: "numeric", month: "short" })}</strong>
          </p>
          <div className="flex flex-wrap gap-2 mb-3">
            {PRESET_YEARS.map((y) => (
              <button key={y} onClick={() => handleYearsChange(y)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  projectionYears === y ? "bg-green-600 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}>
                {y} let
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3 mb-3">
            <label className="text-xs text-gray-500 whitespace-nowrap">Vlastní délka:</label>
            <input type="number" min={1} max={50}
              value={customYearsInput}
              onChange={(e) => {
                setCustomYearsInput(e.target.value);
                const n = parseInt(e.target.value);
                if (!isNaN(n) && n >= 1 && n <= 50) handleYearsChange(n);
              }}
              className="w-20 border border-gray-300 rounded-lg px-3 py-2 text-sm text-center font-semibold focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <span className="text-xs text-gray-500">let (max 50)</span>
          </div>
          <input type="range" min={1} max={50} step={1} value={projectionYears}
            onChange={(e) => handleYearsChange(Number(e.target.value))}
            className="w-full accent-green-600" />
          <div className="flex justify-between text-xs text-gray-400"><span>1 rok</span><span>50 let</span></div>
        </div>

        {/* Vklady a předpoklady — accordion */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <button
            onClick={() => setShowAssumptions((v) => !v)}
            className="w-full flex items-center justify-between px-6 py-5 text-left hover:bg-gray-50 transition-colors"
          >
            <h3 className="font-semibold text-gray-900 flex items-center gap-2">
              <Wallet className="w-4 h-4 text-green-600" /> Vklady a předpoklady
            </h3>
            <span className="text-gray-400 text-lg leading-none">{showAssumptions ? "▲" : "▼"}</span>
          </button>
          {showAssumptions && (
            <div className="px-6 pb-6 space-y-5 border-t border-gray-100 pt-4">

              <SliderWithInput
                label="Počáteční investice"
                value={investmentOverride ?? contract.initialInvestment}
                onChange={setInvestmentOverride}
                min={0} max={5000000} step={10000}
                unit={currency}
                formatDisplay={(v) => fmt(v)}
              />

              <SliderWithInput
                label="Měsíční vklad"
                value={monthlyContribution}
                onChange={setMonthlyContribution}
                min={0} max={50000} step={500}
                unit={currency}
                formatDisplay={(v) => fmt(v)}
              />

              <div>
                <SliderWithInput
                  label={
                    fundPerf?.fiveYearReturn !== undefined
                      ? `Předpokládaný roční výnos (5Y p.a. = ${fundPerf.fiveYearReturn} %)`
                      : "Předpokládaný roční výnos"
                  }
                  value={assumedReturn}
                  onChange={setAssumedReturn}
                  min={0} max={30} step={0.5}
                  unit="%"
                  formatDisplay={(v) => `${v} %`}
                />
                <div className="mt-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-500">
                  ℹ️ <strong>Pouze informativní</strong> — používá se výhradně pro výpočet výkonnostního poplatku
                  a orientační vývoj portfolia. Není to prognóza výnosu.
                  {fundPerf?.fiveYearReturn !== undefined && (
                    <span className="ml-1">Předvyplněno z historického 5Y výnosu fondu.</span>
                  )}
                </div>
              </div>

            </div>
          )}
        </div>
      </div>

      {/* Varování */}
      {contract.annualFeePercent > 1.5 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 mb-8 flex gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-amber-800">
            <strong>Vysoký roční poplatek ({contract.annualFeePercent} %).</strong>{" "}
            Za {projectionYears} let ti přijde na{" "}
            <strong>{formatCurrency(result.potentialSavings, currency)}</strong> navíc oproti indexovému ETF.
            Globální ETF jako Vanguard FTSE All-World (VWCE) nabízí stejnou diverzifikaci za 0,22 % ročně.
          </div>
        </div>
      )}

      {/* ETF alternativy */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-6 mb-8">
        <h3 className="font-semibold text-blue-900 mb-3 flex items-center gap-2">
          <TrendingUp className="w-4 h-4" /> Levné alternativy (ETF)
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[
            { name: "Vanguard FTSE All-World", ticker: "VWCE", ter: "0,22 %", desc: "Globální akcie, 3 700+ firem" },
            { name: "iShares MSCI World",      ticker: "IWDA", ter: "0,20 %", desc: "Rozvinuté trhy, 1 400+ firem" },
            { name: "Xtrackers MSCI World",    ticker: "XDWD", ter: "0,19 %", desc: "Nejlevnější globální ETF" },
          ].map((etf) => (
            <div key={etf.ticker} className="bg-white rounded-lg p-3 border border-blue-100">
              <p className="font-semibold text-gray-900 text-sm">{etf.name}</p>
              <p className="text-xs text-gray-500">{etf.ticker} · TER {etf.ter}</p>
              <p className="text-xs text-blue-700 mt-1">{etf.desc}</p>
            </div>
          ))}
        </div>
        <p className="text-xs text-blue-600 mt-3">Toto není finanční poradenství. Vždy si udělej vlastní průzkum.</p>
      </div>

      <div className="text-center">
        <button onClick={() => router.push("/")}
          className="bg-gray-900 hover:bg-gray-800 text-white font-semibold py-3 px-8 rounded-xl transition-colors">
          Analyzovat další fond
        </button>
      </div>
    </div>
  );
}
