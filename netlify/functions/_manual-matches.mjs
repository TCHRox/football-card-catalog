export const MATCHES_KEY='manual-matches-v1';
export async function readMatches(store){return await store.get(MATCHES_KEY,{type:'json'})||{};}
export function applyMatches(cards,matches){return cards.map(c=>matches[c.key]?.id?{...c,productId:matches[c.key].id,url:''}:c);}
export async function saveMatch(store,key,id){
 for(let attempt=0;attempt<5;attempt++){
 const existing=await store.getWithMetadata(MATCHES_KEY,{type:'json'});
 const data={...(existing?.data||{}),[key]:{id,updatedAt:Date.now()}};
 const result=await store.setJSON(MATCHES_KEY,data,existing?{onlyIfMatch:existing.etag}:{onlyIfNew:true});
 if(result.modified)return data[key];
 }
 throw Error('Another confirmation was saved at the same time. Please retry.');
}
export function overlayMatches(summaries,matches){
 for(const [key,match] of Object.entries(matches)){
 const previous=summaries[key]||{};
 summaries[key]={...previous,manualId:match.id};
 if(previous.id!==match.id)summaries[key]={...summaries[key],id:'',ungraded:null,history:[],checkedAt:null,state:'pending',reason:'ID saved. Waiting for the next pricing batch to verify it.'};
 }
 return summaries;
}
