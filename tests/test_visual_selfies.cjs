// Exercise the three-direction UI request and its documentation-photo attachment.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('templates/index.html', 'utf8');
const start = html.indexOf('async function generateVisualPhoto()');
const end = html.indexOf('// ── Image preview', start);
assert(start > 0 && end > start);
const code = html.slice(start, end);

async function check(mode, omit) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {files: [], value: '', textContent: '', disabled: false});
    return elements.get(id);
  };
  element('f-tingkat').value = '2';
  element('visual-consent').checked = true;
  element('visual-activity').value = 'class';
  element('visual-location').value = 'Ruang kelas';
  for (const direction of ['front', 'left', 'right']) {
    if (direction !== omit) element(`visual-face-${direction}`).files = [{type: 'image/jpeg', size: 10, tag: direction}];
  }
  let sent;
  let previewed;
  const document = {
    getElementById: element,
    querySelector: selector => selector === 'input[name="visual-mode"]:checked'
      ? {value: mode} : {value: 'BUDI'},
  };
  const context = {
    document,
    visualPhotoData: async file => ({mimeType: file.type, data: file.tag}),
    shrinkPhoto: async file => file,
    confirmAiToken: async () => true,
    refreshTokens: async () => null,
    openTopup: () => {},
    fetch: async (url, options) => {
      assert.equal(url, '/api/taruna-visual/generate');
      sent = JSON.parse(options.body);
      return {status: 200, ok: true, json: async () => ({image: {mimeType: 'image/jpeg', data: 'YQ=='}})};
    },
    atob,
    Uint8Array,
    File: class { constructor(parts, name, options) { this.name = name; this.type = options.type; } },
    DataTransfer: class { constructor() { this.files = []; this.items = {add: file => this.files.push(file)}; } },
    previewImage: (_, slot) => { previewed = slot; },
    window: {location: {}},
  };
  const generate = vm.runInNewContext(code + '\ngenerateVisualPhoto', context);
  await generate();
  return {sent, previewed, status: element('visual-status').textContent,
    attached: element('foto-input-1').files[0]};
}

(async () => {
  const three = await check('3');
  assert.deepEqual(Array.from(three.sent.photos, photo => photo.data), ['front', 'left', 'right']);
  assert.equal(three.previewed, 1);
  assert.equal(three.attached.name, 'taruna-visual-1.jpg');
  const one = await check('1');
  assert.deepEqual(Array.from(one.sent.photos, photo => photo.data), ['front']);
  const incomplete = await check('3', 'right');
  assert.equal(incomplete.sent, undefined);
  assert.match(incomplete.status, /depan, kiri, dan kanan/);
  console.log('Visual selfie checks passed: front/left/right order, single option, incomplete set, photo attachment.');
})().catch(error => { console.error(error); process.exitCode = 1; });
