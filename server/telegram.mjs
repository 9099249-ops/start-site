const labels = {sup:'САПборд',catamaran:'Электрокатамаран',boat:'Катер без капитана',captain:'Катер с капитаном',kayak:'Каяк одноместный',kayak2:'Каяк двухместный',kayak3:'Каяк трёхместный',big:'Big SUP',electric:'ЭлектроСАП',bike:'ВелоСАП',rowing:'Вёсельная лодка',glow:'Светящийся САП'};
const plans = {hour:'Почасовой прокат',day:'Безлимит на день',season:'Именной абонемент на сезон',takeaway:'САП с собой'};
export function bookingText(b, now = new Date(), schedule={open:"09:00",close:"22:00"}) {
  const open=schedule?.open||'09:00',close=schedule?.close||'22:00';const minutes=t=>Number(t.slice(0,2))*60+Number(t.slice(3));
  const clean = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\r\n\x00-\x1f]/.test(v);
  if (!b || !Object.hasOwn(labels,b.equipment) || !Object.hasOwn(plans,b.plan) || !clean(b.name,80) || !clean(b.phone,32) || !/^[+\d ()-]+$/.test(b.phone) || !/^\d{10,15}$/.test(b.phone.replace(/\D/g,''))) throw new Error('invalid');
  if (b.plan !== 'hour' && b.equipment !== 'sup') throw new Error('invalid');
  const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const validDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0,10) === d && d >= today && d.slice(5) >= '04-01' && d.slice(5) <= '11-01';
  if (b.plan !== 'season' && (!validDate(b.date) || (!/^(0\d|1\d|2[0-3]):(00|30)$/.test(b.time)||b.time<open||b.time>=close))) throw new Error('invalid');
  if (!Number.isInteger(b.quantity) || b.quantity < 1 || b.quantity > 20 || (b.plan === 'season' && b.quantity !== 1)) throw new Error('invalid');
  if (b.plan === 'hour' && (![1,2,3].includes(b.duration) || minutes(b.time)+b.duration*60>minutes(close))) throw new Error('invalid');
  if (b.plan === 'takeaway' && (!validDate(b.returnDate) || b.returnDate < b.date || b.returnDate.slice(0,4) !== b.date.slice(0,4))) throw new Error('invalid');
  const lines = ['Новая заявка с сайта СТАРТ',`Техника: ${labels[b.equipment]}`,`Тариф: ${plans[b.plan]}`];
  if (b.plan !== 'season') lines.push(`Дата: ${b.date}`,`Время: ${b.time} (Москва)`);
  if (b.plan === 'hour') lines.push(`Длительность: ${b.duration} ч`);
  if (b.plan === 'takeaway') lines.push(`Возврат: ${b.returnDate}`);
  lines.push(`Количество${b.equipment==='big'?' человек':''}: ${b.quantity}`,`Имя: ${b.name.trim()}`,`Телефон: ${b.phone.trim()}`,'Без предоплаты. Требуется подтверждение сотрудника.');
  return lines.join('\n');
}

export async function sendBooking(text, env, request = fetch) {
  if (!env.TELEGRAM_BOT_TOKEN || !/^\d+$/.test(env.TELEGRAM_CHAT_ID || '')) throw new Error('not_configured');
  // Never return Telegram responses, URLs containing tokens, or customer data to logs.
  try {
    const response = await request(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text,protect_content:true,link_preview_options:{is_disabled:true}}),signal:AbortSignal.timeout(10000)});
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error();
  } catch { throw new Error('delivery_unconfirmed'); }
}
