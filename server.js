const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { parseExcelFile } = require('./parse_excel');
const { execFile, exec: execCb } = require('child_process');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3456;
const JWT_SECRET = process.env.JWT_SECRET || 'rehab-schedule-secret-2026';
const DB_PATH = path.join(__dirname, 'data', 'rehab.db');
const UPLOAD_DIR = path.join(__dirname, 'data', 'uploads');
const SCHEDULE_PATH = path.join(__dirname, 'schedule_data.json');
let lastScheduleHash = '';
let scheduleChanges = []; // { date, col, time, oldText, newText, timestamp }

// Ensure dirs
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// DB setup
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS schedule_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT DEFAULT 'therapist' CHECK(role IN ('admin','manager','therapist')),
    therapist_column TEXT,
    category TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Memos table
db.exec(`
  CREATE TABLE IF NOT EXISTS memos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_name TEXT NOT NULL,
    date TEXT NOT NULL,
    memo TEXT NOT NULL,
    category TEXT DEFAULT 'NDT',
    author_id INTEGER NOT NULL DEFAULT 0,
    author_name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_memos_patient ON memos(patient_name, date);`);
// Add category column if missing (migration)
try { db.exec(`ALTER TABLE memos ADD COLUMN category TEXT DEFAULT 'NDT'`); } catch(e) {}

