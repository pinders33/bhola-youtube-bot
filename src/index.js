// ======================================================
// BHOLA YOUTUBE LIVE BOT
// Cloudflare Workers Version
// ======================================================

// In-memory state during one Worker invocation.
// Across invocations we recover from recent YouTube chat
// and use timestamps to avoid replying to old messages.
let botChannelId = null;

// ======================================================
// HELPERS
// ======================================================

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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8"
    }
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=UTF-8"
    }
  });
}

// ======================================================
// ENV CHECK
// ======================================================

function checkEnvironment(env) {
  const required = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
    "GROQ_API_KEY",
    "TARGET_VIDEO_ID"
  ];

  const missing = required.filter((key) => !env[key]);

  return {
    ok: missing.length === 0,
    missing
  };
}

// ======================================================
// GOOGLE OAUTH
// ======================================================

async function getGoogleAccessToken(env) {
  const body = new URLSearchParams();

  body.set("client_id", env.GOOGLE_CLIENT_ID);
  body.set("client_secret", env.GOOGLE_CLIENT_SECRET);
  body.set("refresh_token", env.GOOGLE_REFRESH_TOKEN);
  body.set("grant_type", "refresh_token");

  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    }
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    console.log("Google token error:", JSON.stringify(data));

    throw new Error(
      data.error_description ||
      data.error ||
      "Could not refresh Google access token"
    );
  }

  return data.access_token;
}

// ======================================================
// GOOGLE AUTH URL
// ======================================================

function getGoogleAuthUrl(request, env) {
  const requestUrl = new URL(request.url);

  const redirectUri =
    env.GOOGLE_REDIRECT_URI ||
    `${requestUrl.origin}/oauth2callback`;

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: "https://www.googleapis.com/auth/youtube"
  });

  return (
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    params.toString()
  );
}

// ======================================================
// OAUTH CALLBACK
// ======================================================

async function oauthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (!code) {
    return htmlResponse(
      "<h2>Authorization code missing.</h2>",
      400
    );
  }

  const redirectUri =
    env.GOOGLE_REDIRECT_URI ||
    `${url.origin}/oauth2callback`;

  const body = new URLSearchParams();

  body.set("code", code);
  body.set("client_id", env.GOOGLE_CLIENT_ID);
  body.set("client_secret", env.GOOGLE_CLIENT_SECRET);
  body.set("redirect_uri", redirectUri);
  body.set("grant_type", "authorization_code");

  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.log("OAuth callback error:", JSON.stringify(data));

    return htmlResponse(
      `<h2>OAuth failed</h2>
       <pre>${cleanText(
         data.error_description || data.error
       )}</pre>`,
      500
    );
  }

  const refreshToken = data.refresh_token;

  if (!refreshToken) {
    return htmlResponse(`
      <h2>Bhola connected ✅</h2>

      <p>
        Google did not return a new refresh token.
      </p>

      <p>
        If you already have GOOGLE_REFRESH_TOKEN,
        keep using it.
      </p>
    `);
  }

  return htmlResponse(`
    <h2>Bhola connected ✅</h2>

    <p>
      Copy the token below and add it to
      Cloudflare as GOOGLE_REFRESH_TOKEN.
    </p>

    <textarea
      style="width:90%;height:140px"
      readonly
    >${refreshToken}</textarea>

    <p>
      Keep this token private.
    </p>
  `);
}

// ======================================================
// YOUTUBE API REQUEST
// ======================================================

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
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
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
      "YouTube API error:",
      response.status,
      JSON.stringify(data)
    );

    const message =
      data?.error?.message ||
      `YouTube API HTTP ${response.status}`;

    throw new Error(message);
  }

  return data;
}

// ======================================================
// DETECT BOT CHANNEL
// ======================================================

async function getBotChannelId(accessToken) {
  if (botChannelId) {
    return botChannelId;
  }

  const params = new URLSearchParams({
    part: "snippet",
    mine: "true"
  });

  const data = await youtubeRequest(
    `channels?${params}`,
    accessToken
  );

  const channel = data.items?.[0];

  if (!channel?.id) {
    throw new Error(
      "Authenticated YouTube bot channel not found"
    );
  }

  botChannelId = channel.id;

  console.log(
    "Bhola channel:",
    channel.snippet?.title || channel.id
  );

  return botChannelId;
}

// ======================================================
// GET LIVE CHAT ID
// ======================================================

async function getLiveChatId(
  accessToken,
  videoId
) {
  const params = new URLSearchParams({
    part: "liveStreamingDetails",
    id: videoId
  });

  const data = await youtubeRequest(
    `videos?${params}`,
    accessToken
  );

  const video = data.items?.[0];

  if (!video) {
    throw new Error(
      "TARGET_VIDEO_ID video not found"
    );
  }

  const liveChatId =
    video.liveStreamingDetails?.activeLiveChatId;

  if (!liveChatId) {
    throw new Error(
      "Live chat is not active on TARGET_VIDEO_ID"
    );
  }

  return liveChatId;
}

