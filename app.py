"""
LHP Kegiatan Positif — Flask web app
Admin-controlled accounts, token-gated document generation.
"""
import os, re, shutil, uuid, json
from datetime import datetime
from functools import wraps
from flask import (Flask, request, jsonify, send_file,
                   render_template, after_this_request,
                   session, redirect, url_for)
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash

BASE_DIR      = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_FILE = os.path.join(BASE_DIR, "template_lhp.docx")
XLSX_FILE     = os.path.join(BASE_DIR, "DATA_DANTON_DANKI.xlsx")
UPLOAD_FOLDER = os.path.join(BASE_DIR, "tmp")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# ── Persistent data directory ───────────────────────────────────────────────
# Railway (and most PaaS) wipe the container filesystem on every redeploy, so
# users.json MUST live on a mounted persistent volume. Railway auto-sets
# RAILWAY_VOLUME_MOUNT_PATH; DATA_DIR lets you override on other hosts.
# Falls back to BASE_DIR for local dev.
DATA_DIR = (os.environ.get("DATA_DIR")
            or os.environ.get("RAILWAY_VOLUME_MOUNT_PATH")
            or BASE_DIR)
try:
    os.makedirs(DATA_DIR, exist_ok=True)
except Exception:
    DATA_DIR = BASE_DIR  # last-resort fallback

USERS_FILE     = os.path.join(DATA_DIR, "users.json")
_LEGACY_USERS  = os.path.join(BASE_DIR, "users.json")

# Is data actually on a persistent volume, or on the ephemeral container disk?
STORAGE_IS_PERSISTENT = os.path.abspath(DATA_DIR) != os.path.abspath(BASE_DIR)

# One-time migration: if old users.json sits in the code dir (pre-volume) and
# the volume copy doesn't exist yet, move the data onto the volume so existing
# accounts survive the switch.
if not os.path.exists(USERS_FILE) and os.path.exists(_LEGACY_USERS) \
        and os.path.abspath(_LEGACY_USERS) != os.path.abspath(USERS_FILE):
    try:
        shutil.copy2(_LEGACY_USERS, USERS_FILE)
    except Exception:
        pass

# Startup diagnostics — visible in Railway "Deploy Logs". If you DON'T see
# "PERSISTENT volume", accounts WILL be wiped on every redeploy.
import sys as _sys
print("=" * 60, file=_sys.stderr)
print(f"[STORAGE] DATA_DIR            = {DATA_DIR}", file=_sys.stderr)
print(f"[STORAGE] USERS_FILE          = {USERS_FILE}", file=_sys.stderr)
print(f"[STORAGE] RAILWAY_VOLUME_MOUNT_PATH = "
      f"{os.environ.get('RAILWAY_VOLUME_MOUNT_PATH', '(not set)')}", file=_sys.stderr)
print(f"[STORAGE] users.json exists?  = {os.path.exists(USERS_FILE)}", file=_sys.stderr)
if STORAGE_IS_PERSISTENT:
    print("[STORAGE] ✅ Using PERSISTENT volume — data survives redeploy.",
          file=_sys.stderr)
else:
    print("[STORAGE] ⚠️  EPHEMERAL disk — DATA WILL BE WIPED on redeploy! "
          "Attach a Railway Volume to this service.", file=_sys.stderr)
print("=" * 60, file=_sys.stderr)
_sys.stderr.flush()

# ── Config ────────────────────────────────────────────────────────────────────
ADMIN_USERNAME   = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD   = os.environ.get("ADMIN_PASSWORD", "admin123")
TOKENS_PER_ACCOUNT = 8
TOKENS_PER_DOC     = 1

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "lhp-akpol-secret-2026-xK9mP")
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024

# ── User store ────────────────────────────────────────────────────────────────

def _load_users():
    if not os.path.exists(USERS_FILE):
        return {}
    try:
        with open(USERS_FILE) as f:
            return json.load(f)
    except Exception:
        return {}

def _save_users(users):
    with open(USERS_FILE, 'w') as f:
        json.dump(users, f, indent=2, ensure_ascii=False)

def get_user(username):
    return _load_users().get(username.lower())

