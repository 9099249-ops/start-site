import {shoreBlock} from './shore.mjs';
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const brandImage='<img class="site-logo" src="/assets/start-logo-horizontal.webp" width="400" height="100" alt="СТАРТ — станция проката">';
export const headerBrandImage='<picture><source media="(prefers-reduced-motion: reduce)" srcset="/assets/start-logo-static-v1.svg"><img class="site-logo" src="/assets/start-logo-animated-v1.svg" width="894" height="254" alt="СТАРТ — станция проката"></picture>';
export const brandHead='<link rel="stylesheet" href="/fleet-photos.css"><script defer src="/fleet-photos.js"></script><link rel="icon" href="/assets/start-favicon-v2-32.png" type="image/png" sizes="32x32"><link rel="icon" href="/assets/start-favicon-v2-192.png" type="image/png" sizes="192x192"><link rel="apple-touch-icon" href="/assets/start-favicon-v2-180.png"><link rel="stylesheet" href="/site-brand.css">';
export function withSiteChrome(html,d,home=false){
 const phone=esc(d.phone),tel=esc(d.phone.replace(/[^+\d]/g,''));
 const nav=[['/#fleet','Прокат и цены'],['/#routes','Маршруты'],['/storage/','Хранение САПов'],['/#events','Афиша'],['/cafe/','Кафе'],['/#contacts','Контакты'],['/game/','SUP-игра']].map(([href,label])=>`<a href="${href}">${label}</a>`).join('');
 const header=`<header class="header site-header"><div class="wrap nav-wrap"><a class="brand site-brand" href="/" aria-label="СТАРТ, на главную">${headerBrandImage}</a><nav id="navigation" aria-label="Основная навигация">${nav}</nav><a class="header-phone" href="tel:${tel}">${phone}</a>${home?'<button class="button small" data-book>Забронировать</button>':'<a class="button small" href="/#fleet">Забронировать</a>'}<button id="menu-toggle" class="menu-toggle" aria-expanded="false" aria-controls="navigation" aria-label="Открыть меню">☰</button></div></header>`;
 const footer=`<footer class="site-footer"><div class="site-footer-inner"><a class="brand site-brand" href="/" aria-label="СТАРТ, на главную">${brandImage}</a><div><strong>Больше, чем вода.</strong><p>${esc(d.texts.address.value).replace(/\n/g,'<br>')}</p><a href="tel:${tel}">${phone}</a></div><nav aria-label="Ссылки в подвале"><a href="/#fleet">Прокат и цены</a><a href="/storage/">Хранение САПов</a><a href="/#certificates">Подарочные сертификаты</a><a href="/#faq">Правила проката</a><a href="/#contacts">Контакты</a></nav><div class="site-socials"><a href="https://t.me/STARTpirogovo" target="_blank" rel="noopener">Telegram-канал ↗</a><a href="https://www.instagram.com/stancijstart/" target="_blank" rel="noopener">Instagram ↗</a><span>© СТАРТ, ${new Date().getUTCFullYear()}</span></div></div></footer>`;
 html=html.replace(/<header\b[^>]*>[\s\S]*?<\/header>/,()=>header).replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/,()=>footer);
 html=html.replace(/<link\b[^>]*rel="(?:icon|shortcut icon|apple-touch-icon)"[^>]*>/g,'');
 html=html.replace('</head>',brandHead+(home?'':'<script defer src="/site-shell.js"></script>')+'</head>');
 if(!home)html=html.replace('<body>','<body class="site-inner"><div class="topline"><div class="wrap"><span>Пироговское водохранилище · яхт-клуб «Ореховая бухта»</span><span>Сезон: 1 апреля — 1 ноября <b>'+esc(d.open)+'–'+esc(d.close)+'</b></span></div></div>');
 html=html.replace(/\d+ категорий для вашего отдыха\./,d.inventory.length+' категорий для вашего отдыха.');
 html=html.replace(/<details class="more-fleet">\s*<summary>[\s\S]*?<\/summary>([\s\S]*?)<\/details>/, '<div class="more-fleet" aria-label="Другие категории техники">$1</div>');
 if(home)html=html.replace(/<section\b[^>]*id="about"[^>]*>[\s\S]*?<\/section>/,()=>shoreBlock(d)).replace('</head>','<link rel="stylesheet" href="/shore-routes.css?v=5"></head>');
 html=html.replace(/src="\/?app\.js(?:\?[^"]*)?"/, 'src="/app.js?v=seo-reviews-1"');
 return html.replace('href="/services.css"','href="/services-unified.css"');
}

