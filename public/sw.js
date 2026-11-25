// VESPER's service worker (v0.18.0): shows the notifications VESPER sends (reminders, the daily briefing, meeting
// alerts) and opens VESPER when one is clicked. Registered by Settings → Notifications only. It caches nothing: the
// app loads from the network exactly as before.

const ICON = "/notification-icon.png";

// A new version takes over at once (there's nothing cached to keep consistent).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** Text from the payload, trimmed and cut to `max` characters ("" when it isn't text). */
function text(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** A link inside VESPER only (another site's address becomes the start page). */
function sameOriginPath(value) {
  try {
    const url = new URL(typeof value === "string" && value ? value : "/", self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search + url.hash : "/";
  } catch {
    return "/";
  }
}

/** The payload `{ title, body, url, tag, kind }`; anything unreadable still shows a plain "VESPER" notification. */
function readPayload(data) {
  if (!data) return {};
  try {
    const value = data.json();
    return value && typeof value === "object" ? value : {};
  } catch {
    try {
      return { body: data.text() };
    } catch {
      return {};
    }
  }
}

self.addEventListener("push", (event) => {
  const payload = readPayload(event.data);
  const tag = text(payload.tag, 120);
  const options = {
    body: text(payload.body, 600),
    icon: ICON,
    badge: ICON,
    data: { url: sameOriginPath(payload.url) },
  };
  if (tag) {
    options.tag = tag;
    // A reminder that replaces an earlier one (same tag) still sounds and shows again.
    if (payload.kind === "reminder") options.renotify = true;
  }
  event.waitUntil(self.registration.showNotification(text(payload.title, 120) || "VESPER", options));
});

/**
 * A click: an open VESPER tab comes to the front and is told what to open (the app listens for "vesper:open", so the
 * tab keeps its state); with none open, a new window opens at the link.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = sameOriginPath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const mine = windows.filter((client) => {
        try {
          return new URL(client.url).origin === self.location.origin;
        } catch {
          return false;
        }
      });
      const client = mine.find((c) => c.focused) || mine.find((c) => c.visibilityState === "visible") || mine[0];
      if (!client) {
        await self.clients.openWindow(url);
        return;
      }
      try {
        await client.focus();
      } catch {
        // focusing isn't allowed here: the message still arrives
      }
      client.postMessage({ type: "vesper:open", url });
    })(),
  );
});
