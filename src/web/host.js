import { Notebook, utility } from 'crossnote';
import { toJpeg, toPng } from 'html-to-image';

// Crossnote runs in WebView2, while filesystem access is performed by the
// native plug-in. The bridge is deliberately asynchronous and read-only.
const webview = window.chrome?.webview;
const preview = document.getElementById('preview');
const message = document.getElementById('message');
const toolbar = document.getElementById('toolbar');
const origin = window.location.origin;
const pending = new Map();
let nextRequest = 0;
let generation = 0;
let queued = null;
let rendering = false;
let current = null;
let latestDocument = null;
let lastResult = null;
let childReady = false;
let frameExists = false;
let displayedRevision = '';
let revisionObserver = null;
let publicationInFlight = false;
let pendingPublication = false;
let publicationTimer = null;
let nextPublicationId = 0;
const publicationNonce = Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16)).join('-');
let nextFrameId = 0;
let activeFrameId = 0;
const linkedDocuments = new WeakSet();
let toolbarDocument = null;
let detachToolbarScroll = null;
let needsFreshNotebook = false;
let pdfExportInProgress = false;

// The preview runs in a separate document. Keep its menu compact and make
// document and table scrollbars consistent across Crossnote's themes.
const previewStyles = `<style>
  :root {
    --preview-scrollbar-track: #ededed;
    --preview-scrollbar-thumb: #535353;
    --preview-scrollbar-hover: #3d3d3d;
  }
  :root[data-preview-scrollbar-theme="dark"] {
    --preview-scrollbar-track: #30343a;
    --preview-scrollbar-thumb: #969ba1;
    --preview-scrollbar-hover: #b2b7bd;
  }
  @media (forced-colors: none) {
    :is(html, body, body .markdown-preview, body .markdown-preview *)::-webkit-scrollbar {
      width: 10px;
      height: 10px;
    }
    :is(html, body, body .markdown-preview, body .markdown-preview *)::-webkit-scrollbar-track {
      background: var(--preview-scrollbar-track);
      border-radius: 10px;
      box-shadow: inset 0 0 5px rgba(0, 0, 0, .2);
    }
    :is(html, body, body .markdown-preview, body .markdown-preview *)::-webkit-scrollbar-thumb {
      background: var(--preview-scrollbar-thumb);
      background-clip: border-box;
      border: 0;
      border-radius: 10px;
      box-shadow: inset 0 0 5px rgba(0, 0, 0, .2);
    }
    :is(html, body, body .markdown-preview, body .markdown-preview *)::-webkit-scrollbar-thumb:hover {
      background: var(--preview-scrollbar-hover);
    }
    :is(html, body, body .markdown-preview, body .markdown-preview *)::-webkit-scrollbar-button {
      display: none;
      width: 0;
      height: 0;
    }
    :is(html, body, body .markdown-preview, body .markdown-preview *)::-webkit-scrollbar-corner {
      background: transparent;
    }
  }
  .contexify {
    --contexify-menu-minWidth: 9.1667rem;
    --contexify-menu-padding: .25rem;
    --contexify-menu-radius: .25rem;
    --contexify-separator-margin: .2083rem;
    --contexify-itemContent-padding: .25rem;
    --contexify-activeItem-radius: .1667rem;
    font-size: .6667rem;
  }
  .contexify svg[role="presentation"] { width: .8rem !important; height: .8rem !important; }
  .contexify svg.mr-2 { margin-right: .3333rem; }
  .contexify_rightSlot svg { width: .75rem; height: .75rem; }
  body.preview-container:not([data-presentation-mode]) .crossnote[data-for="preview"] { padding-top: calc(2em + 30px); }
  @media (max-width: 600px) {
    body.preview-container:not([data-presentation-mode]) .crossnote[data-for="preview"] { padding-top: calc(2em + 68px); }
    body .topbar { transition: top 300ms ease; }
    body[data-host-toolbar="visible"] .topbar { top: 54px; }
  }
  @media (prefers-reduced-motion: reduce) { body .topbar { transition: none; } }
  @media print { body.preview-container:not([data-presentation-mode]) .crossnote[data-for="preview"] { padding-top: 2em; } }
</style>`;

