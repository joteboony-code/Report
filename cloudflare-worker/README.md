# EDMS LINE Cloudflare Worker

Worker ตัวนี้ใช้แทนการเปิดคอมหรือ VPS ค้างไว้ โดยให้ Cloudflare Cron เรียกงานทุกวัน

## เวลารัน

ใน `wrangler.toml` ตั้งไว้:

```toml
[triggers]
crons = ["0 0 * * *"]
```

Worker ถูกปลุกทุกนาที แล้วโค้ดจะส่ง LINE เฉพาะเมื่อเวลาไทยตรงกับ `ALERT_TIME` หรือค่าที่บันทึกจากหน้าเว็บ

## ติดตั้ง

```powershell
cd C:\Users\nanta\Report\cloudflare-worker
npm install
```

Login Cloudflare:

```powershell
npx wrangler login
```

## ตั้งค่า secrets

ห้ามใส่ username/password/token ลง git หรือไฟล์ public ให้ใส่เป็น Worker secrets:

```powershell
npx wrangler secret put EDMS_USERNAME
npx wrangler secret put EDMS_PASSWORD
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_TO
npx wrangler secret put ADMIN_TOKEN
```

ถ้าอยากใช้ cookie แทน username/password:

```powershell
npx wrangler secret put EDMS_COOKIE
```

## Deploy

```powershell
npx wrangler deploy
```

หลัง deploy แล้ว Cloudflare จะรันตาม Cron ให้อัตโนมัติ

## หน้าเว็บ

หลัง deploy เปิด URL หลักของ Worker:

```text
https://edms-line-worker.joteboony.workers.dev/
```

หน้าเว็บจะมี:

- ช่องใส่ `ADMIN_TOKEN`
- ปุ่มเช็คงานแบบไม่ส่ง LINE
- ปุ่มส่ง LINE จริง
- ตั้งค่าเปิด/ปิด, เวลาแจ้งเตือน, และแจ้งเมื่อไม่มีงาน

การเช็คงานและส่ง LINE ใช้ได้ทันทีเมื่อใส่ `ADMIN_TOKEN`

ถ้าต้องการให้หน้าเว็บบันทึกค่าเปิด/ปิดและเวลาได้ ต้องสร้าง KV namespace ก่อน

## เปิดให้หน้าเว็บบันทึกค่าได้ด้วย KV

สร้าง KV namespace:

```powershell
npx wrangler kv namespace create EDMS_CONFIG
```

คำสั่งจะคืนค่า `id` กลับมา ให้นำไปใส่ใน `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "EDMS_CONFIG"
id = "id_ที่ได้จากคำสั่ง_create"
```

แล้ว deploy ใหม่:

```powershell
npx wrangler deploy
```

## ทดสอบแบบไม่ส่ง LINE

เปิด URL นี้ โดยใส่ Worker URL ของคุณ:

```powershell
$token = "ADMIN_TOKEN_ที่ตั้งไว้"
Invoke-WebRequest -Headers @{ Authorization = "Bearer $token" } "https://edms-line-worker.joteboony.workers.dev/run"
```

## ทดสอบแบบส่ง LINE จริง

```powershell
$token = "ADMIN_TOKEN_ที่ตั้งไว้"
Invoke-WebRequest -Headers @{ Authorization = "Bearer $token" } "https://edms-line-worker.joteboony.workers.dev/run?send=1"
```

## Health check

```text
https://edms-line-worker.joteboony.workers.dev/health
```

## หมายเหตุด้านความปลอดภัย

- Worker นี้เป็น read-only ต่อ EDMS ยกเว้นการ submit ฟอร์ม login เท่านั้น
- ถ้าเจอหน้า register/sign-up จะหยุดทันที
- Endpoint `/run`, `/api/run`, และ `/api/config` ต้องใช้ `ADMIN_TOKEN`
- Cron จะส่ง LINE จริงเมื่อ `EDMS_ALERT_ENABLED=true`
- ถ้าไม่อยากส่งข้อความตอนงานว่าง ให้ปิดในหน้าเว็บ หรือแก้ `NOTIFY_WHEN_EMPTY=false` ใน `wrangler.toml`
