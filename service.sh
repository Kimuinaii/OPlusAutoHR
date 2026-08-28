#!/system/bin/sh
MODDIR=${0%/*}
chmod 0755 "$MODDIR/bin/oahctl" "$MODDIR/bin/engine_supervisor.sh" "$MODDIR/service.sh" "$MODDIR/post-fs-data.sh" 2>/dev/null
chmod 0755 "$MODDIR/bin/fij1673" 2>/dev/null
chmod 0644 "$MODDIR/agent/oah_v2_agent.js" 2>/dev/null
mkdir -p "$MODDIR/config" "$MODDIR/logs"

# Preserve settings across upgrades and append defaults without overwriting
# existing keys. Xiaomi / HyperOS devices default the internal max-refresh fix ON.
SETTINGS="$MODDIR/config/settings.conf"
touch "$SETTINGS"
if ! grep -q '^auto_enabled=' "$SETTINGS" 2>/dev/null; then
  echo "auto_enabled=1" >> "$SETTINGS"
fi
if ! grep -q '^internal_max_enabled=' "$SETTINGS" 2>/dev/null; then
  MFG="$(getprop ro.product.manufacturer 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  BRAND="$(getprop ro.product.brand 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  MIUI="$(getprop ro.miui.ui.version.name 2>/dev/null)$(getprop ro.mi.os.version.name 2>/dev/null)"
  case "$MFG $BRAND" in
    *xiaomi*|*redmi*|*poco*) INTERNAL_MAX_DEFAULT=1 ;;
    *) [ -n "$MIUI" ] && INTERNAL_MAX_DEFAULT=1 || INTERNAL_MAX_DEFAULT=0 ;;
  esac
  echo "internal_max_enabled=$INTERNAL_MAX_DEFAULT" >> "$SETTINGS"
fi
chmod 0644 "$SETTINGS" 2>/dev/null

/system/bin/sh "$MODDIR/bin/engine_supervisor.sh" >> "$MODDIR/logs/supervisor.log" 2>&1 &
