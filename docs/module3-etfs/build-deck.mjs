import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Presentation, PresentationFile } from '@oai/artifact-tool';

const root = '/Users/justinlee/Desktop/_Active/ths_textbook/simlife-investing/docs/module3-etfs';
const skill = '/Users/justinlee/.codex/plugins/cache/openai-primary-runtime/presentations/26.909.12148/skills/presentations';
const build = path.join(root, '.deck-build');
const out = path.join(root, 'output', 'Module_3_ETFs_Lesson.pptx');
await fs.mkdir(build, { recursive: true });
await fs.mkdir(path.dirname(out), { recursive: true });
const p = Presentation.create({ slideSize: { width: 1280, height: 720 } });
const C = { paper:'#F7F6F1', ink:'#22231D', olive:'#555B34', muted:'#686B5E', pale:'#E8EBDF', white:'#FFFFFF', orange:'#B76A43' };

function txt(slide, value, x,y,w,h,size=28,color=C.ink,bold=false,font='Arial') {
  const shape = slide.shapes.add({ geometry:'textbox', position:{left:x,top:y,width:w,height:h}, fill:'none', line:{fill:'none',width:0} });
  shape.text = value;
  shape.text.style = { typeface:font, fontSize:size, color, bold, autoFit:'none' };
  return shape;
}
function base(title, n, opts={}) {
  const slide=p.slides.add(); slide.background.fill=opts.dark?C.olive:C.paper;
  const fg=opts.dark?C.white:C.ink;
  txt(slide,`SIMLIFE  /  INVESTING  /  MODULE 3`,64,34,800,30,17,opts.dark?C.pale:C.olive,true);
  txt(slide,title,64,91,1140,122,opts.titleSize||45,fg,true,'Georgia');
  txt(slide,String(n).padStart(2,'0'),1160,650,60,28,16,opts.dark?C.pale:C.muted,true);
  return slide;
}
function notes(slide,text,sources=[]) { slide.speakerNotes.textFrame.setText(`${text}${sources.length?'\n\nSources:\n'+sources.join('\n'):''}`); }
function lines(slide,items,x=80,y=230,w=1080,gap=88,size=27,color=C.ink) { items.forEach((item,i)=>txt(slide,item,x,y+i*gap,w,gap-10,size,color)); }
const sec='https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins-24';
const secCompare='https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/characteristics-mutual-funds-exchange-traded-funds';
const secDiversify='https://www.investor.gov/introduction-investing/getting-started/asset-allocation';
const secFees='https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins/mutual-fund-and-etf-fees-and-expenses-investor-bulletin';

