#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Update.h>
#include <Preferences.h>
#include <NimBLEDevice.h>
#include <cJSON.h>
#include <esp_timer.h>
#include <esp_ota_ops.h>
#include <mbedtls/base64.h>
#include <mbedtls/md.h>
#include <mbedtls/pk.h>
#include <time.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#include "TitanatDecoder.h"
#include "BatteryTiming.h"

namespace {
constexpr uint32_t kFreshMs = 45000;
constexpr uint32_t kPollMs = 15000;
constexpr uint32_t kDisconnectedHeartbeatMs = 5000;
constexpr uint32_t kCommandGapMs = 400;
constexpr uint32_t kWifiTrialMs = 120000;
constexpr size_t kMaxControlResponse = 8192;
constexpr char kFirmwareVersion[] = "1.1.3";
constexpr uint8_t kCommands[] = {0x90, 0x93, 0x94, 0x95, 0x96, 0x98, 0x56};
constexpr char kApiPath[] = "/api/devices/battery-telemetry";
constexpr char kRootCa[] PROGMEM = R"CERT(
-----BEGIN CERTIFICATE-----
MIIFWjCCA0KgAwIBAgISEdK7udcjGJ5AXwqdLdDfJWfRMA0GCSqGSIb3DQEBDAUA
MEYxCzAJBgNVBAYTAkJFMRkwFwYDVQQKExBHbG9iYWxTaWduIG52LXNhMRwwGgYD
VQQDExNHbG9iYWxTaWduIFJvb3QgUjQ2MB4XDTE5MDMyMDAwMDAwMFoXDTQ2MDMy
MDAwMDAwMFowRjELMAkGA1UEBhMCQkUxGTAXBgNVBAoTEEdsb2JhbFNpZ24gbnYt
c2ExHDAaBgNVBAMTE0dsb2JhbFNpZ24gUm9vdCBSNDYwggIiMA0GCSqGSIb3DQEB
AQUAA4ICDwAwggIKAoICAQCsrHQy6LNl5brtQyYdpokNRbopiLKkHWPd08EsCVeJ
OaFV6Wc0dwxu5FUdUiXSE2te4R2pt32JMl8Nnp8semNgQB+msLZ4j5lUlghYruQG
vGIFAha/r6gjA7aUD7xubMLL1aa7DOn2wQL7Id5m3RerdELv8HQvJfTqa1VbkNud
316HCkD7rRlr+/fKYIje2sGP1q7Vf9Q8g+7XFkyDRTNrJ9CG0Bwta/OrffGFqfUo
0q3v84RLHIf8E6M6cqJaESvWJ3En7YEtbWaBkoe0G1h6zD8K+kZPTXhc+CtI4wSE
y132tGqzZfxCnlEmIyDLPRT5ge1lFgBPGmSXZgjPjHvjK8Cd+RTyG/FWaha/LIWF
zXg4mutCagI0GIMXTpRW+LaCtfOW3T3zvn8gdz57GSNrLNRyc0NXfeD412lPFzYE
+cCQYDdF3uYM2HSNrpyibXRdQr4G9dlkbgIQrImwTDsHTUB+JMWKmIJ5jqSngiCN
I/onccnfxkF0oE32kRbcRoxfKWMxWXEM2G/CtjJ9++ZdU6Z+Ffy7dXxd7Pj2Fxzs
x2sZy/N78CsHpdlseVR2bJ0cpm4O6XkMqCNqo98bMDGfsVR7/mrLZqrcZdCinkqa
ByFrgY/bxFn63iLABJzjqls2k+g9vXqhnQt2sQvHnf3PmKgGwvgqo6GDoLclcqUC
4wIDAQABo0IwQDAOBgNVHQ8BAf8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNV
HQ4EFgQUA1yrc4GHqMywptWU4jaWSf8FmSwwDQYJKoZIhvcNAQEMBQADggIBAHx4
7PYCLLtbfpIrXTncvtgdokIzTfnvpCo7RGkerNlFo048p9gkUbJUHJNOxO97k4Vg
JuoJSOD1u8fpaNK7ajFxzHmuEajwmf3lH7wvqMxX63bEIaZHU1VNaL8FpO7XJqti
2kM3S+LGteWygxk6x9PbTZ4IevPuzz5i+6zoYMzRx6Fcg0XERczzF2sUyQQCPtIk
pnnpHs6i58FZFZ8d4kuaPp92CC1r2LpXFNqD6v6MVenQTqnMdzGxRBF6XLE+0xRF
FRhiJBPSy03OXIPBNvIQtQ6IbbjhVp+J3pZmOUdkLG5NrmJ7v2B0GbhWrJKsFjLt
rWhV/pi60zTe9Mlhww6G9kuEYO4Ne7UyWHmRVSyBQ7N0H3qqJZ4d16GLuc1CLgSk
ZoNNiTW2bKg2SnkheCLQQrzRQDGQob4Ez8pn7fXwgNNgyYMqIgXQBztSvwyeqiv5
u+YfjyW6hY0XHgL+XVAEV8/+LbzvXMAaq7afJMbfc2hIkCwU9D9SGuTSyxTDYWnP
4vkYxboznxSjBF25cfe1lNj2M8FawTSLfJvdkzrnE6JwYZ+vj+vYxXX4M2bUdGc6
N3ec592kD3ZDZopD8p/7DEJ4Y9HiD2971KE9dJeFt0g5QdYg/NA6s/rob8SKunE3
vouXsXgxT7PntgMTzlSdriVZzH81Xwj3QEUxeCp6
-----END CERTIFICATE-----
)CERT";
constexpr char kFirmwarePublicKey[] PROGMEM = R"KEY(
-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEU1K64gLOvrrqLsqXSgWWYds0auS9
v0wKC5HDEus9w+YObVZcBFKyFMglx4CYCp8KKe/wJGcLOhp1xV6NHyLpXg==
-----END PUBLIC KEY-----
)KEY";

Preferences prefs;
NimBLEScan *scanner = nullptr;
NimBLEClient *client = nullptr;
NimBLERemoteCharacteristic *txCharacteristic = nullptr;
String serialLine;
String wifiSsid, wifiPassword, boundAddress;
String serverOrigin, deviceId, deviceToken;
String commandAckId, commandAckStatus, commandAckCode;
String otaPendingId, otaPendingVersion;
uint32_t otaPendingAddress = 0;
String wifiActiveCommandId;
String wifiTrialId, wifiTrialSsid, wifiTrialPassword, wifiPreviousSsid, wifiPreviousPassword;
uint32_t wifiTrialStartedAt = 0;
bool wifiTrialActive = false;
bool monitorEnabled = false;
bool connectRequested = false;
bool cycleActive = false;
bool clockSyncStarted = false;
bool presenceScanActive = false;
uint32_t lastWifiAttemptAt = 0;
uint32_t lastConnectAttemptAt = 0;
uint32_t lastPollStartedAt = 0;
uint32_t nextCommandAt = 0;
uint32_t connectedAt = 0;
uint32_t lastHeartbeatAt = 0;
uint32_t lastSummaryAt = 0;
uint32_t lastStatusAt = 0;
uint32_t lastCellsAt = 0;
uint32_t lastCellCountAt = 0;
uint32_t lastTemperaturesAt = 0;
uint32_t lastTemperatureCountAt = 0;
uint32_t lastAlarmsAt = 0;
uint32_t lastNameAt = 0;
uint32_t sequence = 0;
uint8_t commandIndex = 0;
titanat::Values values;
titanat::FrameAssembler frameAssembler;
uint8_t rawFrames[7][16][titanat::kFrameSize];
uint8_t rawCounts[7] = {};
uint8_t nameBytes[35] = {};
uint8_t namePageBytes[35] = {};
uint8_t nameSeen = 0;
uint8_t nameCycleMask = 0;
int8_t bleRssi = -127;
char bootId[17] = {};
volatile bool disconnectedEvent = false;
volatile uint32_t lastBleSeenAt = 0;
battery_timing::DisconnectAge bmsDisconnectAge;
portMUX_TYPE bmsDisconnectMux = portMUX_INITIALIZER_UNLOCKED;
char boundAddressForDisconnect[18] = {};
SemaphoreHandle_t dataMutex = nullptr;

uint64_t monotonicMs() { return uint64_t(esp_timer_get_time()) / 1000; }

