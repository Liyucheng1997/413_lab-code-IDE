# Lumen IDE

一个基于 **Electron + Monaco Editor（VS Code 的编辑器内核）** 的多语言桌面 IDE，界面为苹果式简约风格，支持浅色 / 深色主题。

## 下载

到 [Releases](https://github.com/Liyucheng1997/lumen-ide/releases/latest) 下载 Windows 版：

- `Lumen-IDE-Setup-1.4.0.exe`：安装版，可选择安装位置，创建桌面和开始菜单快捷方式，**自动更新**
- `Lumen-IDE-1.4.0-portable.exe`：便携版，免安装，双击即用（有新版本时只提示，需要手动下载）

安装版从 1.3.0 起会自动更新：启动后和每隔 4 小时检查一次新版本，在后台下载，下载完成后可以点“立即重启”，或者等下次关闭 IDE 时自动安装（沿用原来的安装位置）。也可以在 帮助 → 检查更新 手动检查，或在 设置 → 更新 中关闭自动更新。1.2.0 及更早的版本需要手动安装一次 1.3.0。

安装包没有代码签名，首次运行时 Windows SmartScreen 可能提示“已保护你的电脑”，点“更多信息 → 仍要运行”即可。

## 从源码运行

```bash
npm install     # 首次运行
npm start       # 启动 IDE
npm run dev     # 启动并打开开发者工具
npm run dist    # 打包 Windows 安装版和便携版到 dist/
```

发布新版本：改 `package.json` 里的版本号，`npm run dist`，然后把 `dist/` 里的安装包、便携版、`latest.yml` 和 `.blockmap` 一起上传到 GitHub Release（自动更新靠 `latest.yml` 找到新版本，`.blockmap` 用于增量下载）：

```bash
gh release create v1.4.0 dist/Lumen-IDE-Setup-1.4.0.exe dist/Lumen-IDE-Setup-1.4.0.exe.blockmap dist/Lumen-IDE-1.4.0-portable.exe dist/latest.yml --title "Lumen IDE 1.4.0" --notes-file notes.md
```

也可以把文件夹路径作为参数：`npx electron . D:\my-project`。

## 功能

| 类别 | 功能 |
| --- | --- |
| 编辑器 | 语法高亮（80+ 种语言）、多光标、列选择、查找替换（正则）、代码折叠、小地图、括号配对着色、粘性滚动、自动闭合、格式化、行移动/复制、Markdown 实时预览、图片预览 |
| 智能补全 | **JS / TS / HTML / CSS / JSON**：内置语言服务（跨文件补全与跳转）<br>**Python**：随 IDE 自带 Pyright，开箱即用<br>**C/C++、Go、Rust、Java、C#、PHP、Shell、Lua、Ruby、Kotlin、Dart、YAML**：检测到本机语言服务器（clangd、gopls、rust-analyzer…）后自动启用<br>所有语言都有代码片段、关键字和文档单词补全兜底 |
| 语言服务 | 悬停文档、参数提示、转到定义 / 类型定义 / 实现、查找引用、重命名符号、快速修复、大纲（Ctrl+Shift+O）、内联提示、实时诊断 |
| 工作区 | 文件树（新建、重命名、删除到回收站、复制/剪切/粘贴、拖放移动）、外部修改自动同步、快速打开（Ctrl+P）、命令面板（Ctrl+Shift+P）、全局搜索与替换 |
| 编辑器布局 | 多标签（预览标签、拖动排序、拖到另一组）、最多 3 栏拆分编辑器、后退/前进导航、会话恢复 |
| 终端 | 基于 node-pty 的真实终端，可开多个，支持颜色、链接、复制粘贴 |
| 调试 | F5 断点调试 **Python**（debugpy）、**JavaScript**（Node.js，内置适配器）、**C/C++**（GDB 14+）：断点 / 条件断点 / 日志点、单步跳过/进入/跳出、运行到光标处、变量树、监视表达式、调用堆栈、异常断点、悬停查看变量值、调试控制台求值 |
| AI 助手 | 右侧对话面板，默认使用 **Claude Opus 5.5**（`claude-opus-5-5`）。能阅读整个项目、搜索代码、修改文件、运行命令；每次修改先显示差异，确认后才写入；支持右键“AI：修改代码 / 解释代码 / 修复问题” |
| 运行 | Ctrl+F5 直接运行当前文件（Python、JS、TS、C/C++、Java、Go、Rust、C#、Ruby、PHP、Lua、Shell 等 20+ 种），任务运行（npm 脚本、Makefile、Cargo、Go） |
| Git | 状态、暂存/取消暂存、放弃更改、提交（含修正）、差异对比、编辑器行号旁的修改标记；**Git 管理页**：仓库信息、对比 GitHub 上的版本（最新提交、发布、标签）、一键同步、提交历史与详情、分支/标签/远程/储藏管理、发布到 GitHub、克隆仓库 |
| 其他 | 问题面板、输出面板、状态栏（光标、缩进、编码、换行符、语言模式）、设置界面 + settings.json、自动保存、保存时格式化 |

## 常用快捷键

| 操作 | 快捷键 |
| --- | --- |
| 快速打开文件 / 命令面板 | Ctrl+P / Ctrl+Shift+P |
| 打开文件夹 | Ctrl+Alt+O |
| 保存 / 全部保存 | Ctrl+S / Ctrl+Alt+S |
| 触发补全 | Ctrl+Space |
| 转到定义 / 查找引用 / 重命名 | F12 / Shift+F12 / F2 |
| 在文件中搜索 | Ctrl+Shift+F |
| 终端 / 新建终端 | Ctrl+\` / Ctrl+Shift+\` |
| 开始调试 / 继续 | F5 |
| 直接运行（不调试） | Ctrl+F5 |
| 停止调试 | Shift+F5 |
| 切换断点 | F9（或点击行号左侧） |
| 单步跳过 / 进入 / 跳出 | F10 / F11 / Shift+F11 |
| 拆分编辑器 | Ctrl+\\ |
| 切换侧栏 / 面板 | Ctrl+B / Ctrl+J |
| 打开 Git 管理 | Ctrl+Alt+G |
| 打开 AI 助手 | Ctrl+Alt+I |
| AI 修改选中的代码 | Ctrl+Alt+K |

完整列表见 设置 → 快捷键。

## 为更多语言启用智能补全

安装对应的语言服务器并加入 PATH，打开该语言文件时会自动启动：

| 语言 | 安装 |
| --- | --- |
| C / C++ | 安装 LLVM（含 clangd） |
| Go | `go install golang.org/x/tools/gopls@latest` |
| Rust | `rustup component add rust-analyzer` |
| Java | 安装 jdtls |
| C# | `dotnet tool install --global csharp-ls` |
| PHP / Shell / YAML | `npm i -g intelephense bash-language-server yaml-language-server` |

也可以在设置的 `lsp` 中为任意语言指定服务器命令。

## 调试

| 语言 | 需要 | 说明 |
| --- | --- | --- |
| JavaScript | Node.js | 开箱即用，IDE 内置了基于 Chrome DevTools 协议的适配器 |
| Python | `pip install debugpy` | 缺少时 IDE 会提示并可一键在终端安装；程序在集成终端中运行，支持 `input()` |
| C / C++ | gcc/g++ 与 GDB 14+（MinGW-w64） | 自动以 `-g -O0` 编译当前文件后调试，程序输出显示在调试控制台 |

右键行号左侧可以添加条件断点、日志点；在“运行和调试”侧栏里查看变量、监视表达式和调用堆栈；调试控制台底部的输入框可以在当前栈帧里求值。调试 Python 用的解释器可以在 设置 → 运行与语言 → Python 解释器 中指定。

## Git 与 GitHub

左侧“源代码管理”负责日常的暂存和提交；点它标题栏的 ▣ 图标、菜单 Git → 打开 Git 管理，或按 Ctrl+Alt+G，打开完整的 Git 管理页：

| 页签 | 内容 |
| --- | --- |
| 概览 | 当前与远程是否同步（落后 / 领先几个提交，一键拉取、推送或同步）；本地仓库信息（分支、最新提交、提交总数、最新标签、提交身份）；GitHub 上的仓库信息：简介、Star/Fork/Issue、默认分支最新提交是否与本地一致、最新发布、本地还没有的标签和提交；待拉取 / 待推送的提交列表 |
| 提交历史 | 搜索提交、查看全部分支；点开提交看完整说明、作者、父提交和改动的文件，点文件查看该提交的差异；从提交新建分支、打标签、挑选 (cherry-pick)、撤销 (revert)、重置 |
| 分支 | 本地分支与跟踪状态（↑↓、远程已删除），切换、合并、推送、重命名、删除；远程分支检出、删除 |
| 标签 | 新建标签（自动建议下一个版本号，可顺便推送），标出哪些已推送；推送 / 删除本地或远程标签；远程有而本地没有的标签 |
| 远程 | 添加、修改地址、重命名、移除远程；没有远程时可一键“发布到 GitHub” |
| 储藏 | 储藏当前更改（可含未跟踪文件），展开查看改动的文件，弹出、应用、删除 |

**同步** = 获取 → 远程有新提交就拉取 → 本地有新提交就推送；分支还没有上游时会推送并建立跟踪。状态栏的 ⟳ 图标也能一键同步，并显示待拉取 / 待推送的数量。默认每 5 分钟在后台获取一次，可以在 设置 → Git 关闭，也可以让拉取改用 rebase。

读取 GitHub 信息用的是 GitHub 公开接口；安装了 [GitHub CLI](https://cli.github.com/) 并 `gh auth login` 登录后，会自动带上登录凭据，可以查看私有仓库，并能用“发布到 GitHub”直接新建仓库并推送。推送、拉取的账号认证沿用本机 Git 的配置（Windows 上一般是 Git Credential Manager）。

## AI 助手

AI 助手是一个能动手干活的编程智能体，而不只是聊天：它会先列计划，再新建项目、写代码、运行程序、看报错、修改，直到能跑为止。

1. 点左侧活动栏的 ✦ 图标（或 Ctrl+Alt+I）打开 AI 助手。
2. 第一次使用时填入你自己的 Claude API Key（在 [Anthropic 控制台](https://console.anthropic.com/) 创建），默认模型 Claude Opus 5.5。Key 用系统加密（Windows DPAPI）保存在本机，不写入 settings.json，也不会发给界面进程。
3. 使用代理或中转服务时，在 Base URL 填入其地址；模型、思考强度、新项目默认位置可以在 设置 → AI 助手 中修改。

**它能做的事**

| 类别 | 工具 |
| --- | --- |
| 规划 | 任务计划清单（在对话里实时更新进度） |
| 项目 | 新建项目文件夹并在 IDE 中打开、打开已有文件夹 |
| 文件 | 列出、读取、搜索、精确修改、新建/覆盖、新建文件夹、移动/重命名、删除（进回收站）、在编辑器中打开 |
| 运行 | 运行命令（实时显示输出，可终止）、像“运行”按钮一样运行源文件（可提供标准输入）、在“AI 终端”里启动开发服务器等长期运行的程序 |
| 查看输出 | 读取任意终端、问题面板、调试控制台、输出面板（LSP / Git / 运行 等频道）、语言服务器诊断 |
| 联网 | 搜索网页查文档、查报错（仅官方接口，可在设置中关闭） |

每条消息会自动附带 IDE 当前状态（工作区、打开的文件、光标位置、问题数量），选中的代码也会一起发送。

**权限模式**（面板右下角）

- **每次确认**：修改文件前显示差异，运行命令、新建项目、删除前都要你点确认
- **自动改文件**：文件修改直接生效，命令和其他操作仍需确认
- **全自动**：全部自动执行，适合放手让它完成整个任务

文件操作限制在当前工作区内。编辑器中选中代码后，可以右键使用“AI：修改代码…”（Ctrl+Alt+K）、“AI：解释代码”、“AI：修复问题”。

## 项目结构

```
src/main/                 主进程
  main.js                 窗口、app:// 协议、IPC 注册
  preload.js              暴露给界面的安全 API（window.ide）
  services/
    fs-service.js         文件读写、目录、监听
    search-service.js     全局搜索替换
    git-service.js        Git 命令封装、仓库信息、同步、GitHub 接口
    terminal-service.js   node-pty 终端
    lsp-service.js        语言服务器进程管理与 JSON-RPC
    runner.js             “运行当前文件”命令生成
    dap-service.js        调试会话（Debug Adapter Protocol 客户端）
    ai-service.js         AI 助手：调用 Claude API、对话与工具调用循环、加密保存 API Key
    update-service.js     自动更新（electron-updater + GitHub Releases）
    node-adapter.js       内置的 Node.js 调试适配器（DAP ↔ Chrome DevTools 协议）
    settings.js           设置与会话状态
src/renderer/             界面
  index.html, css/        布局与样式（tokens.css 为设计变量）
  js/editors.js           标签页、拆分、保存、差异、预览
  js/lsp-client.js        LSP → Monaco 各类 Provider
  js/debug.js             断点、调试会话、变量/监视/调用堆栈、调试工具栏
  js/debug-console.js     调试控制台
  js/ai-panel.js          AI 助手面板
  js/ai-tools.js          AI 助手的工具执行（读写文件、搜索、运行命令）
  js/update.js            更新提示、状态栏下载进度、检查更新
  js/explorer.js / search-view.js / git-view.js / git-manager.js / run-view.js / terminal.js ...
```

## 目前没有的功能

- 调试 Go / Rust / Java / TypeScript（可以按同样方式接入 dlv、lldb-dap 等适配器）
- 插件 / 扩展系统
- 远程开发
