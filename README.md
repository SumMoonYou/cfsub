# KV Subscription Manager (Cloudflare Workers)

一个基于 **Cloudflare Workers + KV** 的轻量级订阅管理系统，支持在线保存、更新、删除订阅内容，并提供访问日志与管理员 Telegram 通知功能。

本项目适用于管理代理订阅（如 Clash / V2Ray / Sing-Box）、分享节点、或管理任何需要按 Key 提供内容的场景。

------

## ✨ 功能特性

### 🔐 管理后台

- 管理端自带网页 UI（无需额外后端）
- 密码登录
- 在线创建 / 更新 / 删除订阅
- 搜索、排序（名称/剩余天数）
- 分页显示
- 可直接复制订阅 URL 与 Base64 内容
- 备注功能

### 📦 订阅数据

- 每个订阅自动生成随机 `realKey`
- 支持设置有效期（0 = 永久）
- 支持备注 `note`
- 支持记录创建时间（自动）

### 📡 访问追踪

当订阅被访问时自动记录：

- IPv4 / IPv6
- User-Agent
- 国家/地区（Cloudflare 提供）
- 访问时间

并自动发送 Telegram 通知。

### 📩 Telegram 通知

支持两类通知：

- **新增 / 更新 / 删除** 管理动作通知
- **用户访问订阅** 通知

采用 Telegram **MarkdownV2 安全格式**，无消息解析错误。

------

## 🚀 部署方法

### 1. 创建 Cloudflare Worker

在 Cloudflare Dash → Workers → Create → 粘贴本仓库 `worker.js` 全部内容。

------

### 2. 创建 KV Namespace

Dash → Workers → KV → Create namespace，名称如：

```
NODES_KV
```

绑定到 Worker 的 KV，变量名同样设置为：

```
NODES_KV
```

------

### 3. 设置环境变量

Worker → Settings → Variables → Add

| 变量名               | 说明                |
| -------------------- | ------------------- |
| `ADMIN_PASSWORD`     | 管理后台密码        |
| `TELEGRAM_BOT_TOKEN` | 你的 Bot Token      |
| `TELEGRAM_CHAT_ID`   | 接收通知的 chat_id  |
| `NODES_KV`           | KV 名称（自动生成） |

------

## 🖥 管理界面

部署后直接访问 Worker URL 会自动加载管理后台：

```
https://your-worker-domain.workers.dev/
```

输入管理员密码即可使用。

界面功能包括：

- 创建订阅
- 设置有效期
- 添加备注
- 编辑更新
- 删除订阅
- 搜索、排序
- 复制 Base64
- 复制订阅 URL

------

## 📘 API 说明

### 登录

```
GET /login?password=ADMIN_PASSWORD
```

### 新增订阅

```
POST /save?key=名称&days=天数&note=备注
Body = 订阅内容
```

返回生成的 `realKey`。

### 获取订阅 Base64

```
GET /get/realKey
```

返回 Base64 内容。

### 更新订阅

```
POST /update?key=realKey&displayName=名称&days=天数&note=备注&password=ADMIN_PASSWORD
Body = 新内容
```

### 删除订阅

```
POST /delete?key=realKey&password=ADMIN_PASSWORD
```

### 列表查询

```
GET /list?page=1&search=&sort=displayName&order=asc&password=ADMIN_PASSWORD
```

------

## 📬 Telegram 通知示例

### 管理类通知（新增/更新/删除）

```
🟢 新增订阅
⏰ 时间：2025-12-10 10:00:00

📛 名称: 我的节点
🔑 Key: Abc123Xy
📅 过期时间: 2025-12-20 00:00:00
📅 剩余天数: 10
📝 备注: 家宽节点
```

### 用户访问通知

```
🧭 订阅被访问
时间：2025-12-10 11:03:21

📛 订阅: 我的节点
🔑 Key: Abc123Xy
📍 地区: SG, Singapore
🌐 IPv4: 1.2.3.4
💻 设备: ClashMeta/Windows
```

------

## 🧩 技术说明

- 使用 `Cloudflare Workers` 作为后端与管理界面渲染
- 数据存储在 KV
- 所有订阅内容存储为 JSON
- Base64 输出用于兼容 Clash / V2Ray 等订阅格式
- Telegram 采用 `MarkdownV2` 安全转义，避免解析失败
- 地理位置来自 Cloudflare Edge（无需额外 API）

------

## 📄 LICENSE

MIT License
