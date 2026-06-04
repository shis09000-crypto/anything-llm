# AnythingLLM 开发容器设置

欢迎使用 AnythingLLM 开发容器配置。该配置用于为本项目创建一个顺畅且功能完整的开发环境。

<center><h1><b>请务必阅读</b></h1></center>

## 前置条件

- Docker
- Visual Studio Code
- Remote - Containers VS Code 扩展

## 功能特性

- 基础镜像：基于 mcr.microsoft.com/devcontainers/javascript-node:1-18-bookworm 构建，因此使用 Node.JS LTS v18。
- 附加工具：包含 hadolint，以及 curl、gnupg 等必要的 apt-packages。
- 端口：已配置自动转发端口 3000（Frontend）和 3001（Backend）。
- 环境变量：将 NODE_ENV 设置为 development，将 ESLINT_USE_FLAT_CONFIG 设置为 true。
- VS Code 扩展：会自动安装一组扩展，例如 Prettier、Docker、ESLint 等。如果你不认可其中某些扩展，请自行调整。出于隐私方面的考虑，目前不包含 AI 驱动扩展和时间追踪器，但你之后可以在自己的环境中安装。

## 开始使用

1. 使用 GitHub Codespaces。只需选择创建一个新的 workspace，devcontainer 就会自动为你创建。

2. 使用本地 VSCode（Release 或 Insiders）。建议你先 fork 该仓库，然后使用 VSCode 工具将其 clone 到本地机器。随后在 VSCode 中打开项目文件夹，系统会提示你是否在 devcontainer 中打开项目。选择 yes 后，devcontainer 就会被创建。如果没有出现提示，可以打开命令面板并选择 "Remote-Containers: Reopen in Container"。

## 创建时：

容器首次构建时，会自动运行 yarn setup，以确保 Collector、Server 和 Frontend 所需内容都已准备就绪。如果下次重启时检测到内容发生变化，该命令预计会被自动重新运行。

## 在容器中工作：

容器启动后，请耐心等待。有些扩展可能会报错，因为依赖仍在安装中；在 Extensions 标签页中，有些扩展可能会要求你 "Reload" 项目。先不要这样做。第一次使用时，先等待所有内容稳定下来。建议你为这个 devcontainer 创建一个新的 VSCode profile，这样你修改的配置和扩展就不会影响默认 profile。

检查清单：

- [ ] 通常会提示你在不同窗口启动 Server 和 Frontend 的消息，现在已经“隐藏”在 devcontainer 构建过程中。不要忘记按提示操作。
- [ ] 打开一个 JavaScript 文件，例如 "server/index.js"，检查 eslint 是否工作。它会提示 'err' is defined but never used.。这说明它正在工作。
- [ ] 打开一个 React 文件，例如 "frontend/src/main.jsx"，检查 eslint 是否提示 Fast refresh only works when a file has exports. Move your component(s) to a separate file.。同样，这说明 eslint 正在工作。然后检查状态栏中的 Prettier 是否有双勾 :heavy_check_mark:（双重勾选）。这表示 Prettier 正在工作。你会看到一个不错的扩展 Formatting::heavy_check_mark:，它可以用来临时禁用 Format on Save 功能。
- [ ] 检查左侧面板中是否有 NPM Scripts（这可能被禁用；查看 "Explorer" 树右上角的三个点）。package.json 文件中会有相关脚本。你基本上需要按顺序运行 dev:collector、dev:server 和 dev:frontend。当前端启动完成后，会在 VSCode 内部 打开一个浏览器窗口。当然，你也可以在外部浏览器中打开。

:warning: 所有开发者请注意 :warning:

- [ ] 当你使用 NODE_ENV=development 时，出于安全原因，server 不会保存你设置的配置。请在 .env.development 文件中设置正确配置。否则每次重启 server 时，你都会被重新送到 "Onboarding" 页面。

使用 GitHub Codespaces 时的说明

- [ ] 首次运行 "Server" 时，它会默认自动将对应端口配置为公开可访问，因为前端需要访问后端 server。想了解更多，请阅读 frontend 文件夹中 .env 文件的内容。如果出现问题，请确认 "Server" 的端口 "Visibility" 是否已按需手动设置为 "Public"。再次强调，这只在 GitHub Codespaces 开发时需要。


关于 Collector：

- [x] 过去，Collector 曾经位于 Python 的领域中，但现在它已经迁移到了 Node.JS 的世界。因此，旧版本那些复杂的配置问题已经不再需要担心。

### 现在可以开始了

在状态栏中，你会看到三个快捷入口，名称分别是 Collector、Server 和 Frontend。只需要按这个顺序点击并等待即可（如果你使用 GH Codespaces，不要忘记在启动 Frontend 之前 将 Server 的 3001 端口设置为 Public）。

现在你可以把时间用在开发上，而不是反复重新配置环境。

## 使用 devcontainers 进行调试

### 调试 collector、server 和 frontend

首先，确认内置扩展（ms-vscode.js-debug）处于启用状态（我也不知道它为什么会没启用，但以防万一）。你也可以安装 nightly 版本（ms-vscode.js-debug-nightly）。

然后，在 "Run and Debug" 标签页（Ctrl+shift+D）中，可以在菜单里选择：

- Collector debug。它会以调试模式启动 collector 并附加 debugger。效果很好。
- Server debug。它会以调试模式启动 server 并附加 debugger。效果很好。
- Frontend debug。它会以调试模式启动 frontend 并附加 debugger。我目前仍在折腾这个配置。我不确定 VSCode 是否能像处理 server 里的纯 .js 文件一样，顺畅处理 .jsx 文件。也许需要针对 Vite 或 React 做特定配置。不管怎样，它可以启动。另外还有两个配置会启动 Chrome 和 Edge，我认为我们应该也能以某种方式在 .jsx 文件中添加断点。最佳情况始终是使用内嵌浏览器。WIP。

请在 Issues 标签页留言，或通过  反馈。