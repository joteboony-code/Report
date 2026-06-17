# EDMS Daily LINE Job Notifier

สคริปต์นี้เช็คงานจาก 2 หน้า:

- `https://www.castles-th.com/fldjobs`
- `https://www.castles-th.com/showarea/3`

แล้วส่งสรุปเข้า LINE ทุกเช้าผ่าน LINE Messaging API

## ตั้งค่าครั้งแรก

สคริปต์นี้ล็อกอินเข้า EDMS ได้จากค่า `EDMS_USERNAME` และ `EDMS_PASSWORD` ใน `.env` แล้วไปเช็ค 2 หน้างานตาม flow ที่กำหนด แต่ห้ามแตะหน้าสมัครสมาชิกหรือปุ่ม `Register Now` เด็ดขาด และห้ามกรอกข้อมูลใด ๆ ในหน้าสมัครสมาชิกทุกกรณี ถ้าเจอหน้าสมัครสมาชิก สคริปต์จะหยุดทันที

1. คัดลอก `.env.example` เป็น `.env`
2. ใส่ค่า `EDMS_USERNAME` และ `EDMS_PASSWORD` สำหรับล็อกอิน EDMS หรือใส่ `EDMS_COOKIE` ถ้าต้องการใช้ session ที่ล็อกอินอยู่แล้ว ฟอร์ม login ของ EDMS ใช้ field `user_name`, `password` และ `_token` ซึ่งสคริปต์อ่านจากหน้า login ให้อัตโนมัติ
3. ใส่ `LINE_CHANNEL_ACCESS_TOKEN` จาก LINE Developers
4. ใส่ `LINE_TO` เป็น userId, groupId หรือ roomId ปลายทาง

ตัวอย่างรันทดสอบแบบไม่ส่ง LINE:

```powershell
python .\daily_line_jobs.py --dry-run
```

รันทดสอบส่ง LINE จริง:

```powershell
python .\daily_line_jobs.py
```

หน้าเว็บสำหรับดู/แก้ไขค่าและทดสอบ:

```powershell
python .\web_dashboard.py
```

แล้วเปิด `http://127.0.0.1:8765`

การเลือกงานที่จะส่ง LINE จะยึด `Plan Date` จากหน้ารายละเอียดงานเท่านั้น โดยสคริปต์จะเปิดลิงก์รายละเอียดของแต่ละงานจาก 2 หน้างาน แล้วส่งเฉพาะรายการที่ `Plan Date` ตรงกับวันนั้น

ปุ่มเปิด/ปิดระบบบนหน้าเว็บจะเปลี่ยนค่า `EDMS_ALERT_ENABLED` ใน `.env` ถ้าปิดไว้ รอบ automation ตอน 7 โมงจะไม่ล็อกอิน ไม่ดึงงาน และไม่ส่ง LINE

Deploy แบบ local บน Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy_local.ps1
```

คำสั่งนี้จะสร้าง Scheduled Task ชื่อ `EDMS Report Dashboard` ให้เปิด dashboard ตอนล็อกอิน Windows และเริ่ม server ที่ `http://127.0.0.1:8765`

## หมายเหตุ

LINE Notify ปิดบริการแล้วตั้งแต่ 31 มีนาคม 2025 จึงต้องใช้ LINE Messaging API แทน

## กติกาการเลือกงานที่ใช้ตอนนี้

- `fldjobs`: เปิดรายละเอียดงานเพื่ออ่าน `Date Info` แล้วแจ้งเฉพาะงานที่ `Plan Date` ตรงกับวันที่เช็ค
- `showarea/3`: เปิดรายละเอียดงานเพื่ออ่าน `Date Info` แล้วแจ้งเมื่องานอยู่ในช่วง `Request Date` ถึง `Plan Date`
- `showarea/3`: แจ้งเฉพาะงานจังหวัดชลบุรีที่พบอำเภอเป้าหมายในรายละเอียดงาน ได้แก่ พานทอง, พนัสนิคม, เกาะจันทร์, เมือง, บ้านบึง, บ่อทอง
- หน้าเว็บมีค่า `ALERT_TIME` สำหรับแก้เวลาแจ้งเตือนรายวัน รูปแบบ `HH:MM` ค่าเริ่มต้นคือ `07:00`
- ผลการแจ้งเตือนถูกบันทึกไว้ที่ `alert_history.json` และดูได้จากหน้า dashboard

## Deploy

ถ้าจะเอาขึ้นเว็บจริง ให้ดูขั้นตอนใน `DEPLOY.md` และต้องตั้ง `DASHBOARD_PASSWORD` ก่อนเปิด public
