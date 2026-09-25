const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function servicePhotos(item,img){
 const full=src=>src.replace(/-w960\.webp$/,'-w1600.webp');
 const link=(src,alt)=>`<a class="photo-open" href="${esc(full(src))}" aria-label="Открыть фото: ${esc(alt)}"><img src="${esc(src)}" alt="${esc(alt)}" width="900" height="1200" decoding="async"></a>`;
 const gallery=['bike','electric','glow'].includes(item.id)&&img.includes('fleet-20260921-'+item.id+'-')?`<div class="fleet-gallery">${(item.id==='glow'?[2]:[2,3]).map(n=>link('/assets/fleet-20260921-'+item.id+'-'+n+'-w960.webp',item.label+' — вид '+n)).join('')}</div>`:'';
 return `<div class="service-photos">${link(img,item.label)}${gallery}<p class="photo-hint">Нажмите на фото, чтобы рассмотреть целиком</p></div>`;
}
