export const WATER_SOURCE='https://yandex.ru/pogoda/ru/pirogovo-moscow-region';
export const WATER_MAX_AGE=6*60*60*1000;
export function parseWater(html){
 if(!/Пирогово/.test(html)||!/Москва и Московская область/.test(html))throw Error('wrong_location');
 const meta=[...html.matchAll(/<meta\b[^>]*>/gi)].map(x=>x[0]).find(x=>/name=["']description["']/i.test(x));
 const description=(meta?.match(/content=["']([^"']*)["']/i)?.[1]||'')+' '+([...html.matchAll(/<p\b[^>]*>([^<]*Пирогово, погода сейчас:[^<]*)<\/p>/gi)].map(x=>x[1]).join(' '));
 const match=description.replace(/&nbsp;|&#160;/g,' ').match(/Температура воды дн[её]м\s*([+−-]?\d{1,2}(?:[.,]\d+)?)\s*(?:°|&deg;)/i);
 if(!match)throw Error('water_missing');
 const temperature=Number(match[1].replace('−','-').replace(',','.'));
 if(!Number.isFinite(temperature)||temperature<0||temperature>40)throw Error('invalid_water');
 return temperature;
}
export class WaterWeather{
 constructor({fetcher=fetch,now=Date.now}={}){this.fetcher=fetcher;this.now=now;this.value=null;this.inflight=null;this.nextAttempt=0;}
 snapshot(){const valid=this.value&&this.now()-this.value.updatedAt<WATER_MAX_AGE;return {available:Boolean(valid),temperature:valid?this.value.temperature:null,updatedAt:valid?new Date(this.value.updatedAt).toISOString():null,source:WATER_SOURCE,maxAgeMs:WATER_MAX_AGE};}
 refresh(){if(this.inflight)return this.inflight;if(this.now()<this.nextAttempt)return Promise.resolve();this.nextAttempt=this.now()+3600000;this.inflight=(async()=>{try{const res=await this.fetcher(WATER_SOURCE,{signal:AbortSignal.timeout(10000),redirect:'error',headers:{'Accept-Language':'ru-RU,ru;q=0.9'}});if(!res.ok)throw Error('source_status');const html=await res.text();if(html.length>5000000)throw Error('source_size');this.value={temperature:parseWater(html),updatedAt:this.now()};}catch{console.warn('Water weather refresh unavailable');}finally{this.inflight=null;}})();return this.inflight;}
}
