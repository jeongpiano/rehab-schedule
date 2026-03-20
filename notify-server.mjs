// Lightweight notification relay — runs on macbook, sends email via gog
import http from 'http';
import { execSync } from 'child_process';

const PORT = 3457;

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/notify') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.event === 'signup') {
          const subject = `[시간표] 새 가입: ${data.displayName}`;
          const text = `새 사용자 가입\n\n이름: ${data.displayName}\nID: ${data.username}\n카테고리: ${data.category || '미지정'}\n매핑: ${data.therapistColumn || '미매핑'}\n\n승인: https://schedule.lesprit.ddnsfree.com`;
          execSync(`gog gmail send --to lesprit@gmail.com --subject "${subject}" --body "${text.replace(/"/g, '\\"')}"`, { timeout: 15000 });
          console.log(`✉️ Signup email sent for: ${data.displayName}`);
        }
      } catch(e) { console.error('Notify error:', e.message); }
      res.writeHead(200);
      res.end('ok');
    });
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(PORT, () => console.log(`Notify server on :${PORT}`));
