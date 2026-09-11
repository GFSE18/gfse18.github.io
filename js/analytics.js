(() => {
  const WORKER_URL = "https://overseer.matthewzhou05.workers.dev";
  const SESSION_KEY = "portfolio_analytics_session";
  const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
  const ENGAGEMENT_FLUSH_MS = 15 * 1000;
  const SCROLL_BURST_GAP_MS = 700;
  const INPUT_SCROLL_WINDOW_MS = 500;
  const MAX_TRAJECTORY_POINTS = 24;

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
  let lastSentScrollEvents = -1;
  const pageStartedAt = performance.now();
  let lastScrollAt = null;
  let lastScrollY = window.scrollY;
  let lastScrollDirection = 0;
  let lastInputAt = -Infinity;
  let lastPointerMoveAt = -Infinity;
  const scrollProfile = {
    events: 0,
    bursts: 0,
    directionChanges: 0,
    distancePx: 0,
    intervals: [],
    velocities: [],
    pauses500Ms: 0,
    pauses2000Ms: 0,
    wheelEvents: 0,
    touchEvents: 0,
    keyScrollEvents: 0,
    pointerMoves: 0,
    pointerClicks: 0,
    inputLinkedScrolls: 0,
    trajectory: [[0, maxScrollDepth]]
  };

  function average(values) {
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function standardDeviation(values) {
    if (values.length < 2) return 0;
    const mean = average(values);
    return Math.sqrt(
      average(values.map((value) => (value - mean) ** 2))
    );
  }

  function rememberTrajectory(now, depth) {
    const point = [
      Math.round(now - pageStartedAt),
      Math.round(depth)
    ];
    const lastPoint = scrollProfile.trajectory[scrollProfile.trajectory.length - 1];
    if (lastPoint && point[0] - lastPoint[0] < SCROLL_BURST_GAP_MS) {
      scrollProfile.trajectory[scrollProfile.trajectory.length - 1] = point;
    } else {
      scrollProfile.trajectory.push(point);
      if (scrollProfile.trajectory.length > MAX_TRAJECTORY_POINTS) {
        scrollProfile.trajectory.shift();
      }
    }
  }

  function snapshotScrollProfile() {
    const averageIntervalMs = average(scrollProfile.intervals);
    const averageVelocity = average(scrollProfile.velocities);

    return {
      events: scrollProfile.events,
      bursts: scrollProfile.bursts,
      directionChanges: scrollProfile.directionChanges,
      distancePx: Math.round(scrollProfile.distancePx),
      avgIntervalMs: Math.round(averageIntervalMs),
      intervalStdDevMs: Math.round(standardDeviation(scrollProfile.intervals)),
      avgVelocityPxPerSecond: Math.round(averageVelocity),
      velocityVariation: averageVelocity
        ? Math.round((standardDeviation(scrollProfile.velocities) / averageVelocity) * 100) / 100
        : 0,
      pauses500Ms: scrollProfile.pauses500Ms,
      pauses2000Ms: scrollProfile.pauses2000Ms,
      wheelEvents: scrollProfile.wheelEvents,
      touchEvents: scrollProfile.touchEvents,
      keyScrollEvents: scrollProfile.keyScrollEvents,
      pointerMoves: scrollProfile.pointerMoves,
      pointerClicks: scrollProfile.pointerClicks,
      inputLinkedScrolls: scrollProfile.inputLinkedScrolls,
      trajectory: scrollProfile.trajectory
    };
  }

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
    const hasUpdate =
      activeSeconds > 0 ||
      scrollDepth > lastSentScrollDepth ||
      scrollProfile.events > lastSentScrollEvents;

    if (hasUpdate) {
      unsentActiveSeconds = 0;
      lastSentScrollDepth = scrollDepth;
      lastSentScrollEvents = scrollProfile.events;
      sendEvent({
        eventType: "engagement",
        sessionId,
        page,
        activeSeconds,
        scrollDepth,
        scrollProfile: snapshotScrollProfile()
      });
    }

    startActiveTimer();
  }

  document.addEventListener(
    "click",
    (event) => {
      scrollProfile.pointerClicks += 1;
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
    const now = performance.now();
    const scrollY = window.scrollY;
    const deltaY = scrollY - lastScrollY;
    const distance = Math.abs(deltaY);
    const depth = currentScrollDepth();
    maxScrollDepth = Math.max(maxScrollDepth, depth);

    if (distance > 0) {
      scrollProfile.events += 1;
      scrollProfile.distancePx += distance;

      if (now - lastInputAt <= INPUT_SCROLL_WINDOW_MS) {
        scrollProfile.inputLinkedScrolls += 1;
      }

      if (lastScrollAt === null || now - lastScrollAt > SCROLL_BURST_GAP_MS) {
        scrollProfile.bursts += 1;
      } else {
        const interval = now - lastScrollAt;
        scrollProfile.intervals.push(interval);
        scrollProfile.velocities.push((distance / interval) * 1000);
        if (interval >= 500) scrollProfile.pauses500Ms += 1;
        if (interval >= 2000) scrollProfile.pauses2000Ms += 1;
      }

      const direction = Math.sign(deltaY);
      if (lastScrollDirection && direction !== lastScrollDirection) {
        scrollProfile.directionChanges += 1;
      }

      lastScrollDirection = direction;
      lastScrollAt = now;
      lastScrollY = scrollY;
      rememberTrajectory(now, depth);
    }
  }, { passive: true });

  window.addEventListener("wheel", () => {
    scrollProfile.wheelEvents += 1;
    lastInputAt = performance.now();
  }, { passive: true });
  window.addEventListener("touchmove", () => {
    scrollProfile.touchEvents += 1;
    lastInputAt = performance.now();
  }, { passive: true });
  window.addEventListener("keydown", (event) => {
    if ([" ", "ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"].includes(event.key)) {
      scrollProfile.keyScrollEvents += 1;
      lastInputAt = performance.now();
    }
  }, { passive: true });
  window.addEventListener("pointermove", () => {
    const now = performance.now();
    if (now - lastPointerMoveAt >= 250) {
      scrollProfile.pointerMoves += 1;
      lastPointerMoveAt = now;
    }
  }, { passive: true });
  window.addEventListener("focus", startActiveTimer);
  window.addEventListener("blur", flushEngagement);
  document.addEventListener("visibilitychange", flushEngagement);
  window.addEventListener("pagehide", flushEngagement);

  startActiveTimer();
  setInterval(flushEngagement, ENGAGEMENT_FLUSH_MS);
})();
