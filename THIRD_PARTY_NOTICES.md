# Third-Party Notices

OPlusAutoHR interacts with Android platform components and may use or rely on
third-party runtime components. Those components are not relicensed by the
OPlusAutoHR Source Available License.

## Android / AOSP

Android, SurfaceFlinger, Binder, Hardware Composer and related platform APIs are
part of the Android platform and are governed by their respective upstream
licenses.

## Frida / FIJ1673 runtime

Current Canary builds use a Frida-based injection runtime to attach an agent to
`surfaceflinger`. OPlusAutoHR does not claim ownership of Frida or third-party
injector/runtime components.

The GitHub source bundle intentionally does **not** include the large
`bin/fij1673` runtime binary. Before redistributing any third-party binary in a
GitHub Release, verify the exact upstream source and redistribution license and
include the required notices/source links.

## Vendor libraries

Qualcomm QTI, Xiaomi, OnePlus/OPPO/realme and other vendor libraries present on
a user's device remain proprietary or separately licensed where applicable.
The project should prefer using libraries already present on the device rather
than redistributing proprietary vendor binaries.
