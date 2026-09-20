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