function setToolbarVisible(visible) {
  if (!visible && toolbar.contains(document.activeElement)) preview.focus({ preventScroll: true });
  toolbar.classList.toggle('is-collapsed', !visible);
  toolbar.setAttribute('aria-hidden', String(!visible));
  toolbar.inert = !visible;
  const body = preview.contentDocument?.body;
  if (body) body.dataset.hostToolbar = visible ? 'visible' : 'hidden';
}

function bindToolbarScroll() {
  const doc = preview.contentDocument;
  const win = preview.contentWindow;
  if (!doc?.body || !win || toolbarDocument === doc) return;
  detachToolbarScroll?.();
  toolbarDocument = doc;
  setToolbarVisible(true);
  let previous = Math.max(0, win.scrollY);
  let direction = 0;
  let distance = 0;
  const readyAt = performance.now() + 250;
  const onScroll = () => {
    if (preview.contentDocument !== doc) return;
    const position = Math.max(0, win.scrollY);
    const delta = position - previous;
    previous = position;
    if (position <= 8) {
      direction = distance = 0;
      setToolbarVisible(true);
      return;
    }
    // Ignore initial layout/scroll restoration, so a newly opened document
    // always starts with its toolbar visible.
    if (performance.now() < readyAt || Math.abs(delta) < .5) return;
    const nextDirection = Math.sign(delta);
    if (direction !== nextDirection) {
      direction = nextDirection;
      distance = 0;
    }
    distance += Math.abs(delta);
    if (direction > 0 && position > 72 && distance >= 64) setToolbarVisible(false);
    else if (direction < 0 && distance >= 32) setToolbarVisible(true);
  };
  const onKeyDown = (event) => {
    if (event.key === 'Tab' && toolbar.classList.contains('is-collapsed')) setToolbarVisible(true);
  };
  win.addEventListener('scroll', onScroll, { passive: true });
  doc.addEventListener('keydown', onKeyDown, true);
  detachToolbarScroll = () => {
    win.removeEventListener('scroll', onScroll);
    doc.removeEventListener('keydown', onKeyDown, true);
  };
}

function nativeSend(value) {
  if (webview) webview.postMessage(value);
  else if (window.__markdownPreviewTestSend) window.__markdownPreviewTestSend(value);
}

function nativeRequest(operation, filePath) {
  const id = ++nextRequest;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`File request timed out: ${filePath}`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    nativeSend(`fs\t${id}\t${operation}\t${encodeURIComponent(filePath)}`);
  });
}

const fileSystem = {
  exists: async (filePath) => (await nativeRequest('exists', filePath)) === '1',
  readFile: async (filePath) => nativeRequest('read', filePath),
  readdir: async (filePath) => {
    const value = await nativeRequest('readdir', filePath);
    return value ? value.split('\n') : [];
  },
  stat: async (filePath) => {
    const [type, size, mtime] = (await nativeRequest('stat', filePath)).split('\t');
    return {
      isFile: () => type === 'file',
      isDirectory: () => type === 'directory',
      isSymbolicLink: () => type === 'symlink',
      size: Number(size) || 0,
      mtimeMs: Number(mtime) || 0,
      ctimeMs: Number(mtime) || 0,
    };
  },
  // Crossnote creates missing example configuration files on first use. They
  // are optional; discard those writes while keeping the document read-only.
  writeFile: async (filePath) => {
    if (!/(?:^|\/)\.crossnote\/(?:style\.less|head\.html|config\.js|parser\.js)$/i.test(filePath.replace(/\\/g, '/'))) {
      throw new Error('Preview filesystem is read-only');
    }
  },
  mkdir: async () => { throw new Error('Preview filesystem is read-only'); },
  unlink: async () => { throw new Error('Preview filesystem is read-only'); },
};

utility.setCrossnoteBuildDirectory('/__crossnote');
utility.useExternalAddFileProtocolFunction((filePath) => {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('/__crossnote/')) {
    return `${origin}/crossnote/${normalized.slice('/__crossnote/'.length).split('/').map(encodeURIComponent).join('/')}`;
  }
  return `${origin}/local?path=${encodeURIComponent(normalized)}`;
});
const panel = { webview: {} };

function fileUri(path) {
  if (!path) return 'file:///__untitled__/document.md';
  const value = path.replace(/\\/g, '/');
  if (value.startsWith('//')) {
    return `file:///__unc__/${value.slice(2).split('/').map(encodeURIComponent).join('/')}`;
  }
  const match = /^([a-z]):\/(.*)$/i.exec(value);
  if (match) return `file:///__drive__/${match[1].toUpperCase()}/${match[2].split('/').map(encodeURIComponent).join('/')}`;
  return `file:///${value.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`;
}