def create_user(username, password, name):
    users = _load_users()
    key = username.lower()
    if key in users:
        return None, "Username sudah digunakan"
    users[key] = {
        "username": key,
        "name": name,
        "password": generate_password_hash(password),
        "tokens": TOKENS_PER_ACCOUNT,
        "created_at": datetime.now().isoformat()
    }
    _save_users(users)
    return users[key], None

def delete_user(username):
    users = _load_users()
    key = username.lower()
    if key not in users:
        return False
    del users[key]
    _save_users(users)
    return True

def use_token(username):
    users = _load_users()
    key = username.lower()
    if key not in users:
        return False
    if users[key].get("tokens", 0) < TOKENS_PER_DOC:
        return False
    users[key]["tokens"] -= TOKENS_PER_DOC
    _save_users(users)
    return True

# ── Auth decorators ───────────────────────────────────────────────────────────

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "username" not in session:
            if request.is_json or request.path.startswith('/api/'):
                return jsonify({"error": "Login diperlukan", "redirect": "/login"}), 401
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated

def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "username" not in session:
            if request.is_json or request.path.startswith('/api/'):
                return jsonify({"error": "Sesi habis. Silakan login ulang.", "redirect": "/login"}), 401
            return redirect(url_for('login'))
        if session.get("role") != "admin":
            if request.is_json or request.path.startswith('/api/'):
                return jsonify({"error": "Akses ditolak. Bukan admin."}), 403
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated

# ── Roman numeral ─────────────────────────────────────────────────────────────

def to_roman(n) -> str:
    try: n = int(n)
    except: return str(n)
    vals = [(1000,'M'),(900,'CM'),(500,'D'),(400,'CD'),(100,'C'),(90,'XC'),
            (50,'L'),(40,'XL'),(10,'X'),(9,'IX'),(5,'V'),(4,'IV'),(1,'I')]
    r = ''
    for v, s in vals:
        while n >= v: r += s; n -= v
    return r or str(n)

# ── Pangkat abbreviation ─────────────────────────────────────────────────────

PANGKAT_SINGKAT = {
    'BHAYANGKARA TARUNA':   'BHATAR',
    'AJUN BRIGADIR TARUNA': 'ABRIGTAR',
}

def pangkat_singkat(p: str) -> str:
    return PANGKAT_SINGKAT.get(p.upper().strip(), p.upper().strip())

# ── Date / time parsers ───────────────────────────────────────────────────────

MONTHS_ID    = ['','JANUARI','FEBRUARI','MARET','APRIL','MEI','JUNI',
                'JULI','AGUSTUS','SEPTEMBER','OKTOBER','NOVEMBER','DESEMBER']
MONTHS_SHORT = {'jan':1,'feb':2,'mar':3,'apr':4,'mei':5,'jun':6,
                'jul':7,'agu':8,'sep':9,'okt':10,'nov':11,'des':12}

def parse_tanggal(s):
    s = s.strip(); hari = ''
    parts = s.split(',', 1)
    date_part = parts[1].strip() if len(parts) == 2 else s
    if len(parts) == 2: hari = parts[0].strip().upper()
    tokens = date_part.split()
    tgl_num   = tokens[0] if tokens else ''
    bulan_raw = tokens[1].lower().rstrip('.') if len(tokens) > 1 else ''
    tahun_str = tokens[2] if len(tokens) > 2 else ''
    idx = MONTHS_SHORT.get(bulan_raw[:3], 0)
    bulan_str = MONTHS_ID[idx] if idx else bulan_raw.upper()
    return hari, tgl_num, bulan_str, tahun_str

def parse_waktu(s):
    s = re.sub(r'\s*(WIB|WITA|WIT)\s*$', '', s.strip(), flags=re.IGNORECASE)
    return s.replace(':', '.').strip()

# ── Danton / Danki lookup ─────────────────────────────────────────────────────

def _load_xlsx():
    try:
        import openpyxl
        wb = openpyxl.load_workbook(XLSX_FILE, data_only=True)
        ws = wb.active
        rows = list(ws.iter_rows(values_only=True))
        if not rows: return []
        headers = [str(h).strip() if h else '' for h in rows[0]]
        return [{headers[i]: (str(rows[j][i]).strip() if rows[j][i] is not None else '')
                 for i in range(len(headers))}
                for j in range(1, len(rows)) if any(rows[j])]
    except Exception:
        return []

