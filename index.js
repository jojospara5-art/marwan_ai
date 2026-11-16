const fs = require("fs");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const { GoogleGenAI } = require("@google/genai");
const pino = require("pino");

const logger = pino({ level: "silent" });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODELS = ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"];

function systemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `نتا كتجاوب بلاصة مروان فـ واتساب. تاريخ اليوم: ${today}.
نتا شخص مثقف وذكي بزاف وكتفهم فـ كلشي: دراسة، لغات، علوم، رياضيات، تقنية، دين، فلسفة، حياة، نصائح.

قواعد الجواب:
- جاوب بدقة ومعلومات صحيحة. إلا ما كنتيش متأكد قول "ما متأكدش" وما تخترعش.
- فـ الدردشة العادية: هضر بالدارجة المغربية بحال شاب، بجمل قصيرة وعفوية.
- فـ النقاش: دافع على رأيك بحجج منطقية وأمثلة وأرقام، فكك حجج الطرف الآخر بهدوء ونقطة نقطة، وكون مقنع. بلا كذب وبلا تلاعب، وإلا كان الطرف الآخر عندو الحق، اعترف بهادشي.
- فـ الأسئلة الصعيبة والتمارين: فكر مزيان، وحل خطوة خطوة، وشرح كل خطوة، وعطي الجواب النهائي بوضوح.
- إلا جاتك صورة: قراها وحل ما فيها كامل. إلا جاك فويس: سمعو مزيان وجاوب على لي قال.
- إلا طلب منك شي واحد أغنية: ما كتصيفطش الملف. عطيه سمية الأغنية والفنان، ورابط البحث فـ يوتيوب بهاد الشكل: https://www.youtube.com/results?search_query=سمية+الأغنية+الفنان
- إلا سولك على شي حاجة جديدة ولا أخبار، استعمل البحث.
- جاوب بنفس اللغة اللي كيهضر بها الشخص.
- ما تعطي حتى وعد، ولا موعد، ولا تهضر على الفلوس. قول "غنرجع ليك" فهاد الحالات.
- إلا سولك شي واحد بجد واش نتا بوت ولا ذكاء اصطناعي، قول ليه الحقيقة: نتا مساعد ذكاء اصطناعي كيجاوب بلاصة مروان.`;
}

let enabled = true;
const histories = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function askGemini(contents) {
  for (const model of MODELS) {
    for (const useSearch of [true, false]) {
      try {
        const config = { systemInstruction: systemPrompt() };
        if (useSearch) config.tools = [{ googleSearch: {} }];
        const res = await ai.models.generateContent({
          model: model,
          contents: contents,
          config: config,
        });
        if (res.text) return res.text;
      } catch (e) {
        console.error(
          "ERROR with " + model + (useSearch ? " +search" : "") + ":",
          e.message
        );
      }
    }
  }
  return null;
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const sock = makeWASocket({ auth: state, logger: logger });

  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      const code = await sock.requestPairingCode(process.env.PHONE);
      console.log("PAIRING CODE:", code);
    }, 3000);
  }

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (connection === "open") console.log("✅ Connected");
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        fs.rmSync("auth", { recursive: true, force: true });
        console.log("Logged out.");
        process.exit(1);
      } else {
        start();
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0];
    if (!m.message) return;
    const jid = m.key.remoteJid;
    if (jid.endsWith("@g.us") || jid === "status@broadcast") return;

    const msg = m.message;
    const img = msg.imageMessage;
    const audio = msg.audioMessage;
    const text =
      msg.conversation || msg.extendedTextMessage?.text || img?.caption || "";
    if (!text && !img && !audio) return;

    if (m.key.fromMe) {
      if (text === ".stop") {
        enabled = false;
        await sock.sendMessage(jid, { text: "⏸️ البوت وقف" });
      }
      if (text === ".start") {
        enabled = true;
        await sock.sendMessage(jid, { text: "▶️ البوت خدام" });
      }
      if (text === ".reset") {
        for (const k of Object.keys(histories)) delete histories[k];
        await sock.sendMessage(jid, { text: "🧹 تمسحات الذاكرة" });
      }
      return;
    }

    if (!enabled) return;

    const parts = [];
    const media = img || audio;
    if (media) {
      try {
        const buffer = await downloadMediaMessage(
          m,
          "buffer",
          {},
          { logger: logger, reuploadRequest: sock.updateMediaMessage }
        );
        const fallbackType = img ? "image/jpeg" : "audio/ogg";
        parts.push({
          inlineData: {
            mimeType: (media.mimetype || fallbackType).split(";")[0],
            data: buffer.toString("base64"),
          },
        });
      } catch (e) {
        console.error("MEDIA ERROR:", e.message);
        await sock.sendMessage(jid, {
          text: "ما قدرتش نحل الملف، عاود صيفطو 🙏",
        });
        return;
      }
    }

    let prompt = text;
    if (!prompt && img) prompt = "حل ليا هاد التمرين لي فـ الصورة.";
    if (!prompt && audio) prompt = "سمع هاد الفويس وجاوب على لي قال فيه.";
    parts.push({ text: prompt });

    const history = (histories[jid] ||= []);
    await sock.sendPresenceUpdate("composing", jid);
    const answer = await askGemini([...history, { role: "user", parts: parts }]);

    if (!answer) return;

    const label = img ? "[صورة] " : audio ? "[فويس] " : "";
    history.push({ role: "user", parts: [{ text: label + prompt }] });
    history.push({ role: "model", parts: [{ text: answer }] });
    history.splice(0, Math.max(0, history.length - 20));

    await sleep(2000 + Math.random() * 3000);
    await sock.sendMessage(jid, { text: answer });
  });
}

start();
