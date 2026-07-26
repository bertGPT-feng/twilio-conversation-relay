# Twilio ConversationRelay AI 语音客服

Twilio 负责实时中文语音识别和语音合成，Railway WebSocket 调用 LLM 生成客服回复。

## Railway 一键部署

### 1. 上传到 GitHub

```bash
# 先创建一个 GitHub 仓库
# 然后：
git init
git add .
git commit -m "init"
git remote add origin https://github.com/你的用户名/你的仓库名.git
git push -u origin main
```

### 2. 在 Railway 部署

1. 打开 [Railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. 选择你刚刚上传的仓库
3. 在 Railway 项目设置中添加环境变量：

| 变量名 | 值 |
|--------|-----|
| `OPENAI_API_KEY` | `你的OpenRouter API Key` |
| `OPENAI_BASE_URL` | `https://openrouter.ai/api/v1` |
| `LLM_MODEL` | `deepseek/deepseek-v4-flash` |
| `DOMAIN` | Railway 生成的公网域名，不含路径 |

4. Railway 自动部署后，会生成一个域名如 `https://你的应用.up.railway.app`
5. 建议明确设置 `DOMAIN`；未设置时程序会回退使用 Railway 的 `RAILWAY_PUBLIC_DOMAIN`

### 3. 配置 Twilio

在 Twilio Console 中配置你的号码：

1. 打开 [Twilio Console → Phone Numbers](https://console.twilio.com/us1/develop/phone-numbers/manage/incoming)
2. 选择你的号码（+12566188927）
3. 在 **Voice Configuration** 中：
   - **当有来电时**: Webhook
   - **URL**: `https://你的railway域名/voice`
   - **HTTP 方法**: POST

### 4. 测试

拨打你的 Twilio 号码后，ConversationRelay 会把用户语音实时转成文字并通过
WebSocket 发送给本服务；服务返回的 LLM 文本由 Twilio 播放。

## 本地开发

```bash
# 安装依赖
npm install

# 配置 .env
cp .env.example .env
# 编辑 .env 填入你的 API Key

# 启动
node server.js

# 用 ngrok 等 HTTPS 隧道暴露本地服务，并把 DOMAIN 设置为公网域名
ngrok http 8080
```

## 项目结构

```
├── server.js        # 主程序
├── package.json     # 依赖配置
├── railway.json     # Railway 部署配置
├── .env.example     # 环境变量模板
├── .gitignore       # Git 忽略规则
└── README.md        # 本文件
```
