import {legacyLookup404,store,KEY} from './_scp-core.mjs';
export default async request=>{
  if(!process.env.SPORTSCARDSPRO_API_TOKEN||!process.env.CARD_CATALOG_ADMIN_PASSWORD)return;
  const state=await store().get(KEY,{type:'json'});
  if(state?.status?.retryAfter>Date.now()&&!legacyLookup404(state.status))return;
  const response=await fetch(new URL('/.netlify/functions/scp-sync-background',process.env.URL||request.url),{method:'POST',headers:{'x-catalog-admin':process.env.CARD_CATALOG_ADMIN_PASSWORD},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('SportsCardsPro worker could not be started.');
};
// Every ten minutes, process new/due cards only. Each price has a seven-day cache.
export const config={schedule:'*/10 * * * *'};