def _norm(jab):
    jab = jab.upper().strip()
    jab = re.sub(r'DANKITAR',  'DANKI TAR',  jab)
    jab = re.sub(r'DANTONTAR', 'DANTON TAR', jab)
    return re.sub(r'\s+', ' ', jab)

def lookup_danton(peleton, kompi):
    target = f"DANTON TAR {peleton}/{to_roman(kompi)}"
    for row in _load_xlsx():
        if _norm(row.get('JABATAN','')) == target:
            return {'Nama Danton': row.get('NAMA',''),
                    'Pangkat Danton': row.get('PANGKAT',''),
                    'NRP Danton': row.get('NRP','')}
    return None

def lookup_danki(kompi):
    target = f"DANKI TAR {to_roman(kompi)}"
    for row in _load_xlsx():
        if _norm(row.get('JABATAN','')) == target:
            return {'Nama Danki': row.get('NAMA',''),
                    'Pangkat Danki': row.get('PANGKAT',''),
                    'NRP Danki': row.get('NRP','')}
    return None

# ── Docx helpers ──────────────────────────────────────────────────────────────

def _has_drawing(run):
    from docx.oxml.ns import qn
    el = run._element
    return (el.find(qn('w:drawing')) is not None or
            el.find('{http://schemas.openxmlformats.org/markup-compatibility/2006}AlternateContent') is not None)

def _replace_para(para, old, new):
    text_runs = [r for r in para.runs if not _has_drawing(r)]
    full = ''.join(r.text for r in text_runs)
    if old not in full: return False
    if text_runs:
        text_runs[0].text = full.replace(old, new)
        for r in text_runs[1:]: r.text = ''
    return True

def _all_paragraphs(doc):
    for p in doc.paragraphs: yield p
    for tbl in doc.tables:
        for row in tbl.rows:
            for cell in row.cells:
                for p in cell.paragraphs: yield p

def _downscale_image(path, max_edge=1280, quality=82):
    """Resize a (possibly huge phone) photo to a small temp JPEG before
    embedding. python-docx embeds the original bytes, so full-res photos
    bloat the docx and spike memory. Returns a path to use for embedding
    (the downscaled temp file, or the original if anything fails)."""
    try:
        from PIL import Image, ImageOps
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im)   # honor phone rotation
            if im.mode not in ('RGB', 'L'):
                im = im.convert('RGB')
            w, h = im.size
            scale = min(1.0, max_edge / float(max(w, h)))
            if scale < 1.0:
                im = im.resize((max(1, int(w * scale)),
                                max(1, int(h * scale))), Image.LANCZOS)
            out = path + '.small.jpg'
            im.save(out, 'JPEG', quality=quality, optimize=True)
            return out
    except Exception:
        return path  # fall back to original on any error

def _insert_images(doc, placeholder, image_paths):
    from docx.shared import Inches
    from lxml import etree
    target = None
    for para in _all_paragraphs(doc):
        if placeholder in ''.join(r.text for r in para.runs):
            target = para; break
    if not target: return
    for r in target.runs: r.text = ''
    _scaled_tmp = []
    for path in image_paths:
        if path and os.path.exists(path):
            small = _downscale_image(path)
            if small != path:
                _scaled_tmp.append(small)
            run = target.add_run()
            try: run.add_picture(small, width=Inches(2.8))
            except: run.text = f'[{os.path.basename(path)}]'
    for p in _scaled_tmp:
        try: os.remove(p)
        except: pass
    body = doc.element.body
    try: img_idx = list(body).index(target._element)
    except ValueError: return
    to_remove = []
    for el in list(body)[img_idx + 1:]:
        tag = el.tag.split('}')[-1] if '}' in el.tag else el.tag
        if tag != 'p': break
        texts = re.findall(r'<w:t[^>]*>([^<]+)</w:t>', etree.tostring(el, encoding='unicode'))
        if ''.join(texts).strip(): break
        to_remove.append(el)
    for el in to_remove: body.remove(el)

