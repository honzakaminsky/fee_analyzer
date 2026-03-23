"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Upload, FileText, AlertCircle, Loader2,
  ChevronRight, PenLine, Sparkles
} from "lucide-react";
import { ContractData } from "@/lib/types";

export default function HomePage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"choose" | "pdf">("choose");
  const [isDragging, setIsDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback((f: File) => {
    if (f.type !== "application/pdf") {
      setError("Prosím nahrej soubor ve formátu PDF.");
      return;
    }
    setFile(f);
    setError(null);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }, [handleFile]);

  const handleExtract = async () => {
    if (!file) return;
    setIsExtracting(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("pdf", file);
      const res = await fetch("/api/extract", { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Nepodařilo se zpracovat soubor.");
      }
      const data: ContractData = await res.json();
      localStorage.setItem("contractData", JSON.stringify(data));
      router.push("/review");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Nastala neočekávaná chyba.");
    } finally {
      setIsExtracting(false);
    }
  };

  // ── Výběr způsobu zadání ────────────────────────────────────
  if (mode === "choose") {
    return (
      <div className="animate-fade-in">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">
            Kolik tě skutečně stojí tvůj fond?
          </h1>
          <p className="text-lg text-gray-500 max-w-xl mx-auto">
            Zjisti kolik platíš na poplatcích a kolik bys ušetřil s levnějším ETF fondem.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto">

          {/* Manuální zadání */}
          <button
            onClick={() => router.push("/manual")}
            className="group text-left bg-white border-2 border-gray-200 hover:border-green-500 rounded-2xl p-8 transition-all shadow-sm hover:shadow-md"
          >
            <div className="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center mb-5 group-hover:bg-green-200 transition-colors">
              <PenLine className="w-6 h-6 text-green-700" />
            </div>
            <div className="flex items-center gap-2 mb-2">
              <h2 className="text-xl font-bold text-gray-900">Zadat ručně</h2>
              <span className="text-xs bg-green-100 text-green-700 font-semibold px-2 py-0.5 rounded-full">Zdarma</span>
            </div>
            <p className="text-gray-500 text-sm mb-5">
              Zadej název fondu nebo ISIN a poplatky ručně ze smlouvy nebo prospektu.
              Funguje i bez API klíče.
            </p>
            <ul className="text-sm text-gray-600 space-y-1.5 mb-6">
              {["Vyhledání fondu přes ISIN nebo název", "Všechny typy poplatků", "Historická výkonnost (pokud dostupná)", "Okamžitá vizualizace"].map(item => (
                <li key={item} className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-1 text-green-700 font-semibold text-sm">
              Začít <ChevronRight className="w-4 h-4" />
            </div>
          </button>

          {/* AI PDF upload */}
          <button
            onClick={() => setMode("pdf")}
            className="group text-left bg-white border-2 border-gray-200 hover:border-purple-500 rounded-2xl p-8 transition-all shadow-sm hover:shadow-md"
          >
            <div className="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center mb-5 group-hover:bg-purple-200 transition-colors">
              <Sparkles className="w-6 h-6 text-purple-700" />
            </div>
            <div className="flex items-center gap-2 mb-2">
              <h2 className="text-xl font-bold text-gray-900">Nahrát smlouvu</h2>
              <span className="text-xs bg-purple-100 text-purple-700 font-semibold px-2 py-0.5 rounded-full">AI • API klíč</span>
            </div>
            <p className="text-gray-500 text-sm mb-5">
              Nahraj PDF smlouvu a AI automaticky vytáhne všechny poplatky.
              Vyžaduje Anthropic API klíč.
            </p>
            <ul className="text-sm text-gray-600 space-y-1.5 mb-6">
              {["Automatická extrakce z PDF", "AI přečte i složité dokumenty", "Rychlé — hotovo za pár sekund", "Kontrola a oprava před analýzou"].map(item => (
                <li key={item} className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-purple-500 flex-shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-1 text-purple-700 font-semibold text-sm">
              Nahrát PDF <ChevronRight className="w-4 h-4" />
            </div>
          </button>
        </div>

        {/* Info banner */}
        <div className="mt-10 bg-amber-50 border border-amber-200 rounded-xl p-5 max-w-3xl mx-auto">
          <p className="text-sm text-amber-800">
            <strong>Věděl jsi?</strong> Průměrný aktivně spravovaný fond v ČR bere 1,5–3 % ročně.
            Na 500 000 Kč to je 7 500–15 000 Kč každý rok — přitom globální ETF stojí pouhých 0,22 %.
          </p>
        </div>
      </div>
    );
  }

  // ── PDF upload ────────────────────────────────────────────────
  return (
    <div className="animate-fade-in max-w-xl mx-auto">
      <button onClick={() => setMode("choose")} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-6">
        ← Zpět
      </button>
      <h1 className="text-2xl font-bold text-gray-900 mb-2">Nahrát smlouvu</h1>
      <p className="text-gray-500 text-sm mb-6">PDF smlouva, sazebník nebo prospekt fondu (max. 20 MB)</p>

      <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
        <div
          className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-all ${
            isDragging ? "border-purple-500 bg-purple-50"
            : file ? "border-green-400 bg-green-50"
            : "border-gray-300 hover:border-gray-400 hover:bg-gray-50"
          }`}
          onDrop={onDrop}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onClick={() => fileInputRef.current?.click()}
        >
          <input ref={fileInputRef} type="file" accept=".pdf" className="hidden"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />

          {file ? (
            <div className="flex flex-col items-center gap-2">
              <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
                <FileText className="w-6 h-6 text-green-600" />
              </div>
              <p className="font-semibold text-gray-900">{file.name}</p>
              <p className="text-xs text-gray-400">{(file.size / 1024).toFixed(0)} KB · klikni pro změnu</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center">
                <Upload className="w-6 h-6 text-gray-400" />
              </div>
              <p className="font-semibold text-gray-700">Přetáhni PDF sem nebo klikni</p>
              <p className="text-xs text-gray-400">Smlouva, sazebník nebo prospekt</p>
            </div>
          )}
        </div>

        {error && (
          <div className="mt-3 flex items-start gap-2 text-red-600 bg-red-50 rounded-lg p-3">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span className="text-sm">{error}</span>
          </div>
        )}

        <button
          onClick={handleExtract}
          disabled={!file || isExtracting}
          className="mt-4 w-full bg-purple-600 hover:bg-purple-700 disabled:bg-gray-200 disabled:text-gray-400 text-white font-semibold py-3.5 px-6 rounded-xl transition-colors flex items-center justify-center gap-2"
        >
          {isExtracting ? (
            <><Loader2 className="w-5 h-5 animate-spin" /> AI analyzuje smlouvu...</>
          ) : (
            <><Sparkles className="w-4 h-4" /> Analyzovat smlouvu</>
          )}
        </button>
        <p className="text-xs text-gray-400 text-center mt-2">Soubor není ukládán na serveru</p>
      </div>
    </div>
  );
}
