import {legacyLookup404,authorized,store,KEY,blankState,json} from './_scp-core.mjs';
export default async request=>{
  if(request.method!=='POST')return json({error:'Use POST.'},405);
  if(!process.env.CARD_CATALOG_ADMIN_PASSWORD)return json({error:'CARD_CATALOG_ADMIN_PASSWORD is not configured.'},503);
  if(!authorized(request))return json({error:'Incorrect catalog admin password.'},401);
  if(!process.env.SPORTSCARDSPRO_API_TOKEN)return json({error:'SPORTSCARDSPRO_API_TOKEN is missing in production Functions.'},503);
  try {
    const s=store();const state=await s.get(KEY,{type:'json'})||blankState();
    if(state.status.retryAfter>Date.now()&&!legacyLookup404(state.status))return json({error:state.status.error+' Retry after '+new Date(state.status.retryAfter).toISOString()+'.'},429);
    const lease=await s.getWithMetadata('lease',{type:'json'});
    if(lease?.data?.until>Date.now())return json({ok:true,status:{...state.status,configured:true,running:true}},202);
    const response=await fetch(new URL('/.netlify/functions/scp-sync-background',request.url),{method:'POST',headers:{'x-catalog-admin':process.env.CARD_CATALOG_ADMIN_PASSWORD},signal:AbortSignal.timeout(15000)});
    if(!response.ok)return json({error:'Netlify could not launch the background function. Redeploy using a build that includes Functions.'},502);
    // The worker owns durable state; the launcher never overwrites its progress.
    return json({ok:true,status:{...state.status,configured:true,running:true,phase:'queued',queuedAt:Date.now()}},202);
  }catch{return json({error:'Could not start sync. Check Netlify Functions and Blobs configuration.'},502);}
};