void setDisconnectBinding(const String &address) {
  char snapshot[18] = {};
  address.toCharArray(snapshot, sizeof(snapshot));
  portENTER_CRITICAL(&bmsDisconnectMux);
  memcpy(boundAddressForDisconnect, snapshot, sizeof(snapshot));
  bmsDisconnectAge.resetBinding();
  portEXIT_CRITICAL(&bmsDisconnectMux);
}

bool timeReady();
void beginWifi();
bool saveWifi(const String &ssid, const String &password, const String &committedCommandId = "");
void rollbackWifiTrial();

int commandSlot(uint8_t cmd) {
  switch (cmd) {
    case 0x90: return 0;
    case 0x93: return 1;
    case 0x94: return 2;
    case 0x95: return 3;
    case 0x96: return 4;
    case 0x98: return 5;
    case 0x56: return 6;
    default: return -1;
  }
}

void resetCycleFrames() {
  memset(rawCounts, 0, sizeof(rawCounts));
  memset(rawFrames, 0, sizeof(rawFrames));
  memset(namePageBytes, 0, sizeof(namePageBytes));
  nameCycleMask = 0;
  for (size_t i = 0; i < titanat::kMaxCells; ++i) values.cellVoltagesV[i] = NAN;
  for (size_t i = 0; i < titanat::kMaxTemperatures; ++i) values.temperaturesC[i] = NAN;
}

bool peerMatchesBoundLocked() {
  if (!client || !client->isConnected() || boundAddress.length() != 17) return false;
  String peer = client->getPeerAddress().toString().c_str();
  peer.toLowerCase();
  return peer == boundAddress;
}

bool connectedPeerMatchesBound() {
  if (!dataMutex || !client || !client->isConnected()) return false;
  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(100)) != pdTRUE) return false;
  const bool matches = peerMatchesBoundLocked();
  xSemaphoreGive(dataMutex);
  return matches;
}

void clearTelemetryLocked(bool connected) {
  values = titanat::Values();
  frameAssembler.clear();
  memset(rawFrames, 0, sizeof(rawFrames));
  memset(rawCounts, 0, sizeof(rawCounts));
  memset(nameBytes, 0, sizeof(nameBytes));
  memset(namePageBytes, 0, sizeof(namePageBytes));
  nameSeen = 0;
  nameCycleMask = 0;
  lastSummaryAt = 0;
  lastStatusAt = 0;
  lastCellsAt = 0;
  lastCellCountAt = 0;
  lastTemperaturesAt = 0;
  lastTemperatureCountAt = 0;
  lastAlarmsAt = 0;
  lastNameAt = 0;
  connectedAt = connected ? millis() : 0;
  portENTER_CRITICAL(&bmsDisconnectMux);
  if (connected) bmsDisconnectAge.connected();
  else bmsDisconnectAge.resetBinding();
  portEXIT_CRITICAL(&bmsDisconnectMux);
  bleRssi = -127;
}

bool summaryTimedOut() {
  if (!dataMutex || xSemaphoreTake(dataMutex, pdMS_TO_TICKS(100)) != pdTRUE) return false;
  const uint32_t now = millis();
  const uint32_t since = lastSummaryAt ? lastSummaryAt : connectedAt;
  xSemaphoreGive(dataMutex);
  return since && uint32_t(now - since) > kFreshMs;
}

void onFrame(const uint8_t *f) {
  const int slot = commandSlot(f[2]);
  if (slot < 0) return;
  if (rawCounts[slot] < 16) {
    memcpy(rawFrames[slot][rawCounts[slot]], f, titanat::kFrameSize);
    ++rawCounts[slot];
  }
  const bool accepted = titanat::decode(f, values);
  const uint32_t now = millis();
  switch (f[2]) {
    case 0x90:
      if (accepted) {
        lastSummaryAt = now;
        ++sequence;
      }
      break;
    case 0x93: if (accepted) lastStatusAt = now; break;
    case 0x94:
      if (f[4] >= 1 && f[4] <= titanat::kMaxCells) lastCellCountAt = now;
      if (f[5] <= titanat::kMaxTemperatures) lastTemperatureCountAt = now;
      break;
    case 0x95: if (accepted) lastCellsAt = now; break;
    case 0x96: if (accepted) lastTemperaturesAt = now; break;
    case 0x98: if (accepted) lastAlarmsAt = now; break;
    case 0x56: {
      const uint8_t page = f[4];
      if (page >= 1 && page <= 5) {
        memcpy(namePageBytes + size_t(page - 1) * 7, f + 5, 7);
        nameCycleMask |= uint8_t(1U << (page - 1));
        if (nameCycleMask == 0x1F) {
          memcpy(nameBytes, namePageBytes, sizeof(nameBytes));
          nameSeen = 0x1F;
          lastNameAt = now;
        }
      }
      break;
    }
  }
}

void receiveFrames(const uint8_t *data, size_t length) {
  frameAssembler.push(data, length, onFrame);
}

void notification(NimBLERemoteCharacteristic *, uint8_t *data, size_t length, bool) {
  if (!dataMutex) return;
  xSemaphoreTake(dataMutex, portMAX_DELAY);
  if (peerMatchesBoundLocked()) { lastBleSeenAt = millis(); receiveFrames(data, length); }
  xSemaphoreGive(dataMutex);
}

class ClientEvents final : public NimBLEClientCallbacks {
  void onConnect(NimBLEClient *) override {
    disconnectedEvent = false;
    if (dataMutex && xSemaphoreTake(dataMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
      if (peerMatchesBoundLocked()) lastBleSeenAt = millis();
      xSemaphoreGive(dataMutex);
    }
  }
  void onDisconnect(NimBLEClient *disconnectedClient, int) override {
    if (!disconnectedClient) return;
    if (disconnectedClient->isConnected()) return;
    String peer = disconnectedClient->getPeerAddress().toString().c_str();
    peer.toLowerCase();
    char peerAddress[18] = {};
    peer.toCharArray(peerAddress, sizeof(peerAddress));
    const uint64_t eventAt = monotonicMs();
    portENTER_CRITICAL(&bmsDisconnectMux);
    const bool matchesCurrentBinding = peer.length() == 17 && battery_timing::matchesBinding(
        disconnectedClient == client, peerAddress, boundAddressForDisconnect);
    if (matchesCurrentBinding) bmsDisconnectAge.disconnected(eventAt);
    portEXIT_CRITICAL(&bmsDisconnectMux);
    if (matchesCurrentBinding) disconnectedEvent = true;
  }
};
ClientEvents clientEvents;

class PresenceScanCallbacks final : public NimBLEScanCallbacks {
  void onResult(const NimBLEAdvertisedDevice *device) override {
    if (!device || !dataMutex) return;
    String address = device->getAddress().toString().c_str();
    address.toLowerCase();
    if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
      if (address == boundAddress) lastBleSeenAt = millis();
      xSemaphoreGive(dataMutex);
    }
  }
};
PresenceScanCallbacks presenceScanCallbacks;

bool isPrivateHttp(const String &origin) {
  if (!origin.startsWith("http://")) return false;
  String authority = origin.substring(7);
  int slash = authority.indexOf('/');
  if (slash >= 0) authority = authority.substring(0, slash);
  int colon = authority.indexOf(':');
  if (colon >= 0) authority = authority.substring(0, colon);
  authority.toLowerCase();
  if (authority.endsWith(".local")) return true;
  int a, b, c, d;
  char trailing;
  if (sscanf(authority.c_str(), "%d.%d.%d.%d%c", &a, &b, &c, &d, &trailing) != 4) return false;
  if (a < 0 || a > 255 || b < 0 || b > 255 || c < 0 || c > 255 || d < 0 || d > 255) return false;
  if (a == 10 || a == 127) return true;
  if (a == 192 && b == 168) return true;
  if (a == 172 && b >= 16 && b <= 31) return true;
  return false;
}

bool validServerOrigin(const String &origin) {
  if (origin.startsWith("https://")) {
    if (origin.length() <= 8) return false;
    const String authority = origin.substring(8);
    return authority.indexOf('/') < 0 && authority.indexOf('?') < 0 && authority.indexOf('#') < 0 && authority.indexOf(' ') < 0;
  }
  return isPrivateHttp(origin);
}

