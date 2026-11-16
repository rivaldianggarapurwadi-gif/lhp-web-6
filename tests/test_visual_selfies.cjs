// Taruna Visual from the form: face/body photos come from the saved profile (server side).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('templates/index.html', 'utf8');
const start = html.indexOf('async function generateVisualPhoto()');
const end = html.indexOf('// ── Image preview', start);
assert(start > 0 && end > start);
const code = html.slice(start, end);

async function check({hasFace = true, tingkat = '2', consent = true} = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {files: [], value: '', textContent: '', innerHTML: '', disabled: false});
    return elements.get(id);
  };
  element('f-tingkat').value = tingkat;
  element('visual-consent').checked = consent;
  element('visual-activity').value = 'imam_solat';
  element('visual-location').value = 'Akpol';
  let sent;
  let previewed;
  const context = {
    HAS_FACE: hasFace,
    document: {getElementById: element, querySelector: () => ({value: 'budi santoso'})},
    fetch: async (url, options) => {
      assert.equal(url, '/api/taruna-visual/generate');
      sent = JSON.parse(options.body);
      return {status: 200, ok: true, json: async () => ({image: {mimeType: 'image/jpeg', data: 'YQ=='}})};
    },
    atob, Uint8Array,
    File: class { constructor(parts, name, options) { this.name = name; this.type = options.type; } },
    DataTransfer: class { constructor() { this.files = []; this.items = {add: file => this.files.push(file)}; } },
    previewImage: (_, slot) => { previewed = slot; },
    confirmAiToken: async () => true,
    refreshTokens: async () => null,
    openTopup: () => {},
    window: {location: {}},
  };
  const generate = vm.runInNewContext(code + '\ngenerateVisualPhoto', context);
  await generate();
  return {sent, previewed, status: element('visual-status'), attached: element('foto-input-1').files[0]};
}

(async () => {
  const ok = await check();
  assert.equal(ok.sent.photos, undefined, 'photos come from the profile on the server');
  assert.equal(ok.sent.name, 'BUDI SANTOSO');
  assert.equal(ok.sent.activity, 'imam_solat');
  assert.equal(ok.sent.location, 'Akpol');
  assert.equal(ok.previewed, 1);
  assert.equal(ok.attached.name, 'taruna-visual-1.jpg');

  const noFace = await check({hasFace: false});
  assert.equal(noFace.sent, undefined);
  assert.match(noFace.status.innerHTML, /href="\/profil"/);

  const wrongLevel = await check({tingkat: '3'});
  assert.equal(wrongLevel.sent, undefined);
  assert.match(wrongLevel.status.textContent, /Tingkat II/);

  const noConsent = await check({consent: false});
  assert.equal(noConsent.sent, undefined);
  console.log('Visual profile-photo checks passed: payload without photos, missing face, level, consent.');
})().catch(error => { console.error(error); process.exitCode = 1; });
