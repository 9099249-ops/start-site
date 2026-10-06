(()=>{
 'use strict';
 const KEY='start-terminal-voice-v1',ALERT_KEY='start-terminal-alerts-v1',LIMIT=64,phrasing='Приложи\u0301те карту';
 const alertPhrases={cafe_order:'Поступил заказ с сайта',task:'Новое дело',booking:'Новая бронь'};
 let parentHelper=null;
 try{parentHelper=parent!==window?parent.STARTTerminalVoice:null;}catch{}
 if(parentHelper&&typeof parentHelper.prompt==='function'){
  window.STARTTerminalVoice=parentHelper;
  return;
 }
 const spoken=new Set(),announced=new Set(),utterances=new Set(),activeAlerts=new Set();
 function readStored(key=KEY){
  try{
   const value=JSON.parse(sessionStorage.getItem(key)||'[]');
   return Array.isArray(value)?value.filter(x=>typeof x==='string').slice(-LIMIT):[];
  }catch{return [];}
 }
 function remember(id,key=KEY,memory=spoken){
  memory.add(id);
  if(memory.size>LIMIT)memory.delete(memory.values().next().value);
  try{
   const ids=readStored(key).filter(x=>x!==id);ids.push(id);
   sessionStorage.setItem(key,JSON.stringify(ids.slice(-LIMIT)));
  }catch{}
 }
 function makeSpeech(phrase){
  const synth=window.speechSynthesis,Utterance=window.SpeechSynthesisUtterance;
  if(!synth||typeof synth.speak!=='function'||typeof Utterance!=='function')return null;
  const speech=new Utterance(phrase);speech.text=phrase;speech.lang='ru-RU';
  const voices=typeof synth.getVoices==='function'?synth.getVoices():[];
  speech.voice=voices.find(v=>v.localService&&/^ru(?:-|$)/i.test(v.lang||''))||voices.find(v=>/^ru(?:-|$)/i.test(v.lang||''))||null;
  return speech;
 }
 function enqueue(speech,finished=()=>{}){
  utterances.add(speech);
  const release=()=>{utterances.delete(speech);finished();};
  speech.onend=release;speech.onerror=release;
  try{window.speechSynthesis.speak(speech);return true;}catch{release();return false;}
 }
 function prompt(payment,options={}){
  try{
   const {cash=false,previousId=null}=options||{};
   const id=payment?.id;
   if(cash===true||typeof id!=='string'||!id||id===previousId||payment.state!=='payment_waiting'||!payment.paymentOperationId||payment.paid||payment.diagnostic?.paymentNotStarted)return false;
   if(spoken.has(id)||readStored().includes(id))return false;
   const speech=makeSpeech(phrasing);if(!speech)return false;
   remember(id);return enqueue(speech);
  }catch{return false;}
 }
 function notify(event,scope){
  try{
   if(!/^[a-f0-9]{24}$/.test(scope||'')||!Object.hasOwn(alertPhrases,event?.kind)||!Number.isSafeInteger(event.id)||event.id<1)return false;
   const key=scope+':'+event.kind+':'+event.id;
   if(announced.has(key)||readStored(ALERT_KEY).includes(key)||activeAlerts.has(event.kind))return false;
   const speech=makeSpeech(alertPhrases[event.kind]);if(!speech)return false;
   remember(key,ALERT_KEY,announced);activeAlerts.add(event.kind);
   return enqueue(speech,()=>activeAlerts.delete(event.kind));
  }catch{return false;}
 }
 window.STARTTerminalVoice={prompt,notify};
})();
