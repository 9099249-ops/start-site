import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../dist/admin/guest-bills.js',import.meta.url),'utf8');
const styles=readFileSync(new URL('../dist/admin/guest-bills.css',import.meta.url),'utf8');
const helper=source.match(/function billPaymentMethods\(payment\)\{[^}]+\}/)?.[0];
assert.ok(helper,'manual payment choice helper exists');
const billPaymentMethods=runInNewContext(`${helper}; billPaymentMethods`);

test('Guest bill layout separates additions, primary payment and cancellation',()=>{
 const additions=source.indexOf("additions.className='guest-bill-additions'");
 const payments=source.indexOf("choices.className='guest-bill-payment-actions'");
 const footer=source.indexOf("footer.className='guest-bill-footer'");
 assert.ok(additions>=0&&payments>additions&&footer>payments);
 assert.match(source,/head\.className='guest-dialog-header'/);
 assert.match(source,/close\.setAttribute\('aria-label','Закрыть'\)/);
 assert.match(source,/guest-bill-cancel/);
 assert.match(styles,/\.guest-bill-payment-actions button\{flex:1 1 180px;min-height:48px;font-weight:700\}/);
 assert.match(styles,/@media\(max-width:480px\)/);
});

test('Ordinary and cancelled payments offer acquiring reconciliation only',()=>{
 for(const payment of [null,{state:'cancelled'},{state:'done'},{state:'cash_done'}])
  assert.deepEqual(JSON.parse(JSON.stringify(billPaymentMethods(payment))),[['card','Эквайринг вручную']]);
});

test('Unresolved payment states keep both reconciliation choices and warning',()=>{
 for(const state of ['payment_sending','payment_waiting','payment_unknown','receipt_sending','receipt_waiting','paid','review'])
  assert.deepEqual(JSON.parse(JSON.stringify(billPaymentMethods({state}))),[['card','Эквайринг вручную'],['cash','Наличные вручную']]);
 assert.match(source,/Результат оплаты не подтверждён/);
 assert.match(source,/const diagnostic=paymentDiagnostic\(b\.payment\);if\(diagnostic\)m\.body\.append\(diagnostic\)/);
});
