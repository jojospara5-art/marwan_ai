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

const SYSTEM = `نتا كتجاوب بلاصة مروان فـ واتساب، ونتا شخص مثقف وذكي بزاف وكتفهم فـ كلشي: دراسة، لغات، علوم، رياضيات، تقنية، دين، حياة، نصائح.

قواعد الجواب:
- جاوب بدقة ومعلومات صحيحة. إلا ما كنتيش متأكد قول "ما متأكدش" وما تخترعش.
- فـ الدردشة العادية: هضر بالدارجة المغربية بحال شاب، بجمل قصيرة وعفوية.
- فـ الأسئلة الصعيبة والتمارين: فكر مزيان، وحل خطوة خطوة، وشرح كل خطوة، وعطي الجواب النهائي بوضوح.
- إلا جاتك صورة (تمرين، سؤال، نص): قراها مزيان، وحل ما فيها كامل. إلا كانت ما واضحاش قول للشخص يعاود يصيفطها.
- جاوب بنفس اللغة اللي كيهضر بها الشخص ولا اللي مكتوب بها التمرين.
- ما تعطي حتى وعد، ولا موعد، ولا تهضر على الفلوس. قول "غنرجع ليك" فهاد الحالات.
- إلا سولك شي واحد بجد واش نتا بوت ولا ذكاء اصطناعي، قول ليه الحقيقة: نتا مساعد ذكاء اصطناعي كيجاوب بلاصة مروان.`;

let enabled = true;
const histories = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function askGemini(contents) {
  for (const model of MODELS) {
    try {
      const res = await ai.models.generateContent({
        model: model,
        contents: contents,
        config: { systemInstruction: SYSTEM },
      });
      return res.text;
    } catch (e) {
      console.error("ERROR with " + model + ":", e.message);
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
    const text =
      msg.conversation || msg.extendedTextMessage?.text || img?.caption || "";
    if (!text && !img) return;

    if (m.key.fromMe) {
      if (text === ".stop") {
        enabled = false;
        await sock.sendMessage(jid, { text: "⏸️ البوت وقف" });
      }
      if (text === ".start") {
        enabled = true;
        await sock.sendMessage(jid, { text: "▶️ البوت خدام" });
      }
      return;
    }

    if (!enabled) return;

    const parts = [];
    if (img) {
      try {
        const buffer = await downloadMediaMessage(
          m,
          "buffer",
          {},
          { logger: logger, reuploadRequest: sock.updateMediaMessage }
        );
        parts.push({
          inlineData: {
            mimeType: img.mimetype || "image/jpeg",
            data: buffer.toString("base64"),
          },
        });
      } catch (e) {
        console.error("IMAGE ERROR:", e.message);
        await sock.sendMessage(jid, {
          text: "ما قدرتش نحل الصورة، عاود صيفطها 🙏",
        });
        return;
      }
    }
    parts.push({ text: text || "حل ليا هاد التمرين لي فـ الصورة." });

    const history = (histories[jid] ||= []);
    await sock.sendPresenceUpdate("composing", jid);
    const answer = await askGemini([...history, { role: "user", parts: parts }]);

    if (!answer) return;

    history.push({
      role: "user",
      parts: [{ text: img ? "[صورة] " + text : text }],
    });
    history.push({ role: "model", parts: [{ text: answer }] });
    history.splice(0, Math.max(0, history.length - 20));

    await sleep(2000 + Math.random() * 3000);
    await sock.sendMessage(jid, { text: answer });
  });
}

start();
