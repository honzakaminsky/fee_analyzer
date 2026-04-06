"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle, AlertTriangle, Info, ChevronRight, ArrowLeft } from "lucide-react";
import { ContractData } from "@/lib/types";
import DatePicker from "@/app/components/DatePicker";

interface FieldConfig {
  key: keyof ContractData;
  label: string;
  description: string;
  type: "text" | "number" | "date" | "select";
  unit?: string;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
}

const FIELDS: FieldConfig[] = [
  {
    key: "fundName",
    label: "Název fondu / správce",
    description: "Název správce nebo konkrétního fondu ze smlouvy",
    type: "text",
  },
  {
    key: "isin",
    label: "ISIN",
    description: "Mezinárodní identifikátor cenného papíru (12 znaků) — nepovinné",
    type: "text",
  },
  {
    key: "contractStartDate",
    label: "Datum začátku smlouvy",
    description: "Kdy jsi začal/a investovat — slouží k výpočtu kolik jsi už zaplatil/a",
    type: "date",
  },
  {
    key: "initialInvestment",
    label: "Počáteční investice",
    description: "Kolik jsi vložil/a na začátku (jednorázový vklad)",
    type: "number",
    min: 0,
  },
  {
    key: "monthlyContribution",
    label: "Pravidelná měsíční investice",
    description: 'Měsíční vklad — hledej "pravidelná investice", "měsíční vklad", "trvalý příkaz". Pokud nemáš pravidelný vklad, nech 0.',
    type: "number",
    min: 0,
  },
  // entryFeePercent se renderuje zvlášť s přepínačem % / částka
  {
    key: "annualFeePercent",
    label: "Roční poplatek za správu (TER)",
    description: 'Každoroční poplatek odečítaný z portfolia — hledej "TER", "ongoing charges", "management fee"',
    type: "number",
    unit: "%",
    min: 0,
    max: 10,
  },
  {
    key: "exitFeePercent",
    label: "Výstupní poplatek",
    description: "Poplatek při prodeji / ukončení smlouvy — u mnoha fondů je nulový",
    type: "number",
    unit: "%",
    min: 0,
    max: 10,
  },
  {
    key: "performanceFeePercent",
    label: "Poplatek za výkonnost",
    description: 'Procento ze zisku nad benchmark. Hledej "performance fee". Pokud neni ve smlouve, nech 0.',
    type: "number",
    unit: "%",
    min: 0,
    max: 50,
  },
  {
    key: "performanceFeeBenchmark",
    label: "Benchmark pro výkonnostní poplatek",
    description: "Výnos, od kterého se počítá výkonnostní poplatek (hurdle rate). Typicky 5–8 %.",
    type: "number",
    unit: "%",
    min: 0,
    max: 30,
  },
  {
    key: "custodyFeePercent",
    label: "Poplatek za úschovu / platformu",
    description: "Roční poplatek za vedení účtu nebo úschovu. Pokud není ve smlouvě, nech 0.",
    type: "number",
    unit: "%",
    min: 0,
    max: 5,
  },
  {
    key: "currency",
    label: "Měna",
    description: "Měna, ve které je smlouva vedena",
    type: "select",
    options: [
      { value: "CZK", label: "CZK — Česká koruna" },
      { value: "EUR", label: "EUR — Euro" },
      { value: "USD", label: "USD — Americký dolar" },
    ],
  },
];

