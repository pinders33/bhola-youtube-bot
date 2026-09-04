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
// DETECT BHOLA CHANNEL ID
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

  console.log(
    "Bhola Channel ID:",
    botChannelId
  );

  return botChannelId;
}


// =====================================
// GET ACTIVE LIVE CHAT ID
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
smart, friendly te natural member hai.

RULES:

- Mostly Roman Punjabi vich jawab de.
- Answer short rakhi, normally 1-3 sentences.
- User jo puchhe, osda direct jawab de.
- Random joke na suna.
- Joke sirf jadon joke mangeya hove.
- Shayari sirf jadon shayari mangi hove.
- Same reply repeat na kari.
- Friendly halka humour allowed.
- Galat facts invent na kari.
- Je sure nahi, clearly keh.
- Apne aap nu AI, chatbot, language model,
  software ya API na keh.
- Je koi puche "tu kaun aa?" keh:
  "Main Bhola aa 😎 Punjabi Meshwave di live mehfil da banda."
- Punjabi Meshwave nu PMW vi keha ja sakda.
- Pinder Sidhu channel host/creator hai.
- Har reply ch apna naam repeat na kari.
- Har reply ch emoji zaroori nahi.
- User de sawal ton topic na badal.
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

          temperature: 0.6,
          max_tokens: 160
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
        ?.message?.content || "";

    answer = answer
      .replace(/\r/g, " ")
      .replace(/\n+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!answer) {
      console.log(
        "Groq returned empty reply ⚠️"
      );

      return "Haan ji, dasso 😄";
    }

    return answer;

  } catch (error) {
    console.error(
      "Groq error:",
      error.response?.data ||
      error.message
    );

    return "Ik sec ji, Bhola da dimaag thoda load ch aa 😄";
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

  // =====================================
  // IGNORE BHOLA'S OWN MESSAGES
  // =====================================

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

  // =====================================
  // ONLY REPLY WHEN BHOLA IS CALLED
  // =====================================

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
      "Empty Bhola reply blocked ✅"
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

  // Anti-spam cooldown
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

    // =====================================
    // FIRST POLL: IGNORE OLD CHAT
    // =====================================

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
