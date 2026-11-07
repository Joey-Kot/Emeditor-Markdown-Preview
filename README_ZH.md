# Markdown Preview for EmEditor

[English](README.md) | 简体中文

一个使用 WebView2 的 EmEditor Markdown 侧栏插件。渲染核心采用 [Crossnote](https://github.com/shd101wyy/crossnote)，它也是 [Markdown Preview Enhanced](https://github.com/shd101wyy/vscode-markdown-preview-enhanced) 使用的核心。运行插件时不需要安装 Node.js。

## 安装和使用

1. 确保安装了 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)；请使用与 EmEditor 位数一致的 DLL。
2. 将 `MarkdownPreview.dll` 放到 EmEditor 的 `PlugIns` 文件夹，例如 `%LOCALAPPDATA%\Programs\EmEditor\PlugIns`。也可以在 EmEditor 的“工具 → 插件 → 自定义插件”中添加 DLL。
3. 打开 Markdown 文档，从插件菜单或插件工具栏启动 **Markdown Preview**；再次运行可关闭预览。

侧栏的悬浮工具栏提供刷新、HTML、PDF、PNG、JPEG 导出按钮；向下滚动时自动收起，向上滚动或返回顶部时重新显示。预览内右键可选择主题和其他上游菜单功能。普通 Markdown、KaTeX、Mermaid、Graphviz、WaveDrom 和 Vega-Lite 使用本地渲染资源。

在预览中勾选任务会修改当前文档；如编辑器处于整行、列或多重选择状态，需要先清除该选择。导出 HTML 中的本地文件链接使用绝对 `file:` 路径，移动到其他电脑后可能需要调整。

**Online** 按钮控制 TikZ 和 Mermaid ZenUML 所需的在线脚本，默认关闭。文档中的网络图片、部分主题的网络字体和用户配置的网络资源仍可能发起请求。预览只能读取当前文件所在目录及其子目录中的本地文件；未保存的新文档没有可用于相对路径的目录。代码块执行和预览脚本当前关闭；`.crossnote/parser.js` 解析扩展由 Crossnote 在 QuickJS 沙箱中运行。

PlantUML 默认通过在线服务 [Kroki](https://kroki.io/) 渲染，图表文本会发送给该服务，需要联网，与 **Online** 按钮的状态无关。也可以在文档目录创建 `.crossnote/config.js` 指定其他服务，例如 `({ plantumlServer: 'https://example.com/plantuml/svg' })` 并替换为实际地址；该服务需要接受纯文本 POST 请求并允许浏览器跨域访问。

单个文档的内存预览和单个导入文件上限均为 32 MiB；文档大小按 UTF-16 内存大小计算。

## 自行构建

需要 Windows、带 C++ 工具的 Visual Studio、CMake 3.22 及以上版本和 Node.js 20 或以上版本。CMake 配置时下载并校验固定版本的 WebView2 SDK；构建依赖通过锁文件安装。以下命令在仓库根目录运行：

```powershell
npm ci --ignore-scripts
npm run build:assets
cmake -S . -B build-x64 -A x64
cmake --build build-x64 --config Release
cmake -S . -B build-x86 -A Win32
cmake --build build-x86 --config Release
```

产物分别为 `build-x64/Release/MarkdownPreview.dll` 和 `build-x86/Release/MarkdownPreview.dll`。如已下载并解压 SDK，可在 CMake 配置时指定 `-DWEBVIEW2_SDK_DIR=<SDK目录>`。

运行浏览器集成测试时，先构建资源，再设置本机 Chrome 或 Chromium 路径：

```powershell
npm run build:assets
$env:MARKDOWN_PREVIEW_CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm test
```

## 许可

本项目新增代码采用 [MIT License](LICENSE)。Crossnote、EmEditor SDK、WebView2 Loader 及其他第三方组件分别遵循各自的许可，详见 [NOTICE](NOTICE) 和 [third_party](third_party/README.md)。构建产物中的 `THIRD-PARTY-NOTICES.txt` 包含第三方许可声明，也会作为独立文件随 GitHub 发布。
