// Se ejecuta antes de dibujar la página para evitar destellos al cambiar de tema.
(() => {
  let theme = 'dark';
  try { theme = localStorage.getItem('zoe-theme') || 'dark'; } catch (_) {}
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
})();