function reportError(error) {
  // An outstanding parser or old iframe must not replace a newer error with
  // stale content. The next document update will create a fresh preview.
  ++generation;
  queued = null;
  resetPublication();
  childReady = false;
  frameExists = false;
  activeFrameId = 0;
  lastResult = null;
  setToolbarVisible(true);
  message.textContent = `Markdown Preview: ${error instanceof Error ? error.message : String(error)}`;
  message.style.display = 'block';
  preview.style.display = 'none';
  console.error(error);
}

function resetPublication() {
  revisionObserver?.disconnect();
  revisionObserver = null;
  if (publicationTimer !== null) clearTimeout(publicationTimer);
  publicationTimer = null;
  publicationInFlight = false;
  pendingPublication = false;
  displayedRevision = '';
}

function sendToPreview(value) {
  if (childReady && preview.contentWindow) preview.contentWindow.postMessage(value, '*');
}

function publishResult() {
  if (!lastResult || !current || !childReady) return;
  if (lastResult.yamlConfig?.isPresentationMode) {
    // Presentation HTML is already in the template. Sending updateHtml would
    // make the upstream webview request another refresh.
    resetPublication();
    displayedRevision = current.revision;
    if (preview.contentDocument?.body) updateScrollbarTheme(preview.contentDocument.body);
  } else {
    if (publicationInFlight) {
      pendingPublication = true;
      displayedRevision = '';
      // Upstream renders into a shared hidden DOM. Overlapping updates can
      // clear each other's output. If the previous render is stuck on a slow
      // diagram, reload the frame with the newest document instead of waiting.
      if (publicationTimer === null) publicationTimer = setTimeout(() => {
        publicationTimer = null;
        if (publicationInFlight && pendingPublication) refreshCurrent();
      }, 250);
      return;
    }
    // Until React has replaced the visible content, reject clicks and scrolls
    // from the previous render instead of attributing them to a newer revision.
    displayedRevision = '';
    const visible = preview.contentDocument?.querySelector('.markdown-preview[data-for="preview"]');
    if (!visible) {
      reportError('The preview page did not initialize.');
      return;
    }
    updateScrollbarTheme(visible);
    const revision = current.revision;
    const frameId = activeFrameId;
    const publicationId = `${publicationNonce}-${++nextPublicationId}`;
    publicationInFlight = true;
    revisionObserver = new MutationObserver(() => {
      if (!visible.querySelector(`[data-markdown-preview-render="${publicationId}"]`)) return;
      revisionObserver?.disconnect();
      revisionObserver = null;
      publicationInFlight = false;
      if (publicationTimer !== null) clearTimeout(publicationTimer);
      publicationTimer = null;
      if (frameId !== activeFrameId) return;
      updateScrollbarTheme(visible);
      if (pendingPublication) {
        pendingPublication = false;
        publishResult();
      } else {
        displayedRevision = revision;
      }
    });
    revisionObserver.observe(visible, { childList: true });
    sendToPreview({
      command: 'updateHtml',
      markdown: current.text,
      html: `${lastResult.html}<span hidden data-markdown-preview-render="${publicationId}"></span>`,
      tocHTML: lastResult.tocHTML,
      totalLineCount: current.text.split(/\r\n|\r|\n/).length,
      sourceUri: current.uri,
      sourceScheme: 'file',
      id: lastResult.yamlConfig?.id || '',
      class: lastResult.yamlConfig?.class || '',
    });
  }
  preview.style.display = 'block';
  message.style.display = 'none';
}

