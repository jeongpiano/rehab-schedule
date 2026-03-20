#!/bin/bash
NAS_SHARE="//192.168.1.104/SyncingFolder"
NAS_DIR="SynologyDrive/재활 공유/재활치료실"
NAS_FILE="전주  E재활 3 월간시간표.xlsm"
NAS_USER="jyc"
NAS_PASS="Wjddudckd1@"
LOCAL_DIR="/opt/rehab-schedule/data"
LOCAL_FILE="$LOCAL_DIR/schedule.xlsx"
LOG="/opt/rehab-schedule/data/sync.log"

mkdir -p "$LOCAL_DIR"

# Download
smbclient "$NAS_SHARE" -U "$NAS_USER%$NAS_PASS" -c "cd \"$NAS_DIR\"; get \"$NAS_FILE\" \"${LOCAL_FILE}.tmp\"" 2>/dev/null

if [ ! -f "${LOCAL_FILE}.tmp" ]; then
  echo "$(date): Download failed" >> "$LOG"
  exit 1
fi

NEW_HASH=$(md5sum "${LOCAL_FILE}.tmp" | cut -d" " -f1)
OLD_HASH=""
[ -f "$LOCAL_FILE" ] && OLD_HASH=$(md5sum "$LOCAL_FILE" | cut -d" " -f1)

if [ "$NEW_HASH" != "$OLD_HASH" ]; then
  mv "${LOCAL_FILE}.tmp" "$LOCAL_FILE"
  cd /opt/rehab-schedule && node parse_excel.js "$LOCAL_FILE"
  echo "$(date): ✅ Updated (hash: $NEW_HASH)" >> "$LOG"
else
  rm -f "${LOCAL_FILE}.tmp"
  echo "$(date): No changes" >> "$LOG"
fi
