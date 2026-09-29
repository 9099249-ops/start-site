import test from 'node:test';
import assert from 'node:assert/strict';
import {AdminStore,fleet} from './admin.mjs';
import {fleetOrder,saveFleetOrder} from './fleet-order.mjs';
test('Fleet order is shared, audited and cannot change inventory or payroll',()=>{
 const s=new AdminStore(':memory:');
 try{
  s.setupToken('local');s.setup({token:'local',adminPassword:'local-admin-test',staffPassword:'local-staff-test'},'local');
  const admin=s.user(s.login({login:'admin',password:'local-admin-test'},'a')),staff=s.user(s.login({login:'station',password:'local-staff-test'},'b'));
  const before=s.dashboard('2026-09-28',staff),old=fleetOrder(s,fleet),ids=old.items.map(x=>x.id).reverse();
  assert.throws(()=>saveFleetOrder(s,fleet,{revision:0,ids},staff),e=>e.status===403);
  for(const invalid of [ids.slice(1),[...ids.slice(1),ids[1]],[...ids.slice(1),'bogus']])assert.throws(()=>saveFleetOrder(s,fleet,{revision:0,ids:invalid},admin));
  assert.equal(saveFleetOrder(s,fleet,{revision:0,ids},admin).revision,1);
  assert.deepEqual(s.dashboard('2026-09-28',staff).fleet.map(x=>x.id),ids);
  assert.deepEqual(s.dashboard('2026-09-28',staff).fleet.toSorted((a,b)=>a.id.localeCompare(b.id)),before.fleet.toSorted((a,b)=>a.id.localeCompare(b.id)));
  assert.throws(()=>saveFleetOrder(s,fleet,{revision:0,ids:old.items.map(x=>x.id)},admin),e=>e.status===409);
  assert.equal(s.db.prepare("SELECT count(*) n FROM financial_audit_log WHERE action='fleet_order'").get().n,1);
  assert.deepEqual(JSON.parse(s.db.prepare("SELECT value FROM admin_config WHERE key='fleet_display_order'").get().value).ids,ids);
  assert.equal(s.db.prepare('SELECT count(*) n FROM payments').get().n,0);
 }finally{s.close();}
});
