// Closed cash reports are immutable. Their later work is settled once in a later day.
export function installLateWork(db){
 db.exec('CREATE TABLE IF NOT EXISTS late_work_settlements(source_shift_id INTEGER PRIMARY KEY REFERENCES shifts(id),settled_shift_id INTEGER NOT NULL REFERENCES shifts(id),snapshot_json TEXT NOT NULL)');
}
export function mergeWork(base,extra){
 const rows=new Map(base.employees.map(e=>[e.user_id,{...e}]));
 for(const e of extra.employees){const old=rows.get(e.user_id);if(!old){rows.set(e.user_id,{...e});continue;}for(const k of ['worked_ms','fixed_cents','bonus_cents','salary_cents'])old[k]=(old[k]||0)+(e[k]||0);old.active=old.active||e.active;old.sessions=[...(old.sessions||[]),...(e.sessions||[])];old.started_at=Math.min(old.started_at??Infinity,e.started_at??Infinity);old.ended_at=old.active?null:Math.max(old.ended_at||0,e.ended_at||0);}
 return {...base,employees:[...rows.values()],bonus_pool_cents:base.bonus_pool_cents+extra.bonus_pool_cents,unallocated_bonus_cents:(base.unallocated_bonus_cents||0)+(extra.unallocated_bonus_cents||0),revenue:{...base.revenue,cents:base.revenue.cents+extra.revenue.cents,registered_cents:(base.revenue.registered_cents??base.revenue.cents)+(extra.revenue.registered_cents??extra.revenue.cents)}};
}
export function pendingLateWork(store,day,now){
 return store.db.prepare('SELECT s.* FROM shifts s WHERE s.day<? AND s.closed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM late_work_settlements l WHERE l.source_shift_id=s.id) ORDER BY s.day').all(day).map(s=>({source_shift_id:s.id,...store.calculate(s.day,now,undefined,{after:s.closed_at})})).filter(c=>c.employees.length||c.revenue.cents);
}
