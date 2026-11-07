# Markdown Preview for EmEditor

English | [简体中文](README_ZH.md)

An EmEditor Markdown sidebar plugin that uses WebView2. Its rendering core is [Crossnote](https://github.com/shd101wyy/crossnote), which is also used by [Markdown Preview Enhanced](https://github.com/shd101wyy/vscode-markdown-preview-enhanced). Node.js is not required to run the plugin.

## Installation and Usage

1. Make sure [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) is installed; use the DLL that matches your EmEditor architecture.
2. Place `MarkdownPreview.dll` in EmEditor’s `PlugIns` folder, for example, `%LOCALAPPDATA%\Programs\EmEditor\PlugIns`. You can also add the DLL in EmEditor under “Tools → Plug-ins → Customize Plug-ins.”
3. Open a Markdown document and launch **Markdown Preview** from the plug-in menu or plug-in toolbar; run it again to close the preview.

The sidebar’s floating toolbar provides buttons to refresh and export to HTML, PDF, PNG, and JPEG. It automatically collapses when you scroll down and reappears when you scroll up or return to the top. Right-click in the preview to select a theme and access other upstream menu features. Standard Markdown, KaTeX, Mermaid, Graphviz, WaveDrom, and Vega-Lite use local rendering resources.

Checking tasks in the preview modifies the current document. If the editor has a whole-line, column, or multiple selection, clear the selection first. Local file links in exported HTML use absolute `file:` paths and may need to be adjusted after moving the file to another computer.

The **Online** button controls the online scripts required by TikZ and Mermaid ZenUML and is off by default. Remote images in documents, web fonts used by some themes, and user-configured online resources may still trigger network requests. The preview can only read local files in the current file’s directory and its subdirectories; a new, unsaved document has no directory to use for relative paths. Code block execution and preview scripts are currently disabled; the `.crossnote/parser.js` parser extension is run by Crossnote in a QuickJS sandbox.

By default, PlantUML is rendered through the online service [Kroki](https://kroki.io/). Diagram text is sent to the service, so an internet connection is required regardless of the state of the **Online** button. You can specify another service by creating `.crossnote/config.js` in the document directory, for example, `({ plantumlServer: 'https://example.com/plantuml/svg' })`, replacing the URL with the actual address. The service must accept plain-text POST requests and allow cross-origin browser access.

The limit is 32 MiB for the in-memory preview of a single document and for each imported file. Document size is calculated based on its UTF-16 size in memory.

## Building from Source

You need Windows, Visual Studio with C++ tools, CMake 3.22 or later, and Node.js 20 or later. CMake downloads and verifies a pinned version of the WebView2 SDK during configuration; build dependencies are installed using the lockfile. Run the following commands from the repository root:

```powershell
npm ci --ignore-scripts
npm run build:assets
cmake -S . -B build-x64 -A x64
cmake --build build-x64 --config Release
cmake -S . -B build-x86 -A Win32
cmake --build build-x86 --config Release
```

The resulting files are `build-x64/Release/MarkdownPreview.dll` and `build-x86/Release/MarkdownPreview.dll`, respectively. If you have already downloaded and extracted the SDK, you can specify `-DWEBVIEW2_SDK_DIR=<SDK目录>` when configuring CMake.

To run the browser integration tests, first build the assets, then set the path to your local Chrome or Chromium installation:

```powershell
npm run build:assets
$env:MARKDOWN_PREVIEW_CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm test
```

## License

New code in this project is licensed under the [MIT License](LICENSE). Crossnote, the EmEditor SDK, the WebView2 Loader, and other third-party components are subject to their respective licenses; see [NOTICE](NOTICE) and [third_party](third_party/README.md) for details. `THIRD-PARTY-NOTICES.txt` in the build output contains third-party license notices and is also distributed as a separate file with GitHub releases.