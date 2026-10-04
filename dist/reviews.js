(()=>{'use strict';
 const frames=[...document.querySelectorAll('[data-reviews-widget]')];
 function load(frame){if(frame.hasAttribute('src'))return;frame.src=frame.dataset.src;frame.closest('.reviews-widget')?.classList.add('reviews-loaded');}
 if(!('IntersectionObserver' in window)){for(const frame of frames)load(frame);return;}
 const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){load(entry.target);observer.unobserve(entry.target);}},{rootMargin:'300px 0px'});
 for(const frame of frames)observer.observe(frame);
})();
