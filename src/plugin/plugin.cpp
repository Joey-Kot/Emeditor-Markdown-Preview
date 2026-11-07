#include <windows.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <shellapi.h>
#include <commdlg.h>
#include <wincrypt.h>
#include <WebView2.h>

#define EE_STRICT
#include "plugin.h"
#include "deferred_actions.h"
#include "task_marker.h"

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <cwchar>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace {
constexpr wchar_t kClassName[] = L"EmEditorMarkdownPreviewWindow";
constexpr wchar_t kOrigin[] = L"https://markdown-preview.local/";
constexpr UINT_PTR kRefreshTimer = 1;
constexpr UINT kDispatchAction = WM_APP + 42;
constexpr size_t kMaxReadBytes = 32u * 1024u * 1024u;
HINSTANCE g_instance = nullptr;
HMODULE g_loader = nullptr;
CRITICAL_SECTION g_lock;

struct Lock {
  explicit Lock(CRITICAL_SECTION& lock) : lock_(lock) { EnterCriticalSection(&lock_); }
  ~Lock() { LeaveCriticalSection(&lock_); }
  CRITICAL_SECTION& lock_;
};

template <typename T> void release(T*& value) {
  if (value) { value->Release(); value = nullptr; }
}

std::wstring utf8ToWide(const std::string& text) {
  if (text.empty()) return {};
  int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                                 static_cast<int>(text.size()), nullptr, 0);
  if (!size) return {};
  std::wstring result(static_cast<size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                      static_cast<int>(text.size()), result.data(), size);
  return result;
}

std::string wideToUtf8(const std::wstring& text) {
  if (text.empty()) return {};
  int size = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                                 nullptr, 0, nullptr, nullptr);
  if (!size) return {};
  std::string result(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                      result.data(), size, nullptr, nullptr);
  return result;
}

int hexValue(wchar_t value) {
  if (value >= L'0' && value <= L'9') return value - L'0';
  if (value >= L'a' && value <= L'f') return value - L'a' + 10;
  if (value >= L'A' && value <= L'F') return value - L'A' + 10;
  return -1;
}

std::wstring percentDecode(const std::wstring& encoded) {
  std::string bytes;
  for (size_t i = 0; i < encoded.size(); ++i) {
    if (encoded[i] == L'%' && i + 2 < encoded.size()) {
      const int a = hexValue(encoded[i + 1]);
      const int b = hexValue(encoded[i + 2]);
      if (a < 0 || b < 0) return {};
      bytes.push_back(static_cast<char>((a << 4) | b));
      i += 2;
    } else if (encoded[i] <= 127) {
      bytes.push_back(static_cast<char>(encoded[i]));
    } else {
      bytes += wideToUtf8(std::wstring(1, encoded[i]));
    }
  }
  return utf8ToWide(bytes);
}

std::wstring percentEncode(const std::wstring& text) {
  constexpr wchar_t hex[] = L"0123456789ABCDEF";
  std::wstring out;
  for (unsigned char c : wideToUtf8(text)) {
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
        (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') {
      out.push_back(static_cast<wchar_t>(c));
    } else {
      out.push_back(L'%'); out.push_back(hex[c >> 4]); out.push_back(hex[c & 15]);
    }
  }
  return out;
}

std::vector<std::wstring> split(const std::wstring& text, wchar_t separator) {
  std::vector<std::wstring> fields;
  size_t start = 0;
  for (;;) {
    const size_t next = text.find(separator, start);
    fields.push_back(text.substr(start, next == std::wstring::npos ? next : next - start));
    if (next == std::wstring::npos) break;
    start = next + 1;
  }
  return fields;
}

struct Bytes { const BYTE* data = nullptr; size_t size = 0; };

Bytes resourceBytes(int id) {
  HRSRC resource = FindResourceW(g_instance, MAKEINTRESOURCEW(id), RT_RCDATA);
  if (!resource) return {};
  HGLOBAL loaded = LoadResource(g_instance, resource);
  return {static_cast<const BYTE*>(LockResource(loaded)), SizeofResource(g_instance, resource)};
}

