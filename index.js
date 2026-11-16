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
const MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3.5-flash"];
const MAX_FILE = 15 * 1024 * 1024;
const DATA_FILE = "auth/memory.json";
const YTDLP = "/tmp/yt-dlp";
const IG_REGEX = /https?:\/\/(?:www\.)?instagram\.com\/(?:reels?|p|tv)\/[\w-]+\S*/i;
const LIMIT_PER_HOUR = 30;

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

const hits = {};
function overLimit(jid) {
  const now = Date.now();
  const arr = (hits[jid] = (hits[jid] || []).filter((t) => now - t < 3600000));
  arr.push(now);
  return arr.length > LIMIT_PER_HOUR;
}

const str = (d) => ({ type: Type.STRING, description: d });
const fn = (name, description, props, required) => ({
  name: name,
  description: description,
  parameters: { type: Type.OBJECT, properties: props, required: required },
});

const FUNCTIONS = [
  fn("remember_fact", "حفظ معلومة ثابتة على الشخص (ماشي كلمات سر ولا صحة ولا فلوس)", { fact: str("المعلومة") }, ["fact"]),
  fn("forget_fact", "مسح معلومة محفوظة", { keyword: str("كلمة من المعلومة") }, ["keyword"]),
  fn("add_note", "تسجيل ملاحظة فـ دفتر الشخص", { text: str("النص") }, ["text"]),
  fn("delete_note", "مسح ملاحظة بالنمرة (من 1)", { number: { type: Type.INTEGER, description: "النمرة" } }, ["number"]),
];

const TOOLSETS = [
  [{ googleSearch: {} }, { codeExecution: {} }, { functionDeclarations: FUNCTIONS }],
  [{ functionDeclarations: FUNCTIONS }],
  [{ googleSearch: {} }, { codeExecution: {} }],
  [],
];

function runTool(jid, name, a) {
  const u = getUser(jid);
  if (name === "remember_fact") {
    const f = String(a.fact || "").trim().slice(0, 300);
    if (!f) return { ok: false };
    if (!u.memory.includes(f)) u.memory.push(f);
    u.memory = u.memory.slice(-50);
  } else if (name === "forget_fact") {
    const k = String(a.keyword || "").trim();
    if (!k) return { ok: false };
    u.memory = u.memory.filter((x) => !x.includes(k));
  } else if (name === "add_note") {
    const t = String(a.text || "").trim().slice(0, 500);
    if (!t) return { ok: false };
    u.notes.push(t);
    u.notes = u.notes.slice(-100);
  } else if (name === "delete_note") {
    const n = Number(a.number);
    if (!n || n < 1 || n > u.notes.length) return { ok: false };
    u.notes.splice(n - 1, 1);
  } else {
    return { ok: false };
  }
  saveData();
  return { ok: true };
}

function systemPrompt(jid) {
  const today = new Date().toISOString().slice(0, 10);
  const u = getUser(jid);
  const mem = u.memory.length ? u.memory.map((f) => "- " + f).join("\n") : "(والو)";
  const notes = u.notes.length ? u.notes.map((n, i) => i + 1 + ". " + n).join("\n") : "(خاوي)";
  return `نتا كتجاوب بلاصة مروان فـ واتساب. تاريخ اليوم: ${today}.
نتا شخص مثقف وذكي بزاف وكتفهم فـ كلشي: دراسة، لغات، علوم، رياضيات، تقنية، دين، فلسفة، حياة، نصائح.

قواعد الجواب:
- جاوب بدقة ومعلومات صحيحة. إلا ما كنتيش متأكد قول "ما متأكدش" وما تخترعش.
- فـ الدردشة العادية: هضر بالدارجة المغربية بحال شاب، بجمل قصيرة وعفوية.
- فـ النقاش: دافع على رأيك بحجج منطقية وأمثلة وأرقام، فكك حجج الطرف الآخر بهدوء، وكون مقنع بلا كذب ولا تلاعب. إلا كان عندو الحق، اعترف.
- فـ الرياضيات والحسابات: استعمل تنفيذ الكود باش يكون الجواب دقيق.
- فـ التمارين والأسئلة الصعيبة: حل خطوة خطوة وشرح، وعطي الجواب النهائي بوضوح.
- إلا جاتك صورة: قراها وحل ما فيها. إلا جاك فويس: سمعو وجاوب. إلا جاك فيديو ولا PDF: فهمو ولخصو وجاوب على لي طلب.
- إلا طلب منك أغنية: استعمل البحث وجيب سمية الأغنية والفنان ورابط يوتيوب الرسمي الحقيقي (ماشي مخترع). ما كتصيفطش ملف الصوت. إلا ما لقيتيش الرابط، عطيه: https://www.youtube.com/results?search_query=سمية+الأغنية+الفنان
- إلا بغى يراجع درس: شرحو بالدارجة خطوة خطوة بأمثلة بسيطة، ولخصو فـ نقط، وصاوب ليه أسئلة تدريب وصححها ليه. إلا صيفط صورة ولا PDF ديال الدرس، قراه ودرسو منو.
- إلا سولك على شي حاجة جديدة ولا أخبار، استعمل البحث.
- جاوب بنفس اللغة اللي كيهضر بها الشخص.
- ما تعطي وعد ولا موعد ولا تهضر على الفلوس. قول "غنرجع ليك".
- إلا سولك شي واحد بجد واش نتا بوت، قول ليه الحقيقة: نتا مساعد ذكاء اصطناعي كيجاوب بلاصة مروان.

الذاكرة (على هاد الشخص وحدو، ما تكشفها لحتى واحد آخر):
${mem}
الدفتر ديالو:
${notes}
- إلا قال شي حاجة ثابتة على راسو ولا طلب منك تتفكر: remember_fact. تنسى: forget_fact. ملاحظة ولا مهمة: add_note. مسح ملاحظة: delete_note.
- ما تحفظ كلمة سر ولا رقم بطاقة ولا هوية ولا معلومات صحية ولا مالية.
- ملي تحفظ شي حاجة، قولها بجملة وحدة قصيرة.`;
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
            convo.push({
              role: "user",
              parts: calls.map((c) => ({
                functionResponse: {
                  name: c.name,
                  response: { result: runTool(jid, c.name, c.args || {}) },
                },
              })),
            });
            continue;
          }
          if (res.text) return res.text;
          break;
        }
      } catch (e) {
        console.error("ERROR with " + model + " tools#" + i + ":", e.message);
        if (String(e.message).includes("429")) break;
      }
    }
  }
  return null;
}

