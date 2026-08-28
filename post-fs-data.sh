#!/system/bin/sh
MODDIR=${0%/*}
RUNDIR=/data/local/tmp/oplusautohr_beta
mkdir -p "$RUNDIR"

if [ -f "$MODDIR/bin/fij1673" ]; then
  cp -af "$MODDIR/bin/fij1673" "$RUNDIR/fij1673" 2>/dev/null
  chmod 0755 "$RUNDIR/fij1673" 2>/dev/null
fi
