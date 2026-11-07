#include "task_marker.h"

#include <iostream>
#include <string>

int main() {
  struct Case { const wchar_t* input; std::size_t expected; };
  const Case cases[] = {
    {L"- [ ] task [x]", 3},
    {L"- [x] task [ ]", 3},
    {L"  * [X] task", 5},
    {L"\t42. [\t] task", 6},
    {L"+ [ ]", 3},
    {L"> - [ ] quoted", 5},
    {L"> 1. [x] quoted ordered", 6},
    {L" > > * [X] nested quote", 8},
    {L"> not a task [ ]", std::wstring::npos},
    {L"- text [ ]", std::wstring::npos},
    {L"- [x]suffix", std::wstring::npos},
    {L"not a task [x]", std::wstring::npos},
    {L"- [z] unsupported", std::wstring::npos},
    {L"", std::wstring::npos},
  };
  for (const auto& test : cases) {
    const auto result = taskMarkerPosition(test.input);
    if (result != test.expected) {
      std::wcerr << L"Wrong checkbox position for: " << test.input << L'\n';
      return 1;
    }
  }
  return 0;
}
