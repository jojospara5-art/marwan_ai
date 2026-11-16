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
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_MODELS = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];
const WHISPER_MODEL = "whisper-large-v3-turbo";
const MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3.5-flash"];
const MAX_FILE = 15 * 1024 * 1024;
const DATA_FILE = "auth/memory.json";
const YTDLP = "/tmp/yt-dlp";
const IG_REGEX = /https?:\/\/(?:www\.)?instagram\.com\/(?:reels?|p|tv)\/[\w-]+\S*/i;
const NEEDS_GEMINI = /أخبار|اخبار|نتيجة|نتائج|ثمن|سعر|أغنية|اغنية|أغاني|اغاني|طقس|مباراة|احسب|معادلة|مشتقة|تكامل|news|latest|price|score|weather|song|calculate|equation|integral/i;
const LIMIT_PER_HOUR = 30;

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

const hits = {};
function overLimit(jid) {
  const now = Date.now();
  const arr = (hits[jid] = (hits[jid] || []).filter((t) => now - t < 3600000));
  arr.push(now);
  return arr.length > LIMIT_PER_HOUR;
}

// ---------- الأدوات (للجوج ديال المحركات) ----------
const TOOL_DEFS = [
  { name: "remember_fact", description: "حفظ معلومة ثابتة على الشخص (ماشي كلمات سر ولا صحة ولا فلوس)", props: { fact: ["string", "المعلومة"] }, required: ["fact"] },
  { name: "forget_fact", description: "مسح معلومة محفوظة", props: { keyword: ["string", "كلمة من المعلومة"] }, required: ["keyword"] },
  { name: "add_note", description: "تسجيل ملاحظة فـ دفتر الشخص", props: { text: ["string", "النص"] }, required: ["text"] },
  { name: "delete_note", description: "مسح ملاحظة بالنمرة (من 1)", props: { number: ["integer", "النمرة"] }, required: ["number"] },
];

function buildProps(defProps, upper) {
  const out = {};
  for (const k of Object.keys(defProps)) {
    const kind = defProps[k][0];
    out[k] = {
      type: upper ? Type[kind.toUpperCase()] : kind,
      description: defProps[k][1],
    };
  }
  return out;
}

const GEM_FUNCTIONS = TOOL_DEFS.map((d) => ({
  name: d.name,
  description: d.description,
  parameters: { type: Type.OBJECT, properties: buildProps(d.props, true), required: d.required },
}));

const GROQ_TOOLS = TOOL_DEFS.map((d) => ({
  type: "function",
  function: {
    name: d.name,
    description: d.description,
    parameters: { type: "object", properties: buildProps(d.props, false), required: d.required },
  },
}));

