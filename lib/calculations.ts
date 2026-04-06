import {
  ContractData,
  DataPoint,
  FeeCalculationResult,
  CalculationParams,
  EntryFeeMode,
} from "./types";

// Vypočítá celkový vstupní poplatek podle zvoleného režimu
export function calcEntryFee(contract: ContractData): number {
  switch (contract.entryFeeMode) {
    case "upfront_fixed":
      return Math.max(0, contract.entryFeeFixedAmount || 0);
    case "target_pct":
      return Math.max(0, (contract.targetAmount || 0) * (contract.entryFeePercent / 100));
    case "per_contribution_pct":
      // U pravidelného poplatku je vstupní „poplatek" z počáteční investice
      return Math.max(0, contract.initialInvestment * (contract.entryFeePercent / 100));
    default:
      return Math.max(0, contract.initialInvestment * (contract.entryFeePercent / 100));
  }
}

export const ETF_TER = 0.22;

function formatMonthLabel(date: Date): string {
  return date.toLocaleDateString("cs-CZ", { month: "short", year: "numeric" });
}

export function calculateFees(params: CalculationParams): FeeCalculationResult {
  const { contract, projectionEndDate, monthlyContribution, assumedAnnualReturn } = params;

  const startDate = new Date(contract.contractStartDate);
  const endDate = new Date(projectionEndDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dataPoints: DataPoint[] = [];

  // Mesicni sazby
  const monthlyMgmtRate = contract.annualFeePercent / 100 / 12;
  const monthlyCustodyRate = contract.custodyFeePercent / 100 / 12;
  const monthlyReturnRate = assumedAnnualReturn / 100 / 12;
  const etfMonthlyRate = ETF_TER / 100 / 12;

  // Vstupni poplatek (den 0) — závisí na zvoleném režimu
  const entryFee = calcEntryFee(contract);

  // Pro "per_contribution_pct" strhujeme % z každého měsíčního vkladu
  const contributionLoadRate = contract.entryFeeMode === "per_contribution_pct"
    ? (contract.entryFeePercent / 100)
    : 0;

  let cumulativeFees = entryFee;
  let etfCumulativeFees = 0; // ETF zpravidla 0 vstupní poplatek
  let portfolioValue = contract.initialInvestment - entryFee;

  // Breakdown
  let totalMgmtFees = 0;
  let totalPerfFees = 0;
  let totalCustodyFees = 0;

  let currentDate = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  let monthIndex = 0;

  while (currentDate <= endDate) {
    const isHistorical = currentDate <= today;

    // Zajisti ze portfolioValue je vzdy cislo >= 0
    const pv = Math.max(0, isNaN(portfolioValue) ? 0 : portfolioValue);

    // Portfolio roste o predpokldany vykon
    const grossGrowth = pv * monthlyReturnRate;

    // Mesicni spravni poplatek
    const mgmtFee = pv * monthlyMgmtRate;

    // Mesicni poplatek za uschovani
    const custodyFee = pv * monthlyCustodyRate;

    // Performance fee — pouze pokud je vykon nad benchmark
    const annualBenchmark = contract.performanceFeeBenchmark / 100;
    const monthlyBenchmark = annualBenchmark / 12;
    const excessReturn = pv > 0
      ? Math.max(0, grossGrowth / pv - monthlyBenchmark)
      : 0;
    const perfFee = pv * excessReturn * (contract.performanceFeePercent / 100);

    // Poplatek z pravidelného vkladu (jen pro per_contribution_pct režim)
    const contributionLoadFee = monthlyContribution * contributionLoadRate;
    const netContribution = monthlyContribution - contributionLoadFee;

    const totalMonthFees = mgmtFee + custodyFee + perfFee + contributionLoadFee;
    cumulativeFees += totalMonthFees;
    etfCumulativeFees += pv * etfMonthlyRate;

    totalMgmtFees += mgmtFee;
    totalPerfFees += perfFee;
    totalCustodyFees += custodyFee;

    // Aktualizuj portfolio
    portfolioValue = pv + grossGrowth + netContribution - (mgmtFee + custodyFee + perfFee);
    if (portfolioValue < 0) portfolioValue = 0;

    dataPoints.push({
      monthIndex,
      label: formatMonthLabel(currentDate),
      date: currentDate.toISOString().split("T")[0],
      cumulativeFees: Math.round(cumulativeFees),
      etfCumulativeFees: Math.round(etfCumulativeFees),
      isHistorical,
      portfolioValue: Math.round(portfolioValue),
    });

    currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1);
    monthIndex++;
  }

  // Výstupní poplatek (na konci projekce)
  const lastPv = Math.max(0, isNaN(portfolioValue) ? 0 : portfolioValue);
  const exitFee = lastPv * (contract.exitFeePercent / 100);
  cumulativeFees += exitFee;

  const historicalPoints = dataPoints.filter((d) => d.isHistorical);
  const lastHistorical = historicalPoints[historicalPoints.length - 1];
  const totalPaidSoFar = lastHistorical?.cumulativeFees ?? entryFee;
  const annualFeesPaid = totalPaidSoFar - entryFee;

  const lastPoint = dataPoints[dataPoints.length - 1];
  const projectedTotalFees = (lastPoint?.cumulativeFees ?? 0) + exitFee;
  const etfTotalFees = lastPoint?.etfCumulativeFees ?? 0;

  return {
    dataPoints,
    totalPaidSoFar,
    entryFeePaid: entryFee,
    annualFeesPaid,
    projectedTotalFees,
    etfTotalFees,
    potentialSavings: projectedTotalFees - etfTotalFees,
    breakdown: {
      entryFee,
      managementFees: totalMgmtFees,
      performanceFees: totalPerfFees,
      custodyFees: totalCustodyFees,
      exitFee,
    },
  };
}

export function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat("cs-CZ", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function getDefaultProjectionEnd(yearsFromNow = 10): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + yearsFromNow);
  return d.toISOString().split("T")[0];
}

export function defaultContract(): ContractData {
  return {
    fundName: "",
    isin: "",
    contractStartDate: new Date().toISOString().split("T")[0],
    initialInvestment: 0,
    currency: "CZK",
    entryFeeMode: "upfront_fixed",
    entryFeeFixedAmount: 0,
    entryFeePercent: 0,
    targetAmount: 0,
    annualFeePercent: 0,
    exitFeePercent: 0,
    performanceFeePercent: 0,
    performanceFeeBenchmark: 5,
    custodyFeePercent: 0,
    monthlyContribution: 0,
  };
}

// Pomocná funkce: vrátí entryFeePercent ekvivalent pro zobrazení
export function entryFeeModeLabel(mode: EntryFeeMode): string {
  switch (mode) {
    case "upfront_fixed":        return "Předplacený — fixní částka";
    case "per_contribution_pct": return "Z každého vkladu (%)";
    case "target_pct":           return "Z cílové částky (%)";
  }
}
