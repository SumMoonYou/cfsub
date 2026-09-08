/**
 * ============================================================
 * Cloudflare Worker - 节点订阅管理系统
 * ============================================================
 *
 * 【功能概览】
 *   1. 节点订阅的新增、更新、删除、列表、详情
 *   2. 通过 /get/{key}/{token} 下发订阅内容（双重密钥保护）
 *   3. 仅允许中国大陆（CN）IP 访问订阅接口
 *   4. 客户端 User-Agent 白名单校验
 *   5. 同一 Key + 同一 IP 60 秒访问频率限制
 *   6. 所有管理操作与订阅访问均可推送 Telegram 通知
 *   7. 前端管理页面支持：
 *        - 算术验证码登录
 *        - 关闭浏览器/标签页自动退出（sessionStorage）
 *        - 5 分钟无操作自动退出
 *        - 响应式布局（手机端卡片，桌面端表格）
 *   8. 统一简约错误页面（与主题同色系）
 *   9. 返回订阅时附带 Subscription-Userinfo（到期时间 + 总流量）
 *
 * 【环境变量】
 *   NODES_KV              必须绑定（KV 命名空间）
 *   ADMIN_PASSWORD        可选，默认 "admin123"
 *   TELEGRAM_BOT_TOKEN    可选，为空则不发送任何通知
 *   TELEGRAM_CHAT_ID      可选，为空则不发送任何通知
 *   DEFAULT_EXPIRE_DAYS   可选，默认 0（新建时未填天数使用此值，0=永久）
 *   PAGE_SIZE             可选，默认 10（列表每页显示条数）
 *
 * 【订阅链接格式】
 *   https://你的域名/get/{12位key}/{16位token}
 *
 * 【Subscription-Userinfo 响应头格式】
 *   upload=0; download=0; total=107374182400; expire=1735689600
 *   - upload / download : 已用流量（字节），当前固定为 0
 *   - total             : 总流量配额（字节）
 *   - expire            : 到期 Unix 时间戳（秒）
 * ============================================================
 */

