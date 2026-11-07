cmake_minimum_required(VERSION 3.22)
project(MarkdownPreview VERSION 0.1.0 LANGUAGES CXX RC)

if(NOT WIN32)
  message(FATAL_ERROR "The plug-in must be built for Windows.")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# The official NuGet package contains the headers and both native loaders.
# It is downloaded into the build directory and verified before extraction.
set(WEBVIEW2_SDK_DIR "" CACHE PATH "Path to an extracted Microsoft.Web.WebView2 package")
if(NOT WEBVIEW2_SDK_DIR)
  include(FetchContent)
  FetchContent_Declare(webview2
    URL https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.3537.50/microsoft.web.webview2.1.0.3537.50.nupkg
    URL_HASH SHA256=5ea526bbd728adda0da4d31219267e96460494a427e4894c4e09d9f320f4b9aa
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
  FetchContent_MakeAvailable(webview2)
  set(WEBVIEW2_SDK_DIR "${webview2_SOURCE_DIR}")
endif()
if(CMAKE_SIZEOF_VOID_P EQUAL 8)
  set(WEBVIEW2_ARCH x64)
else()
  set(WEBVIEW2_ARCH x86)
endif()
set(WEBVIEW2_LOADER_PATH "${WEBVIEW2_SDK_DIR}/build/native/${WEBVIEW2_ARCH}/WebView2Loader.dll")
if(NOT EXISTS "${WEBVIEW2_LOADER_PATH}")
  message(FATAL_ERROR "WebView2 loader not found: ${WEBVIEW2_LOADER_PATH}")
endif()
find_program(NODE_EXECUTABLE node REQUIRED)
set(ASSET_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/assets")
set(ASSET_PACK_PATH "${ASSET_DIRECTORY}/assets.pack")
file(GLOB VENDORED_LICENSES CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/third_party/vendor-licenses/*")
add_custom_command(OUTPUT "${ASSET_PACK_PATH}"
  COMMAND "${CMAKE_COMMAND}" -E env "MARKDOWN_PREVIEW_ASSET_DIR=${ASSET_DIRECTORY}"
          "${NODE_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/scripts/build-assets.mjs"
  DEPENDS scripts/build-assets.mjs src/web/host.js src/web/index.html package.json package-lock.json LICENSE
          third_party/CROSSNOTE_LICENSE.md third_party/MARKDOWN_PREVIEW_ENHANCED_LICENSE.md
          third_party/WEBVIEW2_LICENSE.txt third_party/emeditor-sdk/LICENSE ${VENDORED_LICENSES}
  WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
  VERBATIM)
add_custom_target(preview_assets DEPENDS "${ASSET_PACK_PATH}")

file(TO_CMAKE_PATH "${ASSET_PACK_PATH}" ASSET_PACK_PATH)
file(TO_CMAKE_PATH "${WEBVIEW2_LOADER_PATH}" WEBVIEW2_LOADER_PATH)
file(TO_CMAKE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/src/plugin/toolbar.bmp" TOOLBAR_BITMAP_PATH)
configure_file(src/plugin/resources.rc.in "${CMAKE_CURRENT_BINARY_DIR}/resources.rc" @ONLY)
set_source_files_properties("${CMAKE_CURRENT_BINARY_DIR}/resources.rc" PROPERTIES
  OBJECT_DEPENDS "${ASSET_PACK_PATH};${WEBVIEW2_LOADER_PATH};${TOOLBAR_BITMAP_PATH}")
add_library(MarkdownPreview SHARED src/plugin/plugin.cpp
  "${CMAKE_CURRENT_BINARY_DIR}/resources.rc" src/plugin/exports.def)
add_dependencies(MarkdownPreview preview_assets)
target_include_directories(MarkdownPreview PRIVATE
  third_party/emeditor-sdk "${WEBVIEW2_SDK_DIR}/build/native/include")
if(MINGW)
  target_include_directories(MarkdownPreview PRIVATE src/plugin/compat)
  target_link_options(MarkdownPreview PRIVATE -static-libgcc -static-libstdc++ -Wl,--kill-at)
else()
  set_property(TARGET MarkdownPreview PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
  target_compile_options(MarkdownPreview PRIVATE /W4 /permissive- /utf-8)
endif()
target_compile_definitions(MarkdownPreview PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(MarkdownPreview PRIVATE comdlg32 crypt32 ole32 shlwapi shell32 user32 uuid)
set_target_properties(MarkdownPreview PROPERTIES PREFIX "" OUTPUT_NAME "MarkdownPreview")

include(CTest)
if(BUILD_TESTING)
  add_executable(task_marker_test tests/task_marker_test.cpp)
  target_include_directories(task_marker_test PRIVATE src/plugin)
  add_test(NAME task_marker_test COMMAND task_marker_test)
  add_executable(deferred_actions_test tests/deferred_actions_test.cpp)
  target_include_directories(deferred_actions_test PRIVATE src/plugin)
  add_test(NAME deferred_actions_test COMMAND deferred_actions_test)
endif()
