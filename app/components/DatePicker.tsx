"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";

type View = "day" | "month" | "year";

const CS_MONTHS = [
  "Leden","Únor","Březen","Duben","Květen","Červen",
  "Červenec","Srpen","Září","Říjen","Listopad","Prosinec",
];
const CS_DAYS_SHORT = ["Po","Út","St","Čt","Pá","So","Ne"];

interface Props {
  value: string;           // "YYYY-MM-DD"
  onChange: (v: string) => void;
  hasError?: boolean;
  placeholder?: string;
}

export default function DatePicker({ value, onChange, hasError, placeholder }: Props) {
  const today = new Date();
  const currentYear = today.getFullYear();

  // Naparsuj aktuální hodnotu
  const parsed = value ? new Date(value + "T00:00:00") : null;

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("day");
  const [viewYear, setViewYear] = useState(parsed?.getFullYear() ?? currentYear);
  const [viewMonth, setViewMonth] = useState(parsed?.getMonth() ?? today.getMonth());
  // Rozsah roků pro "year" view — stránky po 20
  const [yearPage, setYearPage] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);

  // Zavři picker při kliknutí mimo
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Otevři picker — nastav view na "day" a přejdi na měsíc vybraného data
  const handleOpen = () => {
    if (parsed) {
      setViewYear(parsed.getFullYear());
      setViewMonth(parsed.getMonth());
      // Nastav yearPage tak aby vybraný rok byl viditelný
      setYearPage(Math.floor((currentYear - parsed.getFullYear()) / 20));
    } else {
      setViewYear(currentYear);
      setViewMonth(today.getMonth());
      setYearPage(0);
    }
    setView("day");
    setOpen(true);
  };

  // Formátuj zobrazení v inputu
  const displayValue = parsed
    ? `${parsed.getDate()}. ${CS_MONTHS[parsed.getMonth()]} ${parsed.getFullYear()}`
    : "";

  // ── YEAR VIEW ─────────────────────────────────────────────────
  const startYear = 1985;
  const yearsPerPage = 20;
  const yearsPerRow = 4;
  const pageStartYear = currentYear - yearPage * yearsPerPage;
  const yearsList: number[] = [];
  for (let i = 0; i < yearsPerPage; i++) {
    const y = pageStartYear - i;
    if (y >= startYear) yearsList.push(y);
  }

  const selectYear = useCallback((y: number) => {
    setViewYear(y);
    setView("month");
  }, []);

  // ── MONTH VIEW ────────────────────────────────────────────────
  const selectMonth = useCallback((m: number) => {
    setViewMonth(m);
    setView("day");
  }, []);

  // ── DAY VIEW ─────────────────────────────────────────────────
  // Dny v aktuálním viewMonth/viewYear
  const firstDay = new Date(viewYear, viewMonth, 1).getDay(); // 0=Ne,1=Po,...
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  // Převod: Monday=0 ... Sunday=6
  const startOffset = (firstDay + 6) % 7;
  const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;
  const cells: (number | null)[] = Array.from({ length: totalCells }, (_, i) => {
    const d = i - startOffset + 1;
    return d >= 1 && d <= daysInMonth ? d : null;
  });

  const selectDay = useCallback((d: number) => {
    const mm = String(viewMonth + 1).padStart(2, "0");
    const dd = String(d).padStart(2, "0");
    onChange(`${viewYear}-${mm}-${dd}`);
    setOpen(false);
  }, [viewYear, viewMonth, onChange]);

  const isSelectedDay = (d: number) =>
    parsed?.getFullYear() === viewYear &&
    parsed?.getMonth() === viewMonth &&
    parsed?.getDate() === d;

  const isToday = (d: number) =>
    today.getFullYear() === viewYear &&
    today.getMonth() === viewMonth &&
    today.getDate() === d;

  return (
    <div ref={containerRef} className="relative">
      {/* Input trigger */}
      <div
        onClick={handleOpen}
        className={`flex items-center w-full border rounded-lg px-3 py-2.5 text-sm cursor-pointer bg-white transition-colors
          ${hasError ? "border-red-400" : "border-gray-300"}
          ${open ? "ring-2 ring-green-500 border-green-500" : "hover:border-gray-400"}`}
      >
        <span className={`flex-1 ${displayValue ? "text-gray-900" : "text-gray-400"}`}>
          {displayValue || (placeholder ?? "Vyber datum")}
        </span>
        <CalendarDays className="w-4 h-4 text-gray-400 ml-2 flex-shrink-0" />
      </div>

      {/* Picker dropdown */}
      {open && (
        <div className="absolute z-50 mt-1 left-0 bg-white rounded-2xl border border-gray-200 shadow-xl overflow-hidden"
          style={{ width: 280 }}>

          {/* ── YEAR VIEW ── */}
          {view === "year" && (
            <div className="p-4">
              <div className="flex items-center justify-between mb-3">
                <button onClick={() => setYearPage(p => p + 1)}
                  disabled={pageStartYear - yearsPerPage < startYear}
                  className="p-1.5 rounded-lg hover:bg-gray-100 disabled:opacity-30">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-sm font-semibold text-gray-700">
                  {pageStartYear - yearsPerPage + 1} – {pageStartYear}
                </span>
                <button onClick={() => setYearPage(p => Math.max(0, p - 1))}
                  disabled={yearPage === 0}
                  className="p-1.5 rounded-lg hover:bg-gray-100 disabled:opacity-30">
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
              <div className={`grid grid-cols-${yearsPerRow} gap-1`}
                style={{ display: "grid", gridTemplateColumns: `repeat(${yearsPerRow}, 1fr)` }}>
                {yearsList.map((y) => (
                  <button key={y} onClick={() => selectYear(y)}
                    className={`py-2 rounded-lg text-sm font-medium transition-colors
                      ${viewYear === y ? "bg-green-600 text-white" : "hover:bg-gray-100 text-gray-700"}
                      ${parsed?.getFullYear() === y ? "ring-2 ring-green-300" : ""}`}>
                    {y}
                  </button>
                ))}
              </div>
              <button onClick={() => setView("day")}
                className="mt-3 w-full text-xs text-gray-400 hover:text-gray-600 text-center py-1">
                ← Zpět na kalendář
              </button>
            </div>
          )}

          {/* ── MONTH VIEW ── */}
          {view === "month" && (
            <div className="p-4">
              <div className="flex items-center justify-between mb-3">
                <button onClick={() => setViewYear(y => y - 1)}
                  className="p-1.5 rounded-lg hover:bg-gray-100">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button onClick={() => setView("year")}
                  className="text-sm font-semibold text-gray-700 hover:text-green-600 transition-colors px-2 py-1 rounded-lg hover:bg-gray-50">
                  {viewYear}
                </button>
                <button onClick={() => setViewYear(y => Math.min(currentYear, y + 1))}
                  disabled={viewYear >= currentYear}
                  className="p-1.5 rounded-lg hover:bg-gray-100 disabled:opacity-30">
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
              <div className="grid gap-1" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)" }}>
                {CS_MONTHS.map((name, i) => {
                  const isFuture = viewYear === currentYear && i > today.getMonth();
                  return (
                    <button key={i} onClick={() => !isFuture && selectMonth(i)}
                      disabled={isFuture}
                      className={`py-2 rounded-lg text-sm font-medium transition-colors
                        ${parsed?.getFullYear() === viewYear && parsed?.getMonth() === i
                          ? "bg-green-600 text-white"
                          : isFuture
                          ? "text-gray-300 cursor-not-allowed"
                          : "hover:bg-gray-100 text-gray-700"}`}>
                      {name.slice(0, 3)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── DAY VIEW ── */}
          {view === "day" && (
            <div className="p-4">
              {/* Header: šipky + kliknutelný „Měsíc Rok" */}
              <div className="flex items-center justify-between mb-3">
                <button onClick={() => {
                    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
                    else setViewMonth(m => m - 1);
                  }}
                  className="p-1.5 rounded-lg hover:bg-gray-100">
                  <ChevronLeft className="w-4 h-4" />
                </button>

                {/* Klik → month view */}
                <button onClick={() => setView("month")}
                  className="text-sm font-semibold text-gray-700 hover:text-green-600 transition-colors px-2 py-1 rounded-lg hover:bg-gray-50">
                  {CS_MONTHS[viewMonth]} {viewYear}
                </button>

                <button onClick={() => {
                    const next = viewMonth === 11 ? 0 : viewMonth + 1;
                    const nextY = viewMonth === 11 ? viewYear + 1 : viewYear;
                    if (nextY > currentYear || (nextY === currentYear && next > today.getMonth())) return;
                    setViewMonth(next);
                    if (viewMonth === 11) setViewYear(y => y + 1);
                  }}
                  disabled={viewYear >= currentYear && viewMonth >= today.getMonth()}
                  className="p-1.5 rounded-lg hover:bg-gray-100 disabled:opacity-30">
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              {/* Záhlaví dnů */}
              <div className="grid grid-cols-7 mb-1">
                {CS_DAYS_SHORT.map((d) => (
                  <div key={d} className="text-center text-xs font-medium text-gray-400 py-1">{d}</div>
                ))}
              </div>

              {/* Dny */}
              <div className="grid grid-cols-7 gap-0.5">
                {cells.map((d, i) => {
                  if (!d) return <div key={i} />;
                  const isFuture = viewYear === today.getFullYear() && viewMonth === today.getMonth() && d > today.getDate()
                    || viewYear > today.getFullYear()
                    || (viewYear === today.getFullYear() && viewMonth > today.getMonth());
                  return (
                    <button key={i} onClick={() => !isFuture && selectDay(d)}
                      disabled={isFuture}
                      className={`h-8 w-full rounded-lg text-sm transition-colors font-medium
                        ${isSelectedDay(d)
                          ? "bg-green-600 text-white"
                          : isToday(d)
                          ? "bg-green-100 text-green-700"
                          : isFuture
                          ? "text-gray-300 cursor-not-allowed"
                          : "hover:bg-gray-100 text-gray-700"}`}>
                      {d}
                    </button>
                  );
                })}
              </div>

              {/* Rychlý odkaz na dnešek */}
              <button onClick={() => {
                  setViewYear(today.getFullYear());
                  setViewMonth(today.getMonth());
                  selectDay(today.getDate());
                }}
                className="mt-3 w-full text-xs text-green-600 hover:text-green-700 text-center py-1 font-medium">
                Dnes ({today.toLocaleDateString("cs-CZ")})
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
