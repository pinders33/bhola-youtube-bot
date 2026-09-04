const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 10000;

// =====================================
// ENVIRONMENT VARIABLES
// =====================================

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL =
  process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const TARGET_VIDEO_ID = process.env.TARGET_VIDEO_ID;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;


// =====================================
// GOOGLE OAUTH
// =====================================

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

if (REFRESH_TOKEN) {
  oauth2Client.setCredentials({
    refresh_token: REFRESH_TOKEN
  });
}

const youtube = google.youtube({
  version: "v3",
  auth: oauth2Client
});


// =====================================
// BOT STATE
// =====================================

let botChannelId = null;
let nextPageToken = null;
let seenMessages = new Set();
let firstPoll = true;
let botStarted = false;


// =====================================
// HOME
// =====================================

app.get("/", (req, res) => {
  res.send(`
    <h2>Bhola YouTube Bot 😎</h2>
    <p>Server running ✅</p>
    <p><a href="/auth">Connect Bhola YouTube Account</a></p>
  `);
});


// =====================================
// GOOGLE AUTH
// =====================================

app.get("/auth", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/youtube"
    ]
  });

  res.redirect(url);
});


// =====================================
// OAUTH CALLBACK
// =====================================

app.get("/oauth2callback", async (req, res) => {
  try {
    const code = req.query.code;

    if (!code) {
      return res
        .status(400)
        .send("Authorization code missing.");
    }

    const { tokens } =
      await oauth2Client.getToken(code);

    oauth2Client.setCredentials(tokens);

    console.log("Google OAuth successful ✅");

    if (tokens.refresh_token) {
      res.send(`
        <h2>Bhola connected ✅</h2>
        <p>Save this as GOOGLE_REFRESH_TOKEN in Render:</p>

        <textarea
          style="width:90%;height:120px"
          readonly>${tokens.refresh_token}</textarea>

        <p>Keep this private.</p>
      `);
    } else {
      res.send(`
        <h2>Bhola connected ✅</h2>
        <p>No new refresh token returned.</p>
      `);
    }

  } catch (error) {
    console.error(
      "OAuth error:",
      error.response?.data || error.message
    );

    res.status(500).send(
      "OAuth error: " + error.message
    );
  }
});


// =====================================
// DETECT BHOLA CHANNEL
// =====================================

async function getBotChannelId() {
  const response =
    await youtube.channels.list({
      part: ["snippet"],
      mine: true
    });

  const channels =
    response.data.items || [];

  if (channels.length === 0) {
    throw new Error(
      "Authenticated YouTube channel not found"
    );
  }

  botChannelId = channels[0].id;

  console.log(
    "Bhola channel detected:",
    channels[0].snippet?.title || botChannelId
  );

  return botChannelId;
}


// =====================================
// GET LIVE CHAT ID
// =====================================

async function getLiveChatId() {
  if (!TARGET_VIDEO_ID) {
    throw new Error(
      "TARGET_VIDEO_ID missing in Render"
    );
  }

  const response =
    await youtube.videos.list({
      part: ["liveStreamingDetails"],
      id: [TARGET_VIDEO_ID]
    });

  const video =
    response.data.items?.[0];

  if (!video) {
    throw new Error(
      "Live video not found"
    );
  }

  const details =
    video.liveStreamingDetails;

  if (
    !details ||
    !details.activeLiveChatId
  ) {
    throw new Error(
      "Live chat is not active"
    );
  }

  return details.activeLiveChatId;
}


// =====================================
// ASK GROQ
// =====================================

