import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {OperationsCosts,cafeCostKey} from './operations-analytics-costs.mjs';

const owner={id:1,role:'admin'},staff={id:2,role:'staff'},waiter={id:4,role:'waiter'},scheduleOnly={id:3,role:'admin',scheduleOnly:true};

function fixture(t){
 const admin=new AdminStore(':memory:');
 admin.db.exec("INSERT INTO admin_users VALUES(1,'owner','admin','unused'),(2,'staff','staff','unused'),(3,'schedule','admin','unused'),(4,'waiter','waiter','unused')");
 const cafe=new CafeStore(admin,new SmsStore(admin,null,{}),{env:{}});
 const costs=new OperationsCosts(admin,cafe);
 t.after(()=>admin.close());
 return {admin,cafe,costs};
}

const change=(kind,key,values)=>({kind,key,values});
const save=(costs,user,changes,revision=costs.revision(),requestId=randomUUID(),now=1000)=>costs.save({requestId,revision,changes},user,now);

test('cost keys and catalog expose base/variant/option, rental and global cost fields',t=>{
 const {costs}=fixture(t),catalog=costs.catalog(owner,500),variant=catalog.rows.find(r=>r.kind==='cafe'&&r.component?.startsWith('variant:')),option=catalog.rows.find(r=>r.kind==='cafe'&&r.component?.startsWith('option:'));
 assert.equal(cafeCostKey('item-1'),'item-1|base');
 assert.ok(variant);
 assert.equal(variant.key,cafeCostKey(variant.itemId,variant.component));
 assert.ok(option);
 assert.equal(option.key,cafeCostKey(option.itemId,option.component));
 assert.deepEqual(catalog.rows.find(r=>r.kind==='rental'&&r.key==='electric').fields,{issueCents:null,hourCents:null,kwhPerHour:null,electricityTariffCents:null,electricityIncluded:null});
 assert.deepEqual(catalog.rows.find(r=>r.kind==='settings').fields,{cafeCardBps:null,rentalCardBps:null,cafeWageBps:null,deliveryCostCents:null});
});

test('cost save accepts zero values, stores immutable history and returns current fields',t=>{
 const {costs,cafe}=fixture(t),item=cafe.catalog().items[0],key=cafeCostKey(item.id),global='global';
 const changes=[change('cafe',key,{portionCents:0}),change('rental','electric',{issueCents:0,hourCents:0,kwhPerHour:0,electricityTariffCents:0,electricityIncluded:1}),change('settings',global,{cafeCardBps:0,rentalCardBps:0,cafeWageBps:0,deliveryCostCents:0})];
 const result=save(costs,owner,changes,0,randomUUID(),1000);
 assert.equal(result.revision,3);
 assert.deepEqual(costs.at('cafe',key,1000),{portionCents:0});
 assert.deepEqual(costs.at('rental','electric',1000),{issueCents:0,hourCents:0,kwhPerHour:0,electricityTariffCents:0,electricityIncluded:1});
 assert.deepEqual(costs.catalog(owner,1000).rows.find(r=>r.kind==='settings').fields,{cafeCardBps:0,rentalCardBps:0,cafeWageBps:0,deliveryCostCents:0});
 assert.equal(costs.db.prepare('SELECT count(*) n FROM operations_cost_versions').get().n,3);
});

test('strict reader does not apply a version at its effective millisecond; later versions do not rewrite earlier values',t=>{
 const {costs,cafe}=fixture(t),key=cafeCostKey(cafe.catalog().items[0].id);
 save(costs,owner,[change('cafe',key,{portionCents:100})],0,randomUUID(),2000);
 save(costs,owner,[change('cafe',key,{portionCents:150})],1,randomUUID(),2000);
 assert.deepEqual(costs.reader()('cafe',key,2000),{});
 assert.deepEqual(costs.reader()('cafe',key,2001),{portionCents:150});
 save(costs,owner,[change('cafe',key,{portionCents:250})],2,randomUUID(),3000);
 const read=costs.reader();
 assert.deepEqual(read('cafe',key,2500),{portionCents:150});
 assert.deepEqual(read('cafe',key,3001),{portionCents:250});
 assert.deepEqual(costs.at('cafe',key,3000),{portionCents:250});
});

test('cost saves reject invalid values and stale revisions and roll back the entire batch',t=>{
 const {costs,cafe,admin}=fixture(t),key=cafeCostKey(cafe.catalog().items[0].id),before=costs.revision();
 assert.throws(()=>save(costs,owner,[change('cafe',key,{portionCents:50}),change('rental','sup',{hourCents:-1})],before),/стоимость|количество/i);
 assert.equal(costs.revision(),before);
 assert.equal(admin.db.prepare('SELECT count(*) n FROM operations_cost_versions').get().n,0);
 assert.throws(()=>save(costs,owner,[change('cafe',key,{portionCents:50})],before+1),/изменена|обновите/i);
 assert.throws(()=>save(costs,owner,[change('cafe',key,{unknownCost:1})],before),/поле/i);
 assert.equal(costs.revision(),before);
});

test('cost request retry is idempotent only for the same fingerprint and rejects duplicate targets',t=>{
 const {costs,cafe}=fixture(t),key=cafeCostKey(cafe.catalog().items[0].id),requestId=randomUUID(),body={requestId,revision:0,changes:[change('cafe',key,{portionCents:125})]};
 assert.equal(costs.save(body,owner,1000).duplicate,undefined);
 assert.equal(costs.save(body,owner,2000).duplicate,true);
 assert.throws(()=>costs.save({...body,changes:[change('cafe',key,{portionCents:126})]},owner,2000),/уже использован/i);
 assert.throws(()=>save(costs,owner,[change('cafe',key,{portionCents:10}),change('cafe',key,{portionCents:20})],costs.revision()),/дважды/i);
});

test('cost catalog and cost writes are owner-only',t=>{
 const {costs,cafe}=fixture(t),key=cafeCostKey(cafe.catalog().items[0].id);
 assert.equal(costs.catalog(owner).canEdit,true);
 for(const user of [staff,waiter,scheduleOnly,{id:8,role:'guest'},null,{}]){
  assert.throws(()=>costs.catalog(user),e=>e.status===403);
  assert.throws(()=>save(costs,user,[change('cafe',key,{portionCents:1})]),e=>e.status===403);
 }
 assert.equal(costs.revision(),0);
});
