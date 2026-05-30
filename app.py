"""
LHP Kegiatan Positif — Flask web app with token + Midtrans payment
"""
import os, re, shutil, uuid, json, hashlib, hmac
from datetime import datetime, date
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
USERS_FILE    = os.path.join(BASE_DIR, "users.json")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# ── Midtrans config ───────────────────────────────────────────────────────────
MIDTRANS_SERVER_KEY = "Mid-server-pkRweEdXUJ8LNPne8QGDdl1g"
MIDTRANS_CLIENT_KEY = "Mid-client-ExYTb9mt4x5sJ-PJ"
MIDTRANS_IS_PRODUCTION = True
MIDTRANS_SNAP_URL = "https://app.midtrans.com/snap/snap.js"
TOKEN_PRICE    = 100000   # Rp100.000
TOKENS_PER_BUY = 10       # 10 tokens per purchase
TOKENS_PER_DOC = 1        # 1 token per document

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "lhp-akpol-secret-2026-xK9mP")
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024

# ── User store (JSON file) ────────────────────────────────────────────────────

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
        json.dump(users, f, indent=2)

def get_user(email):
    return _load_users().get(email.lower())

def create_user(email, password, name):
    users = _load_users()
    if email.lower() in users:
        return None, "Email sudah terdaftar"
    users[email.lower()] = {
        "email": email.lower(),
        "name": name,
        "password": generate_password_hash(password),
        "tokens": 0,
        "created_at": datetime.now().isoformat()
    }
    _save_users(users)
    return users[email.lower()], None

def add_tokens(email, amount, reason="purchase"):
    users = _load_users()
    if email.lower() not in users:
        return False
    users[email.lower()]["tokens"] = users[email.lower()].get("tokens", 0) + amount
    # Log the transaction
    txns = users[email.lower()].get("transactions", [])
    txns.append({"type": reason, "amount": amount, "at": datetime.now().isoformat()})
    users[email.lower()]["transactions"] = txns[-50:]  # keep last 50
    _save_users(users)
    return True

def use_token(email):
    users = _load_users()
    if email.lower() not in users:
        return False
    if users[email.lower()].get("tokens", 0) < TOKENS_PER_DOC:
        return False
    users[email.lower()]["tokens"] -= TOKENS_PER_DOC
    txns = users[email.lower()].get("transactions", [])
    txns.append({"type": "usage", "amount": -TOKENS_PER_DOC, "at": datetime.now().isoformat()})
    users[email.lower()]["transactions"] = txns[-50:]
    _save_users(users)
    return True

# ── Auth decorator ────────────────────────────────────────────────────────────

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "email" not in session:
            return jsonify({"error": "Login diperlukan", "redirect": "/login"}), 401
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

def _insert_images(doc, placeholder, image_paths):
    from docx.shared import Inches
    from lxml import etree
    target = None
    for para in _all_paragraphs(doc):
        if placeholder in ''.join(r.text for r in para.runs):
            target = para; break
    if not target: return
    for r in target.runs: r.text = ''
    for path in image_paths:
        if path and os.path.exists(path):
            run = target.add_run()
            try: run.add_picture(path, width=Inches(2.8))
            except: run.text = f'[{os.path.basename(path)}]'
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
# Flask routes — Auth
# ══════════════════════════════════════════════════════════════════════════════

@app.route('/')
def index():
    if 'email' not in session:
        return redirect(url_for('login'))
    user = get_user(session['email'])
    if not user:
        session.clear()
        return redirect(url_for('login'))
    return render_template('index.html',
                           user_name=user['name'],
                           user_tokens=user.get('tokens', 0),
                           midtrans_client_key=MIDTRANS_CLIENT_KEY,
                           midtrans_snap_url=MIDTRANS_SNAP_URL)

@app.route('/login', methods=['GET','POST'])
def login():
    if request.method == 'GET':
        return render_template('login.html')
    data = request.get_json() or {}
    email    = data.get('email','').strip().lower()
    password = data.get('password','')
    user = get_user(email)
    if not user or not check_password_hash(user['password'], password):
        return jsonify({'error': 'Email atau password salah'}), 401
    session['email'] = email
    return jsonify({'ok': True})

