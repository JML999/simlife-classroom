# Module 3: Use two ETFs for two portfolio goals

## Assignment

Students inspect their **current** SimLife portfolio and identify an area with little or no exposure. They hold one ETF to fill that gap, then identify a different area they are bullish on and hold a second, different ETF to increase that exposure. For each, they explain what the fund owns, how it serves the goal, overlap, fees, and risks. There is no dollar minimum or answer word limit. They may buy and sell freely; only current holdings count.

The server verifies two different current ETF holdings from the curated directory. Broad, tilted, and sector funds qualify; single asset commodity and crypto products do not. The server cannot establish whether a student's described gap or thesis is sound from the ticker alone, so the teacher evaluates that reasoning. A holdings snapshot is stored with each submission.

Suggested rubric (10 points): portfolio gap and supporting evidence (2); gap ETF fit and risks (3); investment idea and supporting reasoning (2); second ETF fit, overlap, and risks (3). Grade the reasoning, not whether a student picked a preferred ticker.

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
5. **7 minutes:** Students identify their own gap and investment idea, then research two funds.
6. **5 minutes:** Exit ticket names both goals, two funds, and their risks.

The slide examples are discussion prompts, not recommendations. A broad ETF can still lose value and can overlap substantially with stocks a student already owns. Bond ETFs also carry interest rate and credit risk.

## Release and teacher controls

The shared `etf_mission` post is Module 3 after it is enabled. The teacher's per-period module visibility checkboxes control access. For classroom testing, show Module 3 in the 1st Period test class and hide it from 3rd and 4th Period. Direct post and submission routes also enforce those visibility settings.

## Verification

- TypeScript type check and production build pass.
- The full automated suite passes, including tests for two distinct current ETF holdings, submission evidence, draft visibility, and search metadata.
- On September 27, 2026, the configured Finnhub provider returned positive delayed quotes for all 14 broad stock and bond ETFs in the catalog (SPY, VOO, VTI, SCHX, SCHA, IWM, DIA, SCHF, VEA, VWO, VXUS, BND, AGG, BNDX). Future quote availability still depends on the provider.
- The 12 slide deck passes PPTX package, layout, font, and import validation. Every slide was rendered and visually reviewed.

Sources for lesson content: [SEC ETF bulletin](https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins-24), [SEC ETF characteristics](https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/characteristics-mutual-funds-exchange-traded-funds), [SEC diversification guidance](https://www.investor.gov/introduction-investing/getting-started/asset-allocation), and [SEC fund fee guidance](https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins/mutual-fund-and-etf-fees-and-expenses-investor-bulletin).
