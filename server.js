import Fastify from "fastify";
import fastifyFormBody from "@fastify/formbody";
import fastifyWebsocket from "@fastify/websocket";
import dotenv from "dotenv";
import fs from "fs";
import OpenAI from "openai";

dotenv.config();

const PORT = Number(process.env.PORT || 8080);
const DOMAIN = (process.env.DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN || "")
  .replace(/^https?:\/\//, "")
  .replace(/\/+$/, "");
const BASE_URL = DOMAIN ? `https://${DOMAIN}` : `http://localhost:${PORT}`;
const WS_URL = DOMAIN ? `wss://${DOMAIN}/ws` : "";
const LLM_MODEL = process.env.LLM_MODEL || "deepseek/deepseek-v4-flash";
const LOG_FILE = "/tmp/relay_debug.log";

const SYSTEM_PROMPT =
  "你是电话客服小云。永远用中文自然口语回复，每次只说一到两句话，" +
  "不要使用 Markdown、表情或特殊符号，并在适合时用一个简短问题继续对话。";

const sessions = new Map();

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(...args);
  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // Railway stdout remains the source of truth if the temporary file is unavailable.
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function conversationRelayTwiml(wsUrl = WS_URL) {
  if (!wsUrl) throw new Error("DOMAIN or RAILWAY_PUBLIC_DOMAIN is required");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect action="${escapeXml(BASE_URL)}/relay-ended">
    <ConversationRelay
      url="${escapeXml(wsUrl)}"
      welcomeGreeting="您好，我是智能客服小云。请问有什么可以帮您？"
      language="zh-CN"
      transcriptionLanguage="zh-CN"
      transcriptionProvider="Deepgram"
      speechModel="nova-2-general"
      ttsLanguage="zh-CN"
      ttsProvider="Amazon"
      voice="Zhiyu-Neural"
      welcomeGreetingInterruptible="speech">
    </ConversationRelay>
  </Connect>
</Response>`;
}

function createOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
  });
}

async function getAIResponse(openai, conversation) {
  if (!openai) throw new Error("OPENAI_API_KEY 未配置");
  const response = await openai.chat.completions.create({
    model: LLM_MODEL,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...conversation.slice(-10)],
    temperature: 0.6,
    max_tokens: 120,
  });
  const text = response.choices[0]?.message?.content?.trim();
  if (!text) throw new Error("LLM 返回空内容");
  return text;
}

export function buildServer({ openai = createOpenAIClient() } = {}) {
  const fastify = Fastify({ logger: false });
  fastify.register(fastifyFormBody);
  fastify.register(fastifyWebsocket);

  fastify.get("/health", async () => ({
    ok: true,
    mode: "conversation-relay",
    websocket: Boolean(WS_URL),
  }));

  fastify.get("/logs", async (_request, reply) => {
    try {
      const lines = fs
        .readFileSync(LOG_FILE, "utf8")
        .split("\n")
        .filter(Boolean)
        .slice(-80);
      return reply.type("text/plain").send(lines.join("\n"));
    } catch {
      return reply.type("text/plain").send("");
    }
  });

  const voiceHandler = async (_request, reply) => {
    try {
      return reply.type("text/xml").send(conversationRelayTwiml());
    } catch (error) {
      log("❌ TwiML:", error.message);
      return reply.status(500).type("text/plain").send(error.message);
    }
  };
  fastify.all("/voice", voiceHandler);
  fastify.all("/twiml", voiceHandler);

  fastify.all("/relay-ended", async (request, reply) => {
    log("🔚 Relay结束:", request.body?.CallSid || "?", request.body?.ConnectStatus || "");
    return reply.type("text/xml").send(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>',
    );
  });

  fastify.all("/call-status", async (request, reply) => {
    log("📊 通话状态:", request.body?.CallSid || "?", request.body?.CallStatus || "");
    return reply.status(204).send();
  });

  fastify.register(async function websocketRoutes(instance) {
    instance.get("/ws", { websocket: true }, (socket) => {
      let callSid = null;
      let responseInFlight = false;
      log("🔌 WebSocket连接");

      socket.on("message", async (data) => {
        try {
          const message = JSON.parse(data.toString());

          if (message.type === "setup") {
            callSid = message.callSid;
            sessions.set(callSid, []);
            log("📞 Relay通话:", callSid || "?");
            return;
          }

          if (message.type === "prompt") {
            if (message.last === false || responseInFlight) return;
            const userText = String(message.voicePrompt || "").trim();
            if (!userText || !callSid) return;

            const conversation = sessions.get(callSid) || [];
            sessions.set(callSid, conversation);
            conversation.push({ role: "user", content: userText });
            log("🗣️ 用户:", userText);
            responseInFlight = true;

            try {
              const answer = await getAIResponse(openai, conversation);
              conversation.push({ role: "assistant", content: answer });
              log("🤖 AI:", answer);
              if (socket.readyState === 1) {
                socket.send(
                  JSON.stringify({
                    type: "text",
                    token: answer,
                    last: true,
                    interruptible: true,
                  }),
                );
              }
            } catch (error) {
              log("❌ LLM:", error.message);
              if (socket.readyState === 1) {
                socket.send(
                  JSON.stringify({
                    type: "text",
                    token: "抱歉，系统暂时无法回答，请稍后再试。",
                    last: true,
                  }),
                );
              }
            } finally {
              responseInFlight = false;
            }
            return;
          }

          if (message.type === "interrupt") log("⏸️ 用户打断");
          if (message.type === "error") log("❌ Relay:", message.description || "未知错误");
        } catch (error) {
          log("❌ WebSocket消息:", error.message);
        }
      });

      socket.on("close", () => {
        log("🔌 WebSocket断开:", callSid || "?");
        if (callSid) sessions.delete(callSid);
      });
    });
  });

  return fastify;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const fastify = buildServer();
  try {
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    log("✅ 已启动:", BASE_URL, "mode=conversation-relay");
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
