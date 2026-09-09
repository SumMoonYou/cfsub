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
  <link rel="icon" href="data:image/png;base64,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" type="image/jpeg">
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
  <link rel="icon" href="data:image/png;base64,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" type="image/jpeg">
  <style>
    :root {
      --primary: #3b82f6;
      --primary-2: #2563eb;
      --bg: #eef2ff;
      --card: rgba(255,255,255,0.9);
      --text: #0f172a;
      --muted: #64748b;
      --line: #e2e8f0;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --shadow: 0 18px 50px rgba(15, 23, 42, 0.08);
      --radius: 20px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(59,130,246,0.18), transparent 28%),
        radial-gradient(circle at top right, rgba(99,102,241,0.14), transparent 24%),
        linear-gradient(180deg, #eef2ff 0%, #f8fafc 100%);
      color: var(--text);
      min-height: 100vh;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }

    .page {
      max-width: 980px;
      margin: 0 auto;
      padding: 24px 16px 40px;
    }

    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .brand-badge {
      width: 42px;
      height: 42px;
      border-radius: 14px;
      background: linear-gradient(135deg, #3b82f6, #6366f1);
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 16px;
      box-shadow: 0 10px 24px rgba(59,130,246,0.28);
    }

    .brand h1 {
      font-size: 1.35rem;
      font-weight: 800;
      letter-spacing: -0.02em;
    }

    .brand p {
      font-size: 12px;
      color: var(--muted);
      margin-top: 2px;
    }

    .logout-btn {
      border: none;
      background: linear-gradient(135deg, #fb7185, #ef4444);
      color: white;
      padding: 10px 16px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 10px 24px rgba(239,68,68,0.25);
      display: none;
    }

    .panel {
      background: var(--card);
      backdrop-filter: blur(16px);
      border: 1px solid rgba(255,255,255,0.7);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 22px;
      margin-bottom: 16px;
    }

    .panel-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 16px;
    }

    .panel-title h2 {
      font-size: 16px;
      font-weight: 700;
    }

    .panel-title span {
      font-size: 12px;
      color: var(--muted);
    }

    label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: #334155;
      margin: 14px 0 6px;
    }

    label:first-child { margin-top: 0; }

    input, textarea, select {
      width: 100%;
      padding: 13px 14px;
      border: 1.5px solid var(--line);
      border-radius: 14px;
      font-size: 15px;
      background: #fff;
      color: var(--text);
      transition: 0.2s ease;
      outline: none;
      -webkit-appearance: none;
    }

    input:focus, textarea:focus, select:focus {
      border-color: #60a5fa;
      box-shadow: 0 0 0 4px rgba(59,130,246,0.12);
    }

    textarea {
      min-height: 130px;
      resize: vertical;
    }

    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      padding: 13px 16px;
      border: none;
      border-radius: 14px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      transition: 0.2s ease;
    }

    .btn-primary {
      background: linear-gradient(135deg, #3b82f6, #2563eb);
      color: white;
      box-shadow: 0 12px 28px rgba(37,99,235,0.28);
      margin-top: 16px;
    }

    .btn-primary:hover { transform: translateY(-1px); }
    .btn-primary:active { transform: scale(0.98); }
    .btn-primary:disabled {
      background: #cbd5e1;
      box-shadow: none;
      cursor: not-allowed;
      transform: none;
    }

    .btn-soft {
      background: #eff6ff;
      color: #2563eb;
      border: 1px solid #bfdbfe;
    }

    .captcha-row {
      display: flex;
      gap: 10px;
      align-items: center;
    }

    .captcha-q {
      flex: 1;
      background: linear-gradient(135deg, #eff6ff, #f8fafc);
      border: 1.5px dashed #93c5fd;
      border-radius: 14px;
      padding: 12px;
      text-align: center;
      font-size: 18px;
      font-weight: 800;
      color: #1d4ed8;
      user-select: none;
    }

    .search-bar {
      display: grid;
      grid-template-columns: 1.6fr 1fr 1fr auto;
      gap: 10px;
    }

    .search-bar .btn { margin-top: 0; width: auto; min-width: 96px; }

    .table-wrap { overflow-x: auto; }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th {
      text-align: left;
      font-size: 12px;
      color: var(--muted);
      font-weight: 700;
      padding: 10px 8px;
      border-bottom: 1px solid var(--line);
    }

    td {
      padding: 14px 8px;
      border-bottom: 1px solid #f1f5f9;
      vertical-align: middle;
      font-size: 14px;
    }

    tr:last-child td { border-bottom: none; }

    .name-cell {
      font-weight: 700;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
    }

    .badge-ok {
      background: #ecfdf5;
      color: #059669;
    }

    .badge-warn {
      background: #fffbeb;
      color: #d97706;
    }

    .badge-dead {
      background: #fef2f2;
      color: #dc2626;
    }

    .badge-muted {
      background: #f8fafc;
      color: #64748b;
    }

    .actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .mini-btn {
      border: none;
      color: white;
      padding: 7px 10px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
    }

    .mini-copy { background: #0ea5e9; }
    .mini-edit { background: #f59e0b; }
    .mini-del  { background: #ef4444; }

    .mobile-list { display: none; }

    .node-card {
      background: linear-gradient(180deg, #ffffff, #f8fafc);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 14px;
      margin-bottom: 10px;
    }

    .node-card-top {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    }

    .node-card-title {
      font-size: 15px;
      font-weight: 800;
    }

    .node-card-meta {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }

    .pagination {
      display: flex;
      justify-content: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 16px;
    }

    .pagination button {
      min-width: 38px;
      height: 38px;
      border-radius: 12px;
      border: 1px solid var(--line);
      background: white;
      color: var(--text);
      cursor: pointer;
      font-weight: 700;
    }

    .pagination button:disabled {
      background: linear-gradient(135deg, #3b82f6, #2563eb);
      color: white;
      border-color: transparent;
    }

    .empty {
      text-align: center;
      color: var(--muted);
      padding: 36px 12px;
      font-size: 14px;
    }

    .login-wrap {
      max-width: 440px;
      margin: 40px auto 0;
    }

    .login-hero {
      text-align: center;
      margin-bottom: 18px;
    }

    .login-hero h2 {
      font-size: 1.5rem;
      font-weight: 800;
      margin-bottom: 6px;
    }

    .login-hero p {
      color: var(--muted);
      font-size: 14px;
    }

    @media (max-width: 760px) {
      .page { padding: 16px 12px 28px; }
      .brand h1 { font-size: 1.15rem; }
      .grid-2, .search-bar { grid-template-columns: 1fr; }
      .desktop-only { display: none; }
      .mobile-list { display: block; }
      .panel { padding: 16px; border-radius: 18px; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="topbar">
      <div class="brand">
        <div class="brand-badge">Node</div>
        <div>
          <h1>节点订阅管理</h1>
          <p>双重密钥 · 流量统计 · 安全下发</p>
        </div>
      </div>
      <button id="logoutBtn" class="logout-btn">退出登录</button>
    </div>

    <!-- 登录 -->
    <div id="loginDiv" class="login-wrap">
      <div class="login-hero">
        <h2>欢迎回来</h2>
        <p>请输入管理员密码与验证码后继续</p>
      </div>
      <div class="panel">
        <label>管理员密码</label>
        <input type="password" id="adminPassword" placeholder="请输入密码" autocomplete="current-password">

        <label>验证码</label>
        <div class="captcha-row">
          <div class="captcha-q" id="captchaQuestion">0 + 0 = ?</div>
          <button type="button" class="btn btn-soft" id="refreshCaptcha" style="width:auto;margin-top:0;padding:12px 14px;">换一张</button>
        </div>
        <input type="text" id="captchaInput" placeholder="请输入计算结果" maxlength="3" inputmode="numeric" autocomplete="off">

        <button id="loginBtn" class="btn btn-primary" disabled>登录管理后台</button>
      </div>
    </div>

    <!-- 主内容 -->
    <div id="mainDiv" style="display:none;">
      <div class="panel">
        <div class="panel-title">
          <h2>快速搜索</h2>
          <span>支持名称 / Key</span>
        </div>
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

      <div class="panel">
        <div class="panel-title">
          <h2 id="formTitle">新建订阅</h2>
          <span>支持到期时间与总流量</span>
        </div>

        <label>订阅显示名称</label>
        <input type="text" id="key" placeholder="例如：家用节点">

        <label>订阅内容</label>
        <textarea id="text" placeholder="粘贴订阅节点内容"></textarea>

        <div class="grid-2">
          <div>
            <label>有效天数（0 = 永久）</label>
            <input type="number" id="days" placeholder="例如 30" min="0">
          </div>
          <div>
            <label>总流量（GB，0 = 不限制）</label>
            <input type="number" id="traffic" placeholder="例如 100" min="0" step="0.1">
          </div>
        </div>

        <button id="saveBtn" class="btn btn-primary">保存订阅</button>
      </div>

      <div class="panel">
        <div class="panel-title">
          <h2>已保存订阅</h2>
          <span>点击复制可获取双重密钥链接</span>
        </div>

        <div class="table-wrap desktop-only">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>剩余天数</th>
                <th>总流量</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="keylist"></tbody>
          </table>
        </div>

        <div class="mobile-list" id="mobileList"></div>
        <div class="pagination" id="pagination"></div>
      </div>
    </div>
  </div>

  <script>
    let ADMIN_PASSWORD = '';
    let currentPage = 1;
    let currentSearch = '';
    let currentSort = 'displayName';
    let currentOrder = 'asc';
    let currentEditingKey = null;
    let captchaAnswer = 0;

    const INACTIVITY_TIMEOUT = 5 * 60 * 1000;
    let inactivityTimer = null;

    function resetInactivityTimer() {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (!ADMIN_PASSWORD) return;
      inactivityTimer = setTimeout(() => doLogout(true), INACTIVITY_TIMEOUT);
    }

    function setupInactivityListeners() {
      ['mousemove','mousedown','keydown','touchstart','scroll','click'].forEach(e => {
        document.addEventListener(e, resetInactivityTimer, { passive: true });
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

    function generateCaptcha() {
      const a = Math.floor(Math.random() * 9) + 1;
      const b = Math.floor(Math.random() * 9) + 1;
      let question, answer;
      if (Math.random() > 0.5) {
        question = a + ' + ' + b + ' = ?';
        answer = a + b;
      } else {
        const max = Math.max(a, b), min = Math.min(a, b);
        question = max + ' - ' + min + ' = ?';
        answer = max - min;
      }
      captchaAnswer = answer;
      document.getElementById('captchaQuestion').textContent = question;
      document.getElementById('captchaInput').value = '';
      document.getElementById('loginBtn').disabled = true;
    }

    function checkCaptcha() {
      const val = document.getElementById('captchaInput').value.trim();
      document.getElementById('loginBtn').disabled = !(val !== '' && Number(val) === captchaAnswer);
    }

    function dayBadge(text) {
      if (text === '已过期') return '<span class="badge badge-dead">已过期</span>';
      if (text === '∞') return '<span class="badge badge-ok">永久</span>';
      const n = Number(text);
      if (!Number.isNaN(n) && n <= 7) return '<span class="badge badge-warn">' + text + ' 天</span>';
      return '<span class="badge badge-ok">' + text + ' 天</span>';
    }

    function trafficBadge(gb) {
      if (!gb || Number(gb) <= 0) return '<span class="badge badge-muted">不限</span>';
      return '<span class="badge badge-ok">' + gb + ' GB</span>';
    }

    window.addEventListener('DOMContentLoaded', () => {
      generateCaptcha();
      setupInactivityListeners();
      document.getElementById('captchaInput').addEventListener('input', checkCaptcha);
      document.getElementById('refreshCaptcha').addEventListener('click', generateCaptcha);
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

    document.getElementById('loginBtn').addEventListener('click', async () => {
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

    document.getElementById('logoutBtn').addEventListener('click', () => {
      if (confirm('确定要退出登录吗？')) doLogout(false);
    });

    document.getElementById('searchBtn').addEventListener('click', () => {
      currentSearch = document.getElementById('search').value.trim();
      currentSort = document.getElementById('sort').value;
      currentOrder = document.getElementById('order').value;
      loadKeyList(1);
      resetInactivityTimer();
    });

    document.getElementById('saveBtn').addEventListener('click', async () => {
      const displayName = document.getElementById('key').value.trim() || '未命名';
      const text = document.getElementById('text').value.trim();
      const days = parseInt(document.getElementById('days').value, 10) || 0;
      const traffic = parseFloat(document.getElementById('traffic').value) || 0;
      if (!text) return alert('请输入订阅内容');

      try {
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

        currentEditingKey = null;
        document.getElementById('saveBtn').textContent = '保存订阅';
        document.getElementById('formTitle').textContent = '新建订阅';
        ['key','text','days','traffic'].forEach(id => document.getElementById(id).value = '');
        loadKeyList(currentPage);
        resetInactivityTimer();
      } catch {
        alert('操作失败');
      }
    });

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
            const tr = document.createElement('tr');
            tr.innerHTML =
              '<td class="name-cell">' + item.displayName + '</td>' +
              '<td>' + dayBadge(item.remainingDays) + '</td>' +
              '<td>' + trafficBadge(item.totalTrafficGB) + '</td>' +
              '<td><div class="actions">' +
                '<button class="mini-btn mini-copy">复制</button>' +
                '<button class="mini-btn mini-edit">编辑</button>' +
                '<button class="mini-btn mini-del">删除</button>' +
              '</div></td>';
            tbody.appendChild(tr);

            tr.querySelector('.mini-copy').onclick = () => copyLink(item);
            tr.querySelector('.mini-edit').onclick = () => { editItem(item.realKey); resetInactivityTimer(); };
            tr.querySelector('.mini-del').onclick = () => { deleteKey(item.realKey); resetInactivityTimer(); };

            const card = document.createElement('div');
            card.className = 'node-card';
            card.innerHTML =
              '<div class="node-card-top">' +
                '<div class="node-card-title">' + item.displayName + '</div>' +
              '</div>' +
              '<div class="node-card-meta">' +
                dayBadge(item.remainingDays) +
                trafficBadge(item.totalTrafficGB) +
              '</div>' +
              '<div class="actions">' +
                '<button class="mini-btn mini-copy">复制链接</button>' +
                '<button class="mini-btn mini-edit">编辑</button>' +
                '<button class="mini-btn mini-del">删除</button>' +
              '</div>';
            mobileList.appendChild(card);

            card.querySelector('.mini-copy').onclick = () => copyLink(item);
            card.querySelector('.mini-edit').onclick = () => { editItem(item.realKey); resetInactivityTimer(); };
            card.querySelector('.mini-del').onclick = () => { deleteKey(item.realKey); resetInactivityTimer(); };
          });
        }

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

    function copyLink(item) {
      const url = location.origin + '/get/' + encodeURIComponent(item.realKey) + '/' + encodeURIComponent(item.token);
      navigator.clipboard.writeText(url)
        .then(() => alert('已复制双重密钥链接'))
        .catch(() => prompt('请手动复制：', url));
      resetInactivityTimer();
    }

    async function editItem(realKey) {
      const resp = await fetch('/detail?key=' + encodeURIComponent(realKey) + '&password=' + encodeURIComponent(ADMIN_PASSWORD));
      if (resp.status !== 200) return alert('获取详情失败');

      const item = await resp.json();
      document.getElementById('key').value = item.displayName || '';
      document.getElementById('text').value = item.content || '';
      document.getElementById('days').value = item.expire
        ? Math.max(0, Math.ceil((item.expire - Date.now()) / 86400000))
        : 0;
      document.getElementById('traffic').value = item.totalTraffic
        ? (item.totalTraffic / 1073741824).toFixed(1)
        : 0;

      currentEditingKey = realKey;
      document.getElementById('saveBtn').textContent = '更新订阅';
      document.getElementById('formTitle').textContent = '编辑订阅';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    async function deleteKey(key) {
      if (!confirm('确定删除该订阅？')) return;
      const resp = await fetch('/delete?key=' + encodeURIComponent(key) + '&password=' + encodeURIComponent(ADMIN_PASSWORD), { method: 'POST' });
      alert(await resp.text());
      loadKeyList(currentPage);
    }
  </script>
</body>
</html>`;
}