async function createNotebook(job) {
  const uri = fileUri(job.path);
  const separator = uri.lastIndexOf('/');
  const notebookPath = uri.slice(0, separator) || 'file:///__untitled__';
  const noteName = decodeURIComponent(uri.slice(separator + 1)) || 'document.md';
  const config = {
    enableScriptExecution: false,
    previewTheme: localStorage.getItem('markdownPreview.previewTheme') || 'github-light.css',
    codeBlockTheme: localStorage.getItem('markdownPreview.codeBlockTheme') || 'github.css',
    revealjsTheme: localStorage.getItem('markdownPreview.revealjsTheme') || 'white.css',
  };
  const notebook = await Notebook.init({ notebookPath, fs: fileSystem, config });
  // The upstream default starts a local Java process, which is unavailable in
  // WebView2. Use a browser-compatible service unless the document supplies
  // its own PlantUML endpoint in .crossnote/config.js.
  if (typeof notebook.config.plantumlServer !== 'string' || !notebook.config.plantumlServer.trim()) {
    notebook.updateConfig({ plantumlServer: 'https://kroki.io/plantuml/svg' });
  }
  return { ...job, uri, notebook, engine: notebook.getNoteMarkdownEngine(noteName) };
}

async function render(job) {
  const version = job.version;
  const changedDocument = !current || current.id !== job.id || current.path !== job.path;
  if (changedDocument || needsFreshNotebook) {
    const next = await createNotebook(job);
    if (version !== generation) return;
    current = next;
    needsFreshNotebook = false;
    resetPublication();
    lastResult = null;
    childReady = false;
    activeFrameId = 0;
    frameExists = false;
    preview.style.display = 'none';
    message.style.display = 'block';
    message.textContent = 'Loading Markdown Preview…';
  }
  const text = job.text || '\n'; // Crossnote treats an empty string as a disk read.
  const result = await current.engine.parseMD(text, {
    isForPreview: true,
    useRelativeFilePath: false,
    hideFrontMatter: false,
    vscodePreviewPanel: panel,
  });
  if (version !== generation) return;
  current.text = job.text;
  current.revision = job.revision;
  lastResult = result;
  // Front matter can change the template itself, for example when a document
  // becomes a Reveal.js presentation. Recreate the frame when it changes.
  const templateKey = JSON.stringify(result.yamlConfig || {});
  if (changedDocument || job.reload || !frameExists || current.templateKey !== templateKey || result.yamlConfig?.isPresentationMode) {
    resetPublication();
    childReady = false;
    activeFrameId = 0;
    const frameId = ++nextFrameId;
    const shim = `${previewStyles}<script>document.documentElement.dataset.markdownPreviewFrame="${frameId}";window.acquireVsCodeApi=()=>({postMessage:m=>parent.postMessage({markdownPreview:1,frameId:${frameId},message:m},"*")});</script>`;
    let html = await current.engine.generateHTMLTemplateForPreview({
      inputString: text,
      parsedOutput: result,
      config: {
        sourceUri: current.uri,
        isVSCode: true,
        scrollSync: true,
        locale: navigator.language.toLowerCase(),
      },
      vscodePreviewPanel: panel,
      isVSCodeWebExtension: true,
      head: shim,
    });
    // Upstream loads these optional services for every preview. Keep normal
    // previews local; load them only after the user enables online diagrams.
    if (localStorage.getItem('markdownPreview.online') !== '1') {
      html = html.replace(/<link[^>]*href="https:\/\/tikzjax\.com\/v1\/fonts\.css"[^>]*>/g, '')
        .replace(/<script[^>]*src="https:\/\/tikzjax\.com\/v1\/tikzjax\.js"[^>]*><\/script>/g, '')
        .replace(/<script type="module">(?:(?!<\/script>)[\s\S])*?mermaid-zenuml(?:(?!<\/script>)[\s\S])*?<\/script>/g, '');
    }
    if (version !== generation) return;
    current.templateKey = templateKey;
    activeFrameId = frameId;
    preview.srcdoc = html;
    frameExists = true;
  } else {
    publishResult();
  }
}

async function drain() {
  if (rendering) return;
  rendering = true;
  while (queued) {
    const job = queued;
    queued = null;
    try { await render(job); } catch (error) { if (job.version === generation) reportError(error); }
  }
  rendering = false;
}

function setDocument(id, path, text, reload = false, revision = current?.revision || '') {
  if (!reload && (!latestDocument || latestDocument.id !== id || latestDocument.path !== path)) setToolbarVisible(true);
  if (!reload) latestDocument = { id, path, text, revision };
  queued = { id, path, text, reload, revision, version: ++generation };
  void drain();
}

function refreshCurrent(reloadResources = false) {
  const doc = latestDocument || current;
  if (doc) {
    if (reloadResources) needsFreshNotebook = true;
    setDocument(doc.id, doc.path, doc.text, true, doc.revision);
  }
}

