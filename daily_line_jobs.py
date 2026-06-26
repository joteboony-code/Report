import json
import os
import sys
from http.cookiejar import CookieJar
from datetime import date, datetime, timezone, timedelta
from html.parser import HTMLParser
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin
from urllib.request import HTTPCookieProcessor, Request, build_opener, urlopen


BASE_URL = "https://www.castles-th.com"
JOB_URLS = {
    "field": "https://www.castles-th.com/fldjobs",
    "remaining": "https://www.castles-th.com/showarea/3",
}
LOGIN_URL = os.getenv("EDMS_LOGIN_URL", "https://www.castles-th.com/login")
BANGKOK_TZ = timezone(timedelta(hours=7))
TARGET_PROVINCE = "\u0e0a\u0e25\u0e1a\u0e38\u0e23\u0e35"
TARGET_DISTRICTS = [
    "\u0e1e\u0e32\u0e19\u0e17\u0e2d\u0e07",
    "\u0e1e\u0e19\u0e31\u0e2a\u0e19\u0e34\u0e04\u0e21",
    "\u0e40\u0e01\u0e32\u0e30\u0e08\u0e31\u0e19\u0e17\u0e23\u0e4c",
    "\u0e40\u0e21\u0e37\u0e2d\u0e07",
    "\u0e1a\u0e49\u0e32\u0e19\u0e1a\u0e36\u0e07",
    "\u0e1a\u0e48\u0e2d\u0e17\u0e2d\u0e07",
]
FIELD_HEADERS = [
    "วันที่รับแจ้ง",
    "ธนาคาร",
    "ประเภทงาน",
    "TID",
    "MID",
    "ชื่อร้านค้า",
    "จังหวัด",
    "สถานะ",
    "#",
]
REMAINING_HEADERS = [
    "Terminal ID",
    "Merchant Name",
    "Job Number",
    "Job Open Date",
    "SLA Date",
    "สถานะงาน",
    "Service Code",
    "จังหวัด",
]


class TableParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tables = []
        self._current_table = None
        self._current_row = None
        self._current_cell = None
        self._cell_tag = None
        self._link_href = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "table":
            self._current_table = []
        elif self._current_table is not None and tag == "tr":
            self._current_row = []
        elif self._current_row is not None and tag in ("th", "td"):
            self._current_cell = []
            self._cell_tag = tag
            self._link_href = None
        elif self._current_cell is not None and tag == "a":
            href = attrs.get("href")
            if href:
                self._link_href = urljoin(BASE_URL, href)

    def handle_data(self, data):
        if self._current_cell is not None:
            text = " ".join(data.split())
            if text:
                self._current_cell.append(text)

    def handle_endtag(self, tag):
        if tag == "table" and self._current_table is not None:
            self.tables.append(self._current_table)
            self._current_table = None
        elif tag == "tr" and self._current_row is not None:
            if any(cell["text"] for cell in self._current_row):
                self._current_table.append(self._current_row)
            self._current_row = None
        elif self._current_cell is not None and tag == self._cell_tag:
            self._current_row.append(
                {
                    "text": " ".join(self._current_cell).strip(),
                    "href": self._link_href,
                }
            )
            self._current_cell = None
            self._cell_tag = None
            self._link_href = None


class LoginFormParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.forms = []
        self._current_form = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "form":
            self._current_form = {
                "action": attrs.get("action") or LOGIN_URL,
                "method": (attrs.get("method") or "post").lower(),
                "inputs": {},
                "has_password": False,
            }
        elif self._current_form is not None and tag == "input":
            input_type = (attrs.get("type") or "text").lower()
            name = attrs.get("name")
            if input_type == "password":
                self._current_form["has_password"] = True
            if name:
                self._current_form["inputs"][name] = attrs.get("value", "")

    def handle_endtag(self, tag):
        if tag == "form" and self._current_form is not None:
            self.forms.append(self._current_form)
            self._current_form = None


class TextParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.texts = []

    def handle_data(self, data):
        text = " ".join(data.split())
        if text:
            self.texts.append(text)


def load_dotenv(path=".env"):
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as env_file:
        for line in env_file:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def env_bool(name, default):
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "y", "on")


