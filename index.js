const fs = require("fs");
const { spawn } = require("child_process");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const { GoogleGenAI, Type } = require("@google/genai");
const pino = require("pino");

const logger = pino({ level: "silent" });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODELS = ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"];
const IMAGE_MODELS = ["gemini-2.5-flash-image", "gemini-3.1-flash-image"];
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const DATA_FILE = "auth/memory.json";
const YTDLP_PATH = "/tmp/yt-dlp";
const IG_REGEX =
  /https?:\/\/(?:www\.)?instagram\.com\/(?:reels?|p|tv)\/[\w-]+\S*/i;

// ---------- التخزين ----------
let data = { users: {} };
try {
  data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (!data.users) data.users = {};
} catch (e) {}

function saveData() {
  try {
    fs.mkdirSync("auth", { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data));
  } catch (e) {
    console.error("SAVE ERROR:", e.message);
  }
}

function getUser(jid) {
  if (!data.users[jid]) data.users[jid] = { memory: [], notes: [] };
  return data.users[jid];
}

// ---------- الأدوات ديال Gemini ----------
const FUNCTIONS = [
  {
    name: "remember_fact",
    description:
      "حفظ معلومة ثابتة على هاد الشخص (الاسم، شنو كيحب، الدراسة، الخدمة، الأهداف...) باش تتذكرها فـ المحادثات الجاية. ما تحفظش كلمات سر، أرقام بطاقات، معلومات صحية ولا مالية.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        fact: { type: Type.STRING, description: "المعلومة فـ جملة قصيرة" },
      },
      required: ["fact"],
    },
  },
  {
    name: "forget_fact",
    description: "مسح معلومة محفوظة على هاد الشخص، فاش يطلب هو هادشي.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        keyword: { type: Type.STRING, description: "كلمة من المعلومة اللي تمسح" },
      },
      required: ["keyword"],
    },
  },
  {
    name: "add_note",
    description: "تسجيل ملاحظة ولا مهمة فـ دفتر هاد الشخص، فاش يطلب هو هادشي.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: { type: Type.STRING, description: "نص الملاحظة" },
      },
      required: ["text"],
    },
  },
  {
    name: "delete_note",
    description: "مسح ملاحظة من الدفتر بالنمرة ديالها (من 1).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        number: { type: Type.INTEGER, description: "نمرة الملاحظة" },
      },
      required: ["number"],
    },
  },
];

const TOOLSETS = [
  [{ googleSearch: {} }, { codeExecution: {} }, { functionDeclarations: FUNCTIONS }],
  [{ functionDeclarations: FUNCTIONS }],
  [{ googleSearch: {} }, { codeExecution: {} }],
  [],
];

function runTool(jid, name, args) {
  const u = getUser(jid);
  if (name === "remember_fact") {
    const fact = String(args.fact || "").trim().slice(0, 300);
    if (!fact) return { ok: false };
    if (!u.memory.includes(fact)) u.memory.push(fact);
    u.memory = u.memory.slice(-50);
    saveData();
    return { ok: true };
  }
  if (name === "forget_fact") {
    const k = String(args.keyword || "").trim();
    if (!k) return { ok: false };
    const before = u.memory.length;
    u.memory = u.memory.filter((f) => !f.includes(k));
    saveData();
    return { ok: true, removed: before - u.memory.length };
  }
  if (name === "add_note") {
    const t = String(args.text || "").trim().slice(0, 500);
    if (!t) return { ok: false };
    if (!u.notes.includes(t)) u.notes.push(t);
    u.notes = u.notes.slice(-100);
    saveData();
    return { ok: true, total: u.notes.length };
  }
  if (name === "delete_note") {
    const n = Number(args.number);
    if (!n || n < 1 || n > u.notes.length) return { ok: false };
    u.notes.splice(n - 1, 1);
    saveData();
    return { ok: true };
  }
  return { ok: false };
}

