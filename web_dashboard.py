import base64
import hmac
import json
import os
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs


ROOT = Path(__file__).resolve().parent
ENV_PATH = ROOT / ".env"
SCRIPT_PATH = ROOT / "daily_line_jobs.py"
HISTORY_PATH = ROOT / "alert_history.json"
STATE_PATH = ROOT / "scheduler_state.json"
BANGKOK_TZ = timezone(timedelta(hours=7))

CONFIG_KEYS = [
    "EDMS_ALERT_ENABLED",
    "EDMS_USERNAME",
    "EDMS_PASSWORD",
    "EDMS_LOGIN_URL",
    "EDMS_COOKIE",
    "LINE_CHANNEL_ACCESS_TOKEN",
    "LINE_TO",
    "ALERT_TIME",
    "ONLY_TODAY",
    "NOTIFY_WHEN_EMPTY",
]
SECRET_KEYS = {"EDMS_PASSWORD", "EDMS_COOKIE", "LINE_CHANNEL_ACCESS_TOKEN"}
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


def read_env():
    values = {}
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def dashboard_auth(values=None):
    values = values or read_env()
    username = values.get("DASHBOARD_USERNAME", "admin").strip() or "admin"
    password = values.get("DASHBOARD_PASSWORD", "").strip()
    return username, password


def dashboard_auth_required(values=None):
    values = values or read_env()
    _, password = dashboard_auth(values)
    return bool(password) or configured_host(values) not in LOCAL_HOSTS


def configured_host(values=None):
    values = values or read_env()
    return os.getenv("EDMS_DASHBOARD_HOST") or values.get("EDMS_DASHBOARD_HOST", "127.0.0.1").strip() or "127.0.0.1"


def configured_port(values=None):
    values = values or read_env()
    raw = os.getenv("EDMS_DASHBOARD_PORT") or values.get("EDMS_DASHBOARD_PORT", "8765").strip() or "8765"
    try:
        return int(raw)
    except ValueError:
        return 8765


def alert_enabled(values=None):
    values = values or read_env()
    return values.get("EDMS_ALERT_ENABLED", "true").strip().lower() not in ("0", "false", "no", "off")


def write_env(values):
    updates = {key: values[key] for key in CONFIG_KEYS if key in values}
    existing_lines = ENV_PATH.read_text(encoding="utf-8").splitlines() if ENV_PATH.exists() else []

    out_lines = []
    seen = set()
    for line in existing_lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in line:
            out_lines.append(line)
            continue
        key = line.split("=", 1)[0].strip()
        if key in updates:
            out_lines.append(f"{key}={updates[key]}")
            seen.add(key)
        else:
            out_lines.append(line)

    for key in CONFIG_KEYS:
        if key in updates and key not in seen:
            out_lines.append(f"{key}={updates[key]}")

    ENV_PATH.write_text("\n".join(out_lines) + "\n", encoding="utf-8")


def read_history():
    if not HISTORY_PATH.exists():
        return []
    try:
        data = json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    return data if isinstance(data, list) else []


