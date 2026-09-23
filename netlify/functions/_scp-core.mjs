import {readMatches,applyMatches} from './_manual-matches.mjs';
import { getStore } from '@netlify/blobs';

export const STORE = 'football-card-sportscardspro-v31';
export const KEY = 'state';
export const DAY = 86400000;
export const INTERVAL = 1200; // margin above provider's one request/second limit
export const norm = v => String(v ?? '').trim().toLowerCase().replace(/[’']/g,'').replace(/[()]/g,'').replace(/\s+/g,' ');
export const words = v => norm(v).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
export const cardKey = c => [c.year,c.brand,c.player,c.number,c.type,/^(y|yes|true|1|rc)$/i.test(c.rookie) ? 'rookie':'',c.notes].map(norm).join('|');
export const validPrice = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
export const cents = v => v === null || v === undefined || String(v).trim() === '' || !/^\d+$/.test(String(v)) || Number(v) <= 0 ? null : Number(v)/100;
export const store = () => getStore({name:STORE,consistency:'strong'});
export const blankState = () => ({entries:{},status:{},lastRequestAt:0});
export const json = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
export const authorized = request => Boolean(process.env.CARD_CATALOG_ADMIN_PASSWORD) && request.headers.get('x-catalog-admin') === process.env.CARD_CATALOG_ADMIN_PASSWORD;
export function parseCSV(text) {
  const rows=[]; let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++) { const ch=text[i];
    if(quoted) {if(ch==='"'){if(text[i+1]==='"'){cell+='"';i++;}else quoted=false;}else cell+=ch;}
    else if(ch==='"') quoted=true;
    else if(ch===','){row.push(cell);cell='';}
    else if(ch==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}
    else cell+=ch;
  }
  if(cell || row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}
  return rows;
}
export function sheetCards(csv) {
  if(/<!doctype|<html/i.test(csv.slice(0,500))) throw new Error('Google Sheets returned a sign-in page. Check sharing.');
  const matrix=parseCSV(csv);const headers=(matrix.shift() || []).map(norm);
  const idCol=headers.indexOf('sportscardspro id'),urlCol=headers.indexOf('sportscardspro url');
  let first='',last='';const cards=[];
  for(const [i,r] of matrix.entries()) {
    if(!r.some(c=>String(c).trim()))continue;
    if(r[0]?.trim())first=r[0].trim();if(r[1]?.trim())last=r[1].trim();
    const c={player:[first,last].filter(Boolean).join(' '),year:r[2]?.trim()||'',rookie:r[3]?.trim()||'',brand:r[4]?.trim()||'',type:r[5]?.trim()||'',number:r[6]?.trim()||'',quantity:Math.max(1,parseInt(r[7],10)||1),notes:r[14]?.trim()||'',rowNumber:i+2,productId:idCol>=0 ? r[idCol]?.trim()||'':'',url:urlCol>=0 ? r[urlCol]?.trim()||'':''};
    if(c.player && c.year && c.brand && c.number){c.key=cardKey(c);cards.push(c);}
  }
  if(!cards.length)throw new Error('No usable card rows found in Google Sheets.');
  return cards;
}
export async function loadCards() {
  const url='https://docs.google.com/spreadsheets/d/1ZelpNWlXQHIzmDCVSDv1TMYEuh-eua6SKUtsESqlmeI/export?format=csv&gid=1796597612';
  const response=await fetch(url,{signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`Google Sheets returned HTTP ${response.status}.`);
  return sheetCards(await response.text());
}
export function sourceURL(v) {
  try {const u=new URL(v);return u.protocol==='https:' && ['www.sportscardspro.com','sportscardspro.com'].includes(u.hostname) && u.pathname.startsWith('/game/') ? u.origin+u.pathname : '';}
  catch{return '';}
}
export const signature = c => JSON.stringify([c.productId||'',c.url||'']);
export const MATCHER_VERSION = 40;
function normalizedSet(v) {return words(v).replace(/^football cards?\s*/,'').replace(/\bpanini\b/g,'').replace(/\bdonruss optics\b/g,'donruss optic').replace(/\s+/g,' ').trim();}
const splitWords = v => words(v).split(' ').filter(Boolean);
const overlap = (a,b) => {
  const aa=[...new Set(splitWords(a))], bb=[...new Set(splitWords(b))];
  if(!aa.length || !bb.length) return 0;
  const bset=new Set(bb);
  const shared=aa.filter(x=>bset.has(x)).length;
  return shared/Math.max(aa.length,bb.length);
};
const genericTypes = new Set(['','base','base set','parallel','insert','subset']);
const normalizeNumber = v => words(String(v||'').replace(/^\s*#\s*/,''));
const extractNumber = title => normalizeNumber(String(title||'').match(/#\s*([a-z0-9-]+)/i)?.[1]||'');
const extractPlayer = title => words(String(title||'').replace(/\[[^\]]*\]/g,'').replace(/#.*$/,'').replace(/\b(rc|rookie card)\b/ig,''));
const extractVariant = title => words((String(title||'').match(/\[([^\]]+)\]/)||[])[1]||'');
const descriptorWords = c => words([
  !genericTypes.has(norm(c.type)) ? c.type : '',
  c.notes
].filter(Boolean).join(' '));
const searchFromURL = url => decodeURIComponent(new URL(url).pathname.slice(6)).replace(/[\/_-]/g,' ');
export function searchQuery(c) {return [c.year,c.brand,c.player,'#'+c.number,!genericTypes.has(norm(c.type))?c.type:'',c.notes].filter(Boolean).join(' ');}
export function alternateSearchQuery(c) {return [c.player,'#'+c.number,c.year,c.brand,c.notes].filter(Boolean).join(' ');}
// Accept only an exact catalog identity. Fuzzy search results are suggestions for review.
export function matchesCard(c,p) {
  if(!/^\d+$/.test(String(p.id||'')))return false;
  const set=normalizedSet(p['console-name']);
  const number=extractNumber(p['product-name']);
  if(number!==normalizeNumber(c.number))return false;
  const title=String(p['product-name']||'');
  const player=extractPlayer(title);
  if(player!==words(c.player))return false;
  const expected=normalizedSet([c.year,c.brand].join(' '));
  const type=norm(c.type);
  if(['parallel','insert','subset'].includes(type) && !c.notes)return false;
  const descriptor=descriptorWords(c);
  const titleVariant=extractVariant(title);
  if(!descriptor)return set===expected && !titleVariant;
  return (set===expected && titleVariant===descriptor) || (set===normalizedSet(expected+' '+descriptor) && !titleVariant);
}
export function scoreMatch(c,p) {
  const title=String(p['product-name']||'');
  const set=String(p['console-name']||'');
  const expectedSet=normalizedSet([c.year,c.brand].join(' '));
  const actualSet=normalizedSet(set);
  const expectedDescriptor=descriptorWords(c);
  const actualVariant=extractVariant(title);
  const actualPlayer=extractPlayer(title);
  const expectedPlayer=words(c.player);
  const actualNumber=extractNumber(title);
  const expectedNumber=normalizeNumber(c.number);
  const actualYear=(set.match(/\b(19|20)\d{2}\b/)||[])[0]||'';
  const exact={number:actualNumber===expectedNumber,player:actualPlayer===expectedPlayer,year:actualYear===String(c.year),set:actualSet===expectedSet,variant:actualVariant===expectedDescriptor};
  let score=0;
  score += exact.number ? 45 : (actualNumber && expectedNumber && (actualNumber.includes(expectedNumber) || expectedNumber.includes(actualNumber)) ? 16 : -40);
  const playerOverlap=overlap(actualPlayer,expectedPlayer);
  score += exact.player ? 28 : playerOverlap>=0.86 ? 16 : playerOverlap>=0.65 ? 8 : -24;
  score += exact.year ? 12 : (actualYear ? -18 : 0);
  const setOverlap=overlap(actualSet.replace(/^\b(19|20)\d{2}\b\s*/,''), expectedSet.replace(/^\b(19|20)\d{2}\b\s*/,''));
  score += exact.set ? 20 : setOverlap>=0.86 ? 14 : setOverlap>=0.6 ? 8 : -12;
  if(expectedDescriptor) {
    const variantOverlap=Math.max(overlap(actualVariant,expectedDescriptor), overlap(words(actualSet+' '+actualVariant), expectedDescriptor));
    score += exact.variant ? 18 : variantOverlap>=0.86 ? 12 : variantOverlap>=0.6 ? 6 : (actualVariant ? -14 : -8);
  } else if(actualVariant) {
    score -= 8;
  } else {
    score += 8;
  }
  return {product:p,score,exact};
}
export function chooseMatch(c,products) {
  if(['parallel','insert','subset'].includes(norm(c.type)) && !c.notes) return null;
  const unique=[...new Map((products||[]).map(p=>[String(p.id),p])).values()];
  const scored=unique.map(p=>scoreMatch(c,p)).sort((a,b)=>b.score-a.score || String(a.product.id).localeCompare(String(b.product.id)));
  const best=scored[0], second=scored[1];
  if(!best) return null;
  const lead=best.score-(second?.score ?? -999);
  const accept=best.exact.number && best.exact.player && best.exact.year && best.score>=78 && (lead>=8 || best.score>=92 || (best.exact.set && (best.exact.variant || !descriptorWords(c)) && lead>=4));
  return accept ? best.product : null;
}
export function candidateSummary(c,products) {
  return [...new Map((products||[]).map(p=>[String(p.id),p])).values()]
    .map(p=>scoreMatch(c,p))
    .sort((a,b)=>b.score-a.score || String(a.product.id).localeCompare(String(b.product.id)))
    .slice(0,5)
    .map(({product,score})=>({id:String(product.id),title:product['product-name'],set:product['console-name'],score}));
}
export function matchConfidence(c,product,products=[],explicit=false) {
  if(explicit)return {confidence:'high',matchScore:null,matchLead:null};
  const current=scoreMatch(c,product);
  const others=[...new Map((products||[]).map(p=>[String(p.id),p])).values()]
    .filter(p=>String(p.id)!==String(product.id))
    .map(p=>scoreMatch(c,p).score)
    .sort((a,b)=>b-a);
  const lead=others.length?current.score-others[0]:null;
  let confidence='high';
  if(current.score<90 || (lead!==null&&lead<8))confidence='low';
  else if(current.score<108 || (lead!==null&&lead<15) || !current.exact.set || (descriptorWords(c)&&!current.exact.variant))confidence='medium';
  return {confidence,matchScore:current.score,matchLead:lead};
}
export function refreshEntry(entry,product,now=Date.now()) {
  const amount=cents(product['loose-price']);
  const same=entry?.id===String(product.id);
  const history=same ? [...(entry.history||[])] : [];
  const date=new Date(now).toISOString().slice(0,10);
  // Snapshots describe our checks, not the date of a market sale.
  if(validPrice(amount)) {
    const point={date,numericPrice:amount};
    const idx=history.findIndex(p=>p.date===date);if(idx>=0)history[idx]=point;else history.push(point);
  }
  return {...entry,id:String(product.id),title:product['product-name']||'',set:product['console-name']||'',ungraded:amount,checkedAt:now,updatedAt:now,history:history.filter(p=>Date.parse(p.date)>now-400*DAY).slice(-400),source:'SportsCardsPro',lookupNotFound:false,state:validPrice(amount)?'priced':'no-price',reason:validPrice(amount)?'':'SportsCardsPro has no current ungraded price.',url:sourceURL(entry.url),changes:{ungraded:null},retryAt:now+7*DAY};
}
export function publicEntries(state) {
  return Object.fromEntries(Object.entries(state.entries||{}).map(([k,e])=>[k,{ungraded:e.ungraded??null,source:'SportsCardsPro',updatedAt:e.updatedAt||null,checkedAt:e.checkedAt||null,id:e.id||'',title:e.title||'',set:e.set||'',url:sourceURL(e.url),state:e.state,reason:e.reason||'',history:e.history||[],changes:{ungraded:null},candidates:e.candidates||[],confidence:e.confidence||'',matchScore:e.matchScore??null,matchLead:e.matchLead??null}]));
}
export function totals(cards,state,now=Date.now()) {
  const entries=state.entries||{};
  return {totalRows:cards.length,matchedRows:cards.filter(c=>entries[c.key]?.id).length,valuedRows:cards.filter(c=>validPrice(entries[c.key]?.ungraded)).length,unresolvedRows:cards.filter(c=>entries[c.key]?.state==='review').length,pendingRows:cards.filter(c=>!entries[c.key]).length,dueRows:cards.filter(c=>due(c,entries[c.key],now)).length};
}
export function due(c,e,now=Date.now()) {return !e || signature(c)!==e.inputSignature || now>=Number(e.retryAt||0) || (e.state==='review' && Number(e.matcherVersion||0)<MATCHER_VERSION);}
export async function acquireLease(s,now=Date.now()) {
  const current=await s.getWithMetadata('lease',{type:'json'});
  if(current?.data?.until>now)return null;
  const result=await s.setJSON('lease',{until:now+10*60000},current?{onlyIfMatch:current.etag}:{onlyIfNew:true});
  return result.modified ? result.etag : null;
}
export async function releaseLease(s,etag){if(etag)await s.setJSON('lease',{until:0},{onlyIfMatch:etag});}
export const legacyLookup404 = status => status?.error === 'SportsCardsPro could not complete the request (HTTP 404).';
export const legacyTransientCooldown = status => /^SportsCardsPro request timed out or could not connect\./.test(String(status?.error||'')) || /^SportsCardsPro returned an unreadable response \(HTTP 5\d\d\)\./.test(String(status?.error||''));
export const bypassLegacyCooldown = status => legacyLookup404(status) || legacyTransientCooldown(status);
export class ProviderError extends Error {
  constructor(message,status=502,{transient=false,rateLimited=false}={}) {
    super(message);
    this.status=status;
    this.transient=transient;
    this.rateLimited=rateLimited;
  }
}
export function client(token,state,{fetcher=fetch,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  let calls=0;
  const waitForSlot=async()=>{
    const delay=Math.max(0,INTERVAL-(now()-Number(state.lastRequestAt||0)));
    if(delay)await sleep(delay);
    state.lastRequestAt=now();
  };
  return { get calls(){return calls;}, async get(path,params) {
    const url=new URL('https://www.sportscardspro.com/api/'+path);
    url.searchParams.set('t',token);for(const [k,v]of Object.entries(params))url.searchParams.set(k,v);
    let lastError;
    for(let attempt=0;attempt<2;attempt++) {
      await waitForSlot();calls++;
      let response;
      try {response=await fetcher(url,{signal:AbortSignal.timeout(20000),headers:{accept:'application/json'}});}
      catch {
        lastError=new ProviderError('SportsCardsPro request timed out or could not connect. Saved prices are retained.',502,{transient:true});
        if(attempt===0){await sleep(1800);continue;}
        throw lastError;
      }
      let data;
      try {data=await response.json();}
      catch {
        const status=response.status===200?502:response.status;
        lastError=new ProviderError(`SportsCardsPro returned an unreadable response (HTTP ${response.status}).`,status,{transient:status>=500||status===404});
        if(attempt===0&&lastError.transient){await sleep(1800);continue;}
        throw lastError;
      }
      if(!response.ok || data.status!=='success') {
        const status=response.status===200?502:response.status;
        // Never echo provider bodies, request URLs, or token-bearing exceptions.
        const error = new ProviderError(
          [401,403].includes(status)?'SportsCardsPro rejected access. Check the production token and Collector API entitlement.':
          status===429?'SportsCardsPro rate limit reached. The next batch will retry later.':
          `SportsCardsPro could not complete the request (HTTP ${response.status}).`,
          status,
          {transient:status>=500,rateLimited:status===429}
        );
        error.lookupNotFound = status===404;
        if(attempt===0&&error.transient){lastError=error;await sleep(1800);continue;}
        throw error;
      }
      return data;
    }
    throw lastError||new ProviderError('SportsCardsPro request could not be completed.',502,{transient:true});
  }};
}
export async function processCard(c,state,api,now=Date.now()) {
  const old=state.entries[c.key]||{};
  // Manual mapping edits must not carry an old card's value into a different match.
  const changed=old.inputSignature!==signature(c);
  let e=changed?{}:old;
  const url=sourceURL(c.url);
  const base={...e,inputSignature:signature(c),url};
  const review=(reason,candidates=[])=>({...base,lookupNotFound:false,id:'',ungraded:null,updatedAt:null,history:[],state:'review',reason,retryAt:now+30*DAY,matcherVersion:MATCHER_VERSION,candidates:candidateSummary(c,candidates)});
  if(c.productId && !/^\d+$/.test(c.productId))return review('SportsCardsPro ID must contain digits only.');
  if(c.url && !url)return review('Use an HTTPS SportsCardsPro /game/ card URL.');
  let product;
  let matchProducts=[];
  const id=c.productId||e.id;
  try {
  if(id) {
    product=await api.get('product',{id});
    if(String(product.id)!==String(id))throw new ProviderError('SportsCardsPro returned a different product ID. The value was not applied.');
    // Explicit IDs intentionally resolve naming differences and ambiguous variants.
  } else {
    const storedCandidates=(Array.isArray(e.candidates)?e.candidates:[]).map(p=>({id:p.id,'product-name':p.title,'console-name':p.set}));
    let products=storedCandidates;
    matchProducts=products;
    product=chooseMatch(c,products);
    const primaryQuery=url ? searchFromURL(url) : searchQuery(c);
    // v37 already saved the original search candidates. Repeating that same search for
    // every review card wastes API calls, so only perform it when no candidates exist.
    if(!product && !storedCandidates.length) {
      const primary=await api.get('products',{q:primaryQuery});
      if(!Array.isArray(primary.products))throw new ProviderError('SportsCardsPro search returned an unexpected format.');
      products=primary.products;
      matchProducts=products;
      product=chooseMatch(c,products);
    }
    if(!product) {
      const secondaryQuery=alternateSearchQuery(c);
      if(secondaryQuery && secondaryQuery !== primaryQuery) {
        const secondary=await api.get('products',{q:secondaryQuery});
        if(Array.isArray(secondary.products)) products=[...new Map([...products,...secondary.products].map(p=>[String(p.id),p])).values()];
        matchProducts=products;
        product=chooseMatch(c,products);
      }
    }
    if(!product)return review('SportsCardsPro found possible matches, but none was confident enough to link automatically. Review the candidates in the popup.',products);
    product=await api.get('product',{id:String(product.id)});
    const confirmed=chooseMatch(c,[product]);
    if(!confirmed)return review('SportsCardsPro search narrowed this card down, but the final product details were still ambiguous.',[product,...products]);
  }
  const confidence=matchConfidence(c,product,matchProducts,Boolean(c.productId||url));
  return {...refreshEntry(base,product,now),matcherVersion:MATCHER_VERSION,candidates:[],...confidence};
  } catch(error) {
    if(!error.lookupNotFound)throw error;
    return {...base,state:'review',reason:'SportsCardsPro could not find this card lookup (404). Confirm or correct its product ID in the popup.'+(validPrice(base.ungraded)?' The previous saved price is retained.':''),retryAt:now+30*DAY,lookupNotFound:true,matcherVersion:MATCHER_VERSION};
  }
}
// Injected dependencies make batch recovery and API limits testable without credentials.
export async function runBatch(s,{cardsLoader=loadCards,token=process.env.SPORTSCARDSPRO_API_TOKEN,now=Date.now,clientFactory=client,maxCalls=300,maxMs=420000}={}) {
  const lease=await acquireLease(s,now());if(!lease)return {busy:true};
  let state;
  try {
    state=await s.get(KEY,{type:'json'})||blankState();
    if(!token)throw new ProviderError('SPORTSCARDSPRO_API_TOKEN is missing in the production Functions environment.',503);
    if(state.status?.retryAfter>now()&&!bypassLegacyCooldown(state.status))return {cooldown:true};
    const cards=applyMatches(await cardsLoader(),await readMatches(s));
    const keys=new Set(cards.map(c=>c.key));
    for(const k of Object.keys(state.entries))if(!keys.has(k))delete state.entries[k];
    const unique=[...new Map(cards.map(c=>[c.key,c])).values()];
    // Don't choose between conflicting explicit IDs on identical inventory rows.
    const conflicts=new Set();const sigs=new Map();
    for(const c of cards){if(sigs.has(c.key)&&sigs.get(c.key)!==signature(c))conflicts.add(c.key);sigs.set(c.key,signature(c));}
    const queue=unique.filter(c=>due(c,state.entries[c.key],now())).sort((a,b)=>Number(Boolean(b.productId)&&signature(b)!==state.entries[b.key]?.inputSignature)-Number(Boolean(a.productId)&&signature(a)!==state.entries[a.key]?.inputSignature)||Number(state.entries[a.key]?.retryAt||0)-Number(state.entries[b.key]?.retryAt||0));
    if(!queue.length){state.status={...state.status,running:false,phase:'complete',error:'',...totals(cards,state,now())};await s.setJSON(KEY,state);return {idle:true};}
    const startedAt=now();const api=clientFactory(token,state);let processed=0,notFoundStreak=0,transientStreak=0,transientDeferred=0;
    state.status={...state.status,running:true,phase:'pricing',phaseLabel:'Updating SportsCardsPro prices',startedAt,error:'',transientDeferred:0,...totals(cards,state,now())};
    await s.setJSON(KEY,state);
    for(const c of queue) {
      if(api.calls>=maxCalls-1 || now()-startedAt>=maxMs)break;
      try {
        if(conflicts.has(c.key))state.entries[c.key]={inputSignature:signature(c),state:'review',reason:'Duplicate Sheet rows have conflicting SportsCardsPro mappings. Make their IDs/URLs agree.',retryAt:now()+30*DAY};
        else {
          if(state.entries[c.key] && state.entries[c.key].inputSignature!==signature(c))state.entries[c.key]={state:'pending',inputSignature:signature(c),retryAt:0};
          state.entries[c.key]=await processCard(c,state,api,now());
        }
        transientStreak=0;
      } catch(error) {
        if(error instanceof ProviderError && error.transient && !error.rateLimited && ![401,403].includes(error.status)) {
          transientStreak++;transientDeferred++;
          const old=state.entries[c.key]||{};
          state.entries[c.key]={...old,inputSignature:signature(c),state:old.state||(validPrice(old.ungraded)?'priced':'pending'),reason:old.reason||'Temporary SportsCardsPro connection issue. This card will retry automatically.',retryAt:now()+15*60000};
          if(transientStreak>=3) {
            processed++;
            const current=totals(cards,state,now());
            state.status={...state.status,...current,running:false,phase:'partial',error:'SportsCardsPro had several temporary connection failures. Saved prices are retained and syncing will retry automatically.',retryAfter:now()+15*60000,transientDeferred,priceIdsTotal:queue.length,priceIdsProcessed:processed,apiCallsThisRun:api.calls,lastCompletedAt:now()};
            await s.setJSON(KEY,state);
            return state.status;
          }
        } else throw error;
      }
      notFoundStreak=state.entries[c.key]?.lookupNotFound?notFoundStreak+1:0;
      if(notFoundStreak>=5)throw new ProviderError('Five consecutive card lookups were not found. Sync paused to check provider availability; saved prices are retained.',502);
      processed++;
      state.status={...state.status,...totals(cards,state,now()),transientDeferred,priceIdsTotal:queue.length,priceIdsProcessed:processed,apiCallsThisRun:api.calls};
      if(processed%5===0)await s.setJSON(KEY,state);
    }
    const remaining=totals(cards,state,now());
    state.status={...state.status,...remaining,running:false,phase:remaining.dueRows||transientDeferred?'partial':'complete',lastCompletedAt:now(),apiCallsThisRun:api.calls,transientDeferred,error:'',retryAfter:0};
    await s.setJSON(KEY,state);return state.status;
  } catch(error) {
    state=state||blankState();
    state.status={...state.status,running:false,phase:'error',error:error instanceof ProviderError?error.message:'Sync could not finish. Check Google Sheet access and Netlify storage configuration.',retryAfter:now()+([401,403,503].includes(error.status)?6*3600000:15*60000)};
    await s.setJSON(KEY,state);return state.status;
  } finally {await releaseLease(s,lease);}
}
