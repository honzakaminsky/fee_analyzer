// Způsob účtování vstupního poplatku
export type EntryFeeMode =
  | "upfront_fixed"        // Předplacený — fixní částka v Kč/€
  | "per_contribution_pct" // Pravidelný — % z každého vkladu
  | "target_pct";          // % z cílové/smluvní částky

export interface ContractData {
  fundName: string;
  providerName?: string;       // název poskytovatele / správce fondu
  isin?: string;
  contractStartDate: string;       // "YYYY-MM-DD"
  initialInvestment: number;
  currency: "CZK" | "EUR" | "USD";

  // Vstupní poplatek — tři různé režimy
  entryFeeMode: EntryFeeMode;
  entryFeeFixedAmount: number;     // Kč/€ — pro mode "upfront_fixed"
  entryFeePercent: number;         // % — pro mode "per_contribution_pct" a "target_pct"
  targetAmount: number;            // cílová/smluvní částka — pro mode "target_pct"

  annualFeePercent: number;        // TER / roční správa %
  exitFeePercent: number;          // výstupní poplatek %
  performanceFeePercent: number;   // poplatek za výkonnost % (z nadměrného výnosu)
  performanceFeeBenchmark: number; // hurdle rate pro performance fee %
  custodyFeePercent: number;       // poplatek za úschovu/platformu % ročně
  monthlyContribution: number;     // pravidelný měsíční příspěvek
}

export interface FundInfo {
  name: string;
  isin?: string;
  ticker?: string;
  currency?: string;
  // Výkonnost p.a.
  oneYearReturn?: number;       // % za 1 rok
  threeYearReturn?: number;     // % za 3 roky
  fiveYearReturn?: number;      // % za 5 let
  // Poplatky
  ter?: number;                 // TER / ongoing charges % ročně
  entryFee?: number;            // vstupní poplatek %
  exitFee?: number;             // výstupní poplatek %
  performanceFee?: number;      // poplatek za výkonnost %
  custodyFee?: number;          // poplatek za úschovu/platformu % ročně
  // Metadata fondu
  fundCategory?: string;        // kategorie: akciový, dluhopisový, smíšený...
  riskLevel?: number;           // SRI 1–7
  provider?: string;            // název správce fondu
  source?: string;              // zdroj dat
}

export interface DataPoint {
  monthIndex: number;
  label: string;
  date: string;
  cumulativeFees: number;
  etfCumulativeFees: number;
  isHistorical: boolean;
  portfolioValue: number;
}

export interface FeeCalculationResult {
  dataPoints: DataPoint[];
  totalPaidSoFar: number;
  entryFeePaid: number;
  annualFeesPaid: number;
  projectedTotalFees: number;
  etfTotalFees: number;
  potentialSavings: number;
  breakdown: {
    entryFee: number;
    managementFees: number;
    performanceFees: number;
    custodyFees: number;
    exitFee: number;
  };
}

export interface CalculationParams {
  contract: ContractData;
  projectionEndDate: string;
  monthlyContribution: number;
  assumedAnnualReturn: number; // % předpokládaný výnos (pro performance fee)
}