async function askBhola(
  username,
  question
) {
  try {
    const systemPrompt = `
Tera naam Bhola hai.

Tu Punjabi Meshwave YouTube live chat da
smart, natural, friendly te useful banda hai.

SAB TON IMPORTANT RULES:

- HAR valid message da textual jawab de.
- Kade vi blank, empty ya sirf whitespace response na de.
- User jo puchhe, pehla OS GAL DA DIRECT JAWAB de.
- Random joke, shayari, story, motivational line
  ya hor topic apne wallon shuru na kari.
- Joke sirf jadon joke mangeya hove.
- Shayari sirf jadon shayari mangi hove.

UNKNOWN / PERSONAL INFO:

- Je kise real bande bare private/personal info pata nahi,
  guess na kari.
- Simple natural jawab de:
  "Menu ni pta ji 😄"
  ya context de hisaab naal:
  "Oh Sukh hi dass sakda ji 😄"

Examples:

User: 2+2 kina?
Answer: 4 ji 😄

User: UAE di capital ki aa?
Answer: Abu Dhabi aa ji.

User: Sukh di gf kithe aa?
Answer: Menu ni pta ji 😄 Sukh nu hi pucho.

User: Aman ajj kithe aa?
Answer: Menu ni pta ji, Aman hi dass sakda.

User: tu ki kr reha?
Answer: Bas live mehfil sambhal reha aa 😄

User: tera ki haal aa?
Answer: Vadiya ji 😎

STYLE:

- Mostly Roman Punjabi use kar.
- Punjabi-English mix allowed.
- Normally 1-3 short sentences.
- Answer natural hove.
- Same fixed reply baar-baar repeat na kari.
- Friendly halka humour allowed,
  par relevant hona chahida.
- Galat facts invent na kari.
- Je sure nahi, clearly keh ke sure nahi.
- Har reply ch emoji zaroori nahi.
- Har reply ch apna naam repeat na kari.
- Har jawab de end ch question zaroori nahi.
- User de sawal ton topic na badal.
- User di private information guess na kari.

IDENTITY:

Je koi puche:
"tu kaun aa?"
"who are you?"
"tera naam ki aa?"

Jawab:
"Main Bhola aa 😎 Punjabi Meshwave di live mehfil da banda."

Apne aap nu AI, chatbot, language model,
software, Groq, GPT ya API na keh.

CHANNEL CONTEXT:

- Channel: Punjabi Meshwave
- PMW = Punjabi Meshwave
- Pinder Sidhu channel host/creator hai.
`;

    const response =
      await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: GROQ_MODEL,

          messages: [
            {
              role: "system",
              content: systemPrompt
            },
            {
              role: "user",
              content:
                `YouTube username: ${username}\n` +
                `Message: ${question}`
            }
          ],

          temperature: 0.35,
          max_tokens: 120
        },
        {
          headers: {
            Authorization:
              `Bearer ${GROQ_API_KEY}`,
            "Content-Type":
              "application/json"
          },

          timeout: 20000
        }
      );

    let answer =
      response.data?.choices?.[0]
        ?.message?.content;

    if (typeof answer !== "string") {
      answer = "";
    }

    answer = answer
      .replace(/\r/g, " ")
      .replace(/\n+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!answer) {
      console.log(
        "Groq gave blank reply - fallback used"
      );

      return "Menu ehda pata ni ji 😄";
    }

    return answer;

  } catch (error) {
    console.error(
      "Groq error:",
      error.response?.data ||
      error.message
    );

    return "Ik sec ji 😄 hun jawab dubara pucho.";
  }
}


// =====================================
// SEND YOUTUBE MESSAGE
// =====================================

