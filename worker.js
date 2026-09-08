/**
 * Cloudflare Worker - 节点订阅管理系统
 *
 * 功能概览：
 *   1. 管理节点订阅（新增 / 更新 / 删除 / 列表 / 详情）
 *   2. 通过 /get/{key}/{token} 下发订阅内容（双重密钥保护）
 *   3. 仅允许中国大陆（CN）IP 访问订阅
 *   4. 客户端 UA 白名单校验
 *   5. 同 Key + 同 IP 60 秒访问频率限制
 *   6. 所有管理操作与订阅访问均推送 Telegram 通知
 *   7. 使用 NODES_KV 存储数据
 *   8. 前端管理页面支持：
 *        - 算术验证码登录
 *        - 刷新/关闭浏览器自动退出（sessionStorage）
 *        - 5 分钟无操作自动退出
 *        - 双重密钥链接一键复制
 */

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const kv = env.NODES_KV;

      // ---------- 路径白名单 ----------
      const allowedPaths = [
        "/",
        "/login",
        "/save",
        "/update",
        "/delete",
        "/list",
        "/detail",
      ];
      if (!allowedPaths.includes(path) && !path.startsWith("/get/")) {
        return new Response("Not Found", { status: 404 });
      }

      // ---------- 检查 KV 绑定 ----------
      if (!kv) {
        return new Response("未绑定 NODES_KV", { status: 500 });
      }

      // ---------- 获取客户端信息 ----------
      const ua = request.headers.get("user-agent") || "未知设备";
      const ip = (
        request.headers.get("cf-connecting-ip") ||
        request.headers.get("x-forwarded-for") ||
        "未知IP"
      )
        .split(",")[0]
        .trim();

      // ---------- 解析 IP 地理位置 ----------
      const ipInfo = await getIPLocation(ip, request.cf || {});
      const cfLocation = ipInfo.location;

      // =====================================================
      // 订阅获取接口：/get/{key}/{token}（双重密钥）
      // =====================================================
      if (path.startsWith("/get/")) {
        const parts = path.slice(5).split("/").filter(Boolean);

        // 必须同时提供 key 和 token
        if (parts.length < 2) {
          return new Response("缺少密钥", { status: 400 });
        }

        const realKey = parts[0];
        const providedToken = parts[1];

        // 允许的客户端 UA 关键词
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
        const clientUA = ua.toLowerCase();

        // 地区限制：仅允许中国大陆
        if ((request.cf?.country || "") !== "CN") {
          return new Response("当前区域不支持访问", {
            status: 403,
            headers: { "Content-Type": "text/plain;charset=UTF-8" },
          });
        }

        // UA 白名单检测
        if (!uaList.some((x) => clientUA.includes(x))) {
          await sendTG(env, "❌ 订阅访问被拦截（非法客户端）", {
            "提取 🔑": `${realKey.slice(0, 4)}****${realKey.slice(-4)}`,
            "访问位置": cfLocation,
            "IP 地址": ip,
            "客户端 UA": ua,
          });
          return new Response("未授权客户端", { status: 403 });
        }

        // ---------- 访问频率限制（同 Key + 同 IP 60 秒一次） ----------
        const limitKey = `limit:${realKey}:${ip}`;
        if (await kv.get(limitKey)) {
          return new Response("请求过于频繁，请60秒后再试", {
            status: 429,
            headers: {
              "Content-Type": "text/plain;charset=UTF-8",
              "Retry-After": "60",
            },
          });
        }
        await kv.put(limitKey, "1", { expirationTtl: 60 });

        // ---------- 读取订阅数据 ----------
        const value = await kv.get(realKey);
        if (!value) {
          return new Response("订阅不存在", { status: 404 });
        }

        let item;
        try {
          item = JSON.parse(value);
        } catch {
          return new Response("订阅数据异常", { status: 500 });
        }

        // ---------- 验证 token（双重密钥核心） ----------
        if (!item.token || item.token !== providedToken) {
          await sendTG(env, "❌ 订阅访问被拦截（Token错误）", {
            "提取 🔑": `${realKey.slice(0, 4)}****${realKey.slice(-4)}`,
            "访问位置": cfLocation,
            "IP 地址": ip,
            "客户端 UA": ua,
          });
          return new Response("密钥错误", { status: 403 });
        }

        // ---------- 检查是否过期 ----------
        if (item.expire && Date.now() > item.expire) {
          await sendTG(env, "⏳ 订阅已过期", {
            "订阅名称": item.displayName,
            "提取 🔑": `${item.realKey.slice(0, 4)}****${item.realKey.slice(-4)}`,
            "访问位置": cfLocation,
          });
          return new Response("订阅已过期", { status: 403 });
        }

        // ---------- 正常访问通知 ----------
        await sendTG(env, "🧭 订阅节点被访问", {
          "订阅名称": item.displayName,
          "提取 🔑": `${item.realKey.slice(0, 4)}****${item.realKey.slice(-4)}`,
          "访问位置": ipInfo.location,
          "运营商": ipInfo.isp,
          "ASN": ipInfo.asn,
          "IP 地址": ip,
          "客户端 UA": ua,
        });

        // ---------- 返回 Base64 编码的订阅内容 ----------
        return new Response(safeBtoa(item.content), {
          headers: {
            "Content-Type": "text/plain;charset=UTF-8",
            "Cache-Control": "no-store",
          },
        });
      }

      // =====================================================
      // 首页（管理后台页面）
      // =====================================================
      if (path === "/") {
        return new Response(generateHTML(), {
          headers: { "Content-Type": "text/html;charset=UTF-8" },
        });
      }

      // =====================================================
      // 登录验证
      // =====================================================
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

      // ---------- 管理接口统一鉴权 ----------
      if (password !== env.ADMIN_PASSWORD) {
        return new Response("越权访问被拒绝", { status: 403 });
      }

      // =====================================================
      // 获取订阅详情
      // =====================================================
      if (path === "/detail") {
        const key = url.searchParams.get("key") || "";
        const value = await kv.get(key);
        return value
          ? new Response(value, {
              headers: { "Content-Type": "application/json;charset=UTF-8" },
            })
          : new Response("订阅不存在", { status: 404 });
      }

      // =====================================================
      // 新增 / 更新订阅
      // =====================================================
      if (path === "/save" || path === "/update") {
        const content = await request.text();
        if (!content) {
          return new Response("缺少内容", { status: 400 });
        }

        let key = url.searchParams.get("key");
        let old = null;

        // 更新模式必须提供已存在的 key
        if (path === "/update" && key) {
          const oldVal = await kv.get(key);
          if (!oldVal) {
            return new Response("订阅不存在", { status: 404 });
          }
          old = JSON.parse(oldVal);
        } else {
          // 新增：生成 12 位随机 key
          key = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
        }

        // 生成或保留 16 位 token（双重密钥）
        const token =
          old?.token || crypto.randomUUID().replace(/-/g, "").slice(0, 16);

        const now = Date.now();
        const days = parseInt(url.searchParams.get("days"), 10) || 0;

        const item = {
          realKey: key,
          token: token,
          displayName: url.searchParams.get("displayName") || "未命名",
          content,
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
            "Token": token,
          }
        );

        return new Response(path === "/save" ? "保存成功" : "更新成功");
      }

      // =====================================================
      // 删除订阅
      // =====================================================
      if (path === "/delete") {
        const key = url.searchParams.get("key") || "";
        const oldVal = await kv.get(key);
        const old = oldVal ? JSON.parse(oldVal) : null;

        await kv.delete(key);

        await sendTG(env, "🔴 删除订阅节点", {
          "订阅名称": old?.displayName || "未知",
          "提取 🔑": key,
        });

        return new Response("删除成功");
      }

      // =====================================================
      // 订阅列表（分页 + 搜索）
      // =====================================================
      if (path === "/list") {
        const page = parseInt(url.searchParams.get("page"), 10) || 1;
        const search = (url.searchParams.get("search") || "").toLowerCase();

        // 最多读取 1000 条
        const list = await kv.list({ limit: 1000 }).catch(() => ({ keys: [] }));
        const values = await Promise.all(list.keys.map((k) => kv.get(k.name)));

        let items = values
          .filter(Boolean)
          .map((v) => JSON.parse(v))
          .map((i) => ({
            displayName: i.displayName || "未命名",
            realKey: i.realKey,
            token: i.token || "",
            created: i.created || 0,
            remainingDays: i.expire
              ? Date.now() > i.expire
                ? "已过期"
                : Math.ceil((i.expire - Date.now()) / 86400000)
              : "∞",
          }));

        // 关键词过滤
        if (search) {
          items = items.filter(
            (i) =>
              i.displayName.toLowerCase().includes(search) ||
              i.realKey.toLowerCase().includes(search)
          );
        }

        // 默认按名称排序
        items.sort((a, b) => a.displayName.localeCompare(b.displayName));

        return new Response(
          JSON.stringify({
            page,
            totalPages: Math.max(1, Math.ceil(items.length / 10)),
            items: items.slice((page - 1) * 10, page * 10),
          }),
          {
            headers: { "Content-Type": "application/json;charset=UTF-8" },
          }
        );
      }

      return new Response("OK");
    } catch (e) {
      return new Response("Worker错误:" + e.message, { status: 500 });
    }
  },
};

