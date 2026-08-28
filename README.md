# OPlusAutoHR V2 Canary 1.0

**Authors / collaborators:** Kimu / 酷安 @苦力小怕 / 酷安 @念来过倒别叫你 / ChatGPT

Canary 1.0 is the first public-testing-oriented V2 build after the Xiaomi/HyperOS and OnePlus/OPlus paths were verified on real devices.

## Canary 1.0 highlights

- Keeps the proven V1/V2 HWC + DMC/SurfaceFlinger synchronization path.
- Xiaomi/HyperOS internal max-refresh fix uses SurfaceFlinger transaction `1035` with a dynamically selected real internal mode and explicit internal `PhysicalDisplayId`.
- No internal `modeId`, refresh rate, resolution, or physical display ID is hard-coded.
- HWC late-success reconciliation avoids reporting a mode switch as failed when the vendor mode already changed but `getActiveConfig` settles late.
- WebUI polling/diagnostics are throttled to reduce sticky/janky interaction.
- First WebUI launch is gated by a versioned User Agreement & Disclaimer. The WebUI does not start backend polling until the user accepts.
- External Pacesetter remains OFF by default and is marked **high-risk experimental**.

## HyperOS internal max-refresh fix

When an external physical display is connected and the switch is enabled, the backend:

1. identifies the internal physical display from SurfaceFlinger (`HWC display 0`);
2. enumerates that internal display's real SurfaceFlinger modes;
3. selects the highest/native-resolution group first, then the highest real refresh rate inside that group;
4. sends SurfaceFlinger transaction `1035` with the selected `modeId` and explicit internal `PhysicalDisplayId`;
5. verifies the resulting internal active mode.

Xiaomi/Redmi/POCO/MIUI/HyperOS devices default this fix to ON on first installation. Other devices default it to OFF. Disabling it stops future automatic triggers; a lock already applied during the current boot is intentionally left in place until reboot / SurfaceFlinger lifecycle reset.

## OPlus / OxygenOS path

The existing OPlus/OnePlus HWC resolver, high-refresh mode switching, DMC/SF synchronization, engine recovery, hotplug auto-highest behavior, and 10-second manual rollback remain intact.

## External Pacesetter

External Pacesetter can force the external display to become SurfaceFlinger's scheduling pacesetter, but may cause internal low refresh, hotplug stalls/near-freezes, or SurfaceFlinger instability on some devices. It is a separate high-risk experimental feature and remains disabled by default.

## WebUI agreement

The first WebUI open requires explicit acceptance of the bundled User Agreement & Disclaimer. Acceptance is versioned in WebUI storage; a future material agreement revision can require confirmation again.

The agreement covers the project's experimental nature, legal/non-commercial use restriction, current no-profit policy, third-party modification/distribution rules, system-level risks, AS-IS disclaimer, and non-affiliation with device/OS vendors.

See `USER_AGREEMENT.md` and `SOURCE_AVAILABLE_NOTICE.md`.

## Distribution status

This project is currently **Source Available** rather than OSI Open Source because commercial/profit-making use is currently restricted. Source is intended for learning, research, technical discussion, and non-commercial modification/testing.

## ⚠️ Anti-cheat / environment risk

Current Canary builds use Frida-based injection into `surfaceflinger`. The
module does not modify game data or provide anti-cheat bypass features, but
Frida, Root and process injection may be treated as an abnormal environment by
some games or anti-cheat systems.

Known reports during current testing include a very high likelihood of a
roughly three-day observation period in VALORANT Mobile and a reported chance
of a temporary one-day restriction in Delta Force. These behaviors may change
with game, region or anti-cheat updates. Do not use current Frida-based builds
on devices/accounts where anti-cheat safety is critical.

The project does not provide Frida hiding, Root hiding, anti-cheat bypass or
ban-evasion functionality.

## Future architecture

A major future goal is to replace the Frida injection backend with a native
implementation using Qualcomm QTI display / SurfaceFlinger vendor interfaces
where available. The intended direction is to reduce process injection,
improve stability and maintainability, and reduce compatibility risk caused by
private symbol changes. Non-QTI fallback paths may continue to be researched.

## Source and release binaries

This repository contains project source and scripts. The large third-party
`bin/fij1673` runtime binary is intentionally not stored in the source bundle
until its exact redistribution terms are verified. See
`THIRD_PARTY_NOTICES.md`.
