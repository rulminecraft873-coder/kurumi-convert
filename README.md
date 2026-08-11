# Kurumi ConvertSW — Web (Railway) + Bot Claim via HTTP API

## Fitur
1. **Upload File** — convert video lokal ke HD status WA atau compress.
2. **Dari Link** — paste link TikTok/Instagram/dll, otomatis di-download lewat instance cobalt (yang sama dipakai Kurumi DL) lalu langsung diproses, gak perlu download manual dulu.
3. **2 Mode**:
   - `status` — potong max 60 detik, kualitas HD, khusus buat status WA
   - `compress` — perkecil ukuran file, tanpa potong durasi, buat video yang kegedean

## Cara kerja
1. User pilih Upload File atau Dari Link, pilih mode (HD Status/Compress).
2. Server proses video (download dulu lewat cobalt kalau dari link) lalu convert pakai ffmpeg sesuai mode.
3. Server generate **kode klaim** (8 karakter).
4. User ketik `.claim <kode>` di bot WhatsApp (jalan di mesin lain, misal Termux/VPS lu).
5. Plugin `claim.js` **manggil API Railway lewat HTTP** buat validasi kode + ambil URL video, lalu kirim ke chat.

Karena komunikasinya lewat HTTP, web dan bot **boleh ada di mesin yang beda-beda** — gak perlu shared folder/filesystem lagi.

## Environment variable
- `COBALT_API_URL` — default `https://cobalt-production-b426.up.railway.app` (instance cobalt Kurumi DL). Ganti kalau instance cobalt-nya pindah.
- `CLAIM_STORAGE_DIR` — opsional, buat override lokasi storage lokal.

## Deploy ke Railway
1. Push folder ini ke repo GitHub baru (atau tambahin sebagai service baru kalau mau digabung ke repo `kurumi-dl` yang udah ada — tapi disaranin bikin repo terpisah biar rapi).
2. Buka railway.app → New Project → Deploy from GitHub repo → pilih repo ini.
3. Railway otomatis detect Node.js dan baca `nixpacks.toml` buat install ffmpeg juga.
4. Setelah deploy sukses, buka tab **Settings → Networking → Generate Domain** buat dapet URL publik (contoh: `kurumi-convertsw-production.up.railway.app`).
5. **Gak perlu set `CLAIM_STORAGE_DIR`** — Railway pakai disk sementara, itu udah cukup karena kode klaim cuma hidup 30 menit.

## Pasang plugin ke bot Ourin/Akuma MD
1. Copy `wa-plugin/claim.js` ke folder plugins bot lu (biasanya `plugins/convert/claim.js`).
2. Ganti baris ini di `claim.js` dengan URL Railway lu (atau set sebagai environment variable `CONVERTSW_API_URL` di proses bot):
```js
const API_BASE_URL = process.env.CONVERTSW_API_URL || 'https://GANTI-DENGAN-URL-RAILWAY-LU.up.railway.app'
```
3. Plugin ini butuh `fetch` bawaan Node 18+ — pastikan versi Node di environment bot lu (Termux/Pterodactyl) minimal v18.

## Testing cepat tanpa bot dulu
Setelah upload dan dapet kode, coba cek langsung di browser:
```
https://<url-railway-lu>/api/claim/<KODE>
```
Kalau muncul JSON dengan `downloadUrl`, berarti API-nya udah kerja.

## Catatan
- Kode klaim expired otomatis 30 menit (bisa diubah lewat `CODE_TTL_MS` di `server.js`).
- File yang expired dan gak diklaim otomatis kehapus tiap 5 menit oleh cleanup job internal.
- Kalau Railway service-nya restart/redeploy pas ada kode yang masih pending, filenya ikut hilang (disk Railway ephemeral) — bukan masalah besar karena user tinggal convert ulang, tapi kasih tau kalau mau nambah Volume persisten di Railway buat jaga-jaga.
- Batas upload 250MB, video otomatis dipotong max 60 detik pas convert (sama kayak plugin `convertsw` original lu).
- Ini pakai JSON file sebagai "database" — cukup buat skala kecil-menengah.