// Patient notices (특이사항) table
db.exec(`
  CREATE TABLE IF NOT EXISTS patient_notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_name TEXT NOT NULL,
    notice TEXT NOT NULL,
    author_id INTEGER DEFAULT 0,
    author_name TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// Create default admin if not exists
const adminExists = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
if (!adminExists) {
  const hash = bcrypt.hashSync('admin1234', 10);
  db.prepare('INSERT INTO users (username, password_hash, display_name, role, status) VALUES (?, ?, ?, ?, ?)')
    .run('admin', hash, '관리자', 'admin', 'approved');
  console.log('Default admin created: admin / admin1234');
}

app.use(express.json());
// No-cache for HTML - prevents proxy caching
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

// Upload config
const upload = multer({ dest: UPLOAD_DIR });

// Auth middleware
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '로그인 필요' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    // 마지막 활동 시간 갱신 (1분 단위 업데이트, 빈번한 DB 쓰기 방지)
    const nowKST = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace('T', ' ').slice(0, 16);
    const prev = db.prepare('SELECT last_active FROM users WHERE id = ?').get(req.user.id)?.last_active || '';
    if (prev.slice(0, 15) !== nowKST.slice(0, 15)) {
      db.prepare('UPDATE users SET last_active = ? WHERE id = ?').run(nowKST, req.user.id);
    }
    next();
  } catch { return res.status(401).json({ error: '세션 만료' }); }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '관리자 권한 필요' });
  next();
}
function managerOrAdmin(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: '관리 권한 필요' });
  next();
}

function runExecFile(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      timeout: opts.timeoutMs || 120000,
      maxBuffer: opts.maxBuffer || 10 * 1024 * 1024,
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
    }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

function resolveRehabTelegramDir() {
  const candidates = [
    process.env.REHAB_TELEGRAM_DIR,
    path.join(__dirname, '..', 'rehab-telegram'),
    path.join(__dirname, 'rehab-telegram'),
    '/opt/rehab-telegram',
    '/opt/rehab-telegram/',
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      const buildPath = path.join(p, 'build_sms_from_schedule.py');
      const senderPath = path.join(p, 'sms_sender.py');
      if (fs.existsSync(buildPath) && fs.existsSync(senderPath)) return p;
    } catch {}
  }
  return null;
}

// ========== AUTH API ==========

app.post('/api/register', (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password || !displayName) return res.status(400).json({ error: '필수 항목 누락' });
  
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: '이미 사용 중인 아이디' });
  
  const hash = bcrypt.hashSync(password, 10);
  
  // Auto-match therapist by displayName from schedule data
  let therapistColumn = null;
  let category = null;
  try {
    if (fs.existsSync(SCHEDULE_PATH)) {
      const schedData = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf-8'));
      const anyDay = Object.values(schedData)[0];
      if (anyDay && anyDay.therapists) {
        for (const [col, t] of Object.entries(anyDay.therapists)) {
          if (t.name === displayName) {
            therapistColumn = col;
            category = t.category;
            break;
          }
        }
      }
    }
  } catch (e) { console.error('Auto-match error:', e); }
  
  db.prepare('INSERT INTO users (username, password_hash, display_name, role, therapist_column, category) VALUES (?, ?, ?, ?, ?, ?)')
    .run(username, hash, displayName, 'therapist', therapistColumn, category);

  // Send signup notification via macbook notify endpoint
  fetch('http://192.168.1.98:3457/api/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'signup', displayName, username, category: category || '미지정', therapistColumn: therapistColumn || '미매핑' })
  }).catch(e => console.error('Signup notify failed:', e.message));
  
  const matchMsg = therapistColumn ? ` (${category} ${displayName} 자동 매칭)` : '';
  res.json({ message: `가입 완료. 관리자 승인 후 사용 가능합니다.${matchMsg}` });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: '아이디 또는 비밀번호 오류' });
  }
  if (user.status !== 'approved') {
    return res.status(403).json({ error: '관리자 승인 대기 중입니다.' });
  }
  
  const token = jwt.sign({
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    therapistColumn: user.therapist_column,
    category: user.category
  }, JWT_SECRET, { expiresIn: '30d' });

  // 로그인 시간 기록 (KST)
  const nowKST = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace('T', ' ');
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(nowKST, user.id);
  
  res.json({ token, user: {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    therapistColumn: user.therapist_column,
    category: user.category
  }});
});

// ========== ADMIN API ==========

app.get('/api/admin/users', auth, adminOnly, (req, res) => {
  const users = db.prepare('SELECT id, username, display_name, role, therapist_column, category, status, created_at, last_login FROM users ORDER BY last_login DESC NULLS LAST').all();
  res.json(users);
});

app.put('/api/admin/users/:id', auth, adminOnly, (req, res) => {
  const { status, therapistColumn, category, role } = req.body;
  const updates = [];
  const params = [];
  
  if (status) { updates.push('status = ?'); params.push(status); }
  if (therapistColumn !== undefined) { updates.push('therapist_column = ?'); params.push(therapistColumn); }
  if (category) { updates.push('category = ?'); params.push(category); }
  if (role) { updates.push('role = ?'); params.push(role); }
  
  if (updates.length === 0) return res.status(400).json({ error: '변경 항목 없음' });
  
  params.push(req.params.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ message: '업데이트 완료' });
});

app.delete('/api/admin/users/:id', auth, adminOnly, (req, res) => {
  try {
    // Keep memos but remove FK reference
    db.prepare('UPDATE memos SET author_id = 0 WHERE author_id = ?').run(req.params.id);
    db.prepare('DELETE FROM users WHERE id = ? AND role != ?').run(req.params.id, 'admin');
    res.json({ message: '삭제 완료' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== SCHEDULE API ==========

app.get('/api/schedule', auth, (req, res) => {
  if (!fs.existsSync(SCHEDULE_PATH)) return res.json({});
  const data = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf-8'));
  res.json(data);
});

app.get('/api/dates', auth, (req, res) => {
  if (!fs.existsSync(SCHEDULE_PATH)) return res.json([]);
  const data = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf-8'));
  res.json(Object.keys(data).sort());
});

// ========== UPLOAD API ==========

app.post('/api/admin/upload', auth, managerOrAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일 없음' });
  
  try {
    const newSchedules = parseExcelFile(req.file.path);
    
    // Overwrite ALL dates from Excel (full replace)
    let existing = {};
    if (fs.existsSync(SCHEDULE_PATH)) {
      try { existing = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf-8')); } catch(e) {}
    }
    // Merge: Excel data overwrites existing for all dates present in Excel
    const merged = { ...existing, ...newSchedules };
    const overwrittenCount = Object.keys(newSchedules).length;
    fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(merged, null, 2));
    
    // Clean up uploaded file
    fs.unlinkSync(req.file.path);
    
    res.json({ 
      message: `${overwrittenCount}일치 시간표 업로드 완료 (전체 날짜 갱신)`,
      dates: Object.keys(merged).sort()
    });
  } catch (e) {
    res.status(500).json({ error: '파싱 실패: ' + e.message });
  }
});

// ========== ADMIN OPS (sync + SMS) ==========

// NAS 동기화 + parse_excel 즉시 실행 (서버에 sync_nas.sh 존재 필요)
app.post('/api/admin/sync-nas', auth, managerOrAdmin, async (req, res) => {
  try {
    const script = path.join(__dirname, 'sync_nas.sh');
    if (!fs.existsSync(script)) return res.status(500).json({ error: 'sync_nas.sh 없음 (서버 배포 확인 필요)' });

    // bash로 실행 (smbclient 필요)
    const { stdout, stderr } = await runExecFile('bash', [script], { timeoutMs: 180000 });

    // sync.log 마지막 20줄
    let tail = '';
    try {
      const logPath = path.join(__dirname, 'data', 'sync.log');
      if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
        tail = lines.slice(-20).join('\n');
      }
    } catch {}

    res.json({ message: '동기화 실행 완료', stdout, stderr, tail });
  } catch (e) {
    res.status(500).json({ error: `동기화 실패: ${e.message}`, stderr: e.stderr, stdout: e.stdout });
  }
});

// 구글 주소록에서 특정 환자 연락처 검색 (missing 환자만 대상)
app.post('/api/admin/sms/sync-contacts', auth, managerOrAdmin, async (req, res) => {
  try {
    const { names } = req.body || {};
    if (!Array.isArray(names) || names.length === 0) {
      return res.status(400).json({ error: 'names 배열 필요' });
    }

    // 최대 30명까지만
    const targetNames = names.slice(0, 30);

    // patient_db.json + gog 검색으로 업데이트하는 인라인 Python 스크립트
    // gog CLI가 서버에 없을 수 있으므로 localhost 맥북에서 SSH를 통해 실행하거나,
    // 서버에 gog가 있으면 직접 실행
    const dir = resolveRehabTelegramDir();
    if (!dir) return res.status(500).json({ error: 'rehab-telegram 디렉토리 없음' });

    // gog CLI가 맥북에만 있으므로 SSH로 맥북의 스크립트 실행
    const MACBOOK_HOST = process.env.MACBOOK_SSH || 'open@192.168.1.98';
    const MACBOOK_REHAB_DIR = process.env.MACBOOK_REHAB_DIR || '/Users/open/.openclaw/workspace/rehab-telegram';

    // JSON 이름 배열을 안전하게 이스케이프
    const namesJson = JSON.stringify(targetNames);
    // base64로 인코딩해서 shell escaping 문제 회피
    const b64 = Buffer.from(namesJson).toString('base64');

    const sshCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${MACBOOK_HOST} "cd ${MACBOOK_REHAB_DIR} && python3 sync_missing_contacts.py \\$(echo '${b64}' | base64 -d)"`;

    const { stdout, stderr } = await new Promise((resolve, reject) => {
      execCb(sshCmd, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err, out, errOut) => {
        if (err) { err.stdout = out; err.stderr = errOut; return reject(err); }
        resolve({ stdout: out, stderr: errOut });
      });
    });

    // 맥북에서 patient_db.json 업데이트 됐으면 서버로도 복사
    try {
      await new Promise((resolve, reject) => {
        execCb(`scp -o StrictHostKeyChecking=no ${MACBOOK_HOST}:${MACBOOK_REHAB_DIR}/data/patient_db.json ${dir}/data/patient_db.json`,
          { timeout: 15000 },
          (err) => err ? reject(err) : resolve()
        );
      });
    } catch {} // 실패해도 무시

    const result = JSON.parse(stdout.trim());
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: `연락처 동기화 실패: ${e.message}`, stderr: e.stderr });
  }
});

