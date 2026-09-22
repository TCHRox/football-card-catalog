import test from 'node:test';import assert from 'node:assert/strict';
import {overlayMatches,saveMatch} from '../netlify/functions/_manual-matches.mjs';
import handler from '../netlify/functions/confirm-card.mjs';
test('changed confirmation hides stale prices until verified',()=>{const result=overlayMatches({card:{id:'1',ungraded:10,history:[{}]}},{card:{id:'2'}});assert.equal(result.card.manualId,'2');assert.equal(result.card.ungraded,null);assert.deepEqual(result.card.history,[]);assert.equal(result.card.state,'pending');});
test('concurrent confirmation retries preserve other saved cards',async()=>{let attempts=0;const s={async getWithMetadata(){return {data:attempts?{other:{id:'3'}}:{},etag:String(attempts)}},async setJSON(key,data){attempts++;if(attempts===1)return {modified:false};assert.equal(data.other.id,'3');assert.equal(data.card.id,'2');return {modified:true}}};assert.equal((await saveMatch(s,'card','2')).id,'2');assert.equal(attempts,2);});
test('confirmation writes reject unauthenticated requests',async()=>{const response=await handler(new Request('https://test',{method:'POST',body:'{}'}));assert.equal(response.status,401);});
