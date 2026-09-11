(() => {
  const WORKER_URL = "https://overseer.matthewzhou05.workers.dev";
  const SESSION_KEY = "portfolio_analytics_session";
  const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
  const ENGAGEMENT_FLUSH_MS = 15 * 1000;
  const SCROLL_BURST_GAP_MS = 700;
  const INPUT_SCROLL_WINDOW_MS = 500;
  const MAX_TRAJECTORY_POINTS = 24;
  const REPLAY_SAMPLE_MS = 100;
  const MAX_REPLAY_SCROLL_SAMPLES = 560;
  const MAX_REPLAY_EVENTS = 700;
  // Increment this release ID whenever the published portfolio's visible
  // content changes. It lets the replay identify which site revision it uses.
  const SITE_VERSION = "replay-schema-v1";

  function createSessionId() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  }

  function initReplayMode() {
    const parentOrigin = new URL(WORKER_URL).origin;
    document.documentElement.dataset.portfolioReplay = "true";
    window.addEventListener("message", (event) => {
      if (event.origin !== parentOrigin || event.data?.type !== "portfolio-replay-command") return;
      const command = event.data.command || {};
      if (command.type === "scroll") {
        window.scrollTo(0, Math.max(0, Number(command.scrollY) || 0));
      }
      if (command.type === "lightbox_open" || command.type === "lightbox_close") {
        document.dispatchEvent(new CustomEvent("portfolio:replay-lightbox", { detail: command }));
      }
    });
    window.parent?.postMessage({ type: "portfolio-replay-ready", page: location.pathname }, parentOrigin);
  }

  if (new URLSearchParams(window.location.search).has("portfolioReplay")) {
    initReplayMode();
    return;
  }

  function getSessionId() {
    const now = Date.now();
    try {
      const saved = JSON.parse(localStorage.getItem(SESSION_KEY));
      const isActive = saved && typeof saved.id === "string" && Number.isFinite(saved.lastActivity) && now - saved.lastActivity >= 0 && now - saved.lastActivity < SESSION_TIMEOUT_MS;
      const id = isActive ? saved.id : createSessionId();
      localStorage.setItem(SESSION_KEY, JSON.stringify({ id, lastActivity: now }));
      return id;
    } catch {
      return createSessionId();
    }
  }

  function getDeviceType() {
    const userAgent = navigator.userAgent;
    const isIPad = /iPad/i.test(userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isTablet = isIPad || /Tablet|PlayBook|Silk/i.test(userAgent) || (/Android/i.test(userAgent) && !/Mobile/i.test(userAgent));
    if (isTablet) return "tablet";
    if (/Mobi|Android|iPhone|iPod/i.test(userAgent)) return "mobile";
    return "desktop";
  }

  function sendEvent(payload) {
    return fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(() => {});
  }

  function documentHeight() {
    return Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
  }

  function currentScrollDepth() {
    const pageHeight = documentHeight();
    if (pageHeight <= window.innerHeight) return 100;
    return Math.min(100, Math.max(0, Math.round(((window.scrollY + window.innerHeight) / pageHeight) * 100)));
  }

  function bucketViewport(value) {
    return Math.max(100, Math.round(value / 50) * 50);
  }

  function classifyTrackedLink(link) {
    const href = link.getAttribute("href") || "";
    const text = (link.textContent || "").trim().toLowerCase();
    if (/\.pdf(?:$|[?#])/i.test(href) && /resume/i.test(href + " " + text)) return "resume_open";
    if (/^mailto:/i.test(href)) return "email_click";
    if (/github\.com/i.test(href)) return "github_click";
    return null;
  }

  function createRunningStat() {
    return { count: 0, mean: 0, m2: 0 };
  }

  function addRunningStat(stat, value) {
    stat.count += 1;
    const delta = value - stat.mean;
    stat.mean += delta / stat.count;
    stat.m2 += delta * (value - stat.mean);
  }

  function statDeviation(stat) {
    return stat.count > 1 ? Math.sqrt(stat.m2 / stat.count) : 0;
  }

  const sessionId = getSessionId();
  const page = window.location.pathname;
  const pageInstanceId = createSessionId();
  const pageStartedAt = performance.now();
  let activeStartedAt = null;
  let unsentActiveSeconds = 0;
  let maxScrollDepth = currentScrollDepth();
  let lastSentScrollDepth = -1;
  let lastSentScrollEvents = -1;
  let lastScrollAt = null;
  let lastScrollY = window.scrollY;
  let lastScrollDirection = 0;
  let lastInputAt = -Infinity;
  let lastPointerMoveAt = -Infinity;
  let replayEventIndex = 0;
  let replayScrollSamples = 0;
  let lastReplaySampleAt = -Infinity;
  let replayEndTimer = null;
  const pendingReplayEvents = [];
  const intervalStats = createRunningStat();
  const velocityStats = createRunningStat();
  const scrollProfile = {
    events: 0, bursts: 0, directionChanges: 0, distancePx: 0,
    pauses500Ms: 0, pauses2000Ms: 0, wheelEvents: 0, touchEvents: 0,
    keyScrollEvents: 0, pointerMoves: 0, pointerClicks: 0,
    inputLinkedScrolls: 0, trajectory: [[0, maxScrollDepth]]
  };

  function rememberTrajectory(now, depth) {
    const point = [Math.round(now - pageStartedAt), Math.round(depth)];
    const lastPoint = scrollProfile.trajectory[scrollProfile.trajectory.length - 1];
    if (lastPoint && point[0] - lastPoint[0] < SCROLL_BURST_GAP_MS) {
      scrollProfile.trajectory[scrollProfile.trajectory.length - 1] = point;
    } else {
      scrollProfile.trajectory.push(point);
      if (scrollProfile.trajectory.length > MAX_TRAJECTORY_POINTS) scrollProfile.trajectory.shift();
    }
  }

  function snapshotScrollProfile() {
    const averageVelocity = velocityStats.mean;
    return {
      events: scrollProfile.events,
      bursts: scrollProfile.bursts,
      directionChanges: scrollProfile.directionChanges,
      distancePx: Math.round(scrollProfile.distancePx),
      avgIntervalMs: Math.round(intervalStats.mean),
      intervalStdDevMs: Math.round(statDeviation(intervalStats)),
      avgVelocityPxPerSecond: Math.round(averageVelocity),
      velocityVariation: averageVelocity ? Math.round((statDeviation(velocityStats) / averageVelocity) * 100) / 100 : 0,
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

  function recordReplayEvent(type, payload, now = performance.now()) {
    const isScroll = type === "scroll";
    if (replayEventIndex >= MAX_REPLAY_EVENTS) return;
    if (isScroll && replayScrollSamples >= MAX_REPLAY_SCROLL_SAMPLES) return;
    if (isScroll) replayScrollSamples += 1;
    pendingReplayEvents.push({ index: replayEventIndex++, atMs: Math.round(now - pageStartedAt), type, payload });
  }

  function recordReplayScroll(now, force = false) {
    if (!force && now - lastReplaySampleAt < REPLAY_SAMPLE_MS) return;
    lastReplaySampleAt = now;
    recordReplayEvent("scroll", { scrollY: Math.round(window.scrollY), documentHeight: documentHeight() }, now);
  }

  function flushReplayEvents() {
    if (!pendingReplayEvents.length) return;
    const events = pendingReplayEvents.splice(0, pendingReplayEvents.length);
    sendEvent({ eventType: "replay", sessionId, page, pageInstanceId, events });
  }

  sendEvent({
    eventType: "pageview", sessionId, page, referrer: document.referrer, deviceType: getDeviceType(),
    replayPage: {
      pageInstanceId, siteVersion: SITE_VERSION,
      viewportWidth: bucketViewport(window.innerWidth), viewportHeight: bucketViewport(window.innerHeight),
      documentHeight: documentHeight()
    }
  });
  recordReplayScroll(pageStartedAt, true);

  function isActivelyViewing() {
    return document.visibilityState === "visible" && document.hasFocus();
  }

  function startActiveTimer() {
    if (activeStartedAt === null && isActivelyViewing()) activeStartedAt = performance.now();
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
    const hasUpdate = activeSeconds > 0 || scrollDepth > lastSentScrollDepth || scrollProfile.events > lastSentScrollEvents;
    if (hasUpdate) {
      unsentActiveSeconds = 0;
      lastSentScrollDepth = scrollDepth;
      lastSentScrollEvents = scrollProfile.events;
      sendEvent({ eventType: "engagement", sessionId, page, activeSeconds, scrollDepth, scrollProfile: snapshotScrollProfile() });
    }
    flushReplayEvents();
    startActiveTimer();
  }

  document.addEventListener("click", (event) => {
    scrollProfile.pointerClicks += 1;
    const link = event.target.closest?.("a[href]");
    if (!link) return;
    const destination = new URL(link.href, window.location.href);
    if (destination.origin === window.location.origin && link.target !== "_blank" && destination.pathname !== page) {
      recordReplayEvent("navigation", { target: destination.pathname + destination.search });
      flushReplayEvents();
    }
    const action = classifyTrackedLink(link);
    if (!action) return;
    const target = link.getAttribute("href") || "";
    sendEvent({ eventType: "action", sessionId, page, action, target });
    recordReplayEvent("action", { action, target });
    flushReplayEvents();
  }, true);

  document.addEventListener("portfolio:lightbox", (event) => {
    const detail = event.detail || {};
    if (detail.type !== "lightbox_open" && detail.type !== "lightbox_close") return;
    recordReplayEvent(detail.type, {
      imageSrc: typeof detail.imageSrc === "string" ? detail.imageSrc : "",
      imageAlt: typeof detail.imageAlt === "string" ? detail.imageAlt : "",
      galleryIndex: Number.isFinite(detail.galleryIndex) ? detail.galleryIndex : null
    });
    flushReplayEvents();
  });

  window.addEventListener("scroll", () => {
    const now = performance.now();
    const scrollY = window.scrollY;
    const deltaY = scrollY - lastScrollY;
    const distance = Math.abs(deltaY);
    const depth = currentScrollDepth();
    maxScrollDepth = Math.max(maxScrollDepth, depth);
    if (!distance) return;
    scrollProfile.events += 1;
    scrollProfile.distancePx += distance;
    if (now - lastInputAt <= INPUT_SCROLL_WINDOW_MS) scrollProfile.inputLinkedScrolls += 1;
    if (lastScrollAt === null || now - lastScrollAt > SCROLL_BURST_GAP_MS) scrollProfile.bursts += 1;
    if (lastScrollAt !== null) {
      const interval = now - lastScrollAt;
      addRunningStat(intervalStats, interval);
      addRunningStat(velocityStats, (distance / Math.max(interval, 1)) * 1000);
      if (interval >= 500) scrollProfile.pauses500Ms += 1;
      if (interval >= 2000) scrollProfile.pauses2000Ms += 1;
    }
    const direction = Math.sign(deltaY);
    if (lastScrollDirection && direction !== lastScrollDirection) scrollProfile.directionChanges += 1;
    lastScrollDirection = direction;
    lastScrollAt = now;
    lastScrollY = scrollY;
    rememberTrajectory(now, depth);
    recordReplayScroll(now);
    clearTimeout(replayEndTimer);
    replayEndTimer = setTimeout(() => recordReplayScroll(performance.now(), true), 160);
  }, { passive: true });

  window.addEventListener("wheel", () => { scrollProfile.wheelEvents += 1; lastInputAt = performance.now(); }, { passive: true });
  window.addEventListener("touchmove", () => { scrollProfile.touchEvents += 1; lastInputAt = performance.now(); }, { passive: true });
  window.addEventListener("keydown", (event) => {
    if ([" ", "ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"].includes(event.key)) {
      scrollProfile.keyScrollEvents += 1;
      lastInputAt = performance.now();
    }
  }, { passive: true });
  window.addEventListener("pointermove", () => {
    const now = performance.now();
    if (now - lastPointerMoveAt >= 250) { scrollProfile.pointerMoves += 1; lastPointerMoveAt = now; }
  }, { passive: true });
  window.addEventListener("focus", startActiveTimer);
  window.addEventListener("blur", flushEngagement);
  document.addEventListener("visibilitychange", flushEngagement);
  window.addEventListener("pagehide", () => {
    recordReplayScroll(performance.now(), true);
    recordReplayEvent("pagehide", {});
    flushEngagement();
  });

  startActiveTimer();
  setInterval(flushEngagement, ENGAGEMENT_FLUSH_MS);
})();