bool validMacAddress(const String &address) {
  if (address.length() != 17) return false;
  for (size_t i = 0; i < 17; ++i) {
    if (i % 3 == 2) {
      if (address[i] != ':') return false;
    } else if (!isxdigit(uint8_t(address[i]))) return false;
  }
  return true;
}

String trimOrigin(String origin) {
  origin.trim();
  while (origin.endsWith("/")) origin.remove(origin.length() - 1);
  return origin;
}

String jsonEscape(const String &s) {
  String out;
  out.reserve(s.length() + 8);
  for (size_t i = 0; i < s.length(); ++i) {
    const uint8_t c = uint8_t(s[i]);
    if (c == '"' || c == '\\') { out += '\\'; out += char(c); }
    else if (c >= 0x20) out += char(c);
  }
  return out;
}

void jsonFloat(String &out, float n) {
  if (isfinite(n)) out += String(n, 3);
  else out += "null";
}

void appendAge(String &out, uint32_t stamp, uint32_t now) {
  if (!stamp) out += "null";
  else out += String(uint32_t(now - stamp));
}

void appendGroupAge(String &out, uint32_t stampA, uint32_t stampB, uint32_t now) {
  if (!stampA || !stampB) out += "null";
  else appendAge(out, stampA < stampB ? stampA : stampB, now);
}

String batteryName() {
  String name;
  if (nameSeen != 0x1F) return name;
  bool started = false;
  for (size_t i = 0; i < sizeof(nameBytes); ++i) {
    const uint8_t c = nameBytes[i];
    if (c == 0) {
      if (started) break;
      continue;
    }
    if (c < 0x20 || c == 0x7F) continue;
    started = true;
    name += char(c);
  }
  name.trim();
  for (size_t i = 0; i < name.length();) {
    const uint8_t c = uint8_t(name[i]);
    if (c < 0x80) { ++i; continue; }
    size_t continuation = c >= 0xC2 && c <= 0xDF ? 1 : c >= 0xE0 && c <= 0xEF ? 2 : c >= 0xF0 && c <= 0xF4 ? 3 : 0;
    if (!continuation || i + continuation >= name.length()) return String();
    const uint8_t second = uint8_t(name[i + 1]);
    if ((second & 0xC0) != 0x80 || (c == 0xE0 && second < 0xA0) ||
        (c == 0xED && second >= 0xA0) || (c == 0xF0 && second < 0x90) ||
        (c == 0xF4 && second > 0x8F)) return String();
    for (size_t j = 2; j <= continuation; ++j) {
      if ((uint8_t(name[i + j]) & 0xC0) != 0x80) return String();
    }
    i += continuation + 1;
  }
  return name;
}

String rawFrameHex(size_t slot, size_t index) {
  String out;
  out.reserve(26);
  for (size_t i = 0; i < titanat::kFrameSize; ++i) {
    char hex[3];
    snprintf(hex, sizeof(hex), "%02X", rawFrames[slot][index][i]);
    out += hex;
  }
  return out;
}

void appendRawFrames(String &body) {
  static const char *keys[] = {"90", "93", "94", "95", "96", "98", "56"};
  body += "\"rawFrames\":{";
  bool first = true;
  for (size_t slot = 0; slot < 7; ++slot) {
    if (!rawCounts[slot]) continue;
    if (!first) body += ',';
    first = false;
    body += '\"'; body += keys[slot]; body += "\":";
    if (slot == 0 || slot == 1 || slot == 2 || slot == 4 || slot == 5) {
      if (rawCounts[slot]) body += '"' + rawFrameHex(slot, rawCounts[slot] - 1) + '"';
      else body += "null";
    } else {
      body += '[';
      for (size_t i = 0; i < rawCounts[slot]; ++i) {
        if (i) body += ',';
        body += '"'; body += rawFrameHex(slot, i); body += '"';
      }
      body += ']';
    }
  }
  body += "},";
}

String buildPayload(uint32_t now) {
  String body;
  body.reserve(1800);
  const bool peerMatches = peerMatchesBoundLocked();
  const bool summaryFresh = peerMatches && lastSummaryAt && uint32_t(now - lastSummaryAt) <= kFreshMs;
  const bool statusFresh = lastStatusAt && uint32_t(now - lastStatusAt) <= kFreshMs;
  const bool cellCountFresh = lastCellCountAt && uint32_t(now - lastCellCountAt) <= kFreshMs;
  const bool temperatureCountFresh = lastTemperatureCountAt && uint32_t(now - lastTemperatureCountAt) <= kFreshMs;
  const bool cellsFresh = cellCountFresh && lastCellsAt && uint32_t(now - lastCellsAt) <= kFreshMs;
  const bool tempsFresh = temperatureCountFresh && lastTemperaturesAt && uint32_t(now - lastTemperaturesAt) <= kFreshMs;
  const bool alarmsFresh = lastAlarmsAt && uint32_t(now - lastAlarmsAt) <= kFreshMs;
  const bool nameFresh = lastNameAt && uint32_t(now - lastNameAt) <= kFreshMs;
  const String ip = WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : String();
  const String mac = boundAddress;
  body += "{\"deviceId\":\"" + jsonEscape(deviceId) + "\",\"bootId\":\"" + bootId;
  body += "\",\"sequence\":" + String(sequence);
  const uint32_t ageMs = summaryFresh ? uint32_t(now - lastSummaryAt) : 0;
  body += ",\"measurementAgeMs\":" + String(ageMs);
  body += ",\"bmsId\":\"" + jsonEscape(mac) + "\",\"firmwareVersion\":\"" + kFirmwareVersion + "\"";
  body += ",\"controlCapabilityVersion\":1,\"wifiSsid\":";
  if (WiFi.status() == WL_CONNECTED) body += '\"' + jsonEscape(WiFi.SSID()) + '\"'; else body += "null";
  body += ",\"bmsLastSeenAgeMs\":";
  const uint32_t bleSeen = lastBleSeenAt;
  const uint32_t bleAge = bleSeen ? uint32_t(now - bleSeen) : UINT32_MAX;
  if (bleSeen && bleAge <= 86400000UL) body += String(bleAge); else body += "null";
  body += ",\"commandAck\":";
  if (!commandAckId.isEmpty()) {
    body += "{\"id\":\"" + jsonEscape(commandAckId) + "\",\"status\":\"" +
      jsonEscape(commandAckStatus) + "\",\"code\":\"" + jsonEscape(commandAckCode) + "\"}";
  } else body += "null";
  body += ",\"wifiRssi\":";
  if (WiFi.status() == WL_CONNECTED) body += String(WiFi.RSSI()); else body += "null";
  body += ",\"bleRssi\":";
  if (bleRssi != -127) body += String(bleRssi); else body += "null";
  const uint64_t uptimeMs = monotonicMs();
  body += ",\"uptimeSeconds\":" + String((unsigned long long)(uptimeMs / 1000));
  body += ",\"uptimeMs\":" + String((unsigned long long)uptimeMs);
  body += ",\"localIp\":";
  if (WiFi.status() == WL_CONNECTED) body += '"' + jsonEscape(ip) + '"'; else body += "null";
  body += ",\"bmsConnected\":" + String(peerMatches ? "true" : "false");
  uint32_t bmsDisconnectedAgeMs = 0;
  const uint64_t payloadMonotonicMs = monotonicMs();
  portENTER_CRITICAL(&bmsDisconnectMux);
  const bool hasBmsDisconnectedAge = bmsDisconnectAge.ageMs(peerMatches, payloadMonotonicMs, bmsDisconnectedAgeMs);
  portEXIT_CRITICAL(&bmsDisconnectMux);
  body += ",\"bmsDisconnectedAgeMs\":";
  if (hasBmsDisconnectedAge) body += String(bmsDisconnectedAgeMs); else body += "null";
  if (!summaryFresh) {
    body += ",\"telemetry\":null}";
    return body;
  }
  body += ",\"telemetry\":{";
  body += "\"socPercent\":"; jsonFloat(body, values.socPercent);
  body += ",\"voltageV\":"; jsonFloat(body, values.voltageV);
  body += ",\"currentA\":"; jsonFloat(body, values.currentA);
  body += ",\"powerW\":"; jsonFloat(body, values.voltageV * fabsf(values.currentA));
  body += ",\"state\":\"";
  const char *state = statusFresh ? (values.state == 1 ? "charging" : values.state == 2 ? "discharging" : values.state == 0 ? "idle" : "unknown") : "unknown";
  body += state; body += "\",\"chargingEnabled\":";
  if (statusFresh && values.chargingEnabledRaw <= 1) body += values.chargingEnabledRaw ? "true" : "false";
  else body += "null";
  body += ",\"dischargingEnabled\":";
  if (statusFresh && values.dischargingEnabledRaw <= 1) body += values.dischargingEnabledRaw ? "true" : "false";
  else body += "null";
  body += ",\"remainingCapacityAh\":";
  if (statusFresh && titanat::validRemainingCapacityMah(values.remainingCapacityMah))
    body += String(values.remainingCapacityMah / 1000.0f, 3);
  else body += "null";
  body += ",\"cellCount\":";
  if (cellCountFresh && values.hasCellCount) body += String(values.cellCount); else body += "null";
  body += ",\"temperatureSensorCount\":";
  if (temperatureCountFresh && values.hasTemperatureCount) body += String(values.temperatureCount); else body += "null";
  body += ",\"cellVoltagesV\":";
  if (cellsFresh && values.hasCellCount) {
    body += '[';
    for (size_t i = 0; i < values.cellCount; ++i) { if (i) body += ','; jsonFloat(body, values.cellVoltagesV[i]); }
    body += ']';
  } else body += "null";
  body += ",\"temperaturesC\":";
  if (tempsFresh && values.hasTemperatureCount) {
    body += '[';
    for (size_t i = 0; i < values.temperatureCount; ++i) { if (i) body += ','; jsonFloat(body, values.temperaturesC[i]); }
    body += ']';
  } else body += "null";
  body += ",\"alarmMaskHex\":";
  if (alarmsFresh) {
    body += '"';
    for (uint8_t b : values.alarmMask) { char hex[3]; snprintf(hex, sizeof(hex), "%02X", b); body += hex; }
    body += '"';
  } else body += "null";
  body += ",\"bmsName\":";
  String name = batteryName();
  if (nameFresh && name.length()) body += '"' + jsonEscape(name) + '"'; else body += "null";
  body += ",\"fieldAgesMs\":{";
  body += "\"summary\":"; appendAge(body, lastSummaryAt, now);
  body += ",\"status\":"; appendAge(body, lastStatusAt, now);
  body += ",\"cells\":"; appendGroupAge(body, lastCellCountAt, lastCellsAt, now);
  body += ",\"temperatures\":"; appendGroupAge(body, lastTemperatureCountAt, lastTemperaturesAt, now);
  body += ",\"alarms\":"; appendAge(body, lastAlarmsAt, now);
  body += ",\"name\":"; appendAge(body, lastNameAt, now);
  body += "},";
  appendRawFrames(body);
  body.remove(body.length() - 1);
  body += "}}";
  return body;
}

