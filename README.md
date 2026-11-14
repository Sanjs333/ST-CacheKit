# ST-CacheKit · 提示词缓存优化

SillyTavern / Luker / TauriTavern 的提示词整理、缓存诊断与费用统计扩展。

## 功能

- 世界书稳定排序，支持通过 `{{cache_green}}`、`{{cache_depth}}` 整理提示词。
- 查看上一轮提示词、来源和请求记录。
- 查看 Google 缓存用量、消息费用与对话费用估算。
- Google AI Studio / Vertex AI 的 Standard、Flex 层级切换，支持 Gemini 4 Carbon / Argon。

## 后端安装

先停止酒馆，按实际安装位置修改命令中的路径。TauriTavern 无需安装后端。

**Termux**

```bash
pkg install -y nodejs-lts git && cd "$HOME/SillyTavern" && sed -i 's/enableServerPlugins: false/enableServerPlugins: true/' config.yaml && mkdir -p plugins && cd plugins && git clone https://github.com/Sanjs333/ST-CacheKit-Server.git && cd ST-CacheKit-Server && npm install && cd ../.. && echo "安装完成！请重启 SillyTavern"
```

**Windows**

安装 Node.js 20+、Git 和 PowerShell 7+，在 `SillyTavern` 文件夹的上一级运行：

```powershell
cd SillyTavern && ((Get-Content config.yaml -Encoding utf8) -replace 'enableServerPlugins: false', 'enableServerPlugins: true') | Set-Content config.yaml -Encoding utf8 && New-Item -ItemType Directory -Path plugins -Force | Out-Null && cd plugins && git clone https://github.com/Sanjs333/ST-CacheKit-Server.git && cd ST-CacheKit-Server && npm install && cd ../.. && echo "安装完成！请重启 SillyTavern"
```

完成后重启酒馆，刷新页面即可。

## 使用

打开「扩展程序 → 提示词缓存优化」：

- **常规**：查看连接状态，设置消息费用显示。
- **缓存**：开启世界书稳定排序或宏搬迁；宏搬迁需在提示词中放入对应收集宏。
- **价格**：同步模型价格或填写自定义单价。
- **日志**：查看上一轮提示词与请求记录，支持复制和清除。

缓存命中以 Google 返回用量为准，费用为估算。Flex 需要支持的模型与账号，Vertex Flex 需要 `global` 区域。

## 开发验证

在扩展目录运行 `npm test`，验证提示词记录的容量与内容、用量查询和新旧后端兼容。启动酒馆后访问 `/scripts/extensions/third-party/ST-CacheKit/tests/theme-browser.html`，运行独立主题回归场景，检查隐藏抽屉、重复样式写入、动态控件及长聊天更新。

修改配套后端后需重启酒馆；修改前端后需刷新页面。

基于 [Mana Nekoha 的 ST-Vertex-PayGo](https://github.com/mananekoha114/ST-Vertex-PayGo) 修改，采用 [MPL-2.0](LICENSE)。
