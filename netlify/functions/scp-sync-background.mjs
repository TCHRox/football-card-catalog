import {authorized,store,runBatch} from './_scp-core.mjs';

export default async request=>{
  if(request.method!=='POST'||!authorized(request))return new Response('Unauthorized',{status:401});

  const result=await runBatch(store());

  // Keep draining a large initial/re-match queue without forcing the user to
  // click Sync Market over and over or wait for the ten-minute safety schedule.
  // runBatch releases its lease before returning, so the next worker can safely start.
  const due=Number(result?.dueRows||0);
  const retryAfter=Number(result?.retryAfter||0);
  const canContinue=due>0 && !result?.busy && !result?.cooldown && !result?.error && retryAfter<=Date.now();
  if(canContinue && process.env.CARD_CATALOG_ADMIN_PASSWORD){
    try{
      await fetch(new URL('/.netlify/functions/scp-sync-background',request.url),{
        method:'POST',
        headers:{'x-catalog-admin':process.env.CARD_CATALOG_ADMIN_PASSWORD},
        signal:AbortSignal.timeout(15000)
      });
    }catch{
      // The ten-minute scheduled worker remains the fallback if chaining fails.
    }
  }

  return new Response(null,{status:202});
};
export const config={background:true};
