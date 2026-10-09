#include "../TitanatDecoder.h"

#include <assert.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static const uint8_t frame90[13] = {0xFA,0x01,0x90,0x08,0x00,0x86,0x00,0x00,0x75,0x74,0x03,0xA3,0xA8};
static const uint8_t frame93[13] = {0xFA,0x01,0x93,0x08,0x01,0x01,0x01,0xA2,0x00,0x01,0x7D,0xDB,0x94};
static const uint8_t frame94[13] = {0xFA,0x01,0x94,0x08,0x04,0x02,0x00,0x00,0x00,0x00,0x26,0x3C,0xFF};
static const uint8_t frame95a[13] = {0xFA,0x01,0x95,0x08,0x01,0x0D,0x26,0x0D,0x29,0x0D,0x27,0x00,0x36};
static const uint8_t frame95b[13] = {0xFA,0x01,0x95,0x08,0x02,0x0D,0x26,0x0D,0x29,0x0D,0x27,0x00,0x37};
static const uint8_t frame96[13] = {0xFA,0x01,0x96,0x08,0x01,0x3A,0x39,0xFF,0xFF,0xFF,0xFF,0x00,0x09};
static const uint8_t frame98[13] = {0xFA,0x01,0x98,0x08,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x9B};

static titanat::Values decoded;
static unsigned delivered = 0;
static uint8_t received[8][13];

static void capture(const uint8_t *frame) {
  if (delivered < 8) memcpy(received[delivered], frame, 13);
  ++delivered;
}

static void checkFrame(const uint8_t *frame) {
  assert(titanat::validFrame(frame, 13));
  titanat::decode(frame, decoded);
}

static void makeFrame(uint8_t out[13], uint8_t command, const uint8_t payload[8]) {
  out[0] = 0xFA; out[1] = 0x01; out[2] = command; out[3] = 0x08;
  memcpy(out + 4, payload, 8);
  out[12] = 0;
  for (size_t i = 0; i < 12; ++i) out[12] = uint8_t(out[12] + out[i]);
  assert(titanat::validFrame(out, 13));
}

static bool closeTo(float a, float b) { return fabsf(a - b) < 0.001f; }