def _fix_signature_formatting(doc, pangkat_danton, nrp_danton,
                               nama_danki, pangkat_danki, nrp_danki,
                               pangkat_abbr='ABRIGTAR'):
    from lxml import etree
    W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    def wtag(n): return f'{{{W}}}{n}'
    def rm_italic(para):
        for rpr in para._element.iter(wtag('rPr')):
            for tag in (wtag('i'), wtag('iCs')):
                for el in list(rpr.findall(tag)): rpr.remove(el)
    def set_center(para):
        pPr = para._element.find(wtag('pPr'))
        if pPr is None:
            pPr = etree.SubElement(para._element, wtag('pPr'))
            para._element.insert(0, pPr)
        jc = pPr.find(wtag('jc'))
        if jc is None: jc = etree.SubElement(pPr, wtag('jc'))
        jc.set(wtag('val'), 'center')
    for para in _all_paragraphs(doc):
        full = ''.join(r.text for r in para.runs if not _has_drawing(r))
        if ('(Nama lengkap dan gelar dankitar)' in full or
            (nama_danki and nama_danki in full and pangkat_abbr not in full
             and 'NRP' not in full and '(Nama lengkap dan gelar dantontar)' not in full)):
            rm_italic(para)
        elif ('(Pangkat danki)' in full or '(NRP Danki)' in full or
              (pangkat_danki and pangkat_danki in full and nrp_danki and
               nrp_danki in full and pangkat_abbr not in full)):
            rm_italic(para)
        if ('(Pangkat danton)' in full or '(NRP Danton)' in full or
            (pangkat_danton and pangkat_danton in full and
             nrp_danton and nrp_danton in full and pangkat_abbr in full)):
            set_center(para)

def fill_template(data, image_paths, output_path):
    from docx import Document
    shutil.copy(TEMPLATE_FILE, output_path)
    doc = Document(output_path)

    nama           = data['Nama']
    no_ak          = data['No Ak']
    pangkat        = data['Pangkat'].upper()
    pangkat_abbr   = pangkat_singkat(pangkat)
    peleton        = data['Peleton']
    kompi_roman    = to_roman(data['Kompi'])
    nama_kegiatan  = data['Nama Kegiatan']
    tanggal_raw    = data['Tanggal Kegiatan']
    waktu_raw      = data['Waktu Kegiatan']
    tempat         = data['Tempat Kegiatan']
    nama_danton    = data['Nama Danton']
    pangkat_danton = data['Pangkat Danton']
    nrp_danton     = data['NRP Danton']
    nama_danki     = data['Nama Danki']
    pangkat_danki  = data['Pangkat Danki']
    nrp_danki      = data['NRP Danki']

    hari, tgl_num, bulan_str, tahun_str = parse_tanggal(tanggal_raw)
    waktu_clean = parse_waktu(waktu_raw)

    uraian = (
        f"--------PADA HARI {hari} TANGGAL {tgl_num} BULAN {bulan_str} "
        f"TAHUN {tahun_str} PUKUL {waktu_clean} WIB, SAYA {nama} "
        f"TARUNA AKPOL, PANGKAT {pangkat}, NO AKADEMI {no_ak}, "
        f"ANGKATAN KE-60, BATALYON MANGGALA SATYA, "
        f"TELAH MELAKSANAKAN KEGIATAN POSITIF BERUPA {nama_kegiatan.upper()}.-"
    )

    simple = {
        '(No. Ak. Panjang)':                      no_ak,
        '(Nama lengkap taruna)':                  nama,
        'KOMPI III':                              f'KOMPI {kompi_roman}',
        'PLETON 1':                               f'PLETON {peleton}',
        '(Judul Kegiatan)':                       nama_kegiatan,
        '(Hari, Tanggal, pukul)':                 f'{tanggal_raw}, {waktu_raw}',
        '(Lokasi pelaksanaan kegiatan, lengkap)':  tempat,
        '(Tempat)':                               'Semarang',
        '(Tanggal Bulan Tahun)':                  tanggal_raw,
        'DANTONTAR 1 KOMPI III':                  f'DANTONTAR {peleton} KOMPI {kompi_roman}',
        '(Nama lengkap dan gelar dantontar)':     nama_danton,
        '(Pangkat danton)':                       pangkat_danton,
        '(NRP Danton)':                           nrp_danton,
        'ABRIGTAR':                               pangkat_abbr,
        '(No Ak ttd)':                            no_ak,
        '(Nama Lengkap)':                         nama,
        'DANKITAR III':                           f'DANKITAR {kompi_roman}',
        '(Nama lengkap dan gelar dankitar)':      nama_danki,
        '(Pangkat danki)':                        pangkat_danki,
        '(NRP Danki)':                            nrp_danki,
        '(tempat ttd)':                           'Semarang',
        '(tanggal buat laporan ttd)':             tanggal_raw,
        '(Nama Lengkap ttd)':                     nama,
        '(ABRIGTARakhir)':                        pangkat_abbr,
        '(No. Ak. Panjang ttd)':                  no_ak,
    }

    for para in _all_paragraphs(doc):
        full = ''.join(r.text for r in para.runs if not _has_drawing(r))
        if '--------PADA HARI' in full:
            text_runs = [r for r in para.runs if not _has_drawing(r)]
            if text_runs:
                text_runs[0].text = uraian
                for r in text_runs[1:]: r.text = ''
            continue
        for old, new in simple.items():
            _replace_para(para, old, new)

    valid_imgs = [p for p in image_paths if p and os.path.exists(p)]
    if valid_imgs:
        _insert_images(doc, '(Dokumentasi)', valid_imgs)

    _fix_signature_formatting(doc, pangkat_danton, nrp_danton,
                               nama_danki, pangkat_danki, nrp_danki,
                               pangkat_abbr)
    doc.save(output_path)

