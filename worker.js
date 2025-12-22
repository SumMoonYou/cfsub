// --- 1. 配置与题库 ---
// 验证题库：用户首次使用时需正确回答才能开始咨询，防止机器人骚扰
const QUESTION_BANK = [
  // 数学问题
  { question: "5 + 5 = ?", options: ["10", "15", "8"], answer: "10" },
  { question: "3 * 3 = ?", options: ["6", "9", "12"], answer: "9" },
  { question: "15 - 5 = ?", options: ["10", "5", "12"], answer: "10" },
  { question: "12 / 4 = ?", options: ["3", "4", "6"], answer: "3" },
  { question: "100 - 37 = ?", options: ["63", "72", "75"], answer: "63" },
  { question: "2 * 6 = ?", options: ["12", "15", "14"], answer: "12" },
  { question: "9 + 7 = ?", options: ["16", "15", "17"], answer: "16" },
  { question: "100 / 25 = ?", options: ["4", "3", "2"], answer: "4" },
  { question: "50 + 25 = ?", options: ["75", "80", "70"], answer: "75" },
  { question: "21 * 3 = ?", options: ["63", "72", "60"], answer: "63" },

  // 生活常识
  { question: "雪是什么颜色的？", options: ["白色", "红色", "黑色"], answer: "白色" },
  { question: "一年有几个季节？", options: ["4个", "2个", "12个"], answer: "4个" },
  { question: "红灯停，什么灯行？", options: ["绿灯", "黄灯", "蓝灯"], answer: "绿灯" },
  { question: "人类的平均体温是多少？", options: ["36.5°C", "37°C", "38°C"], answer: "37°C" },
  { question: "地球上最常见的气体是什么？", options: ["氮气", "氧气", "二氧化碳"], answer: "氮气" },
  { question: "水的沸点是多少摄氏度？", options: ["100°C", "90°C", "50°C"], answer: "100°C" },
  { question: "水的冰点是多少摄氏度？", options: ["0°C", "5°C", "10°C"], answer: "0°C" },
  { question: "人体的血液大约由多少水分组成？", options: ["55%", "60%", "50%"], answer: "55%" },
  { question: "牛奶的主要成分是什么？", options: ["水", "糖", "脂肪"], answer: "水" },
  { question: "空气的主要成分是什么？", options: ["氮气", "氧气", "二氧化碳"], answer: "氮气" },

  // 交通规则
  { question: "红灯停，什么灯行？", options: ["绿灯", "黄灯", "蓝灯"], answer: "绿灯" },
  { question: "行驶中，遇到红灯时应该怎么办？", options: ["停车等待", "加速通过", "按喇叭"], answer: "停车等待" },
  { question: "在高速公路上，最大车速是多少？", options: ["120公里/小时", "100公里/小时", "80公里/小时"], answer: "120公里/小时" },
  { question: "在城市道路上，最小车速是多少？", options: ["30公里/小时", "20公里/小时", "40公里/小时"], answer: "30公里/小时" },
  { question: "遇到黄色闪烁灯时，应该怎么做？", options: ["减速慢行", "停车", "继续前进"], answer: "减速慢行" },
  { question: "通过交叉路口时，应该注意什么？", options: ["看左看右", "不看车", "不看行人"], answer: "看左看右" },
  { question: "在交叉路口的停车标志下，应该做什么？", options: ["停车", "加速通过", "慢行通过"], answer: "停车" },
  { question: "遇到交通事故，应该首先做什么？", options: ["报警", "检查伤员", "拍照"], answer: "报警" },
  { question: "如果警察示意停车，应该怎么做？", options: ["停车", "继续行驶", "按喇叭"], answer: "停车" },
  { question: "在没有交通标志的路口，应该怎样行驶？", options: ["优先通行", "等候他车通过", "加速通过"], answer: "等候他车通过" },

  // 地理问题
  { question: "太阳系中最小的行星是什么？", options: ["水星", "火星", "金星"], answer: "水星" },
  { question: "地球上最大的岛屿是哪个？", options: ["格陵兰岛", "新几内亚岛", "马尔代夫"], answer: "格陵兰岛" },
  { question: "世界上最深的海洋是哪个？", options: ["太平洋", "印度洋", "大西洋"], answer: "太平洋" },
  { question: "世界上最长的山脉是什么？", options: ["安第斯山脉", "喜马拉雅山脉", "阿尔卑斯山脉"], answer: "安第斯山脉" },
  { question: "冰岛位于哪个大洋？", options: ["大西洋", "太平洋", "印度洋"], answer: "大西洋" },
  { question: "月亮离地球有多远？", options: ["38万公里", "40万公里", "39万公里"], answer: "38万公里" },
  { question: "地球上最常见的气体是什么？", options: ["氮气", "氧气", "二氧化碳"], answer: "氮气" },
  { question: "地球的直径大约是多少公里？", options: ["12742公里", "12000公里", "14000公里"], answer: "12742公里" },
  { question: "地球上有多少个大洋？", options: ["5个", "4个", "6个"], answer: "5个" },
  { question: "地球的最大海洋是什么？", options: ["太平洋", "大西洋", "印度洋"], answer: "太平洋" },

  // 科学常识
  { question: "光速大约是多少？", options: ["30万公里/秒", "20万公里/秒", "10万公里/秒"], answer: "30万公里/秒" },
  { question: "声音在空气中的传播速度大约是多少？", options: ["340米/秒", "100米/秒", "1000米/秒"], answer: "340米/秒" },
  { question: "植物通过什么作用制造氧气？", options: ["光合作用", "呼吸作用", "蒸腾作用"], answer: "光合作用" },
  { question: "指南针的 N 极指向哪个方向？", options: ["北方", "南方", "西方"], answer: "北方" },
  { question: "干冰是哪种气体的固体形态？", options: ["二氧化碳", "氧气", "氢气"], answer: "二氧化碳" },
  { question: "电灯泡是谁发明的？", options: ["爱迪生", "贝尔", "特斯拉"], answer: "爱迪生" },
  { question: "钻石的主要成分是什么元素？", options: ["碳", "硅", "硫"], answer: "碳" },
  { question: "人体最大的器官是什么？", options: ["皮肤", "肝脏", "肺"], answer: "皮肤" },
  { question: "哪种金属在常温下是液态的？", options: ["汞（水银）", "铝", "铜"], answer: "汞（水银）" },
  { question: "酸雨主要是由哪种气体引起的？", options: ["二氧化硫", "氧气", "氮气"], answer: "二氧化硫" },

  // 历史文化
  { question: "四大发明不包括哪一项？", options: ["电报", "造纸术", "火药"], answer: "电报" },
  { question: "《西游记》中的唐僧共有几个徒弟？", options: ["3个", "4个", "2个"], answer: "3个" },
  { question: "“床前明月光”的下一句是什么？", options: ["疑是地上霜", "举头望明月", "低头思故乡"], answer: "疑是地上霜" },
  { question: "战国七雄不包括以下哪个国家？", options: ["晋国", "秦国", "齐国"], answer: "晋国" },
  { question: "万里长城的主要功能是什么？", options: ["军事防御", "交通运输", "旅游观光"], answer: "军事防御" },
  { question: "中国历史上第一个皇帝是谁？", options: ["秦始皇", "汉武帝", "唐太宗"], answer: "秦始皇" },
  { question: "奥林匹克发源于哪个国家？", options: ["希腊", "意大利", "美国"], answer: "希腊" },
  { question: "文艺复兴时期的《蒙娜丽莎》是谁的作品？", options: ["达芬奇", "梵高", "毕加索"], answer: "达芬奇" },
  { question: "被称为“乐圣”的音乐家是谁？", options: ["贝多芬", "莫扎特", "肖邦"], answer: "贝多芬" },
  { question: "莎士比亚是哪国的文学家？", options: ["英国", "法国", "德国"], answer: "英国" },

  // 生物与自然
  { question: "企鹅主要生活在地球的哪一端？", options: ["南极", "北极", "赤道"], answer: "南极" },
  { question: "世界上跑得最快的陆地动物是什么？", options: ["猎豹", "狮子", "羚羊"], answer: "猎豹" },
  { question: "哪种动物被称为“沙漠之舟”？", options: ["骆驼", "马", "驴"], answer: "骆驼" },
  { question: "蝴蝶的一生不经历哪个阶段？", options: ["胎生", "幼虫", "蛹"], answer: "胎生" },
  { question: "壁虎在遇到危险时会切断身体的哪个部位？", options: ["尾巴", "脚", "头"], answer: "尾巴" },
  { question: "大熊猫最喜欢的食物是什么？", options: ["竹子", "苹果", "香蕉"], answer: "竹子" },
  { question: "蝙蝠属于哪类动物？", options: ["哺乳动物", "鸟类", "爬行动物"], answer: "哺乳动物" },
  { question: "世界上最高的树是什么？", options: ["红杉", "松树", "杨树"], answer: "红杉" },
  { question: "蝉依靠什么发出声音？", options: ["腹部的鸣肌", "嘴巴", "翅膀摩擦"], answer: "腹部的鸣肌" },
  { question: "哪种花被称为“花中之王”？", options: ["牡丹", "玫瑰", "荷花"], answer: "牡丹" },

  // 逻辑与趣味
  { question: "1斤棉花和1斤铁哪个重？", options: ["一样重", "铁重", "棉花重"], answer: "一样重" },
  { question: "3个苹果，你拿走了2个，你现在有几个苹果？", options: ["2个", "1个", "3个"], answer: "2个" },
  { question: "一个正方形有4个角，切掉1个角还剩几个角？", options: ["5个", "3个", "4个"], answer: "5个" },
  { question: "冰变成水后，体积会发生什么变化？", options: ["变小", "变大", "不变"], answer: "变小" },
  { question: "24小时内，时针绕表盘转几圈？", options: ["2圈", "1圈", "24圈"], answer: "2圈" },
  { question: "如果今天星期五，那么3天后是星期几？", options: ["星期一", "星期日", "星期二"], answer: "星期一" },
  { question: "世界上最小的鸟是什么鸟？", options: ["蜂鸟", "麻雀", "燕子"], answer: "蜂鸟" },
  { question: "哪个月份天数最少？", options: ["2月", "1月", "4月"], answer: "2月" },
  { question: "人的脊椎骨共有多少块？", options: ["26块", "33块", "24块"], answer: "26块" },
  { question: "彩虹从外到内第一种颜色是什么？", options: ["红色", "紫色", "绿色"], answer: "红色" }
];

