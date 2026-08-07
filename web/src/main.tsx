import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import './style.css';

type Thread = { id:string; name:string|null; preview:string; cwd:string; updatedAt:number; status:{type:string}; turns?:Turn[] };
type Turn = { id:string; status:string; items:any[] };
type Project = { id:string; name:string; path:string; updatedAt:number; sessions:Thread[] };
const storedToken = () => localStorage.getItem('bridge-token') ?? '';
async function api(path:string, init:RequestInit={}) { const res=await fetch('/api'+path,{...init,headers:{'content-type':'application/json',authorization:`Bearer ${storedToken()}`,...init.headers}}); if(!res.ok) throw new Error((await res.json()).error||res.statusText); return res.json(); }

function App(){
  const [ready,setReady]=useState(!!storedToken()), [projects,setProjects]=useState<Project[]>([]), [project,setProject]=useState<Project>(), [thread,setThread]=useState<Thread>(), [text,setText]=useState(''), [error,setError]=useState(''), [online,setOnline]=useState(false);
  const load=async()=>{try{const x=await api('/projects');setProjects(x.projects);if(project)setProject(x.projects.find((p:Project)=>p.id===project.id));}catch(e:any){setError(e.message);}};
  useEffect(()=>{const pair=new URLSearchParams(location.search).get('pair');if(!ready&&pair)api('/pair',{method:'POST',body:JSON.stringify({code:pair}),headers:{authorization:''}}).then(x=>{localStorage.setItem('bridge-token',x.token);history.replaceState({},'',location.pathname);setReady(true)}).catch(e=>setError(e.message));},[]);
  useEffect(()=>{if(!ready)return;load();const proto=location.protocol==='https:'?'wss':'ws';const ws=new WebSocket(`${proto}://${location.host}/api/events?token=${encodeURIComponent(storedToken())}`);ws.onopen=()=>setOnline(true);ws.onclose=()=>setOnline(false);ws.onmessage=()=>{load();if(thread)openThread(thread.id)};return()=>ws.close()},[ready,thread?.id]);
  const openThread=async(id:string)=>{try{const x=await api('/threads/'+id);setThread(x.thread)}catch(e:any){setError(e.message)}};
  const send=async()=>{if(!thread||!text.trim())return;const value=text;setText('');try{await api(`/threads/${thread.id}/turns`,{method:'POST',body:JSON.stringify({text:value})});await openThread(thread.id)}catch(e:any){setError(e.message)}};
  const items=useMemo(()=>thread?.turns?.flatMap(t=>t.items.map(i=>({...i,turnId:t.id,turnStatus:t.status})))??[],[thread]);
  if(!ready)return <main className="pair"><div className="mark">⌘</div><h1>连接你的 Mac</h1><p>请扫描 Mac Bridge 启动时显示的二维码，或在包含配对码的链接中打开此页面。</p>{error&&<p className="error">{error}</p>}</main>;
  return <div className="shell">
    <header><button className="brand" onClick={()=>{setProject(undefined);setThread(undefined)}}>⌘ <b>Codex</b></button><span className={'signal '+(online?'on':'')}>{online?'Mac 在线':'正在重连'}</span></header>
    {!project&&!thread&&<main><div className="eyebrow">PROJECTS · {projects.length}</div><h1>Mac 上的工作</h1><div className="rule"/>{projects.map(p=><button className="project" key={p.id} onClick={()=>setProject(p)}><div><h2>{p.name}</h2><p>{p.path}</p></div><div className="count"><b>{p.sessions.length}</b><span>Sessions</span></div></button>)}</main>}
    {project&&!thread&&<main><button className="back" onClick={()=>setProject(undefined)}>‹ 所有项目</button><div className="eyebrow">{project.path}</div><h1>{project.name}</h1><div className="rule"/>{project.sessions.map(s=><button className="session" key={s.id} onClick={()=>openThread(s.id)}><span className={'dot '+s.status.type}/><div><h2>{s.name||s.preview||'未命名 Session'}</h2><p>{new Date(s.updatedAt*1000).toLocaleString()}</p></div><span>›</span></button>)}</main>}
    {thread&&<main className="conversation"><button className="back" onClick={()=>setThread(undefined)}>‹ {project?.name||'返回'}</button><div className="thread-title"><div><div className="eyebrow">SESSION</div><h1>{thread.name||thread.preview||'未命名'}</h1></div><span className={'state '+thread.status.type}>{thread.status.type==='active'?'运行中':'空闲'}</span></div><div className="messages">{items.map((item:any)=><Item key={item.id} item={item}/>)}</div><form onSubmit={e=>{e.preventDefault();send()}}><textarea aria-label="发送任务" placeholder="让 Codex 继续…" value={text} onChange={e=>setText(e.target.value)}/><button disabled={!text.trim()}>↑</button></form></main>}
    {error&&<button className="toast" onClick={()=>setError('')}>{error}</button>}
  </div>
}
function Item({item}:{item:any}){if(item.type==='userMessage'){const text=item.content?.filter((x:any)=>x.type==='text').map((x:any)=>x.text).join('\n');return <article className="message user"><ReactMarkdown>{text}</ReactMarkdown></article>}if(item.type==='agentMessage')return <article className="message agent"><ReactMarkdown>{item.text}</ReactMarkdown></article>;if(['commandExecution','mcpToolCall','dynamicToolCall','webSearch','imageView'].includes(item.type))return <details className="tool"><summary><span>{item.type}</span><b>{item.status||item.turnStatus}</b></summary><pre>{item.command||item.tool||item.path||JSON.stringify(item.arguments,null,2)}</pre>{item.aggregatedOutput&&<pre>{item.aggregatedOutput}</pre>}</details>;return null}
createRoot(document.getElementById('root')!).render(<App/>);
