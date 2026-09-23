const BASE_URL = "https://www.castles-th.com";
const JOB_URLS = {
  field: "https://www.castles-th.com/fldjobs",
  remaining: "https://www.castles-th.com/showarea/3",
};

const FIELD_HEADERS = [
  "วันที่รับแจ้ง",
  "ธนาคาร",
  "ประเภทงาน",
  "TID",
  "MID",
  "ชื่อร้านค้า",
  "จังหวัด",
  "สถานะ",
  "#",
];

const REMAINING_HEADERS = [
  "Terminal ID",
  "Merchant Name",
  "Job Number",
  "Job Open Date",
  "SLA Date",
  "สถานะงาน",
  "Service Code",
  "จังหวัด",
];

const TARGET_PROVINCE = "ชลบุรี";
const TARGET_DISTRICTS = ["พานทอง", "พนัสนิคม", "เกาะจันทร์", "เมือง", "บ้านบึง", "บ่อทอง"];

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response(pageHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "edms-line-worker" });
    }

    if (url.pathname === "/api/auth") {
      if (!isAuthorized(request, env)) {
        return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
      }
      return jsonResponse({ ok: true });
    }

    if (url.pathname === "/api/config") {
      if (!isAuthorized(request, env)) {
        return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
      }
      if (request.method === "GET") {
        return jsonResponse({ ok: true, config: await readConfig(env), lastSent: await getLastSent(env) });
      }
      if (request.method === "POST") {
        const configStore = getConfigStore(env);
        if (!configStore) {
          return jsonResponse({ ok: false, error: "KV binding EDMS_CONFIG is not configured." }, 500);
        }
        const body = await request.json();
        const current = await readConfig(env);
        const next = {
          alertEnabled: Boolean(body.alertEnabled),
          alertTime: validAlertTime(body.alertTime) ? body.alertTime : current.alertTime,
          notifyWhenEmpty: Boolean(body.notifyWhenEmpty),
        };
        await configStore.put("config", JSON.stringify(next));
        return jsonResponse({ ok: true, config: next });
      }
    }

    if (url.pathname === "/run" || url.pathname === "/api/run") {
      if (!isAuthorized(request, env)) {
        return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
      }
      const sendLine = url.searchParams.get("send") === "1";
      const result = await runAndMaybeNotify(env, { sendLine, source: "manual" });
      return jsonResponse(result, result.ok ? 200 : 500);
    }

    return jsonResponse({ ok: false, error: "Not found" }, 404);
  },
};

async function runScheduled(env) {
  const config = await readConfig(env);
  if (!config.alertEnabled) {
    return { ok: true, skipped: true, reason: "Alert disabled." };
  }

  const now = bangkokHHMM();
  const configStore = getConfigStore(env);
  if (now !== config.alertTime) {
    return { ok: true, skipped: true, reason: "Not scheduled time." };
  }

  const todayKey = bangkokDateKey();
  if (configStore) {
    const lastSent = await configStore.get("last_sent_date");
    if (lastSent === todayKey) {
      return { ok: true, skipped: true, reason: "Already sent today." };
    }
    const lockKey = `send_lock:${todayKey}`;
    if (await configStore.get(lockKey)) {
      return { ok: true, skipped: true, reason: "Send already in progress." };
    }
    await configStore.put(lockKey, new Date().toISOString(), { expirationTtl: 3600 });
  }

  const result = await runAndMaybeNotify(env, { sendLine: true, source: "cron" });
  if (result.ok && result.sentLine && configStore) {
    await configStore.put("last_sent_date", todayKey);
  }
  return result;
}

async function runAndMaybeNotify(env, options) {
  try {
    const config = await readConfig(env);
    if (!config.alertEnabled) {
      return { ok: true, disabled: true, sentLine: false, message: "EDMS LINE alert is disabled." };
    }

    const report = await collectJobs(env, { onlyToday: envBool(env.ONLY_TODAY, true) });
    const message = buildMessage(report);
    const hasJobs = report.fieldJobs.length > 0 || report.remainingJobs.length > 0;
    let lineResponse = null;

    if (options.sendLine && (hasJobs || config.notifyWhenEmpty)) {
      lineResponse = await sendLineMessage(env, message);
    }

    return {
      ok: true,
      source: options.source,
      sentLine: Boolean(lineResponse),
      hasJobs,
      lineResponse,
      message,
      report,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, source: options.source, sentLine: false, error: message };
  }
}

async function readConfig(env) {
  const fallback = {
    alertEnabled: envBool(env.EDMS_ALERT_ENABLED, true),
    alertTime: validAlertTime(env.ALERT_TIME) ? env.ALERT_TIME : "07:00",
    notifyWhenEmpty: envBool(env.NOTIFY_WHEN_EMPTY, true),
  };
  const configStore = getConfigStore(env);
  if (!configStore) {
    return fallback;
  }
  const raw = await configStore.get("config");
  if (!raw) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      alertEnabled: typeof parsed.alertEnabled === "boolean" ? parsed.alertEnabled : fallback.alertEnabled,
      alertTime: validAlertTime(parsed.alertTime) ? parsed.alertTime : fallback.alertTime,
      notifyWhenEmpty: typeof parsed.notifyWhenEmpty === "boolean" ? parsed.notifyWhenEmpty : fallback.notifyWhenEmpty,
    };
  } catch {
    return fallback;
  }
}

function getConfigStore(env) {
  return env.EDMS_CONFIG || env.edms_config || null;
}

async function getLastSent(env) {
  const configStore = getConfigStore(env);
  if (!configStore) {
    return null;
  }
  return (await configStore.get("last_sent_date")) || null;
}

function validAlertTime(value) {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isAuthorized(request, env) {
  if (!env.ADMIN_TOKEN) {
    return false;
  }
  const auth = request.headers.get("Authorization") || "";
  const prefix = "Bearer ";
  if (!auth.startsWith(prefix)) {
    return false;
  }
  return timingSafeEqual(auth.slice(prefix.length), env.ADMIN_TOKEN);
}

function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  // Compare against a fixed length so the loop count never depends on the secret.
  let mismatch = aBytes.length ^ bBytes.length;
  for (let i = 0; i < aBytes.length; i++) {
    mismatch |= aBytes[i] ^ (bBytes[i] ?? 0);
  }
  return mismatch === 0;
}

