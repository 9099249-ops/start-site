import './style.css';
import rawMap from './data/map.json';
import rawRoute from './data/routes.json';
import config from './data/config.json';
import type { MapData, RouteData, Phase } from './game/types.ts';
import { Simulation, distance } from './game/Simulation.ts';
import { Controls } from './game/Controls.ts';
import { Renderer } from './game/Renderer.ts';
import { advanceTraffic } from './game/Traffic.ts';
import { GameAudio } from './game/Audio.ts';
import { formatTime, readRecords, saveResult, track } from './game/Score.ts';

const map = rawMap as MapData, route = rawRoute as RouteData;
const icon = (name: string) => {
  const paths: Record<string, string> = {
    arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
    sound: '<path d="M11 4 5 9H2v6h3l6 5V4ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    mute: '<path d="M11 4 5 9H2v6h3l6 5V4Zm5 5 6 6m0-6-6 6"/>',
    expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    flag: '<path d="M5 21V3m0 1c5-4 9 4 15 0v10c-6 4-10-4-15 0"/>',
    pin: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
    paddle: '<path d="m5 19 9-9m0 0c-3-3 2-8 5-6s-2 9-5 6Z"/>',
  };
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.arrow}</svg>`;
};
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="site-header">
    <a class="brand" href="https://spotsup.ru/" aria-label="СТАРТ — главная страница сайта"><svg viewBox="0 0 42 42" aria-hidden="true"><path d="M6 27 21 4l15 23H25l-4-7-4 7Z" fill="currentColor"/><path d="M5 35q8-6 16 0t16 0" fill="none" stroke="currentColor" stroke-width="3"/></svg><span>СТАРТ<small>СТАНЦИЯ ОТДЫХА НА ВОДЕ</small></span></a>
    <div class="header-location">${icon('pin')}<span>Ореховая бухта<small>Пироговское водохранилище</small></span></div>
    <button class="text-button booking" type="button">На настоящий SUP ${icon('arrow')}</button>
  </header>
  <main id="stage" class="stage">
    <canvas id="water" aria-label="Игровая карта Ореховой бухты. Управление: W — грести, A и D — поворот, пробел — ускорение, Escape — пауза."></canvas>
    <div class="vignette"></div>
    <div class="stage-top"><span class="edition"><i></i> ЛЕТО НАЧИНАЕТСЯ ЗДЕСЬ</span><div class="tools"><button id="sound" class="icon-button" aria-label="Выключить звук" aria-pressed="true">${icon('sound')}</button><button id="fullscreen" class="icon-button" aria-label="Полный экран">${icon('expand')}</button><button id="pause" class="icon-button" aria-label="Пауза" hidden>${icon('pause')}</button></div></div>
    <section id="menu" class="menu-card">
      <div class="eyebrow"><span class="tiny-line"></span> ВИРТУАЛЬНАЯ ПРОГУЛКА</div>
      <h1>Прогулка по<br>Ореховой<br><em>бухте.</em></h1>
      <p class="intro">Поймай лето. Почувствуй воду.<br>Попробуй SUP прямо в браузере.</p>
      <div class="route-info"><span class="route-symbol">${icon('flag')}</span><div><b>Вокруг бухты</b><span>5 буёв <i>·</i> 5 звёзд <i>·</i> 1–3 минуты</span></div><span class="route-number">01</span></div>
      <button id="play" class="primary">ИГРАТЬ ${icon('arrow')}</button>
      <div class="records"><div><span>ЛИЧНЫЙ РЕКОРД</span><b id="best">—:—</b></div><div><span>МОЙ РЕКОРД СЕГОДНЯ</span><b id="daily">—:—</b></div></div>
      <button id="help" class="help-link">Как управлять <span>↗</span></button>
    </section>
    <div id="preview-note" class="preview-note"><span class="live-dot"></span><div>Реальная бухта. Твоя маленькая свобода.<small>Береговая линия по данным OpenStreetMap</small></div></div>
    <section id="hud" class="hud" aria-label="Показатели заезда" hidden>
      <div class="timer-block"><span>ВРЕМЯ ЗАЕЗДА</span><strong id="timer">00:00</strong><small id="penalty"></small></div>
      <div class="hud-divider"></div>
      <div class="hud-secondary"><div><span class="gold">★</span> <b id="stars">0</b><span class="dim"> / 5</span></div><div><b id="checkpoint">0</b><span class="dim"> / 5 буёв</span></div></div>
    </section>
    <div id="navigation" class="navigation" hidden><span id="target-name">Выход из бухты</span><b id="distance">0 м</b><div class="energy"><i id="energy"></i></div><small>ЭНЕРГИЯ ГРЕБКА</small></div>
    <div class="minimap-wrap" id="mini-wrap"><div class="mini-title"><span>АКВАТОРИЯ</span><span>С ↑</span></div><canvas id="minimap" width="280" height="274" aria-label="Мини-карта: маршрут, буи и ваше положение"></canvas><div class="mini-caption"><i></i> Ореховая бухта</div></div>
    <div id="desktop-hint" class="desktop-hint" hidden><span><kbd>W</kbd> грести</span><span><kbd>A</kbd><kbd>D</kbd> поворот</span><span><kbd>пробел</kbd> усиленный гребок</span></div>
    <div id="touch-controls" class="touch-controls" hidden><div class="stick-wrap"><div id="joystick" class="joystick" aria-label="Джойстик направления"><span>↑</span><i></i></div><small>НАПРАВЛЕНИЕ</small></div><div class="paddle-wrap"><button id="paddle" class="paddle" aria-label="Удерживайте, чтобы грести">${icon('paddle')}<b>ГРЕСТИ</b></button><small>УДЕРЖИВАЙ</small></div></div>
    <div id="toast" class="toast" role="status" aria-live="polite"></div>
    <div id="pause-screen" class="scrim" hidden><section class="dialog compact"><div class="eyebrow">МОЖНО ВЫДОХНУТЬ</div><h2>Пауза на воде</h2><p>Таймер остановлен.<br>Бухта никуда не торопится.</p><button id="resume" class="primary">ПРОДОЛЖИТЬ ${icon('arrow')}</button><button id="back-menu" class="secondary">Вернуться на берег</button></section></div>
    <div id="result-screen" class="scrim" hidden><section class="dialog result"><div class="eyebrow">МАРШРУТ ПРОЙДЕН</div><div class="result-mark">⚑</div><h2>С возвращением!</h2><p id="record-message">Ещё одна маленькая история на воде.</p><div class="finish-stats"><div><span>ВРЕМЯ</span><b id="finish-time"></b></div><div><span>ЗВЁЗДЫ</span><b id="finish-stars" class="gold"></b></div><div><span>СТОЛКНОВЕНИЯ</span><b id="finish-collisions"></b></div></div><p class="finish-best">Лучший результат: <b id="finish-best"></b><span id="storage-note"></span></p><button id="replay" class="primary">ЕЩЁ РАЗ ${icon('arrow')}</button><div class="finish-cta"><p>Хочешь попробовать по-настоящему?</p><button class="secondary booking">Забронировать SUP ${icon('arrow')}</button></div><button id="share" class="help-link">Поделиться результатом ↗</button></section></div>
    <div id="portrait" class="portrait"><span>↻</span><h2>Поверните телефон<br>горизонтально для игры.</h2><p>Так видно больше воды и удобнее грести.</p></div>
    <div class="map-credit"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>${map.station.approximate ? '<span>Точка станции предварительная</span>' : ''}</div>
  </main>
  <footer><p>Станция «СТАРТ» · SUP-прогулки в Ореховой бухте</p><button id="about" class="footer-link">О карте и маршруте ↗</button><span>ЧУТЬ БЛИЖЕ К ЛЕТУ</span></footer>
  <dialog id="info-dialog"><button class="close-dialog" aria-label="Закрыть">×</button><div id="info-content"></div></dialog>
`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (id: string, value: boolean) => { $(id).hidden = !value; };
let phase: Phase = 'menu';
let sim = new Simulation(map, route);
const renderer = new Renderer($<HTMLCanvasElement>('water'), $<HTMLCanvasElement>('minimap'), map, route);
const audio = new GameAudio();
const controls = new Controls($('joystick'), $('paddle'), () => { if (phase === 'playing') pause(); else if (phase === 'paused') resume(); }, () => phase === 'playing');
let toastUntil = 0, accumulator = 0;
function toast(message: string, seconds = 2.5) { $('toast').textContent = message; $('toast').classList.add('visible'); toastUntil = performance.now() + seconds * 1000; }
function records() { const r = readRecords(); $('best').textContent = formatTime(r.best); $('daily').textContent = formatTime(r.daily); }
function setPhase(next: Phase) {
  phase = next; controls.clear(); accumulator = 0;
  $('stage').dataset.phase = phase;
  show('menu', next === 'menu'); show('preview-note', next === 'menu');
  show('hud', next !== 'menu'); show('navigation', next === 'playing');
  show('pause', next === 'playing'); show('desktop-hint', next === 'playing'); show('touch-controls', next === 'playing');
  show('pause-screen', next === 'paused'); show('result-screen', next === 'finished');
  $('stage').classList.toggle('in-game', next === 'playing' || next === 'paused');
  audio.setActive(next === 'playing');
}
function start(replay = false) {
  void audio.unlock(); sim = new Simulation(map, route); lastZone = ''; renderer.reset(); setPhase('playing');
  (document.activeElement as HTMLElement)?.blur();
  if (replay) track('replay'); track('game_start', { route: route.id });
  toast('Пройди 5 буёв по порядку. Звёзды — по пути!');
  updateHUD(); if (isPortrait()) pause();
}
function pause() { if (phase !== 'playing') return; setPhase('paused'); $('resume').focus(); }
function resume() { if (phase !== 'paused' || isPortrait()) return; setPhase('playing'); (document.activeElement as HTMLElement)?.blur(); void audio.unlock(); }
function isPortrait() { return matchMedia('(max-width: 760px) and (orientation: portrait)').matches; }
function finish() {
  const saved = saveResult(sim.time, sim.stars.size); setPhase('finished');
  $('finish-time').textContent = formatTime(sim.time); $('finish-stars').textContent = `${sim.stars.size}/5`;
  $('finish-collisions').textContent = String(sim.collisions); $('finish-best').textContent = formatTime(saved.records.best);
  $('record-message').textContent = saved.newBest ? 'Новый личный рекорд. Вот это прогулка!' : 'Ещё одна маленькая история на воде.';
  $('storage-note').textContent = saved.saved ? '' : ' · Браузер не разрешил сохранить рекорд';
  records(); $('replay').focus();
}
function updateHUD() {
  $('timer').textContent = formatTime(sim.time); $('stars').textContent = `${sim.stars.size}`;
  $('checkpoint').textContent = `${sim.next}`; $('penalty').textContent = sim.penalty ? `включая +${sim.penalty} с штрафа` : '';
  $('target-name').textContent = sim.target.name;
  $('distance').textContent = `${Math.round(distance(sim.player, sim.target) * map.metersPerUnit)} м`;
  $('energy').style.width = `${sim.energy * 100}%`;
}
function info(html: string) { if (phase === 'playing') pause(); $('info-content').innerHTML = html; $<HTMLDialogElement>('info-dialog').showModal(); }
$('play').onclick = () => start(); $('replay').onclick = () => start(true);
$('pause').onclick = pause; $('resume').onclick = resume;
$('back-menu').onclick = () => { sim = new Simulation(map, route); renderer.reset(); setPhase('menu'); records(); $('play').focus(); };
$('sound').onclick = () => { audio.toggle(); void audio.unlock(); $('sound').innerHTML = icon(audio.enabled ? 'sound' : 'mute'); $('sound').setAttribute('aria-label', audio.enabled ? 'Выключить звук' : 'Включить звук'); $('sound').setAttribute('aria-pressed', String(audio.enabled)); };
$('fullscreen').onclick = async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('stage').requestFullscreen(); }
  catch { toast('Полный экран недоступен в этом браузере'); }
};
$('help').onclick = () => info(`<div class="eyebrow">ПЕРВЫЙ РАЗ НА SUP?</div><h2>Всё начинается<br>с одного гребка.</h2><p><b>На компьютере:</b> удерживай W или ↑, чтобы грести. A/D или ←/→ плавно поворачивают доску. Пробел — усиленный гребок. Esc или P — пауза.</p><p><b>На телефоне:</b> джойстиком слева укажи направление и удерживай «Грести» справа. Поверни телефон горизонтально.</p><p>Пройди все пять светящихся буёв по порядку. Звёзды можно собирать в любом порядке. Обходи катер, других сапбордистов и красные буи. Столкновение добавляет 2 секунды; таймер не ограничен. На светлой воде скорость ниже.</p>`);
$('about').onclick = () => info(`<div class="eyebrow">ЗНАКОМАЯ АКВАТОРИЯ</div><h2>Настоящие берега.<br>Игровая прогулка.</h2><p>Береговая линия Пироговского водохранилища и пирсы импортированы из <a href="${map.source.url}" target="_blank" rel="noopener">OpenStreetMap</a> (${map.source.retrieved}). Данные © OpenStreetMap contributors, <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">ODbL 1.0</a>.</p><p>Станция «СТАРТ» отмечена по <a href="${map.station.sourceUrl}" target="_blank" rel="noopener">точке, предоставленной владельцем</a>: ${map.station.latitude}, ${map.station.longitude}. Игровой старт расположен рядом на воде. Маршрут, буи, препятствия, мели и запретные зоны — игровые. Для реального выхода на воду этот маршрут не предназначен.</p><p>Рекорды хранятся только в этом браузере. «Мой рекорд сегодня» — личный результат за текущий день, а не общая таблица игроков.</p>`);
document.querySelector<HTMLButtonElement>('.close-dialog')!.onclick = () => $<HTMLDialogElement>('info-dialog').close();
document.querySelectorAll<HTMLButtonElement>('.booking').forEach(button => button.onclick = () => {
  track('booking_click');
  if (!config.bookingConfigured) { info('<div class="eyebrow">СТАНЦИЯ «СТАРТ»</div><h2>Встретимся<br>на воде.</h2><p>Ссылка бронирования ещё не подключена. Она появится здесь после настройки страницы станции.</p>'); return; }
  const url = new URL(config.bookingUrl, location.href);
  if (['https:', 'http:'].includes(url.protocol)) location.assign(url.href);
});
$('share').onclick = async () => {
  const text = `Прошёл SUP-маршрут в Ореховой бухте за ${formatTime(sim.time)}! Звёзды: ${sim.stars.size}/5. СТАРТ — попробуй тоже.`;
  try {
    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    if (navigator.share) await navigator.share({ title: 'SUP-прогулка · СТАРТ', text, ...(local ? {} : { url: location.href }) });
    else { await navigator.clipboard.writeText(text + (local ? '' : ` ${location.href}`)); toast('Результат скопирован'); }
  } catch (e) { if ((e as Error).name !== 'AbortError') info(`<h2>Твой результат</h2><p>${text}</p><p>Выдели и скопируй этот текст, чтобы поделиться.</p>`); }
};
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
addEventListener('blur', pause);
addEventListener('resize', () => { if (isPortrait()) pause(); });