const TOOLSETS = [
  [{ googleSearch: {} }, { codeExecution: {} }, { functionDeclarations: GEM_FUNCTIONS }],
  [{ functionDeclarations: GEM_FUNCTIONS }],
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

// ---------- البرومبت ----------
function systemPrompt(jid, lite) {
  const today = new Date().toISOString().slice(0, 10);
  const u = getUser(jid);
  const mem = u.memory.length ? u.memory.map((f) => "- " + f).join("\n") : "(والو)";
  const notes = u.notes.length ? u.notes.map((n, i) => i + 1 + ". " + n).join("\n") : "(خاوي)";
  const searchLine = lite
    ? "- ما عندكش بحث ولا أنترنت. إلا سولك على أخبار جديدة ولا أثمنة ولا شي حاجة كتبدل، قول ليه ما عندكش معلومات محينة."
    : "- إلا سولك على شي حاجة جديدة ولا أخبار، استعمل البحث.";
  const mathLine = lite
    ? "- فـ الحسابات: دير الحساب خطوة خطوة وراجعو مزيان قبل ما تعطي الجواب."
    : "- فـ الرياضيات والحسابات: استعمل تنفيذ الكود باش يكون الجواب دقيق.";
  const songLine = lite
    ? "- إلا طلب منك أغنية: عطيه سمية الأغنية والفنان ورابط البحث: https://www.youtube.com/results?search_query=سمية+الأغنية+الفنان . ما تخترعش روابط."
    : "- إلا طلب منك أغنية: استعمل البحث وجيب سمية الأغنية والفنان ورابط يوتيوب الرسمي الحقيقي (ماشي مخترع). ما كتصيفطش ملف الصوت. إلا ما لقيتيش الرابط، عطيه: https://www.youtube.com/results?search_query=سمية+الأغنية+الفنان";
  return `نتا كتجاوب بلاصة مروان فـ واتساب. تاريخ اليوم: ${today}.
نتا شخص مثقف وذكي بزاف وكتفهم فـ كلشي: دراسة، لغات، علوم، رياضيات، تقنية، دين، فلسفة، حياة، نصائح.

قواعد الجواب:
- جاوب بدقة ومعلومات صحيحة. إلا ما كنتيش متأكد قول "ما متأكدش" وما تخترعش.
- فـ الدردشة العادية: هضر بالدارجة المغربية بحال شاب، بجمل قصيرة وعفوية.
- فـ النقاش: دافع على رأيك بحجج منطقية وأمثلة وأرقام، فكك حجج الطرف الآخر بهدوء، وكون مقنع بلا كذب ولا تلاعب. إلا كان عندو الحق، اعترف.
${mathLine}
- فـ التمارين والأسئلة الصعيبة: حل خطوة خطوة وشرح، وعطي الجواب النهائي بوضوح.
- إلا جاتك صورة: قراها وحل ما فيها. إلا جاك فويس: جاوب على لي قال. إلا جاك فيديو ولا PDF: فهمو ولخصو وجاوب على لي طلب.
${songLine}
- إلا بغى يراجع درس: شرحو بالدارجة خطوة خطوة بأمثلة بسيطة، ولخصو فـ نقط، وصاوب ليه أسئلة تدريب وصححها ليه.
${searchLine}
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

// ---------- Groq ----------
async function groqChat(body) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + GROQ_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 200));
  }
  return res.json();
}

async function askGroq(jid, history, userText) {
  if (!GROQ_KEY) return null;
  for (const model of GROQ_MODELS) {
    try {
      const messages = [
        { role: "system", content: systemPrompt(jid, true) },
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: "user", content: userText },
      ];
      for (let step = 0; step < 4; step++) {
        const out = await groqChat({
          model: model,
          messages: messages,
          tools: GROQ_TOOLS,
          tool_choice: "auto",
          temperature: 0.7,
        });
        const msg = out.choices[0].message;
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          messages.push({
            role: "assistant",
            content: msg.content || "",
            tool_calls: msg.tool_calls,
          });
          for (const tc of msg.tool_calls) {
            let args = {};
            try {
              args = JSON.parse(tc.function.arguments || "{}");
            } catch (e) {}
            const result = runTool(jid, tc.function.name, args);
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify(result),
            });
          }
          continue;
        }
        if (msg.content) return msg.content;
        break;
      }
    } catch (e) {
      console.error("GROQ ERROR with " + model + ":", e.message);
    }
  }
  return null;
}

async function transcribe(buffer, mime) {
  if (!GROQ_KEY) return null;
  try {
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mime || "audio/ogg" }), "voice.ogg");
    form.append("model", WHISPER_MODEL);
    form.append("response_format", "json");
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer " + GROQ_KEY },
      body: form,
    });
    if (!res.ok) {
      throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 200));
    }
    const j = await res.json();
    return (j.text || "").trim() || null;
  } catch (e) {
    console.error("WHISPER ERROR:", e.message);
    return null;
  }
}

// ---------- Gemini ----------
function geminiHistory(history) {
  return history.map((h) => ({
    role: h.role === "assistant" ? "model" : "user",
    parts: [{ text: h.content }],
  }));
}

async function askGemini(jid, contents) {
  for (const model of MODELS) {
    for (let i = 0; i < TOOLSETS.length; i++) {
      try {
        const convo = [...contents];
        const config = { systemInstruction: systemPrompt(jid, false) };
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
        console.error("GEMINI ERROR with " + model + " tools#" + i + ":", e.message);
        if (String(e.message).includes("429")) break;
      }
    }
  }
  return null;
}

// ---------- إنستغرام ----------
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

// ---------- البوت ----------
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
    let prompt = text;
    let transcribed = false;

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
        const mime = (media.mimetype || fallback).split(";")[0];
        label = img ? "[صورة] " : audio ? "[فويس] " : video ? "[فيديو] " : "[PDF] ";

        if (audio) {
          const t = await transcribe(buffer, mime);
          if (t) {
            transcribed = true;
            prompt = t;
          }
        }
        if (!transcribed) {
          parts.push({ inlineData: { mimeType: mime, data: buffer.toString("base64") } });
        }
      } catch (e) {
        console.error("MEDIA ERROR:", e.message);
        await sock.sendMessage(jid, { text: "ما قدرتش نحل الملف، عاود صيفطو 🙏" });
        return;
      }
    }

    if (!prompt && img) prompt = "حل ليا هاد التمرين لي فـ الصورة.";
    if (!prompt && audio) prompt = "سمع هاد الفويس وجاوب على لي قال فيه.";
    if (!prompt && video) prompt = "شوف هاد الفيديو ولخصو ليا.";
    if (!prompt && doc) prompt = "لخص ليا هاد الملف وعطيني النقط المهمة فيه.";
    parts.push({ text: prompt });

    const history = (histories[jid] ||= []);
    await sock.sendPresenceUpdate("composing", jid);

    const needsGemini = (media && !transcribed) || NEEDS_GEMINI.test(prompt);
    let answer = null;
    let engine = "";

    if (!needsGemini) {
      answer = await askGroq(jid, history, prompt);
      if (answer) engine = "groq";
    }
    if (!answer) {
      answer = await askGemini(jid, [
        ...geminiHistory(history),
        { role: "user", parts: parts },
      ]);
      if (answer) engine = "gemini";
    }
    if (!answer && needsGemini && !(media && !transcribed)) {
      answer = await askGroq(jid, history, prompt);
      if (answer) engine = "groq-fallback";
    }
    console.log("ANSWER via", engine || "none");

    if (!answer) {
      await sock.sendMessage(jid, {
        text: "البوت مشغول دابا، عاود صيفط من بعد دقيقة 🙏",
      });
      return;
    }

    history.push({ role: "user", content: label + prompt });
    history.push({ role: "assistant", content: answer });
    history.splice(0, Math.max(0, history.length - 20));

    await sleep(1500 + Math.random() * 2500);
    await sock.sendMessage(jid, { text: answer });
  });
}

start();