async function collectJobs(env, options) {
  const today = thaiToday();
  const session = await buildAuthenticatedSession(env);
  const errors = [];

  let fieldRows = [];
  let remainingRows = [];

  try {
    const html = await session.get(JOB_URLS.field);
    fieldRows = firstTableRowsWithHeaders(html, FIELD_HEADERS);
  } catch (error) {
    errors.push(`${JOB_URLS.field}: ${errorMessage(error)}`);
  }

  try {
    const html = await session.get(JOB_URLS.remaining);
    remainingRows = firstTableRowsWithHeaders(html, REMAINING_HEADERS);
  } catch (error) {
    errors.push(`${JOB_URLS.remaining}: ${errorMessage(error)}`);
  }

  const fieldJobs = [];
  for (const row of fieldRows) {
    const enriched = await enrichJobDetail(row, session, errors, "field detail");
    if (options.onlyToday && normalizeThaiDate(detailPlanDate(enriched)) !== today) {
      continue;
    }
    fieldJobs.push(enriched);
  }

  const remainingJobs = [];
  for (const row of remainingRows) {
    const enriched = await enrichJobDetail(row, session, errors, "remaining detail");
    if (!isTargetChonburiArea(enriched)) {
      continue;
    }
    if (options.onlyToday && !isInRequestToSlaRange(enriched, today)) {
      continue;
    }
    remainingJobs.push(enriched);
  }

  return { today, fieldJobs, remainingJobs, errors };
}

async function buildAuthenticatedSession(env) {
  const cookieJar = new Map();
  const fixedCookie = (env.EDMS_COOKIE || "").trim();
  const loginUrl = env.EDMS_LOGIN_URL || "https://www.castles-th.com/login";

  const session = {
    async get(url) {
      const response = await requestWithCookies(url, { method: "GET" }, cookieJar, fixedCookie);
      ensureNotRegisterPage(response.url, response.html);
      return response.html;
    },
    async post(url, body) {
      const response = await requestWithCookies(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(body).toString(),
        },
        cookieJar,
        fixedCookie,
      );
      ensureNotRegisterPage(response.url, response.html);
      return response;
    },
  };

  if (fixedCookie) {
    return session;
  }

  if (!env.EDMS_USERNAME || !env.EDMS_PASSWORD) {
    throw new Error("Missing EDMS_COOKIE or EDMS_USERNAME/EDMS_PASSWORD secrets.");
  }

  const loginHtml = await session.get(loginUrl);
  const form = parseLoginForm(loginHtml, loginUrl);
  if (!form) {
    throw new Error("Cannot find EDMS login form.");
  }

  const payload = { ...form.inputs };
  const usernameField = Object.keys(payload).find((key) => key === "user_name")
    || Object.keys(payload).find((key) => /user|email/i.test(key))
    || "user_name";
  const passwordField = Object.keys(payload).find((key) => key === "password")
    || Object.keys(payload).find((key) => /pass/i.test(key))
    || "password";
  payload[usernameField] = env.EDMS_USERNAME;
  payload[passwordField] = env.EDMS_PASSWORD;

  const loginResponse = await session.post(form.action, payload);
  if (/\/login/i.test(loginResponse.url) || /name=["']password["']/i.test(loginResponse.html)) {
    throw new Error("EDMS login failed. Check EDMS_USERNAME/EDMS_PASSWORD.");
  }

  return session;
}

async function requestWithCookies(url, init, cookieJar, fixedCookie, depth = 0) {
  if (depth > 5) {
    throw new Error(`Too many redirects while fetching ${url}`);
  }

  const headers = new Headers(init.headers || {});
  headers.set("User-Agent", "Mozilla/5.0 EDMS Cloudflare Worker job notifier");
  headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  const cookie = fixedCookie || serializeCookies(cookieJar);
  if (cookie) {
    headers.set("Cookie", cookie);
  }

  const response = await fetch(url, { ...init, headers, redirect: "manual" });
  storeSetCookies(cookieJar, response.headers);

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("Location");
    if (!location) {
      throw new Error(`Redirect without Location from ${url}`);
    }
    const nextUrl = new URL(location, url).toString();
    const nextInit = response.status === 307 || response.status === 308
      ? init
      : { method: "GET" };
    return requestWithCookies(nextUrl, nextInit, cookieJar, fixedCookie, depth + 1);
  }

  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }

  return { url: response.url || url, html: await response.text() };
}

function storeSetCookies(cookieJar, headers) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : splitSetCookieHeader(headers.get("Set-Cookie"));
  for (const value of values) {
    const first = value.split(";")[0];
    const index = first.indexOf("=");
    if (index > 0) {
      cookieJar.set(first.slice(0, index).trim(), first.slice(index + 1).trim());
    }
  }
}

function splitSetCookieHeader(value) {
  if (!value) {
    return [];
  }
  return value.split(/,\s*(?=[^;,]+=)/g);
}

