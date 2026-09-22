import test from 'node:test';
import assert from 'node:assert/strict';
import handler,{validatePrices} from '../netlify/functions/manual-grades.mjs';
const prices={'7':null,'8':0,'9':12.34,'9.5':50,'PSA 10':150};
test('manual estimates preserve blank vs zero and reject invalid prices',()=>{assert.deepEqual(validatePrices(prices),prices);for(const bad of [-1,NaN,Infinity,'12',1.234])assert.throws(()=>validatePrices({...prices,'9':bad}));assert.throws(()=>validatePrices({...prices,'10':5}));assert.throws(()=>validatePrices({}));});
test('manual writes require admin authorization before storage',async()=>{const r=await handler(new Request('https://site.test/manual-grades',{method:'POST',body:JSON.stringify({key:'card',prices})}));assert.equal(r.status,401);});