export default {
  /**
   * Worker 入口函数：分发 Webhook 请求
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 路径：/registerWebhook -> 用于初始化 Webhook 配置
    if (url.pathname === "/registerWebhook") return await handleRegisterWebhook(request, env);
    
    // 环境变量基础检查
    if (!env.BOT_TOKEN || !env.SUPERGROUP_ID || !env.TOPIC_MAP) return new Response("Config Error");
    if (request.method !== "POST") return new Response("OK");

    let update;
    try { update = await request.json(); } catch (e) { return new Response("OK"); }

    // 处理 Inline Keyboard 按钮点击回调
    if (update.callback_query) {
      await handleCallback(update.callback_query, env);
      return new Response("OK");
    }

    const msg = update.message;
    if (!msg) return new Response("OK");

    // 识别消息流向：私聊 -> 转发至群；群回复 -> 转发至用户
    if (msg.chat && msg.chat.type === "private") {
      ctx.waitUntil(handlePrivate(msg, env, ctx));
    } 
    else if (msg.chat && String(msg.chat.id) === String(env.SUPERGROUP_ID)) {
      if (msg.message_thread_id) ctx.waitUntil(handleAdminReply(msg, env, ctx));
    }
    return new Response("OK");
  }
};

/**
 * 逻辑 A：处理用户私聊消息
 * 实现：验证拦截、专属话题路由、随机延迟转发、回执自删
 */
async function handlePrivate(msg, env, ctx) {
  const userId = msg.chat.id;
  const isAdmin = env.ADMIN_ID && String(userId) === String(env.ADMIN_ID);

  // 1. 管理员逻辑保持不变
  if (isAdmin) {
    if (msg.text === "/start") {
      return await tgCall(env, "sendMessage", { chat_id: userId, text: "🔧 <b>管理模式已激活</b>\n请前往群里面处理用户消息。", parse_mode: "HTML" });
    }else{
      return await tgCall(env, "sendMessage", { chat_id: userId, text: "请勿在此发消息，如需处理请前往群里面。", parse_mode: "HTML" });
    }
  }

  // 2. 处理普通用户的 /start 指令
  if (msg.text === "/start") {
    // 状态 A：黑名单
    const isBanned = await env.TOPIC_MAP.get(`ban:${userId}`);
    if (isBanned) {
      return await tgCall(env, "sendMessage", { 
        chat_id: userId, 
        text: "🚫 <b>系统提示</b>\n您的账号已被禁止咨询，请联系管理员。", 
        parse_mode: "HTML" 
      });
    }

    // 状态 B：已验证用户
    const isVerified = await env.TOPIC_MAP.get(`v:${userId}`);
    if (isVerified) {
      return await tgCall(env, "sendMessage", { 
        chat_id: userId, 
        text: "✅ <b>验证已生效</b>\n您现在可以直接发送消息，管理员看到后会第一时间回复您。", 
        parse_mode: "HTML" 
      });
    }

    // 状态 C：新用户（发起验证挑战）
    return await sendChallenge(userId, env);
  }

  // 正常消息处理流程（验证拦截等）
  if (await env.TOPIC_MAP.get(`ban:${userId}`)) return; 
  if (!(await env.TOPIC_MAP.get(`v:${userId}`))) return await sendChallenge(userId, env);

  // 3. 专属话题管理：确保用户在群组中有对应的 Thread
  let rec = await env.TOPIC_MAP.get(`u:${userId}`, { type: "json" });
  if (!rec) {
    const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") || `用户_${userId}`;
    const res = await tgCall(env, "createForumTopic", { chat_id: env.SUPERGROUP_ID, name: `${name.substring(0, 15)}` });
    if (res.ok) {
      rec = { thread_id: res.result.message_thread_id.toString() };
      await env.TOPIC_MAP.put(`u:${userId}`, JSON.stringify(rec));      // 用户ID -> 话题ID
      await env.TOPIC_MAP.put(`t:${rec.thread_id}`, userId.toString()); // 话题ID -> 用户ID
    }
  }

  // --- 4. 关键改进：人为制造发送间隔 ---
  // 产生 500ms 到 2500ms 的随机延迟，用于打散多图连发（Media Group）的并发请求
  await new Promise(r => setTimeout(r, 500 + Math.floor(Math.random() * 2000)));

  // 5. 转发用户原始消息至群内对应话题
  const fRes = await sendBot(msg, env.SUPERGROUP_ID, rec.thread_id, env);
  
  if (fRes.ok) {
    // A. 更新群内的汇总卡片（仅首条消息强提醒管理员）
    ctx.waitUntil(triggerNotification(msg.from, rec.thread_id, env, getPreview(msg), fRes.result.message_id));

    // B. 向用户发送私聊回执（限流：60秒内只发一次提示，防刷屏）
    const rateLimitKey = `tip_lock:${userId}`;
    if (!(await env.TOPIC_MAP.get(rateLimitKey))) {
      await env.TOPIC_MAP.put(rateLimitKey, "true", { expirationTtl: 60 });
      const tipRes = await tgCall(env, "sendMessage", { chat_id: userId, text: "✅ <b>已发送</b>", parse_mode: "HTML" });
      if (tipRes.ok) {
        ctx.waitUntil((async () => {
          await new Promise(r => setTimeout(r, 2000));
          await tgCall(env, "deleteMessage", { chat_id: userId, message_id: tipRes.result.message_id });
        })());
      }
    }
  }
}

/**
 * 逻辑 B：更新汇总话题中的卡片
 * 实现：首发提醒管理员，续发静默更新，并发下防多卡片生成
 */
async function triggerNotification(from, userThreadId, env, preview, lastId) {
  const userId = from.id;
  const cardKey = `c:${userId}`;

  // 增加微小避让延迟，防止并发 Worker 同时读取 KV 产生“卡片不存在”的假象
  await new Promise(r => setTimeout(r, Math.floor(Math.random() * 500)));

  // 获取汇总话题 ID，不存在则初始化
  let todoId = await env.TOPIC_MAP.get("sys:todo_id");
  if (!todoId) {
    const res = await tgCall(env, "createForumTopic", { chat_id: env.SUPERGROUP_ID, name: "📬 新消息" });
    if (res.ok) { 
        todoId = res.result.message_thread_id.toString(); 
        await env.TOPIC_MAP.put("sys:todo_id", todoId); 
    }
  }

  const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || "用户";
  const safeName = name.replace(/[<>]/g, "");
  
  // 查询 KV 中是否已有该用户的有效卡片 ID
  let cardId = await env.TOPIC_MAP.get(cardKey);

  // 构建卡片正文
  let text = `🎯 <b>新消息提醒</b>\n\n👤 <b>用户</b>: ${safeName}\n`;
  if (from.username) text += `🆔 <b>账号</b>: @${from.username}\n`;
  else text += `🆔 <b>ID</b>: <code>${userId}</code>\n`;
  text += `💬 <b>内容</b>: ${preview.replace(/[<>]/g, "")}\n\n`;

  // 仅在首次创建卡片时进行艾特（@管理员）
  if (cardId) {
    text += `🔔 状态: [追加消息]`;
  } else {
    const adminMention = env.ADMIN_ID ? `<a href="tg://user?id=${env.ADMIN_ID}">@管理员</a>` : "<b>管理员</b>";
    text += `📢 呼叫 ${adminMention} [待处理]`;
  }

  // 拼接消息跳转链接
  const cleanId = env.SUPERGROUP_ID.toString().replace("-100", "");
  const jumpUrl = `https://t.me/c/${cleanId}/${lastId}?thread=${userThreadId}`;
  
  // 构建按钮组
  const kb = { inline_keyboard: [
    [{ text: "🚀 跳转话题", url: jumpUrl }, ...(from.username ? [{ text: "👤 资料", url: `https://t.me/${from.username}` }] : [])],
    [{ text: "🗑️ 忽略卡片", callback_data: `del:${userId}` }]
  ]};

  // 尝试编辑现有卡片
  if (cardId) {
    const edit = await tgCall(env, "editMessageText", { chat_id: env.SUPERGROUP_ID, message_id: Number(cardId), text, parse_mode: "HTML", reply_markup: kb });
    if (edit.ok) return;
  }

  // 若卡片不存在或已被手动删除，则创建新卡片
  const res = await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: todoId ? Number(todoId) : undefined, text, parse_mode: "HTML", reply_markup: kb });
  if (res.ok) await env.TOPIC_MAP.put(cardKey, res.result.message_id.toString());
}