uint16_t read16(const BYTE* p) { return static_cast<uint16_t>(p[0] | (p[1] << 8)); }
uint32_t read32(const BYTE* p) {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

Bytes findAsset(const std::string& name) {
  const Bytes pack = resourceBytes(101);
  if (!pack.data || pack.size < 8 || std::memcmp(pack.data, "MPAK", 4) != 0) return {};
  const uint32_t count = read32(pack.data + 4);
  size_t offset = 8;
  for (uint32_t i = 0; i < count; ++i) {
    if (offset + 6 > pack.size) return {};
    const size_t keySize = read16(pack.data + offset);
    const size_t dataSize = read32(pack.data + offset + 2);
    offset += 6;
    if (keySize > pack.size - offset || dataSize > pack.size - offset - keySize) return {};
    if (keySize == name.size() && std::memcmp(pack.data + offset, name.data(), keySize) == 0)
      return {pack.data + offset + keySize, dataSize};
    offset += keySize + dataSize;
  }
  return {};
}

std::wstring mimeType(const std::wstring& path) {
  const size_t dot = path.find_last_of(L'.');
  std::wstring ext = dot == std::wstring::npos ? L"" : path.substr(dot);
  std::transform(ext.begin(), ext.end(), ext.begin(), towlower);
  if (ext == L".html") return L"text/html; charset=utf-8";
  if (ext == L".js" || ext == L".mjs") return L"text/javascript; charset=utf-8";
  if (ext == L".css") return L"text/css; charset=utf-8";
  if (ext == L".svg") return L"image/svg+xml";
  if (ext == L".png") return L"image/png";
  if (ext == L".jpg" || ext == L".jpeg") return L"image/jpeg";
  if (ext == L".gif") return L"image/gif";
  if (ext == L".webp") return L"image/webp";
  if (ext == L".woff") return L"font/woff";
  if (ext == L".woff2") return L"font/woff2";
  if (ext == L".ttf") return L"font/ttf";
  if (ext == L".json") return L"application/json; charset=utf-8";
  if (ext == L".wasm") return L"application/wasm";
  return L"application/octet-stream";
}

std::wstring localAppDirectory() {
  wchar_t path[MAX_PATH] = {};
  if (FAILED(SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA, nullptr, SHGFP_TYPE_CURRENT, path))) return {};
  std::wstring root = std::wstring(path) + L"\\MarkdownPreview";
  if (!CreateDirectoryW(root.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) return {};
  return root;
}

bool sameFileContents(const std::wstring& path, Bytes expected) {
  HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                            FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  LARGE_INTEGER size{};
  bool same = GetFileSizeEx(file, &size) && size.QuadPart == static_cast<LONGLONG>(expected.size);
  std::vector<BYTE> data(same ? expected.size : 0);
  DWORD read = 0;
  if (same) same = ReadFile(file, data.data(), static_cast<DWORD>(data.size()), &read, nullptr) &&
                   read == data.size() && std::memcmp(data.data(), expected.data, data.size()) == 0;
  CloseHandle(file);
  return same;
}

HMODULE loadWebViewLoader() {
  Lock lock(g_lock);
  if (g_loader) return g_loader;
  const Bytes loader = resourceBytes(102);
  const std::wstring directory = localAppDirectory();
  if (!loader.data || loader.size > MAXDWORD || directory.empty()) return nullptr;
#ifdef _WIN64
  const std::wstring target = directory + L"\\WebView2Loader-1.0.3537.50-x64.dll";
#else
  const std::wstring target = directory + L"\\WebView2Loader-1.0.3537.50-x86.dll";
#endif
  if (!sameFileContents(target, loader)) {
    const std::wstring temp = target + L"." + std::to_wstring(GetCurrentProcessId()) + L".tmp";
    HANDLE file = CreateFileW(temp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                              FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return nullptr;
    DWORD written = 0;
    const bool ok = WriteFile(file, loader.data, static_cast<DWORD>(loader.size), &written, nullptr) &&
                    written == loader.size;
    CloseHandle(file);
    if (!ok || !MoveFileExW(temp.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
      DeleteFileW(temp.c_str());
      if (!sameFileContents(target, loader)) return nullptr;
    }
  }
  g_loader = LoadLibraryExW(target.c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
  return g_loader;
}

template <class Interface, class... Args>
class Callback final : public Interface {
 public:
  Callback(const IID& iid, std::function<HRESULT(Args...)> fn) : iid_(iid), fn_(std::move(fn)) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** output) override {
    if (!output) return E_POINTER;
    *output = nullptr;
    if (IsEqualIID(iid, IID_IUnknown) || IsEqualIID(iid, iid_)) {
      *output = static_cast<Interface*>(this); AddRef(); return S_OK;
    }
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs_; }
  ULONG STDMETHODCALLTYPE Release() override { const ULONG count = --refs_; if (!count) delete this; return count; }
  HRESULT STDMETHODCALLTYPE Invoke(Args... args) override { return fn_(args...); }
 private:
  std::atomic<ULONG> refs_{1};
  const IID& iid_;
  std::function<HRESULT(Args...)> fn_;
};

std::wstring finalHandlePath(HANDLE file) {
  const DWORD size = GetFinalPathNameByHandleW(file, nullptr, 0, FILE_NAME_NORMALIZED);
  std::wstring result(size, L'\0');
  const DWORD used = size ? GetFinalPathNameByHandleW(file, result.data(), size, FILE_NAME_NORMALIZED) : 0;
  if (!used || used >= size) return {};
  result.resize(used);
  return result;
}

std::wstring finalPath(const std::wstring& path, bool directory) {
  const DWORD flags = directory ? FILE_FLAG_BACKUP_SEMANTICS : FILE_ATTRIBUTE_NORMAL;
  HANDLE file = CreateFileW(path.c_str(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            nullptr, OPEN_EXISTING, flags, nullptr);
  if (file == INVALID_HANDLE_VALUE) return {};
  const std::wstring result = finalHandlePath(file);
  CloseHandle(file);
  return result;
}

struct Frame : std::enable_shared_from_this<Frame> {
  enum class ActionKind { WebMessage, PdfError };
  struct Action { ActionKind kind; std::wstring text; };

  HWND editor = nullptr;
  HWND frame = nullptr;
  HWND client = nullptr;
  UINT barId = 0;
  bool initializedCom = false;
  ICoreWebView2Environment* environment = nullptr;
  ICoreWebView2Controller* controller = nullptr;
  ICoreWebView2* webview = nullptr;
  EventRegistrationToken resourceToken{};
  EventRegistrationToken messageToken{};
  bool resourceRegistered = false;
  bool messageRegistered = false;
  std::wstring root;
  std::wstring rootFinal;
  std::wstring status = L"Loading Markdown Preview…";
  bool failed = false;
  uint64_t viewGeneration = 0;
  uint64_t documentRevision = 1;
  DeferredActions<Action> actions;

  ~Frame() { shutdown(); }
  void shutdown() {
    ++viewGeneration;
    actions.clear();
    if (webview && resourceRegistered) webview->remove_WebResourceRequested(resourceToken);
    if (webview && messageRegistered) webview->remove_WebMessageReceived(messageToken);
    resourceRegistered = messageRegistered = false;
    if (controller) controller->Close();
    release(webview); release(controller); release(environment);
    if (initializedCom) { CoUninitialize(); initializedCom = false; }
  }
  void detach() {
    if (barId && editor && IsWindow(editor)) {
      const UINT id = barId;
      barId = 0;
      Editor_CustomBarClose(editor, id);
    }
    // EmEditor normally destroys the client when closing the custom bar.
    // If it did not, close the window on its owning thread before unloading.
    if (client && IsWindow(client)) SendMessageW(client, WM_CLOSE, 0, 0);
    if (client && IsWindow(client)) {
      SetWindowLongPtrW(client, GWLP_USERDATA, 0);
      client = nullptr;
    }
    shutdown();
  }
  void fail(const std::wstring& text) {
    status = text;
    failed = true;
    if (controller) controller->put_IsVisible(FALSE);
    if (client && IsWindow(client)) InvalidateRect(client, nullptr, TRUE);
  }
  void post(const std::wstring& text) {
    if (webview) webview->PostWebMessageAsString(text.c_str());
  }
  // Editor commands and save dialogs can run nested message loops. Dispatch
  // them after the WebView2 callback returns, and serialize modal actions.
  void enqueueAction(ActionKind kind, std::wstring text = {}) {
    if (!client || !IsWindow(client)) return;
    if (!actions.enqueue(Action{kind, std::move(text)}, [this] {
      return PostMessageW(client, kDispatchAction, 0, 0) != FALSE;
    })) post(L"printdone");
  }
  void dispatchActions() {
    actions.dispatch([this] { return client && IsWindow(client); }, [this](Action action) {
      if (action.kind == ActionKind::PdfError)
        MessageBoxW(client, L"Could not export the PDF.", L"Markdown Preview", MB_OK | MB_ICONERROR);
      else
        onMessage(action.text);
    });
  }
  std::wstring activeDocumentId() const {
    const auto doc = static_cast<uintptr_t>(Editor_Info(editor, EI_GET_ACTIVE_DOC, 0));
    return std::to_wstring(doc);
  }
  std::wstring fileName() const {
    std::vector<wchar_t> buffer(32768, L'\0');
    STRING_BUF info{buffer.data(), static_cast<UINT>(buffer.size())};
    Editor_Info(editor, EI_GET_FILE_NAME_EX, reinterpret_cast<LPARAM>(&info));
    return buffer.data();
  }
  std::wstring lineAt(UINT_PTR line, bool withNewline, bool* tooLong = nullptr) const {
    GET_LINE_INFO info{};
    info.yLine = line;
    info.flags = FLAG_LOGICAL | (withNewline ? FLAG_WITH_CRLF : 0);
    const UINT_PTR size = Editor_GetLineW(editor, &info, nullptr);
    if (!size) return {};
    if (size > kMaxReadBytes / sizeof(wchar_t)) {
      if (tooLong) *tooLong = true;
      return {};
    }
    std::vector<wchar_t> buffer(static_cast<size_t>(size) + 1, L'\0');
    info.cch = static_cast<UINT_PTR>(buffer.size());
    Editor_GetLineW(editor, &info, buffer.data());
    return buffer.data();
  }
  void sendDocument() {
    if (!editor || !IsWindow(editor) || !webview) return;
    const std::wstring path = fileName();
    const size_t slash = path.find_last_of(L"\\/");
    root = slash == std::wstring::npos ? L"" : path.substr(0, slash);
    if (slash == 2 && path.size() > 2 && path[1] == L':') root += L'\\';
    rootFinal = root.empty() ? L"" : finalPath(root, true);
    const UINT_PTR lines = Editor_GetLines(editor, POS_LOGICAL_W);
    std::wstring text;
    for (UINT_PTR i = 0; i < lines; ++i) {
      bool tooLong = false;
      const std::wstring line = lineAt(i, true, &tooLong);
      if (tooLong || line.size() > kMaxReadBytes / sizeof(wchar_t) - text.size()) {
        post(L"error\nThe document is too large for live preview (32 MiB limit).");
        return;
      }
      text += line;
    }
    post(L"document\t" + activeDocumentId() + L"\t" + std::to_wstring(documentRevision) + L"\t" + percentEncode(path) + L"\n" + text);
  }
  void sendScroll() {
    if (!editor || !webview) return;
    POINT_PTR view{};
    POINT_PTR logical{};
    Editor_GetScrollPos(editor, &view);
    view.x = 0;
    Editor_ViewToLogical(editor, &view, &logical);
    post(L"scroll\t" + std::to_wstring(logical.y));
  }
  void revealLine(UINT_PTR line) {
    if (line >= Editor_GetLines(editor, POS_LOGICAL_W)) return;
    POINT_PTR logical{0, static_cast<INT_PTR>(line)};
    POINT_PTR view{}, scroll{};
    SIZE_PTR page{};
    Editor_LogicalToView(editor, &logical, &view);
    Editor_GetScrollPos(editor, &scroll);
    Editor_GetPageSize(editor, &page);
    scroll.y = std::max<INT_PTR>(0, view.y - std::max<INT_PTR>(0, page.cy) / 2);
    // Scrolling the preview is not an editing command: preserve the caret and
    // selection, including when EmEditor's move-cursor-on-scroll option is on.
    Editor_SetScrollPos(editor, &scroll);
  }
  bool withinRoot(const std::wstring& resolved) const {
    if (rootFinal.empty() || resolved.empty()) return false;
    const size_t n = rootFinal.size();
    return resolved.size() >= n && _wcsnicmp(resolved.c_str(), rootFinal.c_str(), n) == 0 &&
           (resolved.size() == n || rootFinal.back() == L'\\' || resolved[n] == L'\\');
  }
  bool permittedPath(std::wstring path, std::wstring& result) const {
    if (root.empty() || rootFinal.empty() || path.empty()) return false;
    std::replace(path.begin(), path.end(), L'/', L'\\');
    const std::wstring drivePrefix = L"\\__drive__\\";
    const std::wstring uncPrefix = L"\\__unc__\\";
    if (path.rfind(drivePrefix, 0) == 0 && path.size() > drivePrefix.size() + 1 && path[drivePrefix.size() + 1] == L'\\')
      path = path.substr(drivePrefix.size(), 1) + L":" + path.substr(drivePrefix.size() + 1);
    else if (path.rfind(uncPrefix, 0) == 0)
      path = L"\\\\" + path.substr(uncPrefix.size());
    // vscode-uri uses /C:/... in a browser even when the underlying file is on Windows.
    if (path.size() > 3 && path[0] == L'\\' && path[2] == L':') path.erase(0, 1);
    if (PathIsRelativeW(path.c_str())) path = root + L"\\" + path;
    const DWORD attributes = GetFileAttributesW(path.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) return false;
    const bool isDirectory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    const std::wstring resolved = finalPath(path, isDirectory);
    if (resolved.empty()) return false;
    if (!withinRoot(resolved)) return false;
    result = path;
    return true;
  }
  bool readFile(const std::wstring& path, std::vector<BYTE>& data) const {
    std::wstring allowed;
    if (!permittedPath(path, allowed)) return false;
    HANDLE file = CreateFileW(allowed.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    LARGE_INTEGER size{};
    bool ok = withinRoot(finalHandlePath(file)) && GetFileSizeEx(file, &size) && size.QuadPart >= 0 &&
              size.QuadPart <= static_cast<LONGLONG>(kMaxReadBytes);
    if (ok) {
      data.resize(static_cast<size_t>(size.QuadPart));
      DWORD read = 0;
      ok = data.empty() || (ReadFile(file, data.data(), static_cast<DWORD>(data.size()), &read, nullptr) && read == data.size());
    }
    CloseHandle(file);
    return ok;
  }
  std::wstring decodeText(const std::vector<BYTE>& data) const {
    if (data.empty()) return {};
    if (data.size() >= 2 && data[0] == 0xff && data[1] == 0xfe) {
      std::wstring text;
      for (size_t i = 2; i + 1 < data.size(); i += 2) text.push_back(static_cast<wchar_t>(data[i] | (data[i + 1] << 8)));
      return text;
    }
    if (data.size() >= 2 && data[0] == 0xfe && data[1] == 0xff) {
      std::wstring text;
      for (size_t i = 2; i + 1 < data.size(); i += 2) text.push_back(static_cast<wchar_t>((data[i] << 8) | data[i + 1]));
      return text;
    }
    size_t start = data.size() >= 3 && data[0] == 0xef && data[1] == 0xbb && data[2] == 0xbf ? 3 : 0;
    const std::string bytes(reinterpret_cast<const char*>(data.data() + start), data.size() - start);
    std::wstring text = utf8ToWide(bytes);
    if (!text.empty() || bytes.empty()) return text;
    const int size = MultiByteToWideChar(CP_ACP, 0, bytes.data(), static_cast<int>(bytes.size()), nullptr, 0);
    if (!size) return {};
    text.resize(static_cast<size_t>(size));
    MultiByteToWideChar(CP_ACP, 0, bytes.data(), static_cast<int>(bytes.size()), text.data(), size);
    return text;
  }
  void fsRequest(const std::vector<std::wstring>& fields) {
    if (fields.size() < 4) return;
    const std::wstring path = percentDecode(fields[3]);
    const std::wstring prefix = L"fs\t" + fields[1] + L"\t";
    std::wstring allowed;
    if (fields[2] == L"exists") {
      post(prefix + L"ok\n" + (permittedPath(path, allowed) ? L"1" : L"0"));
    } else if (fields[2] == L"read") {
      std::vector<BYTE> data;
      if (readFile(path, data)) post(prefix + L"ok\n" + decodeText(data));
      else post(prefix + L"error\nCannot read the requested file.");
    } else if (fields[2] == L"stat") {
      if (!permittedPath(path, allowed)) { post(prefix + L"error\nFile not found."); return; }
      WIN32_FILE_ATTRIBUTE_DATA info{};
      if (!GetFileAttributesExW(allowed.c_str(), GetFileExInfoStandard, &info)) {
        post(prefix + L"error\nCannot inspect the requested file."); return;
      }
      const ULONGLONG size = (static_cast<ULONGLONG>(info.nFileSizeHigh) << 32) | info.nFileSizeLow;
      const std::wstring type = (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ? L"symlink" :
                                ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? L"directory" : L"file");
      post(prefix + L"ok\n" + type + L"\t" + std::to_wstring(size) + L"\t0");
    } else if (fields[2] == L"readdir") {
      if (!permittedPath(path, allowed)) { post(prefix + L"error\nDirectory not found."); return; }
      WIN32_FIND_DATAW data{};
      HANDLE find = FindFirstFileW((allowed + L"\\*").c_str(), &data);
      std::wstring names;
      if (find != INVALID_HANDLE_VALUE) {
        do {
          if (wcscmp(data.cFileName, L".") && wcscmp(data.cFileName, L"..")) {
            if (!names.empty()) names += L'\n';
            names += data.cFileName;
          }
        } while (FindNextFileW(find, &data));
        FindClose(find);
      }
      post(prefix + L"ok\n" + names);
    }
  }
  void toggleTask(UINT_PTR line) {
    if (Editor_Info(editor, EI_GET_READ_ONLY, 0)) return;
    const int selection = Editor_GetSelTypeEx(editor, TRUE);
    const int selectionType = selection & SEL_TYPE_MASK;
    const UINT_PTR selectionCount = Editor_GetMultiSel(editor, static_cast<UINT_PTR>(-1), nullptr);
    if ((selection & SEL_TYPE_MULTI) || selectionCount > 1 ||
        (selectionType != SEL_TYPE_NONE && selectionType != SEL_TYPE_CHAR)) {
      MessageBoxW(client, L"Clear the line, column, or multiple selection before changing a task.", L"Markdown Preview", MB_OK | MB_ICONINFORMATION);
      return;
    }
    const std::wstring text = lineAt(line, false);
    const size_t at = taskMarkerPosition(text);
    if (at == std::wstring::npos) return;
    const wchar_t replacement = text[at] == L'x' || text[at] == L'X' ? L' ' : L'x';
    POINT_PTR original{}, anchor{};
    Editor_GetCaretPos(editor, POS_LOGICAL_W, &original);
    Editor_GetAnchorPos(editor, POS_LOGICAL_W, &anchor);
    POINT_PTR start{static_cast<INT_PTR>(at), static_cast<INT_PTR>(line)};
    POINT_PTR end{static_cast<INT_PTR>(at + 1), static_cast<INT_PTR>(line)};
    Editor_SetCaretPosEx(editor, POS_LOGICAL_W, &start, FALSE);
    Editor_SetCaretPosEx(editor, POS_LOGICAL_W, &end, TRUE);
    const wchar_t insert[] = {replacement, 0};
    Editor_InsertW(editor, insert);
    Editor_SetCaretPosEx(editor, POS_LOGICAL_W, &anchor, FALSE);
    Editor_SetCaretPosEx(editor, POS_LOGICAL_W, &original, TRUE);
  }
  std::wstring chooseOutput(const wchar_t* extension, const wchar_t* filter) const {
    wchar_t name[32768] = {};
    const std::wstring source = fileName();
    const wchar_t* base = source.empty() ? L"Markdown Preview" : PathFindFileNameW(source.c_str());
    wcsncpy_s(name, _countof(name), base, _TRUNCATE);
    PathRemoveExtensionW(name);
    wcscat_s(name, _countof(name), extension);
    OPENFILENAMEW dialog{};
    dialog.lStructSize = sizeof(dialog);
    dialog.hwndOwner = client;
    dialog.lpstrFilter = filter;
    dialog.lpstrFile = name;
    dialog.nMaxFile = _countof(name);
    dialog.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
    dialog.lpstrDefExt = extension + 1;
    return GetSaveFileNameW(&dialog) ? std::wstring(name) : std::wstring();
  }
  void saveHtml(const std::wstring& html) {
    const std::wstring path = chooseOutput(L".html", L"HTML files (*.html)\0*.html\0All files (*.*)\0*.*\0");
    if (path.empty()) return;
    const std::string bytes = wideToUtf8(html);
    HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
      MessageBoxW(client, L"Could not create the HTML file.", L"Markdown Preview", MB_OK | MB_ICONERROR); return;
    }
    DWORD written = 0;
    const bool ok = bytes.size() <= MAXDWORD && WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) && written == bytes.size();
    CloseHandle(file);
    if (!ok) MessageBoxW(client, L"Could not write the complete HTML file.", L"Markdown Preview", MB_OK | MB_ICONERROR);
  }
  void saveImage(const std::wstring& format, const std::wstring& encoded) {
    if ((format != L"png" && format != L"jpeg") || encoded.size() > 128u * 1024u * 1024u) return;
    DWORD size = 0;
    if (!CryptStringToBinaryW(encoded.c_str(), static_cast<DWORD>(encoded.size()),
                             CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, nullptr, &size, nullptr, nullptr) || !size) {
      MessageBoxW(client, L"Could not decode the exported image.", L"Markdown Preview", MB_OK | MB_ICONERROR); return;
    }
    std::vector<BYTE> data(size);
    if (!CryptStringToBinaryW(encoded.c_str(), static_cast<DWORD>(encoded.size()),
                             CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, data.data(), &size, nullptr, nullptr)) {
      MessageBoxW(client, L"Could not decode the exported image.", L"Markdown Preview", MB_OK | MB_ICONERROR); return;
    }
    const bool jpeg = format == L"jpeg";
    const std::wstring path = chooseOutput(jpeg ? L".jpg" : L".png",
      jpeg ? L"JPEG images (*.jpg)\0*.jpg\0All files (*.*)\0*.*\0" : L"PNG images (*.png)\0*.png\0All files (*.*)\0*.*\0");
    if (path.empty()) return;
    HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
      MessageBoxW(client, L"Could not create the image file.", L"Markdown Preview", MB_OK | MB_ICONERROR); return;
    }
    DWORD written = 0;
    const bool ok = WriteFile(file, data.data(), size, &written, nullptr) && written == size;
    CloseHandle(file);
    if (!ok) MessageBoxW(client, L"Could not write the complete image file.", L"Markdown Preview", MB_OK | MB_ICONERROR);
  }
  void exportPdf() {
    const std::wstring path = chooseOutput(L".pdf", L"PDF files (*.pdf)\0*.pdf\0All files (*.*)\0*.*\0");
    if (path.empty()) { post(L"printdone"); return; }
    ICoreWebView2_7* printer = nullptr;
    if (!webview || FAILED(webview->QueryInterface(IID_ICoreWebView2_7, reinterpret_cast<void**>(&printer))) || !printer) {
      MessageBoxW(client, L"This WebView2 Runtime does not support PDF export.", L"Markdown Preview", MB_OK | MB_ICONERROR);
      post(L"printdone"); return;
    }
    const auto weak = weak_from_this();
    const uint64_t generation = viewGeneration;
    using PrintHandler = Callback<ICoreWebView2PrintToPdfCompletedHandler, HRESULT, BOOL>;
    auto* handler = new PrintHandler(IID_ICoreWebView2PrintToPdfCompletedHandler,
      [weak, generation](HRESULT result, BOOL succeeded) -> HRESULT {
        if (auto frame = weak.lock()) {
          if (frame->viewGeneration != generation) return S_OK;
          frame->post(L"printdone");
          if (FAILED(result) || !succeeded) frame->enqueueAction(ActionKind::PdfError);
        }
        return S_OK;
      });
    const HRESULT hr = printer->PrintToPdf(path.c_str(), nullptr, handler);
    handler->Release(); release(printer);
    if (FAILED(hr)) { post(L"printdone"); MessageBoxW(client, L"Could not start PDF export.", L"Markdown Preview", MB_OK | MB_ICONERROR); }
  }
  void onMessage(const std::wstring& value) {
    if (value.rfind(L"savehtml\n", 0) == 0) { saveHtml(value.substr(9)); return; }
    if (value.rfind(L"saveimage\t", 0) == 0) {
      const size_t newline = value.find(L'\n', 10);
      if (newline != std::wstring::npos) saveImage(value.substr(10, newline - 10), value.substr(newline + 1));
      return;
    }
    const auto fields = split(value, L'\t');
    if (fields.empty()) return;
    if (fields[0] == L"ready") sendDocument();
    else if (fields[0] == L"exportpdf") exportPdf();
    else if (fields[0] == L"fs") fsRequest(fields);
    else if ((fields[0] == L"reveal" || fields[0] == L"task") && fields.size() >= 4 &&
             fields[2] == activeDocumentId() && fields[3] == std::to_wstring(documentRevision)) {
      wchar_t* end = nullptr;
      const unsigned long long parsed = wcstoull(fields[1].c_str(), &end, 10);
      if (!end || *end || parsed > static_cast<unsigned long long>(INTPTR_MAX)) return;
      if (fields[0] == L"task") toggleTask(static_cast<UINT_PTR>(parsed));
      else revealLine(static_cast<UINT_PTR>(parsed));
    } else if (fields[0] == L"open" && fields.size() >= 2) {
      const std::wstring url = percentDecode(fields[1]);
      if (url.rfind(L"https://", 0) == 0 || url.rfind(L"http://", 0) == 0 || url.rfind(L"mailto:", 0) == 0)
        ShellExecuteW(client, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    } else if (fields[0] == L"openfile" && fields.size() >= 2) {
      std::wstring path;
      if (permittedPath(percentDecode(fields[1]), path)) {
        Editor_LoadFileW(editor, static_cast<LOAD_FILE_INFO_EX*>(nullptr), path.c_str());
      }
    } else if (fields[0] == L"command" && fields.size() >= 2) {
      const std::wstring command = percentDecode(fields[1]);
      if (command == L"openCrossnote") ShellExecuteW(client, L"open", L"https://github.com/shd101wyy/crossnote", nullptr, nullptr, SW_SHOWNORMAL);
      else if (command == L"openDocumentation") ShellExecuteW(client, L"open", L"https://shd101wyy.github.io/markdown-preview-enhanced/", nullptr, nullptr, SW_SHOWNORMAL);
      else MessageBoxW(client, (L"This action is not yet available: " + command).c_str(), L"Markdown Preview", MB_OK | MB_ICONINFORMATION);
    }
  }
  void onResource(ICoreWebView2WebResourceRequestedEventArgs* args) {
    ICoreWebView2WebResourceRequest* request = nullptr;
    if (FAILED(args->get_Request(&request)) || !request) return;
    LPWSTR raw = nullptr;
    request->get_Uri(&raw);
    std::wstring uri = raw ? raw : L"";
    CoTaskMemFree(raw); release(request);
    const std::wstring prefix(kOrigin);
    if (uri.rfind(prefix, 0) != 0) return;
    std::wstring name = uri.substr(prefix.size());
    const size_t query = name.find(L'?');
    const std::wstring queryText = query == std::wstring::npos ? L"" : name.substr(query + 1);
    if (query != std::wstring::npos) name.resize(query);
    std::vector<BYTE> local;
    Bytes content{};
    std::wstring mimePath = name;
    if (name == L"local" && queryText.rfind(L"path=", 0) == 0) {
      mimePath = percentDecode(queryText.substr(5));
      if (readFile(mimePath, local)) content = {local.data(), local.size()};
    } else {
      name = percentDecode(name.empty() ? L"index.html" : name);
      content = findAsset(wideToUtf8(name));
      mimePath = name;
    }
    IStream* stream = content.data && content.size <= UINT_MAX ? SHCreateMemStream(content.data, static_cast<UINT>(content.size)) : nullptr;
    const bool found = stream != nullptr;
    const std::wstring headers = L"Content-Type: " + mimeType(mimePath) + L"\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-cache\r\n";
    ICoreWebView2WebResourceResponse* response = nullptr;
    if (environment && SUCCEEDED(environment->CreateWebResourceResponse(stream, found ? 200 : 404,
                                                                        found ? L"OK" : L"Not Found", headers.c_str(), &response))) {
      args->put_Response(response);
    }
    release(response); release(stream);
  }
  void resize() {
    if (!controller || !client) return;
    RECT bounds{};
    GetClientRect(client, &bounds);
    controller->put_Bounds(bounds);
  }
  void initialize();
};

std::map<HWND, std::shared_ptr<Frame>> g_frames;

std::shared_ptr<Frame> getFrame(HWND editor, bool create) {
  if (!editor || !IsWindow(editor)) return {};
  HWND frame = GetParent(editor);
  if (!frame) return {};
  EnterCriticalSection(&g_lock);
  auto& value = g_frames[frame];
  if (!value && create) { value = std::make_shared<Frame>(); value->frame = frame; }
  auto result = value;
  if (!value) g_frames.erase(frame);
  LeaveCriticalSection(&g_lock);
  if (result) result->editor = editor;
  return result;
}

void Frame::initialize() {
  failed = false;
  status = L"Loading Markdown Preview…";
  const HRESULT com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(com)) { fail(L"WebView2 requires a Windows UI thread initialized for COM."); return; }
  initializedCom = true;
  HMODULE loader = loadWebViewLoader();
  using CreateEnvironment = HRESULT (STDAPICALLTYPE*)(PCWSTR, PCWSTR, ICoreWebView2EnvironmentOptions*,
      ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler*);
  auto create = loader ? reinterpret_cast<CreateEnvironment>(GetProcAddress(loader, "CreateCoreWebView2EnvironmentWithOptions")) : nullptr;
  if (!create) { fail(L"Could not load the WebView2 loader."); return; }
  const std::wstring appDir = localAppDirectory();
  const std::wstring dataDir = appDir + L"\\WebView2";
  const auto weak = weak_from_this();
  const uint64_t generation = ++viewGeneration;
  using EnvHandler = Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler, HRESULT, ICoreWebView2Environment*>;
  auto* handler = new EnvHandler(IID_ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler,
    [weak, generation](HRESULT result, ICoreWebView2Environment* environment) -> HRESULT {
      auto self = weak.lock();
      if (!self || self->viewGeneration != generation || !self->client || !IsWindow(self->client)) return S_OK;
      if (FAILED(result) || !environment) { self->fail(L"WebView2 Runtime is unavailable. Install it and reopen the preview."); return S_OK; }
      environment->AddRef(); self->environment = environment;
      using ControllerHandler = Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler, HRESULT, ICoreWebView2Controller*>;
      auto* created = new ControllerHandler(IID_ICoreWebView2CreateCoreWebView2ControllerCompletedHandler,
        [weak, generation](HRESULT result, ICoreWebView2Controller* controller) -> HRESULT {
          auto frame = weak.lock();
          if (!frame || frame->viewGeneration != generation || !frame->client || !IsWindow(frame->client)) return S_OK;
          if (FAILED(result) || !controller) { frame->fail(L"Could not create the WebView2 preview."); return S_OK; }
          controller->AddRef(); frame->controller = controller;
          if (FAILED(controller->get_CoreWebView2(&frame->webview)) || !frame->webview) { frame->fail(L"Could not initialize WebView2."); return S_OK; }
          frame->resize();
          using ResourceHandler = Callback<ICoreWebView2WebResourceRequestedEventHandler, ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs*>;
          auto* resource = new ResourceHandler(IID_ICoreWebView2WebResourceRequestedEventHandler,
            [weak](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
              if (auto current = weak.lock()) current->onResource(args);
              return S_OK;
            });
          const HRESULT filterResult = frame->webview->AddWebResourceRequestedFilter(
            L"https://markdown-preview.local/*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
          if (FAILED(filterResult)) {
            resource->Release();
            frame->fail(L"Could not register the WebView2 resource filter.");
            return S_OK;
          }
          frame->resourceRegistered = SUCCEEDED(frame->webview->add_WebResourceRequested(resource, &frame->resourceToken));
          resource->Release();
          using MessageHandler = Callback<ICoreWebView2WebMessageReceivedEventHandler, ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs*>;
          auto* message = new MessageHandler(IID_ICoreWebView2WebMessageReceivedEventHandler,
            [weak](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
              auto current = weak.lock();
              if (!current) return S_OK;
              LPWSTR source = nullptr; LPWSTR text = nullptr;
              args->get_Source(&source);
              if (source && std::wstring(source).rfind(kOrigin, 0) == 0 && SUCCEEDED(args->TryGetWebMessageAsString(&text)) && text)
                current->enqueueAction(ActionKind::WebMessage, text);
              CoTaskMemFree(source); CoTaskMemFree(text);
              return S_OK;
            });
          frame->messageRegistered = SUCCEEDED(frame->webview->add_WebMessageReceived(message, &frame->messageToken));
          message->Release();
          if (!frame->resourceRegistered || !frame->messageRegistered) { frame->fail(L"Could not register WebView2 handlers."); return S_OK; }
          if (FAILED(frame->webview->Navigate(kOrigin))) frame->fail(L"Could not load the Markdown Preview page.");
          return S_OK;
        });
      const HRESULT hr = environment->CreateCoreWebView2Controller(self->client, created);
      created->Release();
      if (FAILED(hr)) self->fail(L"Could not create the WebView2 controller.");
      return S_OK;
    });
  const HRESULT hr = create(nullptr, dataDir.c_str(), nullptr, handler);
  handler->Release();
  if (FAILED(hr)) fail(L"Could not start WebView2. Check that the WebView2 Runtime is installed.");
}

LRESULT CALLBACK clientProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  Frame* frame = reinterpret_cast<Frame*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
  if (msg == WM_NCCREATE) {
    frame = static_cast<Frame*>(reinterpret_cast<CREATESTRUCTW*>(lp)->lpCreateParams);
    SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(frame));
  }
  if (!frame) return DefWindowProcW(hwnd, msg, wp, lp);
  switch (msg) {
    case WM_SIZE: frame->resize(); return 0;
    case kDispatchAction: {
      const auto keepAlive = frame->shared_from_this();
      keepAlive->dispatchActions();
      return 0;
    }
    case WM_TIMER:
      if (wp == kRefreshTimer) { KillTimer(hwnd, kRefreshTimer); frame->sendDocument(); return 0; }
      break;
    case WM_PAINT: {
      PAINTSTRUCT ps{}; HDC dc = BeginPaint(hwnd, &ps);
      if (!frame->controller || frame->failed) {
        RECT rect{}; GetClientRect(hwnd, &rect);
        FillRect(dc, &rect, reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1));
        rect.left += 12; rect.top += 12; rect.right -= 12;
        SetBkMode(dc, TRANSPARENT);
        DrawTextW(dc, frame->status.c_str(), -1, &rect, DT_WORDBREAK | DT_NOPREFIX);
      }
      EndPaint(hwnd, &ps); return 0;
    }
    case WM_DESTROY: frame->shutdown(); frame->client = nullptr; frame->barId = 0; break;
    case WM_NCDESTROY: SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0); break;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

bool openBar(const std::shared_ptr<Frame>& frame) {
  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc); wc.hInstance = g_instance; wc.lpfnWndProc = clientProc;
  wc.lpszClassName = kClassName; wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  if (!RegisterClassExW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return false;
  frame->client = CreateWindowExW(0, kClassName, L"Markdown Preview", WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN,
                                  0, 0, 300, 400, frame->frame, nullptr, g_instance, frame.get());
  if (!frame->client) return false;
  CUSTOM_BAR_INFO info{};
  info.cbSize = sizeof(info); info.hwndClient = frame->client; info.pszTitle = L"Markdown Preview"; info.iPos = 2;
  frame->barId = Editor_CustomBarOpen(frame->editor, &info);
  if (!frame->barId) { DestroyWindow(frame->client); return false; }
  frame->initialize();
  return true;
}

LRESULT copyWide(LPARAM target, WPARAM count, const wchar_t* value) {
  const size_t length = wcslen(value) + 1;
  if (target && count) wcsncpy_s(reinterpret_cast<wchar_t*>(target), static_cast<size_t>(count), value, _TRUNCATE);
  return static_cast<LRESULT>(length);
}
LRESULT copyAnsi(LPARAM target, WPARAM count, const char* value) {
  const size_t length = strlen(value) + 1;
  if (target && count) strncpy_s(reinterpret_cast<char*>(target), static_cast<size_t>(count), value, _TRUNCATE);
  return static_cast<LRESULT>(length);
}
}  // namespace

