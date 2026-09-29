const DAY=86400000,HOUR=3600000;
const date=t=>new Date(t+3*HOUR).toISOString().slice(0,10);
const midnight=d=>Date.parse(d+'T00:00:00+03:00');
export class AutoShift{
 constructor(work){this.work=work;this.db=work.db;this.db.exec('CREATE INDEX IF NOT EXISTS payments_created_workday ON payments(created); CREATE TABLE IF NOT EXISTS automatic_shift_closures(shift_id INTEGER PRIMARY KEY REFERENCES shifts(id),cutoff INTEGER NOT NULL,processed_at INTEGER NOT NULL,review_json TEXT NOT NULL)');}
 get from(){return this.db.prepare("SELECT value FROM admin_config WHERE key='auto_shift_from'").get()?.value||null;}
 day(now=Date.now()){const d=date(now-8*HOUR),from=this.from;return from&&d>=from?d:date(now);}
 bounds(d){const start=midnight(d),from=this.from;return from&&d>=from?[start+(d===from?0:8*HOUR),start+DAY+8*HOUR]:[start,start+DAY];}
 payEnd(session){const d=this.day(session.started_at);return this.from&&d>=this.from?Math.max(session.started_at,midnight(d)+DAY+2*HOUR):Infinity;}
 capped(session,now){const cutoff=this.payEnd(session);return cutoff<=now?{...session,ended_at:Math.min(session.ended_at??cutoff,cutoff)}:session;}
 run(now=Date.now()){
  const from=this.from;if(!from)return;
  const today=date(now),latest=midnight(today)+7.5*HOUR-(now<midnight(today)+7.5*HOUR?DAY:0);
  if(latest<midnight(from)+DAY+7.5*HOUR)return;
  // Close forgotten attendance first. A restart later in the day never extends paid hours.
  this.work.tx(()=>{for(const row of this.db.prepare('SELECT * FROM employee_work_sessions WHERE ended_at IS NULL AND started_at<?').all(latest)){
   const ownCutoff=midnight(this.day(row.started_at))+DAY+7.5*HOUR;if(ownCutoff>latest)continue;
   const end=Math.min(ownCutoff-5.5*HOUR,this.payEnd(row));const ended=Math.max(row.started_at,end);
   this.db.prepare('UPDATE employee_work_sessions SET ended_at=?,revision=revision+1 WHERE id=? AND ended_at IS NULL').run(ended,row.id);
   this.work.audit({id:row.user_id},'work_auto_end',row.id,row,{...row,ended_at:ended},'Автоматически в 07:30 МСК; начисление до 02:00',now);
  }});
  for(const shift of this.db.prepare('SELECT * FROM shifts WHERE closed_at IS NULL ORDER BY day,id').all()){
   const cutoff=midnight(shift.day)+DAY+7.5*HOUR;if(cutoff>latest)continue;
   this.work.tx(()=>{
    if(this.db.prepare('SELECT closed_at FROM shifts WHERE id=?').get(shift.id).closed_at)return;
    const actor={id:shift.opened_by},calc=this.work.settlement(shift.day,cutoff);
    // Earlier calendar-only days may end before an overnight employee's actual departure.
    for(const e of calc.employees)e.active=false;calc.final=true;calc.revenue.final=true;
    this.work.freeze(shift,calc,actor,now);
    for(const tail of calc.carried_work)this.db.prepare('INSERT OR IGNORE INTO late_work_settlements VALUES(?,?,?)').run(tail.source_shift_id,shift.id,JSON.stringify(tail));
    this.db.prepare('UPDATE shifts SET closed_at=?,closed_by=?,cash_end_cents=NULL,cashless_cents=NULL,cash_revenue_cents=NULL,total_revenue_cents=?,declared_revenue_cents=NULL WHERE id=?').run(cutoff,actor.id,calc.revenue.cents,shift.id);
    const review={unallocatedBonusCents:calc.unallocated_bonus_cents||0,source:'registered_sales',payUntil:'02:00',closeAt:'07:30'};
    this.db.prepare('INSERT INTO automatic_shift_closures VALUES(?,?,?,?)').run(shift.id,cutoff,now,JSON.stringify(review));
    this.work.audit(actor,'cash_auto_close',shift.id,shift,{totalRevenueCents:calc.revenue.cents,...review},'Автозакрытие в 07:30 МСК по зарегистрированным продажам, без ручной сверки наличных',now);
   });
  }
 }
}
