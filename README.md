# Form LHP Kegiatan Positif — Web App

Flask web app yang mengisi template `template_lhp.docx` secara otomatis.

## File yang diperlukan (sudah termasuk)
- `app.py` — Flask backend
- `templates/index.html` — halaman form
- `template_lhp.docx` — template Word
- `DATA_DANTON_DANKI.xlsx` — data lookup Danton & Danki

---

## Deploy ke Railway (gratis, ~5 menit)

### 1. Buat akun GitHub
Kalau belum punya, daftar di https://github.com

### 2. Upload project ke GitHub
1. Buka https://github.com/new → buat repo baru (misal: `lhp-app`)
2. Upload semua file dari folder ini ke repo tersebut

### 3. Deploy ke Railway
1. Buka https://railway.app → Login with GitHub
2. Klik **New Project** → **Deploy from GitHub repo**
3. Pilih repo `lhp-app`
4. Railway otomatis mendeteksi `Procfile` dan `requirements.txt`
5. Tunggu ~2 menit → klik **Generate Domain**
6. Buka URL yang diberikan — selesai ✅

---

## Jalankan secara lokal (untuk test)

```bash
pip install -r requirements.txt
python app.py
```
Buka http://localhost:5000
