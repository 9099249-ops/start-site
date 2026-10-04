import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import Phone from '../dist/admin/phone-input.js';

test('Phone entry adds +7 and replaces the domestic trunk without losing digits',()=>{
 for(const [input,expected] of [['9123456789','+79123456789'],['89123456789','+79123456789'],['8 (912) 345-67-89','+79123456789'],['79123456789','+79123456789'],['+7 (912) 345-67-89','+79123456789'],['8','+7'],['',''],['+380501234567','+380501234567'],['abc','abc']])assert.equal(Phone.normalize(input),expected);
});
test('Optional phone stays optional; incomplete Russian and malformed numbers fail',()=>{
 assert.equal(Phone.valid('',false),true);assert.equal(Phone.valid('+7',false),true);assert.equal(Phone.valid('',true),false);assert.equal(Phone.valid('+7',true),false);
 for(const value of ['+7912','+791234567890','+7abc9123456789'])assert.equal(Phone.valid(value,true),false);
 assert.equal(Phone.valid('+79123456789',true,true),true);assert.equal(Phone.valid('+380501234567',true,false),true);assert.equal(Phone.valid('+380501234567',true,true),false);
});
function fixture({required=true,value='',russian=false}={}){
 const listeners={},attributes=new Map([['aria-describedby','existing-hint']]),classes=new Set(),input={value,required,disabled:false,selectionStart:0,listeners,attributes,classList:{add:n=>classes.add(n),remove:n=>classes.delete(n)},after(error){this.error=error;},getAttribute:k=>attributes.get(k)||null,setAttribute:(k,v)=>attributes.set(k,v),removeAttribute:k=>attributes.delete(k),addEventListener:(k,fn)=>listeners[k]=fn,setCustomValidity(message){this.validationMessage=message;},setSelectionRange(a){this.selectionStart=a;},closest:()=>russian?{}:null,scrollIntoView(){this.scrolled=true;},focus(){this.focused=true;listeners.focus();}};
 const detail={tagName:'DETAILS',open:false,parentElement:null};input.parentElement=detail;
 const events={};input.matches=()=>true;
 const document={createElement:()=>({setAttribute(k,v){this[k]=v;}}),querySelectorAll:()=>[],addEventListener:(name,fn)=>events[name]=fn,body:{}};
 const context={window:{},document,MutationObserver:class{observe(){}},setTimeout:fn=>fn(),WeakMap};
 runInNewContext(readFileSync(new URL('../dist/admin/phone-input.js',import.meta.url),'utf8'),context);
 context.window.STARTPhone.bind(input);return {input,api:context.window.STARTPhone,classes,detail,events};
}
test('Invalid phone is highlighted, announced, focused and revealed; correction clears the error',()=>{
 const f=fixture({value:'8912'});assert.equal(f.api.validate(f.input),false);assert.equal(f.input.value,'+7912');assert.equal(f.classes.has('phone-invalid'),true);assert.equal(f.input.attributes.get('aria-invalid'),'true');assert.equal(f.input.error.role,'alert');assert.equal(f.input.error.hidden,false);assert.match(f.input.error.textContent,/10 цифр/);assert.equal(f.input.focused,true);assert.equal(f.detail.open,true);assert.equal(f.input.attributes.get('aria-describedby'),'existing-hint phone-error-1');
 f.input.value='89123456789';f.input.listeners.input({data:null});assert.equal(f.input.value,'+79123456789');assert.equal(f.input.validationMessage,'');assert.equal(f.input.error.hidden,true);assert.equal(f.classes.has('phone-invalid'),false);
});
test('Focus supplies +7; optional untouched prefix is removed on blur',()=>{
 const f=fixture({required:false});f.input.listeners.focus();assert.equal(f.input.value,'+7');f.input.listeners.blur();assert.equal(f.input.value,'');assert.equal(f.input.error.hidden,true);
});
test('Typing or pasting an initial 8 after the supplied prefix does not duplicate country code',()=>{
 const f=fixture();f.input.value='+78';f.input.listeners.input({data:'8',inputType:'insertText'});assert.equal(f.input.value,'+7');
 f.input.value='+789123456789';f.input.listeners.input({data:null,inputType:'insertFromPaste'});assert.equal(f.input.value,'+79123456789');
 f.input.value='+77';f.input.listeners.input({data:'7',inputType:'insertText'});assert.equal(f.input.value,'+7');
});
test('Disabled unresolved-request phone is never rewritten or revalidated',()=>{
 const f=fixture({value:'8912'});f.input.disabled=true;assert.equal(f.api.validate(f.input),true);assert.equal(f.input.value,'8912');
});
test('Submit capture blocks an invalid phone before application handlers and focuses the field',()=>{
 const f=fixture({value:'8912'}),event={target:{querySelectorAll:()=>[f.input]},preventDefault(){this.blocked=true;},stopImmediatePropagation(){this.stopped=true;}};
 f.events.submit(event);assert.equal(event.blocked,true);assert.equal(event.stopped,true);assert.equal(f.input.focused,true);assert.equal(f.input.error.hidden,false);
});
test('Submit capture leaves optional blank phone empty and does not block a valid form',()=>{
 const f=fixture({value:'+7',required:false}),event={target:{querySelectorAll:()=>[f.input]},preventDefault(){this.blocked=true;},stopImmediatePropagation(){this.stopped=true;}};
 f.events.submit(event);assert.equal(f.input.value,'');assert.equal(event.blocked,undefined);assert.equal(event.stopped,undefined);
});
test('Native invalid event reveals the custom error and reset clears its old validity',()=>{
 const f=fixture(),event={target:f.input,preventDefault(){this.blocked=true;}};
 f.events.invalid(event);assert.equal(event.blocked,true);assert.equal(f.input.error.hidden,false);assert.equal(f.input.focused,true);
 f.events.reset({target:{querySelectorAll:()=>[f.input]}});assert.equal(f.input.error.hidden,true);assert.equal(f.input.validationMessage,'');
});
