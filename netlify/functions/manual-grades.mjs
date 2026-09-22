import {getStore} from '@netlify/blobs';
import {createHash} from 'node:crypto';
import {authorized,json} from './_scp-core.mjs';
const grades=['7','8','9','9.5','PSA 10'];
export function validatePrices(prices){
 if(!prices||typeof prices!=='object'||Array.isArray(prices)||Object.keys(prices).some(g=>!grades.includes(g)))throw Error('Invalid grade fields.');
 for(const g of grades){const value=prices[g];if(value!==null&&(typeof value!=='number'||!Number.isFinite(value)||value<0||value>100000000||Math.abs(value*100-Math.round(value*100))>0.00001))throw Error('Enter a valid USD amount with at most two decimals for each grade.');}
 return prices;
}
export default async request=>{
 if(!['GET','POST'].includes(request.method))return json({error:'Method not allowed.'},405);
 if(request.method==='POST'&&!authorized(request))return json({error:'Incorrect catalog admin password.'},401);
 let body={};try{if(request.method==='POST')body=await request.json();}catch{return json({error:'Invalid request.'},400);}
 const key=request.method==='GET'?new URL(request.url).searchParams.get('key'):body.key;
 if(typeof key!=='string'||!key||key.length>2000)return json({error:'Invalid card identity.'},400);
 if(request.method==='POST'){try{validatePrices(body.prices);}catch(e){return json({error:e.message},400);}}
 try{const store=getStore({name:'football-card-manual-grades-v1',consistency:'strong'});const id=createHash('sha256').update(key).digest('hex');
 if(request.method==='GET')return json(await store.get(id,{type:'json'})||{prices:{}});
 const data={prices:body.prices,updatedAt:new Date().toISOString()};await store.setJSON(id,data);return json(data);
 }catch{return json({error:'Saved-price storage is unavailable. Please retry.'},503);}
};
