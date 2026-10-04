const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const imagePath=value=>value?.startsWith('/')?value:'/assets/'+value;
const price=item=>item.price?item.price.toLocaleString('ru-RU')+' ₽ <small>/ '+esc(item.unit)+'</small>':'Стоимость уточнит сотрудник';
const name=item=>`<h3><a href="/prokat/${encodeURIComponent(item.id)}/">${esc(item.name)}</a></h3>`;
const choose=item=>`<button class="round-button" data-equipment="${esc(item.id)}" aria-label="Выбрать: ${esc(item.name)}">↗</button>`;
function photo(item,extra=false){
 if(!item.image)return '';
 return `<a class="${extra?'extra-photo':'fleet-photo'} photo-open" href="${esc(imagePath(item.imageFull||item.image))}" aria-label="Открыть фото: ${esc(item.name)}"><img src="${esc(imagePath(item.image))}" alt="${esc(item.name)} на станции СТАРТ" ${item.imageSrcSet?`srcset="${esc(item.imageSrcSet)}" sizes="${extra?'88px':'(max-width: 580px) 45vw, (max-width: 850px) 50vw, 25vw'}"`:''} decoding="async" loading="lazy" width="${extra?88:600}" height="${extra?88:450}" style="object-position:${esc(item.position||'50% 50%')}"></a>`;
}
export function renderFleet(inventory){
 return {
  main:inventory.slice(0,4).map(item=>`<article class="fleet-card">${photo(item)}<div class="fleet-content">${name(item)}<p>${esc(item.description)}</p><p class="fleet-count">В парке: ${esc(item.quantity)} шт.${item.id==='sup'?' · Гидрокостюм — бесплатно.':''}</p><div class="fleet-bottom"><span class="fleet-price">${price(item)}</span>${choose(item)}</div></div></article>`).join(''),
  extra:inventory.slice(4).map(item=>`<article class="extra-item">${photo(item,true)}<div>${name(item)}<p class="fleet-description">${esc(item.description)}</p><p class="fleet-price">${price(item)}</p><p class="fleet-count">В парке: ${esc(item.quantity)} шт.</p></div>${choose(item)}</article>`).join('')
 };
}
