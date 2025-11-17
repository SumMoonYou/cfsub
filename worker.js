export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};

// -------------------- Worker 主逻辑 --------------------
async function handleRequest(request, env) {
  try {
    const url = new URL(request.url);
    const path = url.pathname;
    const kv = env.NODES_KV;

    // ---------------- 登录 ----------------
    if (path === "/login") {
      const pw = url.searchParams.get("password");
      if (pw === env.ADMIN_PASSWORD) {
        await sendTGNotificationAdmin(env, { displayName: "管理员" }, "登录");
        return new Response("登录成功", { status: 200 });
      } else return new Response("密码错误", { status: 403 });
    }

    // ---------------- 保存 ----------------
    if (path === "/save") {
      const displayName = url.searchParams.get("key") || "未命名";
      let days = parseInt(url.searchParams.get("days"), 10);
      if (isNaN(days) || days < 0) days = 7;
      const content = await request.text();
      const note = url.searchParams.get("note") || "";
      if (!content) return new Response("未提供订阅内容", { status: 400 });

      const realKey = generateRandomKey(8);
      const expire = days > 0 ? Date.now() + days * 24 * 60 * 60 * 1000 : null;
      const item = { realKey, displayName, content, expire, note };
      await kv.put(realKey, JSON.stringify(item));
      await sendTGNotificationAdmin(env, item, "新增");

      return new Response(`订阅 "${displayName}" 保存成功，访问 URL: /get/${realKey}`, { headers: { "Content-Type": "text/plain" } });
    }

    // ---------------- 获取 Base64 ----------------
    if (path.startsWith("/get/")) {
      const realKey = path.replace("/get/", "");
      const value = await kv.get(realKey);
      if (!value) return new Response("订阅不存在", { status: 404 });
      let item;
      try { item = JSON.parse(value); } catch (e) { return new Response("订阅数据异常", { status: 500 }); }
      if (!item || !item.content) return new Response("订阅数据异常", { status: 500 });
      if (item.expire && Date.now() > item.expire) return new Response("订阅已过期", { status: 403 });

      const { ip, ua } = getClientInfo(request);
      await sendTGNotificationAccess(env, item, ip, ua);

      const base64 = btoa(item.content);
      return new Response(base64, { headers: { "Content-Type": "text/plain;charset=UTF-8" } });
    }

    // ---------------- 管理操作 ----------------
    if (["/update", "/delete", "/list"].includes(path)) {
      const pw = url.searchParams.get("password");
      if (pw !== env.ADMIN_PASSWORD) return new Response("密码错误", { status: 403 });

      if (path === "/update") {
        const realKey = url.searchParams.get("key");
        const displayName = url.searchParams.get("displayName") || "未命名";
        let days = parseInt(url.searchParams.get("days"), 10);
        const content = await request.text();
        const note = url.searchParams.get("note") || "";
        if (!realKey || !content) return new Response("缺少参数", { status: 400 });

        const oldValue = await kv.get(realKey);
        if (!oldValue) return new Response("订阅不存在", { status: 404 });
        let oldItem; try { oldItem = JSON.parse(oldValue); } catch (e) { return new Response("订阅数据异常", { status: 500 }); }

        const expire = days > 0 ? Date.now() + days * 24 * 60 * 60 * 1000 : oldItem.expire;
        const item = { realKey, displayName, content, expire, note };
        await kv.put(realKey, JSON.stringify(item));
        await sendTGNotificationAdmin(env, item, "更新");
        return new Response("订阅更新成功", { headers: { "Content-Type": "text/plain" } });
      }

      if (path === "/delete") {
        const key = url.searchParams.get("key");
        if (!key) return new Response("缺少 key", { status: 400 });
        const oldValue = await kv.get(key);
        let oldItem = null;
        if (oldValue) { try { oldItem = JSON.parse(oldValue); } catch (e) { oldItem = null; } }
        await kv.delete(key);
        await sendTGNotificationAdmin(env, { displayName: oldItem?.displayName, realKey: key, note: oldItem?.note }, "删除");
        return new Response("删除成功", { headers: { "Content-Type": "text/plain" } });
      }

      if (path === "/list") {
        const page = parseInt(url.searchParams.get("page"), 10) || 1;
        const search = url.searchParams.get("search") || "";
        const sortField = url.searchParams.get("sort") || "displayName";
        const sortOrder = url.searchParams.get("order") || "asc";

        const listKV = await kv.list();
        let allItems = [];
        for (const k of listKV.keys) {
          const v = await kv.get(k.name);
          if (!v) continue;
          let item; try { item = JSON.parse(v); } catch (e) { continue; }
          if (!item || !item.content) continue;
          const remaining = item.expire ? Math.max(0, Math.ceil((item.expire - Date.now()) / (1000 * 60 * 60 * 24))) : "∞";
          allItems.push({ displayName: item.displayName, realKey: item.realKey, remainingDays: remaining, content: item.content, note: item.note || "" });
        }
        if (search.trim() !== "") { allItems = allItems.filter(i => i.displayName.toLowerCase().includes(search.toLowerCase())); }
        allItems.sort((a, b) => {
          let valA = a[sortField], valB = b[sortField];
          if (sortField === "remainingDays") { valA = valA === "∞" ? Infinity : valA; valB = valB === "∞" ? Infinity : valB; }
          return sortOrder === "asc" ? (valA > valB ? 1 : (valA < valB ? -1 : 0)) : (valA < valB ? 1 : (valA > valB ? -1 : 0));
        });
        const totalPages = Math.ceil(allItems.length / 10);
        const start = (page - 1) * 10;
        const pageItems = allItems.slice(start, start + 10);
        return new Response(JSON.stringify({ page, totalPages, items: pageItems }), { headers: { "Content-Type": "application/json" } });
      }
    }

    // ---------------- 前端管理页面 ----------------
    return new Response(generateHTML(env), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
  } catch (err) {
    return new Response("Worker 内部错误: " + err.message, { status: 500 });
  }
}

// -------------------- 工具函数 --------------------
function generateRandomKey(len = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function getBeijingTime() {
  const d = new Date();
  d.setHours(d.getHours() + 8);
  return d.toISOString().replace("T", " ").split(".")[0];
}

function getClientInfo(req) {
  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "未知 IP";
  const ua = req.headers.get("user-agent") || "未知设备";
  return { ip, ua };
}

// -------------------- TG 通知 --------------------
async function sendTGNotificationUnified(env, item, action, req) {
  try {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
    const name = item?.displayName || item?.realKey || "未知订阅";
    const note = item?.note ? `\n*备注:* ${item.note}` : "";
    const time = getBeijingTime();
    let ip = "未知 IP";
    let ua = "未知设备";
    if (req) {
      const info = getClientInfo(req);
      ip = info.ip;
      ua = info.ua;
    }
    const message = `📌 *订阅${action}通知*\n\n*订阅名称:* ${name}${note}\n*时间（北京）:* ${time}\n*访问 IP:* ${ip}\n*设备信息:* ${ua}`;
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message, parse_mode: "Markdown" })
    });
  } catch (e) { console.error("TG通知异常:", e); }
}

