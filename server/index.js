const http = require('http');
const path = require('path');
const fs = require('fs');
const PORT = process.env.PORT || 3000;
const ROOM_TTL = 5 * 60 * 1000;
const rooms = new Map();
function uid(){return Math.random().toString(36).slice(2)+Date.now().toString(36)}
function makeCode(){
  const w=['amber','arctic','azure','cedar','cloud','coral','dawn','delta','dusk','ember','fern','flame','frost','ghost','gold','grove','haven','iron','jade','karma','lake','lemon','lime','lunar','maple','mist','moon','moss','nova','oak','opal','pearl','pine','rain','raven','reed','ridge','river','rose','ruby','sage','salt','sand','shadow','shore','silver','slate','smoke','snow','spark','star','steel','storm','tide','timber','topaz','vault','veil','wave','wild','wind','wolf'];
  const p=()=>w[Math.floor(Math.random()*w.length)];
  return p()+'-'+p()+'-'+Math.floor(Math.random()*90+10);
}
setInterval(()=>{const now=Date.now();for(const[k,r]of rooms)if(now-r.lastActivity>ROOM_TTL){rooms.delete(k);console.log('Room '+k+' expired')}},30000);
function ok(res,data){res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Cache-Control':'no-cache'});res.end(JSON.stringify(data))}
function err(res,msg,s){res.writeHead(s||400,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify({error:msg}))}
function serveStatic(req,res){
  var url=req.url==='/'?'/index.html':req.url.split('?')[0];
  if(!url.startsWith('/')||url.includes('..')){res.writeHead(403);res.end();return}
  fs.readFile(path.join(__dirname,'../client',url),function(e,data){
    if(e){fs.readFile(path.join(__dirname,'../client/index.html'),function(e2,d2){if(e2){res.writeHead(404);res.end();return}res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(d2)});return}
    var t={'.html':'text/html','.js':'text/javascript','.css':'text/css','.ico':'image/x-icon'};
    res.writeHead(200,{'Content-Type':t[path.extname(url)]||'text/plain'});res.end(data);
  });
}
var srv=http.createServer(function(req,res){
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST','Access-Control-Allow-Headers':'Content-Type'});res.end();return}
  var u=new URL(req.url,'http://x');
  if(!u.pathname.startsWith('/api/')){serveStatic(req,res);return}
  var body='';
  req.on('data',function(d){body+=d});
  req.on('end',function(){var d={};try{if(body)d=JSON.parse(body)}catch(e){}api(u.pathname,req.method,d,u.searchParams,res)});
});
function api(p,method,d,params,res){
  if(p==='/api/create'&&method==='POST'){
    var nc=d.namedCode?d.namedCode.replace(/[^a-z0-9-]/g,'-').slice(0,40):null;
    if(nc&&rooms.has(nc))return err(res,'Room "'+nc+'" already exists.',409);
    var roomCode=nc||makeCode(),token=uid(),name=(d.name||'Stranger').slice(0,24);
    rooms.set(roomCode,{lastActivity:Date.now(),deleteTimer:parseInt(d.deleteTimer)||0,password:d.password||null,seq:0,members:new Map([[token,{name:name,pubKey:d.pubKey||null,lastSeen:Date.now()}]]),msgs:[]});
    console.log('Room created: '+roomCode);
    return ok(res,{code:roomCode,token:token,name:name,deleteTimer:parseInt(d.deleteTimer)||0});
  }
  if(p==='/api/join'&&method==='POST'){
    var roomCode=(d.code||'').toLowerCase().trim();
    var room=rooms.get(roomCode);
    if(!room)return err(res,'Room not found.',404);
    if(room.password&&room.password!==(d.password||null))return err(res,'Incorrect password.',403);
    if(d.token&&room.members.has(d.token)){
      var m=room.members.get(d.token);m.lastSeen=Date.now();if(d.pubKey)m.pubKey=d.pubKey;room.lastActivity=Date.now();
      var pp=null;for(var[t,mb]of room.members)if(t!==d.token)pp=mb.pubKey;
      return ok(res,{code:roomCode,token:d.token,name:m.name,isReconnect:true,peerPubKey:pp,deleteTimer:room.deleteTimer});
    }
    var staleThreshold=Date.now()-30000;
    for(var[t,m]of room.members){if(m.lastSeen<staleThreshold)room.members.delete(t)}
    if(room.members.size>=2)return err(res,'Room is full.',403);
    var token=uid(),name=(d.name||'Stranger').slice(0,24);
    room.members.set(token,{name:name,pubKey:d.pubKey||null,lastSeen:Date.now()});
    room.lastActivity=Date.now();
    room.msgs.push({seq:++room.seq,id:uid(),type:'system',content:name+' joined',ts:Date.now()});
    var pp=null;for(var[t,mb]of room.members)if(t!==token)pp=mb.pubKey;
    console.log(name+' joined '+roomCode);
    return ok(res,{code:roomCode,token:token,name:name,peerPubKey:pp,deleteTimer:room.deleteTimer});
  }
  if(p==='/api/send'&&method==='POST'){
    var room=rooms.get(d.code);
    if(!room)return err(res,'Room not found.',404);
    if(!room.members.has(d.token))return err(res,'Not in room.',403);
    var m=room.members.get(d.token);m.lastSeen=Date.now();room.lastActivity=Date.now();
    var now=new Date(),time=now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0');
    var msgId=uid(),seq=++room.seq;
    room.msgs.push({seq:seq,id:msgId,type:'message',from:d.token,name:m.name,content:d.content,time:time,ts:Date.now(),deliveredAt:null,readAt:null});
    if(room.msgs.length>300)room.msgs.splice(0,room.msgs.length-300);
    return ok(res,{ok:true,msgId:msgId,seq:seq});
  }
  if(p==='/api/poll'&&method==='GET'){
    var roomCode=params.get('code'),token=params.get('token'),clientLastSeq=parseInt(params.get('lastSeq')||'0'),lastReceiptSeq=parseInt(params.get('lastReceiptSeq')||'0');
    var room=rooms.get(roomCode);
    if(!room)return ok(res,{roomGone:true});
    if(!room.members.has(token))return err(res,'Not in room.',403);
    var m=room.members.get(token);m.lastSeen=Date.now();room.lastActivity=Date.now();
    var peerName=null,peerOnline=false,peerPubKey=null,now=Date.now();
    for(var[t,mb]of room.members)if(t!==token){peerName=mb.name;peerOnline=(now-mb.lastSeen)<8000;peerPubKey=mb.pubKey}
    var newMsgs=room.msgs.filter(function(msg){return msg.seq>clientLastSeq&&msg.from!==token});
    for(var i=0;i<newMsgs.length;i++){if(newMsgs[i].type==='message'&&!newMsgs[i].deliveredAt)newMsgs[i].deliveredAt=Date.now()}
    var readReceipts=[];
    for(var i=0;i<room.msgs.length;i++){
      var msg=room.msgs[i];
      if(msg.from!==token||msg.type!=='message'||!msg.deliveredAt)continue;
      if(msg.seq>lastReceiptSeq||(msg.readAt&&!msg.readReported)){
        readReceipts.push({msgId:msg.id,seq:msg.seq,deliveredAt:msg.deliveredAt,readAt:msg.readAt||null});
        if(msg.readAt)msg.readReported=true;
      }
    }
    return ok(res,{messages:newMsgs,peerName:peerName,peerOnline:peerOnline,peerPubKey:peerPubKey,readReceipts:readReceipts,deleteTimer:room.deleteTimer});
  }
  if(p==='/api/read'&&method==='POST'){
    var room=rooms.get(d.code);
    if(room&&room.members.has(d.token)&&Array.isArray(d.msgIds)){
      for(var i=0;i<room.msgs.length;i++)if(d.msgIds.indexOf(room.msgs[i].id)!==-1&&!room.msgs[i].readAt)room.msgs[i].readAt=Date.now();
      room.lastActivity=Date.now();
    }
    return ok(res,{ok:true});
  }
  if(p==='/api/typing'&&method==='POST'){
    var room=rooms.get(d.code);
    if(room&&room.members.has(d.token)){var m=room.members.get(d.token);m.lastSeen=Date.now();m.typing=Date.now();room.lastActivity=Date.now()}
    return ok(res,{ok:true});
  }
  if(p==='/api/check_typing'&&method==='GET'){
    var room=rooms.get(params.get('code'));if(!room)return ok(res,{typing:false});
    var now=Date.now(),typing=false;
    for(var[t,m]of room.members)if(t!==params.get('token')&&m.typing&&now-m.typing<3000)typing=true;
    return ok(res,{typing:typing});
  }
  if(p==='/api/leave'&&method==='POST'){
    var room=rooms.get(d.code);
    if(room){room.members.delete(d.token);room.msgs.push({seq:++room.seq,id:uid(),type:'system',content:(d.name||'Someone')+' left',ts:Date.now()});if(room.members.size===0)rooms.delete(d.code);else room.lastActivity=Date.now()}
    return ok(res,{ok:true});
  }
  if(p==='/api/close'&&method==='POST'){rooms.delete(d.code);return ok(res,{ok:true})}
  err(res,'Not found.',404);
}
srv.listen(PORT,function(){console.log('Vaulted on port '+PORT)});
