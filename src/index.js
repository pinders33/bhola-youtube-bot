// ============================================================
// BHOLA YOUTUBE LIVE BOT
// Cloudflare Worker - Stable Fast Polling Version
// ============================================================

const seenMessageIds = new Set();

let cachedBotChannelId = null;

// ============================================================
// BASIC HELPERS
// ============================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(value) {
  return String(value || "")
    .replace(/\r/g, " ")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=UTF-8"
    }
  });
}

function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=UTF-8"
      }
    }
  );
}

function rememberMessage(id) {
  if (!id) return;

  seenMessageIds.add(id);

  // Prevent unlimited memory growth
  if (seenMessageIds.size > 1000) {
    const values =
      Array.from(seenMessageIds);

    seenMessageIds.clear();

    for (
      const value of values.slice(-500)
    ) {
      seenMessageIds.add(value);
    }
  }
}

// ============================================================
// REQUIRED ENVIRONMENT VARIABLES
// ============================================================

function checkEnvironment(env) {
  const required = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
    "GROQ_API_KEY",
    "TARGET_VIDEO_ID"
  ];

  const missing =
    required.filter(
      (key) => !env[key]
    );

  return {
    ok: missing.length === 0,
    missing
  };
}

// ============================================================
// GOOGLE ACCESS TOKEN
// ============================================================

async function getGoogleAccessToken(env) {
  const body =
    new URLSearchParams();

  body.set(
    "client_id",
    env.GOOGLE_CLIENT_ID
  );

  body.set(
    "client_secret",
    env.GOOGLE_CLIENT_SECRET
  );

  body.set(
    "refresh_token",
    env.GOOGLE_REFRESH_TOKEN
  );

  body.set(
    "grant_type",
    "refresh_token"
  );

  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",

      headers: {
        "content-type":
          "application/x-www-form-urlencoded"
      },

      body
    }
  );

  const data = await response.json();

  if (
    !response.ok ||
    !data.access_token
  ) {
    console.log(
      "❌ Google token error:",
      JSON.stringify(data)
    );

    throw new Error(
      data.error_description ||
      data.error ||
      "Google access token failed"
    );
  }

  console.log(
    "✅ Google access token ready"
  );

  return data.access_token;
}

// ============================================================
// GOOGLE OAUTH URL
// ============================================================

function getGoogleAuthUrl(
  request,
  env
) {
  const currentUrl =
    new URL(request.url);

  const redirectUri =
    env.GOOGLE_REDIRECT_URI ||
    `${currentUrl.origin}/oauth2callback`;

  const params =
    new URLSearchParams({
      client_id:
        env.GOOGLE_CLIENT_ID,

      redirect_uri:
        redirectUri,

      response_type:
        "code",

      access_type:
        "offline",

      prompt:
        "consent",

      scope:
        "https://www.googleapis.com/auth/youtube"
    });

  return (
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    params.toString()
  );
}

// ============================================================
// GOOGLE OAUTH CALLBACK
// ============================================================

async function oauthCallback(
  request,
  env
) {
  const url =
    new URL(request.url);

  const code =
    url.searchParams.get("code");

  if (!code) {
    return htmlResponse(
      "<h2>Authorization code missing.</h2>",
      400
    );
  }

  const redirectUri =
    env.GOOGLE_REDIRECT_URI ||
    `${url.origin}/oauth2callback`;

  const body =
    new URLSearchParams();

  body.set("code", code);

  body.set(
    "client_id",
    env.GOOGLE_CLIENT_ID
  );

  body.set(
    "client_secret",
    env.GOOGLE_CLIENT_SECRET
  );

  body.set(
    "redirect_uri",
    redirectUri
  );

  body.set(
    "grant_type",
    "authorization_code"
  );

  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",

      headers: {
        "content-type":
          "application/x-www-form-urlencoded"
      },

      body
    }
  );

  const data = await response.json();

  if (!response.ok) {
    return htmlResponse(
      `<h2>OAuth failed ❌</h2>
       <p>${cleanText(
         data.error_description ||
         data.error ||
         "Unknown OAuth error"
       )}</p>`,
      500
    );
  }

  if (!data.refresh_token) {
    return htmlResponse(`
      <h2>Bhola connected ✅</h2>

      <p>
        Google ne nava refresh token nahi ditta.
      </p>

      <p>
        Existing GOOGLE_REFRESH_TOKEN use kar sakde ho.
      </p>
    `);
  }

  return htmlResponse(`
    <h2>Bhola connected ✅</h2>

    <p>
      Niche refresh token aa.
      Cloudflare ch GOOGLE_REFRESH_TOKEN update karo.
    </p>

    <textarea
      style="width:90%;height:140px"
      readonly
    >${data.refresh_token}</textarea>

    <p>Eh token private rakho.</p>
  `);
}

