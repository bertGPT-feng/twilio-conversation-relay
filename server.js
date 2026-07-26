import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const PORT = process.env.PORT || 8080;
const DOMAIN = process.env.DOMAIN 
  ? process.env.DOMAIN.replace(/^https?:\/\//, '')
  : process.env.RAILWAY_PUBLIC_DOMAIN;
const BASE_URL = DOMAIN ? `https://${DOMAIN}` : `http://localhost:${PORT}`;
const WS_URL = DOMAIN ? `wss://${DOMAIN}/ws` : null;
const LLM_MODEL = process.env.LLM_MODEL || "deepseek/deepseek-v4-flash";
const LOG_FILE = "/tmp/relay_debug.log";

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(...args);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

const SYSTEM_PROMPT = `你是"法院通知中心"的 AI 语音客服，名叫小云。

## 重要规则
1. **永远用中文回复**
2. **回复极其简短，每次只说 1-2 句话**
3. **每句话结尾必须提一个问题**
4. 使用自然口语，像真人打电话一样
5. 不要说废话，不要重复已说过的信息
6. 这段对话是语音形式，请避免使用表情符号、特殊符号、括号

## 当前通话上下文
- 当事人：张伟
- 案号：(2026)京01民初123号
- 文书类型：民事判决书`;

const sessions = new Map();

async function getAIResponse(conversation) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...conversation.slice(-10),
  ];
  const response = await openai.chat.completions.create({
    model: LLM_MODEL,
    messages,
    temperature: 0.6,
    max_tokens: 100,
  });
  return response.choices[0].message.content.trim();
}

const fastify = Fastify({ logger: false });
fastify.register(fastifyWs);
fastify.register(fastifyFormBody);

fastify.get("/health", async (req, reply) => reply.send({ ok: true, ws: !!WS_URL }));

// TwiML 端点 — 使用 Conversation Relay（非自闭合格式）
fastify.all("/twiml", async (request, reply) => {
  if (!DOMAIN) {
    return reply.status(500).type("text/plain").send("DOMAIN not configured");
  }
  reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="wss://${DOMAIN}/ws" welcomeGreeting="您好，这里是法院通知中心。我是小云，请问您是张伟先生吗？" voice="Polly.Zhiyu">
    </ConversationRelay>
  </Connect>
</Response>`);
});

// WebSocket — Twilio Conversation Relay 实时语音
fastify.register(async function (fastify) {
  fastify.get("/ws", { websocket: true }, (ws, req) => {
    log("🔌 WebSocket 连接");
    let callSid = null;

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data);
        log("📨 消息:", msg.type);

        switch (msg.type) {
          case "setup":
            callSid = msg.callSid;
            log("📞 通话:", callSid);
            sessions.set(callSid, []);
            break;

          case "prompt":
            log("🗣️ 用户:", msg.voicePrompt);
            const conv = sessions.get(callSid);
            if (!conv) break;
            conv.push({ role: "user", content: msg.voicePrompt });

            try {
              const response = await getAIResponse(conv);
              conv.push({ role: "assistant", content: response });
              log("🤖 AI:", response);

              if (ws.readyState === 1) {
                ws.send(JSON.stringify({
                  type: "text",
                  token: response,
                  last: true,
                }));
              }
            } catch (err) {
              log("❌ LLM:", err.message);
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({
                  type: "text",
                  token: "抱歉，系统正忙，请稍后再试。",
                  last: true,
                }));
              }
            }
            break;

          case "interrupt":
            log("⏸️ 打断");
            break;
        }
      } catch (err) {
        log("❌ 解析错误:", err);
      }
    });

    ws.on("close", () => {
      log("🔌 WebSocket 断开");
      if (callSid) sessions.delete(callSid);
    });
  });
});

try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  log(`✅ 已启动 (${BASE_URL})`);
} catch(e) { console.error(e); process.exit(1); }
