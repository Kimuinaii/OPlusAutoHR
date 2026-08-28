#!/system/bin/sh
MODDIR="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)"
RUNDIR=/data/local/tmp/oplusautohr_v2
PRIVATE_RUNTIME=/data/local/tmp/oplusautohr_beta
AGENT="$MODDIR/agent/oah_v2_agent.js"
LOG="$RUNDIR/engine.log"
SETTINGS="$MODDIR/config/settings.conf"
OAHTOOL="$MODDIR/bin/oahctl"

mkdir -p "$RUNDIR" "$PRIVATE_RUNTIME" "$MODDIR/config" "$MODDIR/logs"
touch "$LOG" "$SETTINGS"
chmod 0666 "$LOG" 2>/dev/null
chmod 0644 "$SETTINGS" 2>/dev/null

find_injector() {
    for p in \
        "$PRIVATE_RUNTIME/fij1673" \
        "$MODDIR/bin/fij1673" \
        /data/local/tmp/hksurfaceflinger/fij1673 \
        /data/adb/modules/hooksurfaceflinger_auto/zhiyuan/hksurfaceflinger/fij1673 \
        /data/adb/modules/hooksurfaceflinger/zhiyuan/hksurfaceflinger/fij1673 \
        /data/adb/modules_update/hooksurfaceflinger_auto/zhiyuan/hksurfaceflinger/fij1673 \
        /data/adb/modules_update/hooksurfaceflinger/zhiyuan/hksurfaceflinger/fij1673
    do
        [ -x "$p" ] && { echo "$p"; return 0; }
    done
    return 1
}

# V1 + Canary fusion must have only one SurfaceFlinger agent. Old V1 launchers are
# stopped, while this Canary agent is deliberately excluded.
kill_legacy() {
    ps -A -o PID,ARGS 2>/dev/null | awk '
      /[s]tartFij4ExpPm\.sh/ {print $1}
      /[f]ij1673/ && /modify_ext_pm2\.js/ && $0 !~ /oah_v2_agent\.js/ {print $1}
    ' | while read -r p; do
        [ -n "$p" ] && kill "$p" 2>/dev/null
    done
}

publish_display_identity() {
    all="$(dumpsys SurfaceFlinger --display-id 2>/dev/null)"
    internal="$(printf '%s\n' "$all" | awk '/Display [0-9]+ \(HWC display 0\)/ {print;exit}')"
    ip="$(printf '%s\n' "$internal" | sed -n 's/^Display \([0-9][0-9]*\).*/\1/p')"
    setprop debug.oah.internalphys "$ip"

    line="$(printf '%s\n' "$all" | awk '/Display [0-9]+ \(HWC display [0-9]+\)/ && $0 !~ /\(HWC display 0\)/ {print; exit}')"

    if [ -z "$line" ]; then
        setprop debug.oah.phys ""
        setprop debug.oah.hwc ""
        if [ "$(getprop debug.oah.pace_enabled)" = "1" ] && [ -n "$ip" ]; then
            setprop debug.oah.action pace
            setprop debug.oah.pacephys "$ip"
            setprop debug.oah.seq "failsafe_$(date +%s)"
            setprop debug.oah.pace_enabled 0
            echo "$(date '+%F %T') [OAH-PACE] external disconnected -> restore internal $ip" >> "$LOG"
        fi
        return
    fi

    phys="$(printf '%s\n' "$line" | sed -n 's/^Display \([0-9][0-9]*\).*/\1/p')"
    hwc="$(printf '%s\n' "$line" | sed -n 's/.*(HWC display \([0-9][0-9]*\)).*/\1/p')"
    setprop debug.oah.phys "$phys"
    setprop debug.oah.hwc "$hwc"
}

agent_pid_for_sf() {
    sf="$1"
    ps -A -o PID,ARGS 2>/dev/null | awk -v s="$sf" '
      /[f]ij1673/ && /oah_v2_agent\.js/ && index($0,"-p " s) {print $1; exit}'
}

auto_enabled() {
    [ "$(sed -n 's/^auto_enabled=//p' "$SETTINGS" 2>/dev/null | tail -n1)" = "1" ]
}

schedule_hotplug_actions() {
    reason="$1"; key="$2"
    [ -n "$key" ] || return 0

    # One short delayed action gives Composer/SF time to settle after hotplug or
    # SurfaceFlinger restart. The Xiaomi/HyperOS internal max-refresh fix is
    # independent from Auto Highest and therefore runs even when Auto is off.
    (
      sleep 1.2
      cur="$(getprop debug.oah.phys):$(getprop debug.oah.hwc)"
      [ "$cur" = "$key" ] || exit 0

      sh "$OAHTOOL" _internal_max_hotplug >> "$LOG" 2>&1

      if auto_enabled; then
        cur="$(getprop debug.oah.phys):$(getprop debug.oah.hwc)"
        [ "$cur" = "$key" ] || exit 0
        echo "$(date '+%F %T') [OAH-AUTO] trigger reason=$reason key=$key" >> "$LOG"
        sh "$OAHTOOL" _auto_hotplug >> "$LOG" 2>&1
      fi
    ) </dev/null >/dev/null 2>&1 &
}
setprop debug.oah.pace_enabled 0
echo "$(date '+%F %T') [canary1] supervisor start" >> "$LOG"

LAST_EXT_KEY=""
LAST_SF=""

while true; do
    kill_legacy
    publish_display_identity

    PHYS="$(getprop debug.oah.phys)"
    HWC="$(getprop debug.oah.hwc)"
    EXT_KEY=""
    [ -n "$PHYS" ] && [ -n "$HWC" ] && EXT_KEY="$PHYS:$HWC"

    SF="$(pidof surfaceflinger 2>/dev/null | awk '{print $1}')"
    INJ="$(find_injector)"

    if [ -z "$INJ" ]; then
        echo "$(date '+%F %T') [OAH-HOST] engine=0 error=missing_fij1673" >> "$LOG"
        LAST_EXT_KEY="$EXT_KEY"
        LAST_SF="$SF"
        sleep 3
        continue
    fi

    NEW_AGENT=0
    if [ -n "$SF" ]; then
        APID="$(agent_pid_for_sf "$SF")"
        if [ -z "$APID" ]; then
            setprop debug.oah.seq ""
            echo "$(date '+%F %T') [canary1] inject SF=$SF using $INJ" >> "$LOG"
            "$INJ" -p "$SF" -s "$AGENT" >> "$LOG" 2>&1 &
            NEW_AGENT=1
            sleep 1
        fi
    fi

    if [ -n "$EXT_KEY" ]; then
        if [ "$EXT_KEY" != "$LAST_EXT_KEY" ]; then
            schedule_hotplug_actions "hotplug" "$EXT_KEY"
        elif [ -n "$LAST_SF" ] && [ "$SF" != "$LAST_SF" ]; then
            schedule_hotplug_actions "surfaceflinger_restart" "$EXT_KEY"
        elif [ "$NEW_AGENT" = "1" ] && [ -z "$LAST_SF" ]; then
            schedule_hotplug_actions "first_agent" "$EXT_KEY"
        fi
    fi

    LAST_EXT_KEY="$EXT_KEY"
    LAST_SF="$SF"

    size="$(wc -c < "$LOG" 2>/dev/null)"
    if [ -n "$size" ] && [ "$size" -gt 1048576 ] 2>/dev/null; then
        tail -c 524288 "$LOG" > "$LOG.tmp" 2>/dev/null && mv -f "$LOG.tmp" "$LOG"
    fi

    sleep 2
done