// ======================================================
// GROQ / BHOLA AI
// ======================================================

async function askBhola(
  env,
  username,
  question
) {
  const systemPrompt = `
Tera naam Bhola hai.

Tu Punjabi Meshwave YouTube live chat da
smart, natural, friendly te useful banda hai.

SAB TON IMPORTANT RULES:

- Har valid message da textual jawab de.
- Kade blank, empty ya whitespace-only jawab na de.
- User jo puchhe, pehla os gal da DIRECT jawab de.
- Random joke, shayari, story ya motivational line
  apne wallon shuru na kari.
- Joke sirf jadon joke mangeya hove.
- Shayari sirf jadon shayari mangi hove.
- Galat facts invent na kari.
- Je jawab sure nahi, clearly keh de ke sure nahi.
- Personal/private info guess na kari.
- Mostly natural Roman Punjabi use kar.
- Hindi ch jawab na de.
- Punjabi-English mix theek aa jadon natural lagge.
- Normally 1-3 short sentences.
- Live chat layi concise jawab de.
- Same fixed reply baar-baar repeat na kari.
- Friendly halka humour allowed.
- Har reply ch emoji zaroori nahi.
- Har reply ch Bhola naam repeat na kari.
- Har jawab de end ch question zaroori nahi.
- User de topic ton bahar na ja.
- User nu galat meri/teri pronoun na la.
- Viewer di gall nu dhyan naal samajh.

UNKNOWN / PERSONAL INFO:

Je kise bande bare private information pata nahi:
"Menu ni pta ji 😄"
ya context de hisaab naal:
"Ohnu hi pucho ji 😄"

EXAMPLES:

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

IDENTITY:

Je koi puche:
"tu kaun aa?"
"who are you?"
"tera naam ki aa?"

Jawab natural tareeke naal:
"Main Bhola aa 😎 Punjabi Meshwave di live mehfil da banda."

Apne aap nu AI, chatbot, language model,
software, Groq, GPT ya API na keh.

CHANNEL CONTEXT:

- Channel: Punjabi Meshwave
- PMW = Punjabi Meshwave
- Pinder Sidhu channel host/creator hai.
`;

  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",

        headers: {
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
          "content-type": "application/json"
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
                `YouTube username: ${username}\n` +
                `Message: ${question}`
            }
          ],

          temperature: 0.35,
          max_tokens: 120
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.log(
        "Groq API error:",
        response.status,
        JSON.stringify(data)
      );

      return "Ik sec ji 😄 dubara pucho.";
    }

    let answer =
      data?.choices?.[0]?.message?.content || "";

    answer = cleanText(answer);

    if (!answer) {
      return "Menu ehda pata ni ji 😄";
    }

    // YouTube chat message limit safety.
    return answer.slice(0, 330);

  } catch (error) {
    console.log(
      "Groq request failed:",
      error?.message || String(error)
    );

    return "Ik sec ji 😄 dubara pucho.";
  }
}

// ======================================================
// SEND YOUTUBE MESSAGE
// ======================================================

async function sendMessage(
  accessToken,
  liveChatId,
  text
) {
  const message = cleanText(text).slice(0, 400);

  if (!message) {
    console.log("Empty reply blocked");
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
          type: "textMessageEvent",

          textMessageDetails: {
            messageText: message
          }
        }
      })
    }
  );
}

// ======================================================
// GET CHAT MESSAGES
// ======================================================

async function getChatMessages(
  accessToken,
  liveChatId,
  pageToken = null
) {
  const params = new URLSearchParams({
    liveChatId,
    part: "snippet,authorDetails",
    maxResults: "200"
  });

  if (pageToken) {
    params.set("pageToken", pageToken);
  }

  return youtubeRequest(
    `liveChat/messages?${params}`,
    accessToken
  );
}

// ======================================================
// PROCESS ONE MESSAGE
// ======================================================

