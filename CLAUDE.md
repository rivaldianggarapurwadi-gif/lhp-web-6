# LHP AKPOL — catatan proyek

Web app untuk taruna Akademi Kepolisian: isi form → keluar dokumen Word
"LHP Kegiatan Positif" sesuai format resmi. Bahasa UI: Indonesia.

Produksi: https://lhpakpol.co (Railway) · repo di-deploy dari root folder ini.

---

## Jalankan

```bash
pip install -r requirements.txt
export SECRET_KEY=dev DATA_DIR=./data
python app.py                    # dev (Flask debug)
# produksi persis seperti Railway:
gunicorn app:app --worker-class gthread --workers 1 --threads 8 --timeout 120
```

## Struktur

```
app.py                    seluruh backend (single file, ~1400 baris)
template_lhp.docx         template Word — sumber kebenaran semua placeholder
DATA_DANTON_DANKI.xlsx    data komando, 3 sheet: "TK I" / "TK II" / "TK III"
templates/                index, login, login_admin, register_form, admin, preview
static/logo.png           dipakai kop dokumen + favicon + og:image
Procfile                  konfigurasi gunicorn (JANGAN ubah ke worker sync, lihat bawah)
```

## Environment variables

| Variable | Wajib | Catatan |
|---|---|---|
| `SECRET_KEY` | ya | session Flask |
| `DATA_DIR` / `RAILWAY_VOLUME_MOUNT_PATH` | ya | folder persisten; tanpa ini data hilang tiap redeploy |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | ya | login `/login-admin` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | ya | OAuth hanya untuk verifikasi saat DAFTAR |
| `ANTHROPIC_API_KEY` | opsional | fitur scan timestamp foto; kosong → fitur balas 503 |
| `DUITKU_MERCHANT_CODE` / `DUITKU_API_KEY` / `DUITKU_ENV` | opsional | kosong → dev mode, token langsung ditambah tanpa bayar |

Callback Duitku: `POST /api/topup/notification` (form-encoded, `resultCode == '00'` = lunas).

---

## Alur akun & token

- **Daftar**: `/register` → Google OAuth (verifikasi identitas saja) → form nama/username/password → akun dibuat, dapat **1 token**.
- **Login**: username + password. Google TIDAK dipakai lagi setelah daftar.
- Satu Google ID hanya boleh dipakai sekali daftar (`get_user_by_google_id`).
- Token: 1 token = 1 dokumen. Regenerasi **1 token/minggu, hanya kalau token == 0**.
- Preview **tidak** memotong token; hanya `/api/generate` yang memotong.

---

## ⚠️ Jebakan yang sudah pernah menggigit

Semua di bawah ini pernah jadi bug nyata. Tolong jangan di-"rapikan" tanpa baca.

### 1. Urutan key di dict `simple` (fill_template) itu SIGNIFIKAN
Replacement dijalankan berurutan, jadi string panjang harus diganti lebih dulu:

- `'(ABRIGTARakhir)'` **harus sebelum** `'ABRIGTAR'` — kalau tidak, jadi `(BRIGKATARakhir)`.
- `'DANTONTAR 1 KOMPI III'` **harus sebelum** `'KOMPI III'` dan `'PLETON 1'`.

Placeholder asli ada di `template_lhp.docx` — cek ke sana, jangan tebak dari output.

### 2. `{#` di CSS mematikan Jinja
`@media(max-width:560px){#id{...}}` → Jinja baca `{#` sebagai pembuka komentar
dan seluruh template gagal render. Selalu beri spasi: `){ #id`.

### 3. Logo tabel harus inline, bukan floating
`_anchor_pic_to_inline()` mengubah gambar anchored di tabel jadi inline sebelum
template diisi. Gambar floating bergeser posisinya di converter PDF selain Word.
Hanya `<pic:pic>` yang dikonversi — garis tanda tangan itu shape, jangan disentuh.

### 4. Preview itu duplikat logika server (client-side)
`buildPreviewHTML()` di `templates/index.html` menghitung ulang uraian, label kompi,
dan blok tanda tangan **di browser** supaya instan. Kalau mengubah `fill_template`,
`parse_tanggal`, `parse_waktu`, `_kompi_label`, atau `TINGKAT_CONFIG` di `app.py`,
**ubah juga di sana** atau preview akan berbeda dari file yang diunduh.

Cara cek cepat: bandingkan string uraian server vs `.uraian` di iframe preview.

