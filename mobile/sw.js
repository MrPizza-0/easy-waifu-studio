// Minimal service worker so Chrome offers "Install app" over HTTPS (tailscale serve). Network only.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
