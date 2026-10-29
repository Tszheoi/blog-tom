# ToM 博客（m.blog.tszheoi-law.top）

基于 **Hugo + PaperMod** 的静态博客。功能与 `blog.tszheoi-law.top` 完全同源，
2026-10-30 从 `Tszheoi/blog` 复制而来，**内容独立**（本仓库内容由站主自己维护）。

- 访问地址：https://m.blog.tszheoi-law.top
- 后台地址：https://m.blog.tszheoi-law.top/tsz

## 结构

```
hugo.toml                  站点配置（标题 ToM、菜单、Toc、minify）
content/posts/             文章根目录
  <分区>/_index.md         分区名（首页会按分区分组展示）
  <分区>/<文章>.md          文章
content/archives.md        归档页
layouts/                   主题覆写（首页分组、文件夹级标签/归档过滤）
static/                    favicon、robots.txt、图片（images/）
functions/tsz.js           网页后台（Cloudflare Pages Function，路由 /tsz）
```

主题不在仓库里，Cloudflare Pages 构建时自动克隆最新版 PaperMod。

## 写文章

两种方式，任选：

1. **网页后台**：打开 `https://m.blog.tszheoi-law.top/tsz`，输入后台密码。
2. **改文件**：在 `content/posts/<分区>/` 新建 `.md`，推送到 `main` 即可。

文章头部模板（front matter）：

```markdown
---
title: "文章标题"
date: 2026-10-30T12:00:00+08:00
draft: false
tags: ["标签一", "标签二"]
categories: ["分类"]
summary: "一句话摘要，会显示在列表页"
ShowToc: true
---

正文……
```

新建一个分区（首页会多出一个文件夹分组）：

```
content/posts/新分区/_index.md
---
title: "新分区"
---
```

图片：后台上传的图会存到 `static/images/`，正文里用 `![](/images/文件名.png)` 引用。

## Cloudflare Pages 构建配置

- **构建命令**：`git clone --depth=1 https://github.com/adityatelange/hugo-PaperMod themes/PaperMod && hugo --gc --minify`
- **输出目录**：`public`
- **生产分支**：`main`
- **环境变量**（在 Pages 项目 → Settings → Environment variables 配置）：

| 变量 | 说明 |
|---|---|
| `HUGO_VERSION` | 必须 ≥ `0.158.0`（新版 PaperMod 要求）；与现有 blog 项目保持一致（`0.168.0`） |
| `ADMIN_PASSWORD` | 后台 `/tsz` 登录密码 |
| `ADMIN_SECRET` | 会话签名密钥，随机长字符串 |
| `GITHUB_TOKEN` | GitHub PAT，需 `repo` 权限（后台读写本仓库用） |
| `GITHUB_REPO` | `Tszheoi/blog-tom` |
| `GITHUB_BRANCH` | `main` |

> 安全：`GITHUB_TOKEN` 只放在 Pages 服务端环境变量里，不要写进仓库任何文件。

## 部署

推送 `main` 分支 → Cloudflare Pages 自动构建发布。没有本地构建步骤，也不需要装 Hugo。