async function ensureYtDlp() {
  if (fs.existsSync(YTDLP)) return true;
  try {
    const res = await fetch(
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux"
    );
    if (!res.ok) throw new Error("HTTP " + res.status);
    fs.writeFileSync(YTDLP, Buffer.from(await res.arrayBuffer()));
    fs.chmodSync(YTDLP, 0o755);
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
      "--no-playlist", "--no-warnings", "--max-filesize", "40M",
      "-f", "b[ext=mp4]/b", "-o", "/tmp/" + base + ".%(ext)s", url,
    ];
    const p = spawn(YTDLP, args);
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
      const buf = fs.readFileSync("/tmp/" + file);
      fs.rmSync("/tmp/" + file, { force: true });
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
    if (!m || !m.message) return;
    const jid = m.key.remoteJid;
    if (jid.endsWith("@g.us") || jid === "status@broadcast") return;

    const msg = m.message;
    const img = msg.imageMessage;
    const audio = msg.audioMessage;
    const video = msg.videoMessage;
    const doc =
      msg.documentMessage ||
      msg.documentWithCaptionMessage?.message?.documentMessage;
    const text =
      msg.conversation ||
      msg.extendedTextMessage?.text ||
      img?.caption ||
      video?.caption ||
      doc?.caption ||
      "";
    if (!text && !img && !audio && !video && !doc) return;

    if (m.key.fromMe) {
      let reply = "";
      if (text === ".stop") {
        enabled = false;
        reply = "⏸️ البوت وقف";
      } else if (text === ".start") {
        enabled = true;
        reply = "▶️ البوت خدام";
      } else if (text === ".reset") {
        for (const k of Object.keys(histories)) delete histories[k];
        reply = "🧹 تمسحات المحادثات الأخيرة";
      } else if (text === ".wipe") {
        data = { users: {} };
        saveData();
        reply = "🗑️ تمسحات الذاكرة والملاحظات ديال الكل";
      }
      if (reply) await sock.sendMessage(jid, { text: reply });
      return;
    }

    if (!enabled) return;

    if (overLimit(jid)) {
      if (hits[jid].length === LIMIT_PER_HOUR + 1) {
        await sock.sendMessage(jid, {
          text: "صيفطتي بزاف ديال الرسائل، عاود من بعد شوية 🙏",
        });
      }
      return;
    }

    const igMatch = text.match(IG_REGEX);
    if (igMatch && !img && !video && !doc && !audio) {
      await sock.sendPresenceUpdate("composing", jid);
      const buf = await downloadInstagram(igMatch[0]);
      if (buf) {
        await sock.sendMessage(jid, { video: buf, mimetype: "video/mp4", caption: "🎬" });
      } else {
        await sock.sendMessage(jid, {
          text: "ما قدرتش نحمل الفيديو. ممكن إنستغرام بلوكا الطلب، ولا الفيديو خاص، ولا كبير بزاف 🙏",
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
        if (buffer.length > MAX_FILE) {
          await sock.sendMessage(jid, {
            text: "الملف كبير بزاف (أكثر من 15 MB)، صيفط شي حاجة أصغر 🙏",
          });
          return;
        }
        const fallback = img ? "image/jpeg" : audio ? "audio/ogg" : video ? "video/mp4" : "application/pdf";
        parts.push({
          inlineData: {
            mimeType: (media.mimetype || fallback).split(";")[0],
            data: buffer.toString("base64"),
          },
        });
        label = img ? "[صورة] " : audio ? "[فويس] " : video ? "[فيديو] " : "[PDF] ";
      } catch (e) {
        console.error("MEDIA ERROR:", e.message);
        await sock.sendMessage(jid, { text: "ما قدرتش نحل الملف، عاود صيفطو 🙏" });
        return;
      }
    }

    let prompt = text;
    if (!prompt && img) prompt = "حل ليا هاد التمرين لي فـ الصورة.";
    if (!prompt && audio) prompt = "سمع هاد الفويس وجاوب على لي قال فيه.";
    if (!prompt && video) prompt = "شوف هاد الفيديو ولخصو ليا.";
    if (!prompt && doc) prompt = "لخص ليا هاد الملف وعطيني النقط المهمة فيه.";
    parts.push({ text: prompt });

    const history = (histories[jid] ||= []);
    await sock.sendPresenceUpdate("composing", jid);
    const answer = await askGemini(jid, [...history, { role: "user", parts: parts }]);

    if (!answer) {
      await sock.sendMessage(jid, {
        text: "البوت مشغول دابا، عاود صيفط من بعد دقيقة 🙏",
      });
      return;
    }

    history.push({ role: "user", parts: [{ text: label + prompt }] });
    history.push({ role: "model", parts: [{ text: answer }] });
    history.splice(0, Math.max(0, history.length - 20));

    await sleep(1500 + Math.random() * 2500);
    await sock.sendMessage(jid, { text: answer });
  });
}

start();
