import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const root=new URL('../dist/admin/',import.meta.url);
const read=name=>readFile(new URL(name,root),'utf8');
const smsScript=await read('staff-sms.js'),smsLoader=await read('sms.js'),smsPage=await read('index.html');
const accountScript=await read('accounts.js'),accountPage=await read('accounts.html');
class Element{
 constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.attributes={};this.textContent='';this.value='';this.disabled=false;this.checked=false;this.className='';this.hidden=false;}
 append(...nodes){this.children.push(...nodes);}
 prepend(...nodes){this.children.unshift(...nodes);}
 replaceChildren(...nodes){this.children=[...nodes];}
 setAttribute(key,value){this.attributes[key]=value;}
 querySelector(selector){return this.children.find(node=>node.tagName===selector)||null;}
 reset(){this.didReset=true;}
 showModal(){this.open=true;}
 close(){this.open=false;}
 focus(){this.focused=true;}
}
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,0));for(let i=0;i<16;i++)await Promise.resolve();};
const descendants=node=>[node,...node.children.flatMap(descendants)];
const snapshot=()=>({enabled:true,revision:4,transport:{enabled:true,dailyLimit:80,sign:'START'},people:[{userId:8,name:'Имя не для SMS панели',login:'worker',phone:'79030000000',revision:2}],jobs:[{id:9,userId:8,name:'Сотрудник',day:'2026-10-08',startTime:'18:00',kind:'hour',due:'2026-10-08T15:00:00Z',status:'unknown',attempts:1,lastError:'Timeout',sentAt:null,cancelReason:'expired'}],events:[{id:1,action:'phone_available',body:{attempt:2,reason:'schedule_changed'},at:'2026-10-08T15:00:00Z'},{id:2,action:'contact_changed',body:{},at:'2026-10-08T15:01:00Z'},{id:3,action:'scheduled',body:{},at:'2026-10-08T15:02:00Z'}]});

test('Versioned scripts are wired to admin SMS settings and account page',()=>{
 assert.match(smsPage,/sms\.js\?v=staff-sms-2/);assert.match(smsPage,/staff-sms\.js\?v=staff-sms-1/);assert.match(smsPage,/staff-sms\.css\?v=staff-sms-1/);
 assert.match(smsLoader,/await window\.staffSmsLoad\?\.\(root,user\)/);assert.match(smsLoader,/if\(user\.role==='admin'\)/);
 assert.match(accountPage,/accounts\.js\?v=staff-phones-1/);assert.match(accountPage,/staff-sms\.css\?v=staff-sms-1/);
 assert.match(accountScript,/action:'contact'/);assert.match(smsScript,/За час до смены/);assert.match(smsScript,/Ожидает повторной попытки/);
});

test('SMS settings are admin-only, have no editable staff list, and explain unknown outcomes',async()=>{
 const calls=[];const data=snapshot();data.people[0].phone='';data.people.push({userId:10,name:'Admin account',login:'admin',phone:'',revision:0});const document={createElement:tag=>new Element(tag)},window={};
 runInNewContext(smsScript,{document,window,fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>data};},Date});
 const panel=new Element('section');await window.staffSmsLoad(panel,{role:'staff'});assert.equal(calls.length,0);
 await window.staffSmsLoad(panel,{role:'admin'});await settle();const all=descendants(panel);
 assert.equal(calls.length,1);assert.equal(all.some(node=>node.className==='staff-sms-person'),false);
 assert.equal(all.some(node=>node.textContent==='Имя не для SMS панели'),false);
 assert.ok(all.some(node=>node.textContent.includes('Проверьте SMS Aero вручную')));
 assert.ok(all.some(node=>node.textContent.includes('автоматического повтора нет')));
 assert.ok(all.some(node=>node.textContent.includes('За час до смены')));
 assert.ok(all.some(node=>node.textContent.includes('Телефон добавлен, напоминание запланировано · Попытка 2 · График сменился')));
 assert.ok(all.some(node=>node.textContent.includes('Телефон сотрудника изменён')));
 assert.ok(all.some(node=>node.textContent.includes('Напоминание запланировано')));
 assert.ok(all.some(node=>node.textContent.includes('Срок отправки истёк')));
 assert.equal(all.some(node=>/phone_available|contact_changed|schedule_changed|expired/.test(node.textContent)),false);
 assert.ok(all.some(node=>node.textContent.includes('Без телефона: 1')));
 assert.ok(all.some(node=>node.tagName==='details'&&!node.open));
});

