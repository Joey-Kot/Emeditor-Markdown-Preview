# Third-party components

- [Crossnote 0.9.42](https://github.com/shd101wyy/crossnote), the rendering engine used by [Markdown Preview Enhanced](https://github.com/shd101wyy/vscode-markdown-preview-enhanced): University of Illinois/NCSA Open Source License. The build adapts its prebuilt JavaScript for browser rendering and removes unsupported preview controls. The patches are guarded against upstream bundle changes in `scripts/build-assets.mjs`.
- EmEditor plug-in header: see [emeditor-sdk/UPSTREAM.md](emeditor-sdk/UPSTREAM.md) and [emeditor-sdk/LICENSE](emeditor-sdk/LICENSE).
- Microsoft WebView2 SDK and native loader 1.0.3537.50: [Microsoft Software License Terms](WEBVIEW2_LICENSE.txt). The WebView2 Runtime is installed separately.
- `html-to-image` 1.11.13: MIT, installed from the pinned npm lockfile.
- Crossnote's vendored browser assets include Font Awesome Free 6.4.2, WaveDrom 3.3.0, Reveal.js 4.6.0, Vega 5.25.0, Vega-Lite 5.16.1 and Vega-Embed 6.23.0. Their license texts are in [vendor-licenses](vendor-licenses/). Crossnote also bundles fonts with their own license files, including Source Sans Pro.

At build time, the license texts above and the license files from installed npm packages are embedded in the DLL and written to `build/assets/THIRD-PARTY-NOTICES.txt`. GitHub releases also include the notices as a separate file. See `package-lock.json` for the exact npm dependency versions and Crossnote's `out/dependencies/README.md` for its vendored browser assets.
