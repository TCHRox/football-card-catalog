import { getStore } from "@netlify/blobs";

const SCRAPER_ID = "5e67e7a5-866b-4073-8d41-881feb8b574b";
const BASE_URL = `https://api.parse.bot/scraper/${SCRAPER_ID}`;
const CACHE_STORE = "football-card-market-sales-cache";
const SALES_CACHE_MS = 12 * 60 * 60 * 1000;

function json(body,status=200,cacheSeconds=0){
  const headers={"content-type":"application/json; charset=utf-8"};
  if(cacheSeconds>0){
    headers["Cache-Control"]=`public, max-age=${cacheSeconds}`;
    headers["Netlify-CDN-Cache-Control"]=`public, durable, max-age=${cacheSeconds}`;
  }else headers["Cache-Control"]="no-store";
  return new Response(JSON.stringify(body),{status,headers});
}

function numberValue(value){
  if(value===null||value===undefined||value==="") return null;
  const n=Number(String(value).replace(/[$,\s]/g,""));
  return Number.isFinite(n)?n:null;
}

function saleUrl(sale){
  return String(
    sale?.url ||
    sale?.listing_url ||
    sale?.listingUrl ||
    sale?.sale_url ||
    sale?.saleUrl ||
    sale?.ebay_url ||
    sale?.item_url ||
    sale?.href ||
    sale?.link ||
    ""
  );
}

function normalizeSale(sale){
  if(!sale||typeof sale!=="object") return null;
  const date=sale.date||sale.sale_date||sale.sold_date||"";
  const price=numberValue(sale.price??sale.sale_price);
  if(!date||price===null) return null;
  return {
    date:String(date),
    title:String(sale.title||sale.listing_title||"Completed sale"),
    numericPrice:price,
    price,
    marketplace:String(sale.marketplace||sale.source||""),
    url:saleUrl(sale)
  };
}

function findSales(root,depth=0,out=[]){
  if(!root||typeof root!=="object"||depth>6) return out;

  if(Array.isArray(root)){
    const normalized=root.map(normalizeSale).filter(Boolean);
    if(normalized.length){
      out.push(...normalized);
      return out;
    }
    for(const item of root) findSales(item,depth+1,out);
    return out;
  }

  for(const value of Object.values(root)){
    if(value&&typeof value==="object") findSales(value,depth+1,out);
  }
  return out;
}

async function parseGet(apiKey,endpoint,params={}){
  const url=new URL(`${BASE_URL}/${endpoint}`);
  for(const [key,value] of Object.entries(params)){
    if(value!==null&&value!==undefined&&String(value)!=="") url.searchParams.set(key,String(value));
  }

  const response=await fetch(url,{
    headers:{"X-API-Key":apiKey,"Accept":"application/json"}
  });

  const text=await response.text();
  let payload={};
  try{payload=JSON.parse(text)}catch{payload={raw:text.slice(0,500)}}

  if(!response.ok){
    const message=payload?.error||payload?.message||payload?.detail||`Parse returned HTTP ${response.status}.`;
    const error=new Error(typeof message==="string"?message:JSON.stringify(message));
    error.status=response.status;
    throw error;
  }

  return payload?.data!==undefined?payload.data:payload;
}

export default async(request)=>{
  try{
    const apiKey=process.env.PARSE_API_KEY||"";
    if(!apiKey) return json({message:"PARSE_API_KEY is not configured."},503);

    const url=new URL(request.url);
    const cardId=url.searchParams.get("cardId")||"";
    if(!cardId) return json({message:"Missing cardId."},400);

    const s=getStore({name:CACHE_STORE,consistency:"strong"});
    const cacheKey=Buffer.from(cardId,"utf8").toString("base64url");
    const stored=await s.get(cacheKey,{type:"json"});

    if(stored&&Number(stored.fetchedAt||0)>Date.now()-SALES_CACHE_MS){
      return json({sales:stored.sales||[]},200,3600);
    }

    const history=await parseGet(apiKey,"get_price_history",{
      card_id:cardId,
      grade:"ungraded"
    });

    const seen=new Set();
    const sales=findSales(history)
      .filter(sale=>{
        const key=`${sale.date}|${sale.title}|${sale.numericPrice}`;
        if(seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a,b)=>Date.parse(b.date)-Date.parse(a.date))
      .slice(0,30);

    await s.setJSON(cacheKey,{sales,fetchedAt:Date.now()});
    return json({sales},200,3600);

  }catch(error){
    if(error.status===429){
      return json({
        message:"Recent sales are temporarily rate-limited by Parse. The chart and price guide are still available."
      },429);
    }
    return json({message:error.message},500);
  }
};
