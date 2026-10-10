import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {AdminStore} from './admin.mjs';
import {BatteryStateStore,batteryStateHandler} from './battery-state.mjs';
import {BatteryTripStore} from './battery-trips.mjs';

function fixture(t){
 const admin=new AdminStore(':memory:');
 admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'staff','staff','unused')");
 const owner={id:1,role:'admin'},staff={id:2,role:'staff'};
 admin.user=token=>token==='owner'?owner:token==='staff'?staff:null;
 const store=new BatteryStateStore(admin);t.after(()=>admin.close());
 return {admin,store,owner,staff};
}
test('default and edited thresholds are shared with staff overview, persist and leave devices untouched',t=>{
 const {admin,store,owner,staff}=fixture(t);
 assert.deepEqual(store.colorSettings(),{greenFrom:50,yellowFrom:20,revision:0});
 const body={requestId:randomUUID(),revision:0,greenFrom:65,yellowFrom:25};
 const saved=store.saveColors(body,owner);
 assert.deepEqual(saved.colorSettings,{greenFrom:65,yellowFrom:25,revision:1});
 assert.equal(store.list(owner).colorSettings.greenFrom,65);
 assert.equal(new BatteryTripStore(store).overview(staff).colorSettings.yellowFrom,25);
 assert.equal(new BatteryStateStore(admin).colorSettings().revision,1);
 assert.equal(admin.db.prepare('SELECT count(*) n FROM battery_devices').get().n,0);
 assert.equal(admin.db.prepare("SELECT count(*) n FROM admin_audit WHERE action='battery_colors'").get().n,1);
 assert.equal(store.saveColors(body,owner).duplicate,true);
 assert.equal(store.colorSettings().revision,1);
 assert.throws(()=>store.saveColors({...body,greenFrom:70},owner),e=>e.status===409);
 assert.throws(()=>store.saveColors({...body,requestId:randomUUID()},owner),e=>e.status===409);
});
test('invalid or unauthorized thresholds do not alter state',t=>{
 const {store,owner,staff}=fixture(t);
 const body={requestId:randomUUID(),revision:0,greenFrom:50,yellowFrom:20};
 for(const change of [{greenFrom:101},{yellowFrom:-1},{greenFrom:20},{greenFrom:50.5},{yellowFrom:'20'},{revision:null},{greenFrom:null}])assert.throws(()=>store.saveColors({...body,...change},owner));
 assert.throws(()=>store.saveColors(body,staff),e=>e.status===403);
 assert.throws(()=>store.saveColors(body,{...owner,scheduleOnly:true}),e=>e.status===403);
 assert.equal(store.colorSettings().revision,0);
 store.saveColors({...body,greenFrom:100,yellowFrom:0},owner);
 assert.equal(store.colorSettings().greenFrom,100);
});
test('fresh summary does not turn an old charging status into fresh charging evidence',t=>{
 const {store,owner,staff}=fixture(t),now=Date.now(),bmsId='41:18:12:01:37:50';
 const device=store.manage({action:'create',requestId:randomUUID(),name:'Battery',catamaranLabel:'Сашин',bmsId},owner,now);
 store.ingest({deviceId:device.device.deviceId,bmsId,bootId:'deadbeef',sequence:1,bmsConnected:true,measurementAgeMs:0,telemetry:{socPercent:70,state:'charging',currentA:5,fieldAgesMs:{summary:0,status:91000}}},device.token,now);
 const overview=new BatteryTripStore(store).overview(staff,now),row=overview.catamarans[0].devices[0];
 assert.equal(row.stateFresh,false);assert.equal(row.socPercent,70);assert.equal(row.stale,false);
});
test('colors API requires admin, expected origin and JSON; repeated success is idempotent',async t=>{
 const {admin,store}=fixture(t),origin='http://station.test';
 const handler=batteryStateHandler(store,admin,origin);
 const server=http.createServer(async(req,res)=>{if(!await handler(req,res,new URL(req.url,origin))){res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url='http://127.0.0.1:'+server.address().port+'/api/admin/battery-state/colors';
 assert.equal((await fetch(url)).status,401);
 assert.equal((await fetch(url,{headers:{cookie:'__Host-start_session=staff'}})).status,403);
 assert.equal((await fetch(url,{headers:{cookie:'__Host-start_session=owner'}})).status,200);
 const body=JSON.stringify({requestId:randomUUID(),revision:0,greenFrom:60,yellowFrom:30});
 const headers={cookie:'__Host-start_session=owner','content-type':'application/json',origin};
 assert.equal((await fetch(url,{method:'POST',headers:{...headers,origin:'http://evil.test'},body})).status,403);
 assert.equal((await fetch(url,{method:'POST',headers,body})).status,200);
 assert.equal((await (await fetch(url,{method:'POST',headers,body})).json()).duplicate,true);
 assert.equal(store.colorSettings().revision,1);
});