async function processMessage(
  env,
  accessToken,
  liveChatId,
  botId,
  item,
  invocationStartedAt
) {
  if (!item?.id) {
    return;
  }

  if (
    item.snippet?.type !==
    "textMessageEvent"
  ) {
    return;
  }

  const authorId =
    item.authorDetails?.channelId || "";

  // Never answer Bhola's own message.
  if (
    botId &&
    authorId === botId
  ) {
    return;
  }

  const publishedAt =
    item.snippet?.publishedAt
      ? Date.parse(item.snippet.publishedAt)
      : 0;

  // Important:
  // On first page of every Worker run YouTube can return
  // recent history. Ignore messages older than the current
  // run to avoid replying again to old chat.
  if (
    publishedAt &&
    publishedAt < invocationStartedAt - 5000
  ) {
    return;
  }

  const text =
    item.snippet
      ?.textMessageDetails
      ?.messageText || "";

  const cleaned = cleanText(text);

  if (!cleaned) {
    return;
  }

  const lower = cleaned.toLowerCase();

  const calledBhola =
    lower.includes("bhola") ||
    cleaned.includes("ਭੋਲਾ");

  if (!calledBhola) {
    return;
  }

  const username =
    item.authorDetails?.displayName ||
    "viewer";

  let question = cleaned
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

  const answer = await askBhola(
    env,
    username,
    question
  );

  const finalReply = cleanText(
    `@${username} ${answer}`
  ).slice(0, 400);

  if (!finalReply) {
    return;
  }

  await sendMessage(
    accessToken,
    liveChatId,
    finalReply
  );

  console.log(
    `Bhola replied to ${username}`
  );

  // Avoid sending chat messages too aggressively.
  await sleep(1500);
}

// ======================================================
// BOT LOOP
// ======================================================

async function runBhola(env) {
  const envCheck = checkEnvironment(env);

  if (!envCheck.ok) {
    throw new Error(
      "Missing variables: " +
      envCheck.missing.join(", ")
    );
  }

  console.log("Bhola run starting");

  const invocationStartedAt = Date.now();

  const accessToken =
    await getGoogleAccessToken(env);

  const botId =
    await getBotChannelId(accessToken);

  const liveChatId =
    await getLiveChatId(
      accessToken,
      env.TARGET_VIDEO_ID
    );

  console.log("Live chat connected");

  let nextPageToken = null;

  // Keep one cron invocation alive for about 52 seconds.
  // Cron fires every minute, so the next invocation starts
  // shortly after this one ends.
  const finishAt =
    Date.now() + 52000;

  let firstRequest = true;

  while (Date.now() < finishAt) {
    try {
      const data = await getChatMessages(
        accessToken,
        liveChatId,
        nextPageToken
      );

      const items = data.items || [];

      // On first request, ignore recent history from before
      // this invocation. processMessage also checks time.
      for (const item of items) {
        await processMessage(
          env,
          accessToken,
          liveChatId,
          botId,
          item,
          invocationStartedAt
        );
      }

      nextPageToken =
        data.nextPageToken ||
        nextPageToken;

      const youtubeWait =
        Number(data.pollingIntervalMillis) ||
        5000;

      // Never poll faster than YouTube requests.
      const wait = Math.max(
        youtubeWait,
        3000
      );

      firstRequest = false;

      if (
        data.offlineAt
      ) {
        console.log(
          "YouTube live has ended"
        );
        break;
      }

      if (
        Date.now() + wait >= finishAt
      ) {
        break;
      }

      await sleep(wait);

    } catch (error) {
      console.log(
        "Chat loop error:",
        error?.message || String(error)
      );

      // Stop this run and allow next Cron invocation to retry.
      break;
    }
  }

  console.log("Bhola run finished");

  return {
    ok: true,
    botChannelId: botId,
    videoId: env.TARGET_VIDEO_ID
  };
}

// ======================================================
// CLOUDFLARE WORKER
// ======================================================

export default {

  // ----------------------------------------------------
  // NORMAL WEB REQUESTS
  // ----------------------------------------------------

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Home page
    if (
      request.method === "GET" &&
      url.pathname === "/"
    ) {
      const envCheck =
        checkEnvironment(env);

      return htmlResponse(`
        <h2>Bhola YouTube Bot 😎</h2>

        <p>
          Cloudflare Worker running ✅
        </p>

        <p>
          Configuration:
          ${
            envCheck.ok
              ? "✅ Ready"
              : "⚠️ Missing: " +
                envCheck.missing.join(", ")
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
      `);
    }

    // Google OAuth start
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
        getGoogleAuthUrl(request, env),
        302
      );
    }

    // OAuth callback
    if (
      request.method === "GET" &&
      url.pathname === "/oauth2callback"
    ) {
      return oauthCallback(
        request,
        env
      );
    }

    // Status endpoint
    if (
      request.method === "GET" &&
      url.pathname === "/status"
    ) {
      const envCheck =
        checkEnvironment(env);

      return jsonResponse({
        bot: "Bhola",
        platform: "Cloudflare Workers",
        configured: envCheck.ok,
        missing: envCheck.missing,
        targetVideoConfigured:
          Boolean(env.TARGET_VIDEO_ID)
      });
    }

    // Manual test run.
    // Opening /run will trigger one bot cycle.
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
          "Manual run error:",
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

  // ----------------------------------------------------
  // CRON - RUNS EVERY MINUTE
  // ----------------------------------------------------

  async scheduled(
    controller,
    env,
    ctx
  ) {
    ctx.waitUntil(
      runBhola(env).catch(
        (error) => {
          console.log(
            "Scheduled Bhola error:",
            error?.message ||
            String(error)
          );
        }
      )
    );
  }
};