// SMS 리스트 생성 (rehab-telegram 스크립트 호출)
app.post('/api/admin/sms/preview', auth, managerOrAdmin, async (req, res) => {
  try {
    const { targets } = req.body || {}; // [{date:'YYYY-MM-DD', period:'am'|'pm'}]
    if (!Array.isArray(targets) || targets.length === 0) {
      return res.status(400).json({ error: 'targets 필요' });
    }

    const dir = resolveRehabTelegramDir();
    if (!dir) return res.status(500).json({ error: 'rehab-telegram 디렉토리를 찾지 못했습니다. (REHAB_TELEGRAM_DIR 설정/배포 필요)' });

    const results = [];
    for (const t of targets.slice(0, 6)) {
      const period = t.period;
      const date = t.date;
      if (!['am', 'pm'].includes(period) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'target 형식 오류', target: t });
      }

      const py = `import json, os\n` +
        `from build_sms_from_schedule import build_sms_list\n` +
        `os.environ['DISABLE_GOOGLE_LOOKUP']='1'\n` +
        `print(json.dumps(build_sms_list('${period}', '${date}'), ensure_ascii=False))\n`;

      const { stdout } = await runExecFile('python3', ['-c', py], {
        timeoutMs: 60000,
        env: { DISABLE_GOOGLE_LOOKUP: '1' },
        cwd: dir,
      });

      // NOTE: stdout only JSON
      results.push({ period, date, result: JSON.parse(stdout) });
    }

    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: `SMS 리스트 생성 실패: ${e.message}` });
  }
});

// Telegram 알림 발송 (봇 API 직접 호출)
async function sendTelegramNotify(text) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = '-5156893201';
  try {
    const https = require('https');
    const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (res) => { res.resume(); resolve(); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (e) {
    console.error('[TG notify error]', e.message);
  }
}

// SMS 전송 로그 목록
app.get('/api/admin/sms/history', auth, managerOrAdmin, (req, res) => {
  const dir = resolveRehabTelegramDir();
  if (!dir) return res.json({ logs: [] });
  const logDir = path.join(dir, 'logs');
  try {
    const files = fs.readdirSync(logDir)
      .filter(f => f.startsWith('sms_send_') && f.endsWith('.json'))
      .sort().reverse().slice(0, 30);
    const logs = files.map(f => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(logDir, f), 'utf-8'));
        return { file: f, sent: d.sent, failed: d.failed, total: d.total,
          details: d.details, timestamp: f.replace('sms_send_','').replace('.json','') };
      } catch { return { file: f, error: true }; }
    });
    res.json({ logs });
  } catch { res.json({ logs: [] }); }
});

// SMS 전송내역 삭제
app.delete('/api/admin/sms/history/:file', auth, managerOrAdmin, (req, res) => {
  const dir = resolveRehabTelegramDir();
  if (!dir) return res.status(500).json({ error: 'rehab-telegram 디렉토리 없음' });
  const file = path.basename(req.params.file); // path traversal 방지
  if (!file.startsWith('sms_send_') || !file.endsWith('.json')) {
    return res.status(400).json({ error: '잘못된 파일명' });
  }
  const filePath = path.join(dir, 'logs', file);
  try {
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '파일 없음' });
    fs.unlinkSync(filePath);
    res.json({ message: '삭제 완료' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SMS 전송 (rehab-telegram/sms_sender.py 호출)
app.post('/api/admin/sms/send', auth, managerOrAdmin, async (req, res) => {
  try {
    const { payload, live, confirmText } = req.body || {};
    if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'payload 필요' });
    if (live && confirmText !== 'SEND') return res.status(400).json({ error: 'live 전송은 confirmText="SEND" 필요' });

    const dir = resolveRehabTelegramDir();
    if (!dir) return res.status(500).json({ error: 'rehab-telegram 디렉토리를 찾지 못했습니다. (REHAB_TELEGRAM_DIR 설정/배포 필요)' });

    const tmpPath = path.join(os.tmpdir(), `sms_payload_${Date.now()}.json`);
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));

    const sender = path.join(dir, 'sms_sender.py');
    const args = [sender, tmpPath].concat(live ? ['--live', '--yes'] : []);

    // 반드시 rehab-telegram 디렉토리에서 실행 (config.json 상대경로)
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      execCb(`cd ${dir.replace(/\s/g, '\\ ')} && python3 ${args.map(a => a.replace(/\s/g, '\\ ')).join(' ')}`,
        { timeout: 300000, maxBuffer: 10 * 1024 * 1024 },
        (err, out, errOut) => {
          if (err) {
            err.stdout = out; err.stderr = errOut;
            return reject(err);
          }
          resolve({ stdout: out, stderr: errOut });
        }
      );
    });

    try { fs.unlinkSync(tmpPath); } catch {}

    // LIVE 전송 시 결과 파싱 후 텔레그램 알림
    if (live) {
      const jsonParts = stdout.split('__SMS_RESULT_JSON__');
      if (jsonParts.length >= 2) {
        try {
          const result = JSON.parse(jsonParts[1].trim());
          const dateLabel = payload.date_label || payload.date || '';
          const periodLabel = payload.period === 'am' ? '오전' : payload.period === 'pm' ? '오후' : payload.period || '';
          let tgMsg = `📨 <b>문자 발송 완료</b> (대시보드)\n`;
          tgMsg += `📅 ${dateLabel} ${periodLabel}\n`;
          tgMsg += `✅ 성공: ${result.sent}건 / ❌ 실패: ${result.failed}건 / 전체: ${result.total}건\n`;
          if (result.failed > 0) {
            const failed = result.details.filter(d => d.status !== 'sent');
            tgMsg += `\n⚠️ 실패 목록:\n` + failed.map(d => `  - ${d.name} (${d.phone || '번호없음'})`).join('\n');
          }
          sendTelegramNotify(tgMsg);
        } catch {}
      }
    }

    res.json({ message: live ? 'LIVE 발송 실행 완료' : 'DRY RUN 실행 완료', stdout, stderr });
  } catch (e) {
    res.status(500).json({ error: `SMS 전송 실패: ${e.message}`, stdout: e.stdout, stderr: e.stderr });
  }
});