/* ============================================================
 * 工具函数
 * ============================================================ */

/**
 * IP 地理位置解析
 * 优先级：ip9.com.cn → ip-api.com → Cloudflare cf 信息
 */
async function getIPLocation(ip, cf = {}) {
  // 1. 优先国内源
  try {
    const res = await fetch(`https://ip9.com.cn/get?ip=${ip}`, {
      headers: { "User-Agent": "Cloudflare-Worker" },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error();
    const json = await res.json();
    if (json.ret !== 200 || !json.data) throw new Error();
    const d = json.data;
    return {
      location: [d.country, d.prov, d.city, d.area].filter(Boolean).join(" "),
      isp: d.isp || "Unknown",
      asn: "",
      source: "ip9",
    };
  } catch {}

  // 2. 国际备用源
  try {
    const res = await fetch(
      `http://ip-api.com/json/${ip}?fields=status,message,country,regionName,city,isp,as,org`,
      { signal: AbortSignal.timeout(3000) }
    );
    if (!res.ok) throw new Error();
    const d = await res.json();
    if (d.status !== "success") throw new Error();
    return {
      location: [d.country, d.regionName, d.city].filter(Boolean).join(" "),
      isp: d.isp || d.org || "Unknown",
      asn: d.as || "",
      source: "ip-api",
    };
  } catch {}

  // 3. Cloudflare 兜底
  const parts = [cf.country, cf.city].filter(Boolean);
  return {
    location: parts.length ? parts.join(" ") : "Unknown",
    isp: "Unknown",
    asn: cf.asn ? `AS${cf.asn}` : "",
    source: "cloudflare",
  };
}

/**
 * 安全 Base64 编码（兼容中文等特殊字符）
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
 * 发送 Telegram 通知（MarkdownV2）
 */
async function sendTG(env, title, fields = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const timeStr = new Date()
    .toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false,
    })
    .replace(/\//g, "-");

  // MarkdownV2 特殊字符转义
  const esc = (t) =>
    String(t || "").replace(/([_*\[\]()~`>#+=\-|{}.!])/g, "\\$1");

  const bodyLines = Object.entries(fields)
    .filter(([_, v]) => v)
    .map(([k, v]) => `${k} : ${esc(v)}`)
    .join("\n");

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
 * 生成前端管理页面
 */
function generateHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
  <title>节点订阅管理</title>
  <link rel="icon" href="https://img.helo.de5.net/1786604634282.ico" type="image/x-icon">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      margin: 0; padding: 0; background: #f0f2f5;
    }
    .container {
      max-width: 900px; margin: 20px auto; padding: 24px;
      background: #fff; border-radius: 16px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.08);
    }
    input, textarea, select, button {
      font-size: 14px; margin: 6px 0; padding: 11px 14px;
      border-radius: 10px; border: 1px solid #d9d9d9;
      width: 100%; box-sizing: border-box; transition: all 0.2s;
    }
    input:focus, textarea:focus, select:focus {
      outline: none; border-color: #4facfe;
      box-shadow: 0 0 0 3px rgba(79,172,254,0.15);
    }
    button {
      background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
      color: #fff; border: none; cursor: pointer; font-weight: 500;
    }
    button:hover:not(:disabled) { opacity: 0.92; transform: translateY(-1px); }
    button:disabled {
      background: #ccc; cursor: not-allowed; opacity: 0.7; transform: none;
    }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
    th, td { border: 1px solid #eee; padding: 10px 8px; text-align: center; }
    th { background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); color: #fff; }
    .copy-btn { background: #00c1ff; color: #fff; padding: 5px 10px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; }
    .edit-btn { background: #ffa500; color: #fff; }
    .delete-btn { background: #ff5c5c; color: #fff; }
    .logout-btn {
      background: linear-gradient(135deg, #ff6b6b 0%, #ee5a5a 100%);
      width: auto; padding: 8px 18px; border-radius: 20px; font-size: 13px;
      box-shadow: 0 4px 12px rgba(238,90,90,0.3); display: none; align-items: center;
    }
    .logout-btn:hover { box-shadow: 0 6px 16px rgba(238,90,90,0.4); }
    .pagination { margin-top: 14px; text-align: center; }
    .pagination button { width: auto; padding: 6px 12px; margin: 0 3px; border-radius: 8px; }
    .search-sort { margin-top: 12px; display: flex; gap: 10px; flex-wrap: wrap; }
    .search-sort * { flex: 1; min-width: 100px; }
    .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .header-row h2 { margin: 0; font-size: 22px; color: #1a1a1a; }
    .captcha-box { display: flex; align-items: center; gap: 12px; margin: 10px 0; }
    .captcha-question {
      background: #f5f7fa; border: 1px dashed #4facfe; border-radius: 10px;
      padding: 10px 16px; font-size: 18px; font-weight: 600; color: #333;
      min-width: 100px; text-align: center; user-select: none; letter-spacing: 2px;
    }
    .captcha-refresh {
      background: #e8f4ff; color: #4facfe; border: 1px solid #4facfe;
      width: auto; padding: 8px 12px; border-radius: 8px; font-size: 13px; cursor: pointer;
    }
    .captcha-refresh:hover { background: #4facfe; color: #fff; }
    @media (max-width: 600px) {
      .search-sort { flex-direction: column; }
      .container { margin: 12px; padding: 16px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-row">
      <h2>节点订阅管理</h2>
      <button id="logoutBtn" class="logout-btn">退出登录</button>
    </div>

    <!-- 登录区域 -->
    <div id="loginDiv">
      <label>管理员密码:</label>
      <input type="password" id="adminPassword" placeholder="请输入密码">

      <label>验证码:</label>
      <div class="captcha-box">
        <div class="captcha-question" id="captchaQuestion">0 + 0 = ?</div>
        <button type="button" class="captcha-refresh" id="refreshCaptcha">换一张</button>
      </div>
      <input type="text" id="captchaInput" placeholder="请输入计算结果" maxlength="4" autocomplete="off">

      <button id="loginBtn" disabled>登录</button>
    </div>

    <!-- 主功能区域 -->
    <div id="mainDiv" style="display:none;">
      <div class="search-sort">
        <input type="text" id="search" placeholder="搜索名称/Key">
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

      <label>订阅显示名称:</label>
      <input type="text" id="key" placeholder="如 node1">

      <label>订阅内容:</label>
      <textarea id="text" rows="5" placeholder="输入订阅节点内容"></textarea>

      <label>有效天数 (0 表示永久):</label>
      <input type="number" id="days" placeholder="例如 7">

      <button id="saveBtn">保存订阅</button>

      <h3 style="margin-top:24px;margin-bottom:8px;">已保存订阅列表</h3>
      <table>
        <thead>
          <tr>
            <th>名称</th>
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
    /* ---------- 全局状态 ---------- */
    let ADMIN_PASSWORD = '';
    let currentPage = 1;
    let currentSearch = '';
    let currentSort = 'displayName';
    let currentOrder = 'asc';
    let currentEditingKey = null;
    let captchaAnswer = 0;

    /* ---------- 无操作自动退出（5分钟） ---------- */
    const INACTIVITY_TIMEOUT = 5 * 60 * 1000;
    let inactivityTimer = null;

    function resetInactivityTimer() {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (!ADMIN_PASSWORD) return;
      inactivityTimer = setTimeout(() => doLogout(true), INACTIVITY_TIMEOUT);
    }

    function setupInactivityListeners() {
      ['mousemove','mousedown','keydown','touchstart','scroll','click'].forEach(evt => {
        document.addEventListener(evt, resetInactivityTimer, { passive: true });
      });
    }

    function doLogout(isTimeout = false) {
      sessionStorage.removeItem('adminPassword');
      ADMIN_PASSWORD = '';
      if (inactivityTimer) clearTimeout(inactivityTimer);

      document.getElementById('loginDiv').style.display = 'block';
      document.getElementById('mainDiv').style.display = 'none';
      document.getElementById('logoutBtn').style.display = 'none';
      document.getElementById('adminPassword').value = '';
      generateCaptcha();

      if (isTimeout) alert('已超过5分钟无操作，已自动退出登录');
    }

    /* ---------- 验证码 ---------- */
    function generateCaptcha() {
      const a = Math.floor(Math.random() * 9) + 1;
      const b = Math.floor(Math.random() * 9) + 1;
      const op = Math.random() > 0.5 ? '+' : '-';

      let question, answer;
      if (op === '+') {
        question = a + ' + ' + b + ' = ?';
        answer = a + b;
      } else {
        const max = Math.max(a, b);
        const min = Math.min(a, b);
        question = max + ' - ' + min + ' = ?';
        answer = max - min;
      }

      captchaAnswer = answer;
      document.getElementById('captchaQuestion').textContent = question;
      document.getElementById('captchaInput').value = '';
      document.getElementById('loginBtn').disabled = true;
    }

    function checkCaptcha() {
      const input = document.getElementById('captchaInput').value.trim();
      document.getElementById('loginBtn').disabled =
        !(input !== '' && Number(input) === captchaAnswer);
    }

    /* ---------- 页面初始化 ---------- */
    window.addEventListener('DOMContentLoaded', () => {
      generateCaptcha();
      setupInactivityListeners();

      document.getElementById('captchaInput').addEventListener('input', checkCaptcha);
      document.getElementById('refreshCaptcha').addEventListener('click', generateCaptcha);

      // 使用 sessionStorage：关闭浏览器/标签页后自动退出
      const saved = sessionStorage.getItem('adminPassword');
      if (saved) tryAutoLogin(saved);
    });

    async function tryAutoLogin(pw) {
      try {
        const resp = await fetch('/login?password=' + encodeURIComponent(pw));
        if (resp.status === 200) {
          ADMIN_PASSWORD = pw;
          showMainUI();
          loadKeyList(1);
          resetInactivityTimer();
        } else {
          sessionStorage.removeItem('adminPassword');
        }
      } catch {}
    }

    function showMainUI() {
      document.getElementById('loginDiv').style.display = 'none';
      document.getElementById('mainDiv').style.display = 'block';
      document.getElementById('logoutBtn').style.display = 'inline-flex';
    }

    /* ---------- 登录 ---------- */
    document.getElementById('loginBtn').addEventListener('click', async () => {
      const input = document.getElementById('captchaInput').value.trim();
      if (Number(input) !== captchaAnswer) {
        alert('验证码错误');
        generateCaptcha();
        return;
      }

      const pw = document.getElementById('adminPassword').value.trim();
      if (!pw) return alert('请输入密码');

      try {
        const resp = await fetch('/login?password=' + encodeURIComponent(pw));
        if (resp.status === 200) {
          ADMIN_PASSWORD = pw;
          sessionStorage.setItem('adminPassword', pw);
          showMainUI();
          loadKeyList(1);
          resetInactivityTimer();
        } else {
          alert('密码错误');
          generateCaptcha();
        }
      } catch {
        alert('登录失败，请检查网络');
        generateCaptcha();
      }
    });

    /* ---------- 退出登录 ---------- */
    document.getElementById('logoutBtn').addEventListener('click', () => {
      if (confirm('确定要退出登录吗？')) doLogout(false);
    });

    /* ---------- 搜索 / 排序 ---------- */
    document.getElementById('searchBtn').addEventListener('click', () => {
      currentSearch = document.getElementById('search').value.trim();
      currentSort = document.getElementById('sort').value;
      currentOrder = document.getElementById('order').value;
      loadKeyList(1);
      resetInactivityTimer();
    });

    /* ---------- 保存 / 更新 ---------- */
    document.getElementById('saveBtn').addEventListener('click', async () => {
      const displayName = document.getElementById('key').value.trim() || '未命名';
      const text = document.getElementById('text').value.trim();
      const days = parseInt(document.getElementById('days').value, 10) || 0;

      if (!text) return alert('请输入订阅内容');

      try {
        const url = currentEditingKey
          ? '/update?key=' + encodeURIComponent(currentEditingKey) +
            '&displayName=' + encodeURIComponent(displayName) +
            '&days=' + days +
            '&password=' + encodeURIComponent(ADMIN_PASSWORD)
          : '/save?displayName=' + encodeURIComponent(displayName) +
            '&days=' + days +
            '&password=' + encodeURIComponent(ADMIN_PASSWORD);

        const resp = await fetch(url, { method: 'POST', body: text });
        alert(await resp.text());

        currentEditingKey = null;
        document.getElementById('saveBtn').textContent = '保存订阅';
        ['key', 'text', 'days'].forEach(id => document.getElementById(id).value = '');

        loadKeyList(currentPage);
        resetInactivityTimer();
      } catch {
        alert('操作失败');
      }
    });

    /* ---------- 加载列表 ---------- */
    async function loadKeyList(page = 1) {
      if (!ADMIN_PASSWORD) return;
      currentPage = page;

      try {
        const resp = await fetch(
          '/list?page=' + page +
          '&search=' + encodeURIComponent(currentSearch) +
          '&sort=' + currentSort +
          '&order=' + currentOrder +
          '&password=' + encodeURIComponent(ADMIN_PASSWORD)
        );

        if (resp.status !== 200) {
          if (resp.status === 403) doLogout(false);
          return;
        }

        const data = await resp.json();
        const tbody = document.getElementById('keylist');
        tbody.innerHTML = '';

        data.items.forEach(item => {
          const tr = document.createElement('tr');
          tr.innerHTML =
            '<td>' + item.displayName + '</td>' +
            '<td>' + item.remainingDays + '</td>' +
            '<td><button class="copy-btn">复制</button></td>' +
            '<td><button class="copy-btn edit-btn">编辑</button></td>' +
            '<td><button class="copy-btn delete-btn">删除</button></td>';
          tbody.appendChild(tr);

          // 复制双重密钥链接
          tr.querySelector('.copy-btn').addEventListener('click', () => {
            const fullUrl = window.location.origin + '/get/' +
              encodeURIComponent(item.realKey) + '/' +
              encodeURIComponent(item.token);
            navigator.clipboard.writeText(fullUrl);
            alert('已复制双重密钥链接!');
            resetInactivityTimer();
          });

          tr.querySelector('.edit-btn').addEventListener('click', () => {
            editItem(item.realKey);
            resetInactivityTimer();
          });

          tr.querySelector('.delete-btn').addEventListener('click', () => {
            deleteKey(item.realKey);
            resetInactivityTimer();
          });
        });

        // 分页按钮
        const pageDiv = document.getElementById('pagination');
        pageDiv.innerHTML = '';
        for (let i = 1; i <= data.totalPages; i++) {
          const btn = document.createElement('button');
          btn.textContent = i;
          if (i === data.page) btn.disabled = true;
          btn.addEventListener('click', () => {
            loadKeyList(i);
            resetInactivityTimer();
          });
          pageDiv.appendChild(btn);
        }
      } catch {}
    }

    /* ---------- 编辑 ---------- */
    async function editItem(realKey) {
      const resp = await fetch(
        '/detail?key=' + encodeURIComponent(realKey) +
        '&password=' + encodeURIComponent(ADMIN_PASSWORD)
      );
      if (resp.status !== 200) return alert('获取详情失败');

      const item = await resp.json();
      document.getElementById('key').value = item.displayName || '';
      document.getElementById('text').value = item.content || '';
      document.getElementById('days').value = item.expire
        ? Math.max(0, Math.ceil((item.expire - Date.now()) / 86400000))
        : 0;

      currentEditingKey = realKey;
      document.getElementById('saveBtn').textContent = '更新订阅';
    }

    /* ---------- 删除 ---------- */
    async function deleteKey(key) {
      if (!confirm('确定删除?')) return;
      const resp = await fetch(
        '/delete?key=' + encodeURIComponent(key) +
        '&password=' + encodeURIComponent(ADMIN_PASSWORD),
        { method: 'POST' }
      );
      alert(await resp.text());
      loadKeyList(currentPage);
    }
  </script>
</body>
</html>`;
}