String apiUrl() { return serverOrigin + kApiPath; }

bool readBoundedResponse(HTTPClient &http, String &response) {
  const int expected = http.getSize();
  if (expected < 0 || size_t(expected) > kMaxControlResponse) return false;
  Stream *stream = http.getStreamPtr();
  if (!stream) return false;
  response = "";
  response.reserve(size_t(expected));
  const uint32_t started = millis();
  while (response.length() < size_t(expected) && uint32_t(millis() - started) < 6000) {
    const int available = stream->available();
    if (available <= 0) { delay(2); continue; }
    char chunk[256];
    const size_t wanted = min(sizeof(chunk), size_t(expected) - response.length());
    const int got = stream->readBytes(chunk, min(wanted, size_t(available)));
    if (got <= 0) continue;
    response.concat(chunk, size_t(got));
  }
  return response.length() == size_t(expected);
}

bool postBody(const String &body, String &response) {
  if (WiFi.status() != WL_CONNECTED || serverOrigin.isEmpty() || deviceId.isEmpty() || deviceToken.isEmpty()) return false;
  const bool secure = serverOrigin.startsWith("https://");
  WiFiClientSecure tls;
  WiFiClient plain;
  if (secure) {
    tls.setCACert(kRootCa);
    // RSA certificate verification on ESP32 can exceed eight seconds while BLE
    // is active. Keep verification enabled and allow a bounded handshake.
    tls.setHandshakeTimeout(30);
  }
  HTTPClient http;
  const String url = apiUrl();
  if (!(secure ? http.begin(tls, url) : http.begin(plain, url))) return false;
  http.setConnectTimeout(5000);
  http.setTimeout(5000);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", "Bearer " + deviceToken);
  const uint32_t postStartedAt = millis();
  const int status = http.POST(reinterpret_cast<uint8_t *>(const_cast<char *>(body.c_str())), body.length());
  if (status < 0 && secure) {
    char error[160] = {};
    const int tlsStatus = tls.lastError(error, sizeof(error));
    Serial.printf("TLS: error=%d elapsed=%lu ms %s\n", tlsStatus, (unsigned long)(millis() - postStartedAt), error);
    const int hostStart = serverOrigin.indexOf("://") + 3;
    String host = serverOrigin.substring(hostStart);
    const int hostPort = host.indexOf(':');
    if (hostPort >= 0) host = host.substring(0, hostPort);
    IPAddress resolved;
    const int dnsOk = WiFi.hostByName(host.c_str(), resolved);
    Serial.printf("Network: DNS=%d IP=%s epoch=%lld heap=%lu largest=%lu\n", dnsOk,
      resolved.toString().c_str(), (long long)time(nullptr),
      (unsigned long)ESP.getFreeHeap(), (unsigned long)ESP.getMaxAllocHeap());
  }
  const bool responseRead = readBoundedResponse(http, response);
  http.end();
  cJSON *reply = responseRead ? cJSON_ParseWithLength(response.c_str(), response.length()) : nullptr;
  const cJSON *ok = reply ? cJSON_GetObjectItemCaseSensitive(reply, "ok") : nullptr;
  const bool delivered = status >= 200 && status < 300 && cJSON_IsTrue(ok);
  if (reply) cJSON_Delete(reply);
  Serial.printf("API: POST status=%d reply_ok=%d\n", status, delivered ? 1 : 0);
  return delivered;
}

bool jsonText(const cJSON *object, const char *key, String &out, size_t maximum, bool required = true) {
  const cJSON *item = cJSON_GetObjectItemCaseSensitive(object, key);
  if (!item || !cJSON_IsString(item) || !item->valuestring) return !required;
  out = item->valuestring;
  if (out.length() > maximum) return false;
  for (size_t i = 0; i < out.length(); ++i) if (uint8_t(out[i]) < 0x20 || uint8_t(out[i]) == 0x7f) return false;
  return !required || !out.isEmpty();
}

bool jsonTextAllowEmpty(const cJSON *object, const char *key, String &out, size_t maximum) {
  const cJSON *item = cJSON_GetObjectItemCaseSensitive(object, key);
  if (!item || !cJSON_IsString(item) || !item->valuestring) return false;
  out = item->valuestring;
  if (out.length() > maximum) return false;
  for (size_t i = 0; i < out.length(); ++i) if (uint8_t(out[i]) < 0x20 || uint8_t(out[i]) == 0x7f) return false;
  return true;
}

bool validCommandId(const String &id) {
  if (id.isEmpty() || id.length() > 64) return false;
  for (size_t i = 0; i < id.length(); ++i) {
    const char c = id[i];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-')) return false;
  }
  return true;
}

bool validAckStatus(const String &status) {
  return status == "applied" || status == "failed" || status == "rolled-back";
}

bool validAckCode(const String &code) {
  if (code.isEmpty() || code.length() > 60) return false;
  for (size_t i = 0; i < code.length(); ++i) {
    const char c = code[i];
    if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_')) return false;
  }
  return true;
}

bool writeAckRecord(const char *key, const String &id, const String &status, const String &code) {
  cJSON *record = cJSON_CreateObject();
  if (!record) return false;
  const bool fieldsAdded = cJSON_AddStringToObject(record, "id", id.c_str()) &&
    cJSON_AddStringToObject(record, "status", status.c_str()) && cJSON_AddStringToObject(record, "code", code.c_str());
  char *encoded = fieldsAdded ? cJSON_PrintUnformatted(record) : nullptr;
  const size_t length = encoded ? strlen(encoded) : 0;
  const bool stored = encoded && length <= 256 && prefs.putString(key, encoded) == length;
  if (encoded) free(encoded);
  cJSON_Delete(record);
  return stored;
}

