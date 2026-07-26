#!/bin/bash
set -e

echo "===== 部署 Conversation Relay AI 客服 ====="

# 1. 安装 Node.js 22
echo "[1/5] 安装 Node.js..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt install -y nodejs
fi
echo "  Node.js $(node --version)"

# 2. 创建项目目录
echo "[2/5] 创建项目..."
mkdir -p /opt/relay
cd /opt/relay

# 3. 安装依赖
echo "[3/5] 安装依赖..."
npm init -y > /dev/null
npm pkg set type="module" > /dev/null
npm install fastify @fastify/websocket @fastify/formbody openai dotenv

# 4. 创建 server.js
cat > server.js << 'SERVEREOF'
import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from 'fs';

dotenv.config();

const PORT = process.env.PORT || 8081;
const DOMAIN = process.env.DOMAIN || "localhost";
const WS_URL = `wss://${DOMAIN}/ws`;
const LLM_MODEL = process.env.LLM_MODEL || "deepseek/deepseek-v4-flash";
const LOG_FILE = "/var/log/relay.log";

const WELCOME_GREETING = "您好，这里是法院通知中心。我是小云，请问您是张伟先生吗？";

const SYSTEM_PROMPT = `你是"法院通知中心"的 AI 语音客服，名叫小云。

## 重要规则
1. **永远用中文回复**
2. **回复极其简短，每次只说 1-2 句话**
3. **每句话结尾必须提一个问题**
4. 使用自然口语，像真人打电话一样
5. 这段对话是语音形式，不要使用特殊符号

## 当前通话上下文
- 当事人：张伟
- 案号：(2026)京01民初123号
- 文书类型：民事判决书
- 登记地址：北京市朝阳区建国路88号`;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch(e) {}
}

const sessions = new Map();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

async function getAIResponse(conversation) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...conversation.slice(-10),
  ];
  const response = await openai.chat.completions.create({
    model: LLM_MODEL, messages, temperature: 0.7, max_tokens: 80,
  });
  return response.choices[0].message.content.trim();
}

const fastify = Fastify();
fastify.register(fastifyWs);
fastify.register(fastifyFormBody);

fastify.all("/twiml", async (request, reply) => {
  reply.type("text/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <ConversationRelay url="${WS_URL}" welcomeGreeting="${WELCOME_GREETING}" voice="Google.zh-CN-Wavenet-C" />
      </Connect>
    </Response>`
  );
});

fastify.register(async function (fastify) {
  fastify.get("/ws", { websocket: true }, (ws, req) => {
    log("🔌 WebSocket connected");

    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data);
        log(`📨 消息: ${message.type}`);

        switch (message.type) {
          case "setup":
            ws.callSid = message.callSid;
            sessions.set(message.callSid, []);
            log(`📞 通话: ${message.callSid}`);
            break;
          case "prompt":
            log(`🗣️ 用户: ${message.voicePrompt}`);
            const conv = sessions.get(ws.callSid) || [];
            conv.push({ role: "user", content: message.voicePrompt });
            const reply = await getAIResponse(conv);
            conv.push({ role: "assistant", content: reply });
            log(`🤖 AI: ${reply}`);
            ws.send(JSON.stringify({ type: "text", token: reply, last: true }));
            break;
          case "interrupt":
            log("⏸️ 打断");
            break;
        }
      } catch (err) {
        log(`❌ 错误: ${err.message}`);
      }
    });

    ws.on("close", () => {
      log("🔌 WebSocket 关闭");
      if (ws.callSid) sessions.delete(ws.callSid);
    });
  });
});

try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  log(`Server: ${PORT} | WS: ${WS_URL}`);
} catch (err) { log(`启动失败: ${err.message}`); process.exit(1); }
SERVEREOF

# 5. 创建环境变量文件
echo "[4/5] 创建配置..."
cat > /opt/relay/.env << 'ENVEOF'
OPENAI_API_KEY=你的OpenRouter API Key
OPENAI_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=deepseek/deepseek-v4-flash
DOMAIN=207.57.123.76
PORT=8081
ENVEOF

# 6. 防火墙
echo "[5/5] 配置防火墙..."
ufw allow 8081 2>/dev/null || true

# 7. 使用 PM2 守护进程
npm install -g pm2 2>/dev/null
pm2 delete relay 2>/dev/null || true
pm2 start server.js --name relay
pm2 save

echo ""
echo "✅ 部署完成!"
echo "   服务器: http://207.57.123.76:8081/twiml"
echo "   WebSocket: wss://207.57.123.76:8081/ws"
echo ""
echo "   现在去 Twilio Console 设置号码 Webhook 为:"
echo "   http://207.57.123.76:8081/twiml"
echo "   方法: GET"
