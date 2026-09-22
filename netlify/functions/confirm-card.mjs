import {store,authorized,json} from './_scp-core.mjs';
import {saveMatch} from './_manual-matches.mjs';
export default async request=>{
 if(request.method!=='POST')return json({error:'Use POST.'},405);
 if(!authorized(request))return json({error:'Incorrect catalog admin password.'},401);
 let body;try{body=await request.json();}catch{return json({error:'Invalid request.'},400);}
 if(typeof body.key!=='string'||!body.key||body.key.length>2000||typeof body.id!=='string'||!/^\d{1,15}$/.test(body.id)||Number(body.id)<=0)return json({error:'Enter a valid numeric SportsCardsPro product ID.'},400);
 try{const match=await saveMatch(store(),body.key,body.id);return json({ok:true,match});}catch{return json({error:'The ID could not be saved. Please retry.'},503);}
};
