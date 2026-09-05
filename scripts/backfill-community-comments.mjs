import fs from "fs";

function loadEnv() {
  const text = fs.readFileSync(
    ".env.local",
    "utf8"
  );

  for (const line of text.split("\n")) {
    const trimmed =
      line.trim();

    if (
      !trimmed ||
      trimmed.startsWith("#")
    ) {
      continue;
    }

    const index =
      trimmed.indexOf("=");

    if (index === -1) {
      continue;
    }

    const key =
      trimmed
        .slice(0, index)
        .trim();

    const value =
      trimmed
        .slice(index + 1)
        .trim();

    if (!process.env[key]) {
      process.env[key] =
        value;
    }
  }
}

loadEnv();

const accessToken =
  process.env.INSTAGRAM_ACCESS_TOKEN;

const accountId =
  process.env.INSTAGRAM_ACCOUNT_ID;

const mediaId =
  process.env.BACKFILL_REEL_MEDIA_ID;

const version =
  process.env.INSTAGRAM_GRAPH_VERSION ||
  "v26.0";

const supabaseUrl =
  process.env.SUPABASE_URL;

const supabaseKey =
  process.env.SUPABASE_SECRET_KEY;

const FIRST_DM =
  "Hey bro! I saw that you're interested in the calisthenics community. Do you want me to add you to the waitlist for when it releases?";

const HOURS_TO_SCAN = 24;

// ======================================================
// CHECK ENVIRONMENT VARIABLES
// ======================================================

if (!accessToken) {
  throw new Error(
    "INSTAGRAM_ACCESS_TOKEN is missing"
  );
}

if (!accountId) {
  throw new Error(
    "INSTAGRAM_ACCOUNT_ID is missing"
  );
}

if (!mediaId) {
  throw new Error(
    "BACKFILL_REEL_MEDIA_ID is missing"
  );
}

if (!supabaseUrl) {
  throw new Error(
    "SUPABASE_URL is missing"
  );
}

if (!supabaseKey) {
  throw new Error(
    "SUPABASE_SECRET_KEY is missing"
  );
}

// ======================================================
// SUPABASE HELPERS
// ======================================================

async function supabaseRequest(
  path,
  options = {}
) {
  const response =
    await fetch(
      `${supabaseUrl}/rest/v1/${path}`,
      {
        ...options,

        headers: {
          apikey:
            supabaseKey,

          Authorization:
            `Bearer ${supabaseKey}`,

          "Content-Type":
            "application/json",

          Prefer:
            "return=representation",

          ...(options.headers ?? {}),
        },
      }
    );

  if (!response.ok) {
    const text =
      await response.text();

    throw new Error(
      `Supabase error: ${text}`
    );
  }

  const text =
    await response.text();

  if (!text) {
    return null;
  }

  return JSON.parse(text);
}

// ======================================================
// COMMUNITY MATCHING
// ======================================================

function isCommunityTrigger(
  text
) {
  const words =
    text
      .toLowerCase()
      .match(/[a-z]+/g) ??
    [];

  const target =
    "community";

  for (const word of words) {
    if (word === target) {
      return true;
    }

    if (word.length < 6) {
      continue;
    }

    if (
      levenshteinDistance(
        word,
        target
      ) <= 2
    ) {
      return true;
    }
  }

  return false;
}

function levenshteinDistance(
  a,
  b
) {
  const matrix =
    Array.from(
      {
        length:
          b.length + 1,
      },

      () =>
        Array(
          a.length + 1
        ).fill(0)
    );

  for (
    let i = 0;
    i <= b.length;
    i++
  ) {
    matrix[i][0] = i;
  }

  for (
    let j = 0;
    j <= a.length;
    j++
  ) {
    matrix[0][j] = j;
  }

  for (
    let i = 1;
    i <= b.length;
    i++
  ) {
    for (
      let j = 1;
      j <= a.length;
      j++
    ) {
      if (
        b[i - 1] ===
        a[j - 1]
      ) {
        matrix[i][j] =
          matrix[
            i - 1
          ][
            j - 1
          ];
      } else {
        matrix[i][j] =
          Math.min(
            matrix[
              i - 1
            ][
              j - 1
            ] + 1,

            matrix[i][
              j - 1
            ] + 1,

            matrix[
              i - 1
            ][j] + 1
          );
      }
    }
  }

  return matrix[
    b.length
  ][
    a.length
  ];
}

// ======================================================
// CHECK IF COMMENT ALREADY PROCESSED
// ======================================================

async function commentAlreadyProcessed(
  commentId
) {
  const params =
    new URLSearchParams({
      select:
        "id,status",

      source_comment_id:
        `eq.${commentId}`,

      limit:
        "1",
    });

  const data =
    await supabaseRequest(
      `community_waitlist_leads?${params}`
    );

  return (
    Array.isArray(data) &&
    data.length > 0
  );
}

// ======================================================
// RESERVE COMMENT
// ======================================================

async function reserveComment(
  comment
) {
  return await supabaseRequest(
    "community_waitlist_leads",

    {
      method:
        "POST",

      body:
        JSON.stringify({
          instagram_username:
            comment.username ??
            null,

          status:
            "pending",

          source_comment_id:
            comment.id,

          source_media_id:
            mediaId,

          source_comment_text:
            comment.text,
        }),
    }
  );
}

