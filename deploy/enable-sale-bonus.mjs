// Run only after a database backup: node deploy/enable-sale-bonus.mjs DB YYYY-MM-DD --apply
// Closed days, their accruals, payments and historical settings are not rewritten.
import {AdminStore} from '../server/admin.mjs';
import {pathToFileURL} from 'node:url';
export function enableSaleBonus(admin,day,now=Date.now()){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw Error('Expected accounting day');
 const w=admin.workforce,u=w.people().find(p=>p.role==='admin');if(!u)throw Error('No administrator');
 return w.tx(()=>{
  const before=w.settings(),settings={...before,pay_mode:'prorated',fixed_cents:250000,full_shift_minutes:720,bonus_percent:5,distribution:'sales',revision:before.revision+1};
  const shift=admin.currentShift(day),oldDay=admin.db.prepare('SELECT settings_json FROM work_day_settings WHERE day=?').get(day);
  if(before.distribution==='sales'&&before.pay_mode==='prorated'&&before.fixed_cents===250000&&before.full_shift_minutes===720&&before.bonus_percent===5&&(!oldDay||JSON.parse(oldDay.settings_json).distribution==='sales'||shift?.closed_at))return {alreadyEnabled:true,closedDay:!!shift?.closed_at};
  admin.db.prepare("UPDATE salary_settings SET fixed_cents=?,pay_mode=?,full_shift_minutes=?,bonus_percent=?,distribution=?,revision=? WHERE id=1").run(settings.fixed_cents,settings.pay_mode,settings.full_shift_minutes,settings.bonus_percent,settings.distribution,settings.revision);
  if(!shift?.closed_at){
   admin.db.prepare('INSERT INTO work_day_settings(day,settings_json,created_at) VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET settings_json=excluded.settings_json').run(day,JSON.stringify(settings),now);
   if(shift)admin.db.prepare('UPDATE shifts SET salary_settings_json=? WHERE id=? AND closed_at IS NULL').run(JSON.stringify(settings),shift.id);
  }
  w.audit(u,'sale_bonus_enabled',shift?.id??null,{settings:before,daySettings:oldDay?.settings_json??null},{settings,day,openDayChanged:!shift?.closed_at},'Согласовано владельцем: 2500 за 12 часов; 5% по присутствию в момент продажи; разница кассы по часам',now);
  return {enabled:true,day,openDayChanged:!shift?.closed_at};
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [, ,file,day,flag]=process.argv;if(!file||flag!=='--apply')throw Error('Usage: DB YYYY-MM-DD --apply');
 const a=new AdminStore(file);try{console.log(JSON.stringify(enableSaleBonus(a,day)));}finally{a.close();}
}