bool readAckRecord(const char *key, String &id, String &status, String &code) {
  const String encoded = prefs.getString(key, "");
  if (encoded.isEmpty() || encoded.length() > 256) return false;
  cJSON *record = cJSON_ParseWithLength(encoded.c_str(), encoded.length());
  if (!record) return false;
  const bool valid = jsonText(record, "id", id, 64) && validCommandId(id) &&
    jsonText(record, "status", status, 16) && validAckStatus(status) &&
    jsonText(record, "code", code, 60) && validAckCode(code);
  cJSON_Delete(record);
  return valid;
}

bool persistAck(const String &id, const String &status, const String &code) {
  if (!validCommandId(id) || !validAckStatus(status)) return false;
  String safeCode = code;
  safeCode.toUpperCase();
  safeCode.replace('-', '_');
  if (!validAckCode(safeCode) || !writeAckRecord("cmd-done", id, status, safeCode) ||
      !writeAckRecord("cmd-ack", id, status, safeCode)) return false;
  commandAckId = id;
  commandAckStatus = status;
  commandAckCode = safeCode;
  return true;
}

bool hexDigest(const String &hex, uint8_t digest[32]) {
  if (hex.length() != 64) return false;
  for (size_t i = 0; i < 32; ++i) {
    auto nibble = [](char c) -> int { if (c >= '0' && c <= '9') return c - '0'; if (c >= 'a' && c <= 'f') return c - 'a' + 10; if (c >= 'A' && c <= 'F') return c - 'A' + 10; return -1; };
    const int high = nibble(hex[i * 2]), low = nibble(hex[i * 2 + 1]);
    if (high < 0 || low < 0) return false;
    digest[i] = uint8_t((high << 4) | low);
  }
  return true;
}

bool verifyFirmwareSignature(const String &digestHex, const String &signatureB64) {
  uint8_t digest[32], signature[96];
  size_t signatureLength = 0;
  if (!hexDigest(digestHex, digest) || signatureB64.isEmpty() || signatureB64.length() > 160) return false;
  if (mbedtls_base64_decode(signature, sizeof(signature), &signatureLength,
                            reinterpret_cast<const unsigned char *>(signatureB64.c_str()), signatureB64.length()) != 0) return false;
  mbedtls_pk_context key;
  mbedtls_pk_init(&key);
  const int parsed = mbedtls_pk_parse_public_key(&key,
      reinterpret_cast<const unsigned char *>(kFirmwarePublicKey), sizeof(kFirmwarePublicKey));
  const int verified = parsed == 0 && mbedtls_pk_can_do(&key, MBEDTLS_PK_ECDSA) &&
      mbedtls_pk_verify(&key, MBEDTLS_MD_SHA256, digest, sizeof(digest), signature, signatureLength) == 0;
  mbedtls_pk_free(&key);
  return verified;
}

bool parseVersion(const String &text, uint32_t parts[3]) {
  size_t field = 0, start = 0;
  while (field < 3) {
    const int dot = text.indexOf('.', start);
    const size_t end = dot < 0 ? text.length() : size_t(dot);
    if (end == start || end - start > 3 || (end - start > 1 && text[start] == '0')) return false;
    uint32_t value = 0;
    for (size_t i = start; i < end; ++i) {
      if (text[i] < '0' || text[i] > '9') return false;
      value = value * 10 + uint32_t(text[i] - '0');
      if (value > 999) return false;
    }
    parts[field++] = value;
    if (dot < 0) return field == 3;
    start = size_t(dot) + 1;
  }
  return false;
}

bool newerVersion(const String &candidate, const String &current) {
  uint32_t a[3], b[3];
  if (!parseVersion(candidate, a) || !parseVersion(current, b)) return false;
  for (size_t i = 0; i < 3; ++i) { if (a[i] != b[i]) return a[i] > b[i]; }
  return false;
}

bool storeOtaPending(const String &id, const String &version, uint32_t partitionAddress) {
  if (!validCommandId(id) || version.isEmpty() || version.length() > 16) return false;
  uint8_t blob[7 + 64 + 16];
  blob[0] = 0xA7; blob[1] = uint8_t(id.length()); blob[2] = uint8_t(version.length());
  blob[3] = uint8_t(partitionAddress); blob[4] = uint8_t(partitionAddress >> 8);
  blob[5] = uint8_t(partitionAddress >> 16); blob[6] = uint8_t(partitionAddress >> 24);
  memcpy(blob + 7, id.c_str(), id.length());
  memcpy(blob + 7 + id.length(), version.c_str(), version.length());
  const size_t size = 7 + id.length() + version.length();
  return prefs.putBytes("ota-pending", blob, size) == size;
}

void loadOtaPending() {
  otaPendingId = otaPendingVersion = "";
  otaPendingAddress = 0;
  const size_t size = prefs.getBytesLength("ota-pending");
  uint8_t blob[7 + 64 + 16];
  if (size < 7 || size > sizeof(blob) || prefs.getBytes("ota-pending", blob, size) != size ||
      blob[0] != 0xA7 || blob[1] == 0 || blob[1] > 64 || blob[2] == 0 || blob[2] > 16 || size != size_t(7 + blob[1] + blob[2])) {
    if (size) prefs.remove("ota-pending");
    return;
  }
  otaPendingId = String(reinterpret_cast<char *>(blob + 7), blob[1]);
  otaPendingVersion = String(reinterpret_cast<char *>(blob + 7 + blob[1]), blob[2]);
  if (!validCommandId(otaPendingId)) { otaPendingId = otaPendingVersion = ""; prefs.remove("ota-pending"); return; }
  otaPendingAddress = uint32_t(blob[3]) | (uint32_t(blob[4]) << 8) | (uint32_t(blob[5]) << 16) | (uint32_t(blob[6]) << 24);
}

void clearOtaPending() {
  prefs.remove("ota-pending");
  otaPendingId = otaPendingVersion = "";
  otaPendingAddress = 0;
}

bool runFirmwareUpdate(const String &id, const String &version, const String &url,
                       const String &digest, uint32_t imageSize, const String &signature) {
  if (!timeReady() || !serverOrigin.startsWith("https://") || !newerVersion(version, kFirmwareVersion) || !validCommandId(deviceId) ||
      imageSize == 0 || imageSize > 1966080UL || !verifyFirmwareSignature(digest, signature)) return false;
  String expectedUrl = serverOrigin + "/api/devices/battery-firmware?deviceId=" + deviceId + "&release=gateway-" + version;
  if (url != expectedUrl) return false;
  const esp_partition_t *next = esp_ota_get_next_update_partition(nullptr);
  if (!next || imageSize > next->size) return false;

  WiFiClientSecure tls;
  tls.setCACert(kRootCa);
  tls.setHandshakeTimeout(30);
  HTTPClient http;
  if (!http.begin(tls, url)) return false;
  http.setConnectTimeout(5000);
  http.setTimeout(8000);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  http.addHeader("Authorization", "Bearer " + deviceToken);
  const int status = http.GET();
  const int contentLength = http.getSize();
  if (status != HTTP_CODE_OK || contentLength < 0 || uint32_t(contentLength) != imageSize ||
      !Update.begin(imageSize, U_FLASH) || !Update.setSHA256(digest.c_str())) {
    http.end();
    Update.abort();
    return false;
  }
  Stream *stream = http.getStreamPtr();
  uint32_t received = 0;
  uint8_t buffer[1024];
  const uint32_t started = millis();
  while (stream && received < imageSize && uint32_t(millis() - started) < 300000UL) {
    const int available = stream->available();
    if (available <= 0) { delay(2); continue; }
    const size_t wanted = min(sizeof(buffer), size_t(imageSize - received));
    const int got = stream->readBytes(buffer, min(wanted, size_t(available)));
    if (got <= 0 || Update.write(buffer, size_t(got)) != size_t(got)) break;
    received += size_t(got);
  }
  http.end();
  if (received != imageSize || !storeOtaPending(id, version, next->address)) { Update.abort(); return false; }
  if (!Update.end(true) || !Update.isFinished()) { clearOtaPending(); Update.abort(); return false; }
  ESP.restart();
  return true;
}

