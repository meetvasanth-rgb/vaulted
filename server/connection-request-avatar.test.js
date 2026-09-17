const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const vm=require('node:vm');
test('friend request photo uses screened image and safe initial fallback',()=>{
 const html=fs.readFileSync('client/index.html','utf8');
 const source=html.slice(html.indexOf('function connectionRequestAvatar('),html.indexOf('function refreshConnectionRequestAvatars('));
 const ctx={displayProfileImageUri:value=>value==='approved'?'data:image/png;base64,AAAA':null,escapeHtml:value=>String(value).replaceAll('<','&lt;').replaceAll('"','&quot;')};vm.createContext(ctx);vm.runInContext(source,ctx);
 assert.match(ctx.connectionRequestAvatar({senderDisplayName:'Alex',senderProfileImage:'approved'}),/<img/);
 assert.doesNotMatch(ctx.connectionRequestAvatar({senderDisplayName:'Alex',senderProfileImage:'blocked'}),/<img/);
 assert.match(ctx.connectionRequestAvatar({senderDisplayName:'Alex'}),/>A</);
 assert.doesNotMatch(ctx.connectionRequestAvatar({senderDisplayName:'<script>'}),/<script>/);
 assert.match(html,/connectionRequestAvatarCard\(r\)/);assert.match(html,/connectionRequestAvatarCard\(request\)/);
});