let last = performance.now(), lastHUD = 0, lastStroke = 0, lastZone = '';
function frame(now: number) {
  const dt = Math.min((now - last) / 1000, .1); last = now;
  const input = controls.read();
  if (phase === 'menu') advanceTraffic(sim.traffic, dt);
  if (phase === 'playing') {
    accumulator += dt;
    while (accumulator >= 1 / 60 && phase === 'playing') {
      sim.step(1 / 60, input); accumulator -= 1 / 60;
      for (const event of sim.events) {
        audio.sound(event.type);
        if (event.type === 'collision') { toast(event.obstacle === 'boat' ? 'Столкновение с катером · +2 секунды' : event.obstacle === 'sup' ? 'Столкновение с другим SUP · +2 секунды' : 'Мягче у берега · +2 секунды'); renderer.burst(sim.player, '#eaf8ed'); }
        else if (event.type === 'star_collected') { track(event.type, { index: event.index }); renderer.burst(sim.player, '#ffe18b'); toast(`Звезда твоя! ${sim.stars.size} из 5`, 1.5); }
        else if (event.type === 'checkpoint') { track(event.type, { index: event.index }); renderer.burst(sim.player, '#d6f69c'); toast(`Буй ${sim.next} из 5 пройден`, 1.8); }
        else { track(event.type, { time: sim.time, stars: sim.stars.size, collisions: sim.collisions }); finish(); }
      }
    }
    if (sim.zone !== lastZone && sim.zone) toast(sim.zone); lastZone = sim.zone;
    if (input.thrust && now - lastStroke > 750) { audio.sound('paddle'); lastStroke = now; }
  }
  if (now - lastHUD > 100) { updateHUD(); lastHUD = now; }
  if (now > toastUntil) $('toast').classList.remove('visible');
  renderer.draw(sim, now / 1000, dt, phase === 'menu', phase === 'playing' && input.thrust);
  requestAnimationFrame(frame);
}
records(); setPhase('menu'); track('game_open'); requestAnimationFrame(frame);