/**
 * 逻辑 C：管理员在客服群回复
 * 实现：/ban 封禁指令、/unban 解封、自动删除对应汇总卡片
 */
async function handleAdminReply(msg, env, ctx) {
  const tid = msg.message_thread_id.toString();
  if (tid === await env.TOPIC_MAP.get("sys:todo_id")) return; // 汇总话题内的普通交流不转发
  
  const uid = await env.TOPIC_MAP.get(`t:${tid}`);
  if (!uid) return;

  const cmd = msg.text?.trim();
  
  // 封禁处理
  if (cmd === "/ban") {
    await env.TOPIC_MAP.put(`ban:${uid}`, "1");
    return await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: Number(tid), text: "🚫 <b>用户已封禁</b>", parse_mode: "HTML" });
  }
  // 解封处理
  if (cmd === "/unban") {
    await env.TOPIC_MAP.delete(`ban:${uid}`);
    return await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: Number(tid), text: "✅ <b>用户已解封</b>", parse_mode: "HTML" });
  }

  // 管理员一旦回复，意味着正在处理该用户，自动销毁“汇总话题”中的提醒卡片
  const cid = await env.TOPIC_MAP.get(`c:${uid}`);
  if (cid) { 
    await tgCall(env, "deleteMessage", { chat_id: env.SUPERGROUP_ID, message_id: Number(cid) }); 
    await env.TOPIC_MAP.delete(`c:${uid}`); 
  }

  // 转发给目标用户
  await sendBot(msg, uid, null, env);
}

