import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { ContractData } from "@/lib/types";

// pdf-parse musí být dynamicky importován v Next.js (vyhne se problémům s inicializací)
async function parsePdf(buffer: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse");
  const result = await pdfParse(buffer);
  return result.text;
}

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const EXTRACTION_PROMPT = `Jsi expert na analýzu investičních smluv, prospektů fondů a KIID dokumentů.
Analyzuj přiložený text dokumentu a vytáhni z něj tyto informace:

1. Název fondu (fundName) — přesný název konkrétního podílového fondu / ETF z dokumentu
2. Název společnosti / poskytovatele (providerName) — kdo fond spravuje nebo distribuuje
   (napr. "ČP Invest", "Conseq", "Amundi", "ČSOB Asset Management", "REICO", "KB Asset Management", "iShares", "NN Investment Partners")
3. ISIN (isin) — 12místný mezinárodní identifikátor cenného papíru, začíná 2 písmeny (napr. CZ0008472437, LU1829218749)
   Hledej slovíčka "ISIN", "identifikátor", "kód cenného papíru"
4. Datum zahájení smlouvy / začátek investice (contractStartDate) ve formátu YYYY-MM-DD
5. Výše počáteční investice / vkladu (initialInvestment) jako číslo
6. Pravidelný měsíční vklad (monthlyContribution) jako číslo — hledej "pravidelná investice", "měsíční vklad", "pravidelný příkaz"
7. Vstupní poplatek v procentech (entryFeePercent) — hledej "vstupní poplatek", "subscription fee", "entry fee", "poplatek za nákup", "prodejní přirážka"
8. Roční poplatek za správu / TER v procentech (annualFeePercent) — hledej "TER", "roční náklady", "management fee", "poplatek za správu", "ongoing charges", "celkové náklady"
9. Výstupní poplatek v procentech (exitFeePercent) — hledej "výstupní poplatek", "redemption fee", "poplatek za odkoupení"
10. Poplatek za výkonnost v procentech (performanceFeePercent) — hledej "performance fee", "poplatek za výkonnost", "výkonnostní odměna"
11. Poplatek za úschovu v procentech (custodyFeePercent) — hledej "custody fee", "poplatek za úschovu", "správní poplatek za vedení účtu"
12. Měna (currency) — "CZK", "EUR", nebo "USD"

PRAVIDLA:
- Poplatky zadej jako procenta (napr. 3 pro 3%, NE 0.03)
- Pokud pole nenalezneš, použij: vstupní 0, roční 1.5, výstupní 0, ostatní poplatky 0
- Datum formátuj jako YYYY-MM-DD
- Investici jako celé číslo (bez mezer a symbolů)
- ISIN: pokud v dokumentu není, vlož prázdný řetězec ""
- providerName: pokud nelze určit, vlož prázdný řetězec ""

Odpověz POUZE validním JSON objektem (bez markdown, bez komentářů):
{
  "fundName": "Název fondu",
  "providerName": "Název poskytovatele",
  "isin": "CZ0008472437",
  "contractStartDate": "2020-01-15",
  "initialInvestment": 100000,
  "monthlyContribution": 2000,
  "entryFeePercent": 3,
  "annualFeePercent": 2,
  "exitFeePercent": 0,
  "performanceFeePercent": 0,
  "custodyFeePercent": 0,
  "currency": "CZK"
}`;

