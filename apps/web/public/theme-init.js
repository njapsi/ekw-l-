// Anti-FOUC theme init, loaded render-blocking from <head> (see
// `packages/ui/src/theme.tsx`'s `ThemeScript`). Keep the storage key in sync
// with `STORAGE_KEY` there — there is no build step linking the two.
(function () {
  try {
    var t = localStorage.getItem('growth-agent-theme');
    if (t === 'light' || t === 'dark') {
      document.documentElement.setAttribute('data-theme', t);
      if (t === 'dark') document.documentElement.classList.add('dark');
    }
  } catch (e) {
    /* localStorage unavailable — system preference (already in the CSS media query) stands */
  }
})();
