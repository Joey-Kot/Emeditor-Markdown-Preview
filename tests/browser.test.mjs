import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modules = resolve(process.env.MARKDOWN_PREVIEW_NODE_MODULES || join(root, 'node_modules'));
const assetDir = resolve(process.env.MARKDOWN_PREVIEW_ASSET_DIR || join(root, 'build', 'assets'));
const chrome = process.env.MARKDOWN_PREVIEW_CHROME_PATH || process.env.CHROME_PATH;
const liveKroki = process.env.MARKDOWN_PREVIEW_LIVE_KROKI === '1';
const require = createRequire(join(modules, '_resolve_.js'));

function unpack(buffer) {
  assert.equal(buffer.subarray(0, 4).toString(), 'MPAK');
  const count = buffer.readUInt32LE(4);
  const files = new Map();
  let offset = 8;
  for (let index = 0; index < count; index++) {
    const keyLength = buffer.readUInt16LE(offset);
    const length = buffer.readUInt32LE(offset + 2);
    offset += 6;
    const name = buffer.subarray(offset, offset + keyLength).toString();
    offset += keyLength;
    files.set(name, buffer.subarray(offset, offset + length));
    offset += length;
  }
  assert.equal(offset, buffer.length);
  return files;
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

test('the embedded renderer previews and updates unsaved Markdown', { skip: !chrome && 'Set MARKDOWN_PREVIEW_CHROME_PATH to run the browser integration test', timeout: 60000 }, async (t) => {
  const files = unpack(await readFile(join(assetDir, 'assets.pack')));
  let plantumlInput = '';
  const defaultPlantumlInputs = [];
  const missing = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    // Full Chrome may request a favicon even though the embedded UI has none.
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === '/plantuml/svg' && request.method === 'POST') {
      request.setEncoding('utf8');
      request.on('data', (chunk) => { plantumlInput += chunk; });
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'image/svg+xml' });
        response.end('<svg xmlns="http://www.w3.org/2000/svg"><text>PlantUML test</text></svg>');
      });
      return;
    }
    if (url.pathname === '/local' && url.searchParams.get('path')?.endsWith('/image.png')) {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a88sAAAAASUVORK5CYII=', 'base64'));
      return;
    }
    const name = decodeURIComponent(url.pathname.slice(1) || 'index.html');
    const data = files.get(name);
    if (!data) { missing.push(name); console.error(`Missing preview asset: ${name}`); response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': types[extname(name)] || 'application/octet-stream' });
    response.end(data);
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => server.close());
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: chrome, args: ['--no-sandbox', '--disable-gpu'], ignoreDefaultArgs: ['--hide-scrollbars'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const failures = [];
  const externalRequests = [];
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();
    if (url === 'https://kroki.io/plantuml/svg') {
      defaultPlantumlInputs.push({ method: request.method(), body: request.postData() });
      if (request.postData()?.includes('Simulate network failure')) {
        void request.abort('failed');
      } else if (liveKroki) {
        void request.continue();
      } else {
        void request.respond({
          status: 200,
          contentType: 'image/svg+xml',
          headers: { 'access-control-allow-origin': '*' },
          body: '<svg xmlns="http://www.w3.org/2000/svg"><text>Default PlantUML test</text></svg>',
        });
      }
    } else if (/^https?:/.test(url) && new URL(url).origin !== `http://127.0.0.1:${server.address().port}`) {
      externalRequests.push(url);
      void request.abort('blockedbyclient');
    } else {
      void request.continue();
    }
  });
  page.on('pageerror', (error) => { failures.push(error.message); console.error('page error:', error.message); });
  page.on('console', (entry) => { if (entry.type() === 'error') console.error('browser:', entry.text()); });
  await page.evaluateOnNewDocument(() => {
    let receiver;
    window.nativeMessages = [];
    window.chrome = window.chrome || {};
    window.chrome.webview = {
      addEventListener(type, callback) { if (type === 'message') receiver = callback; },
      postMessage(value) {
        window.nativeMessages.push(value);
        if (value.startsWith('fs\t')) {
          const [, id, op, encoded] = value.split('\t');
          const path = decodeURIComponent(encoded);
          const included = path.endsWith('/included.md');
          const slow = path.endsWith('/slow.md');
          const configDir = path.endsWith('/settings/.crossnote');
          const configFile = path.endsWith('/settings/.crossnote/config.js');
          const result = op === 'exists' ? (included || slow || configDir || configFile ? '1' : '0') :
            op === 'stat' && (included || slow) ? 'file\t16\t0' :
            op === 'read' && included ? (window.reviewIncludedText ?? 'Imported content\n\n- [ ] Imported task') :
            op === 'read' && slow ? 'Slow import' :
            op === 'read' && configFile ? (window.reviewConfigText ?? `({ plantumlServer: "${window.location.origin}/plantuml/svg" })`) : '';
          const status = op === 'read' && !included && !slow && !configFile ? 'error' : 'ok';
          if (op === 'read' && slow && !window.slowReleased) {
            window.releaseSlow = () => { window.slowReleased = true; receiver({ data: `fs\t${id}\tok\n${result}` }); };
            return;
          }
          queueMicrotask(() => receiver({ data: `fs\t${id}\t${status}\n${result}` }));
        }
      },
    };
    window.sendFromEditor = (value) => receiver({ data: value });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.nativeMessages?.includes('ready'), { timeout: 15000 });
  await page.evaluate(() => window.sendFromEditor('document\t99\t1\tC%3A%5Cdocs%5Cquoted.md\n> - [ ] Quoted task'));
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview[data-for="preview"] .task-list-item-checkbox'), { timeout: 10000 });
  await page.evaluate(() => document.querySelector('iframe').contentDocument.querySelector('.markdown-preview[data-for="preview"] .task-list-item-checkbox').click());
  await page.waitForFunction(() => window.nativeMessages.includes('task\t0\t99\t1'), { timeout: 3000 });
  await page.evaluate(() => { window.nativeMessages = []; });
  await page.evaluate(() => {
    window.reviewIncludedText = 'Original imported text';
    const markdown = '# Refresh resources\n\n@import "included.md"\n\n```puml\nAlice -> Bob: Reload config\n```';
    window.sendFromEditor(`document\t98\t1\tC%3A%5Csettings%5Cnote.md\n${markdown}`);
  });
  await page.waitForFunction(() => {
    const content = document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview[data-for="preview"]');
    return content?.textContent.includes('Original imported text') && content.textContent.includes('PlantUML test');
  }, { timeout: 15000 });
  await page.evaluate(() => {
    window.reviewIncludedText = 'Updated imported text';
    window.reviewConfigText = '({ plantumlServer: "https://kroki.io/plantuml/svg" })';
  });
  await page.click('#refresh');
  await page.waitForFunction(() => {
    const content = document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview[data-for="preview"]');
    return content?.textContent.includes('Updated imported text') && content.textContent.includes('Default PlantUML test');
  }, { timeout: 15000 });
  assert.equal(defaultPlantumlInputs.length, 1);
  await page.evaluate(() => {
    window.slowReleased = false;
    window.releaseSlow = null;
    window.sendFromEditor('document\t98\t2\tC%3A%5Csettings%5Cnote.md\n# Pending import\n\n@import "slow.md"');
  });
  await page.waitForFunction(() => typeof window.releaseSlow === 'function', { timeout: 10000 });
  await page.click('#refresh');
  await page.evaluate(() => {
    window.reviewIncludedText = 'Latest imported text';
    window.sendFromEditor('document\t98\t3\tC%3A%5Csettings%5Cnote.md\n# Superseding edit\n\n@import "included.md"');
    window.releaseSlow();
  });
  await page.waitForFunction(() => {
    const content = document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview[data-for="preview"]');
    return content?.textContent.includes('Superseding edit') && content.textContent.includes('Latest imported text');
  }, { timeout: 10000 });
  defaultPlantumlInputs.length = 0;
  plantumlInput = '';
  await page.evaluate(() => { delete window.reviewIncludedText; delete window.reviewConfigText; window.nativeMessages = []; });
  await page.evaluate(() => window.sendFromEditor('document\t1\t10\tC%3A%5Cdocs%5Cnote.md\n# First\n\n**bold**\n\n$e=mc^2$\n\n- [ ] Task\n\n![image](image.png)\n\n[Space](nested/file%20name.md)\n\n[Hash](nested/file%23name.md)\n\n[Percent](nested/100%25.md)\n\n[Unicode](嵌套/文件%20一.md)\n\n[External](https://example.com/?q=a%26b%3Dc)\n\n[Anchor](#first)\n\n@import "included.md"\n\nInline `example`\n\n```js\nconst answer = 42;\n```\n\n```mermaid\ngraph TD; A-->B\n```'));
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview h1')?.textContent?.includes('First'), { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview .mermaid svg'), { timeout: 20000 });
  assert.equal(await page.evaluate(() => !!document.querySelector('iframe').contentDocument.querySelector('.markdown-preview .katex')), true);
  await page.waitForFunction(() => Array.from(document.querySelector('iframe')?.contentDocument?.querySelectorAll('.markdown-preview') || []).some(element => element.textContent.includes('Imported content')), { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview img')?.naturalWidth > 0, { timeout: 20000 });
  const textFonts = ['Samsung Sans', 'Rubik', 'Noto Sans', 'Noto Sans SC'];
  const codeFonts = ['Ubuntu Sans Mono', 'Noto Sans Mono', 'Cascadia Mono'];
  const fontFamilies = () => page.evaluate(() => {
    const doc = document.querySelector('iframe').contentDocument;
    const root = doc.querySelector('.markdown-preview[data-for="preview"]');
    const read = (element) => doc.defaultView.getComputedStyle(element).fontFamily.split(',').map((name) => name.trim().replace(/^['"]|['"]$/g, ''));
    return { text: read(root.querySelector('h1')), inline: read(root.querySelector('p code')), block: read(root.querySelector('pre code')), pre: read(root.querySelector('pre')) };
  });
  const defaultTextFallback = ['Helvetica Neue', 'Helvetica', 'Segoe UI', 'Arial', 'freesans', 'sans-serif'];
  const defaultCodeFallback = ['Menlo', 'Monaco', 'Consolas', 'Courier New', 'monospace'];
  let families = await fontFamilies();
  assert.deepEqual(families.text, [...textFonts, ...defaultTextFallback]);
  assert.deepEqual(families.inline, [...codeFonts, ...defaultCodeFallback]);
  assert.deepEqual(families.block, [...codeFonts, ...defaultCodeFallback]);
  assert.deepEqual(families.pre, [...codeFonts, 'Consolas', 'Liberation Mono', 'Menlo', 'Courier', 'monospace']);
  assert.equal(await page.$('#about'), null);
  assert.equal(await page.$('#licenses'), null);
  let previewFrame = await (await page.$('#preview')).contentFrame();
  await previewFrame.waitForFunction(() => Math.abs(parseFloat(document.body.style.zoom) - 0.9) < 0.001, { timeout: 3000 });
  const menuSummary = () => previewFrame.evaluate(() => {
    const menu = document.querySelector('.contexify:not(.contexify_submenu)');
    return {
      entries: [...menu.children].filter((element) => element.classList.contains('contexify_item'))
        .map((element) => element.querySelector(':scope > .contexify_itemContent')?.textContent.trim()),
      width: menu.getBoundingClientRect().width,
      fontSize: parseFloat(getComputedStyle(menu).fontSize),
      footer: [...document.querySelectorAll('.footer [title]')].map((element) => element.title),
    };
  });
  await previewFrame.click('.markdown-preview h1', { button: 'right' });
  await previewFrame.waitForSelector('.contexify:not(.contexify_submenu)', { visible: true });
  await previewFrame.waitForFunction(() => Math.abs(document.querySelector('.contexify:not(.contexify_submenu)').getBoundingClientRect().width - 220 * 2 / 3) < 2, { timeout: 3000 });
  let menu = await menuSummary();
  assert.deepEqual(menu.entries, ['Zoom (100%)', 'Preview Theme', 'Code Block Theme', 'Reveal.js Theme']);
  assert.deepEqual(menu.footer, ['Zoom out', 'Zoom in', 'Open menu']);
  assert.ok(Math.abs(menu.width - 220 * 2 / 3) < 2 && Math.abs(menu.fontSize - 16 * 2 / 3) < 0.1, JSON.stringify(menu));
  await page.keyboard.press('Escape');
  await previewFrame.waitForSelector('.contexify:not(.contexify_submenu)', { hidden: true });
  await previewFrame.click('.footer [title="Zoom in"]');
  await previewFrame.waitForFunction(() => Math.abs(parseFloat(document.body.style.zoom) - 0.99) < 0.001, { timeout: 3000 });
  await previewFrame.click('.footer [title="Open menu"]');
  await previewFrame.waitForSelector('.contexify:not(.contexify_submenu)', { visible: true });
  assert.equal((await menuSummary()).entries[0], 'Zoom (110%)');
  await page.keyboard.press('Escape');
  await previewFrame.waitForSelector('.contexify:not(.contexify_submenu)', { hidden: true });
  await previewFrame.click('.footer [title="Zoom out"]');
  await previewFrame.waitForFunction(() => Math.abs(parseFloat(document.body.style.zoom) - 0.9) < 0.001, { timeout: 3000 });
  await previewFrame.click('.footer [title="Zoom out"]');
  await previewFrame.waitForFunction(() => Math.abs(parseFloat(document.body.style.zoom) - 0.81) < 0.001, { timeout: 3000 });
  await previewFrame.click('.footer [title="Open menu"]');
  await previewFrame.waitForSelector('.contexify:not(.contexify_submenu)', { visible: true });
  assert.equal((await menuSummary()).entries[0], 'Zoom (90%)');
  const zoomMenu = (await previewFrame.$$('.contexify:not(.contexify_submenu) > .contexify_item'))[0];
  await zoomMenu.hover();
  const resetZoom = await zoomMenu.evaluateHandle((element) => [...element.querySelectorAll(':scope > .contexify_submenu > .contexify_item')]
    .find((item) => item.textContent.trim() === 'Reset Zoom'));
  await resetZoom.asElement().click();
  await previewFrame.waitForFunction(() => Math.abs(parseFloat(document.body.style.zoom) - 0.9) < 0.001, { timeout: 3000 });
  await previewFrame.waitForSelector('.contexify:not(.contexify_submenu)', { hidden: true });
  // The same controls must also be removed when the menu includes Copy.
  await previewFrame.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('.markdown-preview h1'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await previewFrame.click('.markdown-preview h1', { button: 'right' });
  await previewFrame.waitForSelector('.contexify:not(.contexify_submenu)', { visible: true });
  assert.deepEqual((await menuSummary()).entries, ['Copy', 'Zoom (100%)', 'Preview Theme', 'Code Block Theme', 'Reveal.js Theme']);
  await page.keyboard.press('Escape');
  await previewFrame.waitForSelector('.contexify:not(.contexify_submenu)', { hidden: true });
  await previewFrame.evaluate(() => window.getSelection().removeAllRanges());
  // Recreate the frame in Chinese and exercise the bottom menu and a nested
  // theme selection using the actual pointer, as in the EmEditor preview.
  const oldFrameId = await previewFrame.evaluate(() => document.documentElement.dataset.markdownPreviewFrame);
  await page.evaluate(() => Object.defineProperty(navigator, 'language', { value: 'zh-CN', configurable: true }));
  await page.click('#refresh');
  await page.waitForFunction((id) => {
    const doc = document.querySelector('iframe')?.contentDocument;
    return doc?.documentElement.dataset.markdownPreviewFrame !== id && doc?.querySelector('.markdown-preview h1')?.textContent?.includes('First');
  }, { timeout: 10000 }, oldFrameId);
  previewFrame = await (await page.$('#preview')).contentFrame();
  const chineseFrameId = await previewFrame.evaluate(() => document.documentElement.dataset.markdownPreviewFrame);
  await previewFrame.waitForFunction(() => Math.abs(parseFloat(document.body.style.zoom) - 0.9) < 0.001, { timeout: 3000 });
  await previewFrame.hover('.markdown-preview[data-for="preview"] h1');
  await previewFrame.click('.footer [title="打开菜单"]');
  await previewFrame.waitForSelector('.contexify:not(.contexify_submenu)', { visible: true });
  menu = await menuSummary();
  assert.deepEqual(menu.entries, ['缩放 (100%)', '预览主题', '代码块主题', 'Reveal.js 主题']);
  assert.deepEqual(menu.footer, ['缩小', '放大', '打开菜单']);
  const themeMenu = (await previewFrame.$$('.contexify:not(.contexify_submenu) > .contexify_item'))[1];
  await themeMenu.hover();
  const lightMenu = await themeMenu.$(':scope > .contexify_submenu > .contexify_item');
  await lightMenu.hover();
  const githubTheme = await lightMenu.evaluateHandle((element) => [...element.querySelectorAll(':scope > .contexify_submenu > .contexify_item')]
    .find((item) => item.textContent.trim() === 'github-light.css'));
  await githubTheme.asElement().click();
  await page.waitForFunction(() => localStorage.getItem('markdownPreview.previewTheme') === 'github-light.css', { timeout: 10000 });
  await page.waitForFunction((id) => {
    const doc = document.querySelector('iframe')?.contentDocument;
    return doc?.documentElement.dataset.markdownPreviewFrame !== id && doc?.querySelector('.markdown-preview h1')?.textContent?.includes('First');
  }, { timeout: 10000 }, chineseFrameId);
  // Imported tasks have no source line in the active document and must not
  // send an edit request for an unrelated line in that document.
  await page.evaluate(() => document.querySelector('iframe').contentDocument.querySelectorAll('.markdown-preview[data-for="preview"] .task-list-item-checkbox')[1].click());
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
  assert.equal(await page.evaluate(() => window.nativeMessages.some((entry) => entry.startsWith('task\t'))), false);
  for (const [label, expected] of [
    ['Space', '/__drive__/C/docs/nested/file name.md'],
    ['Hash', '/__drive__/C/docs/nested/file#name.md'],
    ['Percent', '/__drive__/C/docs/nested/100%.md'],
    ['Unicode', '/__drive__/C/docs/嵌套/文件 一.md'],
  ]) {
    await page.evaluate((label) => [...document.querySelector('iframe').contentDocument.querySelectorAll('a')].find((a) => a.textContent === label).click(), label);
    try {
      await page.waitForFunction((expected) => window.nativeMessages.some((entry) => entry.startsWith('openfile\t') && decodeURIComponent(entry.slice(9)) === expected), { timeout: 3000 }, expected);
    } catch (error) {
      console.error('link failure:', label, await page.evaluate(() => ({ links: [...document.querySelector('iframe').contentDocument.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]), messages: window.nativeMessages.filter((entry) => entry.startsWith('open')) })));
      throw error;
    }
  }
  await page.evaluate(() => [...document.querySelector('iframe').contentDocument.querySelectorAll('a')].find((a) => a.textContent === 'External').click());
  await page.waitForFunction(() => window.nativeMessages.some((entry) => entry.startsWith('open\t') && decodeURIComponent(entry.slice(5)) === 'https://example.com/?q=a%26b%3Dc'), { timeout: 3000 });
  const openedBeforeAnchor = await page.evaluate(() => window.nativeMessages.filter((entry) => entry.startsWith('open')).length);
  await page.evaluate(() => [...document.querySelector('iframe').contentDocument.querySelectorAll('a')].find((a) => a.textContent === 'Anchor').click());
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
  assert.equal(await page.evaluate(() => window.nativeMessages.filter((entry) => entry.startsWith('open')).length), openedBeforeAnchor);
  await page.evaluate(() => document.querySelector('iframe').contentDocument.querySelector('.task-list-item-checkbox').click());
  await page.waitForFunction(() => window.nativeMessages.some((entry) => entry.startsWith('task\t') && entry.endsWith('\t1\t10')), { timeout: 10000 });
  await page.click('#export-html');
  await page.waitForFunction(() => window.nativeMessages.some((entry) => entry.startsWith('savehtml\n')), { timeout: 20000 });
  assert.equal(await page.evaluate(() => {
    const html = window.nativeMessages.find((entry) => entry.startsWith('savehtml\n'));
    return html.includes('data:image/png;base64,') && html.includes('<svg') && html.includes('Imported content');
  }), true);
  const exportedLinks = await page.evaluate(() => {
    const html = window.nativeMessages.find((entry) => entry.startsWith('savehtml\n')).slice(9);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return [...doc.querySelectorAll('a')].filter((a) => ['Hash', 'Percent', 'Anchor'].includes(a.textContent)).map((a) => a.getAttribute('href'));
  });
  assert.deepEqual(exportedLinks, ['file:///C:/docs/nested/file%23name.md', 'file:///C:/docs/nested/100%25.md', '#first']);
  await page.click('#export-png');
  await page.waitForFunction(() => window.nativeMessages.some((entry) => entry.startsWith('saveimage\tpng\niVBORw0KGgo')), { timeout: 20000 });
  await page.click('#export-jpeg');
  await page.waitForFunction(() => window.nativeMessages.some((entry) => entry.startsWith('saveimage\tjpeg\n/9j/')), { timeout: 20000 });
  const jpegBackground = await page.evaluate(async () => {
    const encoded = window.nativeMessages.find((entry) => entry.startsWith('saveimage\tjpeg\n')).split('\n')[1];
    const image = new Image();
    image.src = `data:image/jpeg;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return [...context.getImageData(0, 0, 1, 1).data];
  });
  assert.ok(jpegBackground.slice(0, 3).every((channel) => channel > 220), `Unexpected JPEG background: ${jpegBackground}`);
  assert.match(files.get('notices.txt').toString(), /Yiyi Wang/);
  await page.click('#export-pdf');
  await page.waitForFunction(() => window.nativeMessages.includes('exportpdf'), { timeout: 10000 });
  await page.evaluate(() => window.sendFromEditor('printdone'));
  await page.evaluate(() => {
    document.querySelector('iframe').contentWindow.tikzjaxRender = () => { window.tikzStarted = true; };
    window.sendFromEditor('document\t1\t11\tC%3A%5Cdocs%5Cnote.md\n# Slow render\n\n<script type="text/tikz">test</script>');
  });
  await page.waitForFunction(() => window.tikzStarted === true, { timeout: 10000 });
  await page.evaluate(() => window.sendFromEditor('document\t1\t12\tC%3A%5Cdocs%5Cnote.md\n# Latest asynchronous render'));
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview h1')?.textContent?.includes('Latest asynchronous render'), { timeout: 10000 });
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
  assert.equal(await page.evaluate(() => document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview h1')?.textContent?.includes('Latest asynchronous render')), true);
  await page.evaluate(() => {
    window.slowReleased = false;
    window.releaseSlow = null;
    window.sendFromEditor('document\t1\t13\tC%3A%5Cdocs%5Cnote.md\n# Outdated content\n\n@import "slow.md"');
  });
  await page.waitForFunction(() => typeof window.releaseSlow === 'function', { timeout: 10000 });
  await page.evaluate(() => {
    window.sendFromEditor('error\nThe document is too large');
    window.releaseSlow();
  });
  await page.click('#refresh');
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
  assert.equal(await page.evaluate(() => document.querySelector('#message').textContent.includes('The document is too large') && getComputedStyle(document.querySelector('iframe')).display === 'none'), true);
  await page.evaluate(() => window.sendFromEditor('document\t1\t14\tC%3A%5Cdocs%5Cnote.md\n# Recovered document'));
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview h1')?.textContent?.includes('Recovered document'), { timeout: 10000 });
  await page.evaluate(() => { window.slowReleased = false; window.releaseSlow = null; });
  await page.evaluate(() => window.sendFromEditor('document\t1\t11\tC%3A%5Cdocs%5Cnote.md\n# Pending update\n\n@import "slow.md"'));
  await page.waitForFunction(() => typeof window.releaseSlow === 'function', { timeout: 10000 });
  await page.click('#refresh');
  await page.evaluate(() => window.releaseSlow());
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview h1')?.textContent?.includes('Pending update'), { timeout: 10000 });
  await page.evaluate(() => {
    window.previousFrameId = Number(document.querySelector('iframe').contentDocument.documentElement.dataset.markdownPreviewFrame);
    window.slowReleased = false;
    window.releaseSlow = null;
    window.sendFromEditor('document\t99\t12\tC%3A%5Cdocs%5Cother.md\n# New tab\n\n@import "slow.md"');
  });
  await page.waitForFunction(() => typeof window.releaseSlow === 'function' && getComputedStyle(document.querySelector('iframe')).display === 'none', { timeout: 10000 });
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent('message', {
      source: document.querySelector('iframe').contentWindow,
      data: { markdownPreview: 1, frameId: window.previousFrameId, message: { command: 'webviewFinishLoading' } },
    }));
  });
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('iframe')).display), 'none');
  await page.evaluate(() => window.releaseSlow());
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview h1')?.textContent?.includes('New tab'), { timeout: 10000 });
  await page.evaluate(() => {
    window.nativeMessages = window.nativeMessages.filter((entry) => entry !== 'exportpdf');
    const text = '# Long document\n\n' + Array.from({ length: 200 }, (_, i) => `Paragraph ${i + 1} with content.\n\n`).join('');
    window.sendFromEditor(`document\t99\t13\tC%3A%5Cdocs%5Cother.md\n${text}`);
  });
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview[data-for="preview"]')?.textContent?.includes('Paragraph 200'), { timeout: 10000 });
  await new Promise((resolve) => setTimeout(resolve, 600));
  const toolbarLayout = await page.evaluate(() => {
    const bar = document.querySelector('#toolbar');
    const rect = bar.getBoundingClientRect();
    const frame = document.querySelector('iframe');
    const heading = frame.contentDocument.querySelector('.markdown-preview h1').getBoundingClientRect();
    return { visible: !bar.classList.contains('is-collapsed'), hidden: bar.getAttribute('aria-hidden'), width: rect.width,
      center: rect.x + rect.width / 2, height: rect.height, backdrop: getComputedStyle(bar).backdropFilter,
      headingTop: frame.getBoundingClientRect().top + heading.top, bottom: rect.bottom };
  });
  assert.equal(toolbarLayout.visible, true);
  assert.equal(toolbarLayout.hidden, 'false');
  assert.equal(await page.$eval('body', (body) => body.dataset.previewTone), 'light');
  assert.ok(Math.abs(toolbarLayout.center - 400) < 1 && Math.abs(toolbarLayout.width - 332) < 1 && toolbarLayout.height === 40, JSON.stringify(toolbarLayout));
  assert.ok(toolbarLayout.backdrop.includes('blur(') && toolbarLayout.headingTop >= toolbarLayout.bottom, JSON.stringify(toolbarLayout));
  await page.evaluate(() => {
    window.nativeMessages = window.nativeMessages.filter((entry) => !entry.startsWith('reveal\t'));
    document.querySelector('iframe').contentWindow.scrollTo(0, 1000);
  });
  await page.waitForFunction(() => window.nativeMessages.some((entry) => entry.startsWith('reveal\t')), { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('#toolbar').classList.contains('is-collapsed'), { timeout: 3000 });
  assert.equal(await page.$eval('#toolbar', (bar) => bar.inert && bar.getAttribute('aria-hidden') === 'true'), true);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(await page.$eval('#toolbar', (bar) => getComputedStyle(bar).visibility), 'hidden');
  await page.evaluate(() => document.querySelector('iframe').contentWindow.scrollBy(0, -16));
  await page.waitForFunction(() => document.querySelector('iframe').contentWindow.scrollY <= 984, { timeout: 3000 });
  assert.equal(await page.$eval('#toolbar', (bar) => bar.classList.contains('is-collapsed')), true);
  await page.evaluate(() => document.querySelector('iframe').contentWindow.scrollBy(0, -25));
  await page.waitForFunction(() => !document.querySelector('#toolbar').classList.contains('is-collapsed'), { timeout: 3000 });
  assert.equal(await page.$eval('#toolbar', (bar) => !bar.inert && bar.getAttribute('aria-hidden') === 'false'), true);
  await page.focus('#export-html');
  await page.evaluate(() => document.querySelector('iframe').contentWindow.scrollBy(0, 120));
  await page.waitForFunction(() => document.querySelector('#toolbar').classList.contains('is-collapsed'), { timeout: 3000 });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'preview');
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => !document.querySelector('#toolbar').classList.contains('is-collapsed'), { timeout: 3000 });
  await page.evaluate(() => window.sendFromEditor('scroll\t200'));
  await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.scrollY > 2000, { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('#toolbar').classList.contains('is-collapsed'), { timeout: 3000 });
  await page.evaluate(() => window.sendFromEditor('scroll\t0'));
  await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.scrollY < 2, { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('#toolbar').classList.contains('is-collapsed'), { timeout: 3000 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#toolbar')).opacity === '1', { timeout: 3000 });
  // Scrolling while the pointer is on the floating bar must still reach the preview.
  const barRect = await page.$eval('#toolbar', (bar) => { const rect = bar.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; });
  await page.mouse.move(barRect.x, barRect.y);
  await page.mouse.wheel({ deltaY: 160 });
  await page.waitForFunction(() => document.querySelector('iframe').contentWindow.scrollY >= 100 && document.querySelector('#toolbar').classList.contains('is-collapsed'), { timeout: 3000 });
  await page.evaluate(() => document.querySelector('iframe').contentWindow.scrollTo(0, 0));
  await page.waitForFunction(() => document.querySelector('iframe').contentWindow.scrollY < 2 && !document.querySelector('#toolbar').classList.contains('is-collapsed'), { timeout: 3000 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#toolbar')).opacity === '1', { timeout: 3000 });
  await page.click('#export-pdf');
  await page.evaluate(() => document.querySelector('#export-pdf').click());
  await page.waitForFunction(() => window.nativeMessages.includes('exportpdf'), { timeout: 10000 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await page.evaluate(() => window.nativeMessages.filter((entry) => entry === 'exportpdf').length), 1);
  const pdf = Buffer.from(await page.pdf({ format: 'A4', printBackground: true }));
  const pageCount = (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
  assert.ok(pageCount > 1, `Expected a multipage PDF; received ${pageCount} page(s)`);
  await page.evaluate(() => window.sendFromEditor('printdone'));
  await page.click('#export-pdf');
  await page.waitForFunction(() => window.nativeMessages.filter((entry) => entry === 'exportpdf').length === 2, { timeout: 3000 });
  await page.evaluate(() => window.sendFromEditor('printdone'));
  await page.evaluate(() => {
    window.sendFromEditor('document\t1\t11\tC%3A%5Cdocs%5Cnote.md\n# Old update');
    window.sendFromEditor('document\t1\t12\tC%3A%5Cdocs%5Cnote.md\n# Latest update');
  });
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview h1')?.textContent?.includes('Latest update'), { timeout: 20000 });
  await page.evaluate(() => window.sendFromEditor('document\t2\t13\t\n# Untitled document'));
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview h1')?.textContent?.includes('Untitled document'), { timeout: 20000 });
  await page.evaluate(() => window.sendFromEditor('document\t3\t14\tC%3A%5Cdocs%5Cdiagrams.md\n# Diagrams\n\n```dot\ndigraph G { Alpha -> Beta }\n```\n\n```wavedrom\n{ signal: [{ name: "clock", wave: "p..." }] }\n```'));
  try {
    await page.waitForFunction(() => {
      const content = document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview[data-for="preview"]');
      return content?.querySelector('h1')?.textContent?.includes('Diagrams') && content.querySelectorAll('svg').length >= 2;
    }, { timeout: 10000 });
  } catch (error) {
    console.error('diagram preview:', await page.evaluate(() => ({ message: document.querySelector('#message')?.textContent, previews: [...document.querySelector('iframe')?.contentDocument?.querySelectorAll('.markdown-preview') || []].map(element => element.outerHTML.slice(0, 3000)) })));
    throw error;
  }
  assert.equal(await page.evaluate(() => {
    const text = document.querySelector('iframe').contentDocument.querySelector('.markdown-preview[data-for="preview"]').textContent;
    return text.includes('Alpha') && text.includes('Beta') && text.includes('clock');
  }), true);
  await page.evaluate(() => window.sendFromEditor('document\t4\t15\tC%3A%5Cdocs%5Cdiagrams.md\n# Vega\n\n```vega-lite\n{"$schema":"https://vega.github.io/schema/vega-lite/v5.json","data":{"values":[{"x":"A","y":3},{"x":"B","y":5}]},"mark":"bar","encoding":{"x":{"field":"x","type":"nominal"},"y":{"field":"y","type":"quantitative"}}}\n```'));
  await page.waitForFunction(() => {
    const content = document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview[data-for="preview"]');
    return content?.querySelector('h1')?.textContent?.includes('Vega') && !!content.querySelector('svg');
  }, { timeout: 10000 });
  const umlDiagrams = [
    '```puml\n@startuml\n用户 -> 服务: 请求\n@enduml\n```',
    '```plantuml\nclass Animal\nclass Cat\nAnimal <|-- Cat\n```',
    '```puml\nstart\n:Process;\nstop\n```',
  ].join('\n\n');
  await page.evaluate((uml) => window.sendFromEditor(`document\t7\t16\tC%3A%5Cdocs%5Cplantuml.md\n# Default PlantUML\n\n${uml}`), umlDiagrams);
  await page.waitForFunction(() => {
    const content = document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview[data-for="preview"]');
    return content?.querySelector('h1')?.textContent?.includes('Default PlantUML') && content.querySelectorAll('svg').length === 3;
  }, { timeout: 15000 });
  assert.equal(await page.$eval('#online', (button) => button.getAttribute('aria-pressed')), 'false');
  assert.equal(defaultPlantumlInputs.length, 3);
  assert.ok(defaultPlantumlInputs.every(({ method, body }) => method === 'POST' && body.includes('@startuml') && body.includes('@enduml')));
  assert.ok(defaultPlantumlInputs.some(({ body }) => body.includes('用户 -> 服务: 请求')));
  await page.evaluate((uml) => window.sendFromEditor(`document\t7\t17\tC%3A%5Cdocs%5Cplantuml.md\n# Updated PlantUML\n\n${uml}`), umlDiagrams);
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview h1')?.textContent?.includes('Updated PlantUML'), { timeout: 10000 });
  assert.equal(defaultPlantumlInputs.length, 3, 'unchanged diagrams should use the renderer cache');
  await page.evaluate(() => window.sendFromEditor('document\t7\t18\tC%3A%5Cdocs%5Cplantuml.md\n# Failed PlantUML\n\n```puml\nAlice -> Bob: Simulate network failure\n```'));
  await page.waitForFunction(() => {
    const content = document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview[data-for="preview"]');
    return content?.querySelector('h1')?.textContent?.includes('Failed PlantUML') && content.textContent.includes('Failed to fetch');
  }, { timeout: 15000 });
  await page.evaluate(() => window.sendFromEditor('document\t7\t19\tC%3A%5Cdocs%5Cplantuml.md\n# Recovered PlantUML\n\n```puml\nAlice -> Bob: Recovered\n```'));
  await page.waitForFunction(() => {
    const content = document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview[data-for="preview"]');
    return content?.querySelector('h1')?.textContent?.includes('Recovered PlantUML') && !!content.querySelector('svg');
  }, { timeout: 15000 });
  await page.evaluate(() => window.sendFromEditor('document\t5\t16\tC%3A%5Csettings%5Cnote.md\n# PlantUML\n\n```puml\nAlice -> Bob: Hello\n```'));
  await page.waitForFunction(() => {
    const content = document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview[data-for="preview"]');
    return content?.querySelector('h1')?.textContent?.trim() === 'PlantUML' && content.textContent.includes('PlantUML test');
  }, { timeout: 15000 });
  assert.match(plantumlInput, /Alice -> Bob: Hello/);
  await page.evaluate(() => window.sendFromEditor('document\t5\t17\tC%3A%5Csettings%5Cnote.md\n<!-- slide -->\n\n# First slide\n\n<!-- slide -->\n\n# Second slide'));
  try {
    await page.waitForFunction(() => {
      const doc = document.querySelector('iframe')?.contentDocument;
      return getComputedStyle(document.querySelector('iframe')).display !== 'none' && doc?.body?.hasAttribute('data-presentation-mode') && doc.querySelectorAll('.reveal .slides section').length >= 2;
    }, { timeout: 6000 });
  } catch (error) {
    console.error('presentation:', await page.evaluate(() => ({ message: document.querySelector('#message')?.textContent, html: document.querySelector('iframe')?.contentDocument?.body?.outerHTML?.slice(0, 3000) })));
    throw error;
  }
  await page.evaluate(() => window.sendFromEditor('document\t5\t18\tC%3A%5Csettings%5Cnote.md\n<!-- slide -->\n\n# Updated slide'));
  await page.waitForFunction(() => {
    const frame = document.querySelector('iframe');
    return getComputedStyle(frame).display !== 'none' && frame.contentDocument?.querySelector('.reveal .slides')?.textContent?.includes('Updated slide');
  }, { timeout: 15000 });
  await page.click('#export-html');
  await page.waitForFunction(() => window.nativeMessages.filter((entry) => entry.startsWith('savehtml\n')).length === 2, { timeout: 20000 });
  assert.equal(await page.evaluate(() => window.nativeMessages.filter((entry) => entry.startsWith('savehtml\n'))[1].includes('data:font/woff;base64,')), true);
  await page.evaluate(() => window.sendFromEditor('document\t5\t19\tC%3A%5Csettings%5Cnote.md\n# Back to Markdown'));
  await page.waitForFunction(() => {
    const doc = document.querySelector('iframe')?.contentDocument;
    return getComputedStyle(document.querySelector('iframe')).display !== 'none' && doc?.body && !doc.body.hasAttribute('data-presentation-mode') && doc.querySelector('.markdown-preview h1')?.textContent?.includes('Back to Markdown');
  }, { timeout: 15000 });
  await page.evaluate(() => {
    const path = String.raw`\\server\share\docs\note.md`;
    window.sendFromEditor(`document\t6\t20\t${encodeURIComponent(path)}\n# UNC\n\n[Share](nested/file%23one.md)`);
  });
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('.markdown-preview h1')?.textContent?.includes('UNC'), { timeout: 10000 });
  await page.evaluate(() => [...document.querySelector('iframe').contentDocument.querySelectorAll('a')].find((a) => a.textContent === 'Share').click());
  await page.waitForFunction(() => window.nativeMessages.some((entry) => entry.startsWith('openfile\t') && decodeURIComponent(entry.slice(9)) === '/__unc__/server/share/docs/nested/file#one.md'), { timeout: 3000 });
  await page.click('#export-html');
  await page.waitForFunction(() => window.nativeMessages.filter((entry) => entry.startsWith('savehtml\n')).length === 3, { timeout: 20000 });
  assert.equal(await page.evaluate(() => {
    const html = window.nativeMessages.filter((entry) => entry.startsWith('savehtml\n'))[2].slice(9);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return [...doc.querySelectorAll('a')].find((a) => a.textContent === 'Share')?.getAttribute('href');
  }), 'file://server/share/docs/nested/file%23one.md');
  await page.evaluate(() => {
    const header = `| ${Array.from({ length: 18 }, (_, i) => `Column ${i + 1}`).join(' | ')} |`;
    const separator = `| ${Array(18).fill('---').join(' | ')} |`;
    const row = `| ${Array(18).fill('wide content').join(' | ')} |`;
    const paragraphs = Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}`).join('\n\n');
    const text = `# Scrollbars\n\n${header}\n${separator}\n${row}\n\n\`\`\`\n${'long-code-'.repeat(150)}\n\`\`\`\n\n${paragraphs}`;
    window.sendFromEditor(`document\t8\t21\tC%3A%5Cdocs%5Cscrollbars.md\n${text}`);
  });
  await page.waitForFunction(() => {
    const doc = document.querySelector('iframe')?.contentDocument;
    const table = doc?.querySelector('.markdown-preview[data-for="preview"] table');
    return table && table.scrollWidth > table.clientWidth && doc.documentElement.dataset.previewScrollbarTheme === 'light';
  }, { timeout: 10000 });
  const scrollbarInfo = () => page.evaluate(() => {
    const frame = document.querySelector('iframe');
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    const table = doc.querySelector('.markdown-preview[data-for="preview"] table');
    const code = doc.querySelector('.markdown-preview[data-for="preview"] pre');
    const info = (element) => ({
      width: win.getComputedStyle(element, '::-webkit-scrollbar').width,
      height: win.getComputedStyle(element, '::-webkit-scrollbar').height,
      track: win.getComputedStyle(element, '::-webkit-scrollbar-track').backgroundColor,
      thumb: win.getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor,
      radius: win.getComputedStyle(element, '::-webkit-scrollbar-thumb').borderRadius,
      buttons: win.getComputedStyle(element, '::-webkit-scrollbar-button').display,
    });
    return { root: info(doc.documentElement), table: info(table), code: info(code) };
  });
  let bars = await scrollbarInfo();
  for (const bar of Object.values(bars)) {
    assert.deepEqual(bar, { width: '10px', height: '10px', track: 'rgb(237, 237, 237)', thumb: 'rgb(83, 83, 83)', radius: '10px', buttons: 'none' });
  }
  const scrollbarPoint = await page.evaluate(() => {
    const frame = document.querySelector('iframe');
    const table = frame.contentDocument.querySelector('.markdown-preview[data-for="preview"] table');
    const outer = frame.getBoundingClientRect();
    const inner = table.getBoundingClientRect();
    return { x: outer.left + inner.left + 30, y: outer.top + inner.bottom - 5 };
  });
  await page.mouse.move(scrollbarPoint.x, scrollbarPoint.y);
  await page.mouse.down();
  await page.mouse.move(scrollbarPoint.x + 120, scrollbarPoint.y, { steps: 5 });
  await page.mouse.up();
  assert.ok(await page.evaluate(() => document.querySelector('iframe').contentDocument.querySelector('.markdown-preview[data-for="preview"] table').scrollLeft > 0), 'wide tables must remain horizontally scrollable by dragging');
  previewFrame = await (await page.$('#preview')).contentFrame();
  await previewFrame.click('.markdown-preview h1', { button: 'right' });
  await previewFrame.waitForSelector('.contexify:not(.contexify_submenu)', { visible: true });
  const previewTheme = (await previewFrame.$$('.contexify:not(.contexify_submenu) > .contexify_item'))[1];
  await previewTheme.hover();
  const darkThemeMenu = (await previewTheme.$$(':scope > .contexify_submenu > .contexify_item'))[1];
  await darkThemeMenu.hover();
  const darkTheme = await darkThemeMenu.evaluateHandle((element) => [...element.querySelectorAll(':scope > .contexify_submenu > .contexify_item')]
    .find((item) => item.textContent.trim() === 'github-dark.css'));
  await darkTheme.asElement().click();
  await page.waitForFunction(() => {
    const doc = document.querySelector('iframe')?.contentDocument;
    return localStorage.getItem('markdownPreview.previewTheme') === 'github-dark.css' && doc?.documentElement?.dataset.previewScrollbarTheme === 'dark' && doc.querySelector('.markdown-preview table');
  }, { timeout: 10000 });
  assert.equal(await page.$eval('body', (body) => body.dataset.previewTone), 'dark');
  await page.mouse.move(10, 15);
  await page.waitForFunction(() => {
    const doc = document.querySelector('iframe')?.contentDocument;
    const table = doc?.querySelector('.markdown-preview[data-for="preview"] table');
    return table && doc.defaultView.getComputedStyle(table, '::-webkit-scrollbar-thumb').backgroundColor === 'rgb(150, 155, 161)';
  }, { timeout: 3000 });
  bars = await scrollbarInfo();
  for (const bar of Object.values(bars)) {
    const { thumb, ...other } = bar;
    assert.deepEqual(other, { width: '10px', height: '10px', track: 'rgb(48, 52, 58)', radius: '10px', buttons: 'none' });
    assert.ok(['rgb(150, 155, 161)', 'rgb(178, 183, 189)'].includes(thumb), thumb);
  }
  families = await page.evaluate(() => {
    const doc = document.querySelector('iframe').contentDocument;
    const root = doc.querySelector('.markdown-preview[data-for="preview"]');
    const read = (el) => doc.defaultView.getComputedStyle(el).fontFamily.split(',').map((name) => name.trim().replace(/^['"]|['"]$/g, ''));
    return { text: read(root.querySelector('h1')), code: read(root.querySelector('pre code')) };
  });
  assert.deepEqual(families.text, [...textFonts, ...defaultTextFallback]);
  assert.deepEqual(families.code, [...codeFonts, ...defaultCodeFallback]);
  // A transparent body must use the visible page background, not be treated
  // as black when deciding the scrollbar colors.
  previewFrame = await (await page.$('#preview')).contentFrame();
  await previewFrame.click('.markdown-preview h1', { button: 'right' });
  await previewFrame.waitForSelector('.contexify:not(.contexify_submenu)', { visible: true });
  const darkPreviewTheme = (await previewFrame.$$('.contexify:not(.contexify_submenu) > .contexify_item'))[1];
  await darkPreviewTheme.hover();
  const noneTheme = await darkPreviewTheme.evaluateHandle((element) => [...element.querySelectorAll(':scope > .contexify_submenu > .contexify_item')]
    .find((item) => item.textContent.trim() === '无'));
  await noneTheme.asElement().click();
  await page.waitForFunction(() => {
    const doc = document.querySelector('iframe')?.contentDocument;
    return localStorage.getItem('markdownPreview.previewTheme') === 'none.css' && doc?.documentElement?.dataset.previewScrollbarTheme === 'light' && doc.querySelector('.markdown-preview table');
  }, { timeout: 10000 });
  assert.equal((await scrollbarInfo()).root.track, 'rgb(237, 237, 237)');
  families = await page.evaluate(() => {
    const doc = document.querySelector('iframe').contentDocument;
    const root = doc.querySelector('.markdown-preview[data-for="preview"]');
    const read = (el) => doc.defaultView.getComputedStyle(el).fontFamily.split(',').map((name) => name.trim().replace(/^['"]|['"]$/g, ''));
    return { text: read(root.querySelector('h1')), code: read(root.querySelector('pre code')) };
  });
  assert.deepEqual(families.text, [...textFonts, 'serif']);
  assert.deepEqual(families.code, [...codeFonts, 'monospace']);
  assert.match(files.get('crossnote/styles/preview_theme/vue.css').toString(), /font-family:'Samsung Sans',Rubik,'Noto Sans','Noto Sans SC',Source Sans Pro,Helvetica Neue,Arial,sans-serif/);
  assert.match(files.get('crossnote/styles/prism_theme/vue.css').toString(), /font-family:'Ubuntu Sans Mono','Noto Sans Mono','Cascadia Mono',Roboto Mono,Monaco,courier,monospace/);
  previewFrame = await (await page.$('#preview')).contentFrame();
  const noneFrameId = await previewFrame.evaluate(() => document.documentElement.dataset.markdownPreviewFrame);
  await previewFrame.click('.markdown-preview h1', { button: 'right' });
  await previewFrame.waitForSelector('.contexify:not(.contexify_submenu)', { visible: true });
  const nonePreviewTheme = (await previewFrame.$$('.contexify:not(.contexify_submenu) > .contexify_item'))[1];
  await nonePreviewTheme.hover();
  const lightThemeMenu = (await nonePreviewTheme.$$(':scope > .contexify_submenu > .contexify_item'))[0];
  await lightThemeMenu.hover();
  const mediumTheme = await lightThemeMenu.evaluateHandle((element) => [...element.querySelectorAll(':scope > .contexify_submenu > .contexify_item')]
    .find((item) => item.textContent.trim() === 'medium.css'));
  await mediumTheme.asElement().click();
  await page.waitForFunction((id) => {
    const doc = document.querySelector('iframe')?.contentDocument;
    return localStorage.getItem('markdownPreview.previewTheme') === 'medium.css' && doc?.documentElement?.dataset.markdownPreviewFrame !== id && doc?.querySelector('.markdown-preview pre code');
  }, { timeout: 10000 }, noneFrameId);
  families = await page.evaluate(() => {
    const doc = document.querySelector('iframe').contentDocument;
    const root = doc.querySelector('.markdown-preview[data-for="preview"]');
    const read = (el) => doc.defaultView.getComputedStyle(el).fontFamily.split(',').map((name) => name.trim().replace(/^['"]|['"]$/g, ''));
    return { text: read(root.querySelector('h1')), code: read(root.querySelector('pre code')) };
  });
  assert.deepEqual(families.text, [...textFonts, 'San Francisco', 'Roboto', 'Segoe UI', 'Helvetica Neue', 'Lucida Grande', 'sans-serif']);
  assert.deepEqual(families.code, [...codeFonts, 'Consolas', 'Menlo', 'Monaco', 'monospace', 'serif']);
  await page.setViewport({ width: 220, height: 600 });
  await page.evaluate(() => document.querySelector('iframe').contentWindow.scrollTo(0, 0));
  await page.waitForFunction(() => !document.querySelector('#toolbar').classList.contains('is-collapsed'), { timeout: 3000 });
  previewFrame = await (await page.$('#preview')).contentFrame();
  await previewFrame.evaluate(() => {
    if (document.body.classList.contains('show-sidebar-toc')) document.querySelector('[title="切换目录"]').click();
  });
  await previewFrame.waitForFunction(() => !document.body.classList.contains('show-sidebar-toc'), { timeout: 3000 });
  await previewFrame.hover('.markdown-preview[data-for="preview"] h1');
  await previewFrame.waitForFunction(() => !document.querySelector('.topbar')?.classList.contains('hidden'), { timeout: 3000 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const narrowLayout = await page.evaluate(() => {
    const bar = document.querySelector('#toolbar');
    const frame = document.querySelector('iframe');
    const topbar = frame.contentDocument.querySelector('.topbar');
    const rect = bar.getBoundingClientRect();
    return { left: rect.left, right: rect.right, bottom: rect.bottom,
      topbarTop: frame.getBoundingClientRect().top + topbar.getBoundingClientRect().top,
      buttons: [...bar.querySelectorAll('button')].map((button) => ({ id: button.id, client: button.clientWidth, scroll: button.scrollWidth })) };
  });
  assert.ok(narrowLayout.left >= 0 && narrowLayout.right <= 220 && narrowLayout.topbarTop >= narrowLayout.bottom && narrowLayout.buttons.every((button) => button.scroll <= button.client + 1), JSON.stringify(narrowLayout));
  assert.deepEqual(failures, []);
  assert.deepEqual(missing, []);
  assert.deepEqual(externalRequests, []);
});
