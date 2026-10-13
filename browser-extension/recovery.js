const id = new URL(location.href).searchParams.get('id');
const status = document.getElementById('status');
let job;
const ask = (type, extra = {}) => chrome.runtime.sendMessage({ type, id, ...extra });
async function load() {
  const response = await ask('import-load');
  job = response?.job;
  if (!job) { status.textContent = '记录已过期，请回到论文网页重新导入。'; return; }
  document.getElementById('title').textContent = job.paper.title;
  const busy = ['downloading', 'handoff', 'sent'].includes(job.state);
  const received = job.state === 'accepted';
  const unconfirmed = job.state === 'unconfirmed';
  status.textContent = received ? '已加入论文库' : unconfirmed ? '尚未收到 App 接收确认' : job.state === 'sent' ? '等待 App 接收…' : busy ? '正在下载全文…' : job.errors.at(-1)?.message || '选择全文链接';
  document.getElementById('submit').disabled = busy || received || unconfirmed;
  const list = document.getElementById('candidates'); list.replaceChildren();
  if (unconfirmed) {
    const resend = document.createElement('button'); resend.textContent = '重新发送给 App';
    resend.onclick = async () => { resend.disabled = true; const result = await ask('import-resend'); if (result?.error) status.textContent = result.error; else await load(); };
    list.append(resend);
  }
  for (const candidate of job.candidates) {
    const row = document.createElement('div'); row.className = 'candidate';
    const text = document.createElement('span'); text.textContent = candidate.label;
    const host = document.createElement('small'); host.textContent = new URL(candidate.url).hostname; text.append(host);
    const open = document.createElement('button'); open.textContent = '打开'; open.onclick = () => chrome.tabs.create({ url: candidate.url });
    const select = document.createElement('button'); select.textContent = '导入'; select.disabled = busy || received || unconfirmed; select.onclick = () => retry(candidate.url);
    row.append(text, open, select); list.append(row);
  }
  document.getElementById('source').disabled = !job.paper.sourceUrl;
  document.getElementById('diagnostics').textContent = job.errors.map(({ url, message }) => `${message}\n${url || ''}`).join('\n\n');
}
async function retry(url) {
  document.getElementById('submit').disabled = true;
  const result = await ask('import-retry', { url });
  if (result?.error) status.textContent = result.error;
  else await load();
}
document.getElementById('manual').onsubmit = (event) => { event.preventDefault(); retry(document.getElementById('url').value).catch((error) => { status.textContent = String(error); }); };
document.getElementById('source').onclick = () => { if (job?.paper.sourceUrl) chrome.tabs.create({ url: job.paper.sourceUrl }); };
document.getElementById('refresh').onclick = () => load();
chrome.runtime.onMessage.addListener((message) => { if (message.type === 'import-updated' && message.id === id) load(); });
load().catch((error) => { status.textContent = String(error); });
