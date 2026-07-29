export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const kv = env.NODES_KV;

      // ========== 基础路由过滤 ==========
      const allowedPaths = ["/", "/login", "/save", "/update", "/delete", "/list", "/detail"];
      if (!allowedPaths.includes(path) && !path.startsWith("/get/")) {
        return new Response("Not Found", { status: 404 });
      }
      if (!kv) return new Response("未绑定 NODES_KV", { status: 500 });

      // ========== 获取访客信息 ==========
      const ua = request.headers.get("user-agent") || "未知设备";
      const ip = (request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "未知IP").split(",")[0].trim();
      const cfLocation = request.cf?.city ? `${request.cf.country}, ${request.cf.city}` : (request.cf?.country || "未知国家");

      // ========== 🌏 地区限制：仅允许中国大陆 ==========
      if (request.cf?.country !== "CN") {
        return new Response("当前区域不支持访问", {
          status: 403,
          headers: { "Content-Type": "text/plain; charset=UTF-8" }
        });
      }

      // ========== 🧭 订阅获取接口 ==========
      if (path.startsWith("/get/")) {
        const realKey = path.replace("/get/", "");
        if (!realKey) return new Response("缺少 Key", { status: 400 });

        // 客户端 UA 白名单
        const uaWhitelist = [
          "clash",
          "quantumult",
          "surge",
          "shadowrocket",
          "v2ray",
          "sing-box",
          "loon",
          "v2rayng",
          "nekobox",
          "tbox",
          "passwall"
        ];

        if (!uaWhitelist.some(k => ua.toLowerCase().includes(k))) {
          return new Response("未授权的客户端类型", { status: 403 });
        }

        const value = await kv.get(realKey);
        if (!value) {
          await sendTG(env, "⚠️ 订阅访问失败", {
            "原因": "订阅不存在",
            "Key": realKey,
            "位置": cfLocation,
            "IP": ip
          });
          return new Response("订阅不存在", { status: 404 });
        }

        const item = JSON.parse(value);

        // 检查过期
        if (item.expire && Date.now() > item.expire) {
          await sendTG(env, "⏳ 订阅已过期", {
            "名称": item.displayName,
            "Key": item.realKey,
            "位置": cfLocation
          });
          return new Response("订阅已过期", { status: 403 });
        }

        await sendTG(env, "🧭 订阅节点访问", {
          "名称": item.displayName,
          "Key": item.realKey,
          "位置": cfLocation,
          "IP": ip,
          "UA": ua
        });

        return new Response(safeBtoa(item.content), {
          headers: {
            "Content-Type": "text/plain; charset=UTF-8",
            "Cache-Control": "no-store"
          }
        });
      }

      // ========== 前端页面 ==========
      if (path === "/") {
        return new Response(generateHTML(env), {
          headers: { "Content-Type": "text/html; charset=UTF-8" }
        });
      }

      // ========== 管理员登录 ==========
      const clientPassword = url.searchParams.get("password");

      if (path === "/login") {
        const ok = clientPassword === env.ADMIN_PASSWORD;

        await sendTG(env, ok ? "🔓 管理员登录成功" : "🔒 管理员登录失败", {
          "位置": cfLocation,
          "IP": ip,
          "UA": ua
        });

        return new Response(ok ? "登录成功" : "密码错误", {
          status: ok ? 200 : 403
        });
      }

      // ========== API 密码保护 ==========
      if (clientPassword !== env.ADMIN_PASSWORD) {
        return new Response("越权访问被拒绝", { status: 403 });
      }

      // ========== 查看详情 ==========
      if (path === "/detail") {
        const key = url.searchParams.get("key") || "";
        const val = await kv.get(key);

        return val
          ? new Response(val, {
              headers: { "Content-Type": "application/json;charset=UTF-8" }
            })
          : new Response("订阅不存在", { status: 404 });
      }

      // ========== 新增 / 更新订阅 ==========
      if (path === "/save" || path === "/update") {
        const content = await request.text();
        if (!content) return new Response("缺少内容", { status: 400 });

        let realKey = url.searchParams.get("key");
        let oldItem = null;

        if (path === "/update" && realKey) {
          const old = await kv.get(realKey);
          if (!old) return new Response("订阅不存在", { status: 404 });
          oldItem = JSON.parse(old);
        } else {
          realKey = Array.from({ length: 8 }, () =>
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 62)]
          ).join("");
        }

        const displayName = url.searchParams.get("displayName") || "未命名";
        const note = url.searchParams.get("note") || "";
        const days = parseInt(url.searchParams.get("days"), 10) || 0;

        const now = Date.now();
        const expire = days > 0
          ? now + days * 86400000
          : (path === "/update" ? oldItem?.expire : null);

        const item = {
          realKey,
          displayName,
          content,
          expire,
          note,
          created: oldItem?.created || now
        };

        await kv.put(realKey, JSON.stringify(item));

        await sendTG(env, path === "/save" ? "🟢 新增订阅" : "🟡 更新订阅", {
          "名称": displayName,
          "Key": realKey,
          "有效期": expire ? `${Math.ceil((expire - now) / 86400000)}天` : "永久",
          "备注": note || "无"
        });

        return new Response(path === "/save" ? "保存成功" : "更新成功");
      }

      // ========== 删除订阅 ==========
      if (path === "/delete") {
        const key = url.searchParams.get("key") || "";
        const old = await kv.get(key);
        const item = old ? JSON.parse(old) : null;

        await kv.delete(key);

        await sendTG(env, "🔴 删除订阅", {
          "名称": item?.displayName || "未知",
          "Key": key
        });

        return new Response("删除成功");
      }
      // ========== 📋 订阅列表 ==========
      if (path === "/list") {
        const page = parseInt(url.searchParams.get("page"), 10) || 1;
        const search = (url.searchParams.get("search") || "").toLowerCase();
        const sortField = url.searchParams.get("sort") || "displayName";
        const sortOrder = url.searchParams.get("order") || "asc";

        const listKV = await kv.list({ limit: 1000 }).catch(() => ({ keys: [] }));
        const values = await Promise.all(listKV.keys.map(k => kv.get(k.name)));

        let items = values.filter(Boolean).map(v => JSON.parse(v)).map(i => ({
          displayName: i.displayName || "未命名",
          realKey: i.realKey,
          remainingDays: i.expire
            ? (Date.now() > i.expire ? "已过期" : Math.ceil((i.expire - Date.now()) / 86400000))
            : "∞",
          note: i.note || "",
          created: i.created || 0
        }));

        // 搜索过滤
        if (search) {
          items = items.filter(i =>
            i.displayName.toLowerCase().includes(search) ||
            i.realKey.toLowerCase().includes(search) ||
            i.note.toLowerCase().includes(search)
          );
        }

        // 排序
        items.sort((a, b) => {
          let va = a[sortField];
          let vb = b[sortField];

          if (sortField === "remainingDays") {
            const cv = v => v === "∞" ? Infinity : (v === "已过期" ? -1 : Number(v));
            va = cv(va);
            vb = cv(vb);
          }

          if (va > vb) return sortOrder === "asc" ? 1 : -1;
          if (va < vb) return sortOrder === "asc" ? -1 : 1;
          return 0;
        });

        const totalPages = Math.max(1, Math.ceil(items.length / 10));

        return new Response(JSON.stringify({
          page,
          totalPages,
          items: items.slice((page - 1) * 10, page * 10)
        }), {
          headers: {
            "Content-Type": "application/json;charset=UTF-8"
          }
        });
      }

      return new Response("Not Found", { status: 404 });

    } catch (err) {
      return new Response(
        "Worker 内部错误: " + (err?.message || String(err)),
        { status: 500 }
      );
    }
  }
};


