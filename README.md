# PromptX

PromptX 是一个面向本机 AI 协作的轻量工作台。

它适合先整理需求、截图、文本、PDF、禅道 Bug 等上下文，再持续发送给本机 Codex，在同一页里查看执行过程和多轮结果。

## 核心能力

- 左侧管理任务，中间查看项目执行过程，右侧整理输入内容
- 支持文本、图片、`md`、`txt`、`pdf`
- 支持为任务绑定本机项目，并持续复用同一个 Codex 线程
- 支持查看执行过程、代码变更和最终回复
- 支持公开页与 Raw 导出
- 内置禅道 Chrome 扩展，可一键把 Bug 内容带入工作台

## 运行前提

- 已安装 Node，支持 `20`、`22`、`24`，推荐 `22`
- 本机可以正常运行 `codex --version`
- Codex 已开启高权限，并使用满血模式

## 安装

```bash
npm install -g @muyichengshayu/promptx
promptx doctor
```

## 启动

默认地址：

- `http://127.0.0.1:3000`

```bash
promptx start
promptx status
promptx stop
promptx relay start
```

```bash
promptx doctor
```

其中：

- `promptx start`：启动本机 PromptX 工作台
- `promptx relay start`：启动公网中转服务，适合部署到你自己的云服务器

## 使用方式

1. 打开工作台，新建或选择一个任务
2. 在右侧整理文本、图片、文件等上下文
3. 在中间选择一个 PromptX 项目
4. 点击发送，把当前内容交给 Codex
5. 在中间继续查看执行过程，并按需多轮发送

## 远程访问 Relay（预览）

现在支持两种模式：

- 单租户：一个 Relay 对应一个公网地址
- 多租户：一个 Relay 进程同时服务多个子域名，例如 `user1.promptx.example.com`、`user2.promptx.example.com`

如果只是你自己远程访问，继续用单租户即可。  
如果想同时服务几位同事，推荐直接上“单进程 + 多子域名租户”。

### 单租户模式

云服务器上：

```bash
export PROMPTX_RELAY_HOST=0.0.0.0
export PROMPTX_RELAY_PORT=3030
export PROMPTX_RELAY_PUBLIC_URL=https://relay.example.com
export PROMPTX_RELAY_DEVICE_TOKEN=请换成你自己的长 token
export PROMPTX_RELAY_ACCESS_TOKEN=手机端访问用的口令
promptx relay start
```

本地 PromptX 所在电脑上：

```bash
export PROMPTX_RELAY_URL=https://relay.example.com
export PROMPTX_RELAY_DEVICE_ID=my-macbook
export PROMPTX_RELAY_DEVICE_TOKEN=请与云端保持一致
promptx start
```

### 多租户子域名模式

这是目前更推荐的方案：

- 只跑一个 Relay 进程
- 每位同事一个独立子域名
- 每位同事各自连自己的本机 PromptX
- 前端、接口、上传、WebSocket 都复用同一个 Relay 进程

1. 在云服务器上准备一个租户配置文件，例如 `/etc/promptx-relay-tenants.json`

```json
{
  "tenants": [
    {
      "key": "user1",
      "host": "user1.promptx.example.com",
      "deviceId": "user1-mac",
      "deviceToken": "promptx-user1-device-token",
      "accessToken": "promptx-user1-access-token"
    },
    {
      "key": "user2",
      "host": "user2.promptx.example.com",
      "deviceId": "user2-mac",
      "deviceToken": "promptx-user2-device-token",
      "accessToken": "promptx-user2-access-token"
    }
  ]
}
```

字段说明：

- `key`：租户标识，只用于日志和状态输出
- `host`：这个同事对应的公网子域名
- `deviceId`：可选，限制必须由这个设备 ID 接入
- `deviceToken`：本机 PromptX 接入 Relay 时使用的设备口令
- `accessToken`：手机或浏览器访问这个子域名时输入的口令

如果你不想手填，也可以直接用 CLI 追加一个租户。

推荐先在云服务器上设两个默认环境变量：

```bash
export PROMPTX_RELAY_TENANTS_FILE=/etc/promptx-relay-tenants.json
export PROMPTX_RELAY_BASE_DOMAIN=promptx.mushayu.com
```

这样以后只要执行：

```bash
promptx relay tenant add user1
```

就会自动生成：

- `host`: `user1.promptx.mushayu.com`
- `deviceId`: `user1-mac`
- `deviceToken`
- `accessToken`

