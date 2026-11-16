# ST-CacheKit · 提示词缓存优化

SillyTavern / Luker / TauriTavern 的提示词整理、缓存诊断与费用统计扩展。

## 功能

- 新安装默认开启世界书稳定排序，支持通过 `{{cache_green}}`、`{{cache_depth}}` 整理提示词。
- 查看提示词来源、请求变化与缓存命中。
- 查看消息和对话费用估算，可选 Google 实际账单查询。
- Google AI Studio / Vertex AI 的 Standard、Flex 层级切换，支持 Gemini 4 Hydrogen / Carbon / Argon。

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
- **缓存**：设置独立系统提示词、前缀分段、世界书排序或宏搬迁；宏搬迁需放入收集宏。
- **价格**：同步单价、填写自定义价格或配置实际账单查询。
- **日志**：查看上一轮提示词与请求记录，支持复制和清除。

缓存命中以 Google 返回用量为准，费用为估算。Flex 需要支持的模型与账号，Vertex Flex 需要 `global` 区域。

Hydrogen 支持 Vertex Standard 和 AI Studio Standard / Flex；最大思考强度对应 xhigh。Carbon 与 Argon 的优惠截止 2026-11-30，到期后自动使用官方已公布的后续单价；手动价格仍优先。

实际账单需先配置 BigQuery 账单导出与查询权限。

修改配套后端后需重启酒馆；修改前端后需刷新页面。

基于 [Mana Nekoha 的 ST-Vertex-PayGo](https://github.com/mananekoha114/ST-Vertex-PayGo) 修改，采用 [MPL-2.0](LICENSE)。
