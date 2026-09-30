# LHP AKPOL

Generator dokumen LHP Kegiatan Positif untuk taruna Akademi Kepolisian.

Isi form → dokumen Word format resmi siap unduh. Dilengkapi scan timestamp foto
otomatis, pengisian data Danton/Danki dari Excel, dan sistem token.

Baca **CLAUDE.md** sebelum mengubah kode — berisi jebakan yang sudah pernah
menyebabkan bug produksi.

## Mulai

```bash
pip install -r requirements.txt
export SECRET_KEY=dev DATA_DIR=./data
python app.py
```

Buka http://127.0.0.1:5000/login

## Scan timestamp foto

Scan memakai `ANTHROPIC_API_KEY` di server. Foto dibaca berdasarkan isi file,
orientasinya diperbaiki, lalu dikirim sebagai JPEG dengan sisi maksimal 1568 px
dan base64 maksimal 4 MiB. Foto asli untuk dokumen tidak diubah oleh proses scan.
HEIC/HEIF memerlukan `pillow-heif` dari requirements.txt; foto yang gagal dibaca
ditolak sebelum dikirim ke layanan AI.

Jika scan gagal, periksa log server dengan awalan `Timestamp scan:`. Log error
API memuat status HTTP, jenis error, request ID, dan pesan provider. Jangan
mengganti API key hanya karena HTTP 400: saldo kredit atau batas pemakaian
Anthropic juga dapat membuat permintaan ditolak. Pesan aplikasi membedakan
masalah saldo, akses, foto, dan layanan sementara. Saldo layanan AI berbeda
dari token dokumen pengguna. Tanggal, waktu, dan tempat tetap dapat diisi manual.

Tes regresi tanpa menghubungi API atau memotong token:

```bash
python -m unittest discover -s tests -v
```

## Duitku checkout

The checkout uses Duitku POP hosted invoices. Set `DUITKU_MERCHANT_CODE`,
`DUITKU_API_KEY`, and `DUITKU_ENV` (`sandbox` or `production`) from the same
Duitku merchant environment. When either credential is missing, checkout is
disabled and callbacks cannot credit tokens. `PUBLIC_BASE_URL` defaults to
`https://lhpakpol.co` and determines Duitku's return and callback URLs.
On `lhpakpol.co`, payment stays disabled unless `DUITKU_ENV=production`; use a
separate test hostname for sandbox checkout.
For production, point Duitku's callback to
`https://lhpakpol.co/api/topup/notification` and keep `DATA_DIR` on the
persistent Railway volume. Payment is confirmed by a signed server callback,
not by the browser redirect. Callback retries credit an order at most once.

If `DUITKU_ENV` is missing, checkout is disabled. Check whether the stored
credentials belong to sandbox or production before deployment.
If invoice creation fails, inspect Railway logs for `Duitku invoice`; the
server records the provider response while the UI shows a safe generic error.

Payment regression checks:

```bash
python -m unittest discover -s tests -v
node tests/test_payment_ui.cjs
```
