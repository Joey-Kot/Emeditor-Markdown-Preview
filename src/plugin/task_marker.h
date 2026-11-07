#pragma once

#include <cstddef>
#include <string_view>

// Return the character inside a task-list checkbox on this source line.
// Crossnote recognises a checkbox immediately after a Markdown list marker;
// later bracketed text on the same line must not be changed.
inline std::size_t taskMarkerPosition(std::wstring_view line) {
  const auto whitespace = [](wchar_t c) { return c == L' ' || c == L'\t'; };
  std::size_t pos = 0;
  while (pos < line.size() && whitespace(line[pos])) ++pos;
  // The rendered task can be inside one or more Markdown block quotes.
  while (pos < line.size() && line[pos] == L'>') {
    ++pos;
    while (pos < line.size() && whitespace(line[pos])) ++pos;
  }
  if (pos == line.size()) return std::wstring_view::npos;

  if (line[pos] == L'-' || line[pos] == L'+' || line[pos] == L'*') {
    ++pos;
  } else {
    const std::size_t start = pos;
    while (pos < line.size() && line[pos] >= L'0' && line[pos] <= L'9') ++pos;
    if (pos == start || pos == line.size() || line[pos] != L'.') return std::wstring_view::npos;
    ++pos;
  }
  if (pos == line.size() || !whitespace(line[pos])) return std::wstring_view::npos;
  while (pos < line.size() && whitespace(line[pos])) ++pos;
  if (pos + 2 >= line.size() || line[pos] != L'[' || line[pos + 2] != L']') return std::wstring_view::npos;
  const wchar_t state = line[pos + 1];
  if (state != L'x' && state != L'X' && !whitespace(state)) return std::wstring_view::npos;
  if (pos + 3 < line.size() && !whitespace(line[pos + 3])) return std::wstring_view::npos;
  return pos + 1;
}