void startWifiTrial(const String &id, const String &ssid, const String &password) {
  if (wifiTrialActive || ssid.isEmpty() || ssid.length() > 32 || password.length() > 63 ||
      (!password.isEmpty() && password.length() < 8) || (ssid == wifiSsid && password == wifiPassword)) {
    persistAck(id, "failed", "wifi-config-invalid");
    return;
  }
  wifiPreviousSsid = wifiSsid;
  wifiPreviousPassword = wifiPassword;
  wifiTrialSsid = ssid;
  wifiTrialPassword = password;
  wifiTrialId = id;
  if (prefs.putString("wifi-trial-id", id) != id.length()) {
    persistAck(id, "failed", "wifi-state-storage-failed");
    return;
  }
  wifiTrialActive = true;
  wifiTrialStartedAt = millis();
  WiFi.disconnect(false, false);
  beginWifi();
  Serial.println("Control: Wi-Fi trial started");
}

void confirmWifiTrial() {
  if (!wifiTrialActive) return;
  const String id = wifiTrialId;
  // Store the command ID in the same atomic active-credentials blob. Startup
  // can tell a committed change from an interrupted trial if power fails now.
  if (!saveWifi(wifiTrialSsid, wifiTrialPassword, id)) { rollbackWifiTrial(); return; }
  prefs.remove("wifi-trial-id");
  wifiTrialActive = false;
  wifiTrialId = wifiTrialSsid = wifiTrialPassword = wifiPreviousSsid = wifiPreviousPassword = "";
  persistAck(id, "applied", "wifi-connected");
  Serial.println("Control: Wi-Fi trial confirmed");
}

void rollbackWifiTrial() {
  if (!wifiTrialActive) return;
  const String id = wifiTrialId;
  WiFi.disconnect(false, false);
  wifiTrialActive = false;
  wifiTrialId = wifiTrialSsid = wifiTrialPassword = "";
  wifiSsid = wifiPreviousSsid;
  wifiPassword = wifiPreviousPassword;
  wifiPreviousSsid = wifiPreviousPassword = "";
  prefs.remove("wifi-trial-id");
  lastWifiAttemptAt = 0;
  beginWifi();
  persistAck(id, "rolled-back", "wifi-trial-timeout");
  Serial.println("Control: Wi-Fi trial rolled back");
}

void handleControlResponse(const String &response) {
  if (response.isEmpty() || response.length() > kMaxControlResponse) return;
  cJSON *root = cJSON_ParseWithLength(response.c_str(), response.length());
  if (!root) return;
  String acceptedId;
  if (jsonText(root, "ackAccepted", acceptedId, 64, false) && !acceptedId.isEmpty() && acceptedId == commandAckId) {
    prefs.remove("cmd-ack");
    commandAckId = commandAckStatus = commandAckCode = "";
  }
  const cJSON *command = cJSON_GetObjectItemCaseSensitive(root, "command");
  if (!command || cJSON_IsNull(command) || wifiTrialActive || !cJSON_IsObject(command)) { cJSON_Delete(root); return; }
  String id, kind;
  const cJSON *expires = cJSON_GetObjectItemCaseSensitive(command, "expiresAt");
  if (!jsonText(command, "id", id, 64) || !validCommandId(id) || !jsonText(command, "kind", kind, 32) ||
      !cJSON_IsNumber(expires) || expires->valuedouble < double(time(nullptr)) * 1000.0 ||
      expires->valuedouble > (double(time(nullptr)) + 86400.0) * 1000.0 || floor(expires->valuedouble) != expires->valuedouble) {
    cJSON_Delete(root); return;
  }
  if (!commandAckId.isEmpty() && id != commandAckId) { cJSON_Delete(root); return; }
  String doneId, doneStatus, doneCode;
  const bool hasDoneRecord = readAckRecord("cmd-done", doneId, doneStatus, doneCode);
  if (id == commandAckId || (hasDoneRecord && id == doneId)) {
    if (commandAckId.isEmpty() && hasDoneRecord && id == doneId && writeAckRecord("cmd-ack", doneId, doneStatus, doneCode)) {
      commandAckId = doneId;
      commandAckStatus = doneStatus;
      commandAckCode = doneCode;
    }
    cJSON_Delete(root); return;
  }
  if (kind == "wifi-config" && !serverOrigin.startsWith("https://")) {
    persistAck(id, "failed", "wifi-config-requires-https");
    cJSON_Delete(root); return;
  }
  const cJSON *payload = cJSON_GetObjectItemCaseSensitive(command, "payload");
  if (!payload || !cJSON_IsObject(payload)) { cJSON_Delete(root); return; }
  if (kind == "wifi-config") {
    String ssid, password;
    if (jsonText(payload, "ssid", ssid, 32) && jsonTextAllowEmpty(payload, "password", password, 63)) {
      if (ssid == wifiSsid && password == wifiPassword) persistAck(id, "applied", "wifi-already-active");
      else startWifiTrial(id, ssid, password);
    }
    else persistAck(id, "failed", "wifi-config-invalid");
  } else if (kind == "firmware-update") {
    String version, url, sha256, signature;
    const cJSON *size = cJSON_GetObjectItemCaseSensitive(payload, "size");
    bool parsed = jsonText(payload, "version", version, 16) && jsonText(payload, "url", url, 512) &&
      jsonText(payload, "sha256", sha256, 64) && jsonText(payload, "signature", signature, 160) &&
      cJSON_IsNumber(size) && size->valuedouble >= 1 && size->valuedouble <= 1966080 && floor(size->valuedouble) == size->valuedouble;
    if (!parsed) persistAck(id, "failed", "firmware-command-invalid");
    else if (!runFirmwareUpdate(id, version, url, sha256, uint32_t(size->valuedouble), signature))
      persistAck(id, "failed", "firmware-update-failed");
  } else persistAck(id, "failed", "command-unsupported");
  cJSON_Delete(root);
}

void confirmPendingFirmware() {
  if (otaPendingId.isEmpty()) return;
  const esp_partition_t *running = esp_ota_get_running_partition();
  if (!running || running->address != otaPendingAddress || otaPendingVersion != kFirmwareVersion) {
    if (persistAck(otaPendingId, "rolled-back", "firmware-version-not-running")) clearOtaPending();
    return;
  }
  esp_ota_img_states_t state;
  const esp_err_t stateResult = esp_ota_get_state_partition(running, &state);
  if (stateResult == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY) {
    if (esp_ota_mark_app_valid_cancel_rollback() != ESP_OK) return;
  }
  if (!persistAck(otaPendingId, "applied", "firmware-running")) return;
  clearOtaPending();
}

void startTimeSync() {
  if (clockSyncStarted || WiFi.status() != WL_CONNECTED) return;
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  clockSyncStarted = true;
}

bool timeReady() { return time(nullptr) > 1760000000; }

void attemptPost() {
  if (serverOrigin.isEmpty() || deviceId.isEmpty() || deviceToken.isEmpty() || boundAddress.length() != 17 || WiFi.status() != WL_CONNECTED) return;
  lastHeartbeatAt = millis();
  if (serverOrigin.startsWith("https://") && !timeReady()) {
    startTimeSync();
    return;
  }
  if (!dataMutex || xSemaphoreTake(dataMutex, pdMS_TO_TICKS(100)) != pdTRUE) return;
  const String body = buildPayload(millis());
  xSemaphoreGive(dataMutex);
  String response;
  const bool delivered = postBody(body, response);
  if (delivered) {
    if (wifiTrialActive) confirmWifiTrial();
    confirmPendingFirmware();
    handleControlResponse(response);
  }
}

bool saveWifi(const String &ssid, const String &password, const String &committedCommandId) {
  if (ssid.isEmpty() || ssid.length() > 32 || password.length() > 63 ||
      (!committedCommandId.isEmpty() && !validCommandId(committedCommandId))) return false;
  uint8_t packed[4 + 32 + 63 + 64];
  packed[0] = 0xB2; packed[1] = uint8_t(ssid.length()); packed[2] = uint8_t(password.length());
  packed[3] = uint8_t(committedCommandId.length());
  memcpy(packed + 4, ssid.c_str(), ssid.length());
  memcpy(packed + 4 + ssid.length(), password.c_str(), password.length());
  memcpy(packed + 4 + ssid.length() + password.length(), committedCommandId.c_str(), committedCommandId.length());
  const size_t packedSize = 4 + ssid.length() + password.length() + committedCommandId.length();
  if (prefs.putBytes("wifi-active", packed, packedSize) != packedSize) return false;
  // Keep the legacy keys synchronized for USB/older-firmware recovery. The
  // atomic packed entry is authoritative to this firmware on the next boot.
  prefs.putString("ssid", ssid);
  prefs.putString("password", password);
  wifiSsid = ssid;
  wifiPassword = password;
  wifiActiveCommandId = committedCommandId;
  lastWifiAttemptAt = 0;
  return true;
}

