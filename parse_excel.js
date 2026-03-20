/**
 * Excel 월간시간표 → JSON 파싱
 * 손상된 xlsx도 raw deflate로 직접 추출
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { DOMParser } = require('@xmldom/xmldom');

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

function extractFilesFromXlsx(filePath) {
  const data = fs.readFileSync(filePath);
  const files = {};
  let pos = 0;

  while (pos < data.length - 4) {
    if (data[pos] === 0x50 && data[pos+1] === 0x4b && data[pos+2] === 0x03 && data[pos+3] === 0x04) {
      const flags = data.readUInt16LE(pos + 6);
      const method = data.readUInt16LE(pos + 8);
      const compSize = data.readUInt32LE(pos + 18);
      const uncompSize = data.readUInt32LE(pos + 22);
      const nameLen = data.readUInt16LE(pos + 26);
      const extraLen = data.readUInt16LE(pos + 28);
      const nameStart = pos + 30;
      const name = data.subarray(nameStart, nameStart + nameLen).toString('utf-8');
      const dataStart = nameStart + nameLen + extraLen;

      try {
        if (method === 8) { // deflate
          let raw = data.subarray(dataStart, compSize > 0 ? dataStart + compSize : undefined);
          if (compSize === 0) {
            // Find next PK header
            let nextPk = data.indexOf(Buffer.from([0x50, 0x4b]), dataStart + 1);
            if (nextPk > 0) raw = data.subarray(dataStart, nextPk);
          }
          files[name] = zlib.inflateRawSync(raw);
        } else if (method === 0) {
          files[name] = data.subarray(dataStart, dataStart + uncompSize);
        }
      } catch (e) { /* skip corrupted entry */ }

      pos = dataStart + Math.max(compSize, 1);
    } else {
      pos++;
    }
  }
  return files;
}

// Color → Tag mapping
const COLOR_TAG_MAP = {
  'FF92D050': '신환/추가',
  'FF87CB3D': '신환/추가',
  'FF00B0F0': '임시',
  'FFFFC000': '보류',
  'FFFFFF00': '보류',
  'FFFF66FF': '시간변경',
  'FFFF9999': '시간변경',
};

function parseStyles(xml) {
  // Returns array: styleIndex[xfIdx] = rgbHex or null
  const doc = new DOMParser().parseFromString(xml, 'text/xml');

  // Parse fills: fills[fillIdx] = fgColor hex or null
  const fills = [];
  const fillEls = doc.getElementsByTagNameNS(NS, 'fill');
  for (let i = 0; i < fillEls.length; i++) {
    const fill = fillEls[i];
    let color = null;
    // patternFill/fgColor
    const patterns = fill.getElementsByTagNameNS(NS, 'patternFill');
    if (patterns.length > 0) {
      const fgEls = patterns[0].getElementsByTagNameNS(NS, 'fgColor');
      if (fgEls.length > 0) {
        const rgb = fgEls[0].getAttribute('rgb');
        if (rgb && rgb.length === 8) color = rgb.toUpperCase();
      }
    }
    fills.push(color);
  }

  // Parse cellXfs: xf index → fillId
  const styleIndex = [];
  const xfs = doc.getElementsByTagNameNS(NS, 'cellXfs');
  if (xfs.length > 0) {
    const xfEls = xfs[0].getElementsByTagNameNS(NS, 'xf');
    for (let i = 0; i < xfEls.length; i++) {
      const fillId = parseInt(xfEls[i].getAttribute('fillId') || '0');
      const rgb = fills[fillId] || null;
      const tag = rgb ? (COLOR_TAG_MAP[rgb] || null) : null;
      styleIndex.push(tag);
    }
  }

  return styleIndex;
}

function parseSharedStrings(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const strings = [];
  const sis = doc.getElementsByTagNameNS(NS, 'si');
  for (let i = 0; i < sis.length; i++) {
    const ts = sis[i].getElementsByTagNameNS(NS, 't');
    let text = '';
    for (let j = 0; j < ts.length; j++) {
      text += ts[j].textContent || '';
    }
    strings.push(text);
  }
  return strings;
}

function parseCellRef(ref) {
  const m = ref.match(/^([A-Z]+)(\d+)$/);
  return m ? { col: m[1], row: parseInt(m[2]) } : null;
}

function parseSheet(xml, strings, styleIndex) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const cells = {};
  const cellTags = {}; // ref -> tag string or null
  const rows = doc.getElementsByTagNameNS(NS, 'row');

  for (let i = 0; i < rows.length; i++) {
    const cs = rows[i].getElementsByTagNameNS(NS, 'c');
    for (let j = 0; j < cs.length; j++) {
      const ref = cs[j].getAttribute('r');
      const t = cs[j].getAttribute('t') || '';
      const s = cs[j].getAttribute('s');
      const vEl = cs[j].getElementsByTagNameNS(NS, 'v')[0];
      const parsed = parseCellRef(ref);
      if (!parsed) continue;
      const key = `${parsed.col}${parsed.row}`;

      // Store tag from style index
      if (s !== null && styleIndex) {
        const sIdx = parseInt(s);
        const tag = styleIndex[sIdx] || null;
        if (tag) cellTags[key] = tag;
      }

      if (ref && vEl && vEl.textContent) {
        let val = vEl.textContent;
        if (t === 's') val = strings[parseInt(val)] || val;
        cells[key] = val;
      }
    }
  }
  return { cells, cellTags };
}

