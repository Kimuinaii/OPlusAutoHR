#!/system/bin/sh
ui_print "- OPlusAutoHR V2 Canary 1.0"
ui_print "- Xiaomi/HyperOS + OnePlus/OPlus paths verified"
ui_print "- First-run WebUI agreement gate + Source Available / non-commercial notice"
ui_print "- Authors: Kimu / Coolapk @苦力小怕 / Coolapk @念来过倒别叫你 / ChatGPT"

set_perm "$MODPATH/service.sh" 0 0 0755
set_perm "$MODPATH/post-fs-data.sh" 0 0 0755
set_perm "$MODPATH/bin/oahctl" 0 0 0755
set_perm "$MODPATH/bin/engine_supervisor.sh" 0 0 0755
set_perm "$MODPATH/agent/oah_v2_agent.js" 0 0 0644
set_perm_recursive "$MODPATH/webroot" 0 0 0755 0644

# Preserve the existing UI preference when this is installed as an update.
# On Magisk/KernelSU updates MODPATH is commonly under modules_update while the
# currently active module is still visible under modules/.
mkdir -p "$MODPATH/config"
if [ ! -s "$MODPATH/config/settings.conf" ]; then
  for OLD_SETTINGS in \
    /data/adb/modules/oplusautohr.v2/config/settings.conf \
    /data/adb/modules_update/oplusautohr.v2/config/settings.conf
  do
    [ "$OLD_SETTINGS" = "$MODPATH/config/settings.conf" ] && continue
    if [ -s "$OLD_SETTINGS" ]; then
      cp -af "$OLD_SETTINGS" "$MODPATH/config/settings.conf" 2>/dev/null
      [ -s "$MODPATH/config/settings.conf" ] && { ui_print "- Preserved existing OPlusAutoHR V2 settings"; break; }
    fi
  done
fi

# Fusion migration: V1 carried the custom fij1673 injector. The source-only
# packages do not redistribute that binary, so Canary imports the user's existing
# copy during installation and owns it afterwards.
DST="$MODPATH/bin/fij1673"
if [ ! -f "$DST" ]; then
  for SRC in \
    /data/local/tmp/hksurfaceflinger/fij1673 \
    /data/adb/modules/hooksurfaceflinger_auto/zhiyuan/hksurfaceflinger/fij1673 \
    /data/adb/modules/hooksurfaceflinger/zhiyuan/hksurfaceflinger/fij1673 \
    /data/adb/modules_update/hooksurfaceflinger_auto/zhiyuan/hksurfaceflinger/fij1673 \
    /data/adb/modules_update/hooksurfaceflinger/zhiyuan/hksurfaceflinger/fij1673
  do
    if [ -f "$SRC" ]; then
      cp -af "$SRC" "$DST" 2>/dev/null
      if [ -f "$DST" ]; then
        ui_print "- Imported V1 HWC injector: $SRC"
        break
      fi
    fi
  done
fi

if [ -f "$DST" ]; then
  set_perm "$DST" 0 0 0755
  ui_print "- HWC injector ready: Canary is standalone after reboot"
else
  ui_print "! fij1673 was not found."
  ui_print "! Canary UI can install, but HWC control engine will stay offline."
  ui_print "! Install over an existing V1 once, or place fij1673 in bin/fij1673."
fi