export default {
  /**
   * Worker 入口函数
   * @param {Request} request  请求对象
   * @param {object}  env      环境变量与绑定（KV、密码、TG 等）
   */
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const kv = env.NODES_KV;

      // ================================================================
      // 一、读取环境变量并设置默认值
      // ================================================================
      const ADMIN_PASSWORD = env.ADMIN_PASSWORD || "admin123";                 // 管理员密码
      const TG_TOKEN = env.TELEGRAM_BOT_TOKEN || "";                           // Telegram Bot Token
      const TG_CHAT_ID = env.TELEGRAM_CHAT_ID || "";                           // Telegram 聊天 ID
      const DEFAULT_EXPIRE_DAYS = parseInt(env.DEFAULT_EXPIRE_DAYS, 10) || 0;  // 默认有效天数（0=永久）
      const PAGE_SIZE = parseInt(env.PAGE_SIZE, 10) || 10;                     // 列表每页条数

      // ================================================================
      // 二、路径白名单校验
      // 只允许以下路径，其余一律返回统一错误页
      // ================================================================
      const allowedPaths = [
        "/",        // 管理后台首页
        "/login",   // 登录验证
        "/save",    // 新增订阅
        "/update",  // 更新订阅
        "/delete",  // 删除订阅
        "/list",    // 订阅列表
        "/detail",  // 订阅详情
      ];
      if (!allowedPaths.includes(path) && !path.startsWith("/get/")) {
        return errorPage(404, "页面不存在");
      }

      // 必须绑定 NODES_KV，否则无法存储数据
      if (!kv) {
        return errorPage(500, "未绑定 NODES_KV");
      }

      // ================================================================
      // 三、获取客户端基础信息（用于日志与 Telegram 通知）
      // ================================================================
      const ua = request.headers.get("user-agent") || "未知设备";
      const ip = (
        request.headers.get("cf-connecting-ip") ||   // Cloudflare 提供的真实 IP
        request.headers.get("x-forwarded-for") ||    // 兼容其他反向代理
        "未知IP"
      )
        .split(",")[0]  // 取第一个 IP（防止多级代理）
        .trim();

      // 解析 IP 地理位置（国内源优先，失败则回退）
      const ipInfo = await getIPLocation(ip, request.cf || {});
      const cfLocation = ipInfo.location;

      // ================================================================
      // 四、订阅获取接口：/get/{key}/{token}
      // 必须同时提供正确的 key 和 token 才能获取订阅内容
      // ================================================================
      if (path.startsWith("/get/")) {
        // 解析路径参数：/get/xxx/yyy → ["xxx", "yyy"]
        const parts = path.slice(5).split("/").filter(Boolean);

        // 路径格式必须是 /get/{key}/{token}
        if (parts.length < 2) {
          return errorPage(400, "缺少密钥");
        }

        const realKey = parts[0];          // 订阅唯一标识（12 位）
        const providedToken = parts[1];    // 用户提供的 token（16 位）

        // 允许的客户端 UA 关键词（不区分大小写）
        const uaList = [
          "clash", "quantumult", "surge", "shadowrocket", "v2ray",
          "sing-box", "loon", "v2rayng", "nekobox", "tbox", "passwall",
        ];
        const clientUA = ua.toLowerCase();

        // ---------- 4.1 地区限制：仅允许中国大陆 ----------
        if ((request.cf?.country || "") !== "CN") {
          return errorPage(403, "当前区域不支持访问");
        }

        // ---------- 4.2 UA 白名单检测 ----------
        if (!uaList.some((x) => clientUA.includes(x))) {
          // 非法客户端访问，推送告警通知
          await sendTG(TG_TOKEN, TG_CHAT_ID, "❌ 订阅访问被拦截（非法客户端）", {
            "提取 🔑": `${realKey.slice(0, 4)}****${realKey.slice(-4)}`,
            "访问位置": cfLocation,
            "IP 地址": ip,
            "客户端 UA": ua,
          });
          return errorPage(403, "未授权客户端");
        }

        // ---------- 4.3 访问频率限制（同 Key + 同 IP 60 秒只能访问一次） ----------
        const limitKey = `limit:${realKey}:${ip}`;
        if (await kv.get(limitKey)) {
          return errorPage(429, "请求过于频繁，请60秒后再试");
        }
        // 写入限制标记，60 秒后自动过期
        await kv.put(limitKey, "1", { expirationTtl: 60 });

        // ---------- 4.4 读取订阅数据 ----------
        const value = await kv.get(realKey);
        if (!value) {
          return errorPage(404, "订阅不存在");
        }

        let item;
        try {
          item = JSON.parse(value);
        } catch {
          return errorPage(500, "订阅数据异常");
        }

        // ---------- 4.5 验证 token（双重密钥核心校验） ----------
        if (!item.token || item.token !== providedToken) {
          await sendTG(TG_TOKEN, TG_CHAT_ID, "❌ 订阅访问被拦截（Token错误）", {
            "提取 🔑": `${realKey.slice(0, 4)}****${realKey.slice(-4)}`,
            "访问位置": cfLocation,
            "IP 地址": ip,
            "客户端 UA": ua,
          });
          return errorPage(403, "密钥错误");
        }

        // ---------- 4.6 检查订阅是否已过期 ----------
        if (item.expire && Date.now() > item.expire) {
          await sendTG(TG_TOKEN, TG_CHAT_ID, "⏳ 订阅已过期", {
            "订阅名称": item.displayName,
            "提取 🔑": `${item.realKey.slice(0, 4)}****${item.realKey.slice(-4)}`,
            "访问位置": cfLocation,
          });
          return errorPage(403, "订阅已过期");
        }

        // ---------- 4.7 正常访问，发送通知 ----------
        await sendTG(TG_TOKEN, TG_CHAT_ID, "🧭 订阅节点被访问", {
          "订阅名称": item.displayName,
          "提取 🔑": `${item.realKey.slice(0, 4)}****${item.realKey.slice(-4)}`,
          "访问位置": ipInfo.location,
          "运营商": ipInfo.isp,
          "ASN": ipInfo.asn,
          "IP 地址": ip,
          "客户端 UA": ua,
        });

        // ---------- 4.8 组装 Subscription-Userinfo 响应头 ----------
        // 格式：upload=0; download=0; total=字节数; expire=Unix时间戳（秒）
        // 方案 A：已用流量固定为 0，只返回总流量和到期时间
        const totalBytes = item.totalTraffic || 0;                    // 总流量（字节）
        const expireTs = item.expire ? Math.floor(item.expire / 1000) : 0; // 转为秒级时间戳

        let userinfo = `upload=0; download=0; total=${totalBytes}`;
        if (expireTs > 0) {
          userinfo += `; expire=${expireTs}`;
        }

        // ---------- 4.9 返回 Base64 编码的订阅内容 + 流量信息头 ----------
        return new Response(safeBtoa(item.content), {
          headers: {
            "Content-Type": "text/plain;charset=UTF-8",
            "Cache-Control": "no-store",                 // 禁止缓存，保证内容实时
            "Subscription-Userinfo": userinfo,           // 流量与到期信息（主流客户端支持）
            "Profile-Update-Interval": "24",             // 建议客户端 24 小时更新一次
          },
        });
      }

      // ================================================================
      // 五、首页：返回管理后台 HTML 页面
      // ================================================================
      if (path === "/") {
        return new Response(generateHTML(), {
          headers: { "Content-Type": "text/html;charset=UTF-8" },
        });
      }

      // ================================================================
      // 六、登录验证接口
      // ================================================================
      const password = url.searchParams.get("password");

      if (path === "/login") {
        const ok = password === ADMIN_PASSWORD;

        // 无论成功失败都推送通知，方便监控异常登录尝试
        await sendTG(
          TG_TOKEN,
          TG_CHAT_ID,
          ok ? "🔓 管理员登录成功" : "🔒 管理员登录失败",
          {
            [ok ? "登录位置" : "尝试位置"]: cfLocation,
            "IP 地址": ip,
            "客户端 UA": ua,
          }
        );

        // 登录接口返回纯文本，方便前端 JS 判断 status
        return new Response(ok ? "登录成功" : "密码错误", {
          status: ok ? 200 : 403,
        });
      }

      // ================================================================
      // 七、管理接口统一鉴权
      // 除 /login 和 /get/ 外，所有管理接口都必须携带正确密码
      // ================================================================
      if (password !== ADMIN_PASSWORD) {
        return errorPage(403, "越权访问被拒绝");
      }

      // ================================================================
      // 八、获取单个订阅详情（编辑时使用）
      // ================================================================
      if (path === "/detail") {
        const key = url.searchParams.get("key") || "";
        const value = await kv.get(key);

        return value
          ? new Response(value, {
              headers: { "Content-Type": "application/json;charset=UTF-8" },
            })
          : errorPage(404, "订阅不存在");
      }

      // ================================================================
      // 九、新增或更新订阅
      // ================================================================
      if (path === "/save" || path === "/update") {
        // 订阅原始内容从请求体读取
        const content = await request.text();
        if (!content) {
          return errorPage(400, "缺少内容");
        }

        let key = url.searchParams.get("key");
        let old = null;

        // 更新模式：必须提供已存在的 key
        if (path === "/update" && key) {
          const oldVal = await kv.get(key);
          if (!oldVal) {
            return errorPage(404, "订阅不存在");
          }
          old = JSON.parse(oldVal);
        } else {
          // 新增模式：生成 12 位随机 key
          key = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
        }

        // 生成或保留 16 位 token
        // 更新时保留原 token，避免已有订阅链接失效
        const token =
          old?.token || crypto.randomUUID().replace(/-/g, "").slice(0, 16);

        const now = Date.now();

        // 优先使用前端传的天数，否则使用环境变量默认值
        const daysParam = parseInt(url.searchParams.get("days"), 10);
        const finalDays = Number.isNaN(daysParam)
          ? DEFAULT_EXPIRE_DAYS
          : daysParam;

        // 总流量（GB）→ 字节
        // 1 GB = 1024³ = 1073741824 字节
        const trafficGB = parseFloat(url.searchParams.get("traffic")) || 0;
        const totalTraffic =
          trafficGB > 0
            ? Math.floor(trafficGB * 1073741824)
            : old?.totalTraffic || 0;

        // 组装要存入 KV 的对象
        const item = {
          realKey: key,                                                     // 唯一标识
          token: token,                                                     // 双重密钥
          displayName: url.searchParams.get("displayName") || "未命名",     // 显示名称
          content: content,                                                 // 订阅原始内容
          // 天数 > 0 时设置过期时间，否则保持原过期时间或永久
          expire:
            finalDays > 0
              ? now + finalDays * 86400000
              : old?.expire || null,
          totalTraffic: totalTraffic,                                       // 总流量（字节）
          created: old?.created || now,                                     // 创建时间
        };

        // 写入 KV
        await kv.put(key, JSON.stringify(item));

        // 推送操作通知
        await sendTG(
          TG_TOKEN,
          TG_CHAT_ID,
          path === "/save" ? "🟢 新增订阅节点" : "🟡 更新订阅节点",
          {
            "订阅名称": item.displayName,
            "提取 🔑": key,
            "Token": token,
            "总流量": trafficGB > 0 ? trafficGB + " GB" : "未设置",
          }
        );

        return new Response(path === "/save" ? "保存成功" : "更新成功");
      }

      // ================================================================
      // 十、删除订阅
      // ================================================================
      if (path === "/delete") {
        const key = url.searchParams.get("key") || "";
        const oldVal = await kv.get(key);
        const old = oldVal ? JSON.parse(oldVal) : null;

        await kv.delete(key);

        await sendTG(TG_TOKEN, TG_CHAT_ID, "🔴 删除订阅节点", {
          "订阅名称": old?.displayName || "未知",
          "提取 🔑": key,
        });

        return new Response("删除成功");
      }

      // ================================================================
      // 十一、订阅列表（支持分页与关键词搜索）
      // ================================================================
      if (path === "/list") {
        const page = parseInt(url.searchParams.get("page"), 10) || 1;
        const search = (url.searchParams.get("search") || "").toLowerCase();

        // 最多读取 1000 条（Cloudflare KV list 限制）
        const list = await kv.list({ limit: 1000 }).catch(() => ({ keys: [] }));
        // 并行读取所有 value，提高性能
        const values = await Promise.all(
          list.keys.map((k) => kv.get(k.name))
        );

        // 转换为前端需要的数据结构
        let items = values
          .filter(Boolean)
          .map((v) => JSON.parse(v))
          .map((i) => ({
            displayName: i.displayName || "未命名",
            realKey: i.realKey,
            token: i.token || "",
            created: i.created || 0,
            // 计算剩余天数：已过期 / 永久 / 具体天数
            remainingDays: i.expire
              ? Date.now() > i.expire
                ? "已过期"
                : Math.ceil((i.expire - Date.now()) / 86400000)
              : "∞",
            // 显示总流量（GB），保留 1 位小数
            totalTrafficGB: i.totalTraffic
              ? (i.totalTraffic / 1073741824).toFixed(1)
              : "0",
          }));

        // 关键词过滤（匹配名称或 key）
        if (search) {
          items = items.filter(
            (i) =>
              i.displayName.toLowerCase().includes(search) ||
              i.realKey.toLowerCase().includes(search)
          );
        }

        // 默认按显示名称排序
        items.sort((a, b) => a.displayName.localeCompare(b.displayName));

        // 使用 PAGE_SIZE 进行分页裁剪
        return new Response(
          JSON.stringify({
            page,
            totalPages: Math.max(1, Math.ceil(items.length / PAGE_SIZE)),
            items: items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
          }),
          {
            headers: { "Content-Type": "application/json;charset=UTF-8" },
          }
        );
      }

      // 默认响应（理论上不会走到这里）
      return new Response("OK");
    } catch (e) {
      // 捕获所有未处理异常，返回统一错误页，避免 Worker 直接崩溃
      return errorPage(500, "服务器错误：" + e.message);
    }
  },
};