function buildSchedule(cells, dateStr, cellTags) {
  // Read category headers from Row 5 dynamically
  // Row 5 has merged cells: NDT, 작업치료/OT, MAT, FES at their starting columns
  const allCols = 'ABCDEFGHIJKLMNOPQRST'.split('');
  
  // Build category map from row 5
  const catMap = {}; // col -> category
  let currentCat = null;
  const row5Vals = {};
  for (const col of allCols) {
    const v = (cells[`${col}5`] || '').trim();
    if (v) row5Vals[col] = v;
  }
  
  // Map row 5 values to categories
  const catNormalize = (v) => {
    if (/NDT/i.test(v)) return 'NDT';
    if (/MAT/i.test(v)) return 'MAT';
    if (/작업|OT/i.test(v)) return 'OT';
    if (/FES/i.test(v)) return 'MAT'; // FES is part of MAT
    return null;
  };
  
  // Assign categories: row5 header sets category for following columns until next header
  // Start from A (NDT header might be in A, not B)
  for (const col of allCols) {
    if (row5Vals[col]) {
      const cat = catNormalize(row5Vals[col]);
      if (cat) currentCat = cat;
    }
    if (currentCat && col !== 'A') catMap[col] = currentCat; // skip A (time column)
  }
  
  // Fallback: if no row 5 data, use default layout (2026 format)
  if (Object.keys(row5Vals).length === 0) {
    const defaults = { NDT: 'BCDEFGHI', MAT: 'JKL', OT: 'NOPQRST' };
    for (const [cat, cols] of Object.entries(defaults)) {
      for (const c of cols) catMap[c] = cat;
    }
  }
  
  // Content-based category detection: scan rows 9-23 for markers
  // If a column has N/M markers → NDT, S/D markers → OT
  const contentCats = {};
  for (const col of allCols) {
    if (col === 'A') continue;
    let nCount = 0, sdCount = 0, fCount = 0, total = 0;
    for (let r = 9; r <= 23; r++) {
      const val = cells[`${col}${r}`];
      if (!val) continue;
      total++;
      const text = val.toString().replace(/([\uAC00-\uD7AF])\s+([NMFSD])/g, '$1$2');
      if (/[\uAC00-\uD7AF][NM]\d*/.test(text)) nCount++;
      if (/[\uAC00-\uD7AF][SD]/.test(text) || /^[SD]\d*$/.test(val.toString().trim())) sdCount++;
      if (/[\uAC00-\uD7AF][Ff]\d*/.test(text)) fCount++;
    }
    if (total > 0) {
      if (nCount > total * 0.3) contentCats[col] = 'NDT';
      else if (sdCount > total * 0.3) contentCats[col] = 'OT';
      else if (fCount > total * 0.3) contentCats[col] = 'MAT';
    }
  }
  
  // Content-based detection overrides Row 5 headers — more reliable
  // Only override if content clearly indicates a category
  for (const [col, cat] of Object.entries(contentCats)) {
    catMap[col] = cat; // always trust content markers
  }

  // Build therapists from row 7
  const therapists = {};
  for (const col of allCols) {
    const cat = catMap[col];
    if (!cat) continue;
    let name = cells[`${col}7`];
    if (!name && row5Vals[col] && ['MAT보조', 'FES'].includes(row5Vals[col])) name = row5Vals[col];
    if (!name && col === 'K' && cat === 'MAT') name = 'MAT보조';
    if (!name && col === 'L' && cat === 'MAT') name = 'FES';
    // If no name in row 7 but column has data in time slots, include it with category-based default name
    if (!name) {
      for (let r = 9; r <= 23; r++) {
        if (cells[`${col}${r}`]) {
          name = cat === 'MAT' ? '허유선' : cat === 'OT' ? `OT-${col}` : `NDT-${col}`;
          break;
        }
      }
    }
    if (name) {
      therapists[col] = { name, category: cat, column: col };
    }
  }

  // Time slots (rows 9-23)
  const timeSlots = [];
  for (let r = 9; r <= 23; r++) {
    const timeA = cells[`A${r}`] || '';
    if (!timeA || !timeA.includes('-')) continue;

    const slot = { time: timeA, patients: {} };

    // All therapist columns — use dynamic catMap
    for (const col of Object.keys(therapists)) {
      const val = cells[`${col}${r}`];
      if (val) {
        const cellKey = `${col}${r}`;
        const tag = (cellTags && cellTags[cellKey]) || null;
        // 이름 뒤 공백+마커 붙이기: "공현철  f3" → "공현철f3", "김금예 f3" → "김금예f3"
        const cleanVal = val.replace(/보호자|보호사/g, ' ')
          .replace(/([\uAC00-\uD7AF]{2,4})\s+([NFMSDnfmsd]\d*)/g, '$1$2')
          .replace(/\s+/g, ' ').trim();
        slot.patients[col] = { text: cleanVal, category: catMap[col] || 'NDT', tag };
      }
    }

    // OT time from M column (if M is not a therapist column)
    if (!therapists['M']) {
      const timeM = cells[`M${r}`];
      if (timeM) slot.otTime = timeM;
    }

    timeSlots.push(slot);
  }

  // Absences — search dynamically after last time slot row (handles Saturday short schedules)
  // Find last time slot row
  let lastTimeRow = 8;
  for (let r = 9; r <= 23; r++) {
    const timeA = cells[`A${r}`] || '';
    if (timeA && timeA.includes('-')) lastTimeRow = r;
  }
  // Scan rows from (lastTimeRow+1) up to 35 for absence data
  const absences = [];
  const absencesByCol = {};
  const skipWords = ['결석환자', '신환 및 추가', '임시', '보류', '시간변경 및 이동'];
  for (let r = lastTimeRow + 1; r <= 35; r++) {
    for (const col of Object.keys(therapists)) {
      const val = cells[`${col}${r}`];
      if (val && !skipWords.includes(val) && !/^\d+$/.test(val.toString().trim())) {
        // Must contain Korean characters (patient name)
        if (/[\uAC00-\uD7AF]{2,}/.test(val.toString())) {
          const name = val.trim();
          absences.push(name);
          if (!absencesByCol[col]) absencesByCol[col] = [];
          absencesByCol[col].push(name);
        }
      }
    }
  }

  // Patient counts — dynamic by category
  const patientCounts = {};
  
  for (const col of Object.keys(therapists)) {
    const cat = catMap[col];
    if (cat === 'NDT') {
      // NDT: count N마커 + M마커
      let count = 0;
      for (const slot of timeSlots) {
        const p = slot.patients[col];
        if (!p) continue;
        const text = p.text.replace(/([\uAC00-\uD7AF])\s+([NM])/g, '$1$2');
        const parts = text.trim().split(/\s+/);
        for (const part of parts) {
          if (/[\uAC00-\uD7AF][NM]\d*/.test(part)) count++;
        }
      }
      patientCounts[col] = count;
    } else if (cat === 'OT') {
      // OT: count occupied slots
      let count = 0;
      for (const slot of timeSlots) {
        if (slot.patients[col]) count++;
      }
      patientCounts[col] = count;
    }
    // MAT: no count display
  }

  return { date: dateStr, therapists, timeSlots, absences, absencesByCol, patientCounts };
}

