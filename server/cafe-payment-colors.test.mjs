import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../dist/admin/cafe.js',import.meta.url),'utf8');
const context={};vm.runInNewContext(source.split(/\r?\n/).filter(l=>l.startsWith('function orderTone(')||l.startsWith('function toneLabel(')).join('\n'),context);
test('payment colors distinguish unknown debit and receipt review from confirmed money',()=>{
 const row={status:'NEW',details:{},terminalPayment:null};assert.equal(context.orderTone(row),'yellow');
 assert.equal(context.orderTone({...row,details:{terminalPaidAt:1},terminalPayment:{state:'review',paid:true}}),'red');
 assert.equal(context.orderTone({...row,details:{terminalPaidAt:1},terminalPayment:{state:'receipt_waiting',paid:true}}),'yellow');
 assert.equal(context.orderTone({...row,details:{terminalPaidAt:1},terminalPayment:{state:'done',paid:true}}),'green');
 assert.equal(context.orderTone({...row,status:'DELIVERED'}),'yellow','unpaid delivered website order is not marked paid');
 assert.equal(context.orderTone({...row,status:'CANCELLED'}),'red');
 assert.equal(context.toneLabel({...row,details:{complimentary:{}}}),'Выдан бесплатно');
});
