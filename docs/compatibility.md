# 功能状态 / Feature status

本项目与 Markdown Preview Enhanced 共用 Crossnote 渲染核心，但预览界面中有些操作依赖 VS Code 或外部工具，还需要分别适配 EmEditor。

| 功能 | 当前状态 |
| --- | --- |
| Markdown、表格、代码高亮、未保存内容实时更新 | 已接入；浏览器测试覆盖基本 Markdown、更新和文档切换 |
| KaTeX 公式、Mermaid、Graphviz、WaveDrom、Vega-Lite | 已接入；浏览器测试覆盖各一种示例 |
| 文档目录内的图片、Markdown `@import` | 已接入；浏览器测试覆盖 PNG 与 Markdown 导入。父目录和其他目录目前受限 |
| PlantUML | 默认通过 Kroki 在线渲染，也可通过 `.crossnote/config.js` 指定服务；浏览器测试覆盖默认服务和自定义服务的请求。图表内容会发送给服务，服务需允许浏览器跨域请求；本地 Java / jar 模式尚未接入 |
| Reveal.js 演示文稿 | 已接入；浏览器测试覆盖由普通文档切换到演示模式及两张幻灯片 |
| 主题、目录和预览界面 | 使用上游界面；预览、代码块和演示主题选择已接入。部分上游菜单尚未适配 |
| 文档与预览同步滚动、任务列表勾选 | 原生消息已接入；滚动不移动光标，任务勾选会保护整行、列及多重选择。浏览器测试覆盖任务勾选消息 |
| HTML、PNG、JPEG 导出 | 浏览器测试覆盖生成 HTML 和图片数据。HTML 内嵌本地样式和图片，复杂资源仍需验证 |
| PDF 导出 | 已调用 WebView2 PDF 接口，浏览器测试覆盖导出请求 |
| TikZ、Mermaid ZenUML | 可手动开启在线资源；实际渲染尚未验证，需要网络 |
| 其他图表类型 | 部分上游渲染资源已包含；尚未完成兼容性验证 |
| D2、Pandoc、Prince、电子书导出 | 尚未完成原生工具对接 |
| 可执行代码块、预览脚本 | 尚未接入；当前关闭。Crossnote 的 `.crossnote/parser.js` 扩展钩子仍会在其 QuickJS 沙箱中运行，尚未完成兼容性验证 |
| 预览内编辑回写、图片上传、翻译、知识图谱、独立 Wiki、部分菜单命令 | 尚未接入 |
