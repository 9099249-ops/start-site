import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {estimateChargeMinutes} from './battery-charge-estimate.mjs';
import {AdminStore} from './admin.mjs';
import {BatteryStateStore} from './battery-state.mjs';
import {BatteryTripStore} from './battery-trips.mjs';

test('charge estimate uses capacity and current, respects observed taper and ignores earlier discharge',()=>{
 const t={state:'charging',currentA:20,remainingCapacityAh:80};
 assert.equal(estimateChargeMinutes(t,100),60);
 assert.equal(estimateChargeMinutes({...t,currentA:10},100,[t]),120);
 assert.equal(estimateChargeMinutes(t,100,[{...t,currentA:10}]),80);
 assert.equal(estimateChargeMinutes(t,100,[{state:'idle',currentA:0},{...t,currentA:1}]),60);
 assert.equal(estimateChargeMinutes({...t,remainingCapacityAh:100},100),0);
 for(const patch of [{state:'idle'},{currentA:0},{currentA:-1},{remainingCapacityAh:null},{remainingCapacityAh:101}])assert.equal(estimateChargeMinutes({...t,...patch},100),null);
 assert.equal(estimateChargeMinutes(t,null),null);
});

test('charging and runtime estimates project separately; stale status, BMS loss and stop suppress charge ETA',t=>{
 const admin=new AdminStore(':memory:');t.after(()=>admin.close());
 admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused')");
 const user={id:1,role:'admin'},store=new BatteryStateStore(admin),trips=new BatteryTripStore(store);
 const made=store.manage({action:'create',requestId:randomUUID(),name:'Test',catamaranLabel:'Сашин',bmsId:'41:18:12:01:37:50',capacityAh:100},user,1000);
 const id=made.device.deviceId;
 const ingest=(sequence,at,patch={},health={})=>store.ingest({deviceId:id,bmsId:made.device.bmsId,bootId:'1234abcd',sequence,measurementAgeMs:0,bmsConnected:true,...health,telemetry:{state:'charging',currentA:20,remainingCapacityAh:80,socPercent:80,fieldAgesMs:{status:0},...patch}},made.token,at);
 ingest(1,10000);ingest(2,70000,{currentA:10,remainingCapacityAh:81,socPercent:81});
 let d=trips.overview(user,70000).catamarans[0].devices[0];
 assert.equal(d.state,'charging');assert.equal(d.estimatedChargeMinutes,114);assert.equal(d.estimatedMinutes,null);
 d=trips.overview(user,170001).catamarans[0].devices[0];assert.equal(d.estimatedChargeMinutes,null);assert.equal(d.stale,true);
 ingest(3,180000,{}, {bmsConnected:false});d=trips.overview(user,180000).catamarans[0].devices[0];assert.equal(d.estimatedChargeMinutes,null);
 ingest(4,190000,{state:'idle',currentA:0});d=trips.overview(user,190000).catamarans[0].devices[0];assert.equal(d.estimatedChargeMinutes,null);
 ingest(5,200000,{state:'discharging',currentA:-20});d=trips.overview(user,200000).catamarans[0].devices[0];assert.equal(d.estimatedChargeMinutes,null);assert.equal(d.estimatedMinutes,240);
 ingest(6,210000,{fieldAgesMs:{status:100000}});d=trips.overview(user,210000).catamarans[0].devices[0];assert.equal(d.estimatedChargeMinutes,null);
});
