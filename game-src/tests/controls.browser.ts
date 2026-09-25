import { Controls } from '../src/game/Controls';
const stick = document.getElementById('stick')!, paddle = document.getElementById('paddle')!;
// Native capture requires real hardware pointers; fixture tracks capture locally.
for (const el of [stick,paddle]) {
  const captures = new Set<number>();
  el.setPointerCapture = id => { captures.add(id); };
  el.hasPointerCapture = id => captures.has(id);
  el.releasePointerCapture = id => { captures.delete(id); };
}
let pauses = 0; const c = new Controls(stick,paddle,()=>pauses++,()=>true);
const rows:string[]=[];
const check=(name:string,ok:boolean)=>{rows.push(`${ok?'PASS':'FAIL'} ${name}`); if(!ok)throw new Error(name);};
function pointer(el:HTMLElement,type:string,id:number,x=0,y=0) { el.dispatchEvent(new PointerEvent(type,{pointerId:id,clientX:x,clientY:y,bubbles:true})); }
try {
  const b=stick.getBoundingClientRect();
  pointer(stick,'pointerdown',11,b.left+85,b.top+50); pointer(paddle,'pointerdown',22);
  check('Two simultaneous pointers: heading + paddle',c.read().thrust && c.read().heading===0);
  pointer(stick,'pointercancel',11); check('Cancelled joystick clears heading, keeps paddle',c.read().heading===null && c.read().thrust);
  pointer(paddle,'lostpointercapture',22); check('Lost capture releases paddle',!c.read().thrust);
  pointer(paddle,'pointerdown',33); c.clear(); pointer(paddle,'pointerdown',44);
  check('New pointer works after pause/blur',c.read().thrust); c.clear();
  dispatchEvent(new KeyboardEvent('keydown',{code:'KeyW'})); check('Keyboard W paddles',c.read().thrust);
  dispatchEvent(new KeyboardEvent('keyup',{code:'KeyW'})); check('Keyup stops paddling',!c.read().thrust);
  dispatchEvent(new KeyboardEvent('keydown',{code:'Space'})); check('Space gives powered stroke',c.read().boost&&c.read().thrust);
  dispatchEvent(new Event('blur')); check('Blur clears keys and pointers',!c.read().thrust&&c.read().heading===null);
  paddle.dispatchEvent(new KeyboardEvent('keydown',{code:'Escape',bubbles:true})); check('Escape pauses even with focused button',pauses===1);
} catch(e) { rows.push(String(e)); }
document.getElementById('report')!.textContent=rows.join('\n');