/* ============================================================
 * 统一错误页面
 * 简约居中卡片风格，与管理后台同色系
 *
 * @param {number} status   HTTP 状态码（如 403、404、500）
 * @param {string} message  错误提示文案
 * @returns {Response}      HTML 错误页响应
 * ============================================================ */
function errorPage(status, message) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <title>${status} - ${message}</title>
  <link rel="icon" href="https://img.helo.de5.net/1788870746264.jpg" type="image/jpeg">
  <style>
    :root {
      --primary: #3b82f6;
      --bg: #f1f5f9;
      --card: #ffffff;
      --text: #1e293b;
      --text-secondary: #64748b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      -webkit-font-smoothing: antialiased;
    }
    .card {
      background: var(--card);
      border-radius: 16px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.06);
      padding: 40px 32px;
      text-align: center;
      max-width: 380px;
      width: 100%;
    }
    .code {
      font-size: 64px;
      font-weight: 700;
      color: var(--primary);
      line-height: 1;
      margin-bottom: 12px;
      letter-spacing: -2px;
    }
    .msg {
      font-size: 16px;
      color: var(--text-secondary);
      margin-bottom: 28px;
      line-height: 1.5;
    }
    .btn {
      display: inline-block;
      background: linear-gradient(135deg, #3b82f6, #2563eb);
      color: white;
      text-decoration: none;
      padding: 12px 28px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      box-shadow: 0 4px 14px rgba(37,99,235,0.3);
      transition: transform 0.15s, opacity 0.15s;
    }
    .btn:active {
      transform: scale(0.97);
      opacity: 0.9;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="code">${status}</div>
    <div class="msg">${message}</div>
    <a class="btn" href="/">返回首页</a>
  </div>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html;charset=UTF-8",
      "Cache-Control": "no-store",
    },
  });
}

