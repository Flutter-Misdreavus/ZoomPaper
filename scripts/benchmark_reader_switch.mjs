/** 独立 Chromium 基准：真实 Reader/PDF/Markdown + 合成论文 + 内存中的 Tauri 替身。
 * 不接触用户数据库。node scripts/benchmark_reader_switch.mjs --source <repo> --output <json>
 */
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer, build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const source = path.resolve(option('--source', '.'));
const output = path.resolve(option('--output', '/private/tmp/zoompaper-reader-performance.json'));
const chromePath = option('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const modes = option('--modes', 'development,production').split(',');
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'zoompaper-reader-bench-')));
let browser, server;
const logs = [];

function makePdf(pages, dense = false) {
  const objects = [];
  const add = value => { objects.push(value); return objects.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${Array.from({length:pages},(_,i)=>`${4+i*2} 0 R`).join(' ')}] /Count ${pages} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for(let i=0;i<pages;i++) {
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`);
    const lines = Array.from({length:dense?60:38},(_,j)=>`(Page ${i+1} line ${j+1}: Attention and memory update in scientific papers.) Tj 0 -11 Td`).join('\n');
    const stream = `BT /F1 9 Tf 35 750 Td\n${lines}\nET`;
    add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = '%PDF-1.4\n', offsets=[0];
  objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;});
  const start=Buffer.byteLength(pdf);
  pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return pdf;
}

class CDP {
  constructor(ws) { this.ws=ws;this.sequence=0;this.pending=new Map(); ws.addEventListener('message', event=>{const message=JSON.parse(event.data);if(message.id){const p=this.pending.get(message.id);if(p){this.pending.delete(message.id);message.error?p.reject(new Error(JSON.stringify(message.error))):p.resolve(message.result);}}}); }
  call(method,params={}) {const id=++this.sequence;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});}
  async evaluate(expression) {const value=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(value.exceptionDetails)throw new Error(JSON.stringify(value.exceptionDetails));return value.result.value;}
}
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
const quantile = (sorted,q) => sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*q)-1)];

try {
  await mkdir(path.join(fixture,'public'));
  for(const [id,pages] of [['short',8],['long',80],['math',40]]) await writeFile(path.join(fixture,'public',`${id}.pdf`),makePdf(pages,id==='math'));
  await writeFile(path.join(fixture,'index.html'),'<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
  const documents = Object.fromEntries(['short', 'long', 'math'].map(id => [id,
    Array.from({length: id === 'short' ? 8 : id === 'long' ? 100 : 50}, (_, i) =>
      '## Section ' + (i + 1) + '\n\nPaper reading and knowledge management. **Attention mechanisms** retain useful information in a recurrent memory. We compare models, experiments, and limitations.\n\n' +
      (id === 'math' ? String.raw`Inline $S_t = S_{t-1} + k_t v_t^\top$ and $\frac{a[0]}{b[1]}$.

$$
\sum_{t=1}^{T}\frac{x_t^2}{1+\exp(-x_t)}
$$

` : '')).join('\n\n')
  ]));
  const mock = `export const documents = ${JSON.stringify(documents)};
const paper = (id: string) => ({id,title:id,authors:'Synthetic benchmark',parse_status:'ready',reading_status:'reading',total_read_seconds:0,pdf_path:'/'+id+'.pdf',md_path:'/'+id+'.md',blog_md_path:'/'+id+'.md',venue:null});
export const convertFileSrc=(value:string)=>value;
export class Channel { onmessage=()=>{}; }
export async function invoke(command:string,args:any={}) {
  (window as any).__bench.calls[command]=((window as any).__bench.calls[command]??0)+1;
  if(['get_paper','open_paper','refresh_paper_publication','mark_paper_read','set_paper_status'].includes(command))return paper(args.paperId);
  if(command==='get_paper_md')return documents[args.paperId];
  if(command==='get_translation')return documents[args.paperId].split(/(?=## Section)/).filter(Boolean).map((en:string)=>({en,zh:en}));
  if(command==='get_annotations')return null;
  if(command==='get_settings')return {providers:[],web_search_provider:'none'};
  if(['list_conversations','list_conversation_summaries','quiz_list'].includes(command))return [];
  return null;
}`;
  await writeFile(path.join(fixture,'tauri.ts'),mock);
  await writeFile(path.join(fixture,'main.tsx'),`
import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
import {Reader} from ${JSON.stringify(path.join(source,'src/pages/Reader.tsx'))};
import {documents} from './tauri';
import ${JSON.stringify(path.join(source,'src/styles.css'))}; import 'katex/dist/katex.min.css';
(window as any).__bench={markdown:0,pdfRenders:0,calls:{},longtasks:[]};
if(PerformanceObserver.supportedEntryTypes.includes('longtask'))new PerformanceObserver(list=>{(window as any).__bench.longtasks.push(...list.getEntries().map(e=>e.duration));}).observe({type:'longtask'});
const originalFetch=window.fetch; window.fetch=(input,init)=>{const name=String(input);const id=/^\\/(short|long|math)\\.md$/.exec(name)?.[1];return id?Promise.resolve(new Response(documents[id])):originalFetch(input,init);};
const surface=new URLSearchParams(location.search).get('surface')??'pdf';
for(const id of ['short','long','math']){localStorage.setItem('zoompaper.readerMode.'+id,surface);localStorage.setItem('zoompaper.translationMode.'+id,'bi');}
localStorage.setItem('zoompaper.preferences',JSON.stringify({showAssistant:false,markReading:false}));
const noop=()=>{};
function Harness(){const [active,setActive]=useState('short');return <div className="flex h-screen flex-col"><nav>{['short','long','math'].map(id=><button data-paper={id} onClick={()=>setActive(id)} key={id}>{id}</button>)}</nav>{['short','long','math'].map(id=><div data-reader={id} key={id} style={{display:active===id?'flex':'none'}} className="min-h-0 flex-1 flex-col p-6"><Reader paperId={id} active={active===id} onBack={noop}/></div>)}</div>}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Harness/></React.StrictMode>);
(window as any).runReaderBenchmark=async()=>{const wait=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));for(const id of ['short','long','math']){document.querySelector<HTMLButtonElement>('[data-paper="'+id+'"]')!.click();await new Promise(r=>setTimeout(r,900));}await wait();const shown=document.querySelector('[data-reader="math"]')!;const snapshot={articles:shown.querySelectorAll('article').length,formulas:shown.querySelectorAll('.katex').length,canvases:shown.querySelectorAll('canvas').length};if(surface==='pdf'&&!snapshot.canvases)throw new Error('PDF fixture did not render');if(surface!=='pdf'&&(!snapshot.articles||!snapshot.formulas))throw new Error('Markdown fixture did not render');const bench=(window as any).__bench;bench.markdown=0;bench.pdfRenders=0;bench.calls={};bench.longtasks=[];const times=[];for(let i=0;i<30;i++){const start=performance.now();document.querySelector<HTMLButtonElement>('[data-paper="'+['short','long','math'][i%3]+'"]')!.click();await wait();times.push(performance.now()-start);}return {times,snapshot,...bench,resources:(window as any).zoompaperPdfResources?.stats()??null,heap:(performance as any).memory?.usedJSHeapSize??null};};
`);
  const instrument={name:'reader-benchmark-counters',enforce:'pre',transform(code,id){
    if(id.endsWith('/src/components/MarkdownView.tsx'))return code.replace(/(function MarkdownView\([^]*?\) \{)/,'$1\n(window as any).__bench.markdown++;');
    if(id.endsWith('/src/components/PdfViewer.tsx'))return code.replace(/(async function renderPage\([^]*?\) \{)/,'$1\n(window as any).__bench.pdfRenders++;');
  }};
  const configuration={configFile:false,root:fixture,cacheDir:path.join(fixture,'cache/node_modules/.vite'),plugins:[instrument,react(),tailwindcss()],resolve:{dedupe:['react','react-dom'],alias:[{find:'@tauri-apps/api/core',replacement:path.join(fixture,'tauri.ts')},{find:'@',replacement:path.join(source,'src')},{find:'react',replacement:path.resolve('node_modules/react')},{find:'react-dom',replacement:path.resolve('node_modules/react-dom')},{find:'katex',replacement:path.resolve('node_modules/katex')}]},server:{hmr:false,fs:{allow:[fixture,source,path.resolve('.')]},host:'127.0.0.1'},build:{outDir:path.join(fixture,'out'),emptyOutDir:true},logLevel:'warn'};
  browser=spawn(chromePath,['--headless=new','--disable-gpu','--no-first-run','--disable-background-networking','--no-default-browser-check','--enable-precise-memory-info','--remote-debugging-port=0',`--user-data-dir=${path.join(fixture,'chrome')}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
  let stderr='';browser.stderr.on('data',data=>{stderr+=data;});
  let endpoint;
  for(let i=0;i<100;i++){try{const info=await readFile(path.join(fixture,'chrome','DevToolsActivePort'),'utf8');endpoint='http://127.0.0.1:'+info.split('\n')[0];break;}catch{if(browser.exitCode!==null)throw new Error('Chrome startup failed: '+stderr);await delay(100);}}
  if(!endpoint)throw new Error('Chrome did not expose a debugging endpoint: '+stderr);
  const tab=await (await fetch(endpoint+'/json/new?about:blank', {method:'PUT'})).json();
  const ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  const cdp=new CDP(ws);await cdp.call('Page.enable');await cdp.call('Runtime.enable');
  ws.addEventListener('message', event => { const message=JSON.parse(event.data); if(message.method==='Runtime.exceptionThrown') console.log('PAGE ERROR: '+JSON.stringify(message.params.exceptionDetails).slice(0,1200)); });
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:2,mobile:false});
  for(const mode of modes){
    if(mode==='development'){server=await createServer(configuration);await server.listen();}
    else {await build(configuration);server=await preview({...configuration,preview:{host:'127.0.0.1',port:0}});}
    const address=server.httpServer?.address();
    const port=typeof address==='object'&&address?address.port:new URL(server.resolvedUrls.local[0]).port;
    for(const surface of ['pdf','translate','blog']){
      const url = `http://127.0.0.1:${port}/?surface=${surface}`;
      console.log('Measuring '+mode+'/'+surface);
      await cdp.call('Page.navigate',{url});
      let ready=false;
      for(let i=0;i<200;i++){try{ready=await cdp.evaluate(`location.href === ${JSON.stringify(url)} && typeof window.runReaderBenchmark === "function" && document.querySelector("[data-paper]") !== null`);}catch{}if(ready)break;await delay(100);}
      if(!ready)throw new Error('Fixture failed to initialize: '+mode+'/'+surface);
      await delay(mode === 'development' ? 5000 : 1000);
      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { result = await cdp.evaluate('window.runReaderBenchmark()'); break; }
        catch (error) { console.log('Retrying page initialization', await cdp.evaluate('JSON.stringify({url:location.href,text:document.body.innerText.slice(0,1200)})')); if (attempt === 2 || !(/navigated|runReaderBenchmark/.test(String(error)))) throw error; await delay(3000); }
      }
      const sorted=[...result.times].sort((a,b)=>a-b);
      let rss=null;try{const processes=await (await fetch(endpoint+'/json/version')).json();const socket=new WebSocket(processes.webSocketDebuggerUrl);await new Promise(r=>socket.addEventListener('open',r,{once:true}));const browserCdp=new CDP(socket);const info=await browserCdp.call('SystemInfo.getProcessInfo');rss=execFileSync('ps',['-o','rss=','-p',info.processInfo.map(p=>p.id).join(',')],{encoding:'utf8'}).trim().split(/\s+/).reduce((sum,value)=>sum+Number(value),0)*1024;socket.close();}catch{}
      const row={mode,surface,medianMs:quantile(sorted,.5),p95Ms:quantile(sorted,.95),processRssBytes:rss,...result};logs.push(row);console.log(JSON.stringify({mode,surface,medianMs:row.medianMs,p95Ms:row.p95Ms,markdown:row.markdown,pdfRenders:row.pdfRenders}));
    }
    if (server.close) await server.close(); else await new Promise(resolve => server.httpServer.close(resolve));
    server=null;
  }
  ws.close();await writeFile(output,JSON.stringify({source,fixture:'synthetic: short 8 pages / long 80 pages / math 40 pages; DPR 2; 1440x1000',engine:'Chromium headless; mocked Tauri IO; not WKWebView',results:logs},null,2));console.log('Report: '+output);
}finally{if(server?.close) await server.close(); else server?.httpServer.close();browser?.kill();await delay(200);await rm(fixture,{recursive:true,force:true});}

process.exit(0);
