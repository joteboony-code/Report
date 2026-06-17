# Deploy EDMS LINE Alert

แอปนี้เป็น Python web app ที่ต้องรันเป็น process ตลอดเวลา ไม่ใช่เว็บ static ที่อัปโหลดไฟล์ HTML อย่างเดียวแล้วจบ

## ก่อนเปิดเป็นเว็บจริง

ตั้งค่าใน `.env`:

```env
EDMS_DASHBOARD_HOST=0.0.0.0
EDMS_DASHBOARD_PORT=8765
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=change-this-password
EDMS_ALERT_ENABLED=true
ALERT_TIME=07:00
```

ข้อสำคัญ:

- ต้องตั้ง `DASHBOARD_PASSWORD` ก่อนเปิด public
- ควรเปิดผ่าน HTTPS เท่านั้น
- ควรให้ reverse proxy เช่น Nginx/Caddy รับ HTTPS ด้านหน้า แล้ว proxy เข้า `127.0.0.1:8765`
- อย่าเปิดไฟล์ `.env`, `alert_history.json`, หรือ source code ให้ download ได้จาก public web root
- Dashboard นี้มี EDMS password และ LINE token จึงควรจำกัด IP หรือซ่อนไว้หลัง VPN ถ้าทำได้

## รันบน VPS

เข้าโฟลเดอร์โปรเจกต์ แล้วรัน:

```bash
python web_dashboard.py
```

จากนั้นเปิด:

```text
http://SERVER_IP:8765
```

ถ้าเปิดผ่าน reverse proxy ให้ชี้โดเมนไปที่ proxy แล้ว proxy กลับมาที่ port `8765`

## Deploy ผ่าน Cloudflare Tunnel

วิธีนี้เหมาะกับแอปนี้มากกว่า Cloudflare Pages เพราะแอปต้องรัน Python, login EDMS, ตั้ง scheduler, และส่ง LINE ทุกวัน

Cloudflare Pages ใช้ได้ดีสำหรับเว็บ static/frontend แต่ไม่เหมาะกับการรัน Python process ตัวนี้ตลอดเวลา ให้ใช้ Cloudflare Tunnel แทน

### ตั้งค่าแอป

ถ้าใช้ Cloudflare Tunnel ไม่จำเป็นต้องเปิด port public ที่เครื่อง ให้รันแอปแบบ local-only:

```env
EDMS_DASHBOARD_HOST=127.0.0.1
EDMS_DASHBOARD_PORT=8765
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=change-this-password
```

จากนั้นรัน:

```bash
python web_dashboard.py
```

### ตั้งค่า Cloudflare Tunnel

ตัวอย่าง `cloudflared` config:

```yaml
tunnel: edms-line-alert
credentials-file: /path/to/edms-line-alert.json

ingress:
  - hostname: edms.example.com
    service: http://127.0.0.1:8765
  - service: http_status:404
```

จากนั้นให้ Cloudflare Tunnel ชี้ public hostname เช่น `edms.example.com` มาที่ `http://127.0.0.1:8765`

### แนะนำความปลอดภัยบน Cloudflare

- เปิด Cloudflare Access / Zero Trust เพื่อให้เฉพาะอีเมลของคุณเข้า dashboard ได้
- ยังต้องตั้ง `DASHBOARD_PASSWORD` ในแอปไว้ด้วย ถึงแม้จะใช้ Cloudflare Access แล้ว
- อย่าเปิด direct port `8765` ออก Internet ถ้าใช้ Tunnel
- ให้เครื่อง/VPS ที่รัน Python เปิดตลอดเวลา เพราะ scheduler จะทำงานเมื่อ `web_dashboard.py` ยังรันอยู่เท่านั้น

## Deploy แบบ Cloudflare Worker Cron

ถ้าไม่ต้องการเปิดคอม/VPS ค้างไว้ ให้ใช้โปรเจกต์ใน `cloudflare-worker/`

```powershell
cd C:\Users\nanta\Report\cloudflare-worker
npm install
npx wrangler login
npx wrangler secret put EDMS_USERNAME
npx wrangler secret put EDMS_PASSWORD
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_TO
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

Cron ใน `wrangler.toml` ตั้งไว้ที่ `0 0 * * *` ซึ่งเท่ากับ 07:00 เวลาไทย

ทดสอบไม่ส่ง LINE:

```powershell
Invoke-WebRequest -Headers @{ Authorization = "Bearer ADMIN_TOKEN_ที่ตั้งไว้" } "https://edms-line-worker.joteboony.workers.dev/run"
```

ทดสอบส่ง LINE จริง:

```powershell
Invoke-WebRequest -Headers @{ Authorization = "Bearer ADMIN_TOKEN_ที่ตั้งไว้" } "https://edms-line-worker.joteboony.workers.dev/run?send=1"
```

## ตั้งให้รันอัตโนมัติบน Linux systemd

สร้างไฟล์ `/etc/systemd/system/edms-line-alert.service`:

```ini
[Unit]
Description=EDMS LINE Alert Dashboard
After=network.target

[Service]
WorkingDirectory=/path/to/Report
ExecStart=/usr/bin/python3 /path/to/Report/web_dashboard.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

เปิด service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable edms-line-alert
sudo systemctl start edms-line-alert
sudo systemctl status edms-line-alert
```

## ทดสอบแบบไม่ส่ง LINE

```bash
python daily_line_jobs.py --dry-run
```

## ทดสอบหน้าเว็บ

```bash
python web_dashboard.py
```

แล้วเข้า `http://127.0.0.1:8765`
