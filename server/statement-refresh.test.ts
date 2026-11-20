import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dailyStatementRefresh} from './statement-refresh.js';

test('1440 same-day ticks run one sweep; New York midnight, not UTC midnight, starts the next',async()=>{
 const calls:string[]=[];
 const refresh=dailyStatementRefresh(async now=>{calls.push(now.toISOString());});
 assert.equal(await refresh(new Date('2026-11-20T05:00:00Z')),true);
 for(let minute=1;minute<1440;minute++)assert.equal(await refresh(new Date(Date.parse('2026-11-20T05:00:00Z')+minute*60000)),false);
 assert.equal(calls.length,1);
 assert.equal(await refresh(new Date('2026-11-21T05:00:00Z')),true);
 assert.equal(calls.length,2);
});
test('overlapping ticks share a sweep, failed sweeps retry, and restarting catches up immediately',async()=>{
 let finish:()=>void=()=>{},calls=0;
 const refresh=dailyStatementRefresh(async()=>{calls++;await new Promise<void>(r=>{finish=r;});});
 const now=new Date('2026-11-20T14:00:00Z'),a=refresh(now),b=refresh(now);
 assert.equal(a,b);await Promise.resolve();assert.equal(calls,1);finish();assert.equal(await a,true);assert.equal(await b,true);
 assert.equal(await refresh(now),false);
 let attempts=0;
 const retry=dailyStatementRefresh(async()=>{if(++attempts===1)throw Error('Temporary DB outage');});
 await assert.rejects(retry(now),/Temporary/);assert.equal(await retry(now),true);assert.equal(attempts,2);
 let restarted=0;
 assert.equal(await dailyStatementRefresh(async()=>{restarted++;})(now),true);assert.equal(restarted,1);
});
test('daylight saving transitions use the full school day without skipping a sweep',async()=>{
 let calls=0;const refresh=dailyStatementRefresh(async()=>{calls++;});
 await refresh(new Date('2026-11-01T04:00:00Z'));
 await refresh(new Date('2026-11-02T04:59:00Z'));assert.equal(calls,1);
 await refresh(new Date('2026-11-02T05:00:00Z'));assert.equal(calls,2);
});