// ========== Base64 编码（支持中文） ==========
function safeBtoa(str) {
  try {
    return btoa(
      encodeURIComponent(str).replace(
        /%([0-9A-F]{2})/g,
        (_, p1) => String.fromCharCode(parseInt(p1, 16))
      )
    );
  } catch {
    return btoa(str);
  }
}


// ========== Telegram 通知 ==========
async function sendTG(env, title, fields = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) return;

  const time = new Date()
    .toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false
    })
    .replace(/\//g, "-");

  const escape = t =>
    String(t || "").replace(
      /([_*\[\]()~`>#+=\-|{}.!])/g,
      "\\$1"
    );

  const body = Object.entries(fields)
    .filter(([_, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  const text =
`*${escape(title)}*
⏰ ${escape(time)}

${body}`;

  await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "MarkdownV2",
        disable_notification: true
      })
    }
  ).catch(() => {});
}

// ========== 前端 UI 管理页面 HTML ==========
function generateHTML(env) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
	<title>KV订阅管理</title>
  <link rel='icon' href='https://cftc.sunmoonyou.workers.dev/1771998133339_favicon.ico' type='image/x-icon'></link>
	<style>
		body{font-family:sans-serif;margin:0;padding:0;background:#f0f2f5;}
		.container{max-width:900px;margin:20px auto;padding:20px;background:#fff;border-radius:12px;box-shadow:0 5px 15px rgba(0,0,0,0.1);}
		input,textarea,select,button{font-size:14px;margin:5px 0;padding:10px;border-radius:8px;border:1px solid #ccc;width:100%;box-sizing:border-box;}
		button{background:#4facfe;color:#fff;border:none;cursor:pointer;}button:hover{background:#00f2fe;}
		table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px;}
		th,td{border:1px solid #ddd;padding:8px;text-align:center;}th{background:#4facfe;color:#fff;}
		.copy-btn{background:#00c1ff;color:#fff;padding:4px 8px;border:none;border-radius:6px;cursor:pointer;}
		.edit-btn{background:#ffa500;color:#fff;} .delete-btn{background:#ff5c5c;color:#fff;}
		.pagination{margin-top:10px;text-align:center;} .pagination button{width:auto;padding:5px 10px;margin:0 2px;}
		.search-sort{margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;} .search-sort *{flex:1;min-width:100px;}
		@media(max-width:600px){.search-sort{flex-direction:column;}}
	</style>
</head>
<body>
<div class="container">
	<h2>KV订阅管理</h2>
  <link rel='icon' href='https://cftc.sunmoonyou.workers.dev/1771998133339_favicon.ico' type='image/x-icon'></link>
	<div id="loginDiv"><label>管理员密码:</label><input type="password" id="adminPassword"><button id="loginBtn">登录</button></div>
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
			<thead><tr><th>名称</th><th>备注</th><th>剩余天数</th><th>URL</th><th>编辑</th><th>删除</th></tr></thead>
			<tbody id="keylist"></tbody>
		</table>
		<div class="pagination" id="pagination"></div>
	</div>
</div>
<script>
	let ADMIN_PASSWORD = '';
	let currentPage=1, currentSearch='', currentSort='displayName', currentOrder='asc', currentEditingKey=null;

	document.getElementById('loginBtn').addEventListener('click', async () => {
		const pw = document.getElementById('adminPassword').value.trim();
		try {
			const resp = await fetch('/login?password=' + encodeURIComponent(pw));
			if(resp.status === 200){
				ADMIN_PASSWORD = pw; // 只有拿到后端 200 回应，才解锁全局密码变量
				document.getElementById('loginDiv').style.display = 'none';
				document.getElementById('mainDiv').style.display = 'block';
				loadKeyList(1);
			} else {
				alert('密码错误');
			}
		} catch(e) {
			alert('登录失败，请检查网络');
		}
	});

	document.getElementById('searchBtn').addEventListener('click', () => {
		currentSearch = document.getElementById('search').value.trim();
		currentSort = document.getElementById('sort').value;
		currentOrder = document.getElementById('order').value;
		loadKeyList(1);
	});

	document.getElementById('saveBtn').addEventListener('click', async () => {
		const displayName = document.getElementById('key').value.trim() || '未命名';
		const text = document.getElementById('text').value.trim();
		const note = document.getElementById('note').value.trim();
		const days = parseInt(document.getElementById('days').value, 10) || 0;
		if(!text) return alert('请输入订阅内容');

		try {
			// 修改或新增的精准分流路由传参
			const url = currentEditingKey 
				? \`/update?key=\${encodeURIComponent(currentEditingKey)}&displayName=\${encodeURIComponent(displayName)}&days=\${days}&note=\${encodeURIComponent(note)}&password=\${encodeURIComponent(ADMIN_PASSWORD)}\`
				: \`/save?displayName=\${encodeURIComponent(displayName)}&days=\${days}&note=\${encodeURIComponent(note)}&password=\${encodeURIComponent(ADMIN_PASSWORD)}\`;
			
			const resp = await fetch(url, { method: 'POST', body: text });
			alert(await resp.text());
			
			currentEditingKey = null;
			document.getElementById('saveBtn').textContent = '保存订阅';
			['key','text','note','days'].forEach(id => document.getElementById(id).value = '');
			loadKeyList(currentPage);
		} catch(err) { alert('操作失败'); }
	});

	async function loadKeyList(page = 1) {
		if(!ADMIN_PASSWORD) return; // 拦截器：如果密码未解锁，断绝发起列表加载请求
		currentPage = page;
		try {
			const resp = await fetch(\`/list?page=\${page}&search=\${encodeURIComponent(currentSearch)}&sort=\${currentSort}&order=\${currentOrder}&password=\${encodeURIComponent(ADMIN_PASSWORD)}\`);
			if (resp.status !== 200) return;
			const data = await resp.json();
			const tbody = document.getElementById('keylist'); tbody.innerHTML = '';
			
			data.items.forEach(item => {
				const tr = document.createElement('tr');
				tr.innerHTML = \`<td>\${item.displayName}</td><td>\${item.note}</td><td>\${item.remainingDays}</td>
				<td><button class="copy-btn">复制</button></td>
				<td><button class="copy-btn edit-btn">编辑</button></td><td><button class="copy-btn delete-btn">删除</button></td>\`;
				tbody.appendChild(tr);

				tr.querySelector('.copy-btn').addEventListener('click', () => { navigator.clipboard.writeText(window.location.origin + '/get/' + encodeURIComponent(item.realKey)); alert('已复制!'); });
				tr.querySelector('.edit-btn').addEventListener('click', () => editItem(item.realKey));
				tr.querySelector('.delete-btn').addEventListener('click', () => deleteKey(item.realKey));
			});

			const pageDiv = document.getElementById('pagination'); pageDiv.innerHTML = '';
			for(let i = 1; i <= data.totalPages; i++) {
				const btn = document.createElement('button'); btn.textContent = i;
				if(i === data.page) btn.disabled = true;
				btn.addEventListener('click', () => loadKeyList(i));
				pageDiv.appendChild(btn);
			}
		} catch(e) { }
	}

	async function editItem(realKey) {
		const resp = await fetch(\`/detail?key=\${encodeURIComponent(realKey)}&password=\${encodeURIComponent(ADMIN_PASSWORD)}\`);
		if (resp.status !== 200) return alert('获取详情失败');
		const item = await resp.json();
		document.getElementById('key').value = item.displayName || '';
		document.getElementById('text').value = item.content || '';
		document.getElementById('note').value = item.note || '';
		document.getElementById('days').value = item.expire ? Math.max(0, Math.ceil((item.expire - Date.now()) / 86400000)) : 0;
		currentEditingKey = realKey;
		document.getElementById('saveBtn').textContent = '更新订阅';
	}

	async function deleteKey(key) {
		if(confirm('确定删除?')) {
			const resp = await fetch(\`/delete?key=\${encodeURIComponent(key)}&password=\${encodeURIComponent(ADMIN_PASSWORD)}\`, { method: 'POST' });
			alert(await resp.text());
			loadKeyList(currentPage);
		}
	}
</script>
</body>
</html>`;
}
