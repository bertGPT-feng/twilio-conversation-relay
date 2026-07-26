import Fastify from "fastify";
import fastifyFormBody from "@fastify/formbody";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const PORT = process.env.PORT || 8080;
const BASE_URL = process.env.DOMAIN 
  ? `https://${process.env.DOMAIN.replace(/^https?:\/\//, '')}`
  : `http://localhost:${PORT}`;
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
6. 如果用户说"转人工"或情绪激动，立即告知会安排转接
7. 这段对话是语音形式，请避免使用表情符号、特殊符号、括号

## 当前通话上下文
- 当事人：张伟
- 案号：(2026)京01民初123号
- 文书类型：民事判决书
- 登记地址：北京市朝阳区建国路88号`;

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
    max_tokens: 120,
  });
  return response.choices[0].message.content.trim();
}

const fastify = Fastify({ logger: false });
fastify.register(fastifyFormBody);

fastify.get("/health", async (req, reply) => {
  reply.send({ status: "ok", baseUrl: BASE_URL });
});

// ── 接听电话 ──────────────────────────────────────
fastify.all("/voice", async (req, reply) => {
  const callSid = req.body?.CallSid || "unknown";
  log(`📞 来电: ${callSid}`);
  sessions.set(callSid, []);

  reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" timeout="4" speechTimeout="auto" language="zh-CN" action="${BASE_URL}/gather" method="POST">
    <Say voice="Google.zh-CN-Wavenet-C" language="zh-CN">
      您好，这里是法院通知中心。我是小云，请问您是张伟先生吗？
    </Say>
  </Gather>
  <Redirect>${BASE_URL}/voice</Redirect>
</Response>`);
});

// ── 处理用户回复 ──────────────────────────────────
fastify.all("/gather", async (req, reply) => {
  const callSid = req.body?.CallSid;
  const speechResult = req.body?.SpeechResult;

  log(`🗣️ 用户 (${callSid}): ${speechResult}`);

  if (!speechResult) {
    reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" timeout="4" speechTimeout="auto" language="zh-CN" action="${BASE_URL}/gather" method="POST">
    <Say voice="Google.zh-CN-Wavenet-C">对不起，我没听清楚，您能再说一遍吗？</Say>
  </Gather>
  <Redirect>${BASE_URL}/voice</Redirect>
</Response>`);
    return;
  }

  const conversation = sessions.get(callSid) || [];
  conversation.push({ role: "user", content: speechResult });

  try {
    const aiResponse = await getAIResponse(conversation);
    conversation.push({ role: "assistant", content: aiResponse });
    log(`🤖 AI (${callSid}): ${aiResponse}`);

    reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.zh-CN-Wavenet-C" language="zh-CN">${escapeXml(aiResponse)}</Say>
  <Gather input="speech" timeout="4" speechTimeout="auto" language="zh-CN" action="${BASE_URL}/gather" method="POST">
    <Say voice="Google.zh-CN-Wavenet-C" language="zh-CN">请讲。</Say>
  </Gather>
  <Redirect>${BASE_URL}/voice</Redirect>
</Response>`);
  } catch (err) {
    log(`❌ LLM 错误: ${err.message}`);
    reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.zh-CN-Wavenet-C">抱歉，系统正忙，请稍后再试。</Say>
  <Hangup/>
</Response>`);
  }
});

function escapeXml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  log(`\n✅ AI 语音客服已启动 (${BASE_URL})`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