function getSheetNames(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const sheets = doc.getElementsByTagNameNS(NS, 'sheet');
  const result = [];
  for (let i = 0; i < sheets.length; i++) {
    result.push({
      name: sheets[i].getAttribute('name'),
      sheetId: sheets[i].getAttribute('sheetId')
    });
  }
  return result;
}

function extractDate(sheetName, year) {
  // "3월 4일 수요일" → "YYYY-03-04"
  const m = sheetName.match(/(\d+)월\s*(\d+)일/);
  if (!m) return null;
  const month = m[1].padStart(2, '0');
  const day = m[2].padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Main
function parseExcelFile(filePath) {
  console.log('Extracting xlsx...');
  const files = extractFilesFromXlsx(filePath);
  
  const sharedStrings = parseSharedStrings(files['xl/sharedStrings.xml'].toString());
  console.log(`Shared strings: ${sharedStrings.length}`);

  // Parse styles for fill colors → tag mapping
  let styleIndex = [];
  if (files['xl/styles.xml']) {
    styleIndex = parseStyles(files['xl/styles.xml'].toString());
    console.log(`Style index: ${styleIndex.length} entries`);
  }
  
  const sheetNames = getSheetNames(files['xl/workbook.xml'].toString());
  console.log(`Sheets: ${sheetNames.length}`);

  // Extract year from filename: "E재활_2025년_5월" → 2025, "전주_E재활_3_월간시간표" → 2026 (current)
  const fname = require('path').basename(filePath);
  const yearMatch = fname.match(/(\d{4})년/);
  const year = yearMatch ? yearMatch[1] : '2026';

  const schedules = {};
  for (let i = 0; i < sheetNames.length; i++) {
    const sheetFile = `xl/worksheets/sheet${i + 1}.xml`;
    if (!files[sheetFile]) continue;
    
    const dateStr = extractDate(sheetNames[i].name, year);
    if (!dateStr) continue;
    
    const { cells, cellTags } = parseSheet(files[sheetFile].toString(), sharedStrings, styleIndex);
    const schedule = buildSchedule(cells, dateStr, cellTags);
    schedules[dateStr] = schedule;
    console.log(`  ${dateStr} (${sheetNames[i].name}): ${schedule.timeSlots.length} slots, ${Object.keys(schedule.therapists).length} therapists, ${schedule.absences.length} absences`);
  }

  return schedules;
}

module.exports = { parseExcelFile };

if (require.main === module) {
  const file = process.argv[2] || '/tmp/rehab_schedule.xlsx';
  const data = parseExcelFile(file);
  const outPath = path.join(__dirname, 'schedule_data.json');
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`\nSaved to ${outPath} (${Object.keys(data).length} days)`);
}