// ========== MEMO API ==========

// Backup today's schedule to DB
app.post('/api/schedule/backup', auth, (req, res) => {
  try {
    const schedData = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf-8'));
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
    const dayData = schedData[today];
    if (!dayData) return res.status(404).json({ error: 'No data for ' + today });
    
    db.prepare('INSERT OR REPLACE INTO schedule_history (date, data) VALUES (?, ?)')
      .run(today, JSON.stringify(dayData));
    res.json({ message: 'Backup saved', date: today });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Backup all dates from current schedule_data.json
app.post('/api/schedule/backup-all', auth, (req, res) => {
  try {
    const schedData = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf-8'));
    let count = 0;
    for (const [date, dayData] of Object.entries(schedData)) {
      db.prepare('INSERT OR REPLACE INTO schedule_history (date, data) VALUES (?, ?)')
        .run(date, JSON.stringify(dayData));
      count++;
    }
    res.json({ message: `${count} days backed up` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get historical schedule for a specific date
// List all available history dates (must be before :date route)
app.get('/api/schedule/history', auth, (req, res) => {
  const rows = db.prepare('SELECT date FROM schedule_history ORDER BY date ASC').all();
  res.json(rows.map(r => r.date));
});

app.get('/api/schedule/history/:date', auth, (req, res) => {
  const row = db.prepare('SELECT data FROM schedule_history WHERE date = ?').get(req.params.date);
  if (!row) return res.status(404).json({ error: 'No history for ' + req.params.date });
  res.json(JSON.parse(row.data));
});

// Change password
app.put('/api/user/password', auth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: '사용자 없음' });
  
  const crypto = require('crypto');
  const oldHash = crypto.createHash('sha256').update(oldPassword).digest('hex');
  if (oldHash !== user.password_hash) return res.status(403).json({ error: '현재 비밀번호 오류' });
  
  const newHash = crypto.createHash('sha256').update(newPassword).digest('hex');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user.id);
  res.json({ message: '비밀번호 변경 완료' });
});

// Patient search (schedule + patient DB + memos)
app.get('/api/search/patients', auth, (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  
  const results = new Map();
  
  // Search in schedule_data
  try {
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('schedule_data.json', 'utf8'));
    for (const day of Object.values(data)) {
      for (const slot of (day.timeSlots || [])) {
        for (const p of Object.values(slot.patients || {})) {
          // Split cell text into individual patient names (Korean name = 2-4 chars)
          const cellText = p.text.replace(/([\uAC00-\uD7AF])\s+([NFMSD])/g, '$1$2');
          const nameMatches = cellText.match(/[\uAC00-\uD7AF]{2,4}[NFMSD]?\d*(\([^)]*\))?/g) || [];
          for (const n of nameMatches) {
            const clean = n.replace(/[NFMSD]\d*(\(.*?\))?/g, '').replace(/\(도\)/g,'').trim();
            if (clean.includes('보호자') || clean.includes('보호사')) continue;
            if (clean.includes(q) && clean.length >= 2) {
              if (!results.has(clean)) results.set(clean, { name: clean });
            }
          }
        }
      }
    }
  } catch(e) {}
  
  // Search in patient_db.json (SMS system)
  try {
    const fs = require('fs');
    const pdb = JSON.parse(fs.readFileSync(__dirname + '/data/patient_db.json', 'utf8'));
    for (const [name, info] of Object.entries(pdb.patients || {})) {
      if (name.includes(q) && !name.includes('보호자') && !name.includes('보호사') && !name.endsWith('보')) {
        const entry = results.get(name) || { name };
        entry.phone = info.primarySelf || (info.selfPhones && info.selfPhones[0]) || null;
        results.set(name, entry);
      }
    }
  } catch(e) {}
  
  // Count memos per patient
  const memoRows = db.prepare("SELECT patient_name, COUNT(*) as cnt FROM memos WHERE patient_name LIKE ? GROUP BY patient_name").all('%' + q + '%');
  for (const r of memoRows) {
    const clean = r.patient_name.replace(/[NFMSD]\d*(\(.*?\))?/g, '').trim();
    const entry = results.get(clean) || { name: clean };
    entry.memoCount = (entry.memoCount || 0) + r.cnt;
    results.set(clean, entry);
  }
  
  res.json([...results.values()].slice(0, 30));
});

// Get patient attendance for last N weeks (from schedule_history)
app.get('/api/patients/:name/attendance', auth, (req, res) => {
  const name = req.params.name;
  const weeks = parseInt(req.query.weeks) || 3;
  
  // Calculate date range using KST date strings (timezone-safe)
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const [ty, tm, td] = today.split('-').map(Number);
  const startUtc = new Date(Date.UTC(ty, tm - 1, td - weeks * 7));
  const startStr = startUtc.toISOString().slice(0, 10);
  
  // Get all history rows in range
  const rows = db.prepare(
    'SELECT date, data FROM schedule_history WHERE date >= ? AND date <= ? ORDER BY date ASC'
  ).all(startStr, today);
  
  const DAY_NAMES = ['일','월','화','수','목','금','토'];

  // Timezone-safe helpers: work directly from YYYY-MM-DD strings using UTC
  const parseDateUtc = (dateStr) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  };
  const getMondayStr = (dateStr) => {
    const d = parseDateUtc(dateStr);
    const day = d.getUTCDay(); // 0=Sun
    const diff = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().slice(0, 10);
  };
  const getDayName = (dateStr) => {
    const d = parseDateUtc(dateStr);
    return DAY_NAMES[d.getUTCDay()];
  };

  // For each date, check if the patient appears
  const attendedDates = [];
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data);
      let found = false;
      for (const slot of (data.timeSlots || [])) {
        for (const p of Object.values(slot.patients || {})) {
          // Use same parsing as search API: strip markers then extract Korean names
          const cellText = (p.text || '').replace(/([\uAC00-\uD7AF])\s+([NFMSD])/g, '$1$2');
          const nameMatches = cellText.match(/[\uAC00-\uD7AF]{2,4}[NFMSD]?\d*(\([^)]*\))?/g) || [];
          const cellNames = nameMatches.map(n => n.replace(/[NFMSD]\d*(\(.*?\))?/g, '').replace(/\(도\)/g, '').trim()).filter(n => n.length >= 2);
          if (cellNames.some(n => n === name)) { found = true; break; }
        }
        if (found) break;
      }
      // Also check absences list (still counts as scheduled)
      if (!found && (data.absences || []).some(a => {
        const clean = (a || '').replace(/[NFMSD]\d*/g, '').trim();
        return clean === name;
      })) found = true;
      
      if (found) attendedDates.push(row.date);
    } catch(e) {}
  }
  
  // Group by week (timezone-safe)
  const thisMonday = getMondayStr(today);

  // Build week buckets: 0=thisWeek, 1=lastWeek, 2=twoWeeksAgo
  const weekBuckets = [{}, {}, {}];
  for (const dateStr of attendedDates) {
    const mon = getMondayStr(dateStr);
    const diffDays = (parseDateUtc(thisMonday) - parseDateUtc(mon)) / 86400000;
    const weekIdx = Math.round(diffDays / 7); // 0, 1, 2 ...
    if (weekIdx >= 0 && weekIdx < weeks) {
      const dayName = getDayName(dateStr);
      weekBuckets[weekIdx][dayName] = true;
    }
  }

  const DAY_ORDER = ['월','화','수','목','금','토'];
  const result = weekBuckets.map((bucket, i) => ({
    label: i === 0 ? '이번주' : `${i}주전`,
    days: DAY_ORDER.filter(d => bucket[d])
  }));
  
  res.json(result);
});