extern "C" __declspec(dllexport) void __stdcall OnCommand(HWND editor) {
  auto frame = getFrame(editor, true);
  if (!frame) return;
  if (frame->barId) Editor_CustomBarClose(editor, frame->barId);
  else if (!openBar(frame)) MessageBoxW(editor, L"Could not open the Markdown Preview pane.", L"Markdown Preview", MB_OK | MB_ICONERROR);
}

extern "C" __declspec(dllexport) BOOL __stdcall QueryStatus(HWND editor, LPBOOL checked) {
  auto frame = getFrame(editor, false);
  if (checked) *checked = frame && frame->barId;
  return TRUE;
}
extern "C" __declspec(dllexport) UINT __stdcall GetMenuTextID() { return 0; }
extern "C" __declspec(dllexport) UINT __stdcall GetStatusMessageID() { return 0; }
extern "C" __declspec(dllexport) UINT __stdcall GetBitmapID() { return 103; }

extern "C" __declspec(dllexport) void __stdcall OnEvents(HWND editor, UINT event, LPARAM) {
  if (event & EVENT_CLOSE) {
    std::map<HWND, std::shared_ptr<Frame>> closing;
    EnterCriticalSection(&g_lock); closing.swap(g_frames); LeaveCriticalSection(&g_lock);
    for (auto& entry : closing) entry.second->detach();
    UnregisterClassW(kClassName, g_instance);
    return;
  }
  auto frame = getFrame(editor, (event & EVENT_CREATE_FRAME) != 0);
  if (!frame) return;
  if (event & EVENT_CLOSE_FRAME) {
    frame->detach();
    EnterCriticalSection(&g_lock); g_frames.erase(frame->frame); LeaveCriticalSection(&g_lock);
    return;
  }
  if (!frame->client || !IsWindow(frame->client)) return;
  if (event & (EVENT_CHANGE | EVENT_DOC_SEL_CHANGED | EVENT_FILE_OPENED | EVENT_SAVING)) {
    ++frame->documentRevision;
    SetTimer(frame->client, kRefreshTimer, 200, nullptr);
  }
  if (event & (EVENT_SCROLL | EVENT_CARET_MOVED)) frame->sendScroll();
}

