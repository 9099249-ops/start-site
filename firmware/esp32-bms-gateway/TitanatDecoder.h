#pragma once

#include <stdint.h>
#include <stddef.h>
#include <math.h>

namespace titanat {

constexpr size_t kFrameSize = 13;
constexpr size_t kMaxCells = 32;
constexpr size_t kMaxTemperatures = 16;

struct Values {
  bool hasSummary = false;
  float socPercent = NAN;
  float voltageV = NAN;
  float currentA = NAN;

  bool hasStatus = false;
  uint8_t state = 0xFF;  // 0 idle, 1 charging, 2 discharging; other values unknown
  uint8_t chargingEnabledRaw = 0xFF;
  uint8_t dischargingEnabledRaw = 0xFF;
  uint32_t remainingCapacityMah = 0;

  bool hasCellCount = false;
  uint8_t cellCount = 0;
  bool hasTemperatureCount = false;
  uint8_t temperatureCount = 0;
  float cellVoltagesV[kMaxCells];
  float temperaturesC[kMaxTemperatures];
  uint8_t alarmMask[8] = {};
  bool hasAlarms = false;

  Values() {
    for (size_t i = 0; i < kMaxCells; ++i) cellVoltagesV[i] = NAN;
    for (size_t i = 0; i < kMaxTemperatures; ++i) temperaturesC[i] = NAN;
  }
};

inline uint16_t be16(const uint8_t *p) {
  return (uint16_t(p[0]) << 8) | p[1];
}

inline uint32_t be32(const uint8_t *p) {
  return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) |
         (uint32_t(p[2]) << 8) | p[3];
}

inline bool validRemainingCapacityMah(uint32_t value) {
  return value != 0xFFFFFFFFUL && value <= 10000000UL;
}

inline bool validFrame(const uint8_t *f, size_t n) {
  if (n != kFrameSize || f[0] != 0xFA || f[1] != 0x01 || f[3] != 8) return false;
  uint8_t sum = 0;
  for (size_t i = 0; i < 12; ++i) sum = uint8_t(sum + f[i]);
  return sum == f[12];
}

class FrameAssembler {
 public:
  using Sink = void (*)(const uint8_t *frame);

  void clear() { length_ = 0; }

  void push(const uint8_t *data, size_t length, Sink sink) {
    for (size_t i = 0; i < length; ++i) {
      if (length_ == 0 && data[i] != 0xFA) continue;
      buffer_[length_++] = data[i];
      if (length_ < kFrameSize) continue;
      if (validFrame(buffer_, length_)) {
        ++validFrames_;
        if (sink) sink(buffer_);
        length_ = 0;
      } else {
        ++badCandidates_;
        for (size_t j = 1; j < kFrameSize; ++j) buffer_[j - 1] = buffer_[j];
        length_ = kFrameSize - 1;
        while (length_ > 0 && buffer_[0] != 0xFA) {
          --length_;
          for (size_t j = 1; j <= length_; ++j) buffer_[j - 1] = buffer_[j];
        }
      }
    }
  }

  size_t bufferedBytes() const { return length_; }
  uint32_t validFrames() const { return validFrames_; }
  uint32_t badCandidates() const { return badCandidates_; }

 private:
  uint8_t buffer_[kFrameSize] = {};
  size_t length_ = 0;
  uint32_t validFrames_ = 0;
  uint32_t badCandidates_ = 0;
};

inline bool decode(const uint8_t *f, Values &v) {
  const uint8_t *p = f + 4;
  switch (f[2]) {
    case 0x90: {
      const float voltage = be16(p) / 10.0f;
      const float current = (int32_t(be16(p + 4)) - 30000) / 10.0f;
      const float soc = be16(p + 6) / 10.0f;
      if (voltage > 0.0f && voltage <= 200.0f && soc <= 100.0f && current >= -1000.0f && current <= 1000.0f) {
        v.voltageV = voltage;
        v.currentA = current;
        v.socPercent = soc;
        v.hasSummary = true;
        return true;
      }
      return false;
    }
    case 0x93:
      v.state = p[0];
      v.chargingEnabledRaw = p[1];
      v.dischargingEnabledRaw = p[2];
      v.remainingCapacityMah = be32(p + 4);
      v.hasStatus = true;
      return true;
    case 0x94:
      {
      bool foundCount = false;
      if (p[0] >= 1 && p[0] <= kMaxCells) {
        v.cellCount = p[0];
        v.hasCellCount = true;
        foundCount = true;
      }
      if (p[1] <= kMaxTemperatures) {
        v.temperatureCount = p[1];
        v.hasTemperatureCount = true;
        foundCount = true;
      }
      return foundCount;
      }
    case 0x95: {
      const uint8_t frameIndex = p[0];
      if (!v.hasCellCount || frameIndex == 0 || frameIndex > 11) return false;
      const size_t first = size_t(frameIndex - 1) * 3;
      if (first >= v.cellCount) return false;
      for (size_t i = 0; i < 3 && first + i < v.cellCount && first + i < kMaxCells; ++i) {
        const uint16_t mv = be16(p + 1 + i * 2);
        v.cellVoltagesV[first + i] = mv == 0xFFFF || mv > 10000 ? NAN : mv / 1000.0f;
      }
      return true;
    }
    case 0x96: {
      const uint8_t frameIndex = p[0];
      if (!v.hasTemperatureCount || v.temperatureCount == 0 || frameIndex == 0 || frameIndex > 3) return false;
      const size_t first = size_t(frameIndex - 1) * 6;
      if (first >= v.temperatureCount) return false;
      for (size_t i = 0; i < 6 && first + i < v.temperatureCount && first + i < kMaxTemperatures; ++i) {
        const uint8_t raw = p[1 + i];
        const int temperature = int(raw) - 40;
        v.temperaturesC[first + i] = raw == 0xFF || temperature < -60 || temperature > 150 ? NAN : float(temperature);
      }
      return true;
    }
    case 0x98:
      for (size_t i = 0; i < 8; ++i) v.alarmMask[i] = p[i];
      v.hasAlarms = true;
      return true;
    default:
      return false;
  }
}

}  // namespace titanat
