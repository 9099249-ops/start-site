# START BMS ESP32 gateway

The ESP32 reads the Titanat BLE telemetry frames and posts snapshots to the START battery dashboard. The firmware sends only the observed read requests (`0x90`, `0x93`, `0x94`, `0x95`, `0x96`, `0x98`, and `0x56`). It does not send configuration or control writes to the BMS.

## Build and upload

Use Arduino IDE with ESP32 boards package **3.3.12**, **NimBLE-Arduino 2.5.1** from Library Manager, board **ESP32 Dev Module**, partition scheme **min_spiffs** (4 MB flash), and 115200 baud for Serial Monitor. Open `esp32-bms-gateway.ino` and upload it over USB. Version 1.1.0 is the first USB-installed control-capable bridge; version 1.1.1 is the OTA test release; version 1.1.2 stores complete command acknowledgements atomically in bounded NVS records.

To compile from a terminal with Arduino CLI:

```powershell
arduino-cli lib install NimBLE-Arduino@2.5.1
arduino-cli compile --fqbn esp32:esp32:esp32:PartitionScheme=min_spiffs firmware/esp32-bms-gateway
```

## Initial setup

Open Serial Monitor at 115200 baud and send these newline-terminated commands:

```text
wifi YOUR_WIFI_NAME|YOUR_WIFI_PASSWORD
server https://spotsup.ru|YOUR_DEVICE_ID|YOUR_DEVICE_TOKEN
monitor 41:18:12:01:37:50
```

The server value is the HTTPS origin; the firmware appends `/api/devices/battery-telemetry`. A private LAN endpoint may use `http://` only when its host is an RFC1918 IPv4 address or ends in `.local`. HTTPS validates the current `spotsup.ru` certificate chain against the embedded GlobalSign Root R46 and waits for NTP time before posting. Do not use HTTP over the public internet.

The commands store Wi-Fi settings under the existing Preferences namespace `start-bms` (`ssid`, `password`, `monitor`, and `bms-address`) and store the telemetry server URL, device ID, and token in Preferences. The gateway does not print credential values. Serial input itself is visible on some terminals, so avoid recording the session while entering the token. Use `status` to check connection state without exposing credentials. `stop-monitor` disables polling; `clear-server` removes the server credentials.

## Remote administration and OTA

The firmware accepts at most one command from the JSON response to an authenticated telemetry POST. Supported command kinds are `wifi-config` and `firmware-update`; arbitrary text, shell commands, and arbitrary download origins are not accepted. Command identifiers and acknowledgements are retained in NVS so retries and rebooted devices can report the same result. The server must return an `ackAccepted` identifier after storing a matching acknowledgement before the firmware clears its pending acknowledgement.

A remote Wi-Fi change is a two-minute trial. Existing credentials remain active in NVS while the new network is tested. The new credentials become active only after an authenticated telemetry POST succeeds over that network. If the trial expires or power is lost before the new credentials are atomically committed, startup uses the old credentials and reports a rollback when it reconnects. A commit records the command ID with the active credential pair so a reboot between commit and acknowledgement is reported as applied. Wi-Fi SSID is included in health telemetry; the password is never transmitted in telemetry or printed.

Firmware OTA accepts a strictly newer numeric `major.minor.patch` release (no prerelease tags) from this device's configured HTTPS origin, at `/api/devices/battery-firmware?deviceId=…&release=gateway-{version}`. The command carries an image size, SHA-256 digest, and base64 DER ECDSA-P256 signature over that digest. The device checks the signature against the public key compiled into the sketch, checks the exact URL and inactive partition capacity, disables redirects, authenticates the download with the device token, and lets `Update` verify the streamed SHA-256 before activating the slot. It does not update SPIFFS. The OTA transaction records its command ID, version, and target slot atomically before activating that slot; the app reports success only after booting from that slot and completing an authenticated POST. Server command delivery and firmware download routes must be available before the dashboard can use these controls.

The standard `min_spiffs` partition table has two OTA application slots, but the ESP32 bootloader rollback feature is a separate build configuration and is not guaranteed by the Arduino partition choice alone. Until the deployed bootloader is confirmed to support rollback and recovery is tested, retain USB access as the recovery path. A failed first OTA cannot be assumed to self-recover on every board.

After reboot, saved Wi-Fi, server, and monitor settings load automatically. If the phone app still has an active BLE session, disconnect it so the ESP32 can connect to the BMS. Keep the ESP32 near the battery for initial binding and reconnect checks. If the battery is not found, verify the MAC address with the diagnostic sketch and send `monitor MAC` again. Changing the bound MAC disconnects the old peer, clears its cached telemetry and starts freshness tracking from the new connection; values from the previous BMS are never attributed to the new address.

