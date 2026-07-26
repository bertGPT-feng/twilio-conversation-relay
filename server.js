import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

// ── 端口与域名 ───────────────────────────────────
const PORT = process.env.PORT || 8080;
// Railway 会自动提供 RAILWAY_PUBLIC_DOMAIN
const rawDomain = process.env.DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN;
if (!rawDomain) {
  console.error("❌ 缺少 DOMAIN 环境变量！部署后请设置 DOMAIN = 你的 Railway 应用域名");
  process.exit(1);
}
const DOMAIN = rawDomain.replace(/^https?:\/\//, ""); // 去掉协议前缀
const WS_URL = `wss://${DOMAIN}/ws`;
const LLM_MODEL = process.env.LLM_MODEL || "deepseek/deepseek-v4-flash";

// ── 日志 ─────────────────────────────────────────
const LOG_FILE = "/tmp/relay_debug.log";
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(...args);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (_) {}
}

// ── 欢迎语 ───────────────────────────────────────
const WELCOME_GREETING = "您好，这里是法院通知中心。我是小云，请问您是张伟先生吗？";

// ── 系统提示词 ───────────────────────────────────
const SYSTEM_PROMPT = `你是"法院通知中心"的 AI 语音客服，名叫小云。

## 重要规则
1. **永远用中文回复**
2. **回复极其简短，每次只说 1-2 句话**
3. **每句话结尾必须提一个问题**
4. 使用自然口语，像真人打电话一样
5. 不要说废话，不要重复已说过的信息
6. 如果用户说"转人工"或情绪激动，立即告知会安排转接
7. 这段对话是语音形式，请避免使用表情符号、特殊符号、括号

## 当前通话上下文
- 当事人：张伟
- 案号：(2026)京01民初123号
- 文书类型：民事判决书
- 登记地址：北京市朝阳区建国路88号`;

// ── 通话语境存储 ─────────────────────────────────
const sessions = new Map();

// ── OpenAI 客户端 ────────────────────────────────
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
    model: LLM_MODEL,
    messages,
    temperature: 0.6,
    max_tokens: 100,
  });
  return response.choices[0].message.content.trim();
}

// ── Fastify 服务 ─────────────────────────────────
const fastify = Fastify({ logger: false });
fastify.register(fastifyWs);
fastify.register(fastifyFormBody);

// TwiML 端点
fastify.all("/twiml", async (request, reply) => {
  reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${WS_URL}"
      welcomeGreeting="${WELCOME_GREETING}"
      voice="Google.zh-CN-Wavenet-C" />
  </Connect>
</Response>`);
});

// WebSocket 端点 — Twilio Conversation Relay 实时语音流
fastify.register(async function (fastify) {
  fastify.get("/ws", { websocket: true }, (ws, req) => {
    log("🔌 WebSocket connected");

    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data);
        log("📨 消息类型:", message.type);

        switch (message.type) {
          case "setup":
            const callSid = message.callSid;
            log("📞 通话建立:", callSid);
            ws.callSid = callSid;
            sessions.set(callSid, []);
            break;

          case "prompt":
            log("🗣️ 用户说:", message.voicePrompt);
            const conversation = sessions.get(ws.callSid);
            if (!conversation) {
              log("⚠️ 找不到通话记录，忽略");
              break;
            }
            conversation.push({ role: "user", content: message.voicePrompt });

            try {
              const response = await getAIResponse(conversation);
              conversation.push({ role: "assistant", content: response });
              log("🤖 AI 回复:", response);

              if (ws.readyState === 1) {
                ws.send(
                  JSON.stringify({
                    type: "text",
                    token: response,
                    last: true,
                  })
                );
              }
            } catch (err) {
              log("❌ LLM 错误:", err.message);
              if (ws.readyState === 1) {
                ws.send(
                  JSON.stringify({
                    type: "text",
                    token: "抱歉，系统正忙，请稍后再试。",
                    last: true,
                  })
                );
              }
            }
            break;

          case "interrupt":
            log("⏸️ 用户打断了对话");
            break;

          default:
            log("⚠️ 未知消息类型:", message.type);
        }
      } catch (err) {
        log("❌ 消息解析错误:", err);
      }
    });

    ws.on("close", () => {
      log("🔌 WebSocket 关闭");
      if (ws.callSid) {
        sessions.delete(ws.callSid);
      }
    });
  });
});

// ── 启动 ─────────────────────────────────────────
try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  log(`
╔══════════════════════════════════════╗
║  Twilio Conversation Relay 已启动    ║
║  端口: ${PORT}                       ║
║  WebSocket: ${WS_URL}               ║
║  TwiML: https://${DOMAIN}/twiml     ║
╚══════════════════════════════════════╝
  `);
} catch (err) {
  console.error(err);
  process.exit(1);
}
