import {readFileSync} from 'node:fs';
const defaults=JSON.parse(readFileSync(new URL('./content-defaults.json',import.meta.url),'utf8'));
export function rentalRates(store){const live=store.sms?.content?.live();if(live)return live.inventory;const exists=store.db.prepare("SELECT name FROM sqlite_master WHERE name='site_content'").get();return exists?JSON.parse(store.db.prepare('SELECT published FROM site_content WHERE id=1').get().published).inventory:defaults.inventory;}
export function rentalPrice(store,equipment,quantity,minutes,people){
 const rate=rentalRates(store).find(i=>i.id===equipment)?.price;
 const units=equipment==='big'?people:quantity;
 if(!Number.isSafeInteger(rate)||rate<0||!Number.isSafeInteger(units)||units<1||!Number.isSafeInteger(minutes)||minutes<1)throw Object.assign(Error('Для расчёта укажите тариф и количество человек / техники.'),{status:400});
 return Math.round(rate*100*units*minutes/60);
}
