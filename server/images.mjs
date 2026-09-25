import {readFileSync} from 'node:fs';
const variants=JSON.parse(readFileSync(new URL('./image-variants.json',import.meta.url),'utf8'));
export function imageOptions(src){const key=src?.startsWith('/')?src:'/'+src;const list=variants[key]||variants['/assets/'+src];if(!list)return null;return {src:list[Math.min(1,list.length-1)].src,srcset:list.map(i=>i.src+' '+i.width+'w').join(', ')};}
export function optimizeImages(html){return html.replace(/<img\b[^>]*>/g,tag=>{
 const src=tag.match(/\bsrc="([^"]+)"/)?.[1],v=imageOptions(src);if(!v)return tag;
 const sizes=tag.includes('fetchpriority="high"')?'(max-width: 580px) calc(100vw - 64px), 75vw':'(max-width: 700px) 100vw, 50vw';
 return tag.replace(/\bsrc="[^"]+"/,'src="'+v.src+'"').replace(/>$/,' srcset="'+v.srcset+'" sizes="'+sizes+'" decoding="async">');
});}
