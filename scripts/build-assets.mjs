import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modules = resolve(process.env.MARKDOWN_PREVIEW_NODE_MODULES || join(root, 'node_modules'));
const output = resolve(process.env.MARKDOWN_PREVIEW_ASSET_DIR || join(root, 'build', 'assets'));
const require = createRequire(join(modules, '_resolve_.js'));
const { build } = require('esbuild');
const { polyfillNode } = require('esbuild-plugin-polyfill-node');
const crossnote = join(modules, 'crossnote', 'out');

// Crossnote's Node/Atom compatibility wrappers replace the browser's native
// eval with vm.runInThisContext. A browser vm shim calls eval itself, producing
// infinite recursion when Vega renders. WebView2 already allows the native
// implementations, so make these wrappers no-ops for the pinned 0.9.42 build.
// Fail the build if upstream changes rather than silently patching other code.
const patchCrossnoteBrowserCompatibility = {
  name: 'crossnote-browser-compatibility',
  setup(build) {
    build.onLoad({ filter: /crossnote[/\\]out[/\\]esm[/\\]index\.mjs$/ }, async ({ path }) => {
      let contents = await readFile(path, 'utf8');
      const replacements = [
        ['function NM(d){let p=globalThis.eval;try{return globalThis.eval=w=>lk.runInThisContext(w),d()}finally{globalThis.eval=p}}', 'function NM(d){return d()}'],
        ['function OM(d){let p=globalThis.Function;try{return globalThis.Function=UA,d()}finally{globalThis.Function=p}}', 'function OM(d){return d()}'],
        ['async function DM(d){let p=globalThis.Function,w=globalThis.eval;try{return globalThis.Function=UA,globalThis.eval=k=>lk.runInThisContext(k),await d()}finally{globalThis.eval=w,globalThis.Function=p}}', 'async function DM(d){return await d()}'],
        // Crossnote caches PlantUML clients by directory. Recreate the client
        // when that directory's configured server changes after a refresh.
        [',!Oy[p])if(w)Oy[p]=new Ny(w);else{if(!J4(k))', ',!Oy[p]||(w&&Oy[p].serverURL!==w))if(w)Oy[p]=new Ny(w);else{if(!J4(k))'],
      ];
      for (const [before, after] of replacements) {
        if (!contents.includes(before) || contents.indexOf(before) !== contents.lastIndexOf(before)) {
          throw new Error('Unsupported Crossnote bundle: browser compatibility patch did not match exactly once.');
        }
        contents = contents.replace(before, after);
      }
      return { contents, loader: 'js', resolveDir: dirname(path) };
    });
  },
};

// Crossnote ships its preview UI as a prebuilt React bundle. Adapt its controls
// and zoom baseline while preserving its counter-zoom for fixed UI elements.
// Match the pinned bundle exactly so upstream changes fail the build visibly.
function patchPreviewControls(contents) {
  function replaceOnce(before, after) {
    if (!contents.includes(before) || contents.indexOf(before) !== contents.lastIndexOf(before)) {
      throw new Error('Unsupported Crossnote preview bundle: zoom compatibility patch did not match exactly once.');
    }
    contents = contents.replace(before, after);
  }
  function removeBetween(start, end, consumeEnd = false) {
    const first = contents.indexOf(start);
    const last = contents.indexOf(end, first + start.length);
    if (first < 0 || last < 0 || first !== contents.lastIndexOf(start) || last !== contents.lastIndexOf(end)) {
      throw new Error('Unsupported Crossnote preview bundle: menu compatibility patch did not match exactly once.');
    }
    contents = contents.slice(0, first) + contents.slice(last + (consumeEnd ? end.length : 0));
  }

  removeBetween(
    '!x&&r1.default.createElement(r1.default.Fragment,null,r1.default.createElement(Me,{id:"open-graph-view"',
    '!i&&!x&&r1.default.createElement(r1.default.Fragment,null,r1.default.createElement(Me,{id:"open-in-browser"',
  );
  removeBetween(
    '!o&&r1.default.createElement(zs,{label:r1.default.createElement("span",{className:"inline-flex flex-row items-center"},r1.default.createElement(sr.default,{path:Lk,size:.8,className:"mr-2"}),ke("contextMenu.editMarkdown"))}',
    '!i&&!x&&r1.default.createElement(r1.default.Fragment,null,r1.default.createElement(Me,{id:"open-image-helper"',
  );
  removeBetween(
    '!x&&r1.default.createElement(r1.default.Fragment,null,r1.default.createElement(Me,{id:"sync-source"',
    'r1.default.createElement(zs,{label:r1.default.createElement("span",{className:"inline-flex flex-row items-center"},r1.default.createElement(sr.default,{path:EY,size:.8,className:"mr-2"}),ke("contextMenu.zoom")',
  );
  removeBetween(
    ',r1.default.createElement(p3,null),r1.default.createElement(zs,{label:r1.default.createElement("span",{className:"inline-flex flex-row items-center"},r1.default.createElement(sr.default,{path:nC1,size:.8,className:"mr-2"}),ke("contextMenu.about"))}',
    'ke("contextMenu.sponsors")))',
    true,
  );
  removeBetween(
    'Y2.default.createElement("div",{className:"p-1 cursor-pointer hover:text-primary w-5 h-5",title:ke("footer.openGraphView")',
    'Y2.default.createElement("div",{className:"p-1 cursor-pointer hover:text-primary w-5 h-5",title:ke("footer.zoomOut")',
  );
  // K remains the percentage displayed to the user. A nominal 100% uses the
  // old 90% body zoom; fixed controls counteract the actual applied zoom.
  replaceOnce(
    'document.body.style.zoom=String(K),K!==1){let w1=1/K,g1=document.querySelectorAll(".fixed, .contexify")',
    'document.body.style.zoom=String(.9*K),.9*K!==1){let w1=1/(.9*K),g1=document.querySelectorAll(".fixed, .contexify")',
  );
  replaceOnce(
    'if(w1=0,K===1)return;let A1=1/K,j1=document.querySelectorAll(".fixed, .contexify")',
    'if(w1=0,.9*K===1)return;let A1=1/(.9*K),j1=document.querySelectorAll(".fixed, .contexify")',
  );
  replaceOnce(
    'J=new MutationObserver(()=>{K!==1&&(w1||(w1=requestAnimationFrame(g1)))})',
    'J=new MutationObserver(()=>{.9*K!==1&&(w1||(w1=requestAnimationFrame(g1)))})',
  );
  return contents;
}

