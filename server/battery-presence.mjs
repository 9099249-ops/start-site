// Anchor monotonic device uptime to server time; never trust device wall-clock time.
export function batteryPresence(previous,body,now){
 const boot=body.bootId,uptime=Number.isFinite(body.uptimeMs)?body.uptimeMs/1000:body.uptimeSeconds;
 const tracked=Number.isFinite(uptime),same=previous.packetBootId===boot;
 if(tracked&&same&&Number.isFinite(previous.packetUptimeSeconds)&&uptime<=previous.packetUptimeSeconds)return null;
 const retired=previous.retiredBootIds||[];
 if(!same&&retired.includes(boot))return null;
 const anchor=tracked?Math.min(same&&Number.isFinite(previous.packetBootAt)?previous.packetBootAt:Infinity,now-uptime*1000):now;
 const observedAt=tracked?Math.min(now,anchor+uptime*1000):now;
 // Delayed packets cannot renew gateway health or create departure evidence.
 if(now-observedAt>10000)return null;
 const connected=body.bmsConnected===true;
 const exactAge=body.bmsDisconnectedAgeMs;
 if(Number.isFinite(exactAge)&&tracked&&exactAge>uptime*1000+999)return null;
 let lostAt=null;
 if(!connected){
  if(Number.isFinite(exactAge)&&exactAge>=0&&(!tracked||exactAge<=uptime*1000))lostAt=observedAt-exactAge;
  else if(same&&previous.bmsConnected===false)lostAt=previous.bmsDisconnectedAt??observedAt;
  else lostAt=observedAt;
  if(same&&previous.bmsConnected===false&&Number.isFinite(previous.bmsDisconnectedAt))lostAt=previous.bmsDisconnectedAt;
 }
 return {packetBootId:boot,packetUptimeSeconds:tracked?uptime:null,packetBootAt:anchor,packetObservedAt:observedAt,
  retiredBootIds:(!same&&previous.packetBootId?[...retired,previous.packetBootId]:retired).slice(-16),
  bmsPresentAt:connected?observedAt:same?previous.bmsPresentAt??null:null,
  bmsDisconnectedAt:lostAt,bmsDisconnectExact:!connected&&Number.isFinite(exactAge)};
}
