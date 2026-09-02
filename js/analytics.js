(() => {
  const WORKER_URL = "https://overseer.matthewzhou05.workers.dev";
  const SESSION_KEY = "portfolio_analytics_session";
  const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
  const ENGAGEMENT_FLUSH_MS = 15 * 1000;

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

  function getDeviceType() {
    const userAgent = navigator.userAgent;
    const isIPad =
      /iPad/i.test(userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isTablet =
      isIPad ||
      /Tablet|PlayBook|Silk/i.test(userAgent) ||
      (/Android/i.test(userAgent) && !/Mobile/i.test(userAgent));

    if (isTablet) return "tablet";
    if (/Mobi|Android|iPhone|iPod/i.test(userAgent)) return "mobile";
    return "desktop";
  }

  function sendEvent(payload) {
    return fetch(WORKER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(() => {});
  }

  function currentScrollDepth() {
    const root = document.documentElement;
    const pageHeight = Math.max(root.scrollHeight, document.body?.scrollHeight || 0);
    if (pageHeight <= window.innerHeight) return 100;

    return Math.min(
      100,
      Math.max(0, Math.round(((window.scrollY + window.innerHeight) / pageHeight) * 100))
    );
  }

  function classifyTrackedLink(link) {
    const href = link.getAttribute("href") || "";
    const text = (link.textContent || "").trim().toLowerCase();

    if (/\.pdf(?:$|[?#])/i.test(href) && /resume/i.test(href + " " + text)) {
      return "resume_open";
    }
    if (/^mailto:/i.test(href)) return "email_click";
    if (/github\.com/i.test(href)) return "github_click";
    return null;
  }

  const sessionId = getSessionId();
  const page = window.location.pathname;
  let activeStartedAt = null;
  let unsentActiveSeconds = 0;
  let maxScrollDepth = currentScrollDepth();
  let lastSentScrollDepth = -1;

  sendEvent({
    eventType: "pageview",
    sessionId,
    page,
    referrer: document.referrer,
    deviceType: getDeviceType()
  });

  function isActivelyViewing() {
    return document.visibilityState === "visible" && document.hasFocus();
  }

  function startActiveTimer() {
    if (activeStartedAt === null && isActivelyViewing()) {
      activeStartedAt = performance.now();
    }
  }

  function stopActiveTimer() {
    if (activeStartedAt !== null) {
      unsentActiveSeconds += (performance.now() - activeStartedAt) / 1000;
      activeStartedAt = null;
    }
  }

  function flushEngagement() {
    stopActiveTimer();
    const activeSeconds = Math.round(unsentActiveSeconds * 10) / 10;
    const scrollDepth = maxScrollDepth;
    const hasUpdate = activeSeconds > 0 || scrollDepth > lastSentScrollDepth;

    if (hasUpdate) {
      unsentActiveSeconds = 0;
      lastSentScrollDepth = scrollDepth;
      sendEvent({
        eventType: "engagement",
        sessionId,
        page,
        activeSeconds,
        scrollDepth
      });
    }

    startActiveTimer();
  }

  document.addEventListener(
    "click",
    (event) => {
      const link = event.target.closest?.("a[href]");
      if (!link) return;

      const action = classifyTrackedLink(link);
      if (!action) return;

      sendEvent({
        eventType: "action",
        sessionId,
        page,
        action,
        target: link.getAttribute("href") || ""
      });
    },
    true
  );

  window.addEventListener("scroll", () => {
    maxScrollDepth = Math.max(maxScrollDepth, currentScrollDepth());
  }, { passive: true });
  window.addEventListener("focus", startActiveTimer);
  window.addEventListener("blur", flushEngagement);
  document.addEventListener("visibilitychange", flushEngagement);
  window.addEventListener("pagehide", flushEngagement);

  startActiveTimer();
  setInterval(flushEngagement, ENGAGEMENT_FLUSH_MS);
})();
