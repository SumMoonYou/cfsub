
<img<img width="984" height="502" alt="截图20251113150114" src="https://github.com/user-attachments/assets/73adf4f5-2d68-4a48-8b89-16caaf1a7948" />
 width="971" height="684" alt="截图20251113150101" src="https://github.com/user-attachments/assets/d77775bc-28bb-47e2-a548-87bfd688d7c7" />


1️⃣ 登录与管理
 • 管理员登录需要密码（ADMIN_PASSWORD）才能访问管理界面和执行更新/删除操作。
 • 添加新订阅无需密码。
 • 登录成功会触发 Telegram 通知，记录登录时间和管理员操作。

⸻

2️⃣ 订阅管理
 • 添加订阅：
 • 输入显示名称（可选）、订阅内容、有效天数。
 • 系统生成随机的 realKey，实际访问订阅链接使用随机码。
 • 添加成功会发送 Telegram 通知，显示 displayName 或 realKey。
 • 编辑订阅：
 • 可以修改显示名称、内容、有效天数。
 • 修改成功会发送 Telegram 通知。
 • 删除订阅：
 • 可以删除已保存的订阅。
 • 删除成功会发送 Telegram 通知。

⸻

3️⃣ 访问订阅
 • 每个订阅有独立 URL：/get/{realKey}。
 • 访问时：
 • 返回订阅内容的 Base64 编码。
 • 自动触发 Telegram 通知：
 • 显示 displayName（如果有），否则显示 realKey。
 • 会检测有效期，过期订阅无法访问。

⸻

4️⃣ KV 数据管理
 • 所有订阅保存在 Cloudflare KV。
 • 数据结构包含：
 • realKey（随机访问码）
 • displayName（显示名称）
 • content（订阅内容）
 • expire（过期时间，单位毫秒）
 • 支持永久订阅（输入天数为 0）。

⸻

5️⃣ 搜索与分页
 • 搜索功能：
 • 输入搜索关键字，可按 displayName 过滤。
 • 搜索框为空时，显示全部订阅。
 • 支持分页显示，每页默认 10 条，可修改 PAGE_SIZE。

⸻

6️⃣ 前端操作
 • 复制功能：
 • Base64 复制按钮
 • 订阅 URL 复制按钮
 • 编辑、删除按钮：
 • 对应每条订阅，直接在表格操作。
 • 表格显示：
 • 显示名称、剩余天数、操作按钮（复制、编辑、删除）
 • 排序功能：
 • 可按名称或剩余天数升序/降序排序。

⸻

7️⃣ Telegram 通知
 • 登录通知：管理员登录
 • 添加通知：新增订阅
 • 修改通知：更新订阅
 • 删除通知：删除订阅
 • 访问通知：有人访问订阅
 • 显示 displayName，没有显示 realKey

⸻

8️⃣ 安全与健壮性
 • 登录、更新、删除接口需要密码。
 • 添加和访问订阅无需密码，但访问订阅会通知管理员。
 • 自动处理订阅过期，不显示已过期内容。
 • KV 读取异常处理，避免 null 或 expire 报错。
