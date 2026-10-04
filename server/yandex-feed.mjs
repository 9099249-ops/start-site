const base='https://spotsup.ru';
const esc=value=>String(value??'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const picture=value=>{const p=value?.startsWith('/')?value:'/assets/'+value;return /^\/(assets|media)\/[a-zA-Z0-9_.-]+\.(webp|png|jpe?g)$/.test(p)?base+p:null;};
export function renderYandexFeed(content){
 const categories=[{id:1,name:'Прокат на воде'},{id:2,name:'Тарифы САП'}],offers=[];
 const add=(id,name,price,categoryId,description,url,image,available=true)=>{if(!Number.isFinite(price)||price<=0)return;offers.push({id,name:name.slice(0,250),price,categoryId,description:String(description||'').slice(0,3000),url,image:picture(image),available});};
 for(const item of content.inventory||[])add('rent-'+item.id,'Аренда: '+item.name,item.price,1,[item.description,'Стоимость за 1 '+(item.unit||'час')+'.'].filter(Boolean).join(' '),base+'/prokat/'+encodeURIComponent(item.id)+'/',item.image, item.quantity!==0);
 const sup=content.inventory?.find(i=>i.id==='sup');
 for(const [key,name,unit] of [['day','САП — безлимит на день','день'],['season','САП — безлимит на сезон','сезон'],['takeaway','САП с собой','день']])add('sup-'+key,name,content.plans?.[key],2,'Стоимость за 1 '+unit+'.',base+'/#plans',sup?.image);
 const used=new Set(offers.map(o=>o.categoryId));
 return '<?xml version="1.0" encoding="UTF-8"?>\n<yml_catalog>\n<shop>\n<name>СТАРТ</name><company>СТАРТ</company><url>'+base+'/</url>\n<currencies><currency id="RUB" rate="1"/></currencies>\n<categories>\n'+categories.filter(c=>used.has(c.id)).map(c=>'<category id="'+c.id+'">'+esc(c.name)+'</category>').join('\n')+'\n</categories>\n<offers>\n'+offers.map(o=>'<offer id="'+esc(o.id)+'"'+(o.available?'':' available="unknown"')+'>'+['name','price','categoryId','description','url'].map(k=>'<'+k+'>'+esc(o[k])+'</'+k+'>').join('')+'<vendor>СТАРТ</vendor><currencyId>RUB</currencyId>'+(o.image?'<picture>'+esc(o.image)+'</picture>':'')+'</offer>').join('\n')+'\n</offers>\n</shop>\n</yml_catalog>\n';
}