export default function ReviewPage() {
  const router = useRouter();
  const [data, setData] = useState<ContractData | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof ContractData, string>>>({});
  const [entryFeeMode, setEntryFeeMode] = useState<"percent" | "amount">("percent");
  const [entryFeeAmount, setEntryFeeAmount] = useState(0);
  const [entryFeeCurrency, setEntryFeeCurrency] = useState<"CZK" | "EUR" | "USD">("CZK");

  useEffect(() => {
    const stored = localStorage.getItem("contractData");
    if (!stored) {
      router.push("/");
      return;
    }
    const parsed = JSON.parse(stored);
    // Doplň nová pole pokud chybí (zpětná kompatibilita)
    setData({
      performanceFeePercent: 0,
      performanceFeeBenchmark: 5,
      custodyFeePercent: 0,
      isin: "",
      entryFeeMode: "upfront_fixed",
      entryFeeFixedAmount: 0,
      targetAmount: 0,
      ...parsed,
    });
  }, [router]);

  if (!data) return null;

  const updateField = (key: keyof ContractData, value: string | number) => {
    setData((prev) => (prev ? { ...prev, [key]: value } : prev));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const switchEntryFeeMode = (newMode: "percent" | "amount") => {
    if (!data || newMode === entryFeeMode) return;
    if (newMode === "amount") {
      setEntryFeeAmount(Math.round(data.initialInvestment * data.entryFeePercent / 100));
    } else {
      if (data.initialInvestment > 0) {
        const pct = Math.round((entryFeeAmount / data.initialInvestment) * 10000) / 100;
        updateField("entryFeePercent", pct);
      }
    }
    setEntryFeeMode(newMode);
  };

  const handleEntryFeeAmountChange = (val: number) => {
    setEntryFeeAmount(val);
    if (data && data.initialInvestment > 0) {
      const pct = Math.round((val / data.initialInvestment) * 10000) / 100;
      updateField("entryFeePercent", pct);
    }
  };

  const validate = (): boolean => {
    const newErrors: Partial<Record<keyof ContractData, string>> = {};

    if (!data.fundName.trim()) newErrors.fundName = "Zadej název fondu";
    if (!data.contractStartDate) newErrors.contractStartDate = "Zadej datum začátku";
    if (data.initialInvestment < 0) newErrors.initialInvestment = "Investice nesmí být záporná";
    if (data.initialInvestment === 0 && (!data.monthlyContribution || data.monthlyContribution === 0))
      newErrors.initialInvestment = "Zadej alespoň počáteční investici nebo měsíční vklad";
    if (data.annualFeePercent <= 0) newErrors.annualFeePercent = "TER musí být větší než 0";

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleContinue = () => {
    if (!validate()) return;
    localStorage.setItem("contractData", JSON.stringify(data));
    router.push("/results");
  };

  // Rychle posouzeni: je TER vysoke?
  const isTerHigh = data.annualFeePercent > 1.5;
  const isEntryHigh = data.entryFeePercent > 2;

  return (
    <div className="animate-fade-in max-w-2xl mx-auto">
      {/* Zpet */}
      <button
        onClick={() => router.push("/")}
        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        Nahrát jiný soubor
      </button>

      <div className="mb-8">
        <div className="flex items-center gap-2 mb-2">
          <CheckCircle className="w-6 h-6 text-green-600" />
          <h1 className="text-2xl font-bold text-gray-900">AI vytáhla tato data</h1>
        </div>
        <p className="text-gray-600">
          Zkontroluj, zda jsou hodnoty správné. Pokud AI něco špatně přečetla,
          oprav to ručně — výsledky budou přesné jen s dobrými daty.
        </p>
        {data.providerName && (
          <div className="mt-3 inline-flex items-center gap-2 bg-blue-50 border border-blue-200 text-blue-800 text-sm px-3 py-1.5 rounded-full">
            <CheckCircle className="w-3.5 h-3.5" />
            Poskytovatel: <strong>{data.providerName}</strong>
          </div>
        )}
      </div>

      {/* Varovania */}
      {(isTerHigh || isEntryHigh) && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6 flex gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-amber-800">
            <strong>Pozor na poplatky:</strong>{" "}
            {isTerHigh && `Roční poplatek ${data.annualFeePercent}% je výrazně nad průměrem ETF (0,22%). `}
            {isEntryHigh && `Vstupní poplatek ${data.entryFeePercent}% snižuje hodnotu tvé investice hned na začátku.`}
          </div>
        </div>
      )}

      {/* Formular */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm divide-y divide-gray-100">
        {/* Vstupní poplatek — s přepínačem % / částka */}
        <div className="p-6">
          <div className="flex-1">
            <label className="block font-semibold text-gray-800 mb-1">Vstupní poplatek</label>
            <p className="text-xs text-gray-500 mb-3 flex items-start gap-1">
              <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
              Jednorázový poplatek při nákupu — hledej &quot;vstupní poplatek&quot; nebo &quot;subscription fee&quot;
            </p>
            <div className="flex gap-2 mb-2">
              <button type="button" onClick={() => switchEntryFeeMode("percent")}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${entryFeeMode === "percent" ? "bg-green-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                v procentech (%)
              </button>
              <button type="button" onClick={() => switchEntryFeeMode("amount")}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${entryFeeMode === "amount" ? "bg-green-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                pevná částka ({data.currency})
              </button>
            </div>
            {entryFeeMode === "percent" ? (
              <div className="relative">
                <input type="number" value={data.entryFeePercent} min={0} max={20} step={0.01}
                  onChange={(e) => updateField("entryFeePercent", parseFloat(e.target.value) || 0)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 pr-8"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">%</span>
              </div>
            ) : (
              <div>
                <div className="flex gap-2">
                  <input type="number" value={entryFeeAmount} min={0} step={100}
                    onChange={(e) => handleEntryFeeAmountChange(parseFloat(e.target.value) || 0)}
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                  <select
                    value={entryFeeCurrency}
                    onChange={(e) => setEntryFeeCurrency(e.target.value as "CZK" | "EUR" | "USD")}
                    className="border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  >
                    <option value="CZK">CZK</option>
                    <option value="EUR">EUR</option>
                    <option value="USD">USD</option>
                  </select>
                </div>
                {data.initialInvestment > 0 && (
                  <p className="text-xs text-gray-500 mt-1">
                    = {Math.round((entryFeeAmount / data.initialInvestment) * 10000) / 100} % z počáteční investice
                    {entryFeeCurrency !== data.currency && (
                      <span className="text-amber-600 ml-1">(pozor — jiná měna než investice)</span>
                    )}
                  </p>
                )}
                {data.initialInvestment === 0 && entryFeeAmount > 0 && (
                  <p className="text-xs text-amber-600 mt-1">
                    Zadej počáteční investici pro automatický přepočet na %. Nebo přepni na % a zadej přímo.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {FIELDS.map((field) => {
          const value = data[field.key];
          const errorMsg = errors[field.key];

          return (
            <div key={field.key} className="p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <label className="block font-semibold text-gray-800 mb-1">
                    {field.label}
                    {field.unit && (
                      <span className="ml-1 font-normal text-gray-500 text-sm">({field.unit})</span>
                    )}
                  </label>
                  <p className="text-xs text-gray-500 mb-3 flex items-start gap-1">
                    <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
                    {field.description}
                  </p>

                  {field.type === "select" ? (
                    <select
                      value={String(value)}
                      onChange={(e) => updateField(field.key, e.target.value)}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                    >
                      {field.options?.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  ) : field.type === "date" ? (
                    <DatePicker
                      value={String(value)}
                      onChange={(v) => updateField(field.key, v)}
                      hasError={!!errorMsg}
                    />
                  ) : (
                    <div className="relative">
                      <input
                        type={field.type}
                        value={String(value)}
                        min={field.min}
                        max={field.max}
                        step={field.type === "number" ? "0.01" : undefined}
                        onChange={(e) => {
                          const v =
                            field.type === "number"
                              ? parseFloat(e.target.value) || 0
                              : e.target.value;
                          updateField(field.key, v);
                        }}
                        className={`w-full border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 ${
                          errorMsg ? "border-red-400 bg-red-50" : "border-gray-300"
                        }`}
                      />
                      {field.unit && (
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">
                          {field.unit}
                        </span>
                      )}
                    </div>
                  )}

                  {errorMsg && (
                    <p className="text-xs text-red-600 mt-1">{errorMsg}</p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Tlacitko pokracovat */}
      <div className="mt-6 flex gap-3">
        <button
          onClick={handleContinue}
          className="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold py-4 px-6 rounded-xl transition-colors flex items-center justify-center gap-2"
        >
          Data jsou správná — zobraz analýzu
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>

      <p className="text-xs text-center text-gray-400 mt-3">
        Data se ukládají pouze v tvém prohlížeči a nejsou odesílána na server.
      </p>
    </div>
  );
}