// Add preferred locally installed fonts in front of each theme's own fallback
// list. Preserve the theme-specific fallbacks, including generic families.
const textFontPrefix = "'Samsung Sans',Rubik,'Noto Sans','Noto Sans SC',";
const codeFontPrefix = "'Ubuntu Sans Mono','Noto Sans Mono','Cascadia Mono',";
const textFontStacks = [
  "'Helvetica Neue',Helvetica,'Segoe UI',Arial,freesans,sans-serif",
  'Raleway,sans-serif',
  "'San Francisco',Roboto,'Segoe UI','Helvetica Neue','Lucida Grande',sans-serif",
  "'PT Serif','Times New Roman',Times",
  "'Helvetica Neue',Helvetica,Arial,sans-serif",
  "'Lucida Grande',Corbal,Georgia,serif",
  'var(--vscode-font-family,system-ui,-apple-system,sans-serif)',
  'Source Sans Pro,Helvetica Neue,Arial,sans-serif',
];
const codeFontStacks = [
  "Menlo,Monaco,Consolas,'Courier New',monospace",
  'Consolas,Menlo,Monaco,monospace,serif',
  "Monaco,Consolas,'Andale Mono','DejaVu Sans Mono',monospace",
  "var(--vscode-editor-font-family, 'Cascadia Code', Menlo, Monaco, Consolas, 'Courier New', monospace)",
];

function patchThemeFonts(name, contents) {
  if (name.startsWith('crossnote/styles/prism_theme/') && name.endsWith('.css')) {
    let count = 0;
    const result = contents.replace(/font-family:([^;{}]+)/g, (_, stack) => {
      count++;
      return `font-family:${codeFontPrefix}${stack}`;
    });
    if (!count) throw new Error(`Unsupported Crossnote code theme: ${name}`);
    return result;
  }
  if (!name.startsWith('crossnote/styles/preview_theme/') || !name.endsWith('.css')) return contents;

  let textCount = 0;
  let codeCount = 0;
  for (const [stacks, prefix, count] of [
    [textFontStacks, textFontPrefix, () => textCount++],
    [codeFontStacks, codeFontPrefix, () => codeCount++],
  ]) {
    for (const stack of stacks) {
      const declaration = `font-family:${stack}`;
      if (contents.includes(declaration)) {
        contents = contents.replaceAll(declaration, () => {
          count();
          return `font-family:${prefix}${stack}`;
        });
      }
    }
  }
  const basename = name.slice(name.lastIndexOf('/') + 1);
  if (!textCount) {
    // These empty themes rely on the browser's default serif font.
    if (!['none.css', 'github.css'].includes(basename) || contents.trim()) throw new Error(`Unsupported Crossnote text theme: ${name}`);
    contents += `\nhtml body{font-family:${textFontPrefix}serif}`;
  }
  if (!codeCount) {
    // These themes leave <code> to the browser's default monospace family.
    if (!['none.css', 'github.css', 'gothic.css', 'newsprint.css', 'vue.css'].includes(basename)) throw new Error(`Unsupported Crossnote code font: ${name}`);
    contents += `\nhtml body code{font-family:${codeFontPrefix}monospace}`;
  }
  return contents;
}

