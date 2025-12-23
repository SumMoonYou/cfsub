export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};

// ================== 主路由 ==================
async function handleRequest(request, env) {
  try {
    const url = new URL(request.url);
    const path = url.pathname;
    const kv = env.NODES_KV;

    // ========== 登录 ==========
    if (path === "/login") {
      const pw = url.searchParams.get("password");
      if (pw === env.ADMIN_PASSWORD) {
        await sendTGNotificationAdmin(env, { displayName: "管理员" }, "登录", null);
        return new Response("登录成功", { status: 200 });
      }
      return new Response("密码错误", { status: 403 });
    }

    // ========== 保存 ==========
    if (path === "/save") {
      const displayName = url.searchParams.get("key") || "未命名";
      let days = parseInt(url.searchParams.get("days"), 10);
      if (isNaN(days) || days < 0) days = 7;

      const content = await request.text();
      if (!content) return new Response("未提供订阅内容", { status: 400 });

      const note = url.searchParams.get("note") || "";
      const realKey = generateRandomKey(8);
      const expire = days > 0 ? Date.now() + days * 86400000 : null;

      const item = { realKey, displayName, content, expire, note };

      await kv.put(realKey, JSON.stringify(item));
      await sendTGNotificationAdmin(env, item, "新增", null);

      return new Response(
        `订阅 "${displayName}" 保存成功，访问 URL: /get/${realKey}`,
        { headers: { "Content-Type": "text/plain; charset=UTF-8" } }
      );
    }

    // ========== 获取订阅 Base64 ==========
    if (path.startsWith("/get/")) {
      const realKey = path.replace("/get/", "");
      const value = await kv.get(realKey);
      if (!value) return new Response("订阅不存在", { status: 404 });

      let item;
      try { item = JSON.parse(value); } catch { return new Response("订阅数据异常", { status: 500 }); }

      if (item.expire && Date.now() > item.expire)
        return new Response("订阅已过期", { status: 403 });

      const { ip, ua } = getClientInfo(request);

      const country = request.cf?.country || "未知国家";
      const city = request.cf?.city || "";
      const cfLocation = city ? `${country}, ${city}` : country;

      await sendTGNotificationAccess(env, item, ip, ua, cfLocation);

      const base64 = btoa(item.content);
      return new Response(base64, { headers: { "Content-Type": "text/plain; charset=UTF-8" } });
    }

    // ========== 管理操作 ==========
    if (["/update", "/delete", "/list"].includes(path)) {
      const pw = url.searchParams.get("password");
      if (pw !== env.ADMIN_PASSWORD) return new Response("密码错误", { status: 403 });

      // === 更新 ===
      if (path === "/update") {
        const realKey = url.searchParams.get("key");
        if (!realKey) return new Response("缺少 key", { status: 400 });

        const content = await request.text();
        if (!content) return new Response("缺少内容", { status: 400 });

        const displayName = url.searchParams.get("displayName") || "未命名";
        const note = url.searchParams.get("note") || "";

        let days = parseInt(url.searchParams.get("days"), 10);
        if (isNaN(days) || days < 0) days = 0;

        const oldValue = await kv.get(realKey);
        if (!oldValue) return new Response("订阅不存在", { status: 404 });

        let old;
        try { old = JSON.parse(oldValue); } catch { return new Response("数据异常", { status: 500 }); }

        const expire = days > 0 ? Date.now() + days * 86400000 : old.expire;

        const item = { realKey, displayName, content, expire, note };
        await kv.put(realKey, JSON.stringify(item));

        await sendTGNotificationAdmin(env, item, "更新", null);

        return new Response("订阅更新成功", {
          headers: { "Content-Type": "text/plain; charset=UTF-8" }
        });
      }
      // === 删除 ===
      if (path === "/delete") {
        const key = url.searchParams.get("key");
        if (!key) return new Response("缺少 key", { status: 400 });

        const oldValue = await kv.get(key);
        let oldItem = null;
        if (oldValue) {
          try { oldItem = JSON.parse(oldValue); } catch (e) { oldItem = null; }
        }

        await kv.delete(key);
        await sendTGNotificationAdmin(env, { displayName: oldItem?.displayName, realKey: key, note: oldItem?.note }, "删除", null);

        return new Response("删除成功", { headers: { "Content-Type": "text/plain; charset=UTF-8" } });
      }

      // === 列表 ===
      if (path === "/list") {
        const page = parseInt(url.searchParams.get("page"), 10) || 1;
        const search = url.searchParams.get("search") || "";
        const sortField = url.searchParams.get("sort") || "displayName";
        const sortOrder = url.searchParams.get("order") || "asc";

        // 使用 kv.list 获取 key 列表（limit 可调）
        const listKV = await kv.list({ limit: 1000 }).catch(() => ({ keys: [] }));
        let allItems = [];

        for (const k of listKV.keys) {
          try {
            const v = await kv.get(k.name);
            if (!v) continue;
            const item = JSON.parse(v);
            if (!item || !item.content) continue;
            const remaining = item.expire ? formatRemainingDays(item.expire) : "∞";
            allItems.push({
              displayName: item.displayName,
              realKey: item.realKey,
              remainingDays: remaining,
              content: item.content,
              note: item.note || "",
              created: item.created || null
            });
          } catch (e) {
            // 忽略单条异常
            continue;
          }
        }

        // 搜索过滤
        if (search.trim() !== "") {
          const s = search.toLowerCase();
          allItems = allItems.filter(i =>
            (i.displayName || "").toLowerCase().includes(s) ||
            (i.realKey || "").toLowerCase().includes(s)
          );
        }

        // 排序
        allItems.sort((a, b) => {
          let va = a[sortField], vb = b[sortField];

          // 特殊处理 remainingDays 字段：'∞' -> Infinity, '已过期' -> -1
          if (sortField === "remainingDays") {
            const conv = v => (v === "∞" ? Infinity : (v === "已过期" ? -1 : Number(v)));
            va = conv(va); vb = conv(vb);
          }

          // created 字段：转为时间戳比较
          if (sortField === "created") {
            va = a.created ? Number(a.created) : 0;
            vb = b.created ? Number(b.created) : 0;
          }

          if (va > vb) return sortOrder === "asc" ? 1 : -1;
          if (va < vb) return sortOrder === "asc" ? -1 : 1;
          return 0;
        });

        const totalPages = Math.max(1, Math.ceil(allItems.length / 10));
        const start = (page - 1) * 10;
        const pageItems = allItems.slice(start, start + 10);

        return new Response(JSON.stringify({ page, totalPages, items: pageItems }), { headers: { "Content-Type": "application/json; charset=UTF-8" } });
      }
    }

    // ========== 默认：返回管理页面 HTML ==========
    return new Response(generateHTML(env), { headers: { "Content-Type": "text/html; charset=UTF-8" } });

  } catch (err) {
    return new Response("Worker 内部错误: " + (err && err.message ? err.message : String(err)), { status: 500 });
  }
} // end handleRequest

