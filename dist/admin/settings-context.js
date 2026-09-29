(()=>{'use strict';
 const section=new URLSearchParams(location.search).get('settings');
 const targets={content:'#content-editor',sms:'#sms-settings',salary:'#salary-form',people:'#person-form',telegram:'#telegram-form',tasks:'#task-create'};
 const titles={content:'Сайт и тарифы',sms:'СМС и напоминания',salary:'Правила зарплаты',people:'Сотрудники и роли',telegram:'Telegram',tasks:'Дела и чек-листы',menu:'Меню кафе',places:'Столы, QR и NFC',settings:'Работа кафе',management:'Управление кафе',inventory:'Товары и остатки',stock:'Расход ингредиентов',accounts:'Учётные записи',print:'Печать и отчёты'};
 if(!titles[section])return;
 document.body.dataset.settingsSection=section;
 const heading=document.querySelector('main h1');if(heading)heading.textContent='Настройки · '+titles[section];
 function expand(){const target=document.querySelector(targets[section]||'#no-settings-target');const fold=target?.matches('details')?target:target?.closest('details')||target?.querySelector('details');if(fold&&!fold.open)fold.open=true;}
 expand();new MutationObserver(expand).observe(document.querySelector('main'),{childList:true,subtree:true});
})();