// Admin: get all memos list
app.get('/api/admin/memos', auth, managerOrAdmin, (req, res) => {
  const { category, limit = 100 } = req.query;
  let sql = 'SELECT * FROM memos';
  const params = [];
  if (category) { sql += ' WHERE category = ?'; params.push(category); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(parseInt(limit));
  const memos = db.prepare(sql).all(...params);
  res.json(memos);
});

// ── 특이사항(Patient Notices) CRUD ──────────────────────
app.get('/api/notices', auth, (req, res) => {
  const notices = db.prepare('SELECT * FROM patient_notices ORDER BY created_at DESC').all();
  res.json(notices);
});

app.post('/api/notices', auth, (req, res) => {
  const { patientName, notice, alsoMemo, memoCategory } = req.body;
  if (!patientName || !notice) return res.status(400).json({ error: '환자명과 내용 필수' });
  const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace('T', ' ');
  db.prepare('INSERT INTO patient_notices (patient_name, notice, author_id, author_name, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(patientName, notice, req.user.id, req.user.displayName, now, now);
  // 기타 메모에도 저장 옵션
  if (alsoMemo) {
    const today = now.slice(0, 10);
    const cat = memoCategory || req.user.category || 'ETC';
    db.prepare('INSERT INTO memos (patient_name, date, memo, category, author_id, author_name, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(patientName, today, notice, cat, req.user.id, req.user.displayName, now);
  }
  res.json({ message: '저장 완료' });
});

app.put('/api/notices/:id', auth, (req, res) => {
  const { notice } = req.body;
  if (!notice?.trim()) return res.status(400).json({ error: '내용 없음' });
  const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace('T', ' ');
  const row = db.prepare('SELECT * FROM patient_notices WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '없음' });
  if (row.author_id !== req.user.id && req.user.role !== 'admin' && req.user.role !== 'manager')
    return res.status(403).json({ error: '권한 없음' });
  db.prepare('UPDATE patient_notices SET notice = ?, updated_at = ? WHERE id = ?').run(notice.trim(), now, req.params.id);
  res.json({ message: '수정 완료' });
});

app.delete('/api/notices/:id', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM patient_notices WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '없음' });
  if (row.author_id !== req.user.id && req.user.role !== 'admin' && req.user.role !== 'manager')
    return res.status(403).json({ error: '권한 없음' });
  db.prepare('DELETE FROM patient_notices WHERE id = ?').run(req.params.id);
  res.json({ message: '삭제 완료' });
});

// Get memos for a patient (all dates or specific date)
app.get('/api/memos/:patientName', auth, (req, res) => {
  const { date } = req.query;
  let memos;
  if (date) {
    memos = db.prepare('SELECT * FROM memos WHERE patient_name = ? AND date = ? ORDER BY created_at ASC').all(req.params.patientName, date);
  } else {
    memos = db.prepare('SELECT * FROM memos WHERE patient_name = ? ORDER BY created_at ASC LIMIT 50').all(req.params.patientName);
  }
  res.json(memos);
});

// Add memo
app.post('/api/memos', auth, (req, res) => {
  const { patientName, date, memo, category } = req.body;
  if (!patientName || !date || !memo) return res.status(400).json({ error: '필수 항목 누락' });
  
  const cat = category || req.user.category || 'NDT';
  const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace('T', ' ');
  db.prepare('INSERT INTO memos (patient_name, date, memo, category, author_id, author_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(patientName, date, memo, cat, req.user.id, req.user.displayName, now);
  
  res.json({ message: '메모 저장 완료' });
});

// Edit memo (author or admin only)
app.put('/api/memos/:id', auth, (req, res) => {
  const memo = db.prepare('SELECT * FROM memos WHERE id = ?').get(req.params.id);
  if (!memo) return res.status(404).json({ error: '메모 없음' });
  if (memo.author_id !== req.user.id && req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: '수정 권한 없음' });
  }
  const { memo: text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: '내용 없음' });
  db.prepare('UPDATE memos SET memo = ? WHERE id = ?').run(text.trim(), req.params.id);
  res.json({ message: '수정 완료' });
});