test('Settings toggle is locked during POST and keeps its draft after failure',async()=>{
 let release;const document={createElement:tag=>new Element(tag)},window={};
 runInNewContext(smsScript,{document,window,fetch:async(_url,options)=>options.method==='POST'?new Promise(resolve=>{release=resolve;}):{ok:true,json:async()=>snapshot()},Date});
 const panel=new Element('section');await window.staffSmsLoad(panel,{role:'admin'});
 const form=descendants(panel).find(node=>node.className==='staff-sms-settings'),toggle=descendants(form).find(node=>node.tagName==='input');toggle.checked=false;
 const pending=form.onsubmit({preventDefault(){}});assert.equal(toggle.disabled,true);
 release({ok:false,status:500,json:async()=>({error:'Unavailable'})});await pending;
 assert.equal(toggle.checked,false);assert.equal(toggle.disabled,false);
});

function accountsFixture({role='admin',saveFail=false,holdPost=false,smsGetFail=false,accountFail=false}={}){
 const selectors=['#own-password','#reset-password','#password-close','#account-message','#password-error','#password-dialog','#password-heading','#account-list','#account-login','#own-account','#account-admin'];
 const nodes=new Map(selectors.map(selector=>[selector,new Element(selector)]));const calls=[];
 let data={people:[{userId:1,name:'Owner',login:'owner',phone:'79030000000',revision:3},{userId:2,name:'Worker',login:'worker',phone:'',revision:1}]};
 const accounts={items:[{id:1,login:'owner',role:'admin'},{id:2,login:'worker',role:'staff'},{id:3,login:'former',role:'staff',archived_at:1}]};
 let releasePost;const fetcher=async(url,options={})=>{calls.push({url,options});if(url==='/api/admin/session')return {json:async()=>({user:{id:1,role}})};if(url==='/api/admin/accounts')return accountFail?{ok:false,json:async()=>({error:'Accounts unavailable'})}:{ok:true,json:async()=>accounts};if(url==='/api/admin/staff-sms'){if(options.method==='POST'){const body=JSON.parse(options.body);if(holdPost)return new Promise(resolve=>{releasePost=resolve;});if(saveFail)return {ok:false,json:async()=>({error:'Unavailable'})};data={people:data.people.map(person=>person.userId===body.userId?{...person,phone:body.phone,revision:person.revision+1}:person)};return {ok:true,json:async()=>data};}if(smsGetFail)throw Error('Staff SMS unavailable');return {ok:true,json:async()=>data};}throw Error(url);};
 const document={querySelector:selector=>nodes.get(selector),createElement:tag=>new Element(tag)};
 runInNewContext(accountScript,{document,fetch:fetcher,location:{href:''},confirm:()=>true});
 return {nodes,calls,get releasePost(){return releasePost;}};
}

test('Only admins request staff SMS contacts; account rows edit active contacts by user ID and revision',async()=>{
 const staff=accountsFixture({role:'staff'});await settle();assert.equal(staff.calls.some(call=>call.url==='/api/admin/staff-sms'),false);
 const f=accountsFixture();await settle();assert.equal(f.calls.filter(call=>call.url==='/api/admin/staff-sms').length,1);
 const rows=descendants(f.nodes.get('#account-list'));const forms=rows.filter(node=>node.className==='account-phone');assert.equal(forms.length,2);
 assert.equal(rows.some(node=>node.className==='account-phone'&&node.textContent.includes('former')),false);
 const input=descendants(forms[1]).find(node=>node.tagName==='input');input.value='8 (912) 345-67-89';await forms[1].onsubmit({preventDefault(){}});await settle();
 const post=JSON.parse(f.calls.find(call=>call.options.method==='POST').options.body);
 assert.deepEqual({...post},{action:'contact',userId:2,phone:'79123456789',revision:1});
 const blank=descendants(forms[1]).find(node=>node.tagName==='input');blank.value='';await forms[1].onsubmit({preventDefault(){}});await settle();
 const posts=f.calls.filter(call=>call.options.method==='POST').map(call=>JSON.parse(call.options.body));assert.equal(posts[1].phone,'');
});