# ══════════════════════════════════════════════════════════════════════════════
# Routes — Auth
# ══════════════════════════════════════════════════════════════════════════════

@app.route('/')
def index():
    if 'username' not in session:
        return redirect(url_for('login'))
    if session.get('role') == 'admin':
        return redirect(url_for('admin_panel'))
    user = get_user(session['username'])
    if not user:
        session.clear()
        return redirect(url_for('login'))
    return render_template('index.html',
                           user_name=user['name'],
                           user_tokens=user.get('tokens', 0))

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'GET':
        return render_template('login.html')
    data     = request.get_json() or {}
    username = data.get('username', '').strip().lower()
    password = data.get('password', '')
    # Check admin
    if username == ADMIN_USERNAME.lower() and password == ADMIN_PASSWORD:
        session['username'] = username
        session['role']     = 'admin'
        return jsonify({'ok': True, 'redirect': '/admin'})
    # Check user
    user = get_user(username)
    if not user or not check_password_hash(user['password'], password):
        return jsonify({'error': 'Username atau password salah'}), 401
    session['username'] = username
    session['role']     = 'user'
    return jsonify({'ok': True, 'redirect': '/'})

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))

@app.route('/ads.txt')
def ads_txt():
    return send_file(os.path.join(BASE_DIR, 'static', 'ads.txt'),
                     mimetype='text/plain')

# ══════════════════════════════════════════════════════════════════════════════
# Routes — Admin panel
# ══════════════════════════════════════════════════════════════════════════════

@app.route('/admin')
@admin_required
def admin_panel():
    users = _load_users()
    user_list = sorted(users.values(), key=lambda u: u.get('created_at',''))
    return render_template('admin.html', users=user_list,
                           tokens_per_account=TOKENS_PER_ACCOUNT,
                           storage_persistent=STORAGE_IS_PERSISTENT,
                           data_dir=DATA_DIR)

@app.route('/api/admin/create-user', methods=['POST'])
@admin_required
def admin_create_user():
    data     = request.get_json() or {}
    username = data.get('username', '').strip()
    password = data.get('password', '').strip()
    name     = data.get('name', '').strip()
    if not username or not password or not name:
        return jsonify({'error': 'Semua field harus diisi'}), 400
    if len(password) < 4:
        return jsonify({'error': 'Password minimal 4 karakter'}), 400
    user, err = create_user(username, password, name)
    if err:
        return jsonify({'error': err}), 400
    return jsonify({'ok': True, 'user': {
        'username': user['username'],
        'name': user['name'],
        'tokens': user['tokens'],
        'created_at': user['created_at']
    }})

@app.route('/api/admin/delete-user', methods=['POST'])
@admin_required
def admin_delete_user():
    data     = request.get_json() or {}
    username = data.get('username', '').strip().lower()
    if not username:
        return jsonify({'error': 'Username diperlukan'}), 400
    if delete_user(username):
        return jsonify({'ok': True})
    return jsonify({'error': 'User tidak ditemukan'}), 404