void loadWifi() {
  const size_t stored = prefs.getBytesLength("wifi-active");
  uint8_t packed[4 + 32 + 63 + 64];
  if (stored >= 4 && stored <= sizeof(packed) && prefs.getBytes("wifi-active", packed, stored) == stored && packed[0] == 0xB2 &&
      packed[1] <= 32 && packed[2] <= 63 && packed[3] <= 64 && stored == size_t(4 + packed[1] + packed[2] + packed[3])) {
    wifiSsid = String(reinterpret_cast<char *>(packed + 4), packed[1]);
    wifiPassword = String(reinterpret_cast<char *>(packed + 4 + packed[1]), packed[2]);
    wifiActiveCommandId = String(reinterpret_cast<char *>(packed + 4 + packed[1] + packed[2]), packed[3]);
    return;
  }
  if (stored >= 2 && stored <= 2 + 32 + 63 && prefs.getBytes("wifi-active", packed, stored) == stored &&
      packed[0] <= 32 && packed[1] <= 63 && stored == size_t(2 + packed[0] + packed[1])) {
    wifiSsid = String(reinterpret_cast<char *>(packed + 2), packed[0]);
    wifiPassword = String(reinterpret_cast<char *>(packed + 2 + packed[0]), packed[1]);
    wifiActiveCommandId = "";
    saveWifi(wifiSsid, wifiPassword);
    return;
  }
  wifiSsid = prefs.getString("ssid", "");
  wifiPassword = prefs.getString("password", "");
  wifiActiveCommandId = "";
  if (!wifiSsid.isEmpty() && wifiSsid.length() <= 32 && wifiPassword.length() <= 63) saveWifi(wifiSsid, wifiPassword);
}

void beginWifi() {
  const String &targetSsid = wifiTrialActive ? wifiTrialSsid : wifiSsid;
  const String &targetPassword = wifiTrialActive ? wifiTrialPassword : wifiPassword;
  if (targetSsid.isEmpty()) return;
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(targetSsid.c_str(), targetPassword.c_str());
  lastWifiAttemptAt = millis();
  Serial.println("WiFi: connection requested");
}

void beginPollCycle() {
  if (!txCharacteristic || !client || !client->isConnected()) return;
  if (!dataMutex || xSemaphoreTake(dataMutex, pdMS_TO_TICKS(100)) != pdTRUE) return;
  resetCycleFrames();
  xSemaphoreGive(dataMutex);
  cycleActive = true;
  commandIndex = 0;
  lastPollStartedAt = millis();
  nextCommandAt = lastPollStartedAt;
}

void sendNextRead() {
  if (!cycleActive || int32_t(millis() - nextCommandAt) < 0) return;
  if (commandIndex >= sizeof(kCommands)) {
    cycleActive = false;
    attemptPost();
    return;
  }
  const uint8_t cmd = kCommands[commandIndex++];
  uint8_t request[13] = {0xFA, 0x40, cmd, 0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0};
  for (size_t i = 0; i < 12; ++i) request[12] = uint8_t(request[12] + request[i]);
  txCharacteristic->writeValue(request, sizeof(request), false);
  nextCommandAt = millis() + kCommandGapMs;
}

void startPresenceScan() {
  if (!scanner || !monitorEnabled || !validMacAddress(boundAddress) || connectedPeerMatchesBound()) return;
  if (scanner->isScanning()) { presenceScanActive = true; return; }
  scanner->setMaxResults(32);
  scanner->setScanCallbacks(&presenceScanCallbacks, true);
  presenceScanActive = scanner->start(0, false, true);
}

bool connectBoundBms() {
  if (!validMacAddress(boundAddress) || !dataMutex) return false;
  if (client && client->isConnected()) {
    if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(100)) != pdTRUE) return false;
    const bool alreadyBound = peerMatchesBoundLocked();
    xSemaphoreGive(dataMutex);
    if (alreadyBound && txCharacteristic) {
      disconnectedEvent = false;
      return true;
    }
    txCharacteristic = nullptr;
    cycleActive = false;
    lastPollStartedAt = 0;
    client->disconnect();
  }
  // NimBLE scan durations are milliseconds. Keep the scan-owned device alive
  // until connect() returns; clearResults() invalidates its pointer.
  if (scanner->isScanning()) scanner->stop();
  presenceScanActive = false;
  NimBLEScanResults results = scanner->getResults(3000, false);
  const NimBLEAdvertisedDevice *target = nullptr;
  {
    for (int i = 0; i < results.getCount(); ++i) {
      const NimBLEAdvertisedDevice *device = results.getDevice(i);
      String address = device->getAddress().toString().c_str();
      address.toLowerCase();
      if (address == boundAddress) { target = device; break; }
    }
  }
  if (!target) { scanner->clearResults(); return false; }
  const int8_t targetRssi = int8_t(target->getRSSI());
  if (!client) {
    client = NimBLEDevice::createClient();
    if (!client) { scanner->clearResults(); return false; }
    client->setClientCallbacks(&clientEvents, false);
    client->setConnectTimeout(10000);
  }
  if (client->isConnected()) client->disconnect();
  const bool connected = client->connect(target);
  scanner->clearResults();
  if (!connected) return false;
  NimBLERemoteService *service = client->getService(NimBLEUUID(uint16_t(0xFFF0)));
  NimBLERemoteCharacteristic *rx = service ? service->getCharacteristic(NimBLEUUID(uint16_t(0xFFF1))) : nullptr;
  txCharacteristic = service ? service->getCharacteristic(NimBLEUUID(uint16_t(0xFFF2))) : nullptr;
  if (!rx || !txCharacteristic || !txCharacteristic->canWriteNoResponse() || !(rx->canNotify() || rx->canIndicate())) {
    client->disconnect();
    return false;
  }
  if (!rx->subscribe(rx->canNotify(), notification, true)) {
    client->disconnect();
    return false;
  }
  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(100)) != pdTRUE) {
    client->disconnect();
    return false;
  }
  clearTelemetryLocked(true);
  bleRssi = targetRssi;
  xSemaphoreGive(dataMutex);
  disconnectedEvent = false;
  cycleActive = false;
  lastPollStartedAt = 0;
  Serial.println("BLE: battery connected; read-only polling enabled");
  return true;
}

void printHelp() {
  Serial.println("Commands: wifi SSID|PASSWORD; monitor MAC; stop-monitor; server URL|DEVICE_ID|TOKEN; clear-server; status");
}

