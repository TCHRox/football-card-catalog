import {getStore} from '@netlify/blobs';
import {json} from './_scp-core.mjs';
export default async()=>{try{const store=getStore({name:'football-card-manual-grades-v1',consistency:'strong'});const entries={};for await(const page of store.list({paginate:true})){for(let i=0;i<page.blobs.length;i+=20){const records=await Promise.all(page.blobs.slice(i,i+20).map(b=>store.get(b.key,{type:'json'})));for(const record of records)if(record?.key&&record.selectedGrade)entries[record.key]=record;}}return json({entries});}catch{return json({error:'Manual grade selections could not be loaded.'},503);}};