function receiveNative(value) {
  if (typeof value !== 'string') return;
  const split = value.indexOf('\n');
  const header = split < 0 ? value : value.slice(0, split);
  const payload = split < 0 ? '' : value.slice(split + 1);
  const fields = header.split('\t');
  if (fields[0] === 'document') {
    setDocument(fields[1], decodeURIComponent(fields[3] || ''), payload, false, fields[2] || '');
  } else if (fields[0] === 'fs') {
    const request = pending.get(Number(fields[1]));
    if (!request) return;
    pending.delete(Number(fields[1]));
    clearTimeout(request.timer);
    if (fields[2] === 'ok') request.resolve(payload);
    else request.reject(new Error(payload || 'File access failed'));
  } else if (fields[0] === 'scroll') {
    sendToPreview({ command: 'changeTextEditorSelection', line: Number(fields[1]), forced: true });
  } else if (fields[0] === 'error') {
    // The host could not send the active document at all (for example, it is
    // too large); refreshing an earlier snapshot would show the wrong file.
    latestDocument = null;
    current = null;
    reportError(payload);
  } else if (fields[0] === 'printdone') {
    pdfExportInProgress = false;
    preview.style.height = '';
  }
}

function openLink(href) {
  if (!current) return;
  try {
    const target = new URL(href, current.uri);
    if (target.origin === origin && target.pathname === '/local') {
      nativeSend(`openfile\t${encodeURIComponent(target.searchParams.get('path') || '')}`);
    } else if (target.protocol === 'file:') {
      nativeSend(`openfile\t${encodeURIComponent(decodeURIComponent(target.pathname))}`);
    } else if (['http:', 'https:', 'mailto:'].includes(target.protocol)) {
      nativeSend(`open\t${encodeURIComponent(target.href)}`);
    }
  } catch (error) { console.error(error); }
}

function interceptDocumentLinks() {
  const doc = preview.contentDocument;
  if (!doc || linkedDocuments.has(doc)) return;
  linkedDocuments.add(doc);
  doc.addEventListener('click', (event) => {
    const element = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    const link = element?.closest?.('a[href]');
    if (!link?.closest('.markdown-preview[data-for="preview"]')) return;
    const href = link.getAttribute('href');
    // Leave in-document anchors and Crossnote tags to the upstream preview.
    if (!href || href.startsWith('#') || href.startsWith('tag://') || link.classList.contains('tag')) return;
    // Crossnote decodes the whole href before it sends a click message. That
    // turns encoded #, & and % in file names or URLs into delimiters. Capture
    // the original attribute instead, before the upstream handler sees it.
    event.preventDefault();
    event.stopImmediatePropagation();
    openLink(href);
  }, true);
}

function previewMessage(event) {
  if (event.source !== preview.contentWindow || event.data?.markdownPreview !== 1 ||
      !activeFrameId || event.data.frameId !== activeFrameId) return;
  const { command, args = [] } = event.data.message || {};
  if (command === 'webviewFinishLoading') {
    bindToolbarScroll();
    interceptDocumentLinks();
    childReady = true;
    publishResult();
  } else if (command === 'revealLine' && Number.isFinite(Number(args[1]))) {
    nativeSend(`reveal\t${Math.max(0, Math.trunc(Number(args[1])))}\t${current?.id || ''}\t${displayedRevision}`);
  } else if (command === 'clickTaskListCheckbox' && Number.isFinite(Number(args[1]))) {
    nativeSend(`task\t${Math.max(0, Math.trunc(Number(args[1])))}\t${current?.id || ''}\t${displayedRevision}`);
  } else if (command === 'clickTagA' && args[0]?.href) {
    try { openLink(decodeURIComponent(args[0].href)); }
    catch (error) { console.error(error); }
  } else if (['setPreviewTheme', 'setCodeBlockTheme', 'setRevealjsTheme'].includes(command)) {
    const key = command === 'setPreviewTheme' ? 'previewTheme' : command === 'setCodeBlockTheme' ? 'codeBlockTheme' : 'revealjsTheme';
    if (typeof args[1] === 'string' && /^[a-z0-9-]+\.css$/i.test(args[1])) {
      localStorage.setItem(`markdownPreview.${key}`, args[1]);
      current.notebook.updateConfig({ [key]: args[1] });
      refreshCurrent();
    }
  } else if (command === 'refreshPreview' && current) {
    refreshCurrent(true);
  } else if (command === 'htmlExport') {
    void exportHtml();
  } else if (command === 'chromeExport' && args[1] === 'pdf') {
    exportPdf();
  } else if (command === 'chromeExport' && ['png', 'jpeg'].includes(args[1])) {
    void exportImage(args[1]);
  } else if (command && !['setZoomLevel', 'cacheCodeChunkResult'].includes(command)) {
    nativeSend(`command\t${encodeURIComponent(command)}`);
  }
}

