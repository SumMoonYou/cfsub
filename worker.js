/**
 * Cloudflare Worker - 订阅节点管理系统
 * 功能：
 *   - 管理代理订阅节点（新增 / 更新 / 删除 / 列表 / 详情）
 *   - 通过 /get/{key} 提供订阅内容（仅允许指定客户端 UA）
 *   - 仅允许中国大陆（CN）访问
 *   - 所有关键操作与订阅访问均推送 Telegram 通知
 *   - 使用 NODES_KV 存储订阅数据
 *   - 提供简单的前端管理页面
 */

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const kv = env.NODES_KV;

      // 允许的路径白名单
      const allowedPaths = ["/", "/login", "/save", "/update", "/delete", "/list", "/detail"];
      if (!allowedPaths.includes(path) && !path.startsWith("/get/")) {
        return new Response("Not Found", { status: 404 });
      }

      // 检查 KV 绑定
      if (!kv) {
        return new Response("未绑定 NODES_KV", { status: 500 });
      }

      // 获取客户端信息
      const ua = request.headers.get("user-agent") || "未知设备";
      const ip = (
        request.headers.get("cf-connecting-ip") ||
        request.headers.get("x-forwarded-for") ||
        "未知IP"
      )
        .split(",")[0]
        .trim();

      // 解析 IP 地理位置
      const ipInfo = await getIPLocation(ip, request.cf || {});
      const cfLocation = ipInfo.location;

      // ==========================
      // 地区限制：仅允许中国大陆访问
      // ==========================
      if ((request.cf?.country || "") !== "CN") {
        return new Response("当前区域不支持访问", {
          status: 403,
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
        });
      }

      // ==========================
      // 订阅获取接口：/get/{realKey}
      // ==========================
      if (path.startsWith("/get/")) {
        const realKey = path.slice(5);
        if (!realKey) {
          return new Response("缺少 Key", { status: 400 });
        }

        // 允许的客户端 UA 关键词列表
        const uaList = [
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
          "passwall",
        ];

        // 检查 UA 是否合法
        if (!uaList.some((x) => ua.toLowerCase().includes(x))) {
          await sendTG(env, "❌ 订阅访问被拦截", {
            "提取 🔑": realKey,
            "访问位置": cfLocation,
            "IP 地址": ip,
            "客户端 UA": ua,
          });
          return new Response("未授权客户端", { status: 403 });
        }

        // 从 KV 读取订阅
        const value = await kv.get(realKey);
        if (!value) {
          return new Response("订阅不存在", { status: 404 });
        }

        const item = JSON.parse(value);

        // 检查是否过期
        if (item.expire && Date.now() > item.expire) {
          await sendTG(env, "⏳ 订阅已过期", {
            "订阅名称": item.displayName,
            "提取 🔑": item.realKey,
            "访问位置": cfLocation,
          });
          return new Response("订阅已过期", { status: 403 });
        }

        // 正常访问通知
        await sendTG(env, "🧭 订阅节点被访问", {
          "订阅名称": item.displayName,
          "提取 🔑": item.realKey,
          "访问位置": ipInfo.location,
          "运营商": ipInfo.isp,
          "ASN": ipInfo.asn,
          "IP 地址": ip,
          "客户端 UA": ua,
        });

        // 返回 Base64 编码后的订阅内容
        return new Response(safeBtoa(item.content), {
          headers: {
            "Content-Type": "text/plain;charset=UTF-8",
            "Cache-Control": "no-store",
          },
        });
      }

      // ==========================
      // 首页（管理后台）
      // ==========================
      if (path === "/") {
        return new Response(generateHTML(env), {
          headers: {
            "Content-Type": "text/html;charset=UTF-8",
          },
        });
      }

      // ==========================
      // 登录验证
      // ==========================
      const password = url.searchParams.get("password");

      if (path === "/login") {
        const ok = password === env.ADMIN_PASSWORD;

        await sendTG(
          env,
          ok ? "🔓 管理员登录成功" : "🔒 管理员登录失败",
          {
            [ok ? "登录位置" : "尝试位置"]: cfLocation,
            "IP 地址": ip,
            "客户端 UA": ua,
          }
        );

        return new Response(ok ? "登录成功" : "密码错误", {
          status: ok ? 200 : 403,
        });
      }

      // 管理接口统一鉴权
      if (password !== env.ADMIN_PASSWORD) {
        return new Response("越权访问被拒绝", { status: 403 });
      }

      // ==========================
      // 获取订阅详情
      // ==========================
      if (path === "/detail") {
        const key = url.searchParams.get("key") || "";
        const value = await kv.get(key);

        return value
          ? new Response(value, {
              headers: {
                "Content-Type": "application/json;charset=UTF-8",
              },
            })
          : new Response("订阅不存在", { status: 404 });
      }

      // ==========================
      // 新增 / 更新订阅
      // ==========================
      if (path === "/save" || path === "/update") {
        const content = await request.text();
        if (!content) {
          return new Response("缺少内容", { status: 400 });
        }

        let key = url.searchParams.get("key");
        let old = null;

        // 更新模式：必须提供已存在的 key
        if (path === "/update" && key) {
          const oldVal = await kv.get(key);
          if (!oldVal) {
            return new Response("订阅不存在", { status: 404 });
          }
          old = JSON.parse(oldVal);
        } else {
          // 新增模式：生成 8 位随机 key
          key = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
        }

        const now = Date.now();
        const days = parseInt(url.searchParams.get("days"), 10) || 0;

        const item = {
          realKey: key,
          displayName: url.searchParams.get("displayName") || "未命名",
          content,
          note: url.searchParams.get("note") || "",
          expire: days > 0 ? now + days * 86400000 : old?.expire || null,
          created: old?.created || now,
        };

        await kv.put(key, JSON.stringify(item));

        await sendTG(
          env,
          path === "/save" ? "🟢 新增订阅节点" : "🟡 更新订阅节点",
          {
            "订阅名称": item.displayName,
            "提取 🔑": key,
            "备注": item.note || "无",
          }
        );

        return new Response(path === "/save" ? "保存成功" : "更新成功");
      }

      // ==========================
      // 删除订阅
      // ==========================
      if (path === "/delete") {
        const key = url.searchParams.get("key") || "";
        const oldVal = await kv.get(key);
        const old = oldVal ? JSON.parse(oldVal) : null;

        await kv.delete(key);

        await sendTG(env, "🔴 删除订阅节点", {
          "订阅名称": old?.displayName || "未知",
          "提取 🔑": key,
          "原备注": old?.note || "无",
        });

        return new Response("删除成功");
      }

      // ==========================
      // 订阅列表（支持分页与搜索）
      // ==========================
      if (path === "/list") {
        const page = parseInt(url.searchParams.get("page"), 10) || 1;
        const search = (url.searchParams.get("search") || "").toLowerCase();

        // 获取所有 key（最多 1000 条）
        const list = await kv.list({ limit: 1000 }).catch(() => ({ keys: [] }));

        // 并行读取所有 value
        const values = await Promise.all(list.keys.map((k) => kv.get(k.name)));

        // 转换为前端需要的数据结构
        let items = values
          .filter(Boolean)
          .map((v) => JSON.parse(v))
          .map((i) => ({
            displayName: i.displayName || "未命名",
            realKey: i.realKey,
            note: i.note || "",
            created: i.created || 0,
            remainingDays: i.expire
              ? Date.now() > i.expire
                ? "已过期"
                : Math.ceil((i.expire - Date.now()) / 86400000)
              : "∞",
          }));

        // 关键词搜索过滤
        if (search) {
          items = items.filter(
            (i) =>
              i.displayName.toLowerCase().includes(search) ||
              i.realKey.toLowerCase().includes(search) ||
              i.note.toLowerCase().includes(search)
          );
        }

        // 按显示名称排序
        items.sort((a, b) => a.displayName.localeCompare(b.displayName));

        return new Response(
          JSON.stringify({
            page,
            totalPages: Math.max(1, Math.ceil(items.length / 10)),
            items: items.slice((page - 1) * 10, page * 10),
          }),
          {
            headers: {
              "Content-Type": "application/json;charset=UTF-8",
            },
          }
        );
      }

      // 默认响应
      return new Response("OK");
    } catch (e) {
      return new Response("Worker错误:" + e.message, { status: 500 });
    }
  },
};

