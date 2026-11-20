# jiyy-mail

Temp mail di atas Cloudflare Workers + D1 + Email Routing. Frontend statis di `public/`.

## Setup

1. Install dependensi dan login:
   ```
   npm install
   npx wrangler login
   ```
2. Buat database D1, lalu salin `database_id` yang muncul ke `wrangler.toml`:
   ```
   npx wrangler d1 create jiyy-mail
   ```
3. Buat tabel:
   ```
   npm run db:init
   ```
4. Deploy:
   ```
   npm run deploy
   ```
5. Di dashboard Cloudflare, domain `jiyy.dev` (DNS harus di Cloudflare):
   **Email → Email Routing → Enable**, lalu **Routing rules → Catch-all address**
   → Action: **Send to a Worker** → pilih `jiyy-mail` → Save.

Selesai. Buka URL worker (atau pasang custom domain di Workers → Settings → Domains), kirim email ke alamat yang tampil, pesan muncul dalam ~5 detik.

## Test lokal

```
npm run db:init:local
npm run dev
```

(Penerimaan email tidak bisa dites lokal secara nyata, tapi API dan UI jalan.)

## Konfigurasi (`wrangler.toml`)

- `DOMAIN`: domain email kamu
- `TTL_MINUTES`: umur email sebelum dihapus cron
- `MAX_EMAIL_BYTES`: batas ukuran email

## Deploy otomatis dari GitHub

Push ke repo, lalu di Cloudflare: **Workers & Pages → Create → Import a repository**. Build command kosong, deploy command `npx wrangler deploy`.