// -------------------- 辅助工具函数 --------------------

// 生成随机 key（不含冲突前缀的简单版本）
function generateRandomKey(len = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

// 获取北京时间（可靠）
function getBeijingTime() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const bj = new Date(utc + 8 * 3600000);
  return bj.toISOString().replace("T", " ").split(".")[0];
}

// 计算剩余天数或已过期
function formatRemainingDays(expireMillis) {
  if (!expireMillis) return "∞";
  const now = Date.now();
  if (now > expireMillis) return "已过期";
  const diff = expireMillis - now;
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
  return days;
}

/**
 * 从 Request 中提取 IP 和 UA 的健壮方法
 * 返回 { ip: { v4, v6, main }, ua }
 */
function getClientInfo(req) {
  // 支持 Headers 对象或普通 map（兼容模拟请求）
  const headers = req && req.headers ? req.headers : {};
  const getHeader = (h) => {
    try {
      if (!headers) return null;
      if (typeof headers.get === "function") return headers.get(h);
      if (headers[h]) return headers[h];
      if (typeof headers.get === "function") return headers.get(h);
      return null;
    } catch (e) {
      return null;
    }
  };

  let cfIp = getHeader("cf-connecting-ip") || getHeader("x-forwarded-for") || getHeader("x-real-ip") || null;
  const ua = getHeader("user-agent") || null;

  if (cfIp && cfIp.includes(",")) {
    const parts = cfIp.split(",").map(s => s.trim()).filter(Boolean);
    if (parts.length) cfIp = parts[0];
  }

  let v4 = null, v6 = null;
  const isV4 = ip => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
  if (cfIp) {
    if (isV4(cfIp)) v4 = cfIp;
    else if (cfIp.includes(":")) v6 = cfIp;
  }

  // try x-forwarded-for chain for IPv4
  const xff = getHeader("x-forwarded-for");
  if (xff) {
    const ips = xff.split(",").map(s => s.trim());
    for (const ip of ips) {
      if (isV4(ip)) { v4 = v4 || ip; break; }
    }
  }

  const main = v4 || v6 || cfIp || "未知 IP";
  return { ip: { v4, v6, main }, ua: ua || "未知设备" };
}

