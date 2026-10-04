(function(root){
 'use strict';
 const russianError='Введите полный телефон: +7 и 10 цифр после него.';
 function normalize(value){
  const raw=String(value||'').trim();if(!raw||!/^[+\d ()-]+$/.test(raw))return raw;
  const digits=raw.replace(/\D/g,'');if(!digits)return raw;
  if(raw.startsWith('+'))return '+'+digits;
  if(digits.startsWith('8'))return '+7'+digits.slice(1);
  if(digits.startsWith('7'))return '+'+digits;
  return '+7'+digits;
 }
 function valid(value,required=false,russian=false){
  const raw=String(value||'').trim();if(!raw||raw==='+7')return !required;
  if(!/^\+\d+$/.test(raw))return false;
  return russian||raw.startsWith('+7')?/^\+7\d{10}$/.test(raw):/^\+\d{10,15}$/.test(raw);
 }
 let serial=0;const bound=new WeakMap();
 function bind(input){
  if(bound.has(input))return bound.get(input);
  input.type='tel';input.inputMode='tel';input.placeholder='+7';
  const error=document.createElement('p');error.id='phone-error-'+(++serial);error.className='phone-field-error';error.hidden=true;error.setAttribute('role','alert');
  input.after(error);const described=input.getAttribute('aria-describedby');input.setAttribute('aria-describedby',[described,error.id].filter(Boolean).join(' '));
  const state={error};bound.set(input,state);
  function clear(){input.setCustomValidity('');input.removeAttribute('aria-invalid');input.classList.remove('phone-invalid');error.hidden=true;error.textContent='';}
  state.clear=clear;
  input.addEventListener('focus',()=>{if(!input.value&&!input.disabled){input.value='+7';input.setSelectionRange(2,2);}});
  input.addEventListener('input',e=>{
   let value=input.value;
   if((value==='+78'&&e.data==='8')||(value==='+77'&&e.data==='7'))value='+7';
   if(e.inputType==='insertFromPaste'&&/^\+7[78]\d{10}$/.test(value))value=value.slice(2);
   const normalized=normalize(value),cursor=input.selectionStart;
   if(normalized!==input.value){const delta=normalized.length-input.value.length;input.value=normalized;if(cursor!==null)input.setSelectionRange(Math.max(0,cursor+delta),Math.max(0,cursor+delta));}
   if(!error.hidden)validate(input,false);else clear();
  });
  input.addEventListener('blur',()=>validate(input,false));
  return state;
 }
 function validate(input,focus=true){
  if(input.disabled)return true;
  const state=bind(input);input.value=normalize(input.value);
  if(!input.required&&input.value==='+7')input.value='';
  const russian=!!input.closest('#checkout');
  if(valid(input.value,input.required,russian)){state.clear();return true;}
  const message=russian||!input.value||input.value.startsWith('+7')?russianError:'Введите полный телефон: от 10 до 15 цифр с кодом страны.';
  input.setCustomValidity(message);input.setAttribute('aria-invalid','true');input.classList.add('phone-invalid');state.error.textContent=message;state.error.hidden=false;
  for(let parent=input.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
  if(focus){input.scrollIntoView({block:'center'});input.focus();}
  return false;
 }
 const api={normalize,valid,bind,validate};
 if(typeof module!=='undefined'&&module.exports){module.exports=api;return;}
 root.STARTPhone=api;
 const selector='input[type="tel"],input[name="phone"]';
 const scan=()=>{for(const input of document.querySelectorAll(selector))bind(input);};
 document.addEventListener('submit',e=>{const inputs=[...e.target.querySelectorAll(selector)];let first;for(const input of inputs)if(!validate(input,false)&&!first)first=input;if(first){e.preventDefault();e.stopImmediatePropagation();validate(first);}},true);
 document.addEventListener('invalid',e=>{if(e.target.matches(selector)){e.preventDefault();validate(e.target);}},true);
 document.addEventListener('reset',e=>{setTimeout(()=>{for(const input of e.target.querySelectorAll(selector))bound.get(input)?.clear();},0);},true);
 new MutationObserver(scan).observe(document.body,{childList:true,subtree:true});scan();
})(typeof window==='undefined'?globalThis:window);
