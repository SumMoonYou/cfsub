# CFSub — Cloudflare Workers 订阅管理系统

CFSub 是一个基于 **Cloudflare Workers + KV** 的轻量级订阅管理后台，用于创建、分发、更新及管理 Clash / Shadowrocket 等代理订阅。

本项目特点：

* 🎯 纯前后端一体，仅需 Cloudflare Worker 即可运行
* 📦 支持自动生成订阅链接（唯一 realKey）
* ⏳ 自带订阅过期管理
* 📝 支持备注（note）与创建时间（createdAt）
* 🔐 管理员密码控制 + Telegram 通知
* 🔍 支持搜索、排序、列表查看

---

## 🚀 功能列表

### 用户侧

* 通过唯一订阅 Key (`/get/<realKey>`) 拉取订阅内容
* 错误或过期自动拒绝访问

### 管理侧

| 路径                    | 功能     | 说明                                       |
| --------------------- | ------ | ---------------------------------------- |
| `/login?password=xxx` | 登录验证   | 正确密码将触发 Telegram 通知                      |
| `/save`               | 新增订阅   | 自动生成 realKey；支持 note 与 createdAt         |
| `/update`             | 更新订阅   | 修改 displayName / expire / note / content |
| `/delete`             | 删除订阅   | 删除 KV 项，通知中不再包含 note                     |
| `/list`               | 列出所有订阅 | 支持分页、搜索、排序                               |

---

## 📦 环境变量（Environment Bindings）

在 Cloudflare Worker Dashboard → Settings → Variables 中配置：

| 变量名               | 说明                        |
| ----------------- | ------------------------- |
| `ADMIN_PASSWORD`  | 管理密码                      |
| `BOT_TOKEN_ADMIN` | Telegram Bot Token        |
| `CHAT_ID_ADMIN`   | Telegram 管理员接收通知的 chat_id |
| `SUBSCRIPTIONS`   | 绑定的 Workers KV 命名空间名称     |

---

## 📡 API 说明

### 1. 新增订阅 `/save`

**方法：POST**

#### Body JSON

```json
{
  "key": "展示名称可选",
  "days": 30,
  "content": "订阅原始内容",
  "note": "备注，可选"
}
```

#### 返回示例

```json
{
  "success": true,
  "realKey": "A1B2C3D4E5",
  "expire": 1737456930000
}
```

📌 **新增功能：保存时会自动添加字段：**

```json
"createdAt": "2025-01-01T12:00:00.000Z"
```

---

### 2. 获取订阅 `/get/<realKey>`

返回 Base64 编码的订阅内容，过期则返回错误。

---

### 3. 更新订阅 `/update?password=xxx`

**方法：POST**

可更新 `displayName`, `days`, `note`, `content`。

---

### 4. 删除订阅 `/delete?password=xxx&key=<realKey>`

删除 KV 中的订阅。

📌 **新增行为：删除通知中已移除 note 字段。**

---

### 5. 订阅列表 `/list?password=xxx`

支持：

* 按显示名搜索
* 按创建时间排序（若启用 createdAt）
* 展示剩余天数、内容、备注等

---

## 🧩 KV 存储结构

每个订阅以 `realKey` 作为键，值为：

```json
{
  "realKey": "A1B2C3D4E5",
  "displayName": "用户A",
  "content": "原始订阅内容",
  "expire": 1737456930000,
  "note": "测试",
  "createdAt": "2025-01-01T12:00:00.000Z"
}
```

---

## 🛠 部署方法

### 1. 克隆仓库

```bash
git clone https://github.com/SumMoonYou/cfsub.git
```

### 2. 进入目录

```bash
cd cfsub
```

### 3. 使用 Wrangler 部署

```bash
wrangler publish
```

配置好 KV 与环境变量即可使用。

---

## 📬 Telegram 通知

系统所有关键操作均会发送至管理员：

* 登录成功
* 新建订阅
* 更新订阅
* 删除订阅（不含 note）
* 用户订阅访问