export async function POST(req: NextRequest) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "ANTHROPIC_API_KEY není nastaveno v .env.local" },
        { status: 500 }
      );
    }

    const formData = await req.formData();
    const file = formData.get("pdf") as File | null;

    if (!file) {
      return NextResponse.json({ error: "Žádný soubor nebyl nahrán." }, { status: 400 });
    }

    if (file.size > 20 * 1024 * 1024) {
      return NextResponse.json({ error: "Soubor je příliš velký (max. 20 MB)." }, { status: 400 });
    }

    // Převed PDF na Buffer a vytáhni text
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let pdfText = "";
    try {
      pdfText = await parsePdf(buffer);
      console.log(`[extract] PDF parsed, text length: ${pdfText.length} chars`);
    } catch (pdfErr) {
      console.error("[extract] pdf-parse error:", pdfErr);
      return NextResponse.json(
        { error: "Nepodařilo se přečíst PDF. Ujisti se, že soubor není zaheslovaný." },
        { status: 422 }
      );
    }

    if (!pdfText.trim()) {
      return NextResponse.json(
        { error: "PDF neobsahuje čitelný text. Možná jde o naskenovaný dokument." },
        { status: 422 }
      );
    }

    // Omez text na prvnich 15 000 znaku (vetšina smluv ma klicova data na zacatku)
    const truncatedText = pdfText.slice(0, 15000);

    // Zavolej Claude API
    console.log(`[extract] Calling Claude API, text preview: "${pdfText.slice(0, 100)}..."`);
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `${EXTRACTION_PROMPT}\n\nTEXT DOKUMENTU:\n\n${truncatedText}`,
        },
      ],
    });

    const responseText =
      message.content[0].type === "text" ? message.content[0].text : "";

    // Parsuj JSON z odpovědi
    let extracted: ContractData;
    try {
      // Odstraň případné markdown obalení
      const cleaned = responseText
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      extracted = JSON.parse(cleaned);
    } catch {
      console.error("Claude response:", responseText);
      return NextResponse.json(
        { error: "Nepodařilo se zpracovat odpověď AI. Zkus to znovu." },
        { status: 500 }
      );
    }

    // Validace a sanitace hodnot
    const result: ContractData = {
      fundName: String(extracted.fundName || "Neznámý fond"),
      providerName: extracted.providerName ? String(extracted.providerName) : undefined,
      isin: extracted.isin ? String(extracted.isin).trim().toUpperCase() : "",
      contractStartDate:
        extracted.contractStartDate || new Date().toISOString().split("T")[0],
      initialInvestment: Math.max(0, Number(extracted.initialInvestment) || 0),
      entryFeePercent: Math.min(20, Math.max(0, Number(extracted.entryFeePercent) || 0)),
      annualFeePercent: Math.min(10, Math.max(0, Number(extracted.annualFeePercent) || 1.5)),
      exitFeePercent: Math.min(10, Math.max(0, Number(extracted.exitFeePercent) || 0)),
      performanceFeePercent: Math.min(50, Math.max(0, Number(extracted.performanceFeePercent) || 0)),
      performanceFeeBenchmark: Math.min(30, Math.max(0, Number(extracted.performanceFeeBenchmark) || 5)),
      custodyFeePercent: Math.min(5, Math.max(0, Number(extracted.custodyFeePercent) || 0)),
      monthlyContribution: Math.max(0, Number(extracted.monthlyContribution) || 0),
      currency: (["CZK", "EUR", "USD"].includes(extracted.currency)
        ? extracted.currency
        : "CZK") as "CZK" | "EUR" | "USD",
    };

    return NextResponse.json(result);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[extract] Unhandled error:", msg);
    // Vrať specifičtější chybovou zprávu pokud možno
    if (msg.includes("credit") || msg.includes("balance")) {
      return NextResponse.json({ error: "Nedostatek kreditů na Anthropic účtu. Dobij na console.anthropic.com." }, { status: 402 });
    }
    if (msg.includes("api_key") || msg.includes("authentication") || msg.includes("auth")) {
      return NextResponse.json({ error: "Neplatný API klíč. Zkontroluj .env.local soubor." }, { status: 401 });
    }
    if (msg.includes("model")) {
      return NextResponse.json({ error: `Chyba modelu: ${msg}` }, { status: 500 });
    }
    return NextResponse.json(
      { error: `Chyba serveru: ${msg.slice(0, 120)}` },
      { status: 500 }
    );
  }
}
