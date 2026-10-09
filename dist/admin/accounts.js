(()=>{'use strict';
const $=selector=>document.querySelector(selector),make=(tag,value='')=>{const element=document.createElement(tag);element.textContent=value;return element;};
let user,target,contacts={people:[]};
async function api(path,body){const response=await fetch('/api/admin/accounts'+path,{cache:'no-store',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw Error(data.error||'Не удалось выполнить действие.');return data;}
async function smsApi(body){const response=await fetch('/api/admin/staff-sms',{cache:'no-store',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw Error(data.error||'Не удалось загрузить телефоны сотрудников.');return data;}
const digits=value=>String(value||'').replace(/\D/g,'');
function normalizedPhone(value){if(!String(value??'').trim())return '';const number=digits(value);if(!number)return null;if(number.length===10)return '7'+number;if(number.length===11&&number[0]==='8')return '7'+number.slice(1);if(number.length===11&&number[0]==='7')return number;return null;}
function displayPhone(value){const number=normalizedPhone(value);return number&&number.length===11?`+7 ${number.slice(1,4)} ${number.slice(4,7)}-${number.slice(7,9)}-${number.slice(9)}`:String(value||'');}
function mergeContacts(next){const previous=contacts.people||[];return {...next,people:(next.people||[]).map(person=>{const old=previous.find(item=>String(item.userId)===String(person.userId));return old&&old.revision>person.revision?old:person;})};}
async function save(form,self){const data=new FormData(form);if(data.get('password')!==data.get('confirm'))throw Error('Пароли не совпадают.');const result=await api('/password',{userId:self?user.id:target,password:data.get('password'),...(self?{currentPassword:data.get('currentPassword')}:{})});form.reset();if(result.signInAgain){location.href='/admin/';return;}$('#password-dialog').close();$('#account-message').textContent='Пароль изменён. Прежние сеансы сотрудника завершены.';}
for(const [selector,self] of [['#own-password',true],['#reset-password',false]])$(selector).onsubmit=async event=>{event.preventDefault();const button=event.currentTarget.querySelector('button');if(button.disabled)return;button.disabled=true;const output=self?$('#account-message'):$('#password-error');output.textContent='';try{await save(event.currentTarget,self);}catch(error){output.textContent=error.message;}finally{button.disabled=false;}};
$('#password-close').onclick=()=>$('#password-dialog').close();
function appendPhoneEditor(row,account,person){
 if(!person){row.append(make('small','Телефон недоступен.'));return;}
 const form=make('form');form.className='account-phone';const field=make('label','Телефон');const input=make('input');input.type='tel';input.inputMode='tel';input.autocomplete='off';input.value=displayPhone(person.phone);input.setAttribute('aria-label','Телефон для СМС: '+account.login);field.append(input);
 const button=make('button','Сохранить');button.type='submit';const status=make('p');status.className='account-phone-status';status.setAttribute('role','status');form.append(field,button,status);
 form.onsubmit=async event=>{event.preventDefault();if(button.disabled)return;const phone=normalizedPhone(input.value);if(phone===null){status.textContent='Введите российский номер из 10 цифр после +7 или оставьте поле пустым.';input.focus();return;}button.disabled=true;input.disabled=true;status.textContent='';try{contacts=mergeContacts(await smsApi({action:'contact',userId:person.userId,phone,revision:((contacts.people||[]).find(item=>String(item.userId)===String(account.id))||person).revision}));const fresh=(contacts.people||[]).find(item=>String(item.userId)===String(account.id));if(fresh)input.value=displayPhone(fresh.phone);status.textContent='Телефон сохранён.';}catch(error){status.textContent=error.message;}finally{button.disabled=false;input.disabled=false;}};
 row.append(form);
}
async function list(){
 const data=await api('');
 let contactError='';
 try{contacts=await smsApi();}catch(error){contacts={people:[]};contactError=error.message;}
 if(contactError)$('#account-message').textContent='Телефоны недоступны: '+contactError+'. Управление паролями и доступом остаётся доступно.';
 const root=$('#account-list');root.replaceChildren();
 for(const account of data.items){
  const row=make('article');row.className='account-row';row.append(make('strong',account.login),make('span',account.archived_at?'Удалён (история сохранена)':({admin:'Администратор',staff:'Прокат и кафе',waiter:'Официант'}[account.role])));
  if(!account.archived_at){const person=(contacts.people||[]).find(item=>String(item.userId)===String(account.id));appendPhoneEditor(row,account,person);}
  if(!account.archived_at&&account.id!==user.id){
   const reset=make('button','Сменить пароль');reset.onclick=()=>{target=account.id;$('#password-heading').textContent='Пароль: '+account.login;$('#reset-password').reset();$('#password-error').textContent='';$('#password-dialog').showModal();};
   const remove=make('button','Удалить доступ');remove.className='account-delete';remove.onclick=async()=>{if(!confirm('Удалить доступ '+account.login+'? Вход будет закрыт. История смен, зарплат и действий сохранится.'))return;remove.disabled=true;try{await api('/archive',{userId:account.id});await list();$('#account-message').textContent='Доступ закрыт. История сохранена.';}catch(error){$('#account-message').textContent=error.message;remove.disabled=false;}};
   row.append(reset,remove);
  }
  root.append(row);
 }
}
(async()=>{try{const response=await fetch('/api/admin/session',{cache:'no-store'});({user}=await response.json());if(!user){$('#account-login').hidden=false;return;}$('#own-account').hidden=false;if(user.role==='admin'){$('#account-admin').hidden=false;await list();}}catch(error){$('#account-message').textContent=error.message;}})();
})();