// ============================================================
// YOUTUBE API HELPER
// ============================================================

async function youtubeRequest(
  endpoint,
  accessToken,
  options = {}
) {
  const response = await fetch(
    `https://www.googleapis.com/youtube/v3/${endpoint}`,
    {
      ...options,

      headers: {
        Authorization:
          `Bearer ${accessToken}`,

        "content-type":
          "application/json",

        ...(options.headers || {})
      }
    }
  );

  let data = {};

  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    console.log(
      "❌ YouTube API:",
      response.status,
      JSON.stringify(data)
    );

    throw new Error(
      data?.error?.message ||
      `YouTube API ${response.status}`
    );
  }

  return data;
}

// ============================================================
// BOT YOUTUBE CHANNEL
// ============================================================

async function getBotChannelId(
  accessToken
) {
  if (cachedBotChannelId) {
    return cachedBotChannelId;
  }

  const params =
    new URLSearchParams({
      part: "snippet",
      mine: "true"
    });

  const data =
    await youtubeRequest(
      `channels?${params}`,
      accessToken
    );

  const channel =
    data.items?.[0];

  if (!channel?.id) {
    throw new Error(
      "Authenticated Bhola channel not found"
    );
  }

  cachedBotChannelId =
    channel.id;

  console.log(
    "✅ Bhola channel:",
    channel.snippet?.title ||
    channel.id
  );

  return channel.id;
}

// ============================================================
// GET LIVE CHAT ID
// ============================================================

async function getLiveChatId(
  accessToken,
  videoId
) {
  const params =
    new URLSearchParams({
      part:
        "liveStreamingDetails",

      id:
        videoId
    });

  const data =
    await youtubeRequest(
      `videos?${params}`,
      accessToken
    );

  const video =
    data.items?.[0];

  if (!video) {
    throw new Error(
      "TARGET_VIDEO_ID video not found"
    );
  }

  const liveChatId =
    video
      .liveStreamingDetails
      ?.activeLiveChatId;

  if (!liveChatId) {
    throw new Error(
      "Live chat is not active"
    );
  }

  console.log(
    "✅ Live chat connected"
  );

  return liveChatId;
}

// ============================================================
// READ LIVE CHAT
// ============================================================

async function getChatMessages(
  accessToken,
  liveChatId,
  pageToken = null
) {
  const params =
    new URLSearchParams({
      liveChatId,

      part:
        "id,snippet,authorDetails",

      maxResults:
        "200"
    });

  if (pageToken) {
    params.set(
      "pageToken",
      pageToken
    );
  }

  const data =
    await youtubeRequest(
      `liveChat/messages?${params}`,
      accessToken
    );

  return data;
}

// ============================================================
// GROQ
// ============================================================

