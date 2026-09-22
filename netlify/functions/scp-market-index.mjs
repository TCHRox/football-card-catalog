import {store,KEY,blankState,publicEntries,json} from './_scp-core.mjs';
export default async()=>{
  try{
    const s=store();const state=await s.get(KEY,{type:'json'})||blankState();
    let status={...state.status,configured:Boolean(process.env.SPORTSCARDSPRO_API_TOKEN)};
    if(status.running && Date.now()-Number(status.startedAt||0)>10*60000)status={...status,running:false,phase:'partial',error:'The previous batch stopped. The next scheduled check will resume.'};
    return json({summaries:publicEntries(state),status});
  }catch{return json({error:'Pricing storage is unavailable. Check Netlify Blobs configuration.'},503);}
};