/**
 * IP 地理位置解析
 * 优先级：
 *   1. ip9.com.cn（国内优先）
 *   2. ip-api.com（免费备用）
 *   3. Cloudflare request.cf 信息
 */
async function getIPLocation(ip, cf = {}) {
  // ---------- 1. 优先使用 ip9.com.cn ----------
  try {
    const res = await fetch(`https://ip9.com.cn/get?ip=${ip}`, {
      headers: { "User-Agent": "Cloudflare-Worker" },
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) throw new Error(`ip9 ${res.status}`);

    const json = await res.json();
    if (json.ret !== 200 || !json.data) throw new Error("ip9 invalid response");

    const d = json.data;

    return {
      location: [d.country, d.prov, d.city, d.area].filter(Boolean).join(" "),
      isp: d.isp || "Unknown",
      asn: "",
      source: "ip9",
    };
  } catch (e) {
    // 忽略错误，继续尝试下一个源
  }

  // ---------- 2. 兜底使用 ip-api.com ----------
  try {
    const res = await fetch(
      `http://ip-api.com/json/${ip}?fields=status,message,country,regionName,city,isp,as,org`,
      { signal: AbortSignal.timeout(3000) }
    );

    if (!res.ok) throw new Error(`ip-api ${res.status}`);

    const d = await res.json();
    if (d.status !== "success") throw new Error(d.message || "ip-api failed");

    return {
      location: [d.country, d.regionName, d.city].filter(Boolean).join(" "),
      isp: d.isp || d.org || "Unknown",
      asn: d.as || "",
      source: "ip-api",
    };
  } catch (e) {
    // 忽略错误，继续使用 Cloudflare 信息
  }

  // ---------- 3. 最终回退到 Cloudflare ----------
  const parts = [cf.country, cf.city].filter(Boolean);
  return {
    location: parts.length ? parts.join(" ") : "Unknown",
    isp: "Unknown",
    asn: cf.asn ? `AS${cf.asn}` : "",
    source: "cloudflare",
  };
}

/**
 * 安全 Base64 编码
 * 先对字符串进行 URI 编码，再转换为 Base64，避免中文等特殊字符问题
 */
function safeBtoa(str) {
  try {
    return btoa(
      encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p) =>
        String.fromCharCode(parseInt(p, 16))
      )
    );
  } catch {
    return btoa(str);
  }
}

