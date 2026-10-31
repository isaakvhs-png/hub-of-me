/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface HubDesktop {
  onStartDictation: (cb: () => void) => () => void;
  notify: (title: string, body: string) => void;
}

interface Window {
  hubDesktop?: HubDesktop;
}