// Delete memo (author or admin only)
app.delete('/api/memos/:id', auth, (req, res) => {
  const memo = db.prepare('SELECT * FROM memos WHERE id = ?').get(req.params.id);
  if (!memo) return res.status(404).json({ error: '메모 없음' });
  if (memo.author_id !== req.user.id && req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: '삭제 권한 없음' });
  }
  db.prepare('DELETE FROM memos WHERE id = ?').run(req.params.id);
  res.json({ message: '삭제 완료' });
});

// ========== ADMIN: RESET THERAPIST MAPPING ==========

app.put('/api/admin/users/:id/reset-mapping', auth, adminOnly, (req, res) => {
  db.prepare('UPDATE users SET therapist_column = NULL, category = NULL WHERE id = ?').run(req.params.id);
  res.json({ message: '매핑 초기화 완료' });
});

// Schedule change detection
const crypto = require('crypto');
const webpush = require('web-push');
let sseClients = [];

// VAPID keys (created once and stored)
const VAPID_PATH = path.join(__dirname, 'data', 'vapid.json');
function loadOrCreateVapid() {
  try {
    if (fs.existsSync(VAPID_PATH)) return JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
  } catch(e) {}
  const keys = webpush.generateVAPIDKeys();
  const vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey, createdAt: new Date().toISOString() };
  try { fs.mkdirSync(path.dirname(VAPID_PATH), { recursive: true }); } catch(e) {}
  fs.writeFileSync(VAPID_PATH, JSON.stringify(vapid, null, 2));
  return vapid;
}
const vapidKeys = loadOrCreateVapid();
webpush.setVapidDetails('mailto:jjermrehab@gmail.com', vapidKeys.publicKey, vapidKeys.privateKey);

