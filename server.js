const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 10000;

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

// Punjabi Meshwave live video ID
const TARGET_VIDEO_ID = process.env.TARGET_VIDEO_ID;

// After OAuth, we will put this in Render
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

let botRunning = false;
let nextPageToken = null;
let seen = new Set();

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

app.get("/", (req, res) => {
  res.send(`
    <h2>Bhola YouTube Bot 😎</h2>
    <p>Server running.</p>
    <p><a href="/auth">Connect Bhola YouTube Account</a></p>
  `);
});


// ========================================
// GOOGLE LOGIN
// ========================================

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


// ========================================
// GOOGLE CALLBACK
// ========================================

app.get("/oauth2callback", async (req, res) => {

  try {

    const code = req.query.code;

    const { tokens } =
      await oauth2Client.getToken(code);

    oauth2Client.setCredentials(tokens);

    console.log("OAuth successful");

    if (tokens.refresh_token) {

      res.send(`
        <h2>Bhola connected ✅</h2>

        <p>Copy the refresh token below and put it in Render as:</p>

        <b>GOOGLE_REFRESH_TOKEN</b>

        <br><br>

        <textarea
          style="width:90%;height:120px"
          readonly>${tokens.refresh_token}</textarea>

        <p>
        Keep this private. Do not send it to anyone.
        </p>
      `);

    } else {

      res.send(`
        <h2>Connected ✅</h2>
        <p>No new refresh token returned.</p>
      `);
    }

  } catch (error) {

    console.error(error);

    res.status(500).send(
      "OAuth error: " + error.message
    );
  }

});


// ========================================
// GET LIVE CHAT ID
// ========================================

async function getLiveChatId() {

  if (!TARGET_VIDEO_ID)
    throw new Error("TARGET_VIDEO_ID missing");

  const response =
    await youtube.videos.list({
      part: ["liveStreamingDetails"],
      id: [TARGET_VIDEO_ID]
    });

  const video = response.data.items &&
                response.data.items[0];

  if (!video)
    throw new Error("Live video not found");

  const details =
    video.liveStreamingDetails;

  if (!details ||
      !details.activeLiveChatId) {

    throw new Error(
      "Live chat not active yet"
    );
  }

  return details.activeLiveChatId;
}


// ========================================
// GROQ
// ========================================

async function askBhola(username, question) {

  const systemPrompt = `
Tera naam Bhola hai.

Tu Punjabi Meshwave YouTube live chat da
smart, friendly te funny banda hai.

Rules:

- Mostly Roman Punjabi vich jawab de.
- Replies short rakh, normally 1-3 sentences.
- Sawal da direct jawab de.
- Random joke na suna.
- Joke sirf joke mangan te suna.
- Shayari sirf mangan te de.
- Friendly halka humour use kar.
- Same reply baar baar repeat na kar.
- Galat facts invent na kar.
- Apne aap nu AI, chatbot, software
  ya language model na keh.
- Je koi puche "tu kaun aa?" keh:
  "Main Bhola aa 😎 Punjabi Meshwave
  di live mehfil da banda."
- Punjabi Meshwave nu PMW vi keha ja sakda.
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
              `Username: ${username}\n` +
              `Message: ${question}`
          }
        ],

        temperature: 0.7,
        max_tokens: 150
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

  return response
    .data
    .choices[0]
    .message
    .content
    .replace(/\n/g, " ")
    .trim();
}


// ========================================
// SEND YOUTUBE MESSAGE
// ========================================

async function sendMessage(
  liveChatId,
  text
) {

  await youtube.liveChatMessages.insert({

    part: ["snippet"],

    requestBody: {

      snippet: {

        liveChatId: liveChatId,

        type: "textMessageEvent",

        textMessageDetails: {
          messageText: text
        }
      }
    }
  });
}


// ========================================
// CHECK CHAT
// ========================================

async function checkChat() {

  if (!REFRESH_TOKEN)
    return;

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

    for (const item of messages) {

      if (seen.has(item.id))
        continue;

      seen.add(item.id);

      if (seen.size > 1000) {
        seen.clear();
      }

      if (
        item.snippet.type !==
        "textMessageEvent"
      )
        continue;

      const text =
        item.snippet
          .textMessageDetails
          .messageText || "";

      const lower =
        text.toLowerCase();

      // Only reply when called
      if (
        !lower.includes("bhola") &&
        !text.includes("ਭੋਲਾ")
      )
        continue;

      // Don't reply to own messages
      if (
        item.authorDetails &&
        item.authorDetails.isChatOwner
      )
        continue;

      const username =
        item.authorDetails
          ?.displayName ||
        "viewer";

      let question = text
        .replace(/bhola/ig, "")
        .replace(/ਭੋਲਾ/g, "")
        .trim();

      if (!question) {
        question =
          "Sat sri akaal da short friendly reply de.";
      }

      console.log(
        `${username}: ${question}`
      );

      const answer =
        await askBhola(
          username,
          question
        );

      const finalReply =
        `@${username} ${answer}`
          .slice(0, 400);

      await sendMessage(
        liveChatId,
        finalReply
      );

      // Small cooldown
      await new Promise(
        resolve =>
          setTimeout(resolve, 2500)
      );
    }

    const wait =
      response.data.pollingIntervalMillis ||
      5000;

    setTimeout(checkChat, wait);

  } catch (error) {

    console.error(
      "Bhola error:",
      error.response?.data ||
      error.message
    );

    setTimeout(checkChat, 10000);
  }
}


// ========================================
// START
// ========================================

app.listen(PORT, "0.0.0.0", () => {

  console.log(
    `Bhola server running on ${PORT}`
  );

  if (
    REFRESH_TOKEN &&
    !botRunning
  ) {

    botRunning = true;

    setTimeout(
      checkChat,
      5000
    );
  }
});