// -------------------- Part 2 end --------------------
// =====================================================
//                 Telegram 通知系统
// =====================================================

// 统一发送（安全 Markdown）
async function tgSend(env, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true
    })
  }).catch(() => {});
}

// Escape Telegram MarkdownV2 保证字符安全
function esc(t) {
  if (!t) return "";
  return t.replace(/([_*\[\]()~`>#+=\-|{}.!])/g, "\\$1");
}

// =====================================================
//                     管理通知
//         type = 新增 / 更新 / 删除
// =====================================================
async function sendTGNotificationAdmin(env, item, type, extra) {
  const ts = getBeijingTime();
  const title = type === "新增" ? "🟢 新增订阅" :
                type === "更新" ? "🟡 更新订阅" :
                type === "删除" ? "🔴 删除订阅" : "🧰 管理操作";

  let lines = [];
  const pushIf = (label, value) => {
    if (value !== null && value !== undefined && value !== "") {
      lines.push(`*${label}*: ${esc(String(value))}`);
    }
  };

  pushIf("📛 名称", item.displayName);
  pushIf("🔑 Key", item.realKey);

  if (item.expire) {
    const remain = formatRemainingDays(item.expire);
    pushIf("📅 过期时间", new Date(item.expire + 8 * 3600000).toISOString().replace("T", " ").split(".")[0]);
    pushIf("📅 剩余天数", remain);
  }

  pushIf("📝 备注", item.note);

  const msg =
    `*${esc(title)}*\n` +
    `*⏰ 时间：${esc(ts)}*\n\n` +
    lines.join("\n");

  await tgSend(env, msg);
}

// =====================================================
//                     访问通知
// =====================================================
async function sendTGNotificationAccess(env, item, ip, ua, location) {
  const ts = getBeijingTime();
  let lines = [];

  const pushIf = (label, value) => {
    if (value !== null && value !== undefined && value !== "") {
      lines.push(`*${label}*: ${esc(String(value))}`);
    }
  };

  // 订阅信息
  pushIf("📛 订阅", item.displayName);
  pushIf("🔑 Key", item.realKey);

  // 位置信息
  pushIf("📍 地区", location || "未知");

  // IP（优先显示 IPv4）
  if (ip && (ip.v4 || ip.v6)) {
    if (ip.v4) pushIf("🌐 IPv4", ip.v4);
    if (ip.v6) pushIf("🌐 IPv6", ip.v6);
  }

  // 设备信息
  pushIf("💻 设备", ua);

  const msg =
    `*🧭 订阅被访问*\n` +
    `*时间：${esc(ts)}*\n\n` +
    lines.join("\n");

  await tgSend(env, msg);
}

// -------------------- Part 3 end --------------------
function generateHTML(env) {
  const ADMIN_PASSWORD = env?.ADMIN_PASSWORD || "";
  let html = "";
  html += "<!DOCTYPE html>";
  html += "<html lang='zh-CN'>";
  html += "<head>";
  html += "<meta charset='UTF-8'>";
  html += "<meta name='viewport' content='width=device-width, initial-scale=1, maximum-scale=1'>";
  html += "<title>KV订阅管理</title>";
  html += "<style>";
  html += "body{font-family:Arial,Helvetica,sans-serif;margin:0;padding:0;background:#f0f2f5;}";
  html += ".container{max-width:900px;margin:20px auto;padding:20px;background:#fff;border-radius:12px;box-shadow:0 5px 15px rgba(0,0,0,0.1);}";
  html += "h2{color:#333;margin-bottom:15px;}";
  html += "input,textarea,select,button{font-size:14px;margin:5px 0;padding:10px;border-radius:8px;border:1px solid #ccc;width:100%;box-sizing:border-box;}";
  html += "button{background:#4facfe;color:#fff;border:none;cursor:pointer;}";
  html += "button:hover{background:#00f2fe;}";
  html += "table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px;}";
  html += "th,td{border:1px solid #ddd;padding:8px;text-align:center;}";
  html += "th{background:#4facfe;color:#fff;}";
  html += ".copy-btn{padding:4px 8px;border-radius:6px;background:#00c1ff;color:#fff;cursor:pointer;border:none;}";
  html += ".copy-btn:hover{background:#0086b3;}";
  html += ".edit-btn{background:#ffa500;color:#fff;}";
  html += ".edit-btn:hover{background:#cc8400;}";
  html += ".delete-btn{background:#ff5c5c;color:#fff;}";
  html += ".delete-btn:hover{background:#cc0000;}";
  html += ".pagination{margin-top:10px;text-align:center;}";
  html += ".pagination button{margin:0 3px;}";
  html += ".search-sort{margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;}";
  html += ".search-sort input, .search-sort select{flex:1;min-width:100px;}";
  html += "@media(max-width:600px){.search-sort{flex-direction:column;}}";
  html += "</style>";
  html += "</head>";
  html += "<body>";
  html += "<div class='container'>";
  html += "<h2>KV订阅管理</h2>";
  html += "<div id='loginDiv'>";
  html += "<label>管理员密码:</label><input type='password' id='adminPassword'>";
  html += "<button id='loginBtn'>登录</button></div>";
  html += "<div id='mainDiv' style='display:none;'>";
  html += "<div class='search-sort'>";
  html += "<input type='text' id='search' placeholder='搜索名称'>";
  html += "<select id='sort'><option value='displayName'>名称排序</option><option value='remainingDays'>剩余天数排序</option></select>";
  html += "<select id='order'><option value='asc'>升序</option><option value='desc'>降序</option></select>";
  html += "<button id='searchBtn'>搜索/排序</button></div>";
  html += "<label>订阅显示名称:</label><input type='text' id='key' placeholder='如 node1'>";
  html += "<label>订阅内容:</label><textarea id='text' rows='5' placeholder='输入订阅节点内容'></textarea>";
  html += "<label>备注:</label><input type='text' id='note' placeholder='节点备注'>";
  html += "<label>有效天数 (0 表示永久):</label><input type='number' id='days' placeholder='例如 7'>";
  html += "<button id='saveBtn'>保存订阅</button>";
  html += "<h3>已保存订阅列表：</h3>";
  html += "<table><thead><tr><th>名称</th><th>备注</th><th>剩余天数</th><th>Base64</th><th>URL</th><th>编辑</th><th>删除</th></tr></thead>";
  html += "<tbody id='keylist'></tbody></table>";
  html += "<div class='pagination' id='pagination'></div>";
  html += "</div>";
  html += "<script>";
  html += "const ADMIN_PASSWORD=" + JSON.stringify(ADMIN_PASSWORD) + ";";
  html += "let currentPage=1,currentSearch='',currentSort='displayName',currentOrder='asc',currentEditingKey=null;";
  html += "document.addEventListener('DOMContentLoaded',()=>{";
  html += "document.getElementById('loginBtn').addEventListener('click',async()=>{";
  html += "const pw=document.getElementById('adminPassword').value.trim();";
  html += "if(pw===ADMIN_PASSWORD){document.getElementById('loginDiv').style.display='none';";
  html += "document.getElementById('mainDiv').style.display='block';";
  html += "await fetch('/login?password='+encodeURIComponent(ADMIN_PASSWORD)).catch(()=>{});";
  html += "loadKeyList(1);}else alert('密码错误');});";
  html += "document.getElementById('saveBtn').addEventListener('click',saveOrUpdateData);";
  html += "document.getElementById('searchBtn').addEventListener('click',()=>{";
  html += "currentSearch=document.getElementById('search').value.trim();";
  html += "currentSort=document.getElementById('sort').value;";
  html += "currentOrder=document.getElementById('order').value;";
  html += "loadKeyList(1);});});";
  html += "async function loadKeyList(page=1){currentPage=page;";
  html += "try{const resp=await fetch('/list?page='+page+'&search='+encodeURIComponent(currentSearch)+'&sort='+currentSort+'&order='+currentOrder+'&password='+encodeURIComponent(ADMIN_PASSWORD));";
  html += "if(!resp.ok){alert('加载失败:'+await resp.text());return;}";
  html += "const data=await resp.json();";
  html += "const tbody=document.getElementById('keylist');tbody.innerHTML='';";
  html += "data.items.forEach(item=>{const tr=document.createElement('tr');";
  html += "tr.innerHTML=\"<td>\"+item.displayName+\"</td><td>\"+item.note+\"</td><td>\"+item.remainingDays+\"</td>\"+";
  html += "\"<td><button class='copy-btn'>复制</button></td><td><button class='copy-btn'>复制</button></td>\"+";
  html += "\"<td><button class='edit-btn'>编辑</button></td><td><button class='delete-btn'>删除</button></td>\";";
  html += "tbody.appendChild(tr);";
  html += "tr.children[3].addEventListener('click',()=>copyBase64(item.realKey));";
  html += "tr.children[4].addEventListener('click',()=>copyURL(item.realKey));";
  html += "tr.children[5].addEventListener('click',()=>editItem(item.realKey,item.displayName,item.content,item.note));";
  html += "tr.children[6].addEventListener('click',()=>deleteKey(item.realKey));});";
  html += "const pageDiv=document.getElementById('pagination');pageDiv.innerHTML='';";
  html += "for(let i=1;i<=data.totalPages;i++){const btn=document.createElement('button');btn.textContent=i;";
  html += "if(i===data.page)btn.disabled=true;btn.addEventListener('click',()=>loadKeyList(i));pageDiv.appendChild(btn);}";
  html += "}catch(err){alert('加载失败:'+err.message);}}";
  html += "async function saveOrUpdateData(){const displayName=document.getElementById('key').value.trim()||'未命名';";
  html += "const text=document.getElementById('text').value.trim();const note=document.getElementById('note').value.trim();";
  html += "let days=parseInt(document.getElementById('days').value,10);if(isNaN(days)||days<0)days=0;";
  html += "if(!text){alert('请输入订阅内容');return;}";
  html += "try{if(currentEditingKey){const resp=await fetch('/update?key='+encodeURIComponent(currentEditingKey)+'&displayName='+encodeURIComponent(displayName)+'&days='+encodeURIComponent(days)+'&note='+encodeURIComponent(note)+'&password='+encodeURIComponent(ADMIN_PASSWORD),{method:'POST',body:text});";
  html += "alert(await resp.text());currentEditingKey=null;document.getElementById('saveBtn').textContent='保存订阅';}else{";
  html += "const resp=await fetch('/save?key='+encodeURIComponent(displayName)+'&days='+encodeURIComponent(days)+'&note='+encodeURIComponent(note),{method:'POST',body:text});";
  html += "alert(await resp.text());}";
  html += "document.getElementById('key').value='';document.getElementById('text').value='';document.getElementById('note').value='';document.getElementById('days').value='';";
  html += "loadKeyList(currentPage);}catch(err){alert('保存失败:'+err.message);}}";
  html += "function editItem(realKey,displayName,content,note){document.getElementById('key').value=displayName;";
  html += "document.getElementById('text').value=content;document.getElementById('note').value=note||'';";
  html += "currentEditingKey=realKey;document.getElementById('saveBtn').textContent='更新订阅';}";
  html += "async function deleteKey(key){if(!confirm('确定删除 \"'+key+'\"?'))return;";
  html += "try{const resp=await fetch('/delete?key='+encodeURIComponent(key)+'&password='+encodeURIComponent(ADMIN_PASSWORD),{method:'POST'});";
  html += "alert(await resp.text());loadKeyList(currentPage);}catch(err){alert('删除失败:'+err.message);}}";
  html += "async function copyText(text){if(!text)return;try{await navigator.clipboard.writeText(text);}catch(e){prompt('复制失败，请手动复制:',text);}alert('已复制!');}";
  html += "async function copyBase64(key){try{let resp=await fetch('/get/'+encodeURIComponent(key));let base64=await resp.text();await copyText(base64);}catch(err){alert('复制 Base64 失败:'+err.message);}}";
  html += "async function copyURL(key){try{let url=window.location.origin+'/get/'+encodeURIComponent(key);await copyText(url);}catch(err){alert('复制 URL 失败:'+err.message);}}";
  html += "</script></div></body></html>";
  return html;
}

// -------------------- Worker.js 完整版结束 --------------------
