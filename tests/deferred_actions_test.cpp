#include "deferred_actions.h"

#include <vector>

int main() {
  DeferredActions<int> actions;
  int posts = 0;
  bool alive = true;
  std::vector<int> handled;
  const auto post = [&] { ++posts; return true; };
  const auto handle = [&](int value) {
    handled.push_back(value);
    if (value == 1) {
      actions.enqueue(3, post);
      actions.dispatch([&] { return alive; }, [&](int nested) { handled.push_back(-nested); });
    }
  };

  actions.enqueue(1, post);
  actions.enqueue(2, post);
  if (posts != 1 || !handled.empty()) return 1;
  actions.dispatch([&] { return alive; }, handle);
  if (posts != 1 || handled != std::vector<int>({1, 2, 3})) return 2;

  actions.enqueue(4, post);
  actions.clear();
  actions.dispatch([&] { return alive; }, handle);
  if (handled != std::vector<int>({1, 2, 3})) return 3;

  if (actions.enqueue(5, [] { return false; })) return 4;
  actions.enqueue(6, post);
  actions.enqueue(7, post);
  actions.dispatch([&] { return alive; }, [&](int value) {
    handled.push_back(value);
    alive = false;
  });
  alive = true;
  actions.dispatch([&] { return alive; }, handle);
  if (handled != std::vector<int>({1, 2, 3, 6})) return 5;
  return 0;
}
