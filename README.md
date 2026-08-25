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
