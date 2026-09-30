import {createHash} from 'node:crypto';

// Store transport metadata, never request bodies, receipts or bank slip contents.
const states=new Set(['Pending','Processing','Finishing','Completed','Canceled','Error','Timeout']);
const codes=new Set(['ETIMEDOUT','ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
function safeText(value,secret){
 if(typeof value!=='string')return undefined;
 let s=value;
 if(secret)s=s.split(secret).join('[скрыто]');
 return s.slice(0,2000).replace(/(?:Application|Bearer|Basic)\s+[^\s,;]+/gi,'[скрыто]')
 .replace(/(?:api[-_ ]?key|token|password|authorization)\s*[:=]\s*[^\s,;]+/gi,'[скрыто]')
 .replace(/https?:\/\/[^\s]+/gi,'[адрес]')
 .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[почта]')
 .replace(/[a-f\d]{24,}|[a-z\d_+\/-]{32,}={0,2}/gi,'[идентификатор]')
 .replace(/\+?\d[\d ()-]{5,}\d/g,'[номер]')
 .replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,400);
}
export function providerDiagnostic(data,secret){
 return {providerReason:safeText(data?.reason,secret),providerMessage:safeText(data?.message,secret),providerProblems:safeText(data?.problems,secret)};
}
export function transportDiagnostic(error){
 const code=error?.cause?.code||error?.code;
 return {kind:['TimeoutError','AbortError'].includes(error?.name)?'timeout':'network',...(codes.has(code)?{networkCode:code}:{})};
}
function message(d){
 const target=d.phase==='receipt'?'фискального чека':'оплаты';
 if(d.kind==='restart')return 'Сайт перезапустился во время передачи '+target+'. Результат неизвестен — требуется сверка с кассой.';
 if(d.kind==='configuration')return 'Настройки подключения aQsi изменились. Проверьте подключение кассы.';
 if(d.kind==='timeout')return 'Сервер не дождался ответа aQsi. Результат '+target+' неизвестен — проверьте кассу.';
 if(d.kind==='network')return 'Соединение сервера с aQsi прервалось. Результат '+target+' пока не подтверждён.';
 if(d.kind==='http'){
  const n=d.httpStatus;
  if(n===401||n===403)return 'aQsi отклонил доступ (HTTP '+n+'). Администратору нужно проверить ключ и права на кассу.';
  if(n===429)return 'aQsi ограничил частоту запросов (HTTP 429). Повторное списание автоматически не запускается.';
  if(n>=500)return 'Ошибка сервиса aQsi (HTTP '+n+'). Результат '+target+' нужно сверить с кассой.';
  return 'aQsi вернул ошибку HTTP '+n+'. Причина сохранена в журнале; проверьте результат на кассе.';
 }
 if(d.kind==='invalid_json')return 'aQsi вернул ответ, который не удалось прочитать. Результат '+target+' не подтверждён.';
 if(d.kind==='missing_operation')return 'aQsi не вернул номер операции. Результат '+target+' неизвестен — требуется сверка.';
 if(d.kind==='invalid_result')return 'Ответ aQsi не подтвердил результат '+target+'. Требуется сверка с кассой.';
 if(d.operationStatus==='Timeout')return 'aQsi сообщил: время ожидания '+target+' истекло. Это не подтверждает отмену — проверьте историю CS50.';
 if(d.operationStatus==='Error')return 'aQsi сообщил об ошибке '+target+'. Проверьте историю CS50 перед повторной оплатой.';
 if(d.operationStatus==='Canceled')return 'Касса подтвердила отмену операции.';
 if(d.operationStatus==='Completed')return 'aQsi сообщил о завершении операции; проверяем результат.';
 return 'Запрос принят aQsi. Ожидаем подтверждение кассы.';
}
export class AqsiDiagnostics {
 constructor(db,scope){this.db=db;this.scope=scope;db.exec(`CREATE TABLE IF NOT EXISTS aqsi_diagnostic_events(id INTEGER PRIMARY KEY,scope TEXT NOT NULL,payment_id TEXT NOT NULL,phase TEXT NOT NULL,event_json TEXT NOT NULL,fingerprint TEXT NOT NULL,created_at INTEGER NOT NULL,seen_at INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS aqsi_diagnostic_payment ON aqsi_diagnostic_events(scope,payment_id,id DESC);`);}
 record(paymentId,phase,data){
  const event={...data,phase};if(event.operationStatus&&!states.has(event.operationStatus))event.operationStatus='Unknown';
  if(!Number.isInteger(event.httpStatus))delete event.httpStatus;
  event.message=message(event);const json=JSON.stringify(event),fingerprint=createHash('sha256').update(json).digest('hex'),now=Date.now();
  const last=this.db.prepare('SELECT id,fingerprint,seen_at FROM aqsi_diagnostic_events WHERE scope=? AND payment_id=? ORDER BY id DESC LIMIT 1').get(this.scope,paymentId);
  if(last?.fingerprint===fingerprint){if(now-last.seen_at>=60000)this.db.prepare('UPDATE aqsi_diagnostic_events SET seen_at=? WHERE id=?').run(now,last.id);return;}
  this.db.prepare('INSERT INTO aqsi_diagnostic_events(scope,payment_id,phase,event_json,fingerprint,created_at,seen_at) VALUES(?,?,?,?,?,?,?)').run(this.scope,paymentId,phase,json,fingerprint,now,now);
  this.db.prepare('DELETE FROM aqsi_diagnostic_events WHERE scope=? AND id NOT IN (SELECT id FROM aqsi_diagnostic_events WHERE scope=? ORDER BY id DESC LIMIT 5000)').run(this.scope,this.scope);
 }
 latest(paymentId){const row=this.db.prepare('SELECT event_json,seen_at FROM aqsi_diagnostic_events WHERE scope=? AND payment_id=? ORDER BY id DESC LIMIT 1').get(this.scope,paymentId);if(!row)return null;const d=JSON.parse(row.event_json);return {message:d.message,checkedAt:row.seen_at,phase:d.phase,...(d.httpStatus?{httpStatus:d.httpStatus}:{}),...(d.operationStatus?{operationStatus:d.operationStatus}:{})};}
}
