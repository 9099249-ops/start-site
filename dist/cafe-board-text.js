(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.CafeBoardText=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){'use strict';
const fields=[
 {key:'brandName',label:'Название',value:'СТАРТ.',max:24,required:true},
 {key:'brandSubtitle',label:'Подпись бренда',value:'Кофе у воды',max:40,required:false},
 {key:'tagline',label:'Слоган',value:'Кофе, который любят в Орешке',max:80,required:false},
 {key:'staffLabel',label:'Подпись сотрудников',value:'Сегодня с вами',max:40,required:false},
 {key:'cookingTitle',label:'Заголовок готовятся',value:'ГОТОВЯТСЯ',max:28,required:true},
 {key:'cookingSubtitle',label:'Подпись готовятся',value:'Ваши заказы в работе',max:80,required:false},
 {key:'readyTitle',label:'Заголовок готовы',value:'ГОТОВЫ К ВЫДАЧЕ',max:28,required:true},
 {key:'readySubtitle',label:'Подпись готовы',value:'Заберите заказ у бара',max:80,required:false},
 {key:'emptyCookingTitle',label:'Пустая колонка готовятся',value:'Что приготовим для вас?',max:80,required:true},
 {key:'emptyCookingHint',label:'Подсказка готовятся',value:'Сделайте заказ на SPOTSUP.RU или у бара.',max:120,required:false},
 {key:'emptyReadyTitle',label:'Пустая колонка готовы',value:'Пока готовим — устраивайтесь поудобнее',max:80,required:true},
 {key:'emptyReadyHint',label:'Подсказка готовых заказов',value:'Здесь появится номер вашего готового заказа.',max:120,required:false},
 {key:'shoreNote',label:'Нижняя подпись слева',value:'Хорошая еда движет вперёд',max:64,required:false},
 {key:'footerNote',label:'Нижняя подпись справа',value:'С заботой о вашем отдыхе',max:64,required:false},
 {key:'siteLabel',label:'Подпись перед адресом сайта',value:'Заказ на',max:24,required:false},
 {key:'readyMessage',label:'Сообщение готового заказа',value:'Ваш заказ готов',max:40,required:true},
 {key:'pickupLabel',label:'Подпись самовывоза',value:'Выдача у бара',max:40,required:true}
];
function resolve(value){const source=value&&typeof value==='object'&&!Array.isArray(value)?value:{};return Object.fromEntries(fields.map(field=>{const candidate=source[field.key];const valid=typeof candidate==='string'&&candidate.length<=field.max&&!/[\x00-\x1f\x7f-\x9f]/.test(candidate)&&(!field.required||candidate.trim().length>0);return [field.key,valid?candidate:field.value];}));}
return {fields,resolve};
});
