import {authorized,store,runBatch} from './_scp-core.mjs';
export default async request=>{
  if(request.method!=='POST'||!authorized(request))return new Response('Unauthorized',{status:401});
  await runBatch(store());
};
export const config={background:true};
