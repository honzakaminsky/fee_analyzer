# Analyzátor poplatků fondů

Webová aplikace, která analyzuje poplatky u investičních fondů (Conseq, Amundi, ČP Invest...).

## Rychlý start

1. **Nainstaluj závislosti:**
   ```bash
   npm install
   ```

2. **Nastav API klíč:**
   ```bash
   cp .env.example .env.local
   # Otevři .env.local a doplň ANTHROPIC_API_KEY
   ```

3. **Spusť vývojový server:**
   ```bash
   npm run dev
   ```

4. Otevři http://localhost:3000

## Funkce

- Nahrání PDF smlouvy s drag & drop
- AI extrakce poplatků pomocí Claude API
- Editovatelný formulář pro kontrolu/opravu dat
- Interaktivní graf kumulativních poplatků
- Výpočet "zaplaceno dosud" od data smlouvy
- Rychlé volby časového rámce (+1, +5, +10... let)
- Slider pro počáteční investici a měsíční vklady
- Srovnání s levným ETF (Vanguard FTSE All-World, 0,22 % TER)

## Struktura projektu

```
app/
  page.tsx          - Upload stránka
  review/page.tsx   - Kontrola/editace dat
  results/page.tsx  - Interaktivní vizualizace
  api/extract/      - API route: Claude PDF extrakce
lib/
  types.ts          - TypeScript typy
  calculations.ts   - Logika výpočtu poplatků
```

## Budoucí rozvoj (nápady)

- [ ] Freemium: 1 analýza zdarma, více po registraci (Stripe)
- [ ] Ukládání analýz (databáze - Supabase/PlanetScale)
- [ ] Export do PDF
- [ ] Srovnání více smluv najednou
- [ ] Kalkulace i s předpokládaným výnosem portfolia
- [ ] OCR pro naskenované dokumenty