/**
 * 通用转发函数
 * 支持：文字、多尺寸图片、视频、贴纸、语音、文件
 */
async function sendBot(msg, target, thread, env) {
  const c = { chat_id: target, message_thread_id: thread ? Number(thread) : undefined };
  if (msg.text) return await tgCall(env, "sendMessage", { ...c, text: msg.text });
  if (msg.photo) return await tgCall(env, "sendPhoto", { ...c, photo: msg.photo.pop().file_id, caption: msg.caption });
  if (msg.video) return await tgCall(env, "sendVideo", { ...c, video: msg.video.file_id, caption: msg.caption });
  if (msg.sticker) return await tgCall(env, "sendSticker", { ...c, sticker: msg.sticker.file_id });
  if (msg.voice) return await tgCall(env, "sendVoice", { ...c, voice: msg.voice.file_id });
  if (msg.document) return await tgCall(env, "sendDocument", { ...c, document: msg.document.file_id, caption: msg.caption });
  return { ok: false };
}

/**
 * 逻辑 D：处理按钮交互回调
 */
async function handleCallback(query, env) {
  const data = query.data;
  
  // 删除卡片
  if (data.startsWith("del:")) {
    await tgCall(env, "deleteMessage", { chat_id: env.SUPERGROUP_ID, message_id: query.message.message_id });
    await env.TOPIC_MAP.delete(`c:${data.split(":")[1]}`);
  } 
  // 处理验证题目点击
  else if (data.startsWith("v:")) {
    const [_, cid, ans] = data.split(":");
    const correct = await env.TOPIC_MAP.get(`chal:${cid}`);
    
    // 无论对错，题目一经点击立即从 KV 中销毁，防重试
    await env.TOPIC_MAP.delete(`chal:${cid}`); 

    if (correct && ans === correct) {
      await env.TOPIC_MAP.put(`v:${query.from.id}`, "1", { expirationTtl: 2592000 }); // 验证有效期 30 天
      await tgCall(env, "editMessageText", { chat_id: query.from.id, message_id: query.message.message_id, text: "✅ <b>验证通过！</b>", parse_mode: "HTML" });
    } else {
      await tgCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: "❌ 验证失败，请重新回答", show_alert: true });
      await sendChallenge(query.from.id, env, query.message.message_id); // 刷新题目
    }
  }
}