/* ============================================================
 * 工具函数区域
 * ============================================================ */

/**
 * IP 地理位置解析
 * 优先级：
 *   1. ip9.com.cn（国内优先，速度较快）
 *   2. ip-api.com（国际备用）
 *   3. Cloudflare 自带的 request.cf 信息（最终兜底）
 *
 * @param {string} ip  客户端 IP
 * @param {object} cf  Cloudflare request.cf 对象
 * @returns {Promise<object>}  { location, isp, asn, source }
 */
async function getIPLocation(ip, cf = {}) {
  // ---------- 1. 优先使用国内源 ----------
  try {
    const res = await fetch(`https://ip9.com.cn/get?ip=${ip}`, {
      headers: { "User-Agent": "Cloudflare-Worker" },
      signal: AbortSignal.timeout(3000), // 3 秒超时
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
  } catch {
    // 忽略错误，继续尝试下一个源
  }

  // ---------- 2. 国际备用源 ----------
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
  } catch {
    // 忽略错误，继续使用 Cloudflare 信息
  }

  // ---------- 3. Cloudflare 兜底 ----------
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
 * 先对字符串进行 URI 编码，再转 Base64，
 * 避免中文等特殊字符导致 btoa 失败
 *
 * @param {string} str  原始字符串
 * @returns {string}    Base64 编码结果
 */
function safeBtoa(str) {
  try {
    return btoa(
      encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p) =>
        String.fromCharCode(parseInt(p, 16))
      )
    );
  } catch {
    // 极端情况下回退到普通 btoa
    return btoa(str);
  }
}

