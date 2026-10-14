import { browserSession } from './browser';
import { createApp } from 'vue';
import 'vue-sonner/style.css';
import App from './App.vue';
import { createWebHashHistory, createWebHistory } from 'vue-router';
import { createWorkbenchRouter, prefetchPages } from './router';
import { warmHighlightWorker } from './lib/markdownHighlightWorker';
import { syncLoaders } from './lib/loaderSync';
import './assets/fonts/fonts.css';
import './styles.css';

// A server with a password shows only the sign-in page until this browser
// signs in.
void browserSession.then(async (session) => {
  if (session?.password_set && !session.signed_in) {
    const { default: SignInPage } = await import('./Pages/SignInPage.vue');
    createApp(SignInPage).mount('#app');
  } else {
    mountWorkbench();
  }
});

syncLoaders();

function mountWorkbench(): void {
  const router = createWorkbenchRouter(window.patterm.runtime === 'desktop' ? createWebHashHistory() : createWebHistory());
  const app = createApp(App).use(router);
  // The manifest's launch_handler reuses the open window instead of starting
  // another, so a launch that names a page (a shortcut) navigates here. A plain
  // relaunch names the start URL and only focuses the window.
  (window as Window & { launchQueue?: { setConsumer(consumer: (params: { targetURL?: string }) => void): void } }).launchQueue?.setConsumer(({ targetURL }) => {
    const url = targetURL ? new URL(targetURL) : null;
    if (url?.origin === location.origin && url.pathname !== '/') void router.push(url.pathname + url.search + url.hash);
  });
  // Once the first page is up, load the other pages, the diff viewer, and the
  // code highlighter, so later navigation doesn't wait for them.
  void router.isReady().then(() => {
    app.mount('#app');
    setTimeout(() => {
      prefetchPages();
      void import('./Components/WorktreeFileDiff.vue');
      void import('./lib/diffHighlighter');
      warmHighlightWorker();
    }, 0);
  });
}