/**
 * 发送/刷新验证题
 */
async function sendChallenge(uid, env, editId = null) {
  const quiz = QUESTION_BANK[Math.floor(Math.random() * QUESTION_BANK.length)];
  const id = Math.random().toString(36).substring(2, 10);
  await env.TOPIC_MAP.put(`chal:${id}`, quiz.answer, { expirationTtl: 300 });
  const kb = { inline_keyboard: [quiz.options.map(o => ({ text: o, callback_data: `v:${id}:${o}` }))] };
  const text = `🛡 <b>身份验证</b>\n请选择正确答案以继续：\n\n问题：<b>${quiz.question}</b>`;
  if (editId) await tgCall(env, "editMessageText", { chat_id: uid, message_id: editId, text, parse_mode: "HTML", reply_markup: kb });
  else await tgCall(env, "sendMessage", { chat_id: uid, text, parse_mode: "HTML", reply_markup: kb });
}

/**
 * 辅助：获取预览摘要
 */
function getPreview(msg) {
  if (msg.text) return msg.text.substring(0, 30);
  if (msg.sticker) return "发送了贴纸 " + (msg.sticker.emoji || "");
  if (msg.photo) return "[图片消息]";
  return "[媒体消息]";
}

/**
 * 辅助：注册 Webhook 及配置菜单指令
 */
async function handleRegisterWebhook(request, env) {
  const domain = `https://${new URL(request.url).hostname}`;
  
  // 1. 注册 Webhook
  await tgCall(env, "setWebhook", { 
    url: domain, 
    allowed_updates: ["message", "callback_query"] 
  });

  // 2. 配置用户端私聊指令菜单 (仅显示 /start)
  await tgCall(env, "setMyCommands", {
    scope: { type: "all_private_chats" },
    commands: [
      { command: "start", description: "开始咨询 / 激活机器人" }
    ]
  });

  // 3. 配置群组内管理指令菜单 (可选，方便管理员操作)
  await tgCall(env, "setMyCommands", {
    scope: { type: "all_group_chats" },
    commands: [
      { command: "ban", description: "封禁当前话题用户" },
      { command: "unban", description: "解封当前话题用户" }
    ]
  });

  return new Response("Webhook & Commands Updated - Bot is Active");
}

/**
 * 底层 API 调用函数
 */
async function tgCall(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return await r.json();
}