async function askBhola(
  env,
  username,
  question
) {
  const systemPrompt = `
Tera naam Bhola hai.

Tu Punjabi Mashwave YouTube Live da smart,
natural, funny-but-useful Punjabi banda hai.

IMPORTANT:

- Har valid sawaal da direct jawab de.
- Kade blank response na de.
- Mostly natural Roman Punjabi use kar.
- Hindi use na kari.
- Punjabi-English mix natural hove ta allowed aa.
- Normally 1-3 short sentences.
- YouTube live chat layi concise jawab de.
- User jo puchhe os gal da pehla direct jawab de.
- Random joke ya shayari apne aap start na kari.
- Joke sirf jadon mangeya hove.
- Shayari sirf jadon mangi hove.
- Same line baar-baar repeat na kari.
- Galat facts invent na kari.
- Je sure nahi ta clearly keh "menu sure ni ji".
- Private information guess na kari.
- Friendly halka humour allowed.
- Har line ch emoji zaroori nahi.
- Har reply ch apna naam na repeat kari.
- User de topic ton bahar na ja.
- Meri/teri pronouns carefully use kari.

IDENTITY:

Je koi puche:
tu kaun aa?
who are you?
tera naam ki aa?

Jawab:
Main Bhola aa 😎 Punjabi Mashwave di live mehfil da banda.

Apne aap nu AI, chatbot, GPT, Groq,
API, software ya language model na keh.

CHANNEL:

Channel = Punjabi Mashwave
PMW = Punjabi Mashwave
Host/creator = Pinder Sidhu

UNKNOWN PERSONAL INFO:

Je puche:
Sukh di gf kithe aa?
Aman kithe aa?
Jasveer ajj kithe aa?

Private info guess na kari.

Natural reply:
Menu ni pta ji 😄 ohnu hi pucho.

EXAMPLES:

User: 2+2 kina?
Answer: 4 ji 😄

User: UAE di capital?
Answer: Abu Dhabi aa ji.

User: tera ki haal?
Answer: Vadiya ji 😎

User: tu ki krda?
Answer: Bas live mehfil sambhal reha aa 😄
`;

  try {
    console.log(
      `🤖 Asking Groq: ${question}`
    );

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${env.GROQ_API_KEY}`,

          "content-type":
            "application/json"
        },

        body: JSON.stringify({
          model:
            env.GROQ_MODEL ||
            "openai/gpt-oss-20b",

          messages: [
            {
              role: "system",
              content: systemPrompt
            },
            {
              role: "user",

              content:
                `Viewer: ${username}\n` +
                `Message: ${question}`
            }
          ],

          temperature:
            0.45,

          max_tokens:
            120
        })
      }
    );

    const data =
      await response.json();

    if (!response.ok) {
      console.log(
        "❌ Groq error:",
        response.status,
        JSON.stringify(data)
      );

      return (
        "Ik sec ji 😄 dubara pucho."
      );
    }

    let answer =
      data?.choices?.[0]
        ?.message?.content || "";

    answer =
      cleanText(answer);

    if (!answer) {
      answer =
        "Menu ehda pata ni ji 😄";
    }

    console.log(
      `✅ AI reply: ${answer}`
    );

    return answer.slice(0, 330);

  } catch (error) {
    console.log(
      "❌ Groq request error:",
      error?.message ||
      String(error)
    );

    return (
      "Ik sec ji 😄 dubara pucho."
    );
  }
}

// ============================================================
// SEND CHAT MESSAGE
// ============================================================

async function sendMessage(
  accessToken,
  liveChatId,
  text
) {
  const finalText =
    cleanText(text).slice(0, 400);

  if (!finalText) {
    console.log(
      "⚠️ Empty reply blocked"
    );

    return;
  }

  await youtubeRequest(
    "liveChat/messages?part=snippet",
    accessToken,
    {
      method: "POST",

      body: JSON.stringify({
        snippet: {
          liveChatId,

          type:
            "textMessageEvent",

          textMessageDetails: {
            messageText:
              finalText
          }
        }
      })
    }
  );

  console.log(
    `✅ REPLY SENT: ${finalText}`
  );
}

// ============================================================
// DOES MESSAGE CALL BHOLA?
// ============================================================

function isBholaCalled(text) {
  const lower =
    cleanText(text)
      .toLowerCase();

  return (
    lower.includes("bhola") ||
    lower.includes("bhole") ||
    lower.includes("@bhola") ||
    text.includes("ਭੋਲਾ") ||
    text.includes("ਭੋਲੇ")
  );
}

// ============================================================
// REMOVE BHOLA NAME FROM QUESTION
// ============================================================

function extractQuestion(text) {
  return cleanText(text)
    .replace(/@?bhola/ig, "")
    .replace(/bhole/ig, "")
    .replace(/ਭੋਲਾ/g, "")
    .replace(/ਭੋਲੇ/g, "")
    .trim();
}

// ============================================================
// PROCESS ONE LIVE CHAT MESSAGE
// ============================================================

async function processMessage(
  env,
  accessToken,
  liveChatId,
  botChannelId,
  item
) {
  if (!item?.id) {
    return;
  }

  // DUPLICATE PROTECTION
  if (
    seenMessageIds.has(item.id)
  ) {
    return;
  }

  rememberMessage(item.id);

  if (
    item.snippet?.type !==
    "textMessageEvent"
  ) {
    return;
  }

  const authorChannelId =
    item.authorDetails?.channelId ||
    "";

  // DON'T ANSWER OWN BHOLA MESSAGE
  if (
    authorChannelId ===
    botChannelId
  ) {
    return;
  }

  const text =
    item.snippet
      ?.textMessageDetails
      ?.messageText || "";

  if (!cleanText(text)) {
    return;
  }

  const username =
    item.authorDetails
      ?.displayName ||
    "viewer";

  console.log(
    `💬 Message received | ${username}: ${text}`
  );

  if (!isBholaCalled(text)) {
    console.log(
      "↪️ Bhola not called - ignored"
    );

    return;
  }

  let question =
    extractQuestion(text);

  if (!question) {
    question =
      "Sat sri akaal da short friendly reply de.";
  }

  console.log(
    `🔥 BHOLA CALLED by ${username}`
  );

  console.log(
    `❓ Question: ${question}`
  );

  const answer =
    await askBhola(
      env,
      username,
      question
    );

  const finalReply =
    cleanText(
      `@${username} ${answer}`
    ).slice(0, 400);

  await sendMessage(
    accessToken,
    liveChatId,
    finalReply
  );
}

// ============================================================
// MAIN BHOLA RUN
// ============================================================

async function runBhola(env) {
  const envCheck =
    checkEnvironment(env);

  if (!envCheck.ok) {
    throw new Error(
      "Missing variables: " +
      envCheck.missing.join(", ")
    );
  }

  console.log(
    "🚀 Bhola run starting"
  );

  const accessToken =
    await getGoogleAccessToken(env);

  const botChannelId =
    await getBotChannelId(
      accessToken
    );

  const liveChatId =
    await getLiveChatId(
      accessToken,
      env.TARGET_VIDEO_ID
    );

  // --------------------------------------------------------
  // FIRST REQUEST = BASELINE
  // --------------------------------------------------------

  const baseline =
    await getChatMessages(
      accessToken,
      liveChatId
    );

  let nextPageToken =
    baseline.nextPageToken ||
    null;

  console.log(
    `📥 Baseline messages: ${
      baseline.items?.length || 0
    }`
  );

  // Remember existing history so it does not get answered
  for (
    const item of baseline.items || []
  ) {
    rememberMessage(item.id);
  }

  console.log(
    "✅ Baseline ready - waiting for NEW messages"
  );

  // --------------------------------------------------------
  // MAIN LOOP
  // Keep running almost whole minute.
  // --------------------------------------------------------

  const finishAt =
    Date.now() + 54000;

  let cycle = 0;

  while (
    Date.now() < finishAt
  ) {
    cycle++;

    const youtubeWait =
      Number(
        baseline
          .pollingIntervalMillis
      ) || 3000;

    // Don't hit YouTube faster than allowed.
    const waitTime =
      Math.max(
        2500,
        Math.min(
          youtubeWait,
          5000
        )
      );

    await sleep(waitTime);

    if (
      Date.now() >= finishAt
    ) {
      break;
    }

    try {
      const data =
        await getChatMessages(
          accessToken,
          liveChatId,
          nextPageToken
        );

      if (
        data.nextPageToken
      ) {
        nextPageToken =
          data.nextPageToken;
      }

      const items =
        data.items || [];

      console.log(
        `🔄 Poll ${cycle}: ${items.length} new item(s)`
      );

      for (const item of items) {
        await processMessage(
          env,
          accessToken,
          liveChatId,
          botChannelId,
          item
        );
      }

      if (data.offlineAt) {
        console.log(
          "🛑 Live has ended"
        );

        break;
      }

    } catch (error) {
      console.log(
        "❌ Poll error:",
        error?.message ||
        String(error)
      );

      break;
    }
  }

  console.log(
    "✅ Bhola run finished"
  );

  return {
    ok: true,
    botChannelId,
    videoId:
      env.TARGET_VIDEO_ID
  };
}

// ============================================================
// CLOUDFLARE WORKER
// ============================================================

export default {

  // ==========================================================
  // HTTP
  // ==========================================================

  async fetch(
    request,
    env,
    ctx
  ) {
    const url =
      new URL(request.url);

    // --------------------------------------------------------
    // HOME
    // --------------------------------------------------------

    if (
      request.method === "GET" &&
      url.pathname === "/"
    ) {
      const envCheck =
        checkEnvironment(env);

      return htmlResponse(`
        <h2>
          Bhola YouTube Bot 😎
        </h2>

        <p>
          Cloudflare Worker running ✅
        </p>

        <p>
          Configuration:
          ${
            envCheck.ok
              ? "✅ Ready"
              : "⚠️ Missing: " +
                envCheck
                  .missing
                  .join(", ")
          }
        </p>

        <p>
          <a href="/auth">
            Connect Bhola YouTube Account
          </a>
        </p>

        <p>
          <a href="/status">
            Check status
          </a>
        </p>

        <p>
          <a href="/run">
            Run Bhola now
          </a>
        </p>
      `);
    }

    // --------------------------------------------------------
    // AUTH
    // --------------------------------------------------------

    if (
      request.method === "GET" &&
      url.pathname === "/auth"
    ) {
      if (
        !env.GOOGLE_CLIENT_ID ||
        !env.GOOGLE_CLIENT_SECRET
      ) {
        return htmlResponse(
          "<h2>Google credentials missing.</h2>",
          500
        );
      }

      return Response.redirect(
        getGoogleAuthUrl(
          request,
          env
        ),
        302
      );
    }

    // --------------------------------------------------------
    // OAUTH CALLBACK
    // --------------------------------------------------------

    if (
      request.method === "GET" &&
      url.pathname ===
        "/oauth2callback"
    ) {
      return oauthCallback(
        request,
        env
      );
    }

    // --------------------------------------------------------
    // STATUS
    // --------------------------------------------------------

    if (
      request.method === "GET" &&
      url.pathname === "/status"
    ) {
      const envCheck =
        checkEnvironment(env);

      return jsonResponse({
        bot: "Bhola",
        runtime:
          "Cloudflare Worker",

        configured:
          envCheck.ok,

        missing:
          envCheck.missing,

        videoId:
          env.TARGET_VIDEO_ID ||
          null
      });
    }

    // --------------------------------------------------------
    // MANUAL RUN
    // --------------------------------------------------------

    if (
      request.method === "GET" &&
      url.pathname === "/run"
    ) {
      try {
        const result =
          await runBhola(env);

        return jsonResponse({
          message:
            "Bhola run completed ✅",

          ...result
        });

      } catch (error) {
        console.log(
          "❌ Manual run:",
          error?.message ||
          String(error)
        );

        return jsonResponse(
          {
            ok: false,

            error:
              error?.message ||
              String(error)
          },
          500
        );
      }
    }

    return new Response(
      "Not found",
      {
        status: 404
      }
    );
  },

  // ==========================================================
  // CRON
  // ==========================================================

  async scheduled(
    controller,
    env,
    ctx
  ) {
    console.log(
      "⏰ CRON started"
    );

    ctx.waitUntil(
      runBhola(env)
        .catch((error) => {
          console.log(
            "❌ Scheduled error:",
            error?.message ||
            String(error)
          );
        })
    );
  }
};