### 5. `parse_tanggal` menerima dua format
`"SENIN, 23 AGUSTUS 2026"` dan `"SENIN 23 AGUSTUS 2026"` (tanpa koma).
Tanpa penanganan ini nama hari terbaca sebagai tanggal dan semua bagian bergeser.

### 6. Tingkat III memakai HURUF untuk kompi
TK I & II → romawi (I–V). TK III → huruf (A–E), dan format jabatan Danton
tanpa garis miring: `DANTON TAR 1A`, bukan `DANTON TAR 1/A`. Lihat `_kompi_label()`
dan `_danton_jabatan()`.

### 7. Override sementara: Danki Kompi I TK II
Karena pergantian personel, Kompi I TK II memakai data **Danki II** dan tanda tangan
tertulis `DANKITAR II`. Ada di dua tempat:
- `app.py` → `danki_kompi_label` di `fill_template()`
- `templates/index.html` → `dankiLabel` di `buildPreviewHTML()`

Kalau personel kembali normal, hapus keduanya.

### 8. Penyimpanan: jangan kembali ke `open(path,'w')`
Semua penulisan JSON lewat `_write_json_atomic()` (temp file + `os.replace`) dan
dilindungi `_STORE_LOCK`. Pernah terjadi: worker mati saat menulis → `users.json`
terpotong → loader mengembalikan `{}` → penyimpanan berikutnya menghapus SEMUA akun.
Loader sekarang memakai cache terakhir kalau file rusak, bukan dict kosong.

### 9. Procfile: worker HARUS threaded
`--workers 1` dengan worker sync = satu request pada satu waktu. Route yang
memanggil API luar (Claude 30s, Duitku 15s, Google 10s) akan membekukan seluruh
situs. Terukur: 3.64s → 0.01s setelah pakai `gthread --threads 8`.

Tetap **1 worker** karena penyimpanan berbasis file diamankan lock dalam-proses;
menambah worker = proses terpisah = lock tidak berlaku lagi.

---

## Cache

- `_users_cache`, `_xlsx_cache` — invalidasi lewat `os.path.getmtime`.
- Statistik pengunjung ditahan di memori, flush ke disk tiap `VISIT_FLUSH_SECS` (30s)
  dan saat proses berhenti (`atexit`).
- **Konsekuensi**: mengganti `DATA_DANTON_DANKI.xlsx` langsung terbaca (mtime berubah),
  tapi mengedit `users.json` manual di disk baru terbaca setelah mtime berubah juga.

---

## Desain UI

Sistem desain ala Apple, token ada di tiap `<style>`:
ink `#1d1d1f` · canvas `#f5f5f7` · biru `#0071e3` **hanya** untuk tombol terisi ·
tanpa shadow · radius kartu 28px · tombol pill · SF Pro dengan tracking negatif ·
hierarki dari pergantian pita putih/abu, bukan garis atau warna.

Aksen oranye `#b64400` maksimal sekali per halaman.

---

## Cara tes (tanpa deploy)

```bash
# 1. semua template render
python3 -c "
from jinja2 import Environment, FileSystemLoader
env=Environment(loader=FileSystemLoader('templates'))
print(env.get_template('index.html').render(request=None, user_tokens=1, user_name='x',
  user_picture='', token_packages=[], duitku_configured=False)[:1])"

# 2. generate dokumen langsung
python3 -c "
import os; os.environ['DATA_DIR']='/tmp/t'; os.makedirs('/tmp/t',exist_ok=True)
import app
app.fill_template({...}, [], '/tmp/out.docx')"

# 3. lihat hasilnya sebagai gambar
soffice --headless --convert-to pdf --outdir /tmp /tmp/out.docx
pdftoppm -png -r 80 /tmp/out.pdf /tmp/page
```

---

## Yang belum selesai

- Sheet **TK I** di Excel masih kosong (placeholder). Format kolom:
  `NO | NAMA | PANGKAT | JABATAN | NRP`, jabatan `DANKI TAR I`, `DANTON TAR 1/I`.
- Beberapa NRP Danki TK III kosong (Danki A dan B).
- Verifikasi merchant Duitku belum tuntas → produksi masih jalan di dev mode
  kalau env var kosong.
- `/api/preview` (server-side, `templates/preview.html`) sudah tidak dipakai UI
  karena preview pindah ke client. Masih ada; aman dihapus kalau mau bersih-bersih.
