/**
 * PWA-Vorbereitung: Das Manifest ist in index.html eingebunden.
 * Registrierung bewusst deaktiviert, solange kein geprüfter Service Worker vorliegt.
 * Ein künftiger Worker darf /api, Sitzungen und private Portfoliodaten nicht cachen.
 */
export function registerServiceWorker(): void {
  const enabled = false;
  if (enabled && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      void navigator.serviceWorker.register('/service-worker.js').catch(() => {
        console.warn('Der Service Worker konnte nicht registriert werden.');
      });
    });
  }
}