如果已经有一个租户配置文件，后续新增租户时即使不再传 `--domain`，也会自动复用现有租户的基础域名。
如果你没有设置 `PROMPTX_RELAY_BASE_DOMAIN`，也可以让它回退使用 `PROMPTX_RELAY_PUBLIC_URL`。

如果你不想依赖环境变量，也可以显式写：

```bash
promptx relay tenant add user1 --domain promptx.mushayu.com --config /etc/promptx-relay-tenants.json
```

命令执行后会直接把结果打印出来，你把其中三项发给同事即可：

- Relay 地址
- 设备 ID
- 设备 Token

查看与删除租户也可以直接走 CLI：

```bash
promptx relay tenant list
promptx relay tenant remove user1
```

2. 启动云端 Relay

```bash
export PROMPTX_RELAY_HOST=0.0.0.0
export PROMPTX_RELAY_PORT=3030
export PROMPTX_RELAY_TENANTS_FILE=/etc/promptx-relay-tenants.json
promptx relay start
```

3. 每位同事在自己的 PromptX 本机里配置

- Relay 地址：填自己的子域名，例如 `https://user1.promptx.example.com`
- 设备 ID：填配置文件里对应的 `deviceId`
- 设备 Token：填配置文件里对应的 `deviceToken`

也可以用环境变量：

```bash
export PROMPTX_RELAY_URL=https://user1.promptx.example.com
export PROMPTX_RELAY_DEVICE_ID=user1-mac
export PROMPTX_RELAY_DEVICE_TOKEN=promptx-user1-device-token
promptx start
```

4. 手机或电脑浏览器直接访问自己的子域名

```text
https://user1.promptx.example.com
https://user2.promptx.example.com
```

首次访问会要求输入各自的 `accessToken`。

### Nginx 最简配置

建议让 Nginx 负责 HTTPS，然后把请求转发到本机的 Relay `3030` 端口。

```nginx
server {
  listen 80;
  server_name *.promptx.example.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  server_name *.promptx.example.com;

  ssl_certificate /etc/letsencrypt/live/promptx.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/promptx.example.com/privkey.pem;

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

### DNS 最简配置

最省事的是做一条通配符解析：

```text
*.promptx.example.com -> 你的云服务器公网 IP
```

如果你不想用泛解析，也可以手动加：

```text
user1.promptx.example.com -> 你的云服务器公网 IP
user2.promptx.example.com -> 你的云服务器公网 IP
```

### 验证方法

云服务器上：

```bash
curl http://127.0.0.1:3030/health
curl -H 'Host: user1.promptx.example.com' http://127.0.0.1:3030/health
```

本地 PromptX 所在电脑上：

```bash
curl http://127.0.0.1:3001/api/relay/status
```

如果一切正常：

- 云端租户健康检查会显示 `deviceOnline: true`
- 本地 Relay 状态会显示 `connected: true`

### 常见排查

- `设备令牌不匹配`：云端租户的 `deviceToken` 和本地配置不一致
- `设备 ID 不匹配`：云端租户配置了 `deviceId`，但本地填的不是同一个值
- `当前 Relay 域名未匹配到租户`：本地填错了 Relay 地址，或子域名没有写进租户配置文件
- `503 PromptX 本地设备暂未连接到 relay`：云端 Relay 正常，但对应同事的本机 PromptX 还没连上

Relay 现在会在日志里输出更清楚的租户信息，例如：

- 当前命中的是哪个 `tenantKey`
- 哪个 `host` 的设备连上/断开
- 被拒绝的具体原因

为了浏览器、WebSocket 与上传更稳定，公网 Relay 强烈建议使用 HTTPS。

## 禅道扩展

仓库内置了禅道 Chrome 扩展：`apps/zentao-extension`

注意：

- 目前 `npm install -g @muyichengshayu/promptx` 安装的正式包不包含这个扩展目录
- 如需使用禅道扩展，请先下载或克隆本仓库源码，再按下面方式手动加载

1. 打开 `chrome://extensions`
2. 开启开发者模式
3. 点击“加载已解压的扩展程序”
4. 选择 `apps/zentao-extension`

使用时保持 PromptX 已启动，然后在禅道 Bug 详情页点击右下角 `AI修复` 即可。

## 注意事项

- 当前只支持 Codex，不支持其他模型后端
- 当前以本机单用户使用为主，不包含账号体系和团队权限
- 默认仅监听本机地址；如需跨设备访问，建议通过 Tailscale
- 如果 Codex 运行在受限权限下，文件读写和自动修改能力会明显受限

## 本地数据目录

运行数据默认保存在 `~/.promptx/`，包含：

```text
data/
uploads/
tmp/
run/
```