@app.route('/api/admin/reset-tokens', methods=['POST'])
@admin_required
def admin_reset_tokens():
    data     = request.get_json() or {}
    username = data.get('username', '').strip().lower()
    users    = _load_users()
    if username not in users:
        return jsonify({'error': 'User tidak ditemukan'}), 404
    users[username]['tokens'] = TOKENS_PER_ACCOUNT
    _save_users(users)
    return jsonify({'ok': True, 'tokens': TOKENS_PER_ACCOUNT})

@app.route('/api/admin/set-tokens', methods=['POST'])
@admin_required
def admin_set_tokens():
    data     = request.get_json() or {}
    username = data.get('username', '').strip().lower()
    try:
        tokens = int(data.get('tokens', -1))
    except (ValueError, TypeError):
        return jsonify({'error': 'Jumlah token tidak valid'}), 400
    if tokens < 0:
        return jsonify({'error': 'Token tidak boleh negatif'}), 400
    if tokens > 999:
        return jsonify({'error': 'Token maksimal 999'}), 400
    users = _load_users()
    if username not in users:
        return jsonify({'error': 'User tidak ditemukan'}), 404
    users[username]['tokens'] = tokens
    _save_users(users)
    return jsonify({'ok': True, 'tokens': tokens})

# ══════════════════════════════════════════════════════════════════════════════
# Routes — App
# ══════════════════════════════════════════════════════════════════════════════

@app.route('/api/lookup', methods=['GET'])
@login_required
def api_lookup():
    peleton = request.args.get('peleton', '').strip()
    kompi   = request.args.get('kompi', '').strip()
    if not peleton or not kompi:
        return jsonify({'error': 'peleton dan kompi diperlukan'}), 400
    danton = lookup_danton(peleton, kompi)
    danki  = lookup_danki(kompi)
    return jsonify({
        'danton': danton, 'danki': danki,
        'label': f"DANTON TAR {peleton}/{to_roman(kompi)}  |  DANKI TAR {to_roman(kompi)}"
                 if danton and danki else None,
    })

@app.route('/api/token-balance', methods=['GET'])
@login_required
def token_balance():
    user = get_user(session['username'])
    return jsonify({'tokens': user.get('tokens', 0)})

@app.route('/api/generate', methods=['POST'])
@login_required
def api_generate():
    import tempfile
    user = get_user(session['username'])
    if user.get('tokens', 0) < TOKENS_PER_DOC:
        return jsonify({'error': 'Token habis. Hubungi admin untuk reset token.',
                        'no_token': True}), 402

    fields = ['Nama','No Ak','Pangkat','Peleton','Kompi',
              'Nama Danton','Pangkat Danton','NRP Danton',
              'Nama Danki','Pangkat Danki','NRP Danki',
              'Nama Kegiatan','Tanggal Kegiatan','Waktu Kegiatan','Tempat Kegiatan']
    data = {}
    for f in fields:
        val = request.form.get(f, '').strip()
        if not val:
            return jsonify({'error': f'Field "{f}" tidak boleh kosong'}), 400
        data[f] = val

    image_paths = []
    image_tmpfiles = []
    for i in range(1, 5):
        file = request.files.get(f'foto_{i}')
        if file and file.filename:
            ext = os.path.splitext(secure_filename(file.filename))[1] or '.jpg'
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext, dir=UPLOAD_FOLDER)
            file.save(tmp.name)
            tmp.close()
            image_paths.append(tmp.name)
            image_tmpfiles.append(tmp.name)

    out_tmp  = tempfile.NamedTemporaryFile(delete=False, suffix='.docx', dir=UPLOAD_FOLDER)
    out_path = out_tmp.name
    out_tmp.close()
    out_name = f"LHP_{data['Nama'].replace(' ','_')}_{uuid.uuid4().hex[:6]}.docx"

    try:
        fill_template(data, image_paths, out_path)
    except Exception as e:
        for p in image_tmpfiles + [out_path]:
            try: os.remove(p)
            except: pass
        return jsonify({'error': str(e)}), 500
    finally:
        for p in image_tmpfiles:
            try: os.remove(p)
            except: pass

    use_token(session['username'])

    @after_this_request
    def cleanup(response):
        try: os.remove(out_path)
        except: pass
        return response

    return send_file(out_path, as_attachment=True,
                     download_name=out_name,
                     mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document')

if __name__ == '__main__':
    app.run(debug=True)
