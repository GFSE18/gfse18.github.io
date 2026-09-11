const ALLOWED_ORIGIN = "https://gfse18.github.io";
const MAX_PAGE_HISTORY = 100;
const MAX_REPLAY_DURATION_MS = 30 * 60 * 1000;
const REPLAY_RETENTION_DAYS = 60;
const REPORT_TIME_ZONE = "America/New_York";
const DEVICE_TYPES = new Set(["desktop", "mobile", "tablet"]);
const TRACKED_ACTIONS = new Set([
  "resume_open",
  "email_click",
  "github_click"
]);
const REPLAY_EVENT_TYPES = new Set([
  "scroll",
  "lightbox_open",
  "lightbox_close",
  "action",
  "navigation",
  "pagehide"
]);
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  Vary: "Origin"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/admin") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }

      return new Response(adminPage, {
        headers: { "Content-Type": "text/html; charset=UTF-8" }
      });
    }

    if (url.pathname === "/admin-data") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }

      const result = await env.DB.prepare(`
        SELECT
          id,
          session_id,
          COALESCE(first_seen, timestamp) AS first_seen,
          COALESCE(last_seen, timestamp) AS last_seen,
          COALESCE(pageviews, 1) AS pageviews,
          ip,
          country,
          region,
          region_code,
          city,
          postal_code,
          latitude,
          longitude,
          timezone,
          page AS last_page,
          pages,
          referrer,
          user_agent,
          device_type,
          COALESCE((
            SELECT SUM(metrics.active_seconds)
            FROM session_page_metrics AS metrics
            WHERE metrics.session_id = visits.session_id
          ), 0) AS active_seconds,
          COALESCE((
            SELECT json_group_array(json_object(
              'page', metrics.page,
              'activeSeconds', ROUND(metrics.active_seconds, 1),
              'scrollDepth', metrics.max_scroll_depth,
              'scrollProfile', json(COALESCE((
                SELECT profiles.profile_json
                FROM session_page_scroll_profiles AS profiles
                WHERE profiles.session_id = metrics.session_id
                  AND profiles.page = metrics.page
              ), '{}'))
            ))
            FROM session_page_metrics AS metrics
            WHERE metrics.session_id = visits.session_id
          ), '[]') AS page_metrics,
          COALESCE((
            SELECT json_group_array(json_object(
              'action', actions.action,
              'page', actions.page,
              'target', actions.target,
              'count', actions.click_count
            ))
            FROM session_actions AS actions
            WHERE actions.session_id = visits.session_id
          ), '[]') AS actions,
          COALESCE((
            SELECT json_group_array(json_object(
              'pageInstanceId', replay_page.page_instance_id,
              'page', replay_page.page,
              'siteVersion', replay_page.site_version,
              'viewportWidth', replay_page.viewport_width,
              'viewportHeight', replay_page.viewport_height,
              'documentHeight', replay_page.document_height,
              'startedAt', replay_page.started_at,
              'lastSeen', replay_page.last_seen,
              'events', COALESCE((
                SELECT json_group_array(json_object(
                  'index', replay_event.event_index,
                  'atMs', replay_event.at_ms,
                  'type', replay_event.event_type,
                  'payload', replay_event.payload_json
                ))
                FROM session_replay_events AS replay_event
                WHERE replay_event.page_instance_id = replay_page.page_instance_id
              ), '[]'),
              'chunks', COALESCE((
                SELECT json_group_array(json_object(
                  'index', replay_chunk.chunk_index,
                  'events', replay_chunk.events_json
                ))
                FROM session_replay_chunks AS replay_chunk
                WHERE replay_chunk.page_instance_id = replay_page.page_instance_id
              ), '[]')
            ))
            FROM session_replay_pages AS replay_page
            WHERE replay_page.session_id = visits.session_id
          ), '[]') AS replay_pages
        FROM visits
        ORDER BY COALESCE(last_seen, timestamp) DESC
        LIMIT 100
      `).all();

      return Response.json(result.results, {
        headers: { "Cache-Control": "no-store" }
      });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: corsHeaders
      });
    }

    if (request.headers.get("Origin") !== ALLOWED_ORIGIN) {
      return new Response("Forbidden", { status: 403, headers: corsHeaders });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON", {
        status: 400,
        headers: corsHeaders
      });
    }

    const suppliedSessionId =
      typeof body.sessionId === "string" ? body.sessionId : "";
    const sessionId = SESSION_ID_PATTERN.test(suppliedSessionId)
      ? suppliedSessionId
      : crypto.randomUUID();
    const page = cleanString(body.page, 500);
    const referrer = cleanString(body.referrer, 1000);
    const now = new Date().toISOString();
    const eventType =
      typeof body.eventType === "string" ? body.eventType : "pageview";

    if (eventType === "engagement") {
      const activeSeconds = clampNumber(body.activeSeconds, 0, 300);
      const scrollDepth = Math.round(clampNumber(body.scrollDepth, 0, 100));
      const scrollProfile = normalizeScrollProfile(body.scrollProfile);

      await env.DB.prepare(`
        INSERT INTO session_page_metrics (
          session_id,
          page,
          active_seconds,
          max_scroll_depth,
          first_seen,
          last_seen
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?5)
        ON CONFLICT(session_id, page) DO UPDATE SET
          active_seconds = session_page_metrics.active_seconds + excluded.active_seconds,
          max_scroll_depth = MAX(
            session_page_metrics.max_scroll_depth,
            excluded.max_scroll_depth
          ),
          last_seen = excluded.last_seen
      `)
        .bind(sessionId, page || "", activeSeconds, scrollDepth, now)
        .run();

      await env.DB.prepare(`
        INSERT INTO session_page_scroll_profiles (
          session_id,
          page,
          profile_json,
          updated_at
        )
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(session_id, page) DO UPDATE SET
          profile_json = excluded.profile_json,
          updated_at = excluded.updated_at
      `)
        .bind(sessionId, page || "", JSON.stringify(scrollProfile), now)
        .run();

      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (eventType === "replay") {
      const pageInstanceId = validSessionId(body.pageInstanceId)
        ? body.pageInstanceId
        : null;
      const chunkIndex = Math.round(clampNumber(body.chunkIndex, 0, 10000));
      const documentHeight = Math.round(
        clampNumber(body.documentHeight, 100, 10000000)
      );
      const events = normalizeReplayEvents(body.events);

      if (!pageInstanceId || events.length === 0) {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      await env.DB.prepare(`
        INSERT INTO session_replay_chunks (
          page_instance_id,
          chunk_index,
          events_json,
          created_at
        )
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(page_instance_id, chunk_index) DO NOTHING
      `)
        .bind(pageInstanceId, chunkIndex, JSON.stringify(events), now)
        .run();

      await env.DB.prepare(`
        UPDATE session_replay_pages
        SET last_seen = ?1,
            document_height = MAX(document_height, ?2)
        WHERE page_instance_id = ?3 AND session_id = ?4
      `)
        .bind(now, documentHeight, pageInstanceId, sessionId)
        .run();

      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (eventType === "action") {
      const action =
        typeof body.action === "string" ? body.action : "";
      if (!TRACKED_ACTIONS.has(action)) {
        return new Response("Unknown action", {
          status: 400,
          headers: corsHeaders
        });
      }

      const target = cleanString(body.target, 1000) || "";
      await env.DB.prepare(`
        INSERT INTO session_actions (
          session_id,
          action,
          page,
          target,
          first_clicked,
          last_clicked,
          click_count
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?5, 1)
        ON CONFLICT(session_id, action, page, target) DO UPDATE SET
          last_clicked = excluded.last_clicked,
          click_count = session_actions.click_count + 1
      `)
        .bind(sessionId, action, page || "", target, now)
        .run();

      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (eventType !== "pageview") {
      return new Response("Unknown event type", {
        status: 400,
        headers: corsHeaders
      });
    }

    const ip = request.headers.get("CF-Connecting-IP");
    const country = request.cf?.country || null;
    const region = request.cf?.region || null;
    const regionCode = request.cf?.regionCode || null;
    const city = request.cf?.city || null;
    const postalCode = request.cf?.postalCode || null;
    const latitude = request.cf?.latitude || null;
    const longitude = request.cf?.longitude || null;
    const timezone = request.cf?.timezone || null;
    const userAgent = request.headers.get("User-Agent");
    const suppliedDeviceType = cleanString(body.deviceType, 20);
    const deviceType = DEVICE_TYPES.has(suppliedDeviceType)
      ? suppliedDeviceType
      : inferDeviceType(userAgent);

    await env.DB.prepare(`
      INSERT INTO visits (
        timestamp,
        ip,
        country,
        region,
        region_code,
        city,
        postal_code,
        latitude,
        longitude,
        timezone,
        page,
        referrer,
        user_agent,
        session_id,
        first_seen,
        last_seen,
        pageviews,
        pages,
        device_type
      )
      VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
        ?10, ?11, ?12, ?13, ?14, ?15, ?16, 1, ?17, ?18
      )
      ON CONFLICT(session_id) DO UPDATE SET
        last_seen = excluded.last_seen,
        pageviews = visits.pageviews + 1,
        page = excluded.page,
        device_type = COALESCE(visits.device_type, excluded.device_type),
        pages = CASE
          WHEN COALESCE(json_array_length(visits.pages), 0) < ?19
          THEN json_insert(
            COALESCE(visits.pages, '[]'),
            '$[#]',
            excluded.page
          )
          ELSE visits.pages
        END
    `)
      .bind(
        now,
        ip,
        country,
        region,
        regionCode,
        city,
        postalCode,
        latitude,
        longitude,
        timezone,
        page,
        referrer,
        userAgent,
        sessionId,
        now,
        now,
        JSON.stringify([page]),
        deviceType,
        MAX_PAGE_HISTORY
      )
      .run();

    const replayPage = normalizeReplayPage(body.replayPage);
    if (replayPage) {
      await env.DB.prepare(`
        INSERT INTO session_replay_pages (
          page_instance_id,
          session_id,
          page,
          site_version,
          viewport_width,
          viewport_height,
          document_height,
          started_at,
          last_seen
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
        ON CONFLICT(page_instance_id) DO UPDATE SET
          last_seen = excluded.last_seen,
          document_height = MAX(
            session_replay_pages.document_height,
            excluded.document_height
          )
      `)
        .bind(
          replayPage.pageInstanceId,
          sessionId,
          page || "",
          replayPage.siteVersion,
          replayPage.viewportWidth,
          replayPage.viewportHeight,
          replayPage.documentHeight,
          now
        )
        .run();
    }

    return new Response(null, { status: 204, headers: corsHeaders });
  },

  async scheduled(controller, env) {
    const easternTime = getZonedParts(
      new Date(controller.scheduledTime),
      REPORT_TIME_ZONE
    );

    // Two UTC schedules are needed because Eastern Time changes between UTC-4
    // and UTC-5. Only the schedule that lands at 11:59 p.m. Eastern sends.
    if (easternTime.hour !== 23 || easternTime.minute !== 59) {
      return;
    }

    await purgeExpiredReplayData(env, easternTime.date);
    if (env.RESEND_API_KEY && env.REPORT_TO) {
      await sendDailyReport(env, easternTime.date);
    }
  }
};

function cleanString(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : null;
}

function clampNumber(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.min(maximum, Math.max(minimum, number));
}

function validSessionId(value) {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

function normalizeReplayPage(value) {
  if (!value || typeof value !== "object" || !validSessionId(value.pageInstanceId)) {
    return null;
  }

  const siteVersion = cleanString(value.siteVersion, 100) || "unknown";
  if (!/^[a-zA-Z0-9._-]+$/.test(siteVersion)) return null;

  return {
    pageInstanceId: value.pageInstanceId,
    siteVersion,
    viewportWidth: Math.round(clampNumber(value.viewportWidth, 100, 5000)),
    viewportHeight: Math.round(clampNumber(value.viewportHeight, 100, 5000)),
    documentHeight: Math.round(clampNumber(value.documentHeight, 100, 10000000))
  };
}

function normalizeReplayEvents(value) {
  if (!Array.isArray(value)) return [];

  return value
    .slice(0, 700)
    .map((input) => {
      const event = Array.isArray(input)
        ? {
            index: input[0],
            atMs: input[1],
            type: input[2],
            payload: input[3]
          }
        : input;
      if (!event || typeof event !== "object" || !REPLAY_EVENT_TYPES.has(event.type)) {
        return null;
      }

      const index = Math.round(clampNumber(event.index, 0, 10000));
      const atMs = Math.round(clampNumber(event.atMs, 0, MAX_REPLAY_DURATION_MS));
      return [
        index,
        atMs,
        event.type,
        normalizeReplayPayload(event.type, event.payload)
      ];
    })
    .filter(Boolean);
}

function normalizeReplayPayload(type, value) {
  const payload = value && typeof value === "object" ? value : {};

  if (type === "scroll") {
    return {
      scrollY: Math.round(clampNumber(payload.scrollY, 0, 10000000))
    };
  }

  if (type === "lightbox_open") {
    return {
      imageSrc: cleanString(payload.imageSrc, 1000) || "",
      imageAlt: cleanString(payload.imageAlt, 500) || "",
      galleryIndex: Math.round(clampNumber(payload.galleryIndex, 0, 10000))
    };
  }

  if (type === "action") {
    const action = typeof payload.action === "string" && TRACKED_ACTIONS.has(payload.action)
      ? payload.action
      : "unknown";
    return { action, target: cleanString(payload.target, 1000) || "" };
  }

  if (type === "navigation") {
    return { target: cleanString(payload.target, 500) || "" };
  }

  return {};
}

function normalizeScrollProfile(value) {
  const profile = value && typeof value === "object" ? value : {};
  const integer = (name, maximum) =>
    Math.round(clampNumber(profile[name], 0, maximum));
  const decimal = (name, maximum) =>
    Math.round(clampNumber(profile[name], 0, maximum) * 100) / 100;
  const trajectory = Array.isArray(profile.trajectory)
    ? profile.trajectory
        .slice(-24)
        .map((point) => Array.isArray(point) ? [
          integerFrom(point[0], 0, 30 * 60 * 1000),
          integerFrom(point[1], 0, 100)
        ] : null)
        .filter(Boolean)
    : [];

  return {
    events: integer("events", 10000),
    bursts: integer("bursts", 1000),
    directionChanges: integer("directionChanges", 1000),
    distancePx: integer("distancePx", 10000000),
    avgIntervalMs: integer("avgIntervalMs", 300000),
    intervalStdDevMs: integer("intervalStdDevMs", 300000),
    avgVelocityPxPerSecond: integer("avgVelocityPxPerSecond", 1000000),
    velocityVariation: decimal("velocityVariation", 1000),
    pauses500Ms: integer("pauses500Ms", 1000),
    pauses2000Ms: integer("pauses2000Ms", 1000),
    wheelEvents: integer("wheelEvents", 10000),
    touchEvents: integer("touchEvents", 10000),
    keyScrollEvents: integer("keyScrollEvents", 10000),
    pointerMoves: integer("pointerMoves", 10000),
    pointerClicks: integer("pointerClicks", 1000),
    inputLinkedScrolls: integer("inputLinkedScrolls", 10000),
    trajectory
  };
}

function integerFrom(value, minimum, maximum) {
  return Math.round(clampNumber(value, minimum, maximum));
}

function inferDeviceType(userAgent) {
  const value = userAgent || "";
  if (/iPad|Tablet|PlayBook|Silk/i.test(value)) return "tablet";
  if (/Android/i.test(value) && !/Mobile/i.test(value)) return "tablet";
  if (/Mobi|Android|iPhone|iPod/i.test(value)) return "mobile";
  return "desktop";
}

async function purgeExpiredReplayData(env, reportDate) {
  const cutoffDate = addDays(reportDate, -REPLAY_RETENTION_DAYS);
  const cutoff = zonedMidnightToUtc(cutoffDate, REPORT_TIME_ZONE).toISOString();
  const expiredPageIds = `
    SELECT page_instance_id
    FROM session_replay_pages
    WHERE last_seen < ?1
  `;

  await env.DB.prepare(`
    DELETE FROM session_replay_chunks
    WHERE page_instance_id IN (${expiredPageIds})
  `).bind(cutoff).run();
  await env.DB.prepare(`
    DELETE FROM session_replay_events
    WHERE page_instance_id IN (${expiredPageIds})
  `).bind(cutoff).run();
  await env.DB.prepare(`
    DELETE FROM session_replay_pages
    WHERE last_seen < ?1
  `).bind(cutoff).run();
}

async function sendDailyReport(env, reportDate) {
  if (!env.RESEND_API_KEY || !env.REPORT_TO) {
    throw new Error("RESEND_API_KEY and REPORT_TO must be configured");
  }

  const nextDate = addDays(reportDate, 1);
  const start = zonedMidnightToUtc(reportDate, REPORT_TIME_ZONE).toISOString();
  const end = zonedMidnightToUtc(nextDate, REPORT_TIME_ZONE).toISOString();

  const result = await env.DB.prepare(`
    SELECT
      COALESCE(first_seen, timestamp) AS first_seen,
      COALESCE(last_seen, timestamp) AS last_seen,
      COALESCE(pageviews, 1) AS pageviews,
      page AS last_page,
      pages,
      city,
      region,
      country,
      device_type,
      COALESCE((
        SELECT SUM(metrics.active_seconds)
        FROM session_page_metrics AS metrics
        WHERE metrics.session_id = visits.session_id
      ), 0) AS active_seconds,
      COALESCE((
        SELECT COUNT(*)
        FROM session_page_metrics AS metrics
        WHERE metrics.session_id = visits.session_id
      ), 0) AS measured_pages,
      COALESCE((
        SELECT SUM(metrics.max_scroll_depth)
        FROM session_page_metrics AS metrics
        WHERE metrics.session_id = visits.session_id
      ), 0) AS total_scroll_depth,
      COALESCE((
        SELECT json_group_array(json_object(
          'action', actions.action,
          'count', actions.click_count
        ))
        FROM session_actions AS actions
        WHERE actions.session_id = visits.session_id
      ), '[]') AS actions
    FROM visits
    WHERE COALESCE(first_seen, timestamp) >= ?1
      AND COALESCE(first_seen, timestamp) < ?2
    ORDER BY COALESCE(first_seen, timestamp)
  `)
    .bind(start, end)
    .all();

  const sessions = result.results || [];
  const pageCounts = new Map();
  const locationCounts = new Map();
  const deviceCounts = new Map();
  const actionCounts = new Map();
  let pageviews = 0;
  let activeSeconds = 0;
  let measuredPages = 0;
  let totalScrollDepth = 0;

  for (const session of sessions) {
    pageviews += Number(session.pageviews) || 1;
    activeSeconds += Number(session.active_seconds) || 0;
    measuredPages += Number(session.measured_pages) || 0;
    totalScrollDepth += Number(session.total_scroll_depth) || 0;

    for (const page of parsePageHistory(session)) {
      incrementCount(pageCounts, page || "Unknown page");
    }

    incrementCount(deviceCounts, session.device_type || "Unknown device");
    for (const action of parseJsonArray(session.actions)) {
      incrementCount(
        actionCounts,
        actionLabel(action.action),
        Number(action.count) || 1
      );
    }

    const location = [session.city, session.region, session.country]
      .filter(Boolean)
      .join(", ");
    incrementCount(locationCounts, location || "Unknown location");
  }

  const displayDate = new Intl.DateTimeFormat("en-US", {
    timeZone: REPORT_TIME_ZONE,
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(zonedMidnightToUtc(reportDate, REPORT_TIME_ZONE));
  const topPages = sortedCounts(pageCounts, 10);
  const topLocations = sortedCounts(locationCounts, 5);
  const report = {
    date: displayDate,
    sessions: sessions.length,
    pageviews,
    averageActiveSeconds: sessions.length ? activeSeconds / sessions.length : 0,
    averageScrollDepth: measuredPages ? totalScrollDepth / measuredPages : 0,
    pages: topPages,
    actions: sortedCounts(actionCounts, 10),
    devices: sortedCounts(deviceCounts, 5),
    locations: topLocations
  };
  const text = buildReportText(report);
  const html = buildReportHtml(report);

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `portfolio-daily-report-${reportDate}`
    },
    body: JSON.stringify({
      from: "Portfolio Analytics <onboarding@resend.dev>",
      to: [env.REPORT_TO],
      subject: `Portfolio report - ${displayDate}`,
      text,
      html
    })
  });

  if (!response.ok) {
    const details = (await response.text()).slice(0, 500);
    throw new Error(`Resend email failed (${response.status}): ${details}`);
  }
}

function getZonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );

  return {
    date: [
      parts.year,
      String(parts.month).padStart(2, "0"),
      String(parts.day).padStart(2, "0")
    ].join("-"),
    hour: parts.hour,
    minute: parts.minute
  };
}