void handleCommand(String line) {
  line.trim();
  if (line.startsWith("wifi ")) {
    const int separator = line.indexOf('|', 5);
    if (separator < 6) { Serial.println("ERROR: use wifi SSID|PASSWORD"); return; }
    if (wifiTrialActive) rollbackWifiTrial();
    if (!saveWifi(line.substring(5, separator), line.substring(separator + 1))) {
      Serial.println("ERROR: Wi-Fi values exceed supported lengths or storage is unavailable"); return;
    }
    Serial.println("WiFi configuration saved");
    beginWifi();
  } else if (line.startsWith("monitor ")) {
    String address = line.substring(8);
    address.trim(); address.toLowerCase();
    if (!validMacAddress(address)) { Serial.println("ERROR: use monitor AA:BB:CC:DD:EE:FF"); return; }
    if (address != boundAddress) {
      // Disconnect outside the callback snapshot mutex. Old notifications are
      // rejected by peerMatchesBoundLocked() once the new address is installed.
      if (client && client->isConnected()) client->disconnect();
      txCharacteristic = nullptr;
      cycleActive = false;
      lastPollStartedAt = 0;
      if (!dataMutex || xSemaphoreTake(dataMutex, pdMS_TO_TICKS(100)) != pdTRUE) {
        Serial.println("ERROR: telemetry snapshot busy; monitor address unchanged");
        return;
      }
      clearTelemetryLocked(false);
      lastBleSeenAt = 0;
      boundAddress = address;
      setDisconnectBinding(boundAddress);
      xSemaphoreGive(dataMutex);
      lastHeartbeatAt = 0;
    }
    prefs.putString("bms-address", boundAddress);
    prefs.putBool("monitor", true);
    monitorEnabled = true;
    bool peerBound = false;
    peerBound = connectedPeerMatchesBound();
    connectRequested = !peerBound;
    Serial.println("BLE monitor saved");
  } else if (line == "stop-monitor") {
    monitorEnabled = false;
    prefs.putBool("monitor", false);
    if (client && client->isConnected()) client->disconnect();
    Serial.println("BLE monitor stopped");
  } else if (line.startsWith("server ")) {
    const int first = line.indexOf('|', 7);
    const int second = first >= 0 ? line.indexOf('|', first + 1) : -1;
    if (first < 0 || second < 0) { Serial.println("ERROR: use server URL|DEVICE_ID|TOKEN"); return; }
    String origin = trimOrigin(line.substring(7, first));
    String id = line.substring(first + 1, second); id.trim();
    String token = line.substring(second + 1); token.trim();
    if (!validServerOrigin(origin) || id.isEmpty() || token.isEmpty()) {
      Serial.println("ERROR: HTTPS required; HTTP allowed only for private IPv4 or .local hosts"); return;
    }
    serverOrigin = origin; deviceId = id; deviceToken = token;
    prefs.putString("server-url", serverOrigin);
    prefs.putString("device-id", deviceId);
    prefs.putString("device-token", deviceToken);
    Serial.println("Telemetry server configuration saved");
  } else if (line == "clear-server") {
    prefs.remove("server-url"); prefs.remove("device-id"); prefs.remove("device-token");
    serverOrigin = deviceId = deviceToken = "";
    Serial.println("Telemetry server configuration cleared");
  } else if (line == "status") {
    uint32_t currentSequence = 0;
    if (dataMutex && xSemaphoreTake(dataMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
      currentSequence = sequence;
      xSemaphoreGive(dataMutex);
    }
    const esp_partition_t *runningPartition = esp_ota_get_running_partition();
    Serial.printf("WiFi=%s IP=%s RSSI=%d BLE=%s monitor=%s API=%s seq=%lu app=%s\n",
      WiFi.status() == WL_CONNECTED ? "connected" : "disconnected",
      WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString().c_str() : "-",
      WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0,
      client && client->isConnected() ? "connected" : "disconnected",
      monitorEnabled ? "on" : "off", serverOrigin.isEmpty() ? "not-configured" : "configured", (unsigned long)currentSequence,
      runningPartition ? runningPartition->label : "unknown");
  } else printHelp();
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.printf("START battery telemetry gateway %s (read-only)\n", kFirmwareVersion);
  dataMutex = xSemaphoreCreateMutex();
  prefs.begin("start-bms", false);
  // The pre-1.1.2 firmware used split ACK keys. Ignore/remove the short legacy
  // ID keys; the oversized status/code keys could not be stored by NVS.
  prefs.remove("command-ack-id");
  prefs.remove("command-done-id");
  loadWifi();
  boundAddress = prefs.getString("bms-address", "");
  setDisconnectBinding(boundAddress);
  monitorEnabled = prefs.getBool("monitor", false);
  serverOrigin = prefs.getString("server-url", "");
  deviceId = prefs.getString("device-id", "");
  deviceToken = prefs.getString("device-token", "");
  if (!readAckRecord("cmd-ack", commandAckId, commandAckStatus, commandAckCode)) {
    prefs.remove("cmd-ack");
    commandAckId = commandAckStatus = commandAckCode = "";
  }
  String doneId, doneStatus, doneCode;
  if (!readAckRecord("cmd-done", doneId, doneStatus, doneCode)) prefs.remove("cmd-done");
  loadOtaPending();
  const esp_partition_t *runningPartition = esp_ota_get_running_partition();
  if (!otaPendingId.isEmpty() && (!runningPartition || runningPartition->address != otaPendingAddress || otaPendingVersion != kFirmwareVersion)) {
    if (persistAck(otaPendingId, "rolled-back", "firmware-version-not-running")) clearOtaPending();
  }
  const String interruptedWifiTrial = prefs.getString("wifi-trial-id", "");
  if (!interruptedWifiTrial.isEmpty()) {
    const bool committed = interruptedWifiTrial == wifiActiveCommandId;
    prefs.remove("wifi-trial-id");
    persistAck(interruptedWifiTrial, committed ? "applied" : "rolled-back",
               committed ? "wifi-connected" : "wifi-trial-interrupted");
  }
  uint32_t randomParts[4];
  for (uint8_t i = 0; i < 4; ++i) randomParts[i] = esp_random();
  snprintf(bootId, sizeof(bootId), "%08lx%08lx", (unsigned long)randomParts[0], (unsigned long)randomParts[1]);
  WiFi.mode(WIFI_STA);
  if (!wifiSsid.isEmpty()) beginWifi();
  NimBLEDevice::init("START-BMS-GATEWAY");
  scanner = NimBLEDevice::getScan();
  scanner->setActiveScan(true);
  scanner->setInterval(160);
  scanner->setWindow(80);
  scanner->setMaxResults(32);
  scanner->setScanCallbacks(&presenceScanCallbacks, true);
  connectRequested = monitorEnabled && boundAddress.length() == 17;
  printHelp();
}

void loop() {
  while (Serial.available()) {
    const char c = char(Serial.read());
    if (c == '\n') { handleCommand(serialLine); serialLine = ""; }
    else if (c != '\r' && serialLine.length() < 256) serialLine += c;
    else if (serialLine.length() >= 256) serialLine = "";
  }

  const uint32_t now = millis();
  if (disconnectedEvent) {
    disconnectedEvent = false;
    txCharacteristic = nullptr;
    cycleActive = false;
    lastPollStartedAt = 0;
    uint32_t disconnectAgeMs = 0;
    const uint64_t eventMonotonicMs = monotonicMs();
    portENTER_CRITICAL(&bmsDisconnectMux);
    const bool isTrackedDisconnect = bmsDisconnectAge.ageMs(false, eventMonotonicMs, disconnectAgeMs);
    portEXIT_CRITICAL(&bmsDisconnectMux);
    if (isTrackedDisconnect) attemptPost();
  }
  if (wifiTrialActive && uint32_t(now - wifiTrialStartedAt) >= kWifiTrialMs) rollbackWifiTrial();
  if (WiFi.status() != WL_CONNECTED && !wifiSsid.isEmpty() && uint32_t(now - lastWifiAttemptAt) >= 15000) beginWifi();
  if (WiFi.status() == WL_CONNECTED) startTimeSync();
  const bool peerBoundBeforeConnect = connectedPeerMatchesBound();
  if (connectRequested || (monitorEnabled && (!peerBoundBeforeConnect || !txCharacteristic) &&
                           uint32_t(now - lastConnectAttemptAt) >= 15000)) {
    connectRequested = false;
    lastConnectAttemptAt = now;
    if (!connectBoundBms()) Serial.println("BLE: battery not found; retrying");
  }
  const bool peerBoundAfterConnect = connectedPeerMatchesBound();
  if (monitorEnabled && peerBoundAfterConnect && txCharacteristic) {
    if (!cycleActive && (!lastPollStartedAt || uint32_t(now - lastPollStartedAt) >= kPollMs)) beginPollCycle();
    sendNextRead();
    // Connecting and writing can block; use a timestamp taken after those calls.
    // The loop's earlier timestamp can precede connectedAt and underflow the age.
    if (summaryTimedOut()) {
      Serial.println("BLE: no valid BMS data for 45 seconds; reconnecting");
      client->disconnect();
      lastPollStartedAt = 0;
    }
  }
  const uint32_t heartbeatInterval = monitorEnabled && !peerBoundAfterConnect ? kDisconnectedHeartbeatMs : kPollMs;
  if (serverOrigin.length() && boundAddress.length() == 17 && WiFi.status() == WL_CONNECTED && !cycleActive &&
      uint32_t(millis() - lastHeartbeatAt) >= heartbeatInterval) attemptPost();
  if (!peerBoundAfterConnect) startPresenceScan();
  delay(5);
}
