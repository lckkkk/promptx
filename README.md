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

如果你希望在手机上远程访问自己电脑上的 PromptX，或想在云端部署多租户 Relay，请直接查看：

- `docs/relay-quickstart.md`

文档里已经整理好这些内容：

- 本地 PromptX 接入 Relay
- 云端 Relay 启动与后台管理
- 多租户子域名接入
- `promptx relay tenant add/list/remove`
- `promptx relay start/stop/restart/status`
- Nginx、DNS、健康检查与常见排查

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

## 开源协议

本项目采用 `Apache-2.0` 开源协议，详见根目录 `LICENSE`。