Use one ESP32 gateway and one BMS MAC/device token per battery. For several batteries, configure each gateway independently with its own dashboard device ID and token.

## Telemetry and protocol limits

The protocol is the captured Titanat `FA` frame variant: 13 bytes, header `FA`, reply address `01`, command, payload size `08`, eight payload bytes, then the additive sum of bytes 0–11 modulo 256. The decoder carries partial notification bytes between callbacks and accepts multiple frames in one notification. Invalid checksums are skipped while searching for the next frame header.

- `0x90`: pack voltage and SOC are big-endian tenths; current is `(raw - 30000) / 10`. The observed positive current and state `1` mean charging. Reported power is `voltage × abs(current)`.
- `0x93`: state, charge MOS, discharge MOS, and big-endian remaining capacity in mAh. Unknown state values become `unknown`.
- `0x94`: cell count and temperature sensor count, bounded to 32 and 16.
- `0x95`: one-based frame index and three big-endian millivolt values. The dashboard array is clipped to the declared cell count; `FFFF` is null.
- `0x96`: one-based frame index and six temperatures with a 40 degree offset; `FF` is null. Values are clipped to the declared sensor count.
- `0x98`: the eight bytes are transported as an opaque hexadecimal mask. The dashboard does not assign alarm names or severities.
- `0x56`: five indexed frames are joined as seven name bytes per frame; null termination and control bytes are removed.

The `0x93` cycle-like byte and undocumented `0x94` bytes are not exposed as decoded values. This battery capture's cell count is four while `0x95` returns multiple three-cell fragments; only the first four indexed slots are reported. Fields older than 45 seconds become null. A stale or missing `0x90` makes the whole `telemetry` object null. When the BMS is unavailable, the gateway continues to send a heartbeat with `bmsConnected: false` and null telemetry while Wi-Fi and server access are available.

Each boot gets a random hexadecimal `bootId`. `sequence` increments only when a valid `0x90` frame is decoded. Every poll or heartbeat attempt serializes a fresh snapshot and age; retries use the same sequence until another valid SOC sample arrives, allowing the server to ignore duplicates without refreshing the measurement time. A null telemetry heartbeat uses age zero because it contains no measurement. The server receives the token only in an HTTPS Bearer authorization header. The endpoint and token are optional; BLE polling works without server configuration. The firmware reports `controlCapabilityVersion: 1` for dashboard-side capability detection and `bmsLastSeenAgeMs` while the bound BMS is visible in connection events, notifications, or advertisements; absence from a BLE scan is not proof of battery departure.

The capture confirms the checksum and fields above for this BMS. The `FA` transport differs from standard Daly `A5` UART frames; other model revisions may use different payload layouts. The root CA certificate must be replaced if the public endpoint changes certificate authority.

## Hardware verification

On 2026-10-09, firmware 1.0.2 was compiled with ESP32 core 3.3.12 and NimBLE-Arduino 2.5.1, uploaded to an ESP32-D0WD-V3, and flash hashes verified. The gateway received Titanat telemetry and delivered multiple HTTPS POSTs to `spotsup.ru` with HTTP 200 and `ok: true`. The public dashboard showed SOC, pack voltage, four cell voltages and two temperature sensors. The earlier Bluedroid build could read BLE but could not finish HTTPS; an isolated TLS test without BLE succeeded, and the NimBLE build resolved simultaneous BLE/HTTPS operation.

The same board was then USB-upgraded to the 1.1.0 bridge and updated through the production dashboard to signed versions 1.1.1 and 1.1.2. Serial output and the dashboard confirmed both version changes, automatic restart, alternate OTA application slots and terminal server acknowledgements. Wi-Fi was changed remotely to a temporary phone hotspot and back to the station network; a nonexistent-network trial automatically restored the station network and acknowledged `rolled-back`. After USB power was moved from the computer to a 5 V adapter, 1.1.2 reconnected and authenticated heartbeats continued with saved settings. BMS connectivity remains separate from gateway connectivity: sleeping or unavailable BMS data is marked stale rather than refreshed by a heartbeat. No real rental or payment was created to test radio trip detection; departure and return rules were verified with isolated test records. A deliberately broken first-boot image was not tested; keep USB recovery available.

## Decoder tests

`tests/test_titanat_decoder.cpp` uses sanitized actual response frames for commands `90`, `93`, `94`, `95`, `96`, and `98`. It checks decoded scales, frame indexing, null sentinels, notification chunking, concatenated frames, invalid-checksum recovery, and a truncated frame completed by a later chunk. Run it with a host C++11 compiler:

```powershell
g++ -std=c++11 -Wall -Wextra -pedantic firmware/esp32-bms-gateway/tests/test_titanat_decoder.cpp -o $env:TEMP\titanat-decoder-test.exe
& $env:TEMP\titanat-decoder-test.exe
```