// ======================================================
// DELETE RESERVATION IF SEND FAILS
// ======================================================

async function removeReservation(
  commentId
) {
  const params =
    new URLSearchParams({
      source_comment_id:
        `eq.${commentId}`,
    });

  await supabaseRequest(
    `community_waitlist_leads?${params}`,

    {
      method:
        "DELETE",
    }
  );
}

// ======================================================
// PRIVATE REPLY
// ======================================================

async function sendPrivateReply(
  commentId
) {
  const response =
    await fetch(
      `https://graph.instagram.com/${version}/${accountId}/messages`,

      {
        method:
          "POST",

        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify({
            recipient: {
              comment_id:
                commentId,
            },

            message: {
              text:
                FIRST_DM,
            },
          }),
      }
    );

  const data =
    await response.json();
    console.log(
  "RAW COMMENTS RESPONSE:",
  JSON.stringify(data, null, 2)
);

  if (!response.ok) {
    console.error(
      "Instagram error:",
      data
    );

    throw new Error(
      "Private reply failed"
    );
  }

  return data;
}

// ======================================================
// UPDATE LEAD WITH INSTAGRAM-SCOPED ID
// ======================================================

async function activateLead(
  commentId,
  recipientId
) {
  const params =
    new URLSearchParams({
      source_comment_id:
        `eq.${commentId}`,
    });

  await supabaseRequest(
    `community_waitlist_leads?${params}`,

    {
      method:
        "PATCH",

      body:
        JSON.stringify({
          instagram_user_id:
            recipientId,

          status:
            "awaiting_confirmation",

          updated_at:
            new Date()
              .toISOString(),
        }),
    }
  );
}

// ======================================================
// FETCH COMMENTS
// ======================================================

async function fetchAllComments() {
  const comments = [];

  const fields =
    "id,text,timestamp,username";

  let url =
    `https://graph.instagram.com/${version}/${mediaId}/comments` +
    `?fields=${encodeURIComponent(fields)}` +
    `&limit=100`;

  while (url) {
    const response =
      await fetch(
        url,
        {
          headers: {
            Authorization:
              `Bearer ${accessToken}`,
          },
        }
      );

    const data =
      await response.json();
      console.log(
  "RAW COMMENTS RESPONSE:",
  JSON.stringify(data, null, 2)
);

    if (!response.ok) {
      console.error(data);

      throw new Error(
        "Failed to fetch Instagram comments"
      );
    }

    comments.push(
      ...(data.data ?? [])
    );

    url =
      data.paging?.next ??
      null;
  }

  return comments;
}

// ======================================================
// MAIN
// ======================================================

console.log(
  `Scanning Reel ${mediaId}`
);

console.log(
  `Only processing comments from the last ${HOURS_TO_SCAN} hours`
);

const comments =
  await fetchAllComments();

console.log(
  `Fetched ${comments.length} total comments`
);

const cutoff =
  Date.now() -
  HOURS_TO_SCAN *
    60 *
    60 *
    1000;

let eligible = 0;
let sent = 0;
let skippedOld = 0;
let skippedKeyword = 0;
let skippedExisting = 0;
let failed = 0;

for (const comment of comments) {
  const created =
    new Date(
      comment.timestamp
    ).getTime();

  // ------------------------------
  // Older than 24 hours
  // ------------------------------

  if (
    !Number.isFinite(created) ||
    created < cutoff
  ) {
    skippedOld++;

    continue;
  }

  // ------------------------------
  // Doesn't say COMMUNITY
  // ------------------------------

  if (
    !isCommunityTrigger(
      comment.text ?? ""
    )
  ) {
    skippedKeyword++;

    continue;
  }

  eligible++;

  // ------------------------------
  // Already handled by webhook/backfill
  // ------------------------------

  if (
    await commentAlreadyProcessed(
      comment.id
    )
  ) {
    console.log(
      `SKIP: already processed @${comment.username ?? "unknown"}`
    );

    skippedExisting++;

    continue;
  }

  console.log(
    `\nMATCH: @${comment.username ?? "unknown"}`
  );

  console.log(
    `Comment: ${comment.text}`
  );

  try {
    // Reserve BEFORE sending so accidental
    // duplicate runs cannot double-message.
    await reserveComment(
      comment
    );

    const result =
      await sendPrivateReply(
        comment.id
      );

    if (!result?.recipient_id) {
      throw new Error(
        "No recipient_id returned"
      );
    }

    await activateLead(
      comment.id,
      result.recipient_id
    );

    console.log(
      `SENT ✅ @${comment.username ?? "unknown"}`
    );

    sent++;

    // Small delay between users.
    await new Promise(
      (resolve) =>
        setTimeout(
          resolve,
          750
        )
    );
  } catch (error) {
    failed++;

    console.error(
      `FAILED ❌ @${comment.username ?? "unknown"}`,
      error
    );

    await removeReservation(
      comment.id
    );
  }
}

console.log("\n==============================");
console.log("BACKFILL COMPLETE");
console.log("==============================");

console.log(
  "Total comments:",
  comments.length
);

console.log(
  "Community matches in 24h:",
  eligible
);

console.log(
  "Private DMs sent:",
  sent
);

console.log(
  "Already processed:",
  skippedExisting
);

console.log(
  "Too old:",
  skippedOld
);

console.log(
  "Other comments:",
  skippedKeyword
);

console.log(
  "Failed:",
  failed
);