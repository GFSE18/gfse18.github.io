const ALLOWED_ORIGIN = "https://gfse18.github.io";
const MAX_PAGE_HISTORY = 100;
const REPORT_TIME_ZONE = "America/New_York";
const DEVICE_TYPES = new Set(["desktop", "mobile", "tablet"]);
const TRACKED_ACTIONS = new Set([
  "resume_open",
  "email_click",
  "github_click"
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
          ), '[]') AS actions
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

    await sendDailyReport(env, easternTime.date);
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
    dialog { width: min(760px, calc(100vw - 32px)); max-height: min(820px, calc(100vh - 48px)); border: 0; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,.3); padding: 0; color: #222; }
    dialog::backdrop { background: rgba(0,0,0,.42); }
    .report-header { display: flex; gap: 16px; align-items: center; justify-content: space-between; padding: 20px 24px; border-bottom: 1px solid #e5e5e5; }
    .report-header h2 { margin: 0; }
    .close { border: 1px solid #999; border-radius: 5px; background: white; }
    .report-content { padding: 0 24px 24px; }
    .report-section { padding: 20px 0; border-bottom: 1px solid #e9e9e9; }
    .report-section:last-child { border-bottom: 0; }
    .report-section h3 { margin: 0 0 10px; font-size: 16px; }
    .page-report + .page-report { border-top: 1px solid #eee; margin-top: 18px; padding-top: 18px; }
    .page-report h4 { margin: 0 0 8px; font-family: monospace; font-size: 14px; }
    .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 12px 0; }
    .fact { background: #f6f7f8; border-radius: 6px; padding: 9px; font-size: 13px; }
    .fact strong { display: block; font-size: 15px; margin-bottom: 2px; }
    .behavior-lines { margin: 0; padding-left: 18px; line-height: 1.5; }
    .trajectory { margin-top: 10px; font-size: 12px; line-height: 1.5; word-break: break-word; }
    .referrer { overflow-wrap: anywhere; }
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
    <div class="report-content" id="report-content"></div>
  </dialog>
  <script>
    const tbody = document.getElementById("visits");
    const reportDialog = document.getElementById("session-report");
    const reportContent = document.getElementById("report-content");
    document.getElementById("refresh").addEventListener("click", loadVisits);
    document.getElementById("close-report").addEventListener("click", () => reportDialog.close());

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
    function addScrollProfile(container, metric) {
      const profile = jsonObject(metric.scrollProfile);
      const events = Number(profile.events) || 0;
      const facts = element("div", undefined, "facts");
      addFact(facts, (metric.scrollDepth || 0) + "%", "deepest depth");
      addFact(facts, (Number(profile.distancePx) || 0).toLocaleString() + " px", "scroll distance");
      addFact(facts, events, "scroll events");
      addFact(facts, Number(profile.directionChanges) || 0, "direction reversals");
      container.append(facts);
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
    function showReport(visit) {
      reportContent.replaceChildren();
      const overview = appendSection("Session overview");
      overview.append(element("p", formatTime(visit.first_seen) + " to " + formatTime(visit.last_seen) + " · " + (visit.pageviews || 0) + " views · " + formatDuration(visit.active_seconds) + " active"));
      const pages = appendSection("Pages and scroll behavior");
      const metrics = new Map(jsonArray(visit.page_metrics).map((metric) => [metric.page, metric]));
      const history = summarizePages(visit);
      if (!history.size) pages.append(element("p", "No page history was recorded."));
      for (const [page, count] of history) {
        const pageReport = element("div", undefined, "page-report");
        pageReport.append(element("h4", count > 1 ? page + " ×" + count : page));
        const metric = metrics.get(page);
        if (metric) { pageReport.append(element("div", formatDuration(metric.activeSeconds) + " active", "secondary")); addScrollProfile(pageReport, metric); }
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
