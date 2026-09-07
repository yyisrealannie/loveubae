# 传讯 · 私人字卡聊天空间

这是基于 Milk 字卡开源版整理的个人定制版本。它是纯静态网站，可以部署到 GitHub Pages，也可以继续交给 Codex 修改。

## 本地打开

不要直接双击 `index.html`。在项目目录启动任意静态文件服务器，例如：

```bash
python3 -m http.server 8080
```

然后访问 `http://localhost:8080`。

## 部署到 GitHub Pages

1. 新建 GitHub 仓库并上传本目录全部文件。
2. 在仓库 Settings → Pages → Source 选择 **GitHub Actions**。
3. 推送到 `main` 分支后，仓库自带的工作流会自动部署。

## Supabase 跨设备同步

1. 新建 Supabase 项目。
2. 打开 SQL Editor，运行 [`supabase/schema.sql`](supabase/schema.sql)。
3. 在 Authentication 中启用 Email/Password 登录。
4. 当前个人版已经预填 Supabase Project URL 和 publishable key；打开“设置 → 数据管理 → Supabase 同步”后直接注册或登录即可。
5. 注册/登录后即可上传当前数据，或在另一台设备恢复。

Project URL 和 publishable key 属于可公开的前端配置，已写入个人版源码；仓库中不包含 `service_role` 私钥。数据表启用了 RLS，每个账户只能读写自己的备份。

## PWA

部署到 HTTPS 后，可在手机浏览器菜单中选择“添加到主屏幕”。网站会缓存本地资源，已打开过一次后可离线进入；云同步和外链音乐仍需要网络。

## 主要定制

- 导入后即时生效，不再刷新页面。
- 历史记录保持当前位置，搜索可直接展开并定位旧消息。
- 隐藏群聊、批量发送和多会话入口，首次打开直接进入聊天。
- 双击对方头像拍一拍；对方拍一拍概率 17%。
- 30% 概率将多条字卡合并为一条回复。
- 8% 概率收到 20 条词条组成的主动拼贴信，冷却 2 小时。
- 新词条 90% 相似度检查、批量近似去重、醒目的禁用状态。
- 音乐支持链接和本地文件；显示浏览器实际存储占用。
- 词云自定义关键词黑名单。
- 使用 Wake Lock 做无声页面保活，不抢占其他音乐软件音频通道。
- Supabase 跨设备同步与 PWA 安装。

## 目录说明

- `index.html`：主页面
- `css/styles.css`：全部样式
- `js/`：应用逻辑与功能模块
- `supabase/schema.sql`：云同步数据表与权限策略
- `manifest.webmanifest`、`service-worker.js`：PWA 配置
- `.github/workflows/deploy-pages.yml`：GitHub Pages 自动部署