window.addEventListener('message', previewMessage);
preview.addEventListener('load', () => {
  interceptDocumentLinks();
  if (Number(preview.contentDocument?.documentElement?.dataset.markdownPreviewFrame) === activeFrameId && activeFrameId) bindToolbarScroll();
  // Unlike the normal preview, Crossnote's presentation does not emit
  // webviewFinishLoading. Its template already contains the rendered slides.
  if (Number(preview.contentDocument?.documentElement?.dataset.markdownPreviewFrame) === activeFrameId &&
      activeFrameId && preview.contentDocument?.body?.hasAttribute('data-presentation-mode')) {
    childReady = true;
    publishResult();
  }
});
webview?.addEventListener('message', (event) => receiveNative(event.data));

async function dataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not read ${url}`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function inlineCss(css, base, ancestors = new Set()) {
  // Resolve imported local styles before embedding their relative fonts and
  // images; a raw data: URL would lose the original stylesheet's base URL.
  const imports = [...css.matchAll(/@import\s+(?:url\(\s*(['"]?)([^)'"\s]+)\1\s*\)|(['"])([^'"]+)\3)\s*([^;]*);/gi)];
  for (const match of imports) {
    try {
      const url = new URL(match[2] || match[4], base);
      if (url.origin !== origin) continue;
      if (ancestors.has(url.href)) { css = css.replace(match[0], ''); continue; }
      const response = await fetch(url);
      if (!response.ok) continue;
      const nested = new Set(ancestors);
      nested.add(url.href);
      const imported = await inlineCss(await response.text(), url, nested);
      const media = match[5].trim();
      css = css.replace(match[0], media ? `@media ${media} {\n${imported}\n}` : imported);
    } catch (error) { console.warn(error); }
  }
  const matches = [...css.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g)];
  for (const match of matches) {
    try {
      const url = new URL(match[2], base);
      if (url.origin === origin) css = css.replace(match[0], `url("${await dataUrl(url.href)}")`);
    } catch (error) { console.warn(error); }
  }
  return css;
}

function exportedFileUri(path) {
  const normalized = path.replace(/\\/g, '/');
  const drive = /^\/?(?:__drive__\/)?([a-z])(?::\/|\/)(.*)$/i.exec(normalized);
  if (drive) {
    const components = drive[2].split('/').map(encodeURIComponent).join('/');
    return `file:///${drive[1].toUpperCase()}:/${components}`;
  }
  const unc = /^\/(?:__unc__\/|\/)([^/]+)\/(.*)$/.exec(normalized);
  if (unc) return `file://${unc[1]}/${unc[2].split('/').map(encodeURIComponent).join('/')}`;
  return null;
}

