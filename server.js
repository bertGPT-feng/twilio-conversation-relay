import Fastify from "fastify";
import fastifyFormBody from "@fastify/formbody";
import fastifyWebsocket from "@fastify/websocket";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import OpenAI from "openai";
import twilio from "twilio";

dotenv.config();

const PORT = Number(process.env.PORT || 8080);
const DOMAIN = (process.env.DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN || "")
  .replace(/^https?:\/\//, "")
  .replace(/\/+$/, "");
const BASE_URL = DOMAIN ? `https://${DOMAIN}` : `http://localhost:${PORT}`;
const WS_URL = DOMAIN ? `wss://${DOMAIN}/ws` : "";
const USE_DEEPSEEK_OFFICIAL = Boolean(process.env.DEEPSEEK_API_KEY);
const LLM_MODEL = USE_DEEPSEEK_OFFICIAL
  ? process.env.DEEPSEEK_MODEL || "deepseek-chat"
  : process.env.LLM_MODEL || "deepseek/deepseek-v4-flash";
const LOG_FILE = "/tmp/relay_debug.log";
const PUBLIC_DIR = new URL("./public/", import.meta.url);
const FFLATE_BROWSER_FILE = new URL("./node_modules/fflate/umd/index.js", import.meta.url);
const DEFAULT_QUEUE_INTERVAL_SECONDS = 8;
export const WELCOME_GREETING =
  "您好，这里是法院通知中心的客服，我是小云。请问您是来电本人吗？";

export const SYSTEM_PROMPT = `你是“法院通知中心”客服，名字叫小云。

角色背景：
- 联系人：以每次导入的联系人姓名为准
- 演示案号：（2026）京01民初123号
- 演示文书：民事判决书
- 你的任务是确认接听人身份，并说明文书送达流程。

对话内容：
越南社会主义共和国
独立-自由-幸福
------------ *** ------------
河南最高人民普蘇拉西，2025年4月24日编号：10/VKSTC–CI（P-7）
信息部保密令
I：NGUYEN HUY TIEN
- 理由：《刑事诉讼法》第34条、第37条、第79条、第80条、第88条、第120条、第194条、第251条和第324条。
- 依据：起诉2025年4月24日第10号刑事案件的决定和起诉最高人民检察长官被告的决定，下令逮捕和拘留嫌疑人：Mai Van Quy及其同伙Tran Thi Loi，罪名是《刑事诉讼法》第37条和第194条规定的协助跨国贩毒和洗钱团伙。
-基于QD26BTT和特别委员会BH0169的第14号通告。
决定
第1条：从2025年4月24日到案件结束，嫌疑人Mai Van Quy及其同犯Tran Thi Loi在BH0169案件中必须确保绝对遵守通信信息：
1，不要使用SIM卡：0374 956 925。
2，不要使用SIM卡：0819 458 141。
3，绝对不要通过Zalo和Facebook接收陌生人的信息。
第2条：除了Hoang Minh Duc船长，绝对不要和任何人一起工作。在保释期间，与BH0169特别项目委员会协调，它必须遵守特别项目委员会的规定。
第3条：如果嫌疑人Mai Van Quy和同犯Tran Thi Loi不协调或将特别委员会的信息传出去，拘留决定的日期应立即执行。
接收地点：至高无上的人民
• VKSNDTC（案例-7）研究所所长
-保存文件：2份
- 拘留中心；T16
-调查部门：PC02
- 嫌疑人：Mai Van Quy
- 共创：Tran Thi Loi NGUYEN HUY TIEN
根据整个根据整个对话内容去回答通知到对方，然后他提的问题就根据LLM围绕对话内容去扩展回答.

对话规则：
1. 永远使用简短、自然、礼貌的中文口语，每次只说一到两句话。
2. 开场先确认对方是否为导入的联系人本人；确认后再说明演示案号和文书类型。
3. 如果对方否认身份或表示打错，不继续披露案件内容，礼貌道歉并结束。
4. 不使用 Markdown、列表、表情、括号或难以朗读的符号。
5. 不编造新案件事实，不提供法律结论，也不冒充法官、律师或执法人员。
6. 不索要验证码、密码、银行卡信息，不要求转账或付款。
7. 如果被问及真实性，真实司法通知应通过官方渠道核验。
8. 每轮围绕当前角色回答，并在适合时用一个简短问题推进流程。
9. 每次回答必须以完整的句号、问号或感叹号结束，绝不能停在半句话。`;

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

export function conversationRelayTwiml(
  wsUrl = WS_URL,
  { welcomeGreeting = WELCOME_GREETING } = {},
) {
  if (!wsUrl) throw new Error("DOMAIN or RAILWAY_PUBLIC_DOMAIN is required");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect action="${escapeXml(BASE_URL)}/relay-ended">
    <ConversationRelay
      url="${escapeXml(wsUrl)}"
      welcomeGreeting="${escapeXml(welcomeGreeting)}"
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

export function identityResponseFor(input, callContext = null) {
  const text = String(input || "")
    .replace(/[\s，。！？,.!?]/g, "")
    .trim();
  if (/^(不是|不对|打错|你找错|不是本人)/.test(text)) {
    return {
      confirmed: false,
      text: "抱歉，可能是我们联系错了。为保护信息安全，我不会继续说明，打扰您了，再见。",
    };
  }
  if (/^(是的|是啊|对的|对|没错|本人|我就是|嗯|是)$/.test(text) || /^(是的|是啊|对的|我就是)/.test(text)) {
    if (callContext?.name) {
      return {
        confirmed: true,
        text: `好的，${callContext.name}。请问您现在方便听取本次通知吗？`,
      };
    }
    return {
      confirmed: true,
      text:
        "好的。这里有一份关于案号（2026）京01民初123号的民事判决书。" +
        "请问您现在方便了解送达流程吗？",
    };
  }
  return {
    confirmed: null,
    text: callContext?.name
      ? `抱歉，我没有听清。请问您是${callContext.name}吗？`
      : "抱歉，我没有听清。请问您是来电本人吗？",
  };
}

export function localResponseFor(input, conversation = []) {
  const text = String(input || "")
    .replace(/[\s，。！？,.!?]/g, "")
    .trim();
  const previousAssistant = [...conversation]
    .reverse()
    .find((message) => message.role === "assistant")?.content;

  if (
    /现在方便了解送达流程/.test(previousAssistant || "") &&
    /^(方便|旁边|我说方便)$/.test(text)
  ) {
    return "好的。这是一份民事判决书的演示送达通知。请问您需要了解送达方式吗？";
  }
  if (
    /邮寄送达|电子送达/.test(previousAssistant || "") &&
    /^(都不方便|都不行|哪个都不方便)$/.test(text)
  ) {
    return "明白，那本次演示不继续安排送达。真实案件请通过法院官方渠道核实。";
  }
  if (/为什么.*(发|联系)|为什么要给我|为什么有这个/.test(text)) {
    return "这是一次AI功能演示，不涉及真实案件。真实通知请通过法院官方渠道核实。";
  }
  if (/判决书.*内容|内容.*判决书|具体内容/.test(text)) {
    return "这是演示文书，我无法提供具体内容。真实案件请通过法院官方渠道核实。";
  }
  if (/^(不方便|没空|现在不方便)$/.test(text)) {
    return "明白，那就先到这里。真实案件请通过法院官方渠道核实。";
  }
  if (/需要了解送达方式/.test(previousAssistant || "") && /^(需要|要|想了解)$/.test(text)) {
    return "送达方式通常有邮寄送达或电子送达，请问您倾向哪一种？";
  }
  if (/^(好的|好)$/.test(text)) {
    if (/需要了解送达方式/.test(previousAssistant || "")) {
      return "好的。送达方式通常有邮寄送达或电子送达，请问您倾向哪一种？";
    }
    if (/更倾向于哪种方式/.test(previousAssistant || "")) {
      return "好的。请问您选择邮寄送达，还是电子送达？";
    }
    return null;
  }
  if (/^(方便|可以|行)$/.test(text)) {
    return "好的。这是一份民事判决书的演示送达通知。请问您需要了解送达方式吗？";
  }
  if (/^(这是什么|什么东西|说什么东西|这是什么东西|什么文书)$/.test(text)) {
    return "这是一份民事判决书的送达通知，案号是（2026）京01民初123号。请问您需要了解送达方式吗？";
  }
  if (/^(不需要|不需要了|不用|不用了|没有|没了|再见)$/.test(text)) {
    return "好的，打扰您了。如有疑问，请通过法院官方渠道核实。再见。";
  }
  return null;
}

function dynamicLocalResponseFor(input) {
  const text = String(input || "")
    .replace(/[\s，。！？,.!?]/g, "")
    .trim();
  if (/^(不需要|不需要了|不用|不用了|停止|别打了|打错了|再见)$/.test(text)) {
    return "好的，我会停止本次说明。打扰您了，再见。";
  }
  return null;
}

function createOpenAIClient() {
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({
    apiKey,
    baseURL: USE_DEEPSEEK_OFFICIAL
      ? "https://api.deepseek.com"
      : process.env.OPENAI_BASE_URL,
  });
}

export async function streamAIResponse(
  openai,
  conversation,
  onToken,
  signal,
  systemPrompt = SYSTEM_PROMPT,
) {
  if (!openai) throw new Error("OPENAI_API_KEY 未配置");
  const response = await openai.chat.completions.create(
    {
      model: LLM_MODEL,
      messages: [{ role: "system", content: systemPrompt }, ...conversation.slice(-10)],
      temperature: 0.6,
      max_tokens: Number(process.env.LLM_MAX_TOKENS) || 512,
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

  let rawAnswer = "";
  let sentenceBuffer = "";
  let spokenAnswer = "";
  let finishReason = null;

  async function emitSentence(sentence) {
    await onToken(sentence, false);
    spokenAnswer += sentence;
  }

  for await (const chunk of response) {
    finishReason = chunk.choices?.[0]?.finish_reason || finishReason;
    const token = chunk.choices?.[0]?.delta?.content;
    if (!token) continue;
    rawAnswer += token;
    sentenceBuffer += token;

    const completeSentences = sentenceBuffer.match(/.*?[。！？?!]+/gs) || [];
    for (const sentence of completeSentences) await emitSentence(sentence);
    if (completeSentences.length > 0) {
      sentenceBuffer = sentenceBuffer.slice(completeSentences.join("").length);
    }
  }

  log("🧠 LLM结束:", finishReason || "unknown", `原始字符=${rawAnswer.trim().length}`);
  const incompleteTail = sentenceBuffer.trim();
  if (incompleteTail) {
    log("⚠️ 丢弃未完整结句:", incompleteTail);
    if (incompleteTail.length <= 12 && !spokenAnswer) {
      const completedTail = `${incompleteTail}。`;
      await onToken(completedTail, true);
      spokenAnswer += completedTail;
    } else {
      const fallback = "后续信息需要通过官方渠道确认。请问您需要我重新说明吗？";
      await onToken(fallback, true);
      spokenAnswer += fallback;
    }
  } else if (spokenAnswer) {
    await onToken("", true);
  }

  if (!spokenAnswer) throw new Error("LLM 返回空内容");
  return spokenAnswer.trim();
}

function dynamicSystemPrompt(callContext) {
  return `你是康城通讯的AI语音助理，正在与${callContext.name}通话。

本次上下文：
${callContext.context}

联系人备注：
${callContext.note || "无"}

安全和表达规则：
1. 必须透明说明自己是AI语音助理，不冒充真人、政府、法院、银行、律师或执法人员。
2. 只围绕本次上下文回答，不编造事实；不知道时明确建议通过正式渠道核实。
3. 每次只说一到两句自然中文，并以完整标点结束。
4. 不索要密码、验证码、银行卡信息、身份证完整号码，不要求转账或付款。
5. 对方否认身份、要求停止或表示打错时，立即停止披露并礼貌结束。
6. 不使用 Markdown、列表、表情或不利于朗读的符号。`;
}

function normalizeE164(value) {
  const phone = String(value || "").trim().replace(/[^\d+]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) return null;
  return phone;
}

function safeContact(input) {
  const name = String(input?.name || "").trim().slice(0, 80);
  const phone = normalizeE164(input?.phone);
  const note = String(input?.note || "").trim().slice(0, 300);
  if (!name || !phone) return null;
  return {
    id: crypto.randomUUID(),
    name,
    phone,
    note,
    status: "pending",
    callSid: null,
    duration: null,
    errorCode: null,
    startedAt: null,
    endedAt: null,
  };
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    intervalSeconds: job.intervalSeconds,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    activeCallSid: job.activeCallSid,
    contacts: job.contacts,
  };
}

function timingSafeMatch(received, expected) {
  const left = Buffer.from(String(received || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createTwilioClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return null;
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

export function buildServer({
  openai = createOpenAIClient(),
  twilioClient = createTwilioClient(),
  twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER || "",
  dashboardUsername = process.env.DASHBOARD_USERNAME || "admin",
  dashboardPassword = process.env.DASHBOARD_PASSWORD || "",
  productionDashboard = Boolean(process.env.RAILWAY_ENVIRONMENT),
  welcomeInterruptDelayMs = 1200,
  llmFirstTokenTimeoutMs = Number(process.env.LLM_FIRST_TOKEN_TIMEOUT_MS) || 10000,
  queueIntervalSeconds = DEFAULT_QUEUE_INTERVAL_SECONDS,
} = {}) {
  const fastify = Fastify({ logger: false });
  const jobs = new Map();
  const callContexts = new Map();
  fastify.register(fastifyFormBody);
  fastify.register(fastifyWebsocket);

  const configuredDashboardPassword = dashboardPassword;
  const dashboardPasswordRequired = Boolean(
    configuredDashboardPassword || productionDashboard,
  );

  function dashboardAuthorized(request) {
    if (!dashboardPasswordRequired) return true;
    const authorization = String(request.headers.authorization || "");
    if (!authorization.startsWith("Basic ")) return false;
    let username = "";
    let password = "";
    try {
      [username, password] = Buffer.from(authorization.slice(6), "base64")
        .toString("utf8")
        .split(/:(.*)/s, 2);
    } catch {
      return false;
    }
    return (
      timingSafeMatch(username, dashboardUsername) &&
      timingSafeMatch(password, configuredDashboardPassword)
    );
  }

  function requireDashboard(request, reply) {
    if (!configuredDashboardPassword && productionDashboard) {
      reply.status(503).send({
        error: "DASHBOARD_PASSWORD_NOT_CONFIGURED",
        message: "Railway 尚未配置 DASHBOARD_PASSWORD。",
      });
      return false;
    }
    if (!dashboardAuthorized(request)) {
      reply.status(401).send({ error: "UNAUTHORIZED", message: "管理密码不正确。" });
      return false;
    }
    return true;
  }

  async function startNextCall(job) {
    if (job.status !== "running" || job.activeCallSid) return;
    const contact = job.contacts.find((item) => item.status === "pending");
    if (!contact) {
      job.status = "completed";
      job.endedAt = new Date().toISOString();
      log("✅ 队列完成:", job.id);
      return;
    }
    if (!twilioClient || !twilioPhoneNumber) {
      contact.status = "failed";
      contact.errorCode = "TWILIO_NOT_CONFIGURED";
      contact.endedAt = new Date().toISOString();
      job.status = "failed";
      job.endedAt = contact.endedAt;
      log("❌ 队列拨号:", job.id, "Twilio未配置");
      return;
    }

    const contextToken = crypto.randomBytes(24).toString("hex");
    callContexts.set(contextToken, {
      jobId: job.id,
      contactId: contact.id,
      name: contact.name,
      note: contact.note,
      context: job.context,
    });
    contact.status = "dialing";
    contact.startedAt = new Date().toISOString();

    try {
      const query = new URLSearchParams({
        jobId: job.id,
        contactId: contact.id,
        token: contextToken,
      });
      const call = await twilioClient.calls.create({
        to: contact.phone,
        from: twilioPhoneNumber,
        url: `${BASE_URL}/voice?${query}`,
        method: "POST",
        statusCallback: `${BASE_URL}/call-status?${query}`,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      });
      contact.callSid = call.sid;
      job.activeCallSid = call.sid;
      log("📤 队列拨号:", job.id, contact.id, call.sid);
    } catch (error) {
      callContexts.delete(contextToken);
      contact.status = "failed";
      contact.errorCode = error.code || "CALL_CREATE_FAILED";
      contact.endedAt = new Date().toISOString();
      log("❌ 队列拨号:", job.id, contact.id, error.code || error.message);
      if (job.status === "running") {
        setTimeout(() => startNextCall(job), job.intervalSeconds * 1000);
      }
    }
  }

  fastify.get("/", async (_request, reply) => {
    return reply
      .type("text/html; charset=utf-8")
      .send(fs.readFileSync(new URL("index.html", PUBLIC_DIR), "utf8"));
  });

  fastify.get("/app.css", async (_request, reply) => {
    return reply
      .type("text/css; charset=utf-8")
      .send(fs.readFileSync(new URL("app.css", PUBLIC_DIR), "utf8"));
  });

  fastify.get("/app.js", async (_request, reply) => {
    return reply
      .type("application/javascript; charset=utf-8")
      .send(fs.readFileSync(new URL("app.js", PUBLIC_DIR), "utf8"));
  });

  fastify.get("/fflate.js", async (_request, reply) => {
    return reply
      .type("application/javascript; charset=utf-8")
      .send(fs.readFileSync(FFLATE_BROWSER_FILE, "utf8"));
  });

  fastify.post("/api/session", async (request, reply) => {
    if (!configuredDashboardPassword && productionDashboard) {
      return reply.status(503).send({
        error: "DASHBOARD_PASSWORD_NOT_CONFIGURED",
        message: "Railway 尚未配置 DASHBOARD_PASSWORD。",
      });
    }
    if (
      dashboardPasswordRequired &&
      (!timingSafeMatch(request.body?.username, dashboardUsername) ||
        !timingSafeMatch(request.body?.password, configuredDashboardPassword))
    ) {
      return reply
        .status(401)
        .send({ error: "UNAUTHORIZED", message: "管理账号或密码不正确。" });
    }
    return { ok: true, passwordRequired: dashboardPasswordRequired };
  });

  fastify.get("/api/session", async (request, reply) => {
    if (!requireDashboard(request, reply)) return;
    return {
      ok: true,
      passwordRequired: dashboardPasswordRequired,
      twilioReady: Boolean(twilioClient && twilioPhoneNumber),
    };
  });

  fastify.post("/api/queues", async (request, reply) => {
    if (!requireDashboard(request, reply)) return;
    const requestedContacts = Array.isArray(request.body?.contacts)
      ? request.body.contacts
      : [];
    const contacts = requestedContacts.map(safeContact).filter(Boolean);
    const context = String(request.body?.context || "").trim().slice(0, 12000);
    const requestedInterval = Number(request.body?.intervalSeconds);
    const intervalSeconds = Number.isFinite(requestedInterval)
      ? Math.min(300, Math.max(5, Math.round(requestedInterval)))
      : queueIntervalSeconds;

    if (!contacts.length || contacts.length !== requestedContacts.length) {
      return reply.status(400).send({
        error: "INVALID_CONTACTS",
        message: "每位联系人都必须包含姓名和 E.164 国际电话号码。",
      });
    }
    if (contacts.length > 500) {
      return reply.status(400).send({
        error: "TOO_MANY_CONTACTS",
        message: "单次最多导入 500 位联系人。",
      });
    }
    if (!context) {
      return reply.status(400).send({
        error: "CONTEXT_REQUIRED",
        message: "请填写本轮通话上下文。",
      });
    }
    if (!twilioClient || !twilioPhoneNumber) {
      return reply.status(503).send({
        error: "TWILIO_NOT_CONFIGURED",
        message: "Twilio 账号或外呼号码尚未配置。",
      });
    }

    const job = {
      id: crypto.randomUUID(),
      status: "running",
      context,
      intervalSeconds,
      contacts,
      activeCallSid: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    jobs.set(job.id, job);
    log("▶️ 队列启动:", job.id, `联系人=${contacts.length}`);
    void startNextCall(job);
    return reply.status(201).send(publicJob(job));
  });

  fastify.get("/api/queues/:jobId", async (request, reply) => {
    if (!requireDashboard(request, reply)) return;
    const job = jobs.get(request.params.jobId);
    if (!job) return reply.status(404).send({ error: "QUEUE_NOT_FOUND" });
    return publicJob(job);
  });

  fastify.post("/api/queues/:jobId/pause", async (request, reply) => {
    if (!requireDashboard(request, reply)) return;
    const job = jobs.get(request.params.jobId);
    if (!job) return reply.status(404).send({ error: "QUEUE_NOT_FOUND" });
    if (job.status === "running") job.status = "paused";
    log("⏸️ 队列暂停:", job.id);
    return publicJob(job);
  });

  fastify.post("/api/queues/:jobId/resume", async (request, reply) => {
    if (!requireDashboard(request, reply)) return;
    const job = jobs.get(request.params.jobId);
    if (!job) return reply.status(404).send({ error: "QUEUE_NOT_FOUND" });
    if (job.status === "paused") {
      job.status = "running";
      log("▶️ 队列继续:", job.id);
      void startNextCall(job);
    }
    return publicJob(job);
  });

  fastify.post("/api/queues/:jobId/stop", async (request, reply) => {
    if (!requireDashboard(request, reply)) return;
    const job = jobs.get(request.params.jobId);
    if (!job) return reply.status(404).send({ error: "QUEUE_NOT_FOUND" });
    job.status = "stopped";
    job.endedAt = new Date().toISOString();
    for (const contact of job.contacts) {
      if (contact.status === "pending") contact.status = "canceled";
    }
    if (job.activeCallSid && twilioClient) {
      try {
        await twilioClient.calls(job.activeCallSid).update({ status: "completed" });
      } catch (error) {
        log("❌ 停止当前通话:", job.id, error.code || error.message);
      }
    }
    log("⏹️ 队列停止:", job.id);
    return publicJob(job);
  });

  fastify.get("/health", async () => ({
    ok: true,
    mode: "conversation-relay",
    websocket: Boolean(WS_URL),
    dashboard: true,
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

  const voiceHandler = async (request, reply) => {
    try {
      const token = String(request.query?.token || "");
      const callContext = callContexts.get(token);
      if (token && !callContext) {
        return reply
          .status(403)
          .type("text/xml")
          .send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
      }
      const wsQuery = token ? `?token=${encodeURIComponent(token)}` : "";
      const greeting = callContext?.name
        ? `您好，我是康城通讯的AI语音助理。请问您是${callContext.name}吗？`
        : WELCOME_GREETING;
      return reply
        .type("text/xml")
        .send(conversationRelayTwiml(`${WS_URL}${wsQuery}`, { welcomeGreeting: greeting }));
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
    const token = String(request.query?.token || "");
    const callContext = callContexts.get(token);
    const job = callContext ? jobs.get(callContext.jobId) : null;
    const contact = job?.contacts.find((item) => item.id === callContext.contactId);
    if (job && contact) {
      const status = String(request.body?.CallStatus || "").toLowerCase();
      const terminalStatuses = new Set([
        "completed",
        "busy",
        "failed",
        "no-answer",
        "canceled",
      ]);
      if (status === "in-progress") contact.status = "in-progress";
      else if (status === "ringing" || status === "queued") contact.status = status;
      else if (terminalStatuses.has(status) && !contact.endedAt) {
        contact.status = status;
        contact.duration = Number(request.body?.CallDuration || 0);
        contact.errorCode = request.body?.ErrorCode || null;
        contact.endedAt = new Date().toISOString();
        job.activeCallSid = null;
        callContexts.delete(token);
        if (job.status === "running") {
          setTimeout(() => startNextCall(job), job.intervalSeconds * 1000);
        }
      }
    }
    return reply.status(204).send();
  });

  fastify.register(async function websocketRoutes(instance) {
    instance.get("/ws", { websocket: true }, (socket, request) => {
      let callSid = null;
      let activeResponse = null;
      let awaitingIdentity = true;
      let identityFallbackTimer = null;
      const contextToken = String(request.query?.token || "");
      const callContext = callContexts.get(contextToken) || null;
      const activeSystemPrompt = callContext
        ? dynamicSystemPrompt(callContext)
        : SYSTEM_PROMPT;
      log("🔌 WebSocket连接");

      socket.on("message", async (data) => {
        try {
          const message = JSON.parse(data.toString());

          if (message.type === "setup") {
            callSid = message.callSid;
            const greeting = callContext?.name
              ? `您好，我是康城通讯的AI语音助理。请问您是${callContext.name}吗？`
              : WELCOME_GREETING;
            sessions.set(callSid, [{ role: "assistant", content: greeting }]);
            log("📞 Relay通话:", callSid || "?");
            return;
          }

          if (message.type === "prompt") {
            if (message.last === false) return;
            clearTimeout(identityFallbackTimer);
            identityFallbackTimer = null;
            const userText = String(message.voicePrompt || "").trim();
            if (!userText || !callSid) return;

            const conversation = sessions.get(callSid) || [];
            sessions.set(callSid, conversation);
            conversation.push({ role: "user", content: userText });
            log("🗣️ 用户:", userText);
            const startedAt = Date.now();

            if (awaitingIdentity) {
              const identity = identityResponseFor(userText, callContext);
              if (identity.confirmed !== null) awaitingIdentity = false;
              conversation.push({ role: "assistant", content: identity.text });
              if (socket.readyState === 1) {
                socket.send(
                  JSON.stringify({
                    type: "text",
                    token: identity.text,
                    last: true,
                    interruptible: true,
                    preemptible: true,
                  }),
                );
              }
              log("⚡ 本地首轮:", `${Date.now() - startedAt}ms`);
              log("🤖 本地:", identity.text);
              return;
            }

            const localResponse = callContext
              ? dynamicLocalResponseFor(userText)
              : localResponseFor(userText, conversation);
            if (localResponse) {
              conversation.push({ role: "assistant", content: localResponse });
              if (socket.readyState === 1) {
                socket.send(
                  JSON.stringify({
                    type: "text",
                    token: localResponse,
                    last: true,
                    interruptible: true,
                    preemptible: true,
                  }),
                );
              }
              log("⚡ 本地意图:", `${Date.now() - startedAt}ms`);
              log("🤖 本地:", localResponse);
              return;
            }

            activeResponse?.abort();
            const controller = new AbortController();
            activeResponse = controller;
            let firstTokenAt = null;
            let timedOut = false;
            log("⚡ 即时承接:", `${Date.now() - startedAt}ms`);
            const firstTokenTimer = setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, llmFirstTokenTimeoutMs);

            try {
              const answer = await streamAIResponse(
                openai,
                conversation,
                async (token, last) => {
                  if (controller.signal.aborted || socket.readyState !== 1) return;
                  if (token && firstTokenAt === null) {
                    firstTokenAt = Date.now();
                    clearTimeout(firstTokenTimer);
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
                activeSystemPrompt,
              );
              if (controller.signal.aborted) return;
              clearTimeout(firstTokenTimer);
              conversation.push({ role: "assistant", content: answer });
              log("🤖 AI:", answer, `总耗时=${Date.now() - startedAt}ms`);
            } catch (error) {
              if (timedOut) {
                const fallback =
                  "具体情况暂时无法立即确认，请通过法院官方渠道核实。请问您需要我继续说明演示送达流程吗？";
                conversation.push({ role: "assistant", content: fallback });
                if (socket.readyState === 1) {
                  socket.send(
                    JSON.stringify({
                      type: "text",
                      token: fallback,
                      last: true,
                      interruptible: true,
                      preemptible: true,
                    }),
                  );
                }
                log("⏱️ LLM首Token超时:", `${Date.now() - startedAt}ms`);
                return;
              }
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
              clearTimeout(firstTokenTimer);
              if (activeResponse === controller) activeResponse = null;
            }
            return;
          }

          if (message.type === "interrupt") {
            log("⏸️ 用户打断");
            activeResponse?.abort();
            activeResponse = null;
            if (awaitingIdentity && !identityFallbackTimer) {
              identityFallbackTimer = setTimeout(() => {
                identityFallbackTimer = null;
                const fallback = callContext?.name
                  ? `抱歉，刚才可能没有听清。请问您是${callContext.name}吗？`
                  : "抱歉，刚才可能没有听清。请问您是来电本人吗？";
                const conversation = sessions.get(callSid) || [];
                conversation.push({ role: "assistant", content: fallback });
                sessions.set(callSid, conversation);
                if (socket.readyState === 1) {
                  socket.send(
                    JSON.stringify({
                      type: "text",
                      token: fallback,
                      last: true,
                      interruptible: true,
                      preemptible: true,
                    }),
                  );
                }
                log("⚡ 开场打断兜底:", fallback);
              }, welcomeInterruptDelayMs);
            }
          }
          if (message.type === "error") log("❌ Relay:", message.description || "未知错误");
        } catch (error) {
          log("❌ WebSocket消息:", error.message);
        }
      });

      socket.on("close", () => {
        clearTimeout(identityFallbackTimer);
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