// Push subscriptions
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(user_id, endpoint)
  )`).run();
} catch(e) { console.error('push_subscriptions table error:', e.message); }

function sendPushToUsers(userIds, payloadObj) {
  if (!userIds || userIds.length === 0) return;
  const payload = JSON.stringify(payloadObj);
  const placeholders = userIds.map(()=>'?').join(',');
  const rows = db.prepare(`SELECT * FROM push_subscriptions WHERE user_id IN (${placeholders})`).all(...userIds);
  for (const r of rows) {
    const sub = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
    webpush.sendNotification(sub, payload).catch(err => {
      if (err.statusCode === 404 || err.statusCode === 410) {
        try { db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(r.id); } catch(e) {}
      }
    });
  }
}

function detectChanges() {
  try {
    if (!fs.existsSync(SCHEDULE_PATH)) return;
    const raw = fs.readFileSync(SCHEDULE_PATH, 'utf-8');
    const newHash = crypto.createHash('md5').update(raw).digest('hex');
    if (lastScheduleHash && newHash !== lastScheduleHash) {
      // Find what changed for today
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
      const newData = JSON.parse(raw);
      const oldRow = db.prepare('SELECT data FROM schedule_history WHERE date = ?').get(today);
      
      if (oldRow && newData[today]) {
        const oldDay = JSON.parse(oldRow.data);
        const newDay = newData[today];
        const changes = [];
        const now = new Date().toLocaleTimeString('sv-SE', { timeZone: 'Asia/Seoul' }).substring(0, 5);
        
        // Compare timeSlots
        for (let i = 0; i < Math.max(oldDay.timeSlots?.length || 0, newDay.timeSlots?.length || 0); i++) {
          const oldSlot = oldDay.timeSlots?.[i] || {};
          const newSlot = newDay.timeSlots?.[i] || {};
          const time = newSlot.time || oldSlot.time || '';
          
          for (const col of Object.keys(newDay.therapists || {})) {
            const oldText = oldSlot.patients?.[col]?.text || '';
            const newText = newSlot.patients?.[col]?.text || '';
            if (oldText !== newText) {
              changes.push({
                date: today, col, time,
                therapist: newDay.therapists[col]?.name || col,
                oldText: oldText || '(빈칸)',
                newText: newText || '(빈칸)',
                timestamp: now
              });
            }
          }
        }
        
        // Compare absences
        for (const col of Object.keys(newDay.therapists || {})) {
          const oldAbs = (oldDay.absencesByCol?.[col] || []).join(',');
          const newAbs = (newDay.absencesByCol?.[col] || []).join(',');
          if (oldAbs !== newAbs) {
            changes.push({
              date: today, col, time: '결석',
              therapist: newDay.therapists[col]?.name || col,
              oldText: oldAbs || '(없음)',
              newText: newAbs || '(없음)',
              timestamp: now
            });
          }
        }
        
        if (changes.length > 0) {
          scheduleChanges = changes;
          console.log(`📋 ${changes.length} changes detected for ${today}`);

          // Notify SSE clients
          sseClients.forEach(res => {
            try { res.write(`data: ${JSON.stringify({ type: 'change', changes })}\n\n`); } catch(e) {}
          });

          // Push (personal): only users whose therapist_column is affected
          try {
            const affectedCols = [...new Set(changes.map(c => c.col).filter(Boolean))];
            if (affectedCols.length > 0) {
              const placeholders = affectedCols.map(()=>'?').join(',');
              const urows = db.prepare(`SELECT id FROM users WHERE therapist_column IN (${placeholders}) AND status='approved'`).all(...affectedCols);
              const userIds = urows.map(r => r.id);
              // Summary only
              sendPushToUsers(userIds, { title: '내 스케줄 변경', body: `변경 ${changes.length}건`, url: '/' });
            }
          } catch(e) { console.error('push notify error:', e.message); }
        }
      }
      
      // Auto-backup new version
      if (newData[today]) {
        db.prepare('INSERT OR REPLACE INTO schedule_history (date, data) VALUES (?, ?)')
          .run(today, JSON.stringify(newData[today]));
      }
    }
    lastScheduleHash = newHash;
  } catch(e) { console.error('Change detect error:', e.message); }
}

// Initial hash
try { lastScheduleHash = crypto.createHash('md5').update(fs.readFileSync(SCHEDULE_PATH, 'utf-8')).digest('hex'); } catch(e) {}

// Watch for file changes
fs.watchFile(SCHEDULE_PATH, { interval: 30000 }, detectChanges);

// SSE endpoint (token via query param since EventSource can't set headers)
app.get('/api/events', (req, res) => {
  try {
    const t = req.query.token;
    if (!t) return res.status(401).end();
    jwt.verify(t, JWT_SECRET);
  } catch(e) { return res.status(401).end(); }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  sseClients.push(res);
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
});

// Push: public key
app.get('/api/push/public-key', auth, (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// Push: subscribe/unsubscribe
app.post('/api/push/subscribe', auth, (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  db.prepare('INSERT OR REPLACE INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)')
    .run(req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', auth, (req, res) => {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

// Get today's changes
app.get('/api/changes', auth, (req, res) => {
  res.json(scheduleChanges);
});

// 🍱 점심 채팅 + 🎰 복권 (이스터에그)
db.exec(`
  CREATE TABLE IF NOT EXISTS lunch_lottery (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    display_name TEXT NOT NULL,
    date TEXT NOT NULL,
    won INTEGER DEFAULT 0,
    amount INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, date)
  );
  CREATE TABLE IF NOT EXISTS lunch_chat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    display_name TEXT NOT NULL,
    message TEXT NOT NULL,
    emoji TEXT DEFAULT '😊',
    date TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 🎰 복권 응모
const LOTTERY_WIN_RATE = 0.20; // 20% 기본 확률
const LOTTERY_MAX_WINNERS = 2; // 하루 최대 당첨자 수
const LOTTERY_PRIZE = 1000;    // 당첨금액 1,000원

app.post('/api/lunch/lottery', auth, (req, res) => {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const today = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10)
    || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const hour = now.getHours();
  const dow = now.getDay(); // 0=Sun, 6=Sat

  // 운영시간 체크 (admin 제외)
  if (req.user.role !== 'admin') {
    let open = false;
    if (dow === 0) {
      // 일요일: 비운영
      open = false;
    } else if (dow === 6) {
      // 토요일: 08:00 ~ 13:00
      open = hour >= 8 && hour < 13;
    } else {
      // 평일(월~금): 08:00 ~ 18:00
      open = hour >= 8 && hour < 18;
    }
    if (!open) {
      const msg = dow === 6
        ? '🎰 복권 운영시간이 아닙니다\n토요일은 오전 8시 ~ 오후 1시에만 응모 가능해요!'
        : dow === 0
        ? '🎰 복권 운영시간이 아닙니다\n일요일은 운영하지 않아요!'
        : '🎰 복권 운영시간이 아닙니다\n평일 오전 8시 ~ 오후 6시에만 응모 가능해요!';
      return res.status(403).json({ error: 'outsideHours', message: msg });
    }
  }

  // admin만 항상 허용, 치료사/매니저는 근무일만
  if (req.user.role === 'therapist' || req.user.role === 'manager') {
    const user = db.prepare('SELECT therapist_column FROM users WHERE id = ?').get(req.user.id);
    const col = user?.therapist_column;
    if (!col) return res.status(403).json({ error: 'notWorking', message: '시간표 컬럼이 배정되지 않았어요' });

    let scheduleData = {};
    try { scheduleData = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf-8')); } catch(e) {}
    const todayData = scheduleData[today];
    if (!todayData) return res.status(403).json({ error: 'notWorking', message: '오늘 시간표가 없어요' });

    // 오늘 해당 치료사 컬럼에 환자가 1명이라도 있는지 확인
    const cols = col.split(',').map(c => c.trim());
    const hasWork = (todayData.timeSlots || []).some(slot =>
      cols.some(c => slot.patients && slot.patients[c] && slot.patients[c].name)
    );
    if (!hasWork) return res.status(403).json({ error: 'notWorking', message: '오늘 근무일이 아니에요! 근무하는 날만 응모 가능해요 😊' });
  }

  // 오늘 이미 응모했는지 확인
  const existing = db.prepare('SELECT * FROM lunch_lottery WHERE user_id = ? AND date = ?').get(req.user.id, today);
  if (existing) {
    return res.json({ alreadyDrawn: true, won: existing.won === 1, amount: existing.amount });
  }
  // 오늘 이미 당첨자 수 확인 (admin 제외)
  const isAdmin = req.user.role === 'admin';
  const todayWinners = db.prepare(`
    SELECT COUNT(*) as cnt FROM lunch_lottery l
    JOIN users u ON l.user_id = u.id
    WHERE l.date = ? AND l.won = 1 AND u.role != 'admin'
  `).get(today);
  const maxReached = !isAdmin && todayWinners.cnt >= LOTTERY_MAX_WINNERS;

  const won = !maxReached && Math.random() < LOTTERY_WIN_RATE;
  const amount = won ? LOTTERY_PRIZE : 0;
  db.prepare('INSERT INTO lunch_lottery (user_id, display_name, date, won, amount) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, req.user.displayName || req.user.display_name, today, won ? 1 : 0, amount);
  res.json({ alreadyDrawn: false, won, amount, maxReached, todayWinners: todayWinners.cnt });
});

app.get('/api/lunch/lottery/today', auth, (req, res) => {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const entry = db.prepare('SELECT * FROM lunch_lottery WHERE user_id = ? AND date = ?').get(req.user.id, today);
  res.json(entry || null);
});

// 내 응모 초기화 (관리자 전용)
app.delete('/api/lunch/lottery/my', auth, adminOnly, (req, res) => {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  db.prepare('DELETE FROM lunch_lottery WHERE user_id = ? AND date = ?').run(req.user.id, today);
  res.json({ ok: true });
});

// 월별 당첨 내역 (관리자)
app.get('/api/lunch/lottery/monthly', auth, adminOnly, (req, res) => {
  const { month } = req.query; // 'YYYY-MM'
  const target = month || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 7);
  const rows = db.prepare(`
    SELECT display_name, COUNT(*) as draws, SUM(won) as wins, SUM(amount) as total_amount
    FROM lunch_lottery WHERE date LIKE ? GROUP BY user_id, display_name ORDER BY total_amount DESC
  `).all(`${target}%`);
  const total = rows.reduce((s, r) => s + r.total_amount, 0);
  res.json({ month: target, rows, total });
});

