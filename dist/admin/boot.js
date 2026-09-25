'use strict';
// Keep a script/download failure from leaving the station with a blank screen.
(() => {
  const fallback = document.querySelector('#admin-load-error');
  const retry = document.querySelector('#admin-reload');
  if (!fallback || !retry) return;
  retry.addEventListener('click', () => location.reload());
  const showIfBlank = () => {
    const hasScreen = ['workspace', 'login-panel', 'setup-panel'].some(id => {
      const panel = document.getElementById(id);
      return panel && !panel.hidden;
    });
    fallback.hidden = hasScreen;
  };
  window.addEventListener('error', event => {
    const source = event.filename || event.target?.src || '';
    if (source.includes('/admin/')) showIfBlank();
  }, true);
  window.addEventListener('unhandledrejection', showIfBlank);
  const observer = new MutationObserver(showIfBlank);
  for (const id of ['workspace', 'login-panel', 'setup-panel']) {
    const panel = document.getElementById(id);
    if (panel) observer.observe(panel, {attributes: true, attributeFilter: ['hidden']});
  }
  setTimeout(showIfBlank, 12000);
})();
