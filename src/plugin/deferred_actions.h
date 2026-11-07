#pragma once

#include <deque>
#include <utility>

// Run queued actions only after the current callback has returned. Actions
// added while dispatching are handled by the same loop, including when an
// action runs a nested native message loop.
template <typename Action>
class DeferredActions {
 public:
  template <typename Post>
  bool enqueue(Action action, Post&& post) {
    actions_.push_back(std::move(action));
    if (!dispatching_ && !posted_) {
      posted_ = true;
      if (!post()) {
        clear();
        return false;
      }
    }
    return true;
  }

  template <typename Alive, typename Handle>
  void dispatch(Alive&& alive, Handle&& handle) {
    posted_ = false;
    if (dispatching_) return;
    dispatching_ = true;
    while (alive() && !actions_.empty()) {
      Action action = std::move(actions_.front());
      actions_.pop_front();
      handle(std::move(action));
    }
    if (!alive()) actions_.clear();
    dispatching_ = false;
  }

  void clear() {
    actions_.clear();
    posted_ = false;
  }

 private:
  std::deque<Action> actions_;
  bool posted_ = false;
  bool dispatching_ = false;
};