// ---------- البرومبت ----------
function systemPrompt(jid) {
  const today = new Date().toISOString().slice(0, 10);
  const u = getUser(jid);
  const memoryText = u.memory.length
    ? u.memory.map((f) => "- " + f).join("\n")
    : "(مازال ما كاين والو)";
  const notesText = u.notes.length
    ? u.notes.map((n, i) => i + 1 + ". " + n).join("\n")
    : "(الدفتر خاوي)";
  return `نتا كتجاوب بلاصة مروان فـ واتساب. تاريخ اليوم: ${today}.
نتا شخص مثقف وذكي بزاف وكتفهم فـ كلشي: دراسة، لغات، علوم، رياضيات، تقنية، دين، فلسفة، حياة، نصائح.

قواعد الجواب:
- جاوب بدقة ومعلومات صحيحة. إلا ما كنتيش متأكد قول "ما متأكدش" وما تخترعش.
- فـ الدردشة العادية: هضر بالدارجة المغربية بحال شاب، بجمل قصيرة وعفوية.
- فـ النقاش: دافع على رأيك بحجج منطقية وأمثلة وأرقام، فكك حجج الطرف الآخر بهدوء ونقطة نقطة، وكون مقنع. بلا كذب وبلا تلاعب، وإلا كان الطرف الآخر عندو الحق، اعترف بهادشي.
- فـ الرياضيات والحسابات: استعمل تنفيذ الكود باش يكون الجواب دقيق، وشرح الخطوات.
- فـ الأسئلة الصعيبة والتمارين: فكر مزيان، وحل خطوة خطوة، وعطي الجواب النهائي بوضوح.
- إلا جاتك صورة: قراها وحل ما فيها كامل. إلا جاك فويس: سمعو وجاوب على لي قال. إلا جاك فيديو ولا PDF: فهمو ولخصو وجاوب على لي طلب.
- إلا طلب منك شي واحد أغنية: استعمل البحث وجيب ليه سمية الأغنية والفنان ورابط يوتيوب الرسمي الحقيقي ديالها (ماشي رابط مخترع). ما كتصيفطش ملف الصوت. إلا ما لقيتيش الرابط، عطيه رابط البحث: https://www.youtube.com/results?search_query=سمية+الأغنية+الفنان
- إلا بغى يراجع درس ولا يفهمو: شرحو ليه بالدارجة خطوة خطوة بأمثلة بسيطة، ولخصو فـ نقط، وصاوب ليه أسئلة تدريب وصححها ليه، وكرر الصعيب بطريقة أخرى. إلا صيفط ليك صورة ولا PDF ديال الدرس، قراه ودرسو منو.
- إلا سولك على شي حاجة جديدة ولا أخبار، استعمل البحث.
- جاوب بنفس اللغة اللي كيهضر بها الشخص.
- ما تعطي حتى وعد، ولا موعد، ولا تهضر على الفلوس. قول "غنرجع ليك" فهاد الحالات.
- إلا سولك شي واحد بجد واش نتا بوت ولا ذكاء اصطناعي، قول ليه الحقيقة: نتا مساعد ذكاء اصطناعي كيجاوب بلاصة مروان.

الذاكرة:
- هادشي لي عارف على هاد الشخص (هو وحدو، ما تكشفو لحتى واحد آخر):
${memoryText}
- الدفتر ديالو:
${notesText}
- إلا قال شي حاجة ثابتة على راسو (سميتو، دراستو، شنو كيحب، أهدافو...) ولا طلب منك تتفكر شي حاجة: استعمل remember_fact.
- إلا طلب منك تنسى شي حاجة: forget_fact.
- إلا طلب منك تسجل ملاحظة ولا مهمة: add_note. وإلا بغى يمسح وحدة: delete_note.
- ما تحفظ حتى كلمة سر، رقم بطاقة، رقم هوية، معلومات صحية ولا مالية.
- ملي تحفظ شي حاجة، قولها ليه بجملة وحدة قصيرة.`;
}

