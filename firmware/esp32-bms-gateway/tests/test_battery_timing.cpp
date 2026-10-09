#include <assert.h>
#include <stdint.h>

#include "../BatteryTiming.h"

int main() {
  assert(battery_timing::elapsedMs(1250, 1000) == 250);
  assert(battery_timing::elapsedMs(3, UINT32_MAX - 4) == 8);
  assert(battery_timing::elapsedMonotonicMs(uint64_t(UINT32_MAX) + 3, uint64_t(UINT32_MAX) - 4) == 7);
  assert(battery_timing::elapsedMonotonicMs(100, 200) == 0);
  assert(battery_timing::matchesBinding(true, "aa:bb:cc:dd:ee:ff", "aa:bb:cc:dd:ee:ff"));
  assert(!battery_timing::matchesBinding(false, "aa:bb:cc:dd:ee:ff", "aa:bb:cc:dd:ee:ff"));
  assert(!battery_timing::matchesBinding(true, "11:bb:cc:dd:ee:ff", "aa:bb:cc:dd:ee:ff"));
  assert(!battery_timing::matchesBinding(true, "short", "aa:bb:cc:dd:ee:ff"));

  battery_timing::DisconnectAge timing;
  uint32_t age = 0;

  assert(!timing.ageMs(false, 1000, age));

  timing.connected();
  assert(!timing.ageMs(false, 1000, age));
  assert(!timing.ageMs(true, 1000, age));

  timing.disconnected(123456);
  assert(timing.ageMs(false, 123456, age) && age == 0);
  assert(timing.ageMs(false, 123457, age) && age == 1);
  assert(timing.ageMs(false, 124455, age) && age == 999);
  assert(!timing.ageMs(true, 124455, age));

  timing.connected();
  assert(!timing.ageMs(false, 124456, age));
  timing.disconnected(124456);
  assert(timing.ageMs(false, 124500, age) && age == 44);

  timing.resetBinding();
  assert(!timing.ageMs(false, 124501, age));

  timing.connected();
  const uint64_t disconnectAt = uint64_t(UINT32_MAX) - 4;
  timing.disconnected(disconnectAt);
  assert(timing.ageMs(false, disconnectAt + 7, age) && age == 7);
  assert(timing.ageMs(false, disconnectAt + battery_timing::kMaxDisconnectAgeMs, age) &&
         age == battery_timing::kMaxDisconnectAgeMs);
  assert(!timing.ageMs(false, disconnectAt + battery_timing::kMaxDisconnectAgeMs + 1, age));
  assert(!timing.ageMs(false, disconnectAt - 1, age));
  return 0;
}
