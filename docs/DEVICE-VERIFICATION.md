# Physical device verification

Everything in this document requires a real Android phone. None of it can be
proved on an emulator or in CI, which is why it is a checklist for a human
rather than a test suite.

The emulator already covers install, launch, sign-in, sync, offline working and
reconnect — those are verified automatically and are not repeated here. What
remains is the hardware: a camera that focuses, a GPS fix that is accurate
enough to prove attendance, a scanner that reads a real label under real light,
and a battery that survives a shift.

## Before you start

| | |
|---|---|
| Build | `apps/mobile/android/app/build/outputs/apk/release/app-release.apk` |
| Backend | `https://orbit-field-api.vercel.app` |
| Console | `https://orbit-field-three.vercel.app` |
| Install | `adb install -r app-release.apk`, or copy to the device and allow "install from unknown sources" |

Use a **real inspector account**, not an administrator: the permission set
differs and several of these screens are gated.

Test on the oldest and cheapest device you intend to support, not on a flagship.
Camera latency, GPS acquisition time and thermal behaviour all degrade on low-end
hardware, and that is where field staff will actually be.

---

## 1. Camera

- [ ] Take a photo against a PHOTO field. It attaches and appears in the field.
- [ ] Denying the camera permission produces an explanation, not a crash or a
      dead button.
- [ ] Granting the permission after a denial works without reinstalling.
- [ ] Photo is legible at full zoom — check a serial plate or a meter reading,
      not a wall.
- [ ] Take a photo in poor light (a plant room, a basement). Usable or not?
- [ ] Rotate the device mid-capture. No crash, orientation is correct in the
      saved image.
- [ ] Take 10 photos in a row. No slowdown, no memory crash, all 10 attach.
- [ ] Photo survives backgrounding the app immediately after capture.
- [ ] Gallery import attaches an existing image.

## 2. GPS

- [ ] Location stamps onto an inspection outdoors within 30 seconds.
- [ ] Accuracy is good enough to be evidence — under ~20 m outdoors.
- [ ] Indoors, the app degrades honestly: it reports poor accuracy rather than
      showing a confident wrong position.
- [ ] Denying location produces a clear message and does not block the rest of
      the inspection.
- [ ] Geofence check against a site with a radius set: inside is accepted,
      several hundred metres away is flagged.
- [ ] Airplane mode: the app does not hang waiting for a fix.
- [ ] Background location while an inspection is in progress, if your
      organisation enables it.

## 3. Barcode and QR

- [ ] Scan a real printed asset label — not a screen.
- [ ] Scan a QR code.
- [ ] Scan a damaged, scuffed or partially obscured label. Does it fail cleanly?
- [ ] Scan in low light and in direct sunlight.
- [ ] Scan from ~30 cm and from as close as the camera will focus.
- [ ] A wrong or unknown code is reported as unknown, not silently accepted.
- [ ] The scan is confirmed before it is applied — check that reading an
      adjacent label does not silently overwrite the right one.

## 4. Audio

- [ ] Record a voice note; it attaches to the inspection.
- [ ] Play it back on the device.
- [ ] Record 60 seconds continuously without truncation.
- [ ] Recording survives a screen lock mid-recording, or fails clearly.
- [ ] Denying the microphone permission is handled gracefully.
- [ ] Audio is audible over site background noise.

## 5. File picker

- [ ] Attach a PDF from device storage.
- [ ] Attach a file from Google Drive or another cloud provider.
- [ ] Cancelling the picker returns cleanly with nothing attached.
- [ ] A large file (>20 MB) either uploads or is refused with a clear reason.

## 6. Push notifications

- [ ] The device registers a push token — confirm in the console under Devices.
- [ ] Assign an inspection from the console; the notification arrives.
- [ ] Notification arrives with the app **backgrounded**.
- [ ] Notification arrives with the app **fully closed**.
- [ ] Tapping it opens the correct inspection, not just the app.
- [ ] Notifications respect the preference toggles in Settings.
- [ ] On Android 13+, denying the notification permission is handled and the
      app still works.

## 7. Background sync

- [ ] Make a change, background the app, wait 15 minutes, confirm it reached the
      server without reopening the app.
- [ ] Kill the app from the recents list. Background sync still runs.
- [ ] Reboot the device. Background sync re-registers without opening the app.
- [ ] With battery optimisation **on** (the default), note whether background
      sync still runs — on many OEM builds it will not. This is the single most
      device-dependent item in this document.
- [ ] Add the app to the battery optimisation exclusion list and re-test.

## 8. Biometrics

- [ ] Enable biometric unlock; fingerprint or face unlocks the app.
- [ ] A failed biometric falls back to the password.
- [ ] Removing all enrolled fingerprints from the OS does not lock the user out
      permanently.
- [ ] Biometric prompt appears after the configured idle timeout.

## 9. Battery and thermals

- [ ] Complete a full inspection with 10 photos and GPS. Note battery drain.
- [ ] Two hours of intermittent use. Note total drain and whether the device
      became hot enough to throttle the camera.
- [ ] The app does not prevent the screen from sleeping when idle.

## 10. Offline, on real networks

Emulator airplane mode is not the same as a bad signal. These need a real one.

- [ ] Work through a complete inspection with mobile data off.
- [ ] On a genuinely weak signal (one bar), sync retries rather than hanging or
      losing data.
- [ ] On a captive-portal wifi — a hotel or café — the app reports it cannot
      reach the server rather than appearing to sync.
- [ ] Switch from wifi to mobile data mid-sync. It recovers.
- [ ] Metered-connection behaviour: large media uploads defer if
      "wifi only" is set.
- [ ] Fill device storage close to full and confirm the failure is reported
      clearly rather than as silent data loss.

## 11. Real-world install

- [ ] Install on a device that has never had the app: no crash on first launch.
- [ ] Upgrade over an existing install and confirm local unsynced data survives.
- [ ] App size and install time acceptable over mobile data — the APK is ~130 MB
      because it ships four ABIs. If that is a problem for your field staff,
      distributing the AAB through Play delivers only the ABI each device needs.

---

## Recording results

For each failure, capture: device model, Android version, exact steps, whether
it reproduces, and `adb logcat` output from the moment of failure. A failure
without a logcat is usually not actionable.

Anything failing under section 7 (background sync) or section 10 (real networks)
should block release. Those are the features field staff depend on when they
have no way to ask for help.
