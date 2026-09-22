import test from 'node:test';
import assert from 'node:assert/strict';
import {cardKey,cents,chooseMatch,matchesCard,signature,refreshEntry,blankState,runBatch,client,ProviderError,DAY,sourceURL,processCard,sheetCards,acquireLease,releaseLease,publicEntries} from '../netlify/functions/_scp-core.mjs';
const now=Date.UTC(2026,8,21);
const row={player:'Troy Aikman',year:'1989',brand:'Score',number:'270',type:'Base',rookie:'Y',notes:'',productId:'',url:''};row.key=cardKey(row);
const product={id:'123', 'product-name':'Troy Aikman #270','console-name':'Football Cards 1989 Score','loose-price':325};
function memoryStore(initial={}){
 const map=new Map(Object.entries(initial).map(([k,v])=>[k,{data:structuredClone(v),etag:'0'}]));let version=0;
 return {async get(k){return structuredClone(map.get(k)?.data)||null;},async getWithMetadata(k){return structuredClone(map.get(k))||null;},async setJSON(k,data,opt={}){if(opt.onlyIfNew&&map.has(k)||opt.onlyIfMatch&&map.get(k)?.etag!==opt.onlyIfMatch)return {modified:false};const etag=String(++version);map.set(k,{data:structuredClone(data),etag});return {modified:true,etag};}};
}
function fakeClient(log,fail=false){return ()=>({get calls(){return log.length;},async get(path,params){log.push([path,params]);if(fail)throw new ProviderError('Service unavailable',502);return path==='products'?{products:[product]}:product;}});}
test('provider cents: no null/empty/zero/negative prices become estimates',()=>{
 for(const v of [null,undefined,'',0,-5,'NaN',' '])assert.equal(cents(v),null);
 assert.equal(cents('325'),3.25);
});
test('exact identity matches, wrong year/set/player/number does not',()=>{
 assert.ok(matchesCard(row,product));
 for(const p of [{...product,'console-name':'Football Cards 1990 Score'},{...product,'console-name':'Football Cards 1989 Score Supplemental'},{...product,'product-name':'Troy Aikman #270 [Gold]'},{...product,'product-name':'Troy Aikmann #270'},{...product,'product-name':'Troy Aikman #2700'}])assert.equal(matchesCard(row,p),false);
});
test('variants and inserts require exact descriptors; ties unresolved',()=>{
 assert.equal(chooseMatch(row,[product,{...product,id:'124'}]),null);
 assert.equal(chooseMatch({...row,type:'Parallel'},[product]),null);
 assert.ok(matchesCard({...row,type:'Parallel',notes:'Gold'},{...product,'product-name':'Troy Aikman [Gold] #270'}));
 assert.equal(matchesCard({...row,type:'Parallel',notes:'Gold'},{...product,'product-name':'Troy Aikman [Gold Refractor] #270'}),false);
});
test('alphanumeric card numbers preserved',()=>{
 assert.ok(matchesCard({...row,number:'RC-10'},{...product,'product-name':'Troy Aikman #RC-10'}));
});
test('snapshots are daily deduplicated and reset for a different product',()=>{
 const first=refreshEntry({},product,now);assert.equal(first.ungraded,3.25);
 const again=refreshEntry(first,{...product,'loose-price':400},now+1000);assert.equal(again.history.length,1);assert.equal(again.history[0].numericPrice,4);
 const next=refreshEntry(again,product,now+7*DAY);assert.equal(next.history.length,2);
 const changed=refreshEntry(next,{...product,id:'999'},now+8*DAY);assert.equal(changed.history.length,1);
});
test('Google Sheet inherits names, quantities and reads appended mappings',()=>{
 const headers=['First','Last','Year','RC','Brand','Type','Number','Qty','I','J','K','L','M','N','Notes','SportsCardsPro ID','SportsCardsPro URL'];
 const r=['Troy','Aikman','1989','Y','Score','Base','270','2','','','','','','','','123',''];
 const cards=sheetCards(headers.join(',')+'\n'+r.join(',')+'\n'+['','','1990','N','Score','Base','1','1'].join(','));
 assert.equal(cards[0].productId,'123');assert.equal(cards[1].player,'Troy Aikman');assert.equal(cards[0].quantity,2);
 assert.throws(()=>sheetCards('<html>login</html>'));
});
test('only SportsCardsPro HTTPS card URLs accepted',()=>{
 assert.equal(sourceURL('https://evil.test/game/card'),'');assert.equal(sourceURL('javascript:alert(1)'),'');
 assert.equal(sourceURL('https://www.sportscardspro.com/game/football-cards-1989-score/troy-aikman-270?x=y'),'https://www.sportscardspro.com/game/football-cards-1989-score/troy-aikman-270');
});
test('manual numeric IDs resolve naming variations; malformed IDs require review',async()=>{
 const state=blankState();const api=fakeClient([])();
 assert.equal((await processCard({...row,productId:'123'},state,api,now)).id,'123');
 assert.equal((await processCard({...row,productId:'bad'},state,api,now)).state,'review');
});
test('weekly cache and duplicate copies avoid repeated API calls',async()=>{
 const s=memoryStore();const log=[];const options={cardsLoader:async()=>[row,{...row,quantity:3}],token:'test',now:()=>now,clientFactory:fakeClient(log)};
 await runBatch(s,options);assert.equal(log.length,2);
 assert.equal((await s.get('state')).status.valuedRows,2);
 await runBatch(s,options);assert.equal(log.length,2);
 await runBatch(s,{...options,now:()=>now+8*DAY});assert.equal(log.length,3);
});
test('batch limit yields partial progress and next batch resumes',async()=>{
 const rows=Array.from({length:4},(_,i)=>({...row,key:row.key+i,notes:String(i),productId:'123'}));
 const s=memoryStore();const log=[];
 const opts={cardsLoader:async()=>rows,token:'test',now:()=>now,clientFactory:fakeClient(log),maxCalls:3};
 const result=await runBatch(s,opts);assert.equal(result.phase,'partial');assert.equal(Object.keys((await s.get('state')).entries).length,2);
 const log2=[];await runBatch(s,{...opts,clientFactory:fakeClient(log2)});assert.equal(Object.keys((await s.get('state')).entries).length,4);
});
test('provider failure preserves known prices and sets retry cooldown',async()=>{
 const entry={...refreshEntry({},product,now-8*DAY),inputSignature:signature(row)};
 const state={...blankState(),entries:{[row.key]:entry}};const s=memoryStore({state});
 await runBatch(s,{cardsLoader:async()=>[row],token:'test',now:()=>now,clientFactory:fakeClient([],true)});
 const saved=await s.get('state');assert.equal(saved.entries[row.key].ungraded,3.25);assert.equal(saved.status.phase,'error');assert.ok(saved.status.retryAfter>now);
});
test('conflicting manual mappings on duplicate rows are never silently chosen',async()=>{
 const s=memoryStore();const log=[];await runBatch(s,{cardsLoader:async()=>[{...row,productId:'123'},{...row,productId:'456'}],token:'test',now:()=>now,clientFactory:fakeClient(log)});
 assert.equal((await s.get('state')).entries[row.key].state,'review');assert.equal(log.length,0);
});
test('lease excludes concurrent workers and can be released',async()=>{
 const s=memoryStore();const leases=await Promise.all([acquireLease(s,now),acquireLease(s,now)]);assert.equal(leases.filter(Boolean).length,1);
 await releaseLease(s,leases.find(Boolean));assert.ok(await acquireLease(s,now));
});
test('client enforces spacing, converts HTTP errors, never echoes token',async()=>{
 let clock=now;const delays=[];const state=blankState();let n=0;
 const api=client('secret-token',state,{now:()=>clock,sleep:async ms=>{delays.push(ms);clock+=ms;},fetcher:async()=>{n++;return new Response(JSON.stringify(n<3?{status:'success',...product}:{status:'error',message:'secret-token'}),{status:n<3?200:403});}});
 await api.get('product',{id:'123'});await api.get('product',{id:'123'});assert.equal(delays[0],1200);
 await assert.rejects(api.get('product',{id:'123'}),e=>e.status===403&&!e.message.includes('secret-token'));
});
test('public entries do not expose internal settings or request timestamps',()=>{
 const result=publicEntries({entries:{x:{...refreshEntry({},product,now),inputSignature:'private'}},lastRequestAt:now});assert.equal(result.x.inputSignature,undefined);
});