def fetch_html(url):
    cookie = os.getenv("EDMS_COOKIE", "").strip()
    headers = {
        "User-Agent": "Mozilla/5.0 EDMS daily job notifier",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    if cookie:
        headers["Cookie"] = cookie

    req = Request(url, headers=headers)
    with urlopen(req, timeout=30) as response:
        final_url = response.geturl()
        charset = response.headers.get_content_charset() or "utf-8"
        html = response.read().decode(charset, errors="replace")
        ensure_not_register_page(final_url, html)
        return html


def ensure_not_register_page(final_url, html):
    if "/register" in final_url.lower() or "name=\"password_confirmation\"" in html.lower():
        raise RuntimeError("Unexpected EDMS registration page detected. Stop without filling sign-up data.")


def request_html(opener, url, data=None):
    headers = {
        "User-Agent": "Mozilla/5.0 EDMS daily job notifier",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        data = urlencode(data).encode("utf-8")
    req = Request(url, data=data, headers=headers)
    with opener.open(req, timeout=30) as response:
        final_url = response.geturl()
        charset = response.headers.get_content_charset() or "utf-8"
        html = response.read().decode(charset, errors="replace")
        ensure_not_register_page(final_url, html)
        return final_url, html


def build_authenticated_opener():
    cookie = os.getenv("EDMS_COOKIE", "").strip()
    username = os.getenv("EDMS_USERNAME", "").strip()
    password = os.getenv("EDMS_PASSWORD", "").strip()

    if cookie:
        return None
    if not username or not password:
        raise RuntimeError("Missing EDMS_COOKIE or EDMS_USERNAME/EDMS_PASSWORD in .env")

    cookie_jar = CookieJar()
    opener = build_opener(HTTPCookieProcessor(cookie_jar))
    login_url, login_html = request_html(opener, LOGIN_URL)
    if "/register" in login_url.lower():
        raise RuntimeError("EDMS opened registration page instead of login. Stop without filling sign-up data.")

    parser = LoginFormParser()
    parser.feed(login_html)
    login_form = next((form for form in parser.forms if form["has_password"]), None)
    if login_form is None:
        raise RuntimeError("Cannot find EDMS login form.")

    action = urljoin(LOGIN_URL, login_form["action"])
    payload = dict(login_form["inputs"])
    username_field = next((name for name in payload if name == "user_name"), None)
    if username_field is None:
        username_field = next((name for name in payload if "user" in name.lower() or "email" in name.lower()), "user_name")
    password_field = next((name for name in payload if name == "password"), None)
    if password_field is None:
        password_field = next((name for name in payload if "pass" in name.lower()), "password")
    payload[username_field] = username
    payload[password_field] = password

    final_url, html = request_html(opener, action, payload)
    if "/login" in final_url.lower() or "name=\"password\"" in html.lower():
        raise RuntimeError("EDMS login failed. Check EDMS_USERNAME/EDMS_PASSWORD.")
    return opener


def fetch_html_with_session(url, opener):
    if opener is None:
        return fetch_html(url)
    _, html = request_html(opener, url)
    return html


def parse_tables(html):
    parser = TableParser()
    parser.feed(html)
    result = []
    for table in parser.tables:
        if len(table) < 2:
            continue
        headers = [cell["text"] for cell in table[0]]
        rows = []
        for raw_row in table[1:]:
            row = {}
            for index, header in enumerate(headers):
                if index < len(raw_row):
                    row[header] = raw_row[index]["text"]
                    if raw_row[index].get("href"):
                        row[f"{header} URL"] = raw_row[index]["href"]
            if row:
                rows.append(row)
        result.append({"headers": headers, "rows": rows})
    return result


def first_table_rows_with_headers(html, fallback_headers):
    parser = TableParser()
    parser.feed(html)
    if not parser.tables:
        return []
    raw_rows = parser.tables[0]
    rows = []
    for raw_row in raw_rows:
        cells = raw_row
        texts = [cell["text"] for cell in cells]
        if not any(texts):
            continue
        if any(text in fallback_headers for text in texts):
            continue
        row = {}
        for index, header in enumerate(fallback_headers):
            if index < len(cells):
                row[header] = cells[index]["text"]
                if cells[index].get("href"):
                    row[f"{header} URL"] = cells[index]["href"]
        rows.append(row)
    return rows


def requested_thai_date():
    for index, arg in enumerate(sys.argv):
        if arg == "--date" and index + 1 < len(sys.argv):
            return sys.argv[index + 1]
        if arg.startswith("--date="):
            return arg.split("=", 1)[1]
    return os.getenv("TEST_THAI_DATE", "").strip()


def normalize_thai_date(value):
    date_part = value.strip().split()[0] if value else ""
    pieces = date_part.split("/")
    if len(pieces) != 3:
        return date_part
    day, month, year = pieces
    if not day.isdigit() or not month.isdigit() or not year.isdigit():
        return date_part
    return f"{int(day):02d}/{int(month):02d}/{year}"


def thai_today():
    selected_date = requested_thai_date()
    now = datetime.now(BANGKOK_TZ)
    if selected_date:
        return now, normalize_thai_date(selected_date)
    return now, f"{now.day:02d}/{now.month:02d}/{now.year + 543}"


def thai_date_to_date(value):
    normalized = normalize_thai_date(value)
    pieces = normalized.split("/")
    if len(pieces) != 3 or not all(piece.isdigit() for piece in pieces):
        return None
    day, month, year = (int(piece) for piece in pieces)
    if year >= 2400:
        year -= 543
    try:
        return date(year, month, day)
    except ValueError:
        return None


def first_table_rows(html):
    tables = parse_tables(html)
    if not tables:
        return []
    return tables[0]["rows"]


def parse_detail_fields(html):
    text_parser = TextParser()
    text_parser.feed(html)
    fields = {"All Text": " ".join(text_parser.texts)}
    labels = {
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
    }
    texts = text_parser.texts
    for index, text in enumerate(texts):
        if text in labels and index + 1 < len(texts):
            fields[text.rstrip(":").rstrip(".")] = texts[index + 1]

    tables = parse_tables(html)
    for table in tables:
        for row in table["rows"]:
            values = list(row.values())
            for index, value in enumerate(values):
                if not isinstance(value, str) or ":" not in value:
                    continue
                key, current = value.split(":", 1)
                key = key.strip()
                current = current.strip()
                if current:
                    fields[key] = current
                elif index + 1 < len(values):
                    fields[key] = str(values[index + 1]).strip()
    return fields


def enrich_job_detail(row, opener):
    detail_url = row.get("# URL") or row.get("View URL") or row.get("Terminal ID URL")
    if not detail_url:
        return row
    detail_html = fetch_html_with_session(detail_url, opener)
    detail = parse_detail_fields(detail_html)
    enriched = dict(row)
    enriched["Detail URL"] = detail_url
    for key, value in detail.items():
        enriched[f"Detail {key}"] = value
    return enriched


def has_plan_date(row, today):
    return normalize_thai_date(row.get("Detail Plan Date", "")) == today


def get_first_value(row, candidates):
    for candidate in candidates:
        value = row.get(candidate)
        if value:
            return value
    return ""


def row_text(row):
    return " ".join(str(value) for value in row.values() if value)


def target_district(row):
    text = row_text(row)
    for district in TARGET_DISTRICTS:
        if district in text:
            return district
    return ""


def is_target_chonburi_area(row):
    text = row_text(row)
    province = get_first_value(row, ["จังหวัด", "Detail Province", "Province"])
    has_chonburi = TARGET_PROVINCE in province or TARGET_PROVINCE in text
    return has_chonburi and bool(target_district(row))


def is_in_request_to_plan_range(row, today):
    today_date = thai_date_to_date(today)
    request_date = thai_date_to_date(
        get_first_value(row, ["Detail Request Date", "Job Open Date"])
    )
    plan_date = thai_date_to_date(
        get_first_value(row, ["Detail Plan Date", "SLA Date"])
    )
    if not today_date or not request_date or not plan_date:
        return False
    return request_date <= today_date <= plan_date


def collect_jobs(only_today=True):
    _, today = thai_today()
    pages = {}
    errors = []
    opener = None
    try:
        opener = build_authenticated_opener()
    except RuntimeError as exc:
        errors.append(str(exc))
        return {
            "today": today,
            "field_jobs": [],
            "remaining_jobs": [],
            "errors": errors,
        }
    for key, url in JOB_URLS.items():
        try:
            html = fetch_html_with_session(url, opener)
            if key == "field":
                pages[key] = first_table_rows_with_headers(html, FIELD_HEADERS)
            elif key == "remaining":
                pages[key] = first_table_rows_with_headers(html, REMAINING_HEADERS)
            else:
                pages[key] = first_table_rows(html)
        except (HTTPError, URLError, TimeoutError, RuntimeError) as exc:
            errors.append(f"{url}: {exc}")

    field_rows = pages.get("field", [])
    remaining_rows = pages.get("remaining", [])

    field_jobs = []
    for row in field_rows:
        try:
            row = enrich_job_detail(row, opener)
        except (HTTPError, URLError, TimeoutError, RuntimeError) as exc:
            errors.append(f"{row.get('# URL') or row.get('View URL') or 'field detail'}: {exc}")
        if only_today and not has_plan_date(row, today):
            continue
        field_jobs.append(row)

    remaining_jobs = []
    for row in remaining_rows:
        try:
            row = enrich_job_detail(row, opener)
        except (HTTPError, URLError, TimeoutError, RuntimeError) as exc:
            errors.append(f"{row.get('Terminal ID URL') or 'remaining detail'}: {exc}")
        if not is_target_chonburi_area(row):
            continue
        if only_today and not has_plan_date(row, today):
            continue
        remaining_jobs.append(row)

    return {
        "today": today,
        "field_jobs": field_jobs,
        "remaining_jobs": remaining_jobs,
        "errors": errors,
    }


def compact_thai_date(value):
    date_part = normalize_thai_date(value)
    pieces = date_part.split("/")
    if len(pieces) != 3:
        return value
    day, month, year = pieces
    return f"{int(day)}/{int(month)}/{year}"


def terminal_id(row):
    return row.get("Terminal ID") or row.get("TID") or "-"


def build_message(report):
    today = compact_thai_date(report["today"])
    install = []
    deinstall = []
    service = []

    for row in report["remaining_jobs"]:
        service.append(terminal_id(row))

    for row in report["field_jobs"]:
        text = row_text(row).lower()
        if "de-install" in text or "de installation" in text:
            deinstall.append(terminal_id(row))
        else:
            install.append(terminal_id(row))

    total = len(service) + len(install) + len(deinstall)
    lines = [f"Plan onsite {today}"]
    if service:
        lines.append("Service")
        lines.extend(service)
    if install:
        lines.append("Install")
        lines.extend(install)
    if deinstall:
        lines.append("De-install")
        lines.extend(deinstall)

    if total == 0:
        lines.append("standby service")
        lines.append(TARGET_PROVINCE)
    else:
        lines.append(TARGET_PROVINCE)

    if report["errors"]:
        lines.append("")
        lines.append("เช็คบางหน้าไม่สำเร็จ:")
        lines.extend(report["errors"])

    return "\n".join(lines)


def send_line_message(message):
    token = os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "").strip()
    to = os.getenv("LINE_TO", "").strip()
    if not token or not to:
        raise RuntimeError("Missing LINE_CHANNEL_ACCESS_TOKEN or LINE_TO in .env")

    payload = json.dumps(
        {
            "to": to,
            "messages": [{"type": "text", "text": message[:5000]}],
        }
    ).encode("utf-8")
    req = Request(
        "https://api.line.me/v2/bot/message/push",
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(req, timeout=30) as response:
            return response.status, response.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"LINE API error {exc.code}: {body}") from exc


def main():
    load_dotenv()
    alert_enabled = env_bool("EDMS_ALERT_ENABLED", True)
    only_today = env_bool("ONLY_TODAY", True)
    notify_when_empty = env_bool("NOTIFY_WHEN_EMPTY", True)
    dry_run = "--dry-run" in sys.argv
    json_output = "--json" in sys.argv

    if not alert_enabled:
        message = "EDMS LINE alert is disabled."
        if json_output:
            print(
                json.dumps(
                    {
                        "message": message,
                        "has_jobs": False,
                        "disabled": True,
                        "report": {
                            "today": "",
                            "field_jobs": [],
                            "remaining_jobs": [],
                            "errors": [],
                        },
                    },
                    ensure_ascii=False,
                )
            )
            return 0
        print(message)
        return 0

    report = collect_jobs(only_today=only_today)
    message = build_message(report)
    has_jobs = bool(report["field_jobs"] or report["remaining_jobs"])

    if json_output:
        payload = {
            "message": message,
            "has_jobs": has_jobs,
            "report": report,
            "sent_line": False,
        }
        if not dry_run and (has_jobs or notify_when_empty):
            try:
                status, body = send_line_message(message)
                payload["sent_line"] = True
                payload["line_response"] = {"status": status, "body": body}
            except RuntimeError as exc:
                payload["line_error"] = str(exc)
                print(json.dumps(payload, ensure_ascii=False))
                return 1
        print(json.dumps(payload, ensure_ascii=False))
        return 0

    print(message)
    if dry_run or (not has_jobs and not notify_when_empty):
        return 0

    status, body = send_line_message(message)
    print(f"LINE response: {status} {body}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
