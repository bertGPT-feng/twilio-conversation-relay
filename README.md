# 康城通讯 · Twilio ConversationRelay AI 外呼工作台

康城通讯提供受密码保护的网页外呼工作台。网页可导入 Excel、CSV 或 TXT
联系人名单，逐个调用 Twilio ConversationRelay；Twilio 负责实时中文语音识别
和语音合成，Railway WebSocket 调用 LLM 生成回复。

## 功能

- 网页导入姓名和 E.164 国际电话号码
- 每通电话使用当前联系人的姓名、备注和网页上下文
- 单队列顺序拨号，可暂停、继续和停止
- 显示排队、响铃、通话中、完成、占线、无人接听和失败状态
- 每批拨号前确认完整号码范围和联系人授权
- Railway 生产环境必须配置管理密码

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
| `TWILIO_ACCOUNT_SID` | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token |
| `TWILIO_PHONE_NUMBER` | Twilio 外呼号码，E.164 格式 |
| `DASHBOARD_USERNAME` | 康城通讯网页管理账号 |
| `DASHBOARD_PASSWORD` | 康城通讯网页管理密码 |
| `DOMAIN` | Railway 生成的公网域名，不含路径 |

4. Railway 自动部署后，会生成一个域名如 `https://你的应用.up.railway.app`
5. 建议明确设置 `DOMAIN`；未设置时程序会回退使用 Railway 的 `RAILWAY_PUBLIC_DOMAIN`

### 3. 打开外呼工作台

访问 Railway 生成的域名，输入管理账号和密码，导入联系人并检查上下文。
确认号码与联系人授权后，网页才会发起真实电话。

ConversationRelay 会把用户语音实时转成文字并通过 WebSocket 发送给本服务；
服务返回的 LLM 文本由 Twilio 播放。每通电话结束后，Twilio 状态回调会更新网页
并在设定间隔后启动下一位联系人。

## 本地开发

```bash
# 安装依赖
npm install

# 配置 .env
cp .env.example .env
# 编辑 .env，填入 LLM、Twilio 和管理密码

# 启动
node server.js

# 用 ngrok 等 HTTPS 隧道暴露本地服务，并把 DOMAIN 设置为公网域名
ngrok http 8080
```

## 项目结构

```
├── server.js        # 主程序
├── public/          # 康城通讯网页工作台
├── package.json     # 依赖配置
├── railway.json     # Railway 部署配置
├── .env.example     # 环境变量模板
├── .gitignore       # Git 忽略规则
└── README.md        # 本文件
```