async function sendMessage(
  liveChatId,
  text
) {
  const cleanText =
    String(text || "")
      .replace(/\r/g, " ")
      .replace(/\n+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  if (!cleanText) {
    console.log(
      "Blocked empty YouTube message ✅"
    );

    return;
  }

  await youtube.liveChatMessages.insert({
    part: ["snippet"],

    requestBody: {
      snippet: {
        liveChatId: liveChatId,
        type: "textMessageEvent",

        textMessageDetails: {
          messageText: cleanText
        }
      }
    }
  });
}


// =====================================
// PROCESS MESSAGE
// =====================================

async function processMessage(
  item,
  liveChatId
) {
  if (!item?.id) {
    return;
  }

  if (seenMessages.has(item.id)) {
    return;
  }

  seenMessages.add(item.id);

  if (seenMessages.size > 2000) {
    const arr =
      Array.from(seenMessages);

    seenMessages =
      new Set(
        arr.slice(-1000)
      );
  }

  if (
    item.snippet?.type !==
    "textMessageEvent"
  ) {
    return;
  }

  const authorChannelId =
    item.authorDetails?.channelId || "";

  // Ignore Bhola's own messages
  if (
    botChannelId &&
    authorChannelId === botChannelId
  ) {
    console.log(
      "Ignoring Bhola's own message ✅"
    );

    return;
  }

  const text =
    item.snippet
      ?.textMessageDetails
      ?.messageText || "";

  if (!text.trim()) {
    return;
  }

  const lower =
    text.toLowerCase();

  // Reply only when Bhola is called
  const calledBhola =
    lower.includes("bhola") ||
    text.includes("ਭੋਲਾ");

  if (!calledBhola) {
    return;
  }

  const username =
    item.authorDetails
      ?.displayName ||
    "viewer";

  let question =
    text
      .replace(/@?bhola/ig, "")
      .replace(/ਭੋਲਾ/g, "")
      .trim();

  if (!question) {
    question =
      "Sat sri akaal da short friendly reply de.";
  }

  console.log(
    `Question from ${username}: ${question}`
  );

  const answer =
    await askBhola(
      username,
      question
    );

  if (
    !answer ||
    !answer.trim()
  ) {
    console.log(
      "Empty answer blocked ✅"
    );

    return;
  }

  const finalReply =
    `@${username} ${answer}`
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400);

  if (!finalReply) {
    console.log(
      "Final reply empty - blocked ✅"
    );

    return;
  }

  try {
    await sendMessage(
      liveChatId,
      finalReply
    );

    console.log(
      `Bhola replied to ${username} ✅`
    );

  } catch (error) {
    console.error(
      "YouTube send error:",
      error.response?.data ||
      error.message
    );
  }

  await new Promise(
    resolve =>
      setTimeout(resolve, 2500)
  );
}


// =====================================
// CHECK CHAT
// =====================================

async function checkChat() {
  try {
    const liveChatId =
      await getLiveChatId();

    const response =
      await youtube.liveChatMessages.list({
        liveChatId: liveChatId,

        part: [
          "snippet",
          "authorDetails"
        ],

        maxResults: 200,

        pageToken:
          nextPageToken || undefined
      });

    nextPageToken =
      response.data.nextPageToken;

    const messages =
      response.data.items || [];

    // First poll: ignore old messages
    if (firstPoll) {
      for (const item of messages) {
        if (item?.id) {
          seenMessages.add(item.id);
        }
      }

      firstPoll = false;

      console.log(
        "Old chat loaded. Waiting for new Bhola messages ✅"
      );

    } else {
      for (const item of messages) {
        await processMessage(
          item,
          liveChatId
        );
      }
    }

    const wait =
      response.data
        .pollingIntervalMillis ||
      5000;

    setTimeout(
      checkChat,
      Math.max(wait, 3000)
    );

  } catch (error) {
    console.error(
      "Bhola chat error:",
      error.response?.data ||
      error.message
    );

    setTimeout(
      checkChat,
      10000
    );
  }
}


// =====================================
// START BHOLA
// =====================================

async function startBhola() {
  if (botStarted) {
    return;
  }

  botStarted = true;

  if (!REFRESH_TOKEN) {
    console.log(
      "GOOGLE_REFRESH_TOKEN missing ⚠️"
    );

    botStarted = false;
    return;
  }

  if (!GROQ_API_KEY) {
    console.log(
      "GROQ_API_KEY missing ⚠️"
    );

    botStarted = false;
    return;
  }

  try {
    await getBotChannelId();

    console.log(
      "Bhola ready 😎"
    );

    setTimeout(
      checkChat,
      3000
    );

  } catch (error) {
    botStarted = false;

    console.error(
      "Bhola startup failed:",
      error.response?.data ||
      error.message
    );
  }
}


// =====================================
// SERVER START
// =====================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Bhola server running on ${PORT}`
    );

    startBhola();
  }
);