{
 const s=base('One ticker can hold a basket',1,{dark:true,titleSize:68});
 txt(s,'Exchange traded funds  ·  Portfolio balance  ·  Your next decision',70,275,1060,100,31,C.pale);
 txt(s,'Today: find a gap in your portfolio, compare funds, and choose one you can explain.',70,464,1030,95,28,C.white);
 notes(s,'Opening prompt: Which part of your current portfolio would be hurt if one company or one type of company struggled? Let students answer without assuming a right ticker.');
}
{
 const s=base('What is an ETF?',2);
 txt(s,'An ETF is a fund that trades on an exchange under a ticker, like a stock.',80,228,1100,90,31);
 txt(s,'The fund owns a basket of investments. You own shares of the fund.',80,350,1080,88,31,C.olive,true);
 txt(s,'The basket might contain stocks, bonds, or a much narrower asset.',80,475,1080,70,28);
 notes(s,'Define “exchange traded fund.” Emphasize ownership of fund shares rather than direct ownership of each security. A fund can be broad or narrow.',[sec,secCompare]);
}
{
 const s=base('One company versus a fund',3);
 txt(s,'AAPL',85,245,340,65,46,C.olive,true,'Georgia'); txt(s,'One company',85,320,340,52,26);
 txt(s,'VTI',645,245,340,65,46,C.olive,true,'Georgia'); txt(s,'A broad U.S. stock fund',645,320,490,52,26);
 txt(s,'Both have a ticker and a changing market price. Their underlying risks differ.',85,495,1050,100,30);
 notes(s,'Ask: What happens to AAPL if Apple has a bad year? What happens to VTI if Apple has a bad year? Do not promise that a broad ETF cannot lose money. VTI details are based on the local SimLife catalog; verify fund details on issuer site before any real-money use.',[sec,secDiversify]);
}
{
 const s=base('An ETF ticker does not tell the whole story',4);
 lines(s,[
  'VTI  →  U.S. stocks across the market',
  'VXUS  →  Stocks outside the U.S.',
  'BND  →  A broad mix of U.S. bonds',
  'XLK  →  Technology stocks only',
  'IBIT  →  Bitcoin exposure'
 ],90,220,1070,79,27);
 notes(s,'These descriptions follow the SimLife ETF directory as audited September 2026. Ask which funds can fill a broad gap and which are concentrated. Stress that the ETF wrapper alone does not guarantee diversification.',[secCompare,secDiversify]);
}
{
 const s=base('How ETFs appear in SimLife',5);
 lines(s,[
  'Investing  →  Search a ticker, such as VTI',
  'Read the fund name and current quote',
  'Enter a dollar amount; SimLife calculates fractional shares',
  'After buying, the ETF appears in your portfolio beside stocks'
 ],86,240,1090,92,27);
 txt(s,'Try VTI, VXUS, BND, or VOO in the search box.',86,617,1000,34,22,C.olive,true);
 notes(s,'Live demo in a test account. Search the ticker and show the quote, then buy only if classroom demo funds are available. The app supports fractional share purchases. Do not imply that a delayed quote is a guaranteed execution price.');
}
{
 const s=base('Read the fund before buying',6);
 lines(s,[
  'What does it own?  Stocks, bonds, a sector, or one asset?',
  'Where is it invested?  U.S., outside the U.S., or both?',
  'What overlaps with your current holdings?',
  'What is the expense ratio?  Check the issuer’s fund page.',
  'What could make it lose value?'
 ],86,220,1080,80,26);
 notes(s,'Show a current issuer fund page or prospectus. Expense ratios can change, so the deck intentionally omits fixed fee figures. Mention that bid-ask spreads and brokerage trading costs can also matter outside this simulation.',[sec,secFees]);
}
{
 const s=base('Your portfolio gap',7);
 txt(s,'Look at what you already own',82,220,1080,62,35,C.olive,true);
 lines(s,[
  'Many U.S. tech stocks?  Another U.S. tech fund may repeat that bet.',
  'Only U.S. stocks?  A broad international fund may add geography.',
  'Only company stocks?  A broad bond fund changes asset type.'
 ],86,328,1080,90,27);
 notes(s,'These are examples for discussion, not prescriptions. A student might choose a different broad ETF if they can explain the fit and tradeoff. Bond ETFs have interest rate and credit risks. International stocks carry currency and market risks.',[secDiversify,sec]);
}
{
 const s=base('The overlap question',8);
 txt(s,'Owning 10 tickers does not always mean 10 different bets.',82,235,1100,100,38,C.olive,true,'Georgia');
 txt(s,'AAPL + MSFT + QQQ may leave you heavily exposed to large technology companies.',82,385,1090,100,30);
 txt(s,'Look through the ETF to its top holdings and sector weights.',82,540,1080,65,27);
 notes(s,'QQQ is a non-financial Nasdaq fund and the SimLife directory marks it as tilted toward technology. Use this as a qualitative overlap example rather than exact portfolio-weight arithmetic. Funds can overlap even when their names differ.',[secDiversify]);
}
{
 const s=base('Compare two ETF candidates',9);
 txt(s,'Student example: mostly U.S. company stocks',84,215,1090,50,29,C.olive,true);
 txt(s,'VTI',88,298,210,65,44,C.ink,true,'Georgia');
 txt(s,'Broad U.S. stocks\nAdds many companies\nStill mostly U.S. stock risk',88,380,450,190,26);
 txt(s,'VXUS',675,298,310,65,44,C.ink,true,'Georgia');
 txt(s,'Broad non-U.S. stocks\nAdds geographic exposure\nStill stock market risk',675,380,460,190,26);
 notes(s,'Ask students: Which fits the stated gap better? If the gap is geographic, VXUS is the clearer explanation. If the goal is broad U.S. coverage, VTI may fit. Check current fund pages for holdings and costs; do not imply one is universally best.',[secDiversify]);
}
{
 const s=base('Module 3 assignment',10,{dark:true});
 lines(s,[
  'Identify a gap or concentration in your portfolio.',
  'Compare two ETFs: holdings, overlap, fees, and risk.',
  'Hold one broad stock or bond ETF that fits your goal.',
  'Explain the effect you expect and the risk that remains.'
 ],82,225,1100,96,29,C.white);
 notes(s,'The app checks current holdings for a broad stock or bond ETF. Students choose one held fund and enter a second ETF they researched. No fixed spending minimum and no requirement to preserve Module 2 holdings. Sector, thematic, commodity, and crypto single-asset ETFs do not satisfy the broad fund check.');
}
{
 const s=base('What a strong explanation sounds like',11);
 txt(s,'“My portfolio is mostly U.S. company stocks. I chose VXUS because it holds companies outside the U.S. I compared it with VTI, which would add more U.S. stocks I already have. I checked each fund’s holdings and costs. VXUS adds geographic spread, but I can still lose money if global stocks fall.”',88,220,1090,365,30,C.ink);
 notes(s,'Model answer only. Students should use their own actual portfolio and fund research. Ask the class to identify the gap, comparison, decision, and remaining risk. Do not grade on agreement with one ticker.',[secDiversify,secFees]);
}
{
 const s=base('Exit ticket',12);
 lines(s,[
  'Which risk in your portfolio are you trying to change?',
  'Which two ETFs will you compare?',
  'What would make you reject an ETF, even if its name sounds right?'
 ],82,225,1100,115,32);
 txt(s,'Next: open Investing, research two funds, then begin your Module 3 draft.',82,615,1100,44,22,C.olive,true);
 notes(s,'Collect responses before independent work. Ask students to name a concrete holding or sector in their current portfolio. Teacher can publish the saved draft from Teacher → Class when ready.');
}

const { finalizePresentation } = await import(pathToFileURL(path.join(skill,'container_tools/artifact_tool_utils.mjs')).href);
const candidate=path.join(build,'candidate.pptx');
await (await PresentationFile.exportPptx(p)).save(candidate);
const result=await finalizePresentation({
 workspaceDir:root, candidatePath:candidate, finalPath:out,
 pythonExecutable:'/Users/justinlee/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3',
 integrityValidatorPath:path.join(skill,'container_tools/inspect_presentation_package_integrity.py'),
 layoutValidatorPath:path.join(skill,'container_tools/inspect_presentation_layout_geometry.py'),
 layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-bullet-geometry','--validate-heading-fit'],
 requiredNativeTableOwnerSlides:[], fontPolicy:{basis:'design',families:['Arial','Georgia']},
 verifyArtifactToolImport:true, receiptPath:path.join(build,'validation.json'),
});
console.log(result);
for(let i=0;i<p.slides.items.length;i++){
 const slide=p.slides.items[i]; const preview=await p.export({slide,format:'png',scale:1});
 await fs.writeFile(path.join(build,`slide-${String(i+1).padStart(2,'0')}.png`),new Uint8Array(await preview.arrayBuffer()));
}
console.log(out);
