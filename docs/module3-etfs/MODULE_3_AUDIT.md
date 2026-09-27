# Module 3: Choose an ETF for your portfolio

## Assignment

Students inspect their **current** SimLife portfolio, identify one gap or concentration, compare two ETFs, and hold at least one **broad stock or bond ETF** that fits their goal. The student explains what each fund owns, overlap with existing holdings, fees, why the selected fund fits better, and what risk remains. A current holding qualifies regardless of when it was bought; students may buy and sell as they choose. There is no dollar minimum or answer word limit.

The server verifies the selected ETF against current ledger holdings and the curated directory's `BROAD` classification. It stores a snapshot with the response when submitted. Sector, thematic, commodity, and single asset ETFs remain tradable but do not meet the broad fund goal. The second comparison ETF must be a different ETF from the catalog; it need not be purchased.

Suggested rubric (10 points): portfolio need is specific (2); two ETF comparisons accurately address holdings, overlap, fees, and risks (4); selected broad ETF fits the stated need (2); remaining risk is explained (2). Grade the reasoning, not whether a student picked a teacher's preferred ticker.

## Catalog and investing audit

The generated directory currently has **42 ETFs**:

| Category | Count | Examples |
| --- | ---: | --- |
| Broad stock | 11 | VTI, VOO, VXUS, VEA, VWO |
| Tilted stock | 6 | QQQ, SCHD, VUG |
| Broad bond | 3 | BND, AGG, BNDX |
| Targeted bond | 2 | TLT, IEF |
| Sector stock | 8 | XLK, XLF, XLE, XLV |
| Real estate sector | 1 | VNQ |
| Single commodity | 1 | GLD |
| Single crypto asset | 10 | IBIT, FBTC, ETHA |

The directory labels the crypto entries `ETF` for search and trading. Some such products fall outside the SEC's investment-company ETF definition; teach them as narrow exchange-traded products rather than examples of a diversified fund.

Search and quotes support the directory. SimLife accepts dollar amounts and calculates fractional shares. The investing search now labels results as **Stock** or **ETF**, and ETF quote previews show the directory's breadth and description. That description is a classroom summary, not live fund data. The app does **not** supply current holdings, sector weights, expense ratios, prospectuses, or bid-ask spreads. Students must check the issuer's current fund page for those facts. Delayed quotes and quote-provider availability still govern trade execution.

Module 2 remains a separate stock and sector exercise. ETFs do not count toward its six individual-stock target.

## Lesson plan (about 45 minutes)

Use [Module_3_ETFs_Lesson.pptx](output/Module_3_ETFs_Lesson.pptx). The 12 slides include speaker notes and source links.

1. **5 minutes:** Ask where the existing portfolio is concentrated.
2. **10 minutes:** Explain the ETF structure and distinguish broad, tilted, sector, and single asset funds.
3. **8 minutes:** Demonstrate ticker search, quote, dollar purchase, and portfolio display in a test account.
4. **10 minutes:** Compare VTI and VXUS for a sample U.S. heavy portfolio; open current issuer fund pages to inspect holdings and fees.
5. **7 minutes:** Students identify their own gap and research two candidates.
6. **5 minutes:** Exit ticket names the gap, candidates, and a reason to reject an attractive sounding ETF.

The slide examples are discussion prompts, not recommendations. A broad ETF can still lose value and can overlap substantially with stocks a student already owns. Bond ETFs also carry interest rate and credit risk.

## Release and teacher controls

The new post type is `etf_mission`. Run `npm run seed:etf` once against the intended database to create the shared assignment as a **draft**. It is not visible to students until a teacher publishes it in **Teacher → Class → Create & publish**. After publishing, it enters the numbered class module catalog and teacher progress view. Teachers can instead create a class specific ETF assignment from the same UI. If Module 1 and Module 2 are already published, the shared post becomes Module 3 by creation time.

For next week's class, publish only after reviewing the lesson and confirming the quote provider can price the ETFs students plan to buy. The app can mark the ETF goal complete from existing current holdings, even if the student purchased the fund before publication; this is deliberate.

## Verification

- TypeScript type check and production build pass.
- The full automated suite passes, including tests for broad vs. narrow ETF holdings, submission evidence, draft visibility, and search metadata.
- On September 27, 2026, the configured Finnhub provider returned positive delayed quotes for all 14 broad stock and bond ETFs in the catalog (SPY, VOO, VTI, SCHX, SCHA, IWM, DIA, SCHF, VEA, VWO, VXUS, BND, AGG, BNDX). Future quote availability still depends on the provider.
- The 12 slide deck passes PPTX package, layout, font, and import validation. Every slide was rendered and visually reviewed.

Sources for lesson content: [SEC ETF bulletin](https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins-24), [SEC ETF characteristics](https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/characteristics-mutual-funds-exchange-traded-funds), [SEC diversification guidance](https://www.investor.gov/introduction-investing/getting-started/asset-allocation), and [SEC fund fee guidance](https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins/mutual-fund-and-etf-fees-and-expenses-investor-bulletin).