async function sendTGNotificationAdmin(env, item, action) {
  await sendTGNotificationUnified(env, item, action, null);
}

async function sendTGNotificationAccess(env, item, ip, ua) {
  const fakeReq = { headers: new Map([["cf-connecting-ip", ip], ["user-agent", ua]]) };
  await sendTGNotificationUnified(env, item, "访问", fakeReq);
}

// -------------------- 前端 HTML --------------------
function generateHTML(env){
return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>KV订阅管理</title>
<style>
body{font-family:Arial;background:#f0f2f5;margin:20px;}
.container{max-width:900px;margin:auto;background:#fff;padding:20px;border-radius:12px;box-shadow:0 10px 25px rgba(0,0,0,0.1);}
h2{margin-bottom:10px;color:#333;}
input,textarea,select{width:100%;margin:5px 0;padding:10px;border-radius:8px;border:1px solid #ccc;font-size:14px;}
button{padding:8px 12px;margin-top:5px;border:none;border-radius:8px;background:#4facfe;color:#fff;cursor:pointer;}
button:hover{background:#00f2fe;}
table{width:100%;border-collapse:collapse;margin-top:10px;}
th,td{border:1px solid #ddd;padding:8px;text-align:center;}
th{background:#4facfe;color:#fff;}
.copy-btn{padding:4px 8px;border-radius:6px;background:#00c1ff;color:#fff;cursor:pointer;border:none;}
.copy-btn:hover{background:#0086b3;}
.edit-btn{background:#ffa500;color:#fff;}
.edit-btn:hover{background:#cc8400;}
.delete-btn{background:#ff5c5c;color:#fff;}
.delete-btn:hover{background:#cc0000;}
.pagination{margin-top:10px;text-align:center;}
.pagination button{margin:0 3px;}
.search-sort{margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;}
.search-sort input, .search-sort select{width:auto;flex:1;}
</style></head><body>
<div class="container">
<h2>KV订阅管理</h2>
<div id="loginDiv">
<label>管理员密码:</label>
<input type="password" id="adminPassword">
<button id="loginBtn">登录</button>
</div>
<div id="mainDiv" style="display:none;">
<div class="search-sort">
<input type="text" id="search" placeholder="搜索名称">
<select id="sort"><option value="displayName">名称排序</option><option value="remainingDays">剩余天数排序</option></select>
<select id="order"><option value="asc">升序</option><option value="desc">降序</option></select>
<button id="searchBtn">搜索/排序</button>
</div>
<label>订阅显示名称:</label><input type="text" id="key" placeholder="如 node1">
<label>订阅内容:</label><textarea id="text" rows="5" placeholder="输入订阅节点内容"></textarea>
<label>备注:</label><input type="text" id="note" placeholder="节点备注">
<label>有效天数 (0 表示永久):</label><input type="number" id="days" placeholder="例如 7">
<button id="saveBtn">保存订阅</button>
<h3>已保存订阅列表：</h3>
<table>
<thead>
<tr><th>名称</th><th>备注</th><th>剩余天数</th><th>Base64</th><th>URL</th><th>编辑</th><th>删除</th></tr>
</thead>
<tbody id="keylist"></tbody>
</table>
<div class="pagination" id="pagination"></div>
</div>
<script>
const ADMIN_PASSWORD = "${env.ADMIN_PASSWORD}";
let currentPage=1,currentSearch="",currentSort="displayName",currentOrder="asc",currentEditingKey=null;

document.addEventListener("DOMContentLoaded",()=>{
  document.getElementById("loginBtn").addEventListener("click",async()=>{
    const pw=document.getElementById("adminPassword").value.trim();
    if(pw===ADMIN_PASSWORD){
      document.getElementById("loginDiv").style.display="none";
      document.getElementById("mainDiv").style.display="block";
      await fetch("/login?password="+encodeURIComponent(ADMIN_PASSWORD)).catch(()=>{});
      loadKeyList(1);
    }else alert("密码错误");
  });
  document.getElementById("saveBtn").addEventListener("click",saveOrUpdateData);
  document.getElementById("searchBtn").addEventListener("click",()=>{
    currentSearch=document.getElementById("search").value.trim();
    currentSort=document.getElementById("sort").value;
    currentOrder=document.getElementById("order").value;
    loadKeyList(1);
  });
});

async function loadKeyList(page=1){
  currentPage=page;
  try{
    const resp=await fetch("/list?page="+page+"&search="+encodeURIComponent(currentSearch)+"&sort="+currentSort+"&order="+currentOrder+"&password="+encodeURIComponent(ADMIN_PASSWORD));
    if(!resp.ok){ alert("加载失败:"+await resp.text()); return; }
    const data=await resp.json();
    const tbody=document.getElementById("keylist"); tbody.innerHTML="";
    data.items.forEach(item=>{
      const tr=document.createElement("tr");
      tr.innerHTML=\`<td>\${item.displayName}</td><td>\${item.note}</td><td>\${item.remainingDays}</td>
      <td><button class="copy-btn">复制</button></td>
      <td><button class="copy-btn">复制</button></td>
      <td><button class="edit-btn">编辑</button></td>
      <td><button class="delete-btn">删除</button></td>\`;
      tbody.appendChild(tr);
      tr.children[3].addEventListener("click",()=>copyBase64(item.realKey));
      tr.children[4].addEventListener("click",()=>copyURL(item.realKey));
      tr.children[5].addEventListener("click",()=>editItem(item.realKey,item.displayName,item.content,item.note));
      tr.children[6].addEventListener("click",()=>deleteKey(item.realKey));
    });
    const pageDiv=document.getElementById("pagination"); pageDiv.innerHTML="";
    for(let i=1;i<=data.totalPages;i++){
      const btn=document.createElement("button"); btn.textContent=i;
      if(i===data.page) btn.disabled=true;
      btn.addEventListener("click",()=>loadKeyList(i));
      pageDiv.appendChild(btn);
    }
  }catch(err){alert("加载失败:"+err.message);}
}

async function saveOrUpdateData(){
  const displayName=document.getElementById("key").value.trim()||"未命名";
  const text=document.getElementById("text").value.trim();
  const note=document.getElementById("note").value.trim();
  let days=parseInt(document.getElementById("days").value,10); if(isNaN(days)||days<0) days=0;
  if(!text){alert("请输入订阅内容"); return;}
  try{
    if(currentEditingKey){
      const resp=await fetch("/update?key="+encodeURIComponent(currentEditingKey)+"&displayName="+encodeURIComponent(displayName)+"&days="+encodeURIComponent(days)+"&note="+encodeURIComponent(note)+"&password="+encodeURIComponent(ADMIN_PASSWORD),{method:"POST",body:text});
      alert(await resp.text()); currentEditingKey=null; document.getElementById("saveBtn").textContent="保存订阅";
    }else{
      const resp=await fetch("/save?key="+encodeURIComponent(displayName)+"&days="+encodeURIComponent(days)+"&note="+encodeURIComponent(note),{method:"POST",body:text});
      alert(await resp.text());
    }
    document.getElementById("key").value=""; document.getElementById("text").value=""; document.getElementById("note").value=""; document.getElementById("days").value="";
    loadKeyList(currentPage);
  }catch(err){alert("保存失败:"+err.message);}
}

function editItem(realKey,displayName,content,note){
  document.getElementById("key").value=displayName;
  document.getElementById("text").value=content;
  document.getElementById("note").value=note||"";
  currentEditingKey=realKey;
  document.getElementById("saveBtn").textContent="更新订阅";
}

async function deleteKey(key){
  if(!confirm("确定删除 '"+key+"'?")) return;
  try{
    const resp=await fetch("/delete?key="+encodeURIComponent(key)+"&password="+encodeURIComponent(ADMIN_PASSWORD),{method:"POST"});
    alert(await resp.text()); loadKeyList(currentPage);
  }catch(err){alert("删除失败:"+err.message);}
}

async function copyText(text){if(!text)return; try{await navigator.clipboard.writeText(text);}catch(e){prompt("复制失败，请手动复制:",text);} alert("已复制!");}
async function copyBase64(key){try{let resp=await fetch("/get/"+encodeURIComponent(key)); let base64=await resp.text(); await copyText(base64);}catch(err){alert("复制 Base64 失败:"+err.message);}}
async function copyURL(key){try{let url=window.location.origin+"/get/"+encodeURIComponent(key); await copyText(url);}catch(err){alert("复制 URL 失败:"+err.message);}}
</script>
</div></body></html>`;
}
