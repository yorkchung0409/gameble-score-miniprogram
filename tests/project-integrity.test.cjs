const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('every configured page has a complete mini-program file set', () => {
  const appConfig = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  for (const page of appConfig.pages) {
    for (const extension of ['js', 'json', 'wxml', 'wxss']) {
      assert.equal(
        fs.existsSync(path.join(root, `${page}.${extension}`)),
        true,
        `${page}.${extension} is missing`,
      );
    }
  }
});

test('all local assets referenced by WXML exist', () => {
  const queue = [path.join(root, 'pages'), path.join(root, 'custom-tab-bar')];
  const wxmlFiles = [];
  while (queue.length) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(target);
      if (entry.isFile() && entry.name.endsWith('.wxml')) wxmlFiles.push(target);
    }
  }
  for (const filename of wxmlFiles) {
    const source = fs.readFileSync(filename, 'utf8');
    for (const match of source.matchAll(/src="\/(assets\/[^"?]+)"/g)) {
      assert.equal(fs.existsSync(path.join(root, match[1])), true, `${match[1]} is missing`);
    }
  }
});

test('all WXML event handlers exist on their page or component', () => {
  const queue = [path.join(root, 'pages'), path.join(root, 'custom-tab-bar')];
  while (queue.length) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(target);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.wxml')) continue;
      const jsFile = target.replace(/\.wxml$/, '.js');
      if (!fs.existsSync(jsFile)) continue;
      const wxml = fs.readFileSync(target, 'utf8');
      const code = fs.readFileSync(jsFile, 'utf8');
      for (const match of wxml.matchAll(/(?:bind|catch)[a-zA-Z]+="([a-zA-Z0-9_]+)"/g)) {
        const handler = match[1];
        assert.match(
          code,
          new RegExp(`^\\s*(?:async\\s+)?${handler}\\s*\\(`, 'm'),
          `${path.relative(root, target)} references missing handler ${handler}`,
        );
      }
    }
  }
});

test('upload package excludes regression-only files', () => {
  const projectConfig = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
  const ignored = new Set((projectConfig.packOptions?.ignore || []).map((item) => item.value));
  assert.equal(ignored.has('tests'), true);
  assert.equal(ignored.has('README.md'), true);
});