let enabled = true;
const histories = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function askGemini(jid, contents) {
  for (const model of MODELS) {
    for (let i = 0; i < TOOLSETS.length; i++) {
      try {
        const convo = [...contents];
        const config = { systemInstruction: systemPrompt(jid) };
        if (TOOLSETS[i].length > 0) config.tools = TOOLSETS[i];
        for (let step = 0; step < 4; step++) {
          const res = await ai.models.generateContent({
            model: model,
            contents: convo,
            config: config,
          });
          const calls = res.functionCalls;
          if (calls && calls.length > 0) {
            convo.push(res.candidates[0].content);
            const responseParts = calls.map((c) => ({
              functionResponse: {
                name: c.name,
                response: { result: runTool(jid, c.name, c.args || {}) },
              },
            }));
            convo.push({ role: "user", parts: responseParts });
            continue;
          }
          if (res.text) return res.text;
          break;
        }
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

// ---------- تحميل فيديو إنستغرام ----------
async function ensureYtDlp() {
  if (fs.existsSync(YTDLP_PATH)) return true;
  try {
    const res = await fetch(
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux"
    );
    if (!res.ok) throw new Error("HTTP " + res.status);
    fs.writeFileSync(YTDLP_PATH, Buffer.from(await res.arrayBuffer()));
    fs.chmodSync(YTDLP_PATH, 0o755);
    return true;
  } catch (e) {
    console.error("YTDLP DOWNLOAD ERROR:", e.message);
    return false;
  }
}

function runYtDlp(url) {
  return new Promise((resolve, reject) => {
    const base = "ig_" + Date.now();
    const args = [
      "--no-playlist",
      "--no-warnings",
      "--max-filesize",
      "40M",
      "-f",
      "b[ext=mp4]/b",
      "-o",
      "/tmp/" + base + ".%(ext)s",
      url,
    ];
    const p = spawn(YTDLP_PATH, args);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => p.kill(), 90000);
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.slice(-300) || "exit " + code));
      const file = fs.readdirSync("/tmp").find((f) => f.startsWith(base + "."));
      if (!file) return reject(new Error("no file"));
      const full = "/tmp/" + file;
      const buf = fs.readFileSync(full);
      fs.rmSync(full, { force: true });
      resolve(buf);
    });
  });
}

async function downloadInstagram(url) {
  if (!(await ensureYtDlp())) return null;
  try {
    return await runYtDlp(url);
  } catch (e) {
    console.error("INSTAGRAM ERROR:", e.message);
    return null;
  }
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
        if (fs.existsSync("auth")) {
          for (const f of fs.readdirSync("auth")) {
            if (f !== "memory.json") {
              fs.rmSync("auth/" + f, { recursive: true, force: true });
            }
          }
        }
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
        await sock.sendMessage(jid, { text: "🧹 تمسحات المحادثات الأخيرة" });
      }
      if (text === ".wipe") {
        data = { users: {} };
        saveData();
        await sock.sendMessage(jid, {
          text: "🗑️ تمسحات الذاكرة والملاحظات ديال الكل",
        });
      }
      return;
    }

    if (!enabled) return;

    // رابط إنستغرام
    const igMatch = text.match(IG_REGEX);
    if (igMatch && !img && !video && !doc && !audio) {
      await sock.sendPresenceUpdate("composing", jid);
      const buf = await downloadInstagram(igMatch[0]);
      if (buf) {
        await sock.sendMessage(jid, {
          video: buf,
          mimetype: "video/mp4",
          caption: "🎬",
        });
      } else {
        await sock.sendMessage(jid, {
          text: "ما قدرتش نحمل الفيديو. ممكن إنستغرام بلوكا الطلب، ولا الفيديو خاص، ولا كبير بزاف 🙏",
        });
      }
      return;
    }

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
      await sock.sendMessage(jid, { text: "حاليا كنقرا غير ملفات PDF 📄" });
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