def append_history(kind, result):
    history = read_history()
    history.insert(
        0,
        {
            "time": datetime.now(BANGKOK_TZ).strftime("%Y-%m-%d %H:%M:%S"),
            "kind": kind,
            "ok": bool(result.get("ok")),
            "sent_line": bool(result.get("sent_line")),
            "has_jobs": bool(result.get("has_jobs")),
            "message": result.get("message") or result.get("stdout") or result.get("stderr") or "",
            "error": result.get("line_error") or result.get("stderr") or result.get("error") or "",
        },
    )
    HISTORY_PATH.write_text(
        json.dumps(history[:80], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def mask_value(key, value):
    if not value:
        return ""
    if key not in SECRET_KEYS:
        return value
    if len(value) <= 8:
        return "********"
    return f"{value[:4]}...{value[-4:]}"


def run_job(send_line=False, history_kind="manual"):
    args = [sys.executable, str(SCRIPT_PATH), "--json"]
    if not send_line:
        args.append("--dry-run")
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    proc = subprocess.run(
        args,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        timeout=120,
    )
    payload = {
        "ok": proc.returncode == 0,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "returncode": proc.returncode,
    }
    try:
        if proc.stdout:
            payload.update(json.loads(proc.stdout))
    except (json.JSONDecodeError, TypeError):
        pass
    if send_line:
        append_history(history_kind if payload.get("ok") else f"{history_kind}-error", payload)
    return payload


def normalized_alert_time(values):
    raw = values.get("ALERT_TIME", "07:00").strip() or "07:00"
    try:
        parsed = datetime.strptime(raw, "%H:%M")
    except ValueError:
        return "07:00"
    return parsed.strftime("%H:%M")


def read_last_sent_key():
    if not STATE_PATH.exists():
        return None
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    return data.get("last_sent_key") if isinstance(data, dict) else None


def write_last_sent_key(today_key):
    STATE_PATH.write_text(
        json.dumps({"last_sent_key": today_key}, ensure_ascii=False),
        encoding="utf-8",
    )


def scheduler_loop():
    # Restored from disk so a restart during/after the alert time does not resend.
    last_sent_key = read_last_sent_key()
    while True:
        values = read_env()
        now = datetime.now(BANGKOK_TZ)
        today_key = now.strftime("%Y-%m-%d")
        alert_time = normalized_alert_time(values)
        # Use >= so a missed minute (sleep drift, brief downtime) still fires once today.
        if (
            alert_enabled(values)
            and now.strftime("%H:%M") >= alert_time
            and last_sent_key != today_key
        ):
            run_job(send_line=True, history_kind="schedule")
            last_sent_key = today_key
            write_last_sent_key(today_key)
        time.sleep(20)


def start_scheduler():
    thread = threading.Thread(target=scheduler_loop, name="edms-alert-scheduler", daemon=True)
    thread.start()


def page_html():
    values = read_env()
    enabled = alert_enabled(values)
    toggle_text = "ปิดระบบ" if enabled else "เปิดระบบ"
    toggle_class = "danger" if enabled else "success"
    enabled_text = "ระบบเปิดอยู่" if enabled else "ระบบปิดอยู่"
    fields = []
    for key in CONFIG_KEYS:
        kind = "password" if key in SECRET_KEYS else "text"
        placeholder = mask_value(key, values.get(key, ""))
        default_value = "07:00" if key == "ALERT_TIME" else ""
        value = "" if key in SECRET_KEYS else values.get(key, default_value)
        fields.append(
            f"""
            <label>
              <span>{escape(key)}</span>
              <input name="{escape(key)}" type="{kind}" value="{escape(value)}" placeholder="{escape(placeholder)}">
            </label>
            """
        )
    return f"""<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>EDMS LINE Alert</title>
  <style>
    :root {{
      color-scheme: light;
      font-family: Arial, Tahoma, sans-serif;
      background: #f4f7f8;
      color: #16202a;
    }}
    body {{
      margin: 0;
    }}
    header {{
      background: #ffffff;
      border-bottom: 1px solid #d9e1e5;
      padding: 18px 28px;
      position: sticky;
      top: 0;
      z-index: 2;
    }}
    h1 {{
      font-size: 22px;
      margin: 0;
    }}
    main {{
      max-width: 1180px;
      margin: 0 auto;
      padding: 24px;
      display: grid;
      gap: 18px;
    }}
    section {{
      background: #ffffff;
      border: 1px solid #d9e1e5;
      border-radius: 8px;
      padding: 18px;
    }}
    h2 {{
      font-size: 16px;
      margin: 0 0 14px;
    }}
    .grid {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px;
    }}
    label span {{
      display: block;
      font-size: 12px;
      font-weight: 700;
      color: #53606b;
      margin-bottom: 5px;
    }}
    input {{
      width: 100%;
      box-sizing: border-box;
      border: 1px solid #c7d1d8;
      border-radius: 6px;
      padding: 10px;
      font-size: 14px;
    }}
    .actions {{
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 14px;
    }}
    button {{
      border: 0;
      border-radius: 6px;
      padding: 10px 14px;
      background: #0c8f6a;
      color: #ffffff;
      font-weight: 700;
      cursor: pointer;
    }}
    button.secondary {{
      background: #40515f;
    }}
    button.warn {{
      background: #b35b00;
    }}
    button.danger {{
      background: #b3261e;
    }}
    button.success {{
      background: #157f3f;
    }}
    pre {{
      white-space: pre-wrap;
      background: #13212b;
      color: #e7f5ef;
      padding: 14px;
      border-radius: 6px;
      overflow: auto;
      min-height: 70px;
    }}
    table {{
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
      font-size: 13px;
    }}
    th, td {{
      border-bottom: 1px solid #e2e8ec;
      padding: 8px;
      text-align: left;
      vertical-align: top;
    }}
    th {{
      background: #eef3f5;
      color: #344450;
    }}
    .status {{
      color: #53606b;
      font-size: 13px;
      margin-top: 8px;
    }}
  </style>
</head>
<body>
  <header><h1>EDMS LINE Alert</h1></header>
  <main>
    <section>
      <h2>ตั้งค่า</h2>
      <form id="configForm">
        <div class="grid">{''.join(fields)}</div>
        <div class="actions">
          <button type="button" class="{toggle_class}" id="toggleBtn">{toggle_text}</button>
          <button type="submit">บันทึกค่า</button>
          <button type="button" class="secondary" id="refreshBtn">ดึงข้อมูลงาน</button>
          <button type="button" class="warn" id="sendBtn">ส่ง LINE ทดสอบ</button>
        </div>
      </form>
      <div class="status" id="systemState">{enabled_text}</div>
      <div class="status" id="status">พร้อมใช้งาน</div>
    </section>
    <section>
      <h2>ข้อความที่จะส่ง</h2>
      <pre id="messageBox">กดดึงข้อมูลงานเพื่อดูข้อความ</pre>
    </section>
    <section>
      <h2>รายการงาน</h2>
      <div id="tables"></div>
    </section>
    <section>
      <h2>Notification History</h2>
      <div id="history"></div>
    </section>
  </main>
  <script>
    const statusEl = document.getElementById('status');
    const messageBox = document.getElementById('messageBox');
    const tablesEl = document.getElementById('tables');
    const historyEl = document.getElementById('history');

    function setStatus(text) {{
      statusEl.textContent = text;
    }}

    function escapeHtml(value) {{
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }}

    async function postForm(url) {{
      const form = document.getElementById('configForm');
      const body = new URLSearchParams(new FormData(form));
      const response = await fetch(url, {{ method: 'POST', body }});
      return response.json();
    }}

    async function toggleSystem() {{
      setStatus('กำลังเปลี่ยนสถานะระบบ...');
      const response = await fetch('/api/toggle', {{ method: 'POST' }});
      const data = await response.json();
      if (data.ok) {{
        document.getElementById('systemState').textContent = data.enabled ? 'ระบบเปิดอยู่' : 'ระบบปิดอยู่';
        const btn = document.getElementById('toggleBtn');
        btn.textContent = data.enabled ? 'ปิดระบบ' : 'เปิดระบบ';
        btn.className = data.enabled ? 'danger' : 'success';
        const input = document.querySelector('input[name="EDMS_ALERT_ENABLED"]');
        if (input) input.value = data.enabled ? 'true' : 'false';
        setStatus('เปลี่ยนสถานะแล้ว');
      }} else {{
        setStatus('เปลี่ยนสถานะไม่สำเร็จ');
      }}
    }}

    function renderRows(title, rows) {{
      if (!rows || rows.length === 0) {{
        return `<h3>${{title}}</h3><p class="status">ไม่มีรายการ</p>`;
      }}
      const keys = Array.from(new Set(rows.flatMap(row => Object.keys(row)))).slice(0, 10);
      const head = keys.map(key => `<th>${{escapeHtml(key)}}</th>`).join('');
      const body = rows.map(row => `<tr>${{keys.map(key => `<td>${{escapeHtml(row[key] || '')}}</td>`).join('')}}</tr>`).join('');
      return `<h3>${{escapeHtml(title)}}</h3><table><thead><tr>${{head}}</tr></thead><tbody>${{body}}</tbody></table>`;
    }}

    function renderHistory(rows) {{
      if (!rows || rows.length === 0) {{
        historyEl.innerHTML = '<p class="status">No notification history yet.</p>';
        return;
      }}
      const body = rows.slice(0, 20).map(row => `
        <tr>
          <td>${{escapeHtml(row.time || '')}}</td>
          <td>${{escapeHtml(row.kind || '')}}</td>
          <td>${{row.ok ? 'OK' : 'Failed'}}</td>
          <td>${{row.sent_line ? 'Sent' : '-'}}</td>
          <td>${{row.has_jobs ? 'Has jobs' : 'No jobs'}}</td>
          <td>${{escapeHtml(row.error || '')}}</td>
        </tr>
      `).join('');
      historyEl.innerHTML = `<table><thead><tr><th>Time</th><th>Run</th><th>Status</th><th>LINE</th><th>Jobs</th><th>Error</th></tr></thead><tbody>${{body}}</tbody></table>`;
    }}

    async function loadHistory() {{
      const response = await fetch('/api/history');
      renderHistory(await response.json());
    }}

    async function loadJobs(sendLine=false) {{
      setStatus(sendLine ? 'กำลังส่ง LINE...' : 'กำลังดึงข้อมูลงาน...');
      const response = await fetch(sendLine ? '/api/send-line' : '/api/jobs', {{ method: 'POST' }});
      const data = await response.json();
      messageBox.textContent = data.message || data.stdout || data.stderr || 'ไม่มีข้อมูล';
      const report = data.report || {{}};
      tablesEl.innerHTML = renderRows('Job Remaining List', report.remaining_jobs || []) +
        renderRows('Field Engineer', report.field_jobs || []);
      setStatus(data.ok ? 'สำเร็จ' : `ไม่สำเร็จ: ${{data.stderr || data.stdout || data.returncode}}`);
      if (sendLine) loadHistory();
    }}

    document.getElementById('configForm').addEventListener('submit', async (event) => {{
      event.preventDefault();
      setStatus('กำลังบันทึก...');
      const data = await postForm('/api/config');
      setStatus(data.ok ? 'บันทึกแล้ว' : 'บันทึกไม่สำเร็จ');
    }});
    document.getElementById('refreshBtn').addEventListener('click', () => loadJobs(false));
    document.getElementById('sendBtn').addEventListener('click', () => loadJobs(true));
    document.getElementById('toggleBtn').addEventListener('click', toggleSystem);
    loadHistory();
  </script>
</body>
</html>"""


class Handler(BaseHTTPRequestHandler):
    def is_authorized(self):
        values = read_env()
        if not dashboard_auth_required(values):
            return True
        username, password = dashboard_auth(values)
        if not password:
            return False
        auth_header = self.headers.get("Authorization", "")
        if not auth_header.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(auth_header.split(" ", 1)[1]).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return False
        provided_user, separator, provided_password = decoded.partition(":")
        if not separator:
            return False
        return hmac.compare_digest(provided_user, username) and hmac.compare_digest(
            provided_password, password
        )

    def send_auth_required(self):
        values = read_env()
        _, password = dashboard_auth(values)
        message = (
            "Set DASHBOARD_PASSWORD in .env before exposing this dashboard."
            if not password
            else "Authentication required."
        )
        body = message.encode("utf-8")
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="EDMS LINE Alert"')
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.is_authorized():
            self.send_auth_required()
            return
        if self.path == "/api/history":
            self.send_json(read_history())
            return
        body = page_html().encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def is_same_origin(self):
        # CSRF guard: a same-origin fetch from our own page sends an Origin
        # header matching the Host. Cross-site form posts carry a different
        # Origin; requests with no browser context (curl) carry none.
        origin = self.headers.get("Origin")
        if not origin:
            return True
        host = self.headers.get("Host", "")
        return origin in (f"http://{host}", f"https://{host}")

    def do_POST(self):
        if not self.is_authorized():
            self.send_auth_required()
            return
        if not self.is_same_origin():
            self.send_json({"ok": False, "error": "Cross-origin request blocked"}, 403)
            return
        try:
            if self.path == "/api/config":
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length).decode("utf-8")
                parsed = parse_qs(raw, keep_blank_values=True)
                existing = read_env()
                values = {}
                for key in CONFIG_KEYS:
                    value = parsed.get(key, [""])[0].strip()
                    if key in SECRET_KEYS and not value:
                        value = existing.get(key, "")
                    values[key] = value
                write_env(values)
                self.send_json({"ok": True})
            elif self.path == "/api/jobs":
                self.send_json(run_job(send_line=False))
            elif self.path == "/api/send-line":
                self.send_json(run_job(send_line=True))
            elif self.path == "/api/toggle":
                values = read_env()
                values["EDMS_ALERT_ENABLED"] = "false" if alert_enabled(values) else "true"
                write_env(values)
                self.send_json({"ok": True, "enabled": alert_enabled(values)})
            else:
                self.send_json({"ok": False, "error": "Not found"}, 404)
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, 500)


def main():
    values = read_env()
    host = configured_host(values)
    port = configured_port(values)
    start_scheduler()
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"EDMS dashboard running at http://{host}:{port}")
    print("Daily scheduler is active while this dashboard process is running.")
    server.serve_forever()


if __name__ == "__main__":
    main()