await mkdir(output, { recursive: true });
await build({
  entryPoints: [join(root, 'src', 'web', 'host.js')],
  outfile: join(output, 'engine.js'),
  nodePaths: [modules],
  bundle: true,
  minify: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  external: ['vscode', 'node-tikzjax', 'stream/promises', 'stream', 'sharp'],
  plugins: [patchCrossnoteBrowserCompatibility, polyfillNode({ polyfills: { fs: true } })],
  define: { global: 'globalThis', 'process.env.IS_VSCODE_WEB_EXTENSION': '"true"' },
});

const entries = [
  ['index.html', await readFile(join(root, 'src', 'web', 'index.html'))],
  ['engine.js', await readFile(join(output, 'engine.js'))],
];
const notices = [
  'Markdown Preview — third-party notices\n',
  await readFile(join(root, 'LICENSE'), 'utf8'),
  await readFile(join(root, 'third_party', 'emeditor-sdk', 'LICENSE'), 'utf8'),
  await readFile(join(root, 'third_party', 'CROSSNOTE_LICENSE.md'), 'utf8'),
  await readFile(join(root, 'third_party', 'MARKDOWN_PREVIEW_ENHANCED_LICENSE.md'), 'utf8'),
  await readFile(join(root, 'third_party', 'WEBVIEW2_LICENSE.txt'), 'utf8'),
];
for (const name of (await readdir(join(root, 'third_party', 'vendor-licenses'))).sort()) {
  notices.push(`\n--- Crossnote vendored asset: ${name} ---\n`);
  notices.push(await readFile(join(root, 'third_party', 'vendor-licenses', name), 'utf8'));
}
notices.push('\n--- Source Sans Pro font bundled with Reveal.js ---\n');
notices.push(await readFile(join(crossnote, 'dependencies', 'reveal', 'lib', 'font', 'source-sans-pro', 'LICENSE'), 'utf8'));
async function packageNotices(directory) {
  const folders = await readdir(directory, { withFileTypes: true });
  for (const item of folders.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!item.isDirectory() || item.name === '.bin' || item.name.startsWith('.')) continue;
    const packageDir = join(directory, item.name);
    if (item.name.startsWith('@')) { await packageNotices(packageDir); continue; }
    let manifest;
    try { manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')); }
    catch { continue; }
    const names = await readdir(packageDir);
    const licenseFile = names.find((name) => /^(license|licence|copying)(\.(md|txt|markdown))?$/i.test(name));
    notices.push(`\n--- ${manifest.name || item.name}@${manifest.version || '?'} (${manifest.license || 'see package'}) ---\n`);
    if (licenseFile) notices.push(await readFile(join(packageDir, licenseFile), 'utf8'));
    else notices.push(`License declared by package: ${manifest.license || 'not specified'}\n`);
    if (names.includes('node_modules')) await packageNotices(join(packageDir, 'node_modules'));
  }
}
await packageNotices(modules);
const noticesText = Buffer.from(notices.join('\n'), 'utf8');
await rm(join(output, 'THIRD-PARTY-NOTICES.txt'), { force: true });
entries.push(['notices.txt', noticesText]);
async function collect(directory, prefix) {
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(directory, item.name);
    const name = `${prefix}/${item.name}`;
    if (item.isDirectory()) await collect(file, name);
    else if (item.isFile()) {
      const data = await readFile(file);
      if (name === 'crossnote/webview/preview.js') entries.push([name, Buffer.from(patchPreviewControls(data.toString('utf8')))]);
      else if (name.startsWith('crossnote/styles/preview_theme/') || name.startsWith('crossnote/styles/prism_theme/')) {
        entries.push([name, Buffer.from(patchThemeFonts(name, data.toString('utf8')))]);
      } else entries.push([name, data]);
    }
  }
}
for (const directory of ['dependencies', 'styles', 'webview']) {
  await collect(join(crossnote, directory), `crossnote/${directory}`);
}
// Reveal 4's themes use ./fonts/ but Crossnote stores these files in lib/font.
await collect(join(crossnote, 'dependencies', 'reveal', 'lib', 'font'),
  'crossnote/dependencies/reveal/css/theme/fonts');

// A small deterministic uncompressed archive makes every asset a resource in
// the single plug-in DLL. The native host serves entries on WebView2 requests.
const header = Buffer.alloc(8);
header.write('MPAK', 0, 'ascii');
header.writeUInt32LE(entries.length, 4);
const parts = [header];
for (const [name, data] of entries) {
  const key = Buffer.from(name, 'utf8');
  if (key.length > 65535 || data.length > 0xffffffff) throw new Error(`Asset too large: ${name}`);
  const entry = Buffer.alloc(6);
  entry.writeUInt16LE(key.length, 0);
  entry.writeUInt32LE(data.length, 2);
  parts.push(entry, key, data);
}
await writeFile(join(output, 'assets.pack'), Buffer.concat(parts));
console.log(`Packed ${entries.length} assets into ${join(output, 'assets.pack')}`);