function serializeCookies(cookieJar) {
  return [...cookieJar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

function ensureNotRegisterPage(finalUrl, html) {
  if (/\/register/i.test(finalUrl) || /password_confirmation/i.test(html)) {
    throw new Error("Unexpected EDMS registration page detected. Stop without filling sign-up data.");
  }
}

function parseLoginForm(html, loginUrl) {
  const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)];
  for (const formMatch of forms) {
    const formHtml = formMatch[0];
    if (!/<input\b[^>]*type=["']?password/i.test(formHtml)) {
      continue;
    }
    const attrs = parseAttrs(formHtml.match(/<form\b([^>]*)>/i)?.[1] || "");
    const inputs = {};
    for (const inputMatch of formHtml.matchAll(/<input\b([^>]*)>/gi)) {
      const inputAttrs = parseAttrs(inputMatch[1]);
      if (inputAttrs.name) {
        inputs[inputAttrs.name] = inputAttrs.value || "";
      }
    }
    return {
      action: new URL(attrs.action || loginUrl, loginUrl).toString(),
      inputs,
    };
  }
  return null;
}

function parseAttrs(raw) {
  const attrs = {};
  for (const match of raw.matchAll(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attrs[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function firstTableRowsWithHeaders(html, fallbackHeaders) {
  const tables = parseTables(html);
  if (tables.length === 0) {
    return [];
  }
  let bestRows = [];
  let bestScore = -1;
  for (const table of tables) {
    const rows = rowsWithHeaders(table, fallbackHeaders);
    const viewCount = rows.filter((row) => String(row["#"] || row.View || "").toLowerCase() === "view").length;
    const score = rows.length + viewCount;
    if (score > bestScore) {
      bestScore = score;
      bestRows = rows;
    }
  }
  return bestRows;
}

function rowsWithHeaders(tableRows, fallbackHeaders) {
  const rows = [];
  for (const cells of tableRows) {
    const texts = cells.map((cell) => cell.text);
    if (!texts.some(Boolean)) {
      continue;
    }
    if (texts.some((text) => fallbackHeaders.includes(text))) {
      continue;
    }
    const row = {};
    fallbackHeaders.forEach((header, index) => {
      if (cells[index]) {
        row[header] = cells[index].text;
        if (cells[index].href) {
          row[`${header} URL`] = cells[index].href;
        }
      }
    });
    rows.push(row);
  }
  return rows;
}

function parseTables(html) {
  const tables = [];
  for (const tableMatch of html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)) {
    const tableHtml = tableMatch[0];
    const rows = [];
    for (const rowMatch of tableHtml.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
      const rowHtml = rowMatch[0];
      const cells = [];
      for (const cellMatch of rowHtml.matchAll(/<(td|th)\b[^>]*>[\s\S]*?<\/\1>/gi)) {
        const cellHtml = cellMatch[0];
        const href = cellHtml.match(/<a\b[^>]*href=["']([^"']+)["']/i)?.[1];
        cells.push({
          text: htmlToText(cellHtml),
          href: href ? new URL(decodeHtml(href), BASE_URL).toString() : "",
        });
      }
      if (cells.some((cell) => cell.text)) {
        rows.push(cells);
      }
    }
    if (rows.length > 0) {
      tables.push(rows);
    }
  }
  return tables;
}

async function enrichJobDetail(row, session, errors, label) {
  const detailUrl = row["# URL"] || row["View URL"] || row["Terminal ID URL"];
  if (!detailUrl) {
    return row;
  }
  try {
    const detailHtml = await session.get(detailUrl);
    const fields = parseDetailFields(detailHtml);
    const enriched = { ...row, "Detail URL": detailUrl };
    for (const [key, value] of Object.entries(fields)) {
      enriched[`Detail ${key}`] = value;
    }
    return enriched;
  } catch (error) {
    errors.push(`${detailUrl || label}: ${errorMessage(error)}`);
    return row;
  }
}

function parseDetailFields(html) {
  const texts = htmlToTextList(html);
  const fields = { "All Text": texts.join(" ") };
  const labels = new Set([
    "Bank:",
    "Job Type:",
    "Job No.",
    "Job No:",
    "Office Code:",
    "Request Date:",
    "Request Time:",
    "Plan Date:",
    "Plan Time:",
    "SLA Date:",
    "SLA Time:",
  ]);

  texts.forEach((text, index) => {
    if (labels.has(text) && texts[index + 1]) {
      fields[text.replace(/[:.]$/, "")] = texts[index + 1];
    }
  });
  applyDateFallbacks(fields);

  return fields;
}

function applyDateFallbacks(fields) {
  const allText = fields["All Text"] || "";
  const dateLabels = [
    ["Request Date", /Request\s*Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i],
    ["Plan Date", /Plan\s*Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i],
    ["SLA Date", /SLA\s*Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i],
  ];
  const timeLabels = [
    ["Request Time", /Request\s*Time:\s*([0-2]?\d:[0-5]\d)/i],
    ["Plan Time", /Plan\s*Time:\s*([0-2]?\d:[0-5]\d)/i],
    ["SLA Time", /SLA\s*Time:\s*([0-2]?\d:[0-5]\d)/i],
  ];
  for (const [key, pattern] of [...dateLabels, ...timeLabels]) {
    if (!fields[key]) {
      const match = allText.match(pattern);
      if (match) {
        fields[key] = match[1];
      }
    }
  }
}

function htmlToTextList(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .split(/\n+/)
    .map((text) => decodeHtml(text).replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function htmlToText(html) {
  return decodeHtml(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function decodeHtml(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function thaiToday() {
  const now = new Date();
  const bangkok = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const day = String(bangkok.getUTCDate()).padStart(2, "0");
  const month = String(bangkok.getUTCMonth() + 1).padStart(2, "0");
  const year = bangkok.getUTCFullYear() + 543;
  return `${day}/${month}/${year}`;
}

function bangkokHHMM() {
  const now = new Date();
  const bangkok = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return `${String(bangkok.getUTCHours()).padStart(2, "0")}:${String(bangkok.getUTCMinutes()).padStart(2, "0")}`;
}

function bangkokDateKey() {
  const now = new Date();
  const bangkok = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return `${bangkok.getUTCFullYear()}-${String(bangkok.getUTCMonth() + 1).padStart(2, "0")}-${String(bangkok.getUTCDate()).padStart(2, "0")}`;
}

function normalizeThaiDate(value) {
  const datePart = String(value || "").trim().split(/\s+/)[0];
  const pieces = datePart.split("/");
  if (pieces.length !== 3 || pieces.some((piece) => !/^\d+$/.test(piece))) {
    return datePart;
  }
  return `${String(Number(pieces[0])).padStart(2, "0")}/${String(Number(pieces[1])).padStart(2, "0")}/${pieces[2]}`;
}

function compactThaiDate(value) {
  const datePart = normalizeThaiDate(value);
  const pieces = datePart.split("/");
  if (pieces.length !== 3 || pieces.some((piece) => !/^\d+$/.test(piece))) {
    return String(value || "");
  }
  return `${Number(pieces[0])}/${Number(pieces[1])}/${pieces[2]}`;
}

function thaiDateToDate(value) {
  const pieces = normalizeThaiDate(value).split("/");
  if (pieces.length !== 3 || pieces.some((piece) => !/^\d+$/.test(piece))) {
    return null;
  }
  let year = Number(pieces[2]);
  if (year >= 2400) {
    year -= 543;
  }
  const month = Number(pieces[1]);
  const day = Number(pieces[0]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function isInRequestToPlanRange(row, today) {
  const todayDate = thaiDateToDate(today);
  const requestDate = thaiDateToDate(firstValue(row, ["Detail Request Date", "Job Open Date"]));
  const planDate = thaiDateToDate(detailPlanDate(row) || firstValue(row, ["SLA Date"]));
  if (!todayDate || !requestDate || !planDate) {
    return false;
  }
  return requestDate <= todayDate && todayDate <= planDate;
}

function isInRequestToSlaRange(row, today) {
  const todayDate = thaiDateToDate(today);
  const requestDate = thaiDateToDate(firstValue(row, ["Detail Request Date", "Job Open Date"]));
  const slaDate = thaiDateToDate(firstValue(row, ["Detail SLA Date", "SLA Date"]));
  if (!todayDate || !requestDate || !slaDate) {
    return false;
  }
  return requestDate <= todayDate && todayDate <= slaDate;
}

function detailPlanDate(row) {
  if (row["Detail Plan Date"]) {
    return row["Detail Plan Date"];
  }
  const allText = row["Detail All Text"] || row["All Text"] || rowText(row);
  const match = String(allText).match(/Plan\s*Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
  return match ? match[1] : "";
}

function isTargetChonburiArea(row) {
  const text = areaText(row);
  const province = firstValue(row, ["จังหวัด", "Detail จังหวัด", "Detail Province", "Province"]);
  const hasChonburi = province.includes(TARGET_PROVINCE) || text.includes(TARGET_PROVINCE) || text.toUpperCase().includes("CHONBURI");
  return hasChonburi && Boolean(targetDistrict(row));
}

function targetDistrict(row) {
  const text = areaText(row);
  return TARGET_DISTRICTS.find((district) => {
    const markers = [`อ.${district}`, `อำเภอ${district}`, `เขต${district}`, district];
    return markers.some((marker) => text.includes(marker));
  }) || "";
}

function firstValue(row, keys) {
  for (const key of keys) {
    if (row[key]) {
      return row[key];
    }
  }
  return "";
}

function rowText(row) {
  return Object.values(row).filter(Boolean).join(" ");
}

function areaText(row) {
  return [
    row["จังหวัด"],
    row["Detail Site Address"],
    extractSiteAddress(row),
    row["Detail แขวง/ตำบล"],
    row["Detail เขต/อำเภอ"],
    row["Detail จังหวัด"],
    row["Detail Sale Slip Line2"],
  ].filter(Boolean).join(" ");
}

function extractSiteAddress(row) {
  const text = String(row["Detail All Text"] || row["All Text"] || "");
  const match = text.match(/Site Address:\s*([\s\S]*?)(?:Service SLA:|Contact Name:|Phone No:|Marketing Bank:|ชื่อร้านค้า:|Sale Slip Line1:)/);
  return match ? match[1].trim() : "";
}

function jobCategory(row) {
  const typeText = [
    row["ประเภทงาน"],
    row["Detail Job Type"],
    row["Job Type"],
    row["Service Code"],
  ].filter(Boolean).join(" ").toLowerCase();
  const text = typeText || rowText(row).toLowerCase();
  if (text.includes("de-install") || text.includes("de installation")) {
    return "deinstall";
  }
  if (text.includes("initialization") || text.includes("initialisation")) {
    return "initial";
  }
  if (text.includes("install") || text.includes("installation")) {
    return "install";
  }
  if (text.includes("service") || text.includes("ตรวจเช็ค") || text.includes("เปลี่ยนเครื่อง")) {
    return "service";
  }
  return "install";
}

function buildMessage(report) {
  const categories = {
    service: [],
    initial: [],
    install: [],
    deinstall: [],
  };
  const seen = new Set();
  const fieldTids = new Set();

  const addJob = (category, row) => {
    const tid = terminalId(row);
    const seenKey = `${category}:${tid}`;
    if (seen.has(seenKey)) return;
    seen.add(seenKey);
    categories[category].push(tid);
  };

  for (const row of report.fieldJobs) {
    fieldTids.add(terminalId(row));
    addJob(jobCategory(row), row);
  }

  for (const row of report.remainingJobs) {
    if (fieldTids.has(terminalId(row))) continue;
    addJob("service", row);
  }

  const { service, initial, install, deinstall } = categories;
  const lines = [`Plan onsite ${compactThaiDate(report.today)}`];
  if (service.length) {
    lines.push("Service", ...service);
  }
  if (initial.length) {
    lines.push("Initial", ...initial);
  }
  if (install.length) {
    lines.push("Install", ...install);
  }
  if (deinstall.length) {
    lines.push("De-install", ...deinstall);
  }
  if (!service.length && !initial.length && !install.length && !deinstall.length) {
    lines.push("standby service");
  }
  lines.push(TARGET_PROVINCE);
  if (report.errors.length) {
    lines.push("", "เช็คบางหน้าไม่สำเร็จ:", ...report.errors);
  }
  return lines.join("\n");
}

function terminalId(row) {
  return row["Terminal ID"] || row.TID || "-";
}

async function sendLineMessage(env, message) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN || !env.LINE_TO) {
    throw new Error("Missing LINE_CHANNEL_ACCESS_TOKEN or LINE_TO secrets.");
  }

  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: env.LINE_TO,
      messages: [{ type: "text", text: message.slice(0, 5000) }],
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`LINE API error ${response.status}: ${body}`);
  }
  return { status: response.status, body };
}

function envBool(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function pageHtml() {
  return `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>EDMS LINE Worker</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; }
    :root {
      --green: #06C755;
      --green-dark: #05a847;
      --ink: #0f1b24;
      --muted: #6b7a86;
      --line: #e4ebef;
      --bg: #eef2f5;
      --card: #ffffff;
    }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: 'Sarabun', system-ui, -apple-system, 'Segoe UI', Tahoma, sans-serif;
      color: var(--ink);
      background: radial-gradient(1100px 480px at 50% -220px, #d7f4e3 0%, var(--bg) 55%);
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 13px 24px;
      background: rgba(255, 255, 255, 0.85);
      backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--line);
      position: sticky;
      top: 0;
      z-index: 5;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-mark {
      width: 42px;
      height: 42px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 700;
      color: #fff;
      background: linear-gradient(135deg, var(--green), #00b894);
      box-shadow: 0 6px 16px rgba(6, 199, 85, 0.35);
    }
    .brand-text h1 { font-size: 17px; margin: 0; font-weight: 700; }
    .brand-text p { font-size: 12px; margin: 2px 0 0; color: var(--muted); }
    .status-pill {
      font-size: 13px;
      font-weight: 600;
      color: #475a67;
      background: #eef2f5;
      border: 1px solid var(--line);
      padding: 6px 14px;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      white-space: nowrap;
    }
    .status-pill::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 0 3px rgba(6, 199, 85, 0.2);
    }
    main {
      max-width: 760px;
      margin: 0 auto;
      padding: 24px;
      display: grid;
      gap: 16px;
    }
    .login-wrap { align-content: center; min-height: calc(100vh - 80px); }
    .hidden { display: none; }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 20px 22px;
      box-shadow: 0 1px 2px rgba(16, 40, 60, 0.04), 0 8px 24px rgba(16, 40, 60, 0.05);
    }
    .card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 16px;
    }
    h2 { font-size: 16px; margin: 0; font-weight: 700; }
    .muted { color: var(--muted); font-size: 13px; margin: 4px 0 0; }
    .login-card { max-width: 420px; margin: 0 auto; text-align: center; }
    .login-icon {
      width: 56px;
      height: 56px;
      margin: 0 auto 12px;
      border-radius: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 26px;
      background: #e5f8ee;
    }
    .login-card h2 { margin-bottom: 4px; }
    .login-card .field { text-align: left; margin: 18px 0; }
    .field span {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--muted);
      margin-bottom: 6px;
    }
    input[type="password"], input[type="text"], input[type="time"] {
      width: 100%;
      border: 1.5px solid var(--line);
      border-radius: 10px;
      padding: 11px 13px;
      font-size: 14px;
      font-family: inherit;
      color: var(--ink);
      background: #fbfdfe;
      transition: border-color .15s, box-shadow .15s;
    }
    input:focus {
      outline: none;
      border-color: var(--green);
      box-shadow: 0 0 0 3px rgba(6, 199, 85, 0.15);
    }
    .time-field { max-width: 220px; }
    .config-grid { display: grid; gap: 12px; }
    .switch {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 14px 16px;
      border: 1.5px solid var(--line);
      border-radius: 12px;
      background: #fbfdfe;
      cursor: pointer;
      transition: border-color .15s, background .15s;
    }
    .switch:hover { border-color: #cfe9da; }
    .switch input { position: absolute; opacity: 0; width: 0; height: 0; }
    .slider {
      position: relative;
      flex: 0 0 auto;
      width: 44px;
      height: 26px;
      border-radius: 999px;
      background: #cdd6dd;
      transition: background .2s;
    }
    .slider::after {
      content: "";
      position: absolute;
      top: 3px;
      left: 3px;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
      transition: transform .2s;
    }
    .switch input:checked + .slider { background: var(--green); }
    .switch input:checked + .slider::after { transform: translateX(18px); }
    .switch input:focus-visible + .slider { box-shadow: 0 0 0 3px rgba(6, 199, 85, 0.25); }
    .switch-text strong { display: block; font-size: 14px; font-weight: 600; }
    .switch-text small { color: var(--muted); font-size: 12px; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
    .btn {
      border: 0;
      border-radius: 10px;
      padding: 11px 18px;
      font-size: 14px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: transform .05s, box-shadow .15s, background .15s;
    }
    .btn:active { transform: translateY(1px); }
    .btn-block { width: 100%; padding: 13px; }
    .btn-primary, .btn-line {
      background: var(--green);
      color: #fff;
      box-shadow: 0 6px 16px rgba(6, 199, 85, 0.3);
    }
    .btn-primary:hover, .btn-line:hover { background: var(--green-dark); }
    .btn-ghost { background: #eef2f5; color: #3a4a55; }
    .btn-ghost:hover { background: #e2e8ed; }
    pre {
      margin: 0;
      min-height: 160px;
      max-height: 380px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      background: #0f1b24;
      color: #9ff0c4;
      border-radius: 12px;
      padding: 16px;
      font-size: 12.5px;
      line-height: 1.55;
      font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
    }
    .topbar-right { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
    .clock { font-size: 14px; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; line-height: 1.2; text-align: right; }
    .clock small { display: block; font-weight: 500; color: var(--muted); font-size: 11px; }
    .info-row { display: flex; justify-content: space-between; gap: 12px; padding: 9px 0; border-top: 1px solid var(--line); font-size: 14px; }
    .info-row:first-of-type { border-top: 0; padding-top: 4px; }
    .info-row span:first-child { color: var(--muted); }
    .info-row span:last-child { font-weight: 600; text-align: right; }
    .badges { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
    .badge { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; background: #eef2f5; color: #3a4a55; }
    .badge b { font-size: 14px; }
    .badge.green { background: #e5f8ee; color: var(--green-dark); }
    .badge.blue { background: #e7f0fe; color: #1f5fbf; }
    .badge.purple { background: #f1e9fe; color: #7040a0; }
    .badge.amber { background: #fdf0e0; color: #a65a00; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { font-size: 12px; color: var(--muted); font-weight: 600; background: #f7fafb; white-space: nowrap; }
    tbody tr:hover { background: #f7fafb; }
    .pill-type { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; }
    .pill-type.install { background: #e7f0fe; color: #1f5fbf; }
    .pill-type.initial { background: #f1e9fe; color: #7040a0; }
    .pill-type.deinstall { background: #fdecec; color: #c0392b; }
    .pill-type.service { background: #e5f8ee; color: var(--green-dark); }
    .bubble { background: var(--green); color: #fff; border-radius: 16px 16px 16px 4px; padding: 14px 16px; white-space: pre-wrap; word-break: break-word; font-size: 13.5px; line-height: 1.6; max-width: 560px; box-shadow: 0 4px 14px rgba(6, 199, 85, 0.25); }
    .run-status { display: none; align-items: center; gap: 10px; margin-top: 14px; padding: 11px 14px; border-radius: 10px; background: #f7fafb; border: 1px solid var(--line); font-size: 13.5px; color: #3a4a55; }
    .run-status.active { display: flex; }
    .run-status.error { background: #fdecec; border-color: #f4c4c0; color: #c0392b; }
    .run-status.done { background: #e5f8ee; border-color: #b9ead0; color: var(--green-dark); }
    .spinner { width: 16px; height: 16px; border-radius: 50%; border: 2.5px solid #cfe0d8; border-top-color: var(--green); animation: spin .7s linear infinite; flex: 0 0 auto; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .btn:disabled { opacity: .55; cursor: not-allowed; box-shadow: none; }
    .empty-note { color: var(--muted); font-size: 13px; margin: 0; }
    details.debug summary { cursor: pointer; color: var(--muted); font-size: 13px; font-weight: 600; }
    details.debug pre { margin-top: 12px; }
    @media (max-width: 600px) {
      .topbar { flex-direction: column; align-items: flex-start; }
      .topbar-right { align-items: flex-start; }
      main { padding: 16px; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <div class="brand-mark">EDMS</div>
      <div class="brand-text">
        <h1>EDMS LINE Notifier</h1>
        <p>แจ้งเตือนงานเข้า LINE อัตโนมัติทุกเช้า</p>
      </div>
    </div>
    <div class="topbar-right">
      <div class="clock"><span id="clockTime">--:--:--</span><small id="clockDate"></small></div>
      <div class="status-pill" id="status">พร้อมใช้งาน</div>
    </div>
  </header>

  <main id="loginView" class="login-wrap">
    <section class="card login-card">
      <div class="login-icon">🔒</div>
      <h2>เข้าสู่ระบบ</h2>
      <label class="field">
        <input id="token" type="password" autocomplete="current-password" placeholder="Password">
      </label>
      <button id="loginBtn" type="button" class="btn btn-primary btn-block">เข้าสู่ระบบ</button>
    </section>
  </main>

  <main id="dashboardView" class="hidden">
    <section class="card">
      <div class="card-head">
        <div>
          <h2>สถานะระบบ</h2>
          <p class="muted">ยืนยัน token แล้ว · cron ทำงานอยู่</p>
        </div>
        <button id="logoutBtn" type="button" class="btn btn-ghost">ออกจากระบบ</button>
      </div>
      <div class="info-row"><span>ส่งอัตโนมัติล่าสุด</span><span id="lastSent">—</span></div>
      <div class="info-row"><span>รอบส่งถัดไป</span><span id="nextRun">—</span></div>
    </section>

    <section class="card">
      <div class="card-head"><h2>ตั้งค่าการแจ้งเตือน</h2></div>
      <div class="config-grid">
        <label class="switch">
          <input id="alertEnabled" type="checkbox">
          <span class="slider"></span>
          <span class="switch-text">
            <strong>เปิดระบบแจ้งเตือน</strong>
            <small>ปิดเพื่อหยุดส่ง LINE ชั่วคราว</small>
          </span>
        </label>
        <label class="switch">
          <input id="notifyWhenEmpty" type="checkbox">
          <span class="slider"></span>
          <span class="switch-text">
            <strong>แจ้งเมื่อไม่มีงาน</strong>
            <small>ส่งข้อความแม้วันนั้นไม่มีงาน</small>
          </span>
        </label>
        <label class="field time-field">
          <span>เวลาแจ้งเตือน (เวลาไทย)</span>
          <input id="alertTime" type="time" value="07:00">
        </label>
      </div>
      <div class="actions">
        <button id="saveConfigBtn" type="button" class="btn btn-primary">บันทึกค่า</button>
        <button id="loadConfigBtn" type="button" class="btn btn-ghost">โหลดค่าใหม่</button>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h2>ทดสอบ</h2></div>
      <div class="actions">
        <button id="dryRunBtn" type="button" class="btn btn-ghost">เช็คงาน (ไม่ส่ง LINE)</button>
        <button id="sendLineBtn" type="button" class="btn btn-line">ส่ง LINE จริง</button>
        <button id="demoBtn" type="button" class="btn btn-ghost">ดูตัวอย่างหน้าตา</button>
      </div>
      <div class="run-status" id="runStatus">
        <span class="spinner" id="runSpinner"></span>
        <span id="runStatusText"></span>
      </div>
    </section>

    <section class="card" id="messageCard" style="display:none">
      <div class="card-head"><h2>ข้อความที่จะส่งเข้า LINE</h2></div>
      <div class="bubble" id="messagePreview"></div>
    </section>

    <section class="card" id="jobsCard" style="display:none">
      <div class="card-head"><h2>งานวันนี้</h2></div>
      <div class="badges" id="jobBadges"></div>
      <div id="jobTables"></div>
    </section>

    <section class="card">
      <div class="card-head"><h2>รายละเอียด (debug)</h2></div>
      <details class="debug">
        <summary>แสดงข้อมูลดิบ JSON</summary>
        <pre id="output">ยังไม่มีผลลัพธ์</pre>
      </details>
    </section>
  </main>
  <script>
    const tokenEl = document.getElementById('token');
    const outputEl = document.getElementById('output');
    const statusEl = document.getElementById('status');
    const alertEnabledEl = document.getElementById('alertEnabled');
    const notifyWhenEmptyEl = document.getElementById('notifyWhenEmpty');
    const alertTimeEl = document.getElementById('alertTime');
    const loginView = document.getElementById('loginView');
    const dashboardView = document.getElementById('dashboardView');
    const messageCard = document.getElementById('messageCard');
    const messagePreview = document.getElementById('messagePreview');
    const jobsCard = document.getElementById('jobsCard');
    const jobBadges = document.getElementById('jobBadges');
    const jobTables = document.getElementById('jobTables');
    const lastSentEl = document.getElementById('lastSent');
    const nextRunEl = document.getElementById('nextRun');
    const runStatus = document.getElementById('runStatus');
    const runSpinner = document.getElementById('runSpinner');
    const runStatusText = document.getElementById('runStatusText');
    const clockTime = document.getElementById('clockTime');
    const clockDate = document.getElementById('clockDate');
    const dryRunBtn = document.getElementById('dryRunBtn');
    const sendLineBtn = document.getElementById('sendLineBtn');

    let runTimer = null;

    tokenEl.value = localStorage.getItem('edms_admin_token') || '';
    tokenEl.addEventListener('change', () => localStorage.setItem('edms_admin_token', tokenEl.value));

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function headers() {
      return {
        Authorization: 'Bearer ' + tokenEl.value,
        'Content-Type': 'application/json',
      };
    }

    function show(data) {
      outputEl.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    }

    async function api(path, options = {}) {
      if (!tokenEl.value) {
        throw new Error('กรุณาใส่ ADMIN_TOKEN ก่อน');
      }
      const response = await fetch(path, {
        ...options,
        headers: { ...headers(), ...(options.headers || {}) },
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Request failed');
      }
      return data;
    }

    // ---- Live Bangkok clock ----
    function tickClock() {
      const now = new Date();
      clockTime.textContent = now.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false });
      clockDate.textContent = now.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric' });
    }
    setInterval(tickClock, 1000);
    tickClock();

    function bangkokParts() {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const parts = {};
      for (const p of fmt.formatToParts(new Date())) parts[p.type] = p.value;
      return parts;
    }

    function thaiDateFromKey(key) {
      const parts = String(key).split('-');
      if (parts.length !== 3) return key;
      const d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12));
      return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function updateSchedule(alertTime, lastSent) {
      const p = bangkokParts();
      const todayKey = p.year + '-' + p.month + '-' + p.day;
      const nowHHMM = (p.hour === '24' ? '00' : p.hour) + ':' + p.minute;
      const at = alertTime || '07:00';
      lastSentEl.textContent = lastSent ? thaiDateFromKey(lastSent) : 'ยังไม่เคยส่ง';
      if (lastSent === todayKey) {
        nextRunEl.textContent = 'พรุ่งนี้ ' + at;
      } else if (nowHHMM < at) {
        nextRunEl.textContent = 'วันนี้ ' + at;
      } else {
        nextRunEl.textContent = 'อีกไม่กี่นาที (ถึงเวลาส่งแล้ว)';
      }
    }

    // ---- Render LINE message + job tables ----
    function renderMessage(message) {
      if (message && message.trim()) {
        messagePreview.textContent = message;
        messageCard.style.display = '';
      } else {
        messageCard.style.display = 'none';
      }
    }

    function jobRowHtml(typeLabel, typeClass, row) {
      const terminal = row['Terminal ID'] || row['TID'] || '-';
      const merchant = row['Merchant Name'] || row['ชื่อร้านค้า'] || '-';
      const province = row['จังหวัด'] || row['Detail Province'] || '-';
      const planDate = row['Detail Plan Date'] || row['SLA Date'] || row['Detail Request Date'] || '-';
      return '<tr>'
        + '<td><span class="pill-type ' + typeClass + '">' + escapeHtml(typeLabel) + '</span></td>'
        + '<td>' + escapeHtml(terminal) + '</td>'
        + '<td>' + escapeHtml(merchant) + '</td>'
        + '<td>' + escapeHtml(province) + '</td>'
        + '<td>' + escapeHtml(planDate) + '</td>'
        + '</tr>';
    }

    function renderReport(report) {
      if (!report) { jobsCard.style.display = 'none'; return; }
      const service = [];
      const fieldRows = report.fieldJobs || [];
      const initial = [];
      const install = [];
      const deinstall = [];
      const seen = new Set();
      const fieldTerminals = new Set();
      function addRow(bucket, row, category) {
        const terminal = row['Terminal ID'] || row['TID'] || '-';
        const seenKey = category + ':' + terminal;
        if (seen.has(seenKey)) return;
        seen.add(seenKey);
        bucket.push(row);
      }
      function dashboardJobCategory(row) {
        const typeText = [
          row['ประเภทงาน'],
          row['Detail Job Type'],
          row['Job Type'],
          row['Service Code'],
        ].filter(Boolean).join(' ').toLowerCase();
        const text = typeText || Object.values(row).filter(Boolean).join(' ').toLowerCase();
        if (text.includes('de-install') || text.includes('de installation')) return 'deinstall';
        if (text.includes('initialization') || text.includes('initialisation')) return 'initial';
        if (text.includes('install') || text.includes('installation')) return 'install';
        if (text.includes('service') || text.includes('ตรวจเช็ค') || text.includes('เปลี่ยนเครื่อง')) return 'service';
        return 'install';
      }
      for (const row of fieldRows) {
        const category = dashboardJobCategory(row);
        fieldTerminals.add(row['Terminal ID'] || row['TID'] || '-');
        if (category === 'deinstall') addRow(deinstall, row, category);
        else if (category === 'initial') addRow(initial, row, category);
        else if (category === 'service') addRow(service, row, category);
        else addRow(install, row, category);
      }
      for (const row of (report.remainingJobs || [])) {
        const terminal = row['Terminal ID'] || row['TID'] || '-';
        if (fieldTerminals.has(terminal)) continue;
        addRow(service, row, 'service');
      }
      const total = service.length + initial.length + install.length + deinstall.length;
      jobBadges.innerHTML =
        '<span class="badge">รวม <b>' + total + '</b></span>'
        + '<span class="badge green">Service <b>' + service.length + '</b></span>'
        + '<span class="badge purple">Initial <b>' + initial.length + '</b></span>'
        + '<span class="badge blue">Install <b>' + install.length + '</b></span>'
        + '<span class="badge amber">De-install <b>' + deinstall.length + '</b></span>';

      if (total === 0) {
        jobTables.innerHTML = '<p class="empty-note">วันนี้ไม่มีงานใน 2 หน้าที่ตั้งไว้</p>';
      } else {
        let rows = '';
        service.forEach((r) => { rows += jobRowHtml('Service', 'service', r); });
        initial.forEach((r) => { rows += jobRowHtml('Initial', 'initial', r); });
        install.forEach((r) => { rows += jobRowHtml('Install', 'install', r); });
        deinstall.forEach((r) => { rows += jobRowHtml('De-install', 'deinstall', r); });
        jobTables.innerHTML = '<div class="table-wrap"><table><thead><tr>'
          + '<th>ประเภท</th><th>TID</th><th>ร้านค้า</th><th>จังหวัด</th><th>วันที่ Plan</th>'
          + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
      }
      jobsCard.style.display = '';
    }

    // ---- Run status (staged progress) ----
    function setRunStatus(text, state) {
      runStatus.className = 'run-status active' + (state ? ' ' + state : '');
      runStatusText.textContent = text;
      runSpinner.style.display = (state === 'done' || state === 'error') ? 'none' : '';
    }

    // ---- Demo / sample data so the layout is visible even when there are no real jobs ----
    function demoData() {
      const p = bangkokParts();
      const today = p.day + '/' + p.month + '/' + (Number(p.year) + 543);
      const remainingJobs = [
        { 'Terminal ID': 'T1234567', 'Merchant Name': '7-Eleven สาขาพานทอง', 'จังหวัด': 'ชลบุรี', 'Detail Plan Date': today, 'Detail Request Date': '05/06/2569' },
        { 'Terminal ID': 'T7654321', 'Merchant Name': 'Lotus พนัสนิคม', 'จังหวัด': 'ชลบุรี', 'Detail Plan Date': today, 'Detail Request Date': '06/06/2569' },
      ];
      const fieldJobs = [
        { 'TID': 'F1111111', 'ชื่อร้านค้า': 'CP Fresh Mart เมืองชลบุรี', 'จังหวัด': 'ชลบุรี', 'ประเภทงาน': 'Install', 'Detail Plan Date': today },
        { 'TID': 'F2222222', 'ชื่อร้านค้า': 'Big C บ้านบึง', 'จังหวัด': 'ชลบุรี', 'ประเภทงาน': 'Initialization', 'Detail Plan Date': today },
        { 'TID': 'F3333333', 'ชื่อร้านค้า': 'Makro บ่อทอง', 'จังหวัด': 'ชลบุรี', 'ประเภทงาน': 'De-install', 'Detail Plan Date': today },
      ];
      const message = [
        'Plan onsite ' + today,
        'Service',
        'T1234567',
        'T7654321',
        'Initial',
        'F2222222',
        'Install',
        'F1111111',
        'De-install',
        'F3333333',
        'ชลบุรี',
      ].join('\\n');
      return { today: today, fieldJobs: fieldJobs, remainingJobs: remainingJobs, errors: [], message: message };
    }

    function showDemo() {
      const d = demoData();
      renderMessage(d.message);
      renderReport(d);
      show({ demo: true, report: d, note: 'ข้อมูลตัวอย่างเท่านั้น ไม่ได้ดึงจาก EDMS และไม่ได้ส่ง LINE' });
      runStatus.className = 'run-status active';
      runSpinner.style.display = 'none';
      runStatusText.textContent = 'นี่คือข้อมูลตัวอย่าง — ไม่ได้ส่ง LINE จริง';
      statusEl.textContent = 'แสดงตัวอย่าง';
      messageCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    function clearRunStages() {
      if (runTimer) { clearTimeout(runTimer); runTimer = null; }
    }

    function showDashboard() {
      loginView.classList.add('hidden');
      dashboardView.classList.remove('hidden');
      statusEl.textContent = 'ยืนยัน token แล้ว';
    }

    function showLogin() {
      dashboardView.classList.add('hidden');
      loginView.classList.remove('hidden');
      statusEl.textContent = 'พร้อมใช้งาน';
    }

    async function login() {
      statusEl.textContent = 'กำลังตรวจสอบ token...';
      try {
        await api('/api/auth');
        localStorage.setItem('edms_admin_token', tokenEl.value);
        showDashboard();
        await loadConfig();
      } catch (error) {
        localStorage.removeItem('edms_admin_token');
        statusEl.textContent = 'token ไม่ถูกต้อง';
        show({ ok: false, error: error.message });
      }
    }

    function logout() {
      localStorage.removeItem('edms_admin_token');
      tokenEl.value = '';
      outputEl.textContent = 'ยังไม่มีผลลัพธ์';
      messageCard.style.display = 'none';
      jobsCard.style.display = 'none';
      runStatus.className = 'run-status';
      showLogin();
    }

    async function loadConfig() {
      statusEl.textContent = 'กำลังโหลดค่า...';
      try {
        const data = await api('/api/config');
        alertEnabledEl.checked = Boolean(data.config.alertEnabled);
        notifyWhenEmptyEl.checked = Boolean(data.config.notifyWhenEmpty);
        alertTimeEl.value = data.config.alertTime || '07:00';
        updateSchedule(data.config.alertTime, data.lastSent);
        show(data);
        statusEl.textContent = 'โหลดค่าแล้ว';
      } catch (error) {
        statusEl.textContent = 'โหลดค่าไม่สำเร็จ';
        show({ ok: false, error: error.message });
      }
    }

    async function saveConfig() {
      statusEl.textContent = 'กำลังบันทึกค่า...';
      try {
        const data = await api('/api/config', {
          method: 'POST',
          body: JSON.stringify({
            alertEnabled: alertEnabledEl.checked,
            notifyWhenEmpty: notifyWhenEmptyEl.checked,
            alertTime: alertTimeEl.value || '07:00',
          }),
        });
        updateSchedule(data.config.alertTime, data.lastSent);
        show(data);
        statusEl.textContent = 'บันทึกค่าแล้ว';
      } catch (error) {
        statusEl.textContent = 'บันทึกค่าไม่สำเร็จ';
        show({ ok: false, error: error.message });
      }
    }

    async function run(send) {
      clearRunStages();
      dryRunBtn.disabled = true;
      sendLineBtn.disabled = true;
      statusEl.textContent = send ? 'กำลังส่ง LINE...' : 'กำลังเช็คงาน...';
      const stages = send
        ? ['กำลังล็อกอิน EDMS...', 'กำลังดึงข้อมูลงาน 2 หน้า...', 'กำลังอ่านรายละเอียดงาน...', 'กำลังส่งข้อความเข้า LINE...']
        : ['กำลังล็อกอิน EDMS...', 'กำลังดึงข้อมูลงาน 2 หน้า...', 'กำลังอ่านรายละเอียดงาน...'];
      let i = 0;
      setRunStatus(stages[0], '');
      const advance = () => {
        if (i < stages.length - 1) {
          i++;
          setRunStatus(stages[i], '');
          runTimer = setTimeout(advance, 1600);
        }
      };
      runTimer = setTimeout(advance, 1600);

      try {
        const data = await api('/api/run' + (send ? '?send=1' : ''));
        clearRunStages();
        show(data);
        renderMessage(data.message);
        renderReport(data.report);
        if (data.ok) {
          const sent = data.sentLine ? ' · ส่ง LINE แล้ว' : '';
          setRunStatus((send ? 'ส่ง LINE สำเร็จ' : 'เช็คงานสำเร็จ') + sent, 'done');
          statusEl.textContent = 'สำเร็จ';
        } else {
          setRunStatus('ไม่สำเร็จ: ' + (data.error || 'unknown'), 'error');
          statusEl.textContent = 'ไม่สำเร็จ';
        }
      } catch (error) {
        clearRunStages();
        setRunStatus('ผิดพลาด: ' + error.message, 'error');
        statusEl.textContent = 'ไม่สำเร็จ';
        show({ ok: false, error: error.message });
      } finally {
        dryRunBtn.disabled = false;
        sendLineBtn.disabled = false;
      }
    }

    document.getElementById('loadConfigBtn').addEventListener('click', loadConfig);
    document.getElementById('saveConfigBtn').addEventListener('click', saveConfig);
    dryRunBtn.addEventListener('click', () => run(false));
    sendLineBtn.addEventListener('click', () => run(true));
    document.getElementById('demoBtn').addEventListener('click', showDemo);
    document.getElementById('loginBtn').addEventListener('click', login);
    document.getElementById('logoutBtn').addEventListener('click', logout);
    tokenEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') login();
    });
    // Auto-login on refresh when a token is already saved, so config loads without extra clicks.
    if (tokenEl.value) {
      login();
    }
  </script>
</body>
</html>`;
}
