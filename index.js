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
const IMAGE_MODELS = ["gemini-2.5-flash-image", "gemini-3.1-flash-image"];
const TOOLSETS = [
  [{ googleSearch: {} }, { codeExecution: {} }],
  [{ codeExecution: {} }],
  [],
];
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const YT_REGEX =
  /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)[\w-]+\S*/i;

function systemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `نتا كتجاوب بلاصة مروان فـ واتساب. تاريخ اليوم: ${today}.
نتا شخص مثقف وذكي بزاف وكتفهم فـ كلشي: دراسة، لغات، علوم، رياضيات، تقنية، دين، فلسفة، حياة، نصائح.

قواعد الجواب:
- جاوب بدقة ومعلومات صحيحة. إلا ما كنتيش متأكد قول "ما متأكدش" وما تخترعش.
- فـ الدردشة العادية: هضر بالدارجة المغربية بحال شاب، بجمل قصيرة وعفوية.
- فـ النقاش: دافع على رأيك بحجج منطقية وأمثلة وأرقام، فكك حجج الطرف الآخر بهدوء ونقطة نقطة، وكون مقنع. بلا كذب وبلا تلاعب، وإلا كان الطرف الآخر عندو الحق، اعترف بهادشي.
- فـ الرياضيات والحسابات والإحصاء والمنطق: استعمل تنفيذ الكود باش يكون الجواب دقيق، وشرح الخطوات.
- فـ الأسئلة الصعيبة والتمارين: فكر مزيان، وحل خطوة خطوة، وشرح كل خطوة، وعطي الجواب النهائي بوضوح.
- إلا جاتك صورة: قراها وحل ما فيها كامل. إلا جاك فويس: سمعو وجاوب على لي قال. إلا جاك فيديو ولا PDF ولا رابط يوتيوب: فهمو ولخصو وجاوب على لي طلب.
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
    for (let i = 0; i < TOOLSETS.length; i++) {
      try {
        const config = { systemInstruction: systemPrompt() };
        if (TOOLSETS[i].length > 0) config.tools = TOOLSETS[i];
        const res = await ai.models.generateContent({
          model: model,
          contents: contents,
          config: config,
        });
        if (res.text) return res.text;
      } catch (e) {
        console.error("ERROR with " + model + " tools#" + i + ":", e.message);
      }
    }
  }
  return null;
}

async function generateImage(prompt) {
  for (const model of IMAGE_MODELS) {
    try {
      const res = await ai.models.generateContent({
        model: model,
        contents: [{ parts: [{ text: prompt }] }],
        config: { responseModalities: ["TEXT", "IMAGE"] },
      });
      const part = res.candidates?.[0]?.content?.parts?.find(
        (p) => p.inlineData
      );
      if (part) return Buffer.from(part.inlineData.data, "base64");
    } catch (e) {
      console.error("IMAGE GEN ERROR with " + model + ":", e.message);
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
    const video = msg.videoMessage;
    const doc =
      msg.documentMessage ||
      msg.documentWithCaptionMessage?.message?.documentMessage;
    const caption = img?.caption || video?.caption || doc?.caption || "";
    const text =
      msg.conversation || msg.extendedTextMessage?.text || caption || "";
    if (!text && !img && !audio && !video && !doc) return;

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

    // توليد صورة
    const imgCmd = text.match(/^\.(?:img|صورة)\s+([\s\S]+)/);
    if (imgCmd && !img && !video && !doc && !audio) {
      await sock.sendPresenceUpdate("composing", jid);
      const buf = await generateImage(imgCmd[1].trim());
      if (buf) {
        await sock.sendMessage(jid, { image: buf, caption: "🎨" });
      } else {
        await sock.sendMessage(jid, {
          text: "ما قدرتش نصاوب الصورة دابا (غالبا هاد الميزة ماشي مجانية) 🙏",
        });
      }
      return;
    }

    if (doc && !(doc.mimetype || "").includes("pdf")) {
      await sock.sendMessage(jid, {
        text: "حاليا كنقرا غير ملفات PDF 📄",
      });
      return;
    }

    const parts = [];
    const media = img || audio || video || doc;
    let label = "";
    if (media) {
      try {
        const buffer = await downloadMediaMessage(
          m,
          "buffer",
          {},
          { logger: logger, reuploadRequest: sock.updateMediaMessage }
        );
        if (buffer.length > MAX_FILE_BYTES) {
          await sock.sendMessage(jid, {
            text: "الملف كبير بزاف (أكثر من 15 MB)، صيفط شي حاجة أصغر 🙏",
          });
          return;
        }
        const fallbackType = img
          ? "image/jpeg"
          : audio
          ? "audio/ogg"
          : video
          ? "video/mp4"
          : "application/pdf";
        parts.push({
          inlineData: {
            mimeType: (media.mimetype || fallbackType).split(";")[0],
            data: buffer.toString("base64"),
          },
        });
        label = img ? "[صورة] " : audio ? "[فويس] " : video ? "[فيديو] " : "[PDF] ";
      } catch (e) {
        console.error("MEDIA ERROR:", e.message);
        await sock.sendMessage(jid, {
          text: "ما قدرتش نحل الملف، عاود صيفطو 🙏",
        });
        return;
      }
    }

    const ytMatch = text.match(YT_REGEX);
    if (ytMatch) {
      parts.unshift({ fileData: { fileUri: ytMatch[0] } });
      label = "[يوتيوب] ";
    }

    let prompt = text;
    if (!prompt && img) prompt = "حل ليا هاد التمرين لي فـ الصورة.";
    if (!prompt && audio) prompt = "سمع هاد الفويس وجاوب على لي قال فيه.";
    if (!prompt && video) prompt = "شوف هاد الفيديو ولخصو ليا.";
    if (!prompt && doc) prompt = "لخص ليا هاد الملف وعطيني النقط المهمة فيه.";
    parts.push({ text: prompt });

    const history = (histories[jid] ||= []);
    await sock.sendPresenceUpdate("composing", jid);
    let answer = await askGemini([...history, { role: "user", parts: parts }]);

    if (!answer && ytMatch) {
      const plain = parts.filter((p) => !p.fileData);
      answer = await askGemini([...history, { role: "user", parts: plain }]);
      if (answer) {
        answer = "(ما قدرتش نحل الفيديو ديال يوتيوب)\n\n" + answer;
      }
    }

    if (!answer) return;

    history.push({ role: "user", parts: [{ text: label + prompt }] });
    history.push({ role: "model", parts: [{ text: answer }] });
    history.splice(0, Math.max(0, history.length - 20));

    await sleep(1500 + Math.random() * 2500);
    await sock.sendMessage(jid, { text: answer });
  });
}

start();
