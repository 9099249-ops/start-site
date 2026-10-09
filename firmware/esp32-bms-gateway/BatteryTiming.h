#ifndef START_BATTERY_TIMING_H
#define START_BATTERY_TIMING_H

#include <stdint.h>
#include <stddef.h>

namespace battery_timing {
constexpr uint32_t kMaxDisconnectAgeMs = 24UL * 60 * 60 * 1000;

inline uint32_t elapsedMs(uint32_t nowMs, uint32_t sinceMs) {
  return uint32_t(nowMs - sinceMs);
}

inline uint64_t elapsedMonotonicMs(uint64_t nowMs, uint64_t sinceMs) {
  return nowMs >= sinceMs ? nowMs - sinceMs : 0;
}

inline bool matchesBinding(bool sameClient, const char *peer, const char *bound) {
  if (!sameClient || !peer || !bound) return false;
  for (size_t i = 0; i < 17; ++i) {
    if (!peer[i] || peer[i] != bound[i]) return false;
  }
  return peer[17] == '\0' && bound[17] == '\0';
}

class DisconnectAge {
 public:
  DisconnectAge() : connectedThisBoot_(false), disconnected_(false), disconnectedAtMs_(0) {}

  void resetBinding() {
    connectedThisBoot_ = false;
    disconnected_ = false;
    disconnectedAtMs_ = 0;
  }

  void connected() {
    connectedThisBoot_ = true;
    disconnected_ = false;
    disconnectedAtMs_ = 0;
  }

  void disconnected(uint64_t nowMs) {
    if (connectedThisBoot_ && !disconnected_) {
      disconnectedAtMs_ = nowMs;
      disconnected_ = true;
    }
  }

  bool ageMs(bool currentlyConnected, uint64_t nowMs, uint32_t &age) const {
    if (currentlyConnected || !connectedThisBoot_ || !disconnected_ || nowMs < disconnectedAtMs_) return false;
    const uint64_t elapsed = elapsedMonotonicMs(nowMs, disconnectedAtMs_);
    if (elapsed > kMaxDisconnectAgeMs) return false;
    age = uint32_t(elapsed);
    return true;
  }

 private:
  bool connectedThisBoot_;
  bool disconnected_;
  uint64_t disconnectedAtMs_;
};

}  // namespace battery_timing

#endif
