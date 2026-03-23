export interface ContractData {
  fundName: string;
  providerName?: string;       // název poskytovatele / správce fondu
  isin?: string;
  contractStartDate: string;       // "YYYY-MM-DD"
  initialInvestment: number;
  currency: "CZK" | "EUR" | "USD";

  // Poplatky
  entryFeePercent: number;         // vstupní poplatek %
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
  oneYearReturn?: number;    // % za 1 rok
  threeYearReturn?: number;  // % za 3 roky
  fiveYearReturn?: number;   // % za 5 let
  ter?: number;              // TER pokud je dostupné
  source?: string;           // zdroj dat
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