extern "C" __declspec(dllexport) LRESULT __stdcall PlugInProc(HWND, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case EP_GET_NAMEW: return copyWide(lp, wp, L"Markdown Preview");
    case EP_GET_NAMEA: return copyAnsi(lp, wp, "Markdown Preview");
    case EP_GET_MENU_TEXT: return copyWide(lp, wp, L"Markdown Preview");
    case EP_GET_STATUS_MESSAGE: return copyWide(lp, wp, L"Preview Markdown in a side pane");
    case EP_GET_VERSIONW: return copyWide(lp, wp, L"0.1.0");
    case EP_GET_VERSIONA: return copyAnsi(lp, wp, "0.1.0");
    case EP_GET_INFO:
      if (wp == EPGI_SUPPORT_EE_PRO || wp == EPGI_USE_CUSTOM_BAR || wp == EPGI_ALLOW_MULTIPLE_INSTANCES ||
          wp == EPGI_ALLOW_OPEN_SAME_GROUP) return TRUE;
      return 0;
    default: return 0;
  }
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    g_instance = instance; InitializeCriticalSection(&g_lock); DisableThreadLibraryCalls(instance);
  } else if (reason == DLL_PROCESS_DETACH) {
    DeleteCriticalSection(&g_lock);
  }
  return TRUE;
}