/**
 * 发送 Telegram 通知
 * @param {object} env       Worker 环境变量
 * @param {string} title     消息标题
 * @param {object} fields    键值对字段（会自动过滤空值）
 */
async function sendTG(env, title, fields = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  // 生成上海时区时间字符串
  const timeStr = new Date()
    .toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false,
    })
    .replace(/\//g, "-");

  // MarkdownV2 特殊字符转义
  const esc = (t) =>
    String(t || "").replace(/([_*\[\]()~`>#+=\-|{}.!])/g, "\\$1");

  // 组装消息正文
  const bodyLines = Object.entries(fields)
    .filter(([_, v]) => v)
    .map(([k, v]) => `${k} : ${esc(v)}`)
    .join("\n");

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: `*${esc(title)}*
*⏰ 时间:* \`${esc(timeStr)}\`

\`\`\`
${bodyLines}
\`\`\``,
      parse_mode: "MarkdownV2",
      disable_notification: true,
    }),
  }).catch(() => {});
}

/**
 * 生成前端管理页面 HTML
 * 包含登录、搜索、新增/编辑、列表展示、复制订阅链接、删除等功能
 */
function generateHTML(env) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
  <title>KV订阅管理</title>
  <link rel="icon" href="https://cftc.sunmoonyou.workers.dev/1771998133339_favicon.ico" type="image/x-icon">
  <style>
    body {
      font-family: sans-serif;
      margin: 0;
      padding: 0;
      background: #f0f2f5;
    }
    .container {
      max-width: 900px;
      margin: 20px auto;
      padding: 20px;
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 5px 15px rgba(0, 0, 0, 0.1);
    }
    input, textarea, select, button {
      font-size: 14px;
      margin: 5px 0;
      padding: 10px;
      border-radius: 8px;
      border: 1px solid #ccc;
      width: 100%;
      box-sizing: border-box;
    }
    button {
      background: #4facfe;
      color: #fff;
      border: none;
      cursor: pointer;
    }
    button:hover {
      background: #00f2fe;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
      font-size: 13px;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 8px;
      text-align: center;
    }
    th {
      background: #4facfe;
      color: #fff;
    }
    .copy-btn {
      background: #00c1ff;
      color: #fff;
      padding: 4px 8px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
    }
    .edit-btn {
      background: #ffa500;
      color: #fff;
    }
    .delete-btn {
      background: #ff5c5c;
      color: #fff;
    }
    .pagination {
      margin-top: 10px;
      text-align: center;
    }
    .pagination button {
      width: auto;
      padding: 5px 10px;
      margin: 0 2px;
    }
    .search-sort {
      margin-top: 10px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .search-sort * {
      flex: 1;
      min-width: 100px;
    }
    @media (max-width: 600px) {
      .search-sort {
        flex-direction: column;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h2>KV订阅管理</h2>

    <!-- 登录区域 -->
    <div id="loginDiv">
      <label>管理员密码:</label>
      <input type="password" id="adminPassword">
      <button id="loginBtn">登录</button>
    </div>

    <!-- 主功能区域（登录后显示） -->
    <div id="mainDiv" style="display: none;">
      <!-- 搜索与排序 -->
      <div class="search-sort">
        <input type="text" id="search" placeholder="搜索名称">
        <select id="sort">
          <option value="displayName">名称排序</option>
          <option value="remainingDays">剩余天数排序</option>
        </select>
        <select id="order">
          <option value="asc">升序</option>
          <option value="desc">降序</option>
        </select>
        <button id="searchBtn">搜索/排序</button>
      </div>

      <!-- 新增 / 编辑表单 -->
      <label>订阅显示名称:</label>
      <input type="text" id="key" placeholder="如 node1">

      <label>订阅内容:</label>
      <textarea id="text" rows="5" placeholder="输入订阅节点内容"></textarea>

      <label>备注:</label>
      <input type="text" id="note" placeholder="节点备注">

      <label>有效天数 (0 表示永久):</label>
      <input type="number" id="days" placeholder="例如 7">

      <button id="saveBtn">保存订阅</button>

      <!-- 订阅列表 -->
      <h3>已保存订阅列表：</h3>
      <table>
        <thead>
          <tr>
            <th>名称</th>
            <th>备注</th>
            <th>剩余天数</th>
            <th>URL</th>
            <th>编辑</th>
            <th>删除</th>
          </tr>
        </thead>
        <tbody id="keylist"></tbody>
      </table>
      <div class="pagination" id="pagination"></div>
    </div>
  </div>

  <script>
    // 全局状态
    let ADMIN_PASSWORD = '';
    let currentPage = 1;
    let currentSearch = '';
    let currentSort = 'displayName';
    let currentOrder = 'asc';
    let currentEditingKey = null;

    // 登录按钮事件
    document.getElementById('loginBtn').addEventListener('click', async () => {
      const pw = document.getElementById('adminPassword').value.trim();
      try {
        const resp = await fetch('/login?password=' + encodeURIComponent(pw));
        if (resp.status === 200) {
          ADMIN_PASSWORD = pw;
          document.getElementById('loginDiv').style.display = 'none';
          document.getElementById('mainDiv').style.display = 'block';
          loadKeyList(1);
        } else {
          alert('密码错误');
        }
      } catch (e) {
        alert('登录失败，请检查网络');
      }
    });

    // 搜索 / 排序按钮
    document.getElementById('searchBtn').addEventListener('click', () => {
      currentSearch = document.getElementById('search').value.trim();
      currentSort = document.getElementById('sort').value;
      currentOrder = document.getElementById('order').value;
      loadKeyList(1);
    });

    // 保存 / 更新按钮
    document.getElementById('saveBtn').addEventListener('click', async () => {
      const displayName = document.getElementById('key').value.trim() || '未命名';
      const text = document.getElementById('text').value.trim();
      const note = document.getElementById('note').value.trim();
      const days = parseInt(document.getElementById('days').value, 10) || 0;

      if (!text) return alert('请输入订阅内容');

      try {
        // 根据是否处于编辑状态选择不同接口
        const url = currentEditingKey
          ? \`/update?key=\${encodeURIComponent(currentEditingKey)}&displayName=\${encodeURIComponent(displayName)}&days=\${days}&note=\${encodeURIComponent(note)}&password=\${encodeURIComponent(ADMIN_PASSWORD)}\`
          : \`/save?displayName=\${encodeURIComponent(displayName)}&days=\${days}&note=\${encodeURIComponent(note)}&password=\${encodeURIComponent(ADMIN_PASSWORD)}\`;

        const resp = await fetch(url, {
          method: 'POST',
          body: text
        });

        alert(await resp.text());

        // 重置表单
        currentEditingKey = null;
        document.getElementById('saveBtn').textContent = '保存订阅';
        ['key', 'text', 'note', 'days'].forEach(id => {
          document.getElementById(id).value = '';
        });

        loadKeyList(currentPage);
      } catch (err) {
        alert('操作失败');
      }
    });

    /**
     * 加载订阅列表
     * @param {number} page 页码
     */
    async function loadKeyList(page = 1) {
      if (!ADMIN_PASSWORD) return; // 未登录则不请求

      currentPage = page;

      try {
        const resp = await fetch(
          \`/list?page=\${page}&search=\${encodeURIComponent(currentSearch)}&sort=\${currentSort}&order=\${currentOrder}&password=\${encodeURIComponent(ADMIN_PASSWORD)}\`
        );

        if (resp.status !== 200) return;

        const data = await resp.json();
        const tbody = document.getElementById('keylist');
        tbody.innerHTML = '';

        data.items.forEach(item => {
          const tr = document.createElement('tr');
          tr.innerHTML = \`
            <td>\${item.displayName}</td>
            <td>\${item.note}</td>
            <td>\${item.remainingDays}</td>
            <td><button class="copy-btn">复制</button></td>
            <td><button class="copy-btn edit-btn">编辑</button></td>
            <td><button class="copy-btn delete-btn">删除</button></td>
          \`;
          tbody.appendChild(tr);

          // 复制订阅链接
          tr.querySelector('.copy-btn').addEventListener('click', () => {
            navigator.clipboard.writeText(
              window.location.origin + '/get/' + encodeURIComponent(item.realKey)
            );
            alert('已复制!');
          });

          // 编辑
          tr.querySelector('.edit-btn').addEventListener('click', () => {
            editItem(item.realKey);
          });

          // 删除
          tr.querySelector('.delete-btn').addEventListener('click', () => {
            deleteKey(item.realKey);
          });
        });

        // 渲染分页按钮
        const pageDiv = document.getElementById('pagination');
        pageDiv.innerHTML = '';

        for (let i = 1; i <= data.totalPages; i++) {
          const btn = document.createElement('button');
          btn.textContent = i;
          if (i === data.page) btn.disabled = true;
          btn.addEventListener('click', () => loadKeyList(i));
          pageDiv.appendChild(btn);
        }
      } catch (e) {
        // 静默失败
      }
    }

    /**
     * 编辑指定订阅
     * @param {string} realKey 订阅真实 key
     */
    async function editItem(realKey) {
      const resp = await fetch(
        \`/detail?key=\${encodeURIComponent(realKey)}&password=\${encodeURIComponent(ADMIN_PASSWORD)}\`
      );

      if (resp.status !== 200) return alert('获取详情失败');

      const item = await resp.json();

      document.getElementById('key').value = item.displayName || '';
      document.getElementById('text').value = item.content || '';
      document.getElementById('note').value = item.note || '';
      document.getElementById('days').value = item.expire
        ? Math.max(0, Math.ceil((item.expire - Date.now()) / 86400000))
        : 0;

      currentEditingKey = realKey;
      document.getElementById('saveBtn').textContent = '更新订阅';
    }

    /**
     * 删除指定订阅
     * @param {string} key 订阅 key
     */
    async function deleteKey(key) {
      if (!confirm('确定删除?')) return;

      const resp = await fetch(
        \`/delete?key=\${encodeURIComponent(key)}&password=\${encodeURIComponent(ADMIN_PASSWORD)}\`,
        { method: 'POST' }
      );

      alert(await resp.text());
      loadKeyList(currentPage);
    }
  </script>
</body>
</html>`;
}