@app.route('/register', methods=['GET','POST'])
def register():
    if request.method == 'GET':
        return render_template('login.html', mode='register')
    data = request.get_json() or {}
    email    = data.get('email','').strip().lower()
    password = data.get('password','')
    name     = data.get('name','').strip()
    if not email or not password or not name:
        return jsonify({'error': 'Semua field harus diisi'}), 400
    if len(password) < 6:
        return jsonify({'error': 'Password minimal 6 karakter'}), 400
    user, err = create_user(email, password, name)
    if err:
        return jsonify({'error': err}), 400
    session['email'] = email
    return jsonify({'ok': True})

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))

@app.route('/ads.txt')
def ads_txt():
    return send_file(os.path.join(BASE_DIR, 'static', 'ads.txt'),
                     mimetype='text/plain')

# ══════════════════════════════════════════════════════════════════════════════
# Flask routes — Token & Payment
# ══════════════════════════════════════════════════════════════════════════════

@app.route('/api/create-payment', methods=['POST'])
@login_required
def create_payment():
    import base64, urllib.request
    user  = get_user(session['email'])
    order_id = f"LHP-{uuid.uuid4().hex[:12].upper()}"

    payload = json.dumps({
        "transaction_details": {
            "order_id": order_id,
            "gross_amount": TOKEN_PRICE
        },
        "item_details": [{
            "id": "TOKEN-10",
            "price": TOKEN_PRICE,
            "quantity": 1,
            "name": f"10 Token LHP Generator"
        }],
        "customer_details": {
            "email": user['email'],
            "first_name": user['name']
        }
    }).encode()

    auth = base64.b64encode(f"{MIDTRANS_SERVER_KEY}:".encode()).decode()
    req = urllib.request.Request(
        "https://app.midtrans.com/snap/v1/transactions",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Basic {auth}"
        }
    )
    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
        # Save pending order_id to user record so webhook can match it
        users = _load_users()
        if 'pending_orders' not in users[session['email']]:
            users[session['email']]['pending_orders'] = []
        users[session['email']]['pending_orders'].append(order_id)
        _save_users(users)
        return jsonify({'snap_token': result['token'], 'order_id': order_id})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/payment-webhook', methods=['POST'])
def payment_webhook():
    """Midtrans server-to-server webhook — add tokens after verified payment."""
    data = request.get_json() or {}

    # Verify signature
    order_id           = data.get('order_id','')
    status_code        = data.get('status_code','')
    gross_amount       = data.get('gross_amount','')
    server_key         = MIDTRANS_SERVER_KEY
    signature_key      = data.get('signature_key','')
    expected_sig       = hashlib.sha512(
        f"{order_id}{status_code}{gross_amount}{server_key}".encode()
    ).hexdigest()

    if not hmac.compare_digest(expected_sig, signature_key):
        return jsonify({'error': 'Invalid signature'}), 403

    transaction_status = data.get('transaction_status','')
    fraud_status       = data.get('fraud_status','')

    if transaction_status == 'capture' and fraud_status == 'accept':
        success = True
    elif transaction_status == 'settlement':
        success = True
    else:
        success = False

    if success:
        # Find which user owns this order
        users = _load_users()
        for email, user in users.items():
            if order_id in user.get('pending_orders', []):
                add_tokens(email, TOKENS_PER_BUY, reason="purchase")
                user['pending_orders'].remove(order_id)
                _save_users(users)
                break

    return jsonify({'ok': True})

@app.route('/api/token-balance', methods=['GET'])
@login_required
def token_balance():
    user = get_user(session['email'])
    return jsonify({'tokens': user.get('tokens', 0), 'name': user['name']})

# ══════════════════════════════════════════════════════════════════════════════
# Flask routes — Lookup & Generate
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
        'danton': danton,
        'danki':  danki,
        'label':  f"DANTON TAR {peleton}/{to_roman(kompi)}  |  DANKI TAR {to_roman(kompi)}"
                  if danton and danki else None,
    })

@app.route('/api/generate', methods=['POST'])
@login_required
def api_generate():
    import tempfile

    # Check token balance FIRST
    user = get_user(session['email'])
    if user.get('tokens', 0) < TOKENS_PER_DOC:
        return jsonify({'error': 'Token tidak cukup. Beli token untuk melanjutkan.',
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

    # Deduct token AFTER successful generation
    use_token(session['email'])

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
