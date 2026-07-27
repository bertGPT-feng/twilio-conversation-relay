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

export const SYSTEM_PROMPT = `你是“法院通知中心”的 AI 演示客服，名字叫小云。

角色背景：
- 联系人：刘宗宝
- 演示案号：（2026）京01民初123号
- 演示文书：民事判决书
- 你的任务是确认接听人身份，并说明文书送达流程。

对话规则：
1. 永远使用简短、自然、礼貌的中文口语，每次只说一到两句话。
2. 开场先确认对方是否为刘宗宝先生；确认后再说明演示案号和文书类型。
3. 如果对方否认身份或表示打错，不继续披露案件内容，礼貌道歉并结束。
4. 不使用 Markdown、列表、表情、括号或难以朗读的符号。
5. 不编造新案件事实，不提供法律结论，也不冒充法官、律师或执法人员。
6. 不索要验证码、密码、银行卡信息，不要求转账或付款。
7. 如果被问及真实性，明确说明这是 AI 演示客服，真实司法通知应通过官方渠道核验。
8. 每轮围绕当前角色回答，并在适合时用一个简短问题推进流程。`;

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
      welcomeGreeting="您好，这里是法院通知中心的AI演示客服，我是小云。请问您是刘宗宝先生吗？"
      language="zh-CN"
      transcriptionLanguage="zh-CN"
      transcriptionProvider="Deepgram"
      speechModel="nova-2-general"
      ttsLanguage="zh-CN"
      ttsProvider="Amazon"
      voice="Zhiyu-Neural"
      speechTimeout="900"
      interruptible="speech"
      reportInputDuringAgentSpeech="speech"
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

export async function streamAIResponse(openai, conversation, onToken, signal) {
  if (!openai) throw new Error("OPENAI_API_KEY 未配置");
  const response = await openai.chat.completions.create(
    {
      model: LLM_MODEL,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...conversation.slice(-10)],
      temperature: 0.6,
      max_tokens: 160,
      stream: true,
    },
    { signal },
  );

  // Compatibility with OpenAI-compatible providers that ignore stream=true.
  if (!response?.[Symbol.asyncIterator]) {
    const text = response?.choices?.[0]?.message?.content;
    if (!text) throw new Error("LLM 返回空内容");
    await onToken(text, true);
    return text;
  }

  let answer = "";
  let pendingToken = null;
  for await (const chunk of response) {
    const token = chunk.choices?.[0]?.delta?.content;
    if (!token) continue;
    answer += token;
    if (pendingToken !== null) await onToken(pendingToken, false);
    pendingToken = token;
  }
  if (pendingToken === null) throw new Error("LLM 返回空内容");
  await onToken(pendingToken, true);
  return answer.trim();
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
      let activeResponse = null;
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
            if (message.last === false) return;
            const userText = String(message.voicePrompt || "").trim();
            if (!userText || !callSid) return;

            activeResponse?.abort();
            const controller = new AbortController();
            activeResponse = controller;
            const conversation = sessions.get(callSid) || [];
            sessions.set(callSid, conversation);
            conversation.push({ role: "user", content: userText });
            log("🗣️ 用户:", userText);
            const startedAt = Date.now();
            let firstTokenAt = null;

            try {
              const answer = await streamAIResponse(
                openai,
                conversation,
                async (token, last) => {
                  if (controller.signal.aborted || socket.readyState !== 1) return;
                  if (firstTokenAt === null) {
                    firstTokenAt = Date.now();
                    log("⚡ 首Token:", `${firstTokenAt - startedAt}ms`);
                  }
                  socket.send(
                    JSON.stringify({
                      type: "text",
                      token,
                      last,
                      interruptible: true,
                      preemptible: true,
                    }),
                  );
                },
                controller.signal,
              );
              if (controller.signal.aborted) return;
              conversation.push({ role: "assistant", content: answer });
              log("🤖 AI:", answer, `总耗时=${Date.now() - startedAt}ms`);
            } catch (error) {
              if (controller.signal.aborted || error.name === "AbortError") {
                log("⏹️ LLM生成已中止");
                return;
              }
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
              if (activeResponse === controller) activeResponse = null;
            }
            return;
          }

          if (message.type === "interrupt") {
            log("⏸️ 用户打断");
            activeResponse?.abort();
            activeResponse = null;
          }
          if (message.type === "error") log("❌ Relay:", message.description || "未知错误");
        } catch (error) {
          log("❌ WebSocket消息:", error.message);
        }
      });

      socket.on("close", () => {
        activeResponse?.abort();
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