function zonedMidnightToUtc(dateString, timeZone) {
  const [year, month, day] = dateString.split("-").map(Number);
  const utcGuess = Date.UTC(year, month - 1, day);
  let offset = timeZoneOffset(new Date(utcGuess), timeZone);
  let result = utcGuess - offset;

  // Recalculate using the resulting instant in case the first guess was on
  // the other side of a daylight-saving transition.
  offset = timeZoneOffset(new Date(result), timeZone);
  result = utcGuess - offset;
  return new Date(result);
}

function timeZoneOffset(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
  const displayedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  return displayedAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function addDays(dateString, days) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function parsePageHistory(session) {
  if (session.pages) {
    try {
      const parsed = JSON.parse(session.pages);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return session.last_page ? [session.last_page] : [];
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function actionLabel(action) {
  return {
    resume_open: "Resume opened",
    email_click: "Email clicked",
    github_click: "GitHub clicked"
  }[action] || action || "Unknown action";
}

function incrementCount(counts, label, amount = 1) {
  counts.set(label, (counts.get(label) || 0) + amount);
}

function sortedCounts(counts, limit) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function buildReportText(report) {
  const lines = [
    `Portfolio traffic for ${report.date}`,
    "",
    `Visitor sessions: ${report.sessions}`,
    `Page views: ${report.pageviews}`,
    `Average active reading time: ${formatDuration(report.averageActiveSeconds)}`,
    `Average maximum scroll depth: ${Math.round(report.averageScrollDepth)}%`,
    "",
    "Pages:"
  ];

  lines.push(...formatTextCounts(report.pages));
  lines.push("", "Tracked clicks:", ...formatTextCounts(report.actions));
  lines.push("", "Devices:", ...formatTextCounts(report.devices));
  lines.push("", "Visitor locations:", ...formatTextCounts(report.locations));
  return lines.join("\n");
}

function formatTextCounts(items) {
  return items.length
    ? items.map(([label, count]) => `- ${label}: ${count}`)
    : ["- None"];
}

function buildReportHtml(report) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:620px;color:#222">
      <h1 style="font-size:24px;margin-bottom:8px">Portfolio traffic</h1>
      <p style="color:#666;margin-top:0">${escapeHtml(report.date)}</p>
      <table style="border-collapse:collapse;margin:24px 0">
        <tr>
          <td style="padding:12px 24px 12px 0"><strong>${report.sessions}</strong><br>Visitor sessions</td>
          <td style="padding:12px 24px 12px 0"><strong>${report.pageviews}</strong><br>Page views</td>
          <td style="padding:12px 24px 12px 0"><strong>${formatDuration(report.averageActiveSeconds)}</strong><br>Avg. active time</td>
          <td style="padding:12px 0"><strong>${Math.round(report.averageScrollDepth)}%</strong><br>Avg. max scroll</td>
        </tr>
      </table>
      <h2 style="font-size:18px">Pages</h2>
      ${formatHtmlCounts(report.pages)}
      <h2 style="font-size:18px;margin-top:24px">Tracked clicks</h2>
      ${formatHtmlCounts(report.actions)}
      <h2 style="font-size:18px;margin-top:24px">Devices</h2>
      ${formatHtmlCounts(report.devices)}
      <h2 style="font-size:18px;margin-top:24px">Visitor locations</h2>
      ${formatHtmlCounts(report.locations)}
      <p style="font-size:12px;color:#777;margin-top:28px">
        Sessions use a 30-minute inactivity timeout. Times and report dates use Eastern Time.
      </p>
    </div>`;
}

function formatDuration(seconds) {
  const totalSeconds = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function formatHtmlCounts(items) {
  if (items.length === 0) return "<p>None</p>";

  return `<table style="border-collapse:collapse;width:100%">${items
    .map(
      ([label, count]) =>
        `<tr><td style="padding:7px 12px 7px 0;border-bottom:1px solid #eee">${escapeHtml(label)}</td>` +
        `<td style="padding:7px 0;border-bottom:1px solid #eee;text-align:right">${count}</td></tr>`
    )
    .join("")}</table>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const adminPage = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Portfolio Analytics</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; background: #f5f5f5; color: #222; }
    .container { max-width: 1500px; margin: 40px auto; padding: 0 24px; }
    h1 { margin-bottom: 8px; }
    .subtitle { color: #666; margin-bottom: 24px; }
    .card { background: white; border-radius: 10px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,.08); overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { text-align: left; padding: 12px; border-bottom: 2px solid #ddd; white-space: nowrap; }
    td { padding: 12px; border-bottom: 1px solid #eee; vertical-align: top; }
    tr:hover { background: #fafafa; }
    .mono { font-family: monospace; font-size: 13px; }
    .secondary { color: #666; font-size: 12px; }
    button { font: inherit; }
    .refresh, .report-button, .close { padding: 8px 14px; cursor: pointer; }
    .refresh { margin-bottom: 16px; }
    .report-button { border: 1px solid #777; background: white; border-radius: 5px; white-space: nowrap; }
    dialog { width: min(1100px, calc(100vw - 32px)); max-height: min(900px, calc(100vh - 48px)); border: 0; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,.3); padding: 0; color: #222; }
    dialog::backdrop { background: rgba(0,0,0,.42); }
    .report-header { display: flex; gap: 16px; align-items: center; justify-content: space-between; padding: 20px 24px; border-bottom: 1px solid #e5e5e5; }
    .report-header h2 { margin: 0; }
    .close { border: 1px solid #999; border-radius: 5px; background: white; }
    .report-content { padding: 0 24px 24px; }
    .report-tabs { display: flex; gap: 6px; padding: 12px 24px 0; border-bottom: 1px solid #e5e5e5; }
    .report-tab { border: 0; border-bottom: 3px solid transparent; background: transparent; padding: 10px 12px; cursor: pointer; }
    .report-tab[aria-selected="true"] { border-bottom-color: #222; font-weight: 700; }
    [hidden] { display: none !important; }
    .report-section { padding: 20px 0; border-bottom: 1px solid #e9e9e9; }
    .report-section:last-child { border-bottom: 0; }
    .report-section h3 { margin: 0 0 10px; font-size: 16px; }
    .page-report + .page-report { border-top: 1px solid #eee; margin-top: 18px; padding-top: 18px; }
    .page-report h4 { margin: 0 0 8px; font-family: monospace; font-size: 14px; }
    .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 12px 0; }
    .fact { background: #f6f7f8; border-radius: 6px; padding: 9px; font-size: 13px; }
    .fact strong { display: block; font-size: 15px; margin-bottom: 2px; }
    .scroll-chart { margin: 14px 0; border: 1px solid #e2e5e8; border-radius: 8px; padding: 10px; }
    .scroll-chart-title { margin: 0 0 6px; font-size: 13px; font-weight: 700; }
    .scroll-chart-note { color: #666; font-size: 12px; }
    .scroll-chart svg { display: block; width: 100%; height: auto; }
    .behavior-lines { margin: 0; padding-left: 18px; line-height: 1.5; }
    .trajectory { margin-top: 10px; font-size: 12px; line-height: 1.5; word-break: break-word; }
    .referrer { overflow-wrap: anywhere; }
    .replay-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 14px 0 10px; }
    .replay-controls input { flex: 1 1 260px; }
    .replay-controls button, .replay-controls select { padding: 7px 10px; }
    .replay-stage { background: #d8dce0; border-radius: 8px; overflow: hidden; position: relative; }
    .replay-viewport { transform-origin: top left; background: white; box-shadow: 0 2px 14px rgba(0,0,0,.2); }
    .replay-frame { display: block; border: 0; background: white; }
    .replay-meta { display: flex; flex-wrap: wrap; gap: 12px; color: #555; font-size: 13px; }
    .replay-events { margin: 14px 0 0; padding-left: 18px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Portfolio Analytics</h1>
    <div class="subtitle">Recent visitor sessions (30-minute inactivity timeout)</div>
    <button class="refresh" id="refresh" type="button">Refresh</button>
    <div class="card">
      <table>
        <thead>
          <tr>
            <th>First seen</th><th>Last seen</th><th>Views</th><th>Active time</th>
            <th>Device</th><th>City</th><th>State</th><th>Country</th><th>IP</th><th>Session report</th>
          </tr>
        </thead>
        <tbody id="visits"><tr><td colspan="10">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
  <dialog id="session-report" aria-labelledby="report-title">
    <div class="report-header"><h2 id="report-title">Session report</h2><button class="close" id="close-report" type="button">Close</button></div>
    <div class="report-tabs" role="tablist" aria-label="Session report sections">
      <button class="report-tab" id="summary-tab" type="button" role="tab" aria-selected="true">Summary</button>
      <button class="report-tab" id="replay-tab" type="button" role="tab" aria-selected="false">Replay</button>
    </div>
    <div class="report-content" id="report-content"></div>
    <div class="report-content" id="replay-content" hidden></div>
  </dialog>
  <script>
    const tbody = document.getElementById("visits");
    const reportDialog = document.getElementById("session-report");
    const reportContent = document.getElementById("report-content");
    const replayContent = document.getElementById("replay-content");
    const summaryTab = document.getElementById("summary-tab");
    const replayTab = document.getElementById("replay-tab");
    let stopReplay = () => {};
    document.getElementById("refresh").addEventListener("click", loadVisits);
    document.getElementById("close-report").addEventListener("click", () => { stopReplay(); reportDialog.close(); });
    reportDialog.addEventListener("close", () => stopReplay());
    function showPanel(name) {
      const replay = name === "replay";
      summaryTab.setAttribute("aria-selected", String(!replay));
      replayTab.setAttribute("aria-selected", String(replay));
      reportContent.hidden = replay;
      replayContent.hidden = !replay;
    }
    summaryTab.addEventListener("click", () => showPanel("summary"));
    replayTab.addEventListener("click", () => showPanel("replay"));

    function formatTime(value) {
      if (!value) return "";
      return new Date(value).toLocaleString("en-US", { timeZone: "America/New_York", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" });
    }
    function cell(row, value, className = "") {
      const td = document.createElement("td");
      td.textContent = value ?? "";
      if (className) td.className = className;
      row.appendChild(td);
      return td;
    }
    function element(tag, text, className = "") {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    }
    function pageHistory(visit) {
      if (visit.pages) { try { const parsed = JSON.parse(visit.pages); if (Array.isArray(parsed)) return parsed; } catch {} }
      return visit.last_page ? [visit.last_page] : [];
    }
    function summarizePages(visit) {
      const counts = new Map();
      for (const page of pageHistory(visit)) { const label = page ?? ""; counts.set(label, (counts.get(label) ?? 0) + 1); }
      return counts;
    }
    function jsonArray(value) {
      if (!value) return [];
      try { const parsed = typeof value === "string" ? JSON.parse(value) : value; return Array.isArray(parsed) ? parsed : []; } catch { return []; }
    }
    function jsonObject(value) {
      if (!value) return {};
      try { const parsed = typeof value === "string" ? JSON.parse(value) : value; return parsed && typeof parsed === "object" ? parsed : {}; } catch { return {}; }
    }
    function formatDuration(value) {
      const seconds = Math.max(0, Math.round(Number(value) || 0)); const minutes = Math.floor(seconds / 60); const remainder = seconds % 60;
      return minutes ? minutes + "m " + remainder + "s" : remainder + "s";
    }
    function actionName(value) { return { resume_open: "Resume opened", email_click: "Email clicked", github_click: "GitHub clicked" }[value] || value || "Unknown action"; }
    function addFact(container, value, label) {
      const fact = element("div", undefined, "fact"); fact.append(element("strong", value)); fact.append(element("span", label)); container.append(fact);
    }
    function scrollChartPoints(replayPage, profile) {
      if (replayPage) {
        const maximum = Math.max(1, (Number(replayPage.documentHeight) || 0) - (Number(replayPage.viewportHeight) || 0));
        const points = replayPage.events
          .filter((event) => event.type === "scroll")
          .map((event) => ({
            atMs: Number(event.atMs) || 0,
            percent: Math.max(0, Math.min(100, ((Number(event.payload.scrollY) || 0) / maximum) * 100))
          }))
          .sort((first, second) => first.atMs - second.atMs);
        if (points.length) return { points, label: "Recorded replay timeline" };
      }
      const legacy = jsonArray(profile.trajectory).map((point) => ({
        atMs: Number(point[0]) || 0,
        percent: Number(point[1]) || 0
      }));
      return { points: legacy, label: "Coarse legacy timeline" };
    }
    function renderScrollChart(container, chart) {
      const wrapper = element("div", undefined, "scroll-chart");
      wrapper.append(element("div", "Scroll position over time", "scroll-chart-title"));
      if (chart.points.length < 2) {
        wrapper.append(element("div", "Not enough recorded movement to draw a timeline.", "scroll-chart-note"));
        container.append(wrapper);
        return;
      }
      const width = 680; const height = 210; const left = 46; const right = 14; const top = 16; const bottom = 34;
      const graphWidth = width - left - right; const graphHeight = height - top - bottom;
      const duration = Math.max(1, ...chart.points.map((point) => point.atMs));
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 " + width + " " + height);
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", "Scroll percentage over time");
      const addSvg = (tag, attributes, text) => {
        const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
        for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
        if (text !== undefined) node.textContent = text;
        svg.append(node);
      };
      for (const percent of [0, 50, 100]) {
        const y = top + graphHeight - (percent / 100) * graphHeight;
        addSvg("line", { x1: left, x2: width - right, y1: y, y2: y, stroke: "#dce1e6", "stroke-width": "1" });
        addSvg("text", { x: left - 8, y: y + 4, "text-anchor": "end", fill: "#59636d", "font-size": "11" }, percent + "%");
      }
      addSvg("line", { x1: left, x2: width - right, y1: top + graphHeight, y2: top + graphHeight, stroke: "#8d98a3", "stroke-width": "1" });
      const coordinates = chart.points.map((point) => {
        const x = left + (point.atMs / duration) * graphWidth;
        const y = top + graphHeight - (point.percent / 100) * graphHeight;
        return x.toFixed(1) + "," + y.toFixed(1);
      }).join(" ");
      addSvg("polyline", { points: coordinates, fill: "none", stroke: "#1769aa", "stroke-width": "2", "stroke-linejoin": "round", "stroke-linecap": "round" });
      addSvg("text", { x: left, y: height - 10, fill: "#59636d", "font-size": "11" }, "0s");
      addSvg("text", { x: width - right, y: height - 10, "text-anchor": "end", fill: "#59636d", "font-size": "11" }, (duration / 1000).toFixed(1) + "s");
      wrapper.append(svg, element("div", chart.label + " · x-axis: time since page opened · y-axis: page scrolled", "scroll-chart-note"));
      container.append(wrapper);
    }
    function addScrollProfile(container, metric, replayPage) {
      const profile = jsonObject(metric.scrollProfile);
      const events = Number(profile.events) || 0;
      const facts = element("div", undefined, "facts");
      addFact(facts, (metric.scrollDepth || 0) + "%", "deepest depth");
      addFact(facts, events, "scroll events");
      addFact(facts, Number(profile.directionChanges) || 0, "direction reversals");
      container.append(facts);
      renderScrollChart(container, scrollChartPoints(replayPage, profile));
      if (!events) { container.append(element("p", "No movement was recorded on this page.")); return; }
      const lines = element("ul", undefined, "behavior-lines");
      const intervals = (Number(profile.avgIntervalMs) || 0) + " ms average ± " + (Number(profile.intervalStdDevMs) || 0) + " ms";
      const velocity = (Number(profile.avgVelocityPxPerSecond) || 0).toLocaleString() + " px/s average; " + Math.round((Number(profile.velocityVariation) || 0) * 100) + "% variation";
      const physicalInputs = (Number(profile.wheelEvents) || 0) + (Number(profile.touchEvents) || 0) + (Number(profile.keyScrollEvents) || 0);
      lines.append(element("li", (Number(profile.bursts) || 0) + " scroll bursts; timing: " + intervals));
      lines.append(element("li", "velocity: " + velocity));
      lines.append(element("li", "pauses: " + (Number(profile.pauses500Ms) || 0) + " ≥ 0.5 s; " + (Number(profile.pauses2000Ms) || 0) + " ≥ 2 s"));
      lines.append(element("li", "input: " + (Number(profile.wheelEvents) || 0) + " wheel, " + (Number(profile.touchEvents) || 0) + " touch, " + (Number(profile.keyScrollEvents) || 0) + " keyboard; " + (Number(profile.inputLinkedScrolls) || 0) + "/" + events + " scrolls linked to recent input"));
      lines.append(element("li", (Number(profile.pointerMoves) || 0) + " sampled pointer moves; " + (Number(profile.pointerClicks) || 0) + " clicks; " + physicalInputs + " total scroll-input events"));
      container.append(lines);
      const trajectory = jsonArray(profile.trajectory);
      if (trajectory.length) {
        const details = element("details", undefined, "trajectory");
        details.append(element("summary", "Scroll trajectory (" + trajectory.length + " sampled points)"));
        details.append(element("div", trajectory.map((point) => ((Number(point[0]) || 0) / 1000).toFixed(1) + "s: " + (Number(point[1]) || 0) + "%").join("  →  "), "mono"));
        container.append(details);
      }
    }
    function appendSection(title) { const section = element("section", undefined, "report-section"); section.append(element("h3", title)); reportContent.append(section); return section; }
    function replayActionLabel(event) {
      const payload = jsonObject(event.payload);
      if (event.type === "lightbox_open") return "Opened image: " + (payload.imageAlt || payload.imageSrc || "image");
      if (event.type === "lightbox_close") return "Closed image lightbox";
      if (event.type === "action") return actionName(payload.action);
      if (event.type === "navigation") return "Navigated to " + (payload.target || "another page");
      return event.type;
    }
    function replayPages(visit) {
      return jsonArray(visit.replay_pages).map((replayPage) => {
        const legacyEvents = jsonArray(replayPage.events).map((event) => ({ ...event, payload: jsonObject(event.payload) }));
        const chunkEvents = jsonArray(replayPage.chunks)
          .sort((first, second) => Number(first.index) - Number(second.index))
          .flatMap((chunk) => jsonArray(chunk.events))
          .map((event) => Array.isArray(event) ? {
            index: event[0], atMs: event[1], type: event[2], payload: jsonObject(event[3])
          } : { ...event, payload: jsonObject(event.payload) });
        return { ...replayPage, events: [...legacyEvents, ...chunkEvents] };
      }).sort((first, second) => String(first.startedAt).localeCompare(String(second.startedAt)));
    }
    function makeReplayUrl(page) {
      const url = new URL(page || "/", "https://gfse18.github.io");
      url.searchParams.set("portfolioReplay", "1");
      return url.toString();
    }
    function buildReplay(visit) {
      stopReplay();
      replayContent.replaceChildren();
      const pages = replayPages(visit);
      if (!pages.length) {
        replayContent.append(element("p", "Replay data is available only for sessions recorded after this update was published."));
        stopReplay = () => {};
        return;
      }

      const heading = element("h3", "Simulated page replay");
      const intro = element("p", "This is an interactive reconstruction from recorded scrolling and site actions, not a screen recording.");
      const pageSelect = element("select");
      for (const replayPage of pages) {
        const option = element("option", replayPage.page + " · " + formatTime(replayPage.startedAt));
        option.value = replayPage.pageInstanceId;
        pageSelect.append(option);
      }
      const controls = element("div", undefined, "replay-controls");
      const playButton = element("button", "Play"); playButton.type = "button";
      const timeLabel = element("span", "0:00 / 0:00");
      const speed = element("select");
      for (const value of ["0.5", "1", "2"]) { const option = element("option", value + "×"); option.value = value; if (value === "1") option.selected = true; speed.append(option); }
      const scrubber = element("input"); scrubber.type = "range"; scrubber.min = "0"; scrubber.value = "0"; scrubber.step = "10";
      controls.append(playButton, pageSelect, scrubber, timeLabel, speed);
      const stage = element("div", undefined, "replay-stage");
      const viewport = element("div", undefined, "replay-viewport");
      const frame = document.createElement("iframe");
      frame.className = "replay-frame";
      frame.title = "Simulated visitor page replay";
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
      viewport.append(frame); stage.append(viewport);
      const meta = element("div", undefined, "replay-meta");
      const eventList = element("ul", undefined, "replay-events");
      replayContent.append(heading, intro, controls, stage, meta, eventList);

      let selected = pages[0];
      let currentTime = 0;
      let playing = false;
      let animationFrame = null;
      let startedWallTime = 0;
      let startedReplayTime = 0;
      let frameReady = false;
      let lastLightboxState = "";
      const portfolioOrigin = "https://gfse18.github.io";

      function formatReplayTime(ms) {
        const seconds = Math.max(0, Math.round(ms / 1000));
        return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
      }
      function selectedEvents() {
        return selected.events.slice().sort((a, b) => Number(a.atMs) - Number(b.atMs));
      }
      function duration() {
        return Math.max(1000, ...selectedEvents().map((event) => Number(event.atMs) || 0));
      }
      function scrollYAt(time) {
        const points = selectedEvents().filter((event) => event.type === "scroll");
        if (!points.length) return 0;
        let previous = points[0];
        for (const next of points.slice(1)) {
          if (time <= Number(next.atMs)) {
            const span = Math.max(1, Number(next.atMs) - Number(previous.atMs));
            const progress = Math.max(0, Math.min(1, (time - Number(previous.atMs)) / span));
            return Math.round(Number(previous.payload.scrollY || 0) + (Number(next.payload.scrollY || 0) - Number(previous.payload.scrollY || 0)) * progress);
          }
          previous = next;
        }
        return Number(previous.payload.scrollY) || 0;
      }
      function lightboxAt(time) {
        let state = null;
        for (const event of selectedEvents()) {
          if (Number(event.atMs) > time) break;
          if (event.type === "lightbox_open") state = event;
          if (event.type === "lightbox_close") state = null;
        }
        return state;
      }
      function sendCommand(command) {
        if (frameReady) frame.contentWindow.postMessage({ type: "portfolio-replay-command", command }, portfolioOrigin);
      }
      function applyFrame(time) {
        currentTime = Math.max(0, Math.min(duration(), time));
        scrubber.value = String(currentTime);
        timeLabel.textContent = formatReplayTime(currentTime) + " / " + formatReplayTime(duration());
        sendCommand({ type: "scroll", scrollY: scrollYAt(currentTime) });
        const lightbox = lightboxAt(currentTime);
        const stateKey = lightbox ? "open:" + (lightbox.payload.imageSrc || "") : "closed";
        if (stateKey !== lastLightboxState) {
          lastLightboxState = stateKey;
          sendCommand(lightbox ? { type: "lightbox_open", ...lightbox.payload } : { type: "lightbox_close" });
        }
      }
      function stopPlaying() {
        playing = false; playButton.textContent = "Play";
        if (animationFrame) cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }
      function tick(now) {
        if (!playing) return;
        applyFrame(startedReplayTime + (now - startedWallTime) * Number(speed.value));
        if (currentTime >= duration()) { stopPlaying(); return; }
        animationFrame = requestAnimationFrame(tick);
      }
      function startPlaying() {
        if (currentTime >= duration()) applyFrame(0);
        playing = true; playButton.textContent = "Pause";
        startedWallTime = performance.now(); startedReplayTime = currentTime;
        animationFrame = requestAnimationFrame(tick);
      }
      function configurePage() {
        stopPlaying(); frameReady = false; lastLightboxState = ""; currentTime = 0;
        const width = Math.max(100, Number(selected.viewportWidth) || 1200);
        const height = Math.max(100, Number(selected.viewportHeight) || 800);
        const scale = Math.min(1, 980 / width, 480 / height);
        stage.style.height = Math.round(height * scale) + "px";
        viewport.style.width = width + "px"; viewport.style.height = height + "px";
        viewport.style.transform = "scale(" + scale + ")";
        frame.width = String(width); frame.height = String(height);
        frame.src = makeReplayUrl(selected.page);
        scrubber.max = String(duration());
        meta.replaceChildren(element("span", width + " × " + height + " approximate viewport"), element("span", "Site version: " + (selected.siteVersion || "unknown")), element("span", selectedEvents().filter((event) => event.type === "scroll").length + " scroll samples"));
        eventList.replaceChildren();
        const semanticEvents = selectedEvents().filter((event) => event.type !== "scroll" && event.type !== "pagehide");
        if (!semanticEvents.length) eventList.append(element("li", "No lightbox or tracked-link actions were recorded on this page."));
        for (const event of semanticEvents) eventList.append(element("li", formatReplayTime(event.atMs) + " — " + replayActionLabel(event)));
      }
      frame.addEventListener("load", () => { frameReady = true; lastLightboxState = ""; applyFrame(currentTime); });
      playButton.addEventListener("click", () => playing ? stopPlaying() : startPlaying());
      scrubber.addEventListener("input", () => { stopPlaying(); applyFrame(Number(scrubber.value)); });
      speed.addEventListener("change", () => { if (playing) { startedWallTime = performance.now(); startedReplayTime = currentTime; } });
      pageSelect.addEventListener("change", () => { selected = pages.find((page) => page.pageInstanceId === pageSelect.value) || pages[0]; configurePage(); });
      configurePage();
      stopReplay = () => { stopPlaying(); frame.src = "about:blank"; };
    }
    function showReport(visit) {
      stopReplay();
      showPanel("summary");
      reportContent.replaceChildren();
      const overview = appendSection("Session overview");
      overview.append(element("p", formatTime(visit.first_seen) + " to " + formatTime(visit.last_seen) + " · " + (visit.pageviews || 0) + " views · " + formatDuration(visit.active_seconds) + " active"));
      const pages = appendSection("Pages and scroll behavior");
      const metrics = new Map(jsonArray(visit.page_metrics).map((metric) => [metric.page, metric]));
      const replayByPage = new Map();
      for (const replayPage of replayPages(visit)) replayByPage.set(replayPage.page, replayPage);
      const history = summarizePages(visit);
      if (!history.size) pages.append(element("p", "No page history was recorded."));
      for (const [page, count] of history) {
        const pageReport = element("div", undefined, "page-report");
        pageReport.append(element("h4", count > 1 ? page + " ×" + count : page));
        const metric = metrics.get(page);
        if (metric) { pageReport.append(element("div", formatDuration(metric.activeSeconds) + " active", "secondary")); addScrollProfile(pageReport, metric, replayByPage.get(page)); }
        else pageReport.append(element("p", "No engagement data was recorded for this page."));
        pages.append(pageReport);
      }
      const clicks = appendSection("Tracked clicks");
      const actionCounts = new Map();
      for (const action of jsonArray(visit.actions)) { const label = actionName(action.action); actionCounts.set(label, (actionCounts.get(label) ?? 0) + (Number(action.count) || 1)); }
      if (!actionCounts.size) clicks.append(element("p", "No tracked clicks."));
      for (const [label, count] of actionCounts) clicks.append(element("div", count > 1 ? label + " ×" + count : label));
      const referrer = appendSection("Entry referrer");
      referrer.append(element("div", visit.referrer || "Direct visit or no referrer supplied.", "referrer mono"));
      buildReplay(visit);
      reportDialog.showModal();
    }
    async function loadVisits() {
      tbody.replaceChildren(); const loading = document.createElement("tr"); cell(loading, "Loading...").colSpan = 10; tbody.appendChild(loading);
      try {
        const response = await fetch("/admin-data", { cache: "no-store" }); if (!response.ok) throw new Error("Could not load analytics");
        const visits = await response.json(); tbody.replaceChildren();
        for (const visit of visits) {
          const row = document.createElement("tr");
          cell(row, formatTime(visit.first_seen)); cell(row, formatTime(visit.last_seen)); cell(row, visit.pageviews); cell(row, formatDuration(visit.active_seconds));
          cell(row, visit.device_type ? visit.device_type[0].toUpperCase() + visit.device_type.slice(1) : "Unknown"); cell(row, visit.city); cell(row, visit.region); cell(row, visit.country); cell(row, visit.ip, "mono");
          const reportCell = cell(row, ""); const button = element("button", "View report", "report-button"); button.type = "button"; button.addEventListener("click", () => showReport(visit)); reportCell.append(button);
          tbody.appendChild(row);
        }
        if (!visits.length) { const empty = document.createElement("tr"); cell(empty, "No visits yet.").colSpan = 10; tbody.appendChild(empty); }
      } catch (error) {
        tbody.replaceChildren(); const failed = document.createElement("tr"); cell(failed, error.message).colSpan = 10; tbody.appendChild(failed);
      }
    }
    loadVisits();
  </script>
</body>
</html>`;
