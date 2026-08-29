const ALLOWED_ORIGIN = "https://gfse18.github.io";
const MAX_PAGE_HISTORY = 100;
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
          user_agent
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
        pages
      )
      VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
        ?10, ?11, ?12, ?13, ?14, ?15, ?16, 1, ?17
      )
      ON CONFLICT(session_id) DO UPDATE SET
        last_seen = excluded.last_seen,
        pageviews = visits.pageviews + 1,
        page = excluded.page,
        pages = CASE
          WHEN COALESCE(json_array_length(visits.pages), 0) < ?18
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
        MAX_PAGE_HISTORY
      )
      .run();

    return new Response(null, { status: 204, headers: corsHeaders });
  }
};

function cleanString(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : null;
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
    .pages { min-width: 220px; }
    .pages div + div { margin-top: 4px; }
    .refresh { margin-bottom: 16px; padding: 8px 14px; cursor: pointer; }
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
            <th>First seen</th>
            <th>Last seen</th>
            <th>Views</th>
            <th>City</th>
            <th>State</th>
            <th>Country</th>
            <th>IP</th>
            <th>Pages</th>
            <th>Entry referrer</th>
          </tr>
        </thead>
        <tbody id="visits"><tr><td colspan="9">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
  <script>
    const tbody = document.getElementById("visits");
    document.getElementById("refresh").addEventListener("click", loadVisits);

    function formatTime(value) {
      if (!value) return "";
      return new Date(value).toLocaleString("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short"
      });
    }

    function cell(row, value, className = "") {
      const td = document.createElement("td");
      td.textContent = value ?? "";
      if (className) td.className = className;
      row.appendChild(td);
      return td;
    }

    function pageHistory(visit) {
      if (visit.pages) {
        try {
          const parsed = JSON.parse(visit.pages);
          if (Array.isArray(parsed)) return parsed;
        } catch {}
      }
      return visit.last_page ? [visit.last_page] : [];
    }

    function summarizePages(visit) {
      const counts = new Map();
      for (const page of pageHistory(visit)) {
        const label = page ?? "";
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      return counts;
    }

    async function loadVisits() {
      tbody.replaceChildren();
      const loading = document.createElement("tr");
      cell(loading, "Loading...").colSpan = 9;
      tbody.appendChild(loading);

      try {
        const response = await fetch("/admin-data", { cache: "no-store" });
        if (!response.ok) throw new Error("Could not load analytics");
        const visits = await response.json();
        tbody.replaceChildren();

        for (const visit of visits) {
          const row = document.createElement("tr");
          cell(row, formatTime(visit.first_seen));
          cell(row, formatTime(visit.last_seen));
          cell(row, visit.pageviews);
          cell(row, visit.city);
          cell(row, visit.region);
          cell(row, visit.country);
          cell(row, visit.ip, "mono");

          const pagesCell = cell(row, "", "pages mono");
          for (const [page, count] of summarizePages(visit)) {
            const item = document.createElement("div");
            item.textContent = count > 1 ? page + " ×" + count : page;
            pagesCell.appendChild(item);
          }

          cell(row, visit.referrer);
          tbody.appendChild(row);
        }

        if (visits.length === 0) {
          const empty = document.createElement("tr");
          cell(empty, "No visits yet.").colSpan = 9;
          tbody.appendChild(empty);
        }
      } catch (error) {
        tbody.replaceChildren();
        const failed = document.createElement("tr");
        cell(failed, error.message).colSpan = 9;
        tbody.appendChild(failed);
      }
    }

    loadVisits();
  </script>
</body>
</html>`;
