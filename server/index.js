const http = require('http');
const path = require('path');
const fs = require('fs');
const PORT = process.env.PORT || 3000;
const ROOM_TTL = 5 * 60 * 1000;
const rooms = new Map();
function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function makeCode() {
  const w = ['amber','arctic','azure','cedar','cloud','coral','dawn','delta','dusk','ember','fern','flame','frost','ghost','gold','grove','haven','iron','jade','karma','lake','lemon','lime','lunar','maple','mist','moon','moss','nova','oak','opal','pearl','pine','rain','raven','reed','ridge','river','rose','ruby','sage','salt','sand','shadow','shore','silver','slate','smoke','snow','spark','star','steel','storm','tide','timber','topaz','vault','veil','wave','wild','wind','wolf'];
  const p = () => w[Math.floor(Math.random()*w.length)];
  return `${p()}-${p()}-${Math.floor(Math.random()*90+10)}`;
}
setInterval(() => { const now=Date.now(); for(const[k,r]of rooms) if(now-r.lastActivity>ROOM_TTL){rooms.delete(k);console.log(`Room ${k} expired`);} }, 30000);
function ok(res,data){res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Cache-Control':'no-cache'});res.end(JSON.stringify(data));}
function err(res,msg,s=400){res.writeHead(s,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify({error:msg}));}
function serveStatic(req,res){
  let url=req.url==='/'?'/index.html':req.url.split('?')[0];
  if(!url.startsWith('/')||url.includes('..')){res.writeHead(403);res.end();return;}
  fs.readFile(path.join(__dirname,'../client',url),(e,data)=>{
    if(e){fs.readFile(path.join(__dirname,'../client/index.html'),(e2,d2)=>{if(e2){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(d2);});return;}
    const t={'.html':'text/html','.js':'text/javascript','.css':'text/css','.ico':'image/x-icon'};
    res.writeHead(200,{'Content-Type':t[path.extname(url)]||'text/plain'});res.end(data);
  });
}
const srv=http.createServer((req,res)=>{
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST','Access-Control-Allow-Headers':'Content-Type'});res.end();return;}
  const u=new URL(req.url,'http://x');
  if(!u.pathname.startsWith('/api/')){serveStatic(req,res);return;}
  let body='';
  req.on('data',d=>body+=d);
  req.on('end',()=>{let d={};try{if(body)d=JSON.parse(body);}catch{}api(u.pathname,req.method,d,u.searchParams,res);});
});
function api(path,method,d,p,res){
  if(path==='/api/create'&&method==='POST'){
    const nc=d.namedCode?d.namedCode.replace(/[^a-z0-9-]/g,'-').slice(0,40):null;
    if(nc&&rooms.has(nc))return err(res,`Room "${nc}" already exists.`,409);
    const code=nc||makeCode(),token=uid(),name=(d.name||'Stranger').slice(0,24);
    rooms.set(code,{lastActivity:Date.now(),deleteTimer:parseInt(d.deleteTimer)||0,password:d.password||null,seq:0,members:new Map([[token,{name,pubKey:d.pubKey||null,lastSeen:Date.now()}]]),msgs:[]});
    console.log(`Room created: ${code}`);
    return ok(res,{code,token,name,deleteTimer:parseInt(d.deleteTimer)||0});
  }
  if(path==='/api/join'&&method==='POST'){
    const code=(d.code||'').toLowerCase().trim(),room=rooms.get(code);
    if(!room)return err(res,'Room not found.',404);
    if(room.password&&room.password!==(d.password||null))return err(res,'Incorrect password.',403);
    if(d.token&&room.members.has(d.token)){
      const m=room.members.get(d.token);m.lastSeen=Date.now();if(d.pubKey)m.pubKey=d.pubKey;room.lastActivity=Date.now();
      let pp=null;for(const[t,mb]of room.members)if(t!==d.token)pp=mb.pubKey;
      return ok(res,{code,token:d.token,name:m.name,isReconnect:true,peerPubKey:pp,deleteTimer:room.deleteTimer});
    }
    if(room.members.size>=2)return err(res,'Room is full.',403);
    const token=uid(),name=(d.name||'Stranger').slice(0,24);
    room.members.set(token,{name,pubKey:d.pubKey||null,lastSeen:Date.now()});
    room.lastActivity=Date.now();
    room.msgs.push({seq:++room.seq,id:uid(),type:'system',content:`${name} joined`,ts:Date.now()});
    let pp=null;for(const[t,mb]of room.members)if(t!==token)pp=mb.pubKey;
    console.log(`${name} joined ${code}`);
    return ok(res,{code,token,name,peerPubKey:pp,deleteTimer:room.deleteTimer});
  }
  if(path==='/api/send'&&method==='POST'){
    const room=rooms.get(d.code);
    if(!room)return err(res,'Room not found.',404);
    if(!room.members.has(d.token))return err(res,'Not in room.',403);
    const m=room.members.get(d.token);m.lastSeen=Date.now();room.lastActivity=Date.now();
    const now=new Date(),time=now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0');
    const msgId=uid(),seq=++room.seq;
    room.msgs.push({seq,id:msgId,type:'message',from:d.token,name:m.name,content:d.content,time,ts:Date.now(),deliveredAt:null,readAt:null});
    if(room.msgs.length>300)room.msgs.splice(0,room.msgs.length-300);
    return ok(res,{ok:true,msgId,seq});
  }
  if(path==='/api/poll'&&method==='GET'){
    const code=p.get('code'),token=p.get('token'),clientLastSeq=parseInt(p.get('lastSeq')||'0'),lastReceiptSeq=parseInt(p.get('lastReceiptSeq')||'0');
    const room=rooms.get(code);
    if(!room)return ok(res,{roomGone:true});
    if(!room.members.has(token))return err(res,'Not in room.',403);
    const m=room.members.get(token);m.lastSeen=Date.now();room.lastActivity=Date.now();
    let peerName=null,peerOnline=false,peerPubKey=null;const now=Date.now();
    for(const[t,mb]of room.members)if(t!==token){peerName=mb.name;peerOnline=(now-mb.lastSeen)<8000;peerPubKey=mb.pubKey;}
    const newMsgs=room.msgs.filter(msg=>msg.seq>clientLastSeq&&msg.from!==token);
    for(const msg of newMsgs)if(msg.type==='message'&&!msg.deliveredAt)msg.deliveredAt=Date.now();
    const readReceipts=room.msgs.filter(msg=>msg.from===token&&msg.type==='message'&&msg.seq>lastReceiptSeq&&msg.deliveredAt).map(msg=>({msgId:msg.id,seq:msg.seq,deliveredAt:msg.deliveredAt,readAt:msg.readAt||null}));
    return ok(res,{messages:newMsgs,peerName,peerOnline,peerPubKey,readReceipts,deleteTimer:room.deleteTimer});
  }
  if(path==='/api/read'&&method==='POST'){
    const room=rooms.get(d.code);
    if(room&&room.members.has(d.token)&&Array.isArray(d.msgIds)){for(const msg of room.msgs)if(d.msgIds.includes(msg.id)&&!msg.readAt)msg.readAt=Date.now();room.lastActivity=Date.now();}
    return ok(res,{ok:true});
  }
  if(path==='/api/typing'&&method==='POST'){
    const room=rooms.get(d.code);
    if(room&&room.members.has(d.token)){const m=room.members.get(d.token);m.lastSeen=Date.now();m.typing=Date.now();room.lastActivity=Date.now();}
    return ok(res,{ok:true});
  }
  if(path==='/api/check_typing'&&method==='GET'){
    const room=rooms.get(p.get('code'));if(!room)return ok(res,{typing:false});
    const now=Date.now();let typing=false;
    for(const[t,m]of room.members)if(t!==p.get('token')&&m.typing&&now-m.typing<3000)typing=true;
    return ok(res,{typing});
  }
  if(path==='/api/leave'&&method==='POST'){
    const room=rooms.get(d.code);
    if(room){room.members.delete(d.token);room.msgs.push({seq:++room.seq,id:uid(),type:'system',content:`${d.name} left`,ts:Date.now()});if(room.members.size===0)rooms.delete(d.code);else room.lastActivity=Date.now();}
    return ok(res,{ok:true});
  }
  if(path==='/api/close'&&method==='POST'){rooms.delete(d.code);return ok(res,{ok:true});}
  err(res,'Not found.',404);
}
srv.listen(PORT,()=>console.log(`Vaulted on port ${PORT}`));
