# Twilio Conversation Relay AI 语音客服

基于 Twilio Conversation Relay + LLM 的实时 AI 语音客服系统。

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

4. Railway 自动部署后，会生成一个域名如 `https://你的应用.up.railway.app`
5. **这个域名会自动注入到 `DOMAIN` 环境变量中，无需手动设置**

### 3. 配置 Twilio

在 Twilio Console 中配置你的号码：

1. 打开 [Twilio Console → Phone Numbers](https://console.twilio.com/us1/develop/phone-numbers/manage/incoming)
2. 选择你的号码（+12566188927）
3. 在 **Voice Configuration** 中：
   - **当有来电时**: Webhook
   - **URL**: `https://你的railway域名/twiml`
   - **HTTP 方法**: POST

### 4. 测试

拨打你的 Twilio 号码，AI 客服会接听电话。

## 本地开发

```bash
# 安装依赖
npm install

# 配置 .env
cp .env.example .env
# 编辑 .env 填入你的 API Key

# 启动
node server.js

# 用 ngrok 暴露本地服务
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