/**
 * 发送 Telegram 通知
 * 如果 token 或 chatId 为空，直接跳过，不影响主流程
 *
 * @param {string} token   Bot Token
 * @param {string} chatId  聊天 ID
 * @param {string} title   消息标题
 * @param {object} fields  键值对内容（自动过滤空值）
 */
async function sendTG(token, chatId, title, fields = {}) {
  // 未配置 Telegram 时静默跳过
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

  // 发送消息（失败时静默忽略，避免影响主业务）
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
      disable_notification: true, // 静默通知，不打断用户
    }),
  }).catch(() => {});
}

/**
 * 生成前端管理页面 HTML
 * 包含登录、验证码、列表、新增/编辑、流量设置、响应式布局等全部前端逻辑
 */
function generateHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <title>节点订阅管理</title>
  <!-- 网站图标 -->
  <link rel="icon" href="https://img.helo.de5.net/1788870746264.jpg" type="image/jpeg">
  <style>
    /* -------------------- CSS 变量（方便统一调整主题色） -------------------- */
    :root {
      --primary: #3b82f6;
      --primary-dark: #2563eb;
      --bg: #f1f5f9;
      --card: #ffffff;
      --text: #1e293b;
      --text-secondary: #64748b;
      --border: #e2e8f0;
      --radius: 14px;
      --shadow: 0 4px 20px rgba(0,0,0,0.06);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }

    .container {
      max-width: 860px;
      margin: 0 auto;
      padding: 16px;
    }

    /* -------------------- 头部 -------------------- */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 4px 20px;
    }
    .header h1 {
      font-size: 1.35rem;
      font-weight: 700;
    }
    .logout-btn {
      background: linear-gradient(135deg, #f87171, #ef4444);
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(239,68,68,0.25);
      display: none;
      align-items: center;
    }
    .logout-btn:active { transform: scale(0.97); }

    /* -------------------- 卡片容器 -------------------- */
    .card {
      background: var(--card);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 20px;
      margin-bottom: 16px;
    }

    /* -------------------- 表单元素 -------------------- */
    label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-secondary);
      margin-bottom: 6px;
      margin-top: 14px;
    }
    label:first-child { margin-top: 0; }

    input, textarea, select {
      width: 100%;
      padding: 12px 14px;
      border: 1.5px solid var(--border);
      border-radius: 10px;
      font-size: 15px;
      background: #fff;
      transition: border-color 0.2s, box-shadow 0.2s;
      -webkit-appearance: none;
    }
    input:focus, textarea:focus, select:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(59,130,246,0.15);
    }
    textarea { resize: vertical; min-height: 110px; }

    /* -------------------- 主按钮 -------------------- */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      padding: 13px;
      border: none;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      margin-top: 16px;
    }
    .btn-primary {
      background: linear-gradient(135deg, #3b82f6, #2563eb);
      color: white;
      box-shadow: 0 4px 14px rgba(37,99,235,0.3);
    }
    .btn-primary:active { transform: scale(0.98); }
    .btn-primary:disabled {
      background: #cbd5e1;
      box-shadow: none;
      cursor: not-allowed;
    }

    /* -------------------- 验证码区域 -------------------- */
    .captcha-row {
      display: flex;
      gap: 10px;
      align-items: center;
      margin-top: 6px;
    }
    .captcha-q {
      flex: 1;
      background: #f8fafc;
      border: 1.5px dashed #93c5fd;
      border-radius: 10px;
      padding: 12px;
      text-align: center;
      font-size: 18px;
      font-weight: 700;
      color: #1e40af;
      user-select: none;
      letter-spacing: 1px;
    }
    .captcha-refresh {
      background: #eff6ff;
      color: var(--primary);
      border: 1.5px solid #93c5fd;
      padding: 12px 14px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
    }
    .captcha-refresh:active { background: #dbeafe; }

    /* -------------------- 搜索栏 -------------------- */
    .search-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 4px;
    }
    .search-bar input { flex: 2; min-width: 140px; }
    .search-bar select { flex: 1; min-width: 100px; }
    .search-bar .btn { flex: 1; min-width: 90px; margin-top: 0; padding: 12px; }

    /* -------------------- 列表标题 -------------------- */
    .list-header {
      font-size: 16px;
      font-weight: 600;
      margin: 8px 0 12px;
    }

    /* -------------------- 桌面端表格 -------------------- */
    .desktop-table {
      width: 100%;
      border-collapse: collapse;
      display: table;
    }
    .desktop-table th {
      background: #f8fafc;
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 600;
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
    }
    .desktop-table td {
      padding: 12px;
      border-bottom: 1px solid var(--border);
      font-size: 14px;
      vertical-align: middle;
    }
    .desktop-table tr:last-child td { border-bottom: none; }

    /* -------------------- 手机端卡片列表 -------------------- */
    .mobile-cards { display: none; }
    .node-card {
      background: #f8fafc;
      border-radius: 12px;
      padding: 14px 16px;
      margin-bottom: 10px;
      border: 1px solid var(--border);
    }
    .node-card-title {
      font-weight: 600;
      font-size: 15px;
      margin-bottom: 6px;
    }
    .node-card-meta {
      font-size: 13px;
      color: var(--text-secondary);
      margin-bottom: 12px;
    }
    .node-card-actions {
      display: flex;
      gap: 8px;
    }
    .node-card-actions button {
      flex: 1;
      padding: 8px;
      border: none;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      color: white;
    }
    .btn-copy { background: #0ea5e9; }
    .btn-edit { background: #f59e0b; }
    .btn-del  { background: #ef4444; }

    /* -------------------- 分页 -------------------- */
    .pagination {
      display: flex;
      justify-content: center;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 16px;
    }
    .pagination button {
      min-width: 36px;
      height: 36px;
      border: 1.5px solid var(--border);
      background: white;
      border-radius: 8px;
      font-size: 14px;
      cursor: pointer;
      color: var(--text);
    }
    .pagination button:disabled {
      background: var(--primary);
      color: white;
      border-color: var(--primary);
    }

    /* -------------------- 空状态 -------------------- */
    .empty {
      text-align: center;
      padding: 40px 20px;
      color: var(--text-secondary);
      font-size: 14px;
    }

    /* -------------------- 响应式适配 -------------------- */
    @media (max-width: 640px) {
      .container { padding: 12px; }
      .header h1 { font-size: 1.2rem; }
      .card { padding: 16px; }
      .desktop-table { display: none; }   /* 手机隐藏表格 */
      .mobile-cards { display: block; }   /* 手机显示卡片 */
      .search-bar { flex-direction: column; }
      .search-bar input,
      .search-bar select,
      .search-bar .btn { width: 100%; min-width: 0; }
    }
    @media (min-width: 641px) {
      .mobile-cards { display: none; }
      .desktop-table { display: table; }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- 页面头部 -->
    <div class="header">
      <h1>节点订阅管理</h1>
      <button id="logoutBtn" class="logout-btn">退出登录</button>
    </div>

    <!-- ==================== 登录区域 ==================== -->
    <div id="loginDiv" class="card">
      <label>管理员密码</label>
      <input type="password" id="adminPassword" placeholder="请输入密码" autocomplete="current-password">

      <label>验证码</label>
      <div class="captcha-row">
        <div class="captcha-q" id="captchaQuestion">0 + 0 = ?</div>
        <button type="button" class="captcha-refresh" id="refreshCaptcha">换一张</button>
      </div>
      <input type="text" id="captchaInput" placeholder="请输入计算结果" maxlength="3" inputmode="numeric" autocomplete="off">

      <button id="loginBtn" class="btn btn-primary" disabled>登 录</button>
    </div>

    <!-- ==================== 主功能区域（登录后显示） ==================== -->
    <div id="mainDiv" style="display:none;">
      <!-- 搜索与排序 -->
      <div class="card">
        <div class="search-bar">
          <input type="text" id="search" placeholder="搜索名称或 Key">
          <select id="sort">
            <option value="displayName">按名称</option>
            <option value="remainingDays">按剩余天数</option>
          </select>
          <select id="order">
            <option value="asc">升序</option>
            <option value="desc">降序</option>
          </select>
          <button id="searchBtn" class="btn btn-primary">搜索</button>
        </div>
      </div>

      <!-- 新增 / 编辑表单 -->
      <div class="card">
        <label>订阅显示名称</label>
        <input type="text" id="key" placeholder="例如：家用节点">

        <label>订阅内容</label>
        <textarea id="text" placeholder="粘贴订阅节点内容"></textarea>

        <label>有效天数（0 = 永久）</label>
        <input type="number" id="days" placeholder="例如 30" min="0">

        <label>总流量（GB，0 = 不限制）</label>
        <input type="number" id="traffic" placeholder="例如 100" min="0" step="0.1">

        <button id="saveBtn" class="btn btn-primary">保存订阅</button>
      </div>

      <!-- 订阅列表 -->
      <div class="card">
        <div class="list-header">已保存的订阅</div>

        <!-- 桌面端表格 -->
        <table class="desktop-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>剩余天数</th>
              <th>总流量</th>
              <th style="width:90px">操作</th>
            </tr>
          </thead>
          <tbody id="keylist"></tbody>
        </table>

        <!-- 手机端卡片列表 -->
        <div class="mobile-cards" id="mobileList"></div>

        <!-- 分页按钮 -->
        <div class="pagination" id="pagination"></div>
      </div>
    </div>
  </div>

  <script>
    /* ============================================================
     * 前端全局状态
     * ============================================================ */
    let ADMIN_PASSWORD = '';          // 当前登录密码
    let currentPage = 1;              // 当前页码
    let currentSearch = '';           // 当前搜索关键词
    let currentSort = 'displayName';  // 当前排序字段
    let currentOrder = 'asc';         // 当前排序方向
    let currentEditingKey = null;     // 正在编辑的 key（null 表示新增模式）
    let captchaAnswer = 0;            // 当前验证码正确答案

    /* ---------- 无操作自动退出（5 分钟） ---------- */
    const INACTIVITY_TIMEOUT = 5 * 60 * 1000;
    let inactivityTimer = null;

    /** 重置无操作计时器 */
    function resetInactivityTimer() {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (!ADMIN_PASSWORD) return;
      inactivityTimer = setTimeout(() => doLogout(true), INACTIVITY_TIMEOUT);
    }

    /** 监听用户操作事件，用于重置计时器 */
    function setupInactivityListeners() {
      ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'].forEach(e => {
        document.addEventListener(e, resetInactivityTimer, { passive: true });
      });
    }

    /**
     * 执行退出登录
     * @param {boolean} isTimeout  是否为超时自动退出
     */
    function doLogout(isTimeout = false) {
      sessionStorage.removeItem('adminPassword');
      ADMIN_PASSWORD = '';
      if (inactivityTimer) clearTimeout(inactivityTimer);

      document.getElementById('loginDiv').style.display = 'block';
      document.getElementById('mainDiv').style.display = 'none';
      document.getElementById('logoutBtn').style.display = 'none';
      document.getElementById('adminPassword').value = '';
      generateCaptcha();

      if (isTimeout) {
        alert('已超过5分钟无操作，已自动退出登录');
      }
    }

    /* ---------- 验证码相关 ---------- */

    /** 生成新的算术验证码（加减法，结果为正数） */
    function generateCaptcha() {
      const a = Math.floor(Math.random() * 9) + 1;
      const b = Math.floor(Math.random() * 9) + 1;
      let question, answer;

      if (Math.random() > 0.5) {
        question = a + ' + ' + b + ' = ?';
        answer = a + b;
      } else {
        // 保证结果为正数
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

    /** 检查验证码是否正确，正确才启用登录按钮 */
    function checkCaptcha() {
      const val = document.getElementById('captchaInput').value.trim();
      document.getElementById('loginBtn').disabled =
        !(val !== '' && Number(val) === captchaAnswer);
    }

    /* ---------- 页面初始化 ---------- */
    window.addEventListener('DOMContentLoaded', () => {
      generateCaptcha();
      setupInactivityListeners();

      document.getElementById('captchaInput').addEventListener('input', checkCaptcha);
      document.getElementById('refreshCaptcha').addEventListener('click', generateCaptcha);

      // 尝试使用 sessionStorage 中的密码自动登录
      // （关闭浏览器后 sessionStorage 会自动清除）
      const saved = sessionStorage.getItem('adminPassword');
      if (saved) tryAutoLogin(saved);
    });

    /** 静默自动登录 */
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

    /** 显示主界面，隐藏登录框 */
    function showMainUI() {
      document.getElementById('loginDiv').style.display = 'none';
      document.getElementById('mainDiv').style.display = 'block';
      document.getElementById('logoutBtn').style.display = 'inline-flex';
    }

    /* ---------- 登录按钮点击 ---------- */
    document.getElementById('loginBtn').addEventListener('click', async () => {
      // 二次校验验证码，防止绕过
      if (Number(document.getElementById('captchaInput').value.trim()) !== captchaAnswer) {
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
          sessionStorage.setItem('adminPassword', pw); // 使用 sessionStorage
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

    /* ---------- 退出登录按钮 ---------- */
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

    /* ---------- 保存 / 更新订阅 ---------- */
    document.getElementById('saveBtn').addEventListener('click', async () => {
      const displayName = document.getElementById('key').value.trim() || '未命名';
      const text = document.getElementById('text').value.trim();
      const days = parseInt(document.getElementById('days').value, 10) || 0;
      const traffic = parseFloat(document.getElementById('traffic').value) || 0;

      if (!text) return alert('请输入订阅内容');

      try {
        // 根据是否处于编辑状态选择不同接口
        const url = currentEditingKey
          ? '/update?key=' + encodeURIComponent(currentEditingKey) +
            '&displayName=' + encodeURIComponent(displayName) +
            '&days=' + days +
            '&traffic=' + traffic +
            '&password=' + encodeURIComponent(ADMIN_PASSWORD)
          : '/save?displayName=' + encodeURIComponent(displayName) +
            '&days=' + days +
            '&traffic=' + traffic +
            '&password=' + encodeURIComponent(ADMIN_PASSWORD);

        const resp = await fetch(url, { method: 'POST', body: text });
        alert(await resp.text());

        // 重置表单
        currentEditingKey = null;
        document.getElementById('saveBtn').textContent = '保存订阅';
        ['key', 'text', 'days', 'traffic'].forEach(id => document.getElementById(id).value = '');

        loadKeyList(currentPage);
        resetInactivityTimer();
      } catch {
        alert('操作失败');
      }
    });

    /* ---------- 加载订阅列表 ---------- */
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
        const mobileList = document.getElementById('mobileList');
        tbody.innerHTML = '';
        mobileList.innerHTML = '';

        if (data.items.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4" class="empty">暂无订阅</td></tr>';
          mobileList.innerHTML = '<div class="empty">暂无订阅</div>';
        } else {
          data.items.forEach(item => {
            const trafficText = item.totalTrafficGB > 0 ? item.totalTrafficGB + ' GB' : '不限';

            // ---------- 桌面端表格行 ----------
            const tr = document.createElement('tr');
            tr.innerHTML =
              '<td><strong>' + item.displayName + '</strong></td>' +
              '<td>' + item.remainingDays + '</td>' +
              '<td>' + trafficText + '</td>' +
              '<td style="white-space:nowrap">' +
                '<button class="btn-copy" style="padding:5px 8px;border:none;border-radius:6px;color:#fff;font-size:12px;margin-right:4px;cursor:pointer">复制</button>' +
                '<button class="btn-edit" style="padding:5px 8px;border:none;border-radius:6px;color:#fff;font-size:12px;margin-right:4px;cursor:pointer">编辑</button>' +
                '<button class="btn-del" style="padding:5px 8px;border:none;border-radius:6px;color:#fff;font-size:12px;cursor:pointer">删除</button>' +
              '</td>';
            tbody.appendChild(tr);

            tr.querySelector('.btn-copy').onclick = () => copyLink(item);
            tr.querySelector('.btn-edit').onclick = () => { editItem(item.realKey); resetInactivityTimer(); };
            tr.querySelector('.btn-del').onclick = () => { deleteKey(item.realKey); resetInactivityTimer(); };

            // ---------- 手机端卡片 ----------
            const card = document.createElement('div');
            card.className = 'node-card';
            card.innerHTML =
              '<div class="node-card-title">' + item.displayName + '</div>' +
              '<div class="node-card-meta">剩余：' + item.remainingDays + '　|　流量：' + trafficText + '</div>' +
              '<div class="node-card-actions">' +
                '<button class="btn-copy">复制链接</button>' +
                '<button class="btn-edit">编辑</button>' +
                '<button class="btn-del">删除</button>' +
              '</div>';
            mobileList.appendChild(card);

            card.querySelector('.btn-copy').onclick = () => copyLink(item);
            card.querySelector('.btn-edit').onclick = () => { editItem(item.realKey); resetInactivityTimer(); };
            card.querySelector('.btn-del').onclick = () => { deleteKey(item.realKey); resetInactivityTimer(); };
          });
        }

        // ---------- 渲染分页按钮 ----------
        const pageDiv = document.getElementById('pagination');
        pageDiv.innerHTML = '';
        for (let i = 1; i <= data.totalPages; i++) {
          const btn = document.createElement('button');
          btn.textContent = i;
          if (i === data.page) btn.disabled = true;
          btn.onclick = () => { loadKeyList(i); resetInactivityTimer(); };
          pageDiv.appendChild(btn);
        }
      } catch {}
    }

    /* ---------- 复制双重密钥订阅链接 ---------- */
    function copyLink(item) {
      const url = location.origin + '/get/' +
        encodeURIComponent(item.realKey) + '/' +
        encodeURIComponent(item.token);

      navigator.clipboard.writeText(url)
        .then(() => alert('已复制双重密钥链接'))
        .catch(() => prompt('请手动复制：', url));

      resetInactivityTimer();
    }

    /* ---------- 编辑指定订阅 ---------- */
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
      // 字节转 GB 回填到表单
      document.getElementById('traffic').value = item.totalTraffic
        ? (item.totalTraffic / 1073741824).toFixed(1)
        : 0;

      currentEditingKey = realKey;
      document.getElementById('saveBtn').textContent = '更新订阅';
      // 滚动到表单顶部，方便编辑
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    /* ---------- 删除指定订阅 ---------- */
    async function deleteKey(key) {
      if (!confirm('确定删除该订阅？')) return;

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