app.get('/api/lunch/messages', auth, (req, res) => {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const msgs = db.prepare('SELECT * FROM lunch_chat WHERE date = ? ORDER BY created_at ASC LIMIT 50').all(today);
  res.json(msgs);
});

app.post('/api/lunch/messages', auth, (req, res) => {
  const { message, emoji } = req.body;
  if (!message || message.trim().length === 0) return res.status(400).json({ error: '메시지를 입력해주세요' });
  if (message.length > 100) return res.status(400).json({ error: '100자 이내로 입력해주세요' });
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const result = db.prepare('INSERT INTO lunch_chat (user_id, display_name, message, emoji, date) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, req.user.displayName || req.user.display_name, message.trim(), emoji || '😊', today);
  const msg = db.prepare('SELECT * FROM lunch_chat WHERE id = ?').get(result.lastInsertRowid);
  res.json(msg);
});

app.delete('/api/lunch/messages/:id', auth, (req, res) => {
  const msg = db.prepare('SELECT * FROM lunch_chat WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: '없음' });
  if (msg.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: '권한 없음' });
  db.prepare('DELETE FROM lunch_chat WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Auto-backup at 18:30 KST daily
function scheduleDailyBackup() {
  const now = new Date();
  const kstStr = now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' });
  const kst = new Date(kstStr);
  const target = new Date(kst);
  target.setHours(18, 30, 0, 0);
  if (kst >= target) target.setDate(target.getDate() + 1);
  const delay = target - kst;
  setTimeout(() => {
    try {
      const schedData = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf-8'));
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
      if (schedData[today]) {
        db.prepare('INSERT OR REPLACE INTO schedule_history (date, data) VALUES (?, ?)').run(today, JSON.stringify(schedData[today]));
        console.log('✅ Auto-backup:', today);
      }
    } catch(e) { console.error('Backup error:', e.message); }
    scheduleDailyBackup();
  }, delay);
  console.log('📅 Next backup in', Math.round(delay/1000/60), 'min');
}
scheduleDailyBackup();

// ===== 출석체크 DB + API =====
db.exec(`CREATE TABLE IF NOT EXISTS attendance_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  att_key TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(date, att_key)
)`);

// 날짜별 출석체크 목록
app.get('/api/attendance', auth, (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });
  const rows = db.prepare('SELECT att_key FROM attendance_checks WHERE date = ? AND checked = 1').all(date);
  res.json(rows.map(r => r.att_key));
});

// 출석체크 토글
app.post('/api/attendance', auth, (req, res) => {
  const { date, att_key } = req.body;
  if (!date || !att_key) return res.status(400).json({ error: 'date and att_key required' });
  const existing = db.prepare('SELECT checked FROM attendance_checks WHERE date = ? AND att_key = ?').get(date, att_key);
  let checked;
  if (existing) {
    checked = existing.checked ? 0 : 1;
    db.prepare("UPDATE attendance_checks SET checked = ?, updated_at = datetime('now','localtime') WHERE date = ? AND att_key = ?").run(checked, date, att_key);
  } else {
    checked = 1;
    db.prepare('INSERT INTO attendance_checks (date, att_key, checked) VALUES (?, ?, 1)').run(date, att_key);
  }
  // SSE 브로드캐스트
  sseClients.forEach(c => {
    try { c.write(`data: ${JSON.stringify({ type: 'attendance', date, att_key, checked })}\n\n`); } catch(e) {}
  });
  res.json({ att_key, checked });
});

// SPA fallback — must be LAST (after all API routes)
app.get('/{*path}', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🏥 재활 시간표 서버: http://0.0.0.0:${PORT}`);
});