int main() {
  checkFrame(frame90);
  assert(decoded.hasSummary && closeTo(decoded.voltageV, 13.4f));
  assert(closeTo(decoded.currentA, 6.8f) && closeTo(decoded.socPercent, 93.1f));

  checkFrame(frame93);
  assert(decoded.hasStatus && decoded.state == 1);
  assert(decoded.chargingEnabledRaw == 1 && decoded.dischargingEnabledRaw == 1);
  assert(decoded.remainingCapacityMah == 97755);

  checkFrame(frame94);
  assert(decoded.hasCellCount && decoded.cellCount == 4);
  assert(decoded.hasTemperatureCount && decoded.temperatureCount == 2);

  // Frame 2 may arrive before frame 1; index determines its three cell slots.
  checkFrame(frame95b);
  checkFrame(frame95a);
  assert(closeTo(decoded.cellVoltagesV[0], 3.366f));
  assert(closeTo(decoded.cellVoltagesV[1], 3.369f));
  assert(closeTo(decoded.cellVoltagesV[2], 3.367f));
  assert(closeTo(decoded.cellVoltagesV[3], 3.366f));

  checkFrame(frame96);
  assert(closeTo(decoded.temperaturesC[0], 18.0f));
  assert(closeTo(decoded.temperaturesC[1], 17.0f));
  assert(isnan(decoded.temperaturesC[2]));

  checkFrame(frame98);
  assert(decoded.hasAlarms);
  for (uint8_t bitByte : decoded.alarmMask) assert(bitByte == 0);

  // Valid-checksum but reserved/out-of-range page indices must not touch arrays.
  uint8_t edgePayload[8] = {0x00,0x0D,0x26,0x0D,0x29,0x0D,0x27,0x00};
  uint8_t edgeFrame[13];
  makeFrame(edgeFrame, 0x95, edgePayload);
  assert(!titanat::decode(edgeFrame, decoded)); // zero page index
  edgePayload[0] = 0xFF;
  makeFrame(edgeFrame, 0x95, edgePayload);
  assert(!titanat::decode(edgeFrame, decoded)); // reserved page index
  edgePayload[0] = 12;
  makeFrame(edgeFrame, 0x95, edgePayload);
  assert(!titanat::decode(edgeFrame, decoded)); // beyond maximum 32-cell layout
  edgePayload[0] = 3;
  makeFrame(edgeFrame, 0x95, edgePayload);
  assert(!titanat::decode(edgeFrame, decoded)); // page begins beyond the declared four cells

  // Page 2 starts at cell 4 for this pack; two padding values must not enter the array.
  edgePayload[0] = 2;
  edgePayload[1] = 0x0D; edgePayload[2] = 0x2A;
  edgePayload[3] = 0x0D; edgePayload[4] = 0x2B;
  edgePayload[5] = 0x0D; edgePayload[6] = 0x2C;
  makeFrame(edgeFrame, 0x95, edgePayload);
  assert(titanat::decode(edgeFrame, decoded));
  assert(closeTo(decoded.cellVoltagesV[3], 3.370f));
  assert(isnan(decoded.cellVoltagesV[4]));

  // Checksum-valid voltage values above 10 V are null sentinels at cell granularity.
  edgePayload[0] = 1;
  edgePayload[1] = 0x27; edgePayload[2] = 0x11; // 10001 mV
  edgePayload[3] = 0x0D; edgePayload[4] = 0x26;
  edgePayload[5] = 0x0D; edgePayload[6] = 0x27;
  makeFrame(edgeFrame, 0x95, edgePayload);
  assert(titanat::decode(edgeFrame, decoded));
  assert(isnan(decoded.cellVoltagesV[0]));
  assert(closeTo(decoded.cellVoltagesV[1], 3.366f));

  // Temperature pages use the same bounds and declared-count clipping.
  uint8_t tempPayload[8] = {1,0xC0,0x3A,0xFF,0xFF,0xFF,0xFF,0x00};
  makeFrame(edgeFrame, 0x96, tempPayload);
  assert(titanat::decode(edgeFrame, decoded));
  assert(isnan(decoded.temperaturesC[0])); // 0xC0 - 40 is above 150 C
  assert(closeTo(decoded.temperaturesC[1], 18.0f));
  tempPayload[0] = 4;
  makeFrame(edgeFrame, 0x96, tempPayload);
  assert(!titanat::decode(edgeFrame, decoded)); // index exceeds the maximum 16-sensor layout
  tempPayload[0] = 2;
  makeFrame(edgeFrame, 0x96, tempPayload);
  assert(!titanat::decode(edgeFrame, decoded)); // page starts past the declared two sensors
  titanat::Values noSensors;
  tempPayload[0] = 1;
  makeFrame(edgeFrame, 0x96, tempPayload);
  assert(!titanat::decode(edgeFrame, noSensors));

  // Zero declared cells is invalid; a zero temperature-sensor count remains valid.
  titanat::Values zeroCounts;
  uint8_t countPayload[8] = {0,0,0,0,0,0,0,0};
  makeFrame(edgeFrame, 0x94, countPayload);
  assert(titanat::decode(edgeFrame, zeroCounts));
  assert(!zeroCounts.hasCellCount && zeroCounts.hasTemperatureCount && zeroCounts.temperatureCount == 0);
  edgePayload[0] = 1;
  makeFrame(edgeFrame, 0x95, edgePayload);
  assert(!titanat::decode(edgeFrame, zeroCounts));

  // Reserved/out-of-range remaining capacity is not suitable for Ah telemetry.
  assert(titanat::validRemainingCapacityMah(97755));
  assert(!titanat::validRemainingCapacityMah(0xFFFFFFFFUL));
  assert(!titanat::validRemainingCapacityMah(10000001UL));

  titanat::FrameAssembler stream;
  const uint8_t noise[] = {0x00,0xFA,0x01,0x90,0x08};
  stream.push(noise, sizeof(noise), capture);
  assert(stream.bufferedBytes() == sizeof(noise) - 1);
  stream.push(frame90 + 4, 9, capture);
  assert(delivered == 1 && memcmp(received[0], frame90, 13) == 0);

  // One notification may contain multiple frames; arbitrary BLE chunks may split them.
  uint8_t joined[26];
  memcpy(joined, frame93, 13);
  memcpy(joined + 13, frame94, 13);
  stream.push(joined, 7, capture);
  stream.push(joined + 7, sizeof(joined) - 7, capture);
  assert(delivered == 3 && stream.validFrames() == 3);

  // Reject a bad checksum and resynchronize at the next valid header.
  uint8_t bad[13];
  memcpy(bad, frame98, sizeof(bad));
  bad[12] ^= 0x01;
  memcpy(joined, bad, 13);
  memcpy(joined + 13, frame96, 13);
  stream.push(joined, sizeof(joined), capture);
  assert(delivered == 4 && memcmp(received[3], frame96, 13) == 0);
  assert(stream.badCandidates() == 1);

  // An incomplete trailing frame stays buffered until more bytes arrive.
  stream.clear();
  stream.push(frame95a, 10, capture);
  assert(stream.bufferedBytes() == 10 && delivered == 4);
  stream.push(frame95a + 10, 3, capture);
  assert(delivered == 5 && stream.bufferedBytes() == 0);

  puts("Titanat decoder checks passed");
  return 0;
}
