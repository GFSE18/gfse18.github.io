(() => {
  const WORKER_URL = "https://overseer.matthewzhou05.workers.dev";
  const SESSION_KEY = "portfolio_analytics_session";
  const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

  function createSessionId() {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }

    // Fallback for older browsers. This still uses cryptographically secure
    // random values; it is not intended to identify a person.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");

    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20)
    ].join("-");
  }

  function getSessionId() {
    const now = Date.now();

    try {
      const saved = JSON.parse(localStorage.getItem(SESSION_KEY));
      const isActive =
        saved &&
        typeof saved.id === "string" &&
        Number.isFinite(saved.lastActivity) &&
        now - saved.lastActivity >= 0 &&
        now - saved.lastActivity < SESSION_TIMEOUT_MS;

      const id = isActive ? saved.id : createSessionId();
      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ id, lastActivity: now })
      );
      return id;
    } catch {
      // Privacy settings can disable localStorage. Such a page view is still
      // logged, but it cannot be joined reliably to a later navigation.
      return createSessionId();
    }
  }

  fetch(WORKER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      sessionId: getSessionId(),
      page: window.location.pathname,
      referrer: document.referrer
    }),
    keepalive: true
  }).catch(() => {});
})();
