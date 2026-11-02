# Lumen IDE

一个基于 **Electron + Monaco Editor（VS Code 的编辑器内核）** 的多语言桌面 IDE，界面为苹果式简约风格，支持浅色 / 深色主题。

## 启动

```bash
npm install     # 首次运行
npm start       # 启动 IDE
npm run dev     # 启动并打开开发者工具
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
| 运行 | Ctrl+F5 直接运行当前文件（Python、JS、TS、C/C++、Java、Go、Rust、C#、Ruby、PHP、Lua、Shell 等 20+ 种），任务运行（npm 脚本、Makefile、Cargo、Go） |
| Git | 状态、暂存/取消暂存、放弃更改、提交（含修正）、分支切换/新建、拉取/推送/储藏、提交历史、差异对比、编辑器行号旁的修改标记 |
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

## 项目结构

```
src/main/                 主进程
  main.js                 窗口、app:// 协议、IPC 注册
  preload.js              暴露给界面的安全 API（window.ide）
  services/
    fs-service.js         文件读写、目录、监听
    search-service.js     全局搜索替换
    git-service.js        Git 命令封装
    terminal-service.js   node-pty 终端
    lsp-service.js        语言服务器进程管理与 JSON-RPC
    runner.js             “运行当前文件”命令生成
    dap-service.js        调试会话（Debug Adapter Protocol 客户端）
    node-adapter.js       内置的 Node.js 调试适配器（DAP ↔ Chrome DevTools 协议）
    settings.js           设置与会话状态
src/renderer/             界面
  index.html, css/        布局与样式（tokens.css 为设计变量）
  js/editors.js           标签页、拆分、保存、差异、预览
  js/lsp-client.js        LSP → Monaco 各类 Provider
  js/debug.js             断点、调试会话、变量/监视/调用堆栈、调试工具栏
  js/debug-console.js     调试控制台
  js/explorer.js / search-view.js / git-view.js / run-view.js / terminal.js ...
```

## 目前没有的功能

- 调试 Go / Rust / Java / TypeScript（可以按同样方式接入 dlv、lldb-dap 等适配器）
- 插件 / 扩展系统
- 远程开发