async function exportHtml() {
  const doc = preview.contentDocument;
  const previews = doc?.querySelectorAll('.markdown-preview:not(.hidden-preview)');
  if (!previews?.length) return;
  try {
    const content = previews[previews.length - 1].cloneNode(true);
    for (const image of content.querySelectorAll('img[src]')) {
      const source = new URL(image.getAttribute('src'), doc.baseURI);
      if (source.origin === origin) image.setAttribute('src', await dataUrl(source.href));
    }
    for (const link of content.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href');
      if (!href || href.startsWith('#')) continue;
      const source = new URL(href, doc.baseURI);
      let path = null;
      if (source.origin === origin && source.pathname === '/local') path = source.searchParams.get('path');
      else if (source.protocol === 'file:') path = decodeURIComponent(source.pathname);
      const fileUri = path && exportedFileUri(path);
      if (fileUri) link.setAttribute('href', fileUri + source.hash);
    }
    const styles = [];
    for (const link of doc.querySelectorAll('link[rel="stylesheet"]')) {
      const source = new URL(link.href, doc.baseURI);
      if (source.origin !== origin) continue;
      const response = await fetch(source);
      if (response.ok) styles.push(await inlineCss(await response.text(), source));
    }
    for (const style of doc.querySelectorAll('head style')) styles.push(style.textContent || '');
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Markdown Preview</title><style>${styles.join('\n').replace(/<\/style/gi, '<\\/style')}</style></head><body>${content.outerHTML}</body></html>`;
    nativeSend(`savehtml\n${html}`);
  } catch (error) {
    alert(`HTML export failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function exportPdf() {
  if (pdfExportInProgress || !childReady || !preview.contentDocument) return;
  pdfExportInProgress = true;
  const height = Math.max(preview.contentDocument.documentElement.scrollHeight, preview.contentDocument.body.scrollHeight);
  preview.style.height = `${height}px`;
  setTimeout(() => nativeSend('exportpdf'), 100);
}

function previewBackgroundChannels(content) {
  // The preview's own background is often transparent while its ancestors
  // supply the visible theme. JPEG otherwise flattens that transparency to
  // black, making the default dark text unreadable.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = getComputedStyle(document.body).backgroundColor;
  context.fillRect(0, 0, 1, 1);
  const layers = [];
  for (let element = content; element; element = element.parentElement) {
    layers.push(preview.contentWindow.getComputedStyle(element).backgroundColor);
  }
  for (const color of layers.reverse()) {
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
  }
  return context.getImageData(0, 0, 1, 1).data;
}

function previewBackground(content) {
  const [r, g, b] = previewBackgroundChannels(content);
  return `rgb(${r}, ${g}, ${b})`;
}

function updateScrollbarTheme(content) {
  // A theme can leave body transparent (for example, "None" and "VS Code").
  // Resolve the actual background instead of relying on Crossnote's body-only
  // light/dark detection, which misclassifies transparent backgrounds.
  const [r, g, b] = previewBackgroundChannels(content);
  const theme = .299 * r + .587 * g + .114 * b < 128 ? 'dark' : 'light';
  const root = content.ownerDocument.documentElement;
  if (root.dataset.previewScrollbarTheme !== theme) root.dataset.previewScrollbarTheme = theme;
  if (document.body.dataset.previewTone !== theme) document.body.dataset.previewTone = theme;
}

async function exportImage(format) {
  const content = preview.contentDocument?.querySelector('.markdown-preview[data-for="preview"]');
  if (!content) return;
  try {
    const options = { backgroundColor: previewBackground(content) };
    const image = format === 'jpeg' ? await toJpeg(content, { ...options, quality: 0.95 }) : await toPng(content, options);
    nativeSend(`saveimage\t${format}\n${image.slice(image.indexOf(',') + 1)}`);
  } catch (error) {
    alert(`Image export failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const online = document.getElementById('online');
toolbar.addEventListener('wheel', (event) => {
  if (event.ctrlKey || event.metaKey || !preview.contentWindow || !childReady) return;
  const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? preview.clientHeight : 1;
  event.preventDefault();
  preview.contentWindow.scrollBy({ left: event.deltaX * factor, top: event.deltaY * factor, behavior: 'auto' });
}, { passive: false });
function updateOnlineButton() { online.setAttribute('aria-pressed', localStorage.getItem('markdownPreview.online') === '1' ? 'true' : 'false'); }
updateOnlineButton();
online.addEventListener('click', () => {
  localStorage.setItem('markdownPreview.online', localStorage.getItem('markdownPreview.online') === '1' ? '0' : '1');
  updateOnlineButton();
  refreshCurrent();
});
let refreshAnimation = null;
document.getElementById('refresh').addEventListener('click', (event) => {
  refreshAnimation?.cancel();
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    refreshAnimation = event.currentTarget.querySelector('svg').animate(
      [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
      { duration: 550, easing: 'ease-in-out' },
    );
  }
  refreshCurrent(true);
});
document.getElementById('export-html').addEventListener('click', () => void exportHtml());
document.getElementById('export-pdf').addEventListener('click', exportPdf);
document.getElementById('export-png').addEventListener('click', () => void exportImage('png'));
document.getElementById('export-jpeg').addEventListener('click', () => void exportImage('jpeg'));
// This entry point also enables a browser-only integration harness.
window.MarkdownPreviewHost = { receiveNative, setDocument };
nativeSend('ready');
