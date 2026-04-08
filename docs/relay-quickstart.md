# PromptX Relay 使用说明

这份文档分两部分：

- 给同事：本地 PromptX 如何接入 Relay
- 给运维：云端 Relay 如何新增租户、启动和排查

## 给同事

### 1. 安装

```bash
npm install -g @muyichengshayu/promptx
```

### 2. 启动 PromptX

```bash
promptx start
```

启动后本地访问：

```text
http://127.0.0.1:9301
```

### 3. 配置远程访问

打开 PromptX 设置 -> 远程，填写管理员发给你的 3 项：

- Relay 地址
- 设备 ID
- 设备 Token

然后勾选“启用远程访问”。

如果状态显示“已连接”，说明本机已经接入 Relay。

### 4. 手机远程访问

直接打开管理员发给你的子域名，例如：

```text
https://user1.promptx.mushayu.com
```

首次访问需要输入访问口令 `accessToken`。

### 5. 排查

安装版默认检查命令：

```bash
curl http://127.0.0.1:9301/api/relay/status
```

如果你本地跑的是开发环境 `pnpm dev`，改成：

```bash
curl http://127.0.0.1:9302/api/relay/status
```

重点看这些字段：

- `connected`
- `lastError`
- `lastCloseReason`

## 给运维

### 1. 安装

```bash
npm install -g @muyichengshayu/promptx
```

### 2. 配环境变量

建议在云端先设好：

```bash
export PROMPTX_RELAY_TENANTS_FILE=/etc/promptx-relay-tenants.json
export PROMPTX_RELAY_BASE_DOMAIN=promptx.mushayu.com
export PROMPTX_RELAY_HOST=0.0.0.0
export PROMPTX_RELAY_PORT=3030
```

### 3. 新增一个租户

```bash
promptx relay tenant add user1
```

它会自动生成并写入：

- `host`
- `deviceId`
- `deviceToken`
- `accessToken`

如果没有设 `PROMPTX_RELAY_BASE_DOMAIN`，也可以显式写：

```bash
promptx relay tenant add user1 --domain promptx.mushayu.com
```

### 4. 查看租户列表

```bash
promptx relay tenant list
```

### 5. 删除租户

```bash
promptx relay tenant remove user1
```

### 6. 启动 Relay

```bash
promptx relay start
```

查看状态：

```bash
promptx relay status
```

停止 Relay：

```bash
promptx relay stop
```

重启 Relay：

```bash
promptx relay restart
```

如果只是升级 Relay 的租户统计能力，只需要在云端更新代码并重启 Relay，本地同事的 PromptX 不需要升级。

### 7. 发给同事的信息

新增好租户后，把这 4 项发给同事：

- 子域名地址，例如 `https://user1.promptx.mushayu.com`
- 设备 ID
- 设备 Token
- 访问口令 `accessToken`

### 8. 健康检查

检查某个租户是否在线：

```bash
curl -H 'Host: user1.promptx.mushayu.com' http://127.0.0.1:3030/health
```

正常会看到类似：

```json
{"ok":true,"tenant":"user1","host":"user1.promptx.mushayu.com","deviceOnline":true}
```

### 9. 查看使用统计

Relay 现在自带一个轻量统计页，用来看“今天有哪些租户实际使用了 Relay”。

直接打开：

```text
https://你的域名/relay/admin/usage
```

如果你没有配置管理口令，这个页面可直接访问；如果后面想加保护，可以额外配置：

```bash
export PROMPTX_RELAY_ADMIN_TOKEN=你自己的管理口令
```

统计页会展示：

- 今日活跃租户数
- 今日设备连接次数
- 今日转发请求数
- 每个租户的最近活跃时间、最近设备、API 请求数、上传请求数

统计文件默认保存在：

```text
~/.promptx/data/relay-usage.json
```

### 10. Nginx 配置

建议让 Nginx 负责 HTTPS，并把请求转发到本机 `3030`：

```nginx
server {
  listen 80;
  server_name *.promptx.mushayu.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  server_name *.promptx.mushayu.com;

  ssl_certificate /etc/letsencrypt/live/promptx.mushayu.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/promptx.mushayu.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3030;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

### 11. DNS 配置

最省事的是泛解析：

```text
*.promptx.mushayu.com -> 云服务器公网 IP
```

### 12. 常见问题

- `设备令牌不匹配`
  - 同事本地填写的 `deviceToken` 不对
- `设备 ID 不匹配`
  - 同事本地填写的 `deviceId` 不对
- `当前 Relay 域名未匹配到租户`
  - 子域名没加到租户配置里，或者 DNS/Nginx 没配好
- `503 PromptX 本地设备暂未连接到 relay`
  - 云端 Relay 正常，但对应同事的本机 PromptX 没连上

### 13. 开发环境源码启动

如果不是 npm 安装版，而是源码测试：

云端：

```bash
pnpm install
pnpm build
PROMPTX_RELAY_TENANTS_FILE=/etc/promptx-relay-tenants.json \
PROMPTX_RELAY_HOST=0.0.0.0 \
PROMPTX_RELAY_PORT=3030 \
node scripts/relay.mjs
```

本地开发机：

```bash
pnpm dev
```

本地开发前端地址：

```text
http://127.0.0.1:5174
```
