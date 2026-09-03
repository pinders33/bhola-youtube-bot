const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 10000;

// ===============================
// ENVIRONMENT VARIABLES
// ===============================

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL =
  process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const TARGET_VIDEO_ID = process.env.TARGET_VIDEO_ID;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;


// ===============================
// GOOGLE OAUTH
// ===============================

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


// ===============================
// BOT STATE
// ===============================

let botChannelId = null;
let nextPageToken = null;
let seenMessages = new Set();
let firstPoll = true;
let botStarted = false;


// ===============================
// HOME PAGE
// ===============================

app.get("/", (req, res) => {
  res.send(`
    <h2>Bhola YouTube Bot 😎</h2>
    <p>Server running ✅</p>
    <p><a href="/auth">Connect Bhola YouTube Account</a></p>
  `);
});


// ===============================
// GOOGLE AUTH
// ===============================

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


// ===============================
// GOOGLE CALLBACK
// ===============================

app.get("/oauth2callback", async (req, res) => {

  try {

    const code = req.query.code;

    if (!code) {
      return res.status(400).send(
        "Google authorization code missing."
      );
    }

    const { tokens } =
      await oauth2Client.getToken(code);

    oauth2Client.setCredentials(tokens);

    console.log("Google OAuth successful ✅");

    if (tokens.refresh_token) {

      res.send(`
        <h2>Bhola connected ✅</h2>

        <p>
        Copy this refresh token and save it
        in Render as:
        </p>

        <b>GOOGLE_REFRESH_TOKEN</b>

        <br><br>

        <textarea
          style="width:90%;height:120px"
          readonly>${tokens.refresh_token}</textarea>

        <p>
        Keep this token private.
        </p>
      `);

    } else {

      res.send(`
        <h2>Bhola connected ✅</h2>

        <p>
        Google did not return a new refresh token.
        Existing token may still be valid.
        </p>
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


// ===============================
// FIND BHOLA'S OWN CHANNEL ID
// ===============================

async function getBotChannelId() {

  try {

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

  } catch (error) {

    console.error(
      "Could not detect Bhola channel:",
      error.response?.data || error.message
    );

    throw error;
  }
}


// ===============================
// GET LIVE CHAT ID
// ===============================

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
    response.data.items &&
    response.data.items[0];

  if (!video) {
    throw new Error(
      "YouTube live video not found"
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


// ===============================
// ASK GROQ / BHOLA
// ===============================

async function askBhola(
  username,
  question
) {

  const systemPrompt = `
Tera naam Bhola hai.

Tu Punjabi Meshwave YouTube live chat da
smart, friendly te entertaining member hai.

RULES:

1. Mostly Roman Punjabi vich jawab de.

2. Answer short rakhi.
Normally 1 to 3 sentences.

3. User de actual sawal da direct jawab de.

4. Random joke na suna.

5. Joke sirf jadon user joke mange.

6. Shayari sirf jadon user shayari mange.

7. Same reply repeatedly na kari.

8. Friendly halka funny style rakh.

9. Galat facts invent na kari.

10. Apne aap nu AI, chatbot,
language model ya software na keh.

11. Je koi puche "tu kaun aa?"
jawab de:
"Main Bhola aa 😎 Punjabi Meshwave di live mehfil da banda."

12. Punjabi Meshwave nu PMW vi keha ja sakda.

13. Pinder Sidhu channel host/creator hai.

14. User nu disrespect, abuse ya unnecessary
argument na kari.

15. Har message ch apna naam Bhola repeat
karan di lod nahi.

16. YouTube live chat layi natural reply de.

17. Emojis occasionally use kar,
har sentence ch nahi.

18. User je simple question puche,
simple answer hi de.

19. User di private information guess na kari.

20. Answer useful te conversational rakhi.
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

        temperature: 0.7,
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
    response.data
      ?.choices
      ?.[0]
      ?.message
      ?.content;

  if (!answer) {
    return "";
  }

  answer = answer
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return answer;
}


// ===============================
// SEND YOUTUBE MESSAGE
// ===============================

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


// ===============================
// PROCESS ONE MESSAGE
// ===============================

async function processMessage(
  item,
  liveChatId
) {

  // Already processed
  if (seenMessages.has(item.id)) {
    return;
  }

  seenMessages.add(item.id);


  // Keep memory reasonable
  if (seenMessages.size > 2000) {

    const arr =
      Array.from(seenMessages);

    seenMessages =
      new Set(
        arr.slice(-1000)
      );
  }


  // Only normal text messages
  if (
    item.snippet?.type !==
    "textMessageEvent"
  ) {
    return;
  }


  const authorChannelId =
    item.authorDetails?.channelId;


  // ==================================
  // MOST IMPORTANT FIX:
  // IGNORE BHOLA'S OWN MESSAGES
  // ==================================

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


  // ==================================
  // ONLY ANSWER IF BHOLA IS CALLED
  // ==================================

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


  // Remove Bhola name from question

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


  try {

    const answer =
      await askBhola(
        username,
        question
      );


    if (!answer) {
      return;
    }


    const finalReply =
      `@${username} ${answer}`
        .slice(0, 400);


    await sendMessage(
      liveChatId,
      finalReply
    );


    console.log(
      `Bhola replied to ${username} ✅`
    );


    // Small anti-spam cooldown
    await new Promise(
      resolve =>
        setTimeout(resolve, 2500)
    );

  } catch (error) {

    console.error(
      "Reply error:",
      error.response?.data ||
      error.message
    );
  }
}


// ===============================
// CHECK YOUTUBE CHAT
// ===============================

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


    // ==================================
    // FIRST POLL:
    // MARK OLD MESSAGES AS SEEN
    // DON'T ANSWER OLD CHAT
    // ==================================

    if (firstPoll) {

      for (const item of messages) {

        seenMessages.add(item.id);
      }

      firstPoll = false;

      console.log(
        "Initial chat loaded. Waiting for new Bhola messages ✅"
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
      response.data.pollingIntervalMillis ||
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


// ===============================
// START BOT
// ===============================

async function startBhola() {

  if (botStarted) {
    return;
  }

  botStarted = true;


  if (!REFRESH_TOKEN) {

    console.log(
      "GOOGLE_REFRESH_TOKEN missing. OAuth required."
    );

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


// ===============================
// SERVER START
// ===============================

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