test('Contact lookup failure keeps the account list, password reset, and archive controls available',async()=>{
 const f=accountsFixture({smsGetFail:true});await settle();const all=descendants(f.nodes.get('#account-list'));
 assert.equal(all.filter(node=>node.className==='account-row').length,3);
 assert.equal(all.filter(node=>node.className==='account-delete').length,1);
 assert.ok(all.some(node=>node.textContent==='Сменить пароль'));
 assert.ok(all.some(node=>node.textContent==='Телефон недоступен.'));
 assert.match(f.nodes.get('#account-message').textContent,/Staff SMS unavailable/);
});

test('Accounts GET failure remains visible and does not issue a staff SMS GET',async()=>{
 const f=accountsFixture({accountFail:true});await settle();
 assert.equal(f.calls.some(call=>call.url==='/api/admin/staff-sms'),false);
 assert.equal(f.nodes.get('#account-message').textContent,'Accounts unavailable');
 assert.equal(descendants(f.nodes.get('#account-list')).filter(node=>node.className==='account-row').length,0);
});

test('Failed account phone save retains the unsaved draft',async()=>{
 const f=accountsFixture({saveFail:true});await settle();const form=descendants(f.nodes.get('#account-list')).find(node=>node.className==='account-phone');
 const input=descendants(form).find(node=>node.tagName==='input');input.value='+7 900 111-22-33';await form.onsubmit({preventDefault(){}});await settle();
 assert.equal(input.value,'+7 900 111-22-33');assert.ok(descendants(form).some(node=>node.textContent==='Unavailable'));
});

test('Alphabetic-only phone input is rejected without posting or clearing the stored contact',async()=>{
 const f=accountsFixture();await settle();const form=descendants(f.nodes.get('#account-list')).find(node=>node.className==='account-phone');
 const input=descendants(form).find(node=>node.tagName==='input');input.value='abc';await form.onsubmit({preventDefault(){}});await settle();
 assert.equal(input.value,'abc');assert.equal(f.calls.some(call=>call.options.method==='POST'),false);
 assert.ok(descendants(form).some(node=>node.textContent.includes('Введите российский номер')));
});

test('Account phone save blocks duplicate clicks while request is pending',async()=>{
 const f=accountsFixture({holdPost:true});await settle();const form=descendants(f.nodes.get('#account-list')).find(node=>node.className==='account-phone');
 const input=descendants(form).find(node=>node.tagName==='input'),button=descendants(form).find(node=>node.tagName==='button');input.value='79001112233';
 const pending=form.onsubmit({preventDefault(){}});assert.equal(button.disabled,true);assert.equal(input.disabled,true);await form.onsubmit({preventDefault(){}});
 assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1);
 f.releasePost({ok:false,json:async()=>({error:'Unavailable'})});await pending;await settle();assert.equal(input.value,'79001112233');assert.equal(input.disabled,false);
});

test('SMS text from the server is rendered as text, never markup',async()=>{
 const data=snapshot();data.jobs[0].name='<img src=x onerror=alert(1)>';
 const document={createElement:tag=>new Element(tag)},window={};runInNewContext(smsScript,{document,window,fetch:async()=>({ok:true,json:async()=>data}),Date});
 const panel=new Element('section');await window.staffSmsLoad(panel,{role:'admin'});await settle();
 assert.ok(descendants(panel).some(node=>node.textContent.includes(data.jobs[0].name)));assert.equal(descendants(panel).some(node=>node.tagName==='img'),false);
});
