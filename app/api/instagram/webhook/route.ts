import {
  NextRequest,
  NextResponse,
} from "next/server";

import crypto from "crypto";

import {
  supabaseAdmin,
} from "@/lib/supabaseAdmin";

export const runtime =
  "nodejs";

// ======================================================
// COMMUNITY SETTINGS
// ======================================================

const COMMUNITY_CHANNEL_URL =
  process.env
    .COMMUNITY_CHANNEL_URL ??
  "https://www.instagram.com/channel/TGk3f35BqQ7yrElw/";

const COMMUNITY_MESSAGE =
  `yo bro, here's the link to join the Calisthenics New Gen community 👇\n\n${COMMUNITY_CHANNEL_URL}`;

// ======================================================
// GET
// META WEBHOOK VERIFICATION
// ======================================================

export async function GET(
  req: NextRequest
) {
  const {
    searchParams,
  } = new URL(req.url);

  const mode =
    searchParams.get(
      "hub.mode"
    );

  const token =
    searchParams.get(
      "hub.verify_token"
    );

  const challenge =
    searchParams.get(
      "hub.challenge"
    );

  if (
    mode === "subscribe" &&
    token ===
      process.env
        .INSTAGRAM_WEBHOOK_VERIFY_TOKEN
  ) {
    console.log(
      "Instagram webhook verified"
    );

    return new NextResponse(
      challenge ?? "",
      {
        status: 200,
      }
    );
  }

  console.error(
    "Instagram webhook verification failed"
  );

  return new NextResponse(
    "Forbidden",
    {
      status: 403,
    }
  );
}

// ======================================================
// POST
// COMMENT + MESSAGE WEBHOOKS
// ======================================================

export async function POST(
  req: NextRequest
) {
  try {
    const rawBody =
      await req.text();

    // ==================================================
    // VERIFY INSTAGRAM SIGNATURE
    // ==================================================

    if (
      !verifyInstagramSignature(
        req,
        rawBody
      )
    ) {
      console.error(
        "Invalid Instagram webhook signature"
      );

      return NextResponse.json(
        {
          error:
            "Invalid signature",
        },
        {
          status: 401,
        }
      );
    }

    const body =
      JSON.parse(
        rawBody
      );

    console.log(
      "INSTAGRAM EVENT:",
      JSON.stringify(
        body,
        null,
        2
      )
    );

    if (
      body.object !==
      "instagram"
    ) {
      return NextResponse.json({
        received: true,
      });
    }

    // ==================================================
    // PROCESS ENTRIES
    // ==================================================

    for (
      const entry of
      body.entry ?? []
    ) {
      let commentHandled =
        false;

      // ==================================================
      // COMMENT FORMAT 1
      //
      // entry.field
      // entry.value
      // ==================================================

      if (
        entry.field ===
          "comments" &&
        entry.value
      ) {
        console.log(
          "COMMENT WEBHOOK DETECTED: direct format"
        );

        await handleComment(
          entry.value
        );

        commentHandled =
          true;
      }

      // ==================================================
      // COMMENT FORMAT 2
      //
      // entry.changes[]
      //
      // This is the format that fixed your live webhook
      // previously, so we are keeping both formats.
      // ==================================================

      if (
        !commentHandled
      ) {
        for (
          const change of
          entry.changes ?? []
        ) {
          if (
            change?.field ===
              "comments" &&
            change?.value
          ) {
            console.log(
              "COMMENT WEBHOOK DETECTED: changes format"
            );

            await handleComment(
              change.value
            );

            commentHandled =
              true;

            break;
          }
        }
      }

      // ==================================================
      // INSTAGRAM DMS
      // ==================================================

      for (
        const event of
        entry.messaging ?? []
      ) {
        await handleMessage(
          event
        );
      }
    }

    return NextResponse.json({
      received: true,
    });
  } catch (error) {
    console.error(
      "Instagram webhook error:",
      error
    );

    return NextResponse.json(
      {
        error:
          "Webhook failed",
      },
      {
        status: 500,
      }
    );
  }
}

// ======================================================
// HANDLE COMMENT
// ======================================================

async function handleComment(
  value: any
) {
  const commentId =
    value?.id;

  const text =
    value?.text ??
    "";

  const instagramUserId =
    value?.from?.id ??
    null;

  if (
    !commentId ||
    !text
  ) {
    console.log(
      "Comment missing ID or text"
    );

    return;
  }

  console.log(
    "NEW COMMENT:",
    {
      commentId,
      text,
      instagramUserId,
    }
  );

  // ==================================================
  // DOES IT MATCH COMMUNITY?
  // ==================================================

  if (
    !isCommunityTrigger(
      text
    )
  ) {
    console.log(
      "Comment does not match COMMUNITY"
    );

    return;
  }

  console.log(
    "COMMUNITY COMMENT DETECTED:",
    text
  );

  // ==================================================
  // IF WE KNOW THE USER ID, CHECK WHETHER THEY
  // ALREADY RECEIVED THE LINK.
  // ==================================================

  if (
    instagramUserId &&
    (await hasAlreadyReceivedLink(
      instagramUserId
    ))
  ) {
    console.log(
      "User already received community link:",
      instagramUserId
    );

    return;
  }

  const sourceId =
    `comment:${commentId}`;

  // ==================================================
  // RESERVE EVENT
  //
  // Prevents Meta delivering the same webhook twice
  // and causing two DMs.
  // ==================================================

  const reserved =
    await reserveDelivery({
      sourceType:
        "comment",

      sourceId,

      instagramUserId,

      sourceText:
        text,
    });

  if (!reserved) {
    console.log(
      "Comment already processed:",
      commentId
    );

    return;
  }

  try {
    console.log(
      "SENDING COMMUNITY LINK FROM COMMENT:",
      commentId
    );

    const result =
      await sendPrivateReply(
        commentId,
        COMMUNITY_MESSAGE
      );

    const recipientId =
      result?.recipient_id ??
      instagramUserId ??
      null;

    await markDeliverySent(
      sourceId,
      recipientId
    );

    console.log(
      "COMMUNITY LINK SENT FROM COMMENT:",
      {
        commentId,
        recipientId,
      }
    );
  } catch (error) {
    console.error(
      "Community private reply failed:",
      error
    );

    // Allow future retry.
    await removeDeliveryReservation(
      sourceId
    );
  }
}

// ======================================================
// HANDLE DIRECT INSTAGRAM DM
// ======================================================

async function handleMessage(
  event: any
) {
  const senderId =
    event?.sender?.id;

  const message =
    event?.message;

  if (
    !senderId ||
    !message
  ) {
    return;
  }

  // Ignore messages sent by our own account.
  if (
    message.is_echo
  ) {
    return;
  }

  const text =
    message.text;

  const messageId =
    message.mid;

  if (
    !text ||
    !messageId
  ) {
    return;
  }

  console.log(
    "NEW INSTAGRAM DM:",
    {
      senderId,
      text,
      messageId,
    }
  );

  // ==================================================
  // ONLY RESPOND TO COMMUNITY
  // ==================================================

  if (
    !isCommunityTrigger(
      text
    )
  ) {
    console.log(
      "DM unrelated to COMMUNITY"
    );

    return;
  }

  console.log(
    "DIRECT COMMUNITY DM DETECTED:",
    text
  );

  // ==================================================
  // DON'T SEND THE LINK AGAIN IF THEY ALREADY GOT IT
  // ==================================================

  if (
    await hasAlreadyReceivedLink(
      senderId
    )
  ) {
    console.log(
      "User already received community link:",
      senderId
    );

    return;
  }

  const sourceId =
    `dm:${messageId}`;

  // ==================================================
  // DUPLICATE PROTECTION
  // ==================================================

  const reserved =
    await reserveDelivery({
      sourceType:
        "dm",

      sourceId,

      instagramUserId:
        senderId,

      sourceText:
        text,
    });

  if (!reserved) {
    console.log(
      "DM already processed:",
      messageId
    );

    return;
  }

  try {
    await sendInstagramMessage(
      senderId,
      COMMUNITY_MESSAGE
    );

    await markDeliverySent(
      sourceId,
      senderId
    );

    console.log(
      "COMMUNITY LINK SENT FROM DM:",
      senderId
    );
  } catch (error) {
    console.error(
      "Community DM failed:",
      error
    );

    await removeDeliveryReservation(
      sourceId
    );
  }
}

// ======================================================
// CHECK IF PERSON ALREADY RECEIVED LINK
// ======================================================

async function hasAlreadyReceivedLink(
  instagramUserId: string
): Promise<boolean> {
  const {
    data,
    error,
  } = await supabaseAdmin
    .from(
      "community_link_deliveries"
    )
    .select(
      "id"
    )
    .eq(
      "instagram_user_id",
      instagramUserId
    )
    .not(
      "sent_at",
      "is",
      null
    )
    .limit(1);

  if (error) {
    console.error(
      "Delivery lookup failed:",
      error
    );

    // Don't block the automation if this lookup fails.
    return false;
  }

  return (
    data !== null &&
    data.length > 0
  );
}

// ======================================================
// RESERVE DELIVERY
// ======================================================

async function reserveDelivery(
  input: {
    sourceType:
      "comment" |
      "dm";

    sourceId:
      string;

    instagramUserId:
      string |
      null;

    sourceText:
      string;
  }
): Promise<boolean> {
  const {
    error,
  } = await supabaseAdmin
    .from(
      "community_link_deliveries"
    )
    .insert({
      source_type:
        input.sourceType,

      source_id:
        input.sourceId,

      instagram_user_id:
        input.instagramUserId,

      source_text:
        input.sourceText,

      sent_at:
        null,
    });

  if (!error) {
    return true;
  }

  // Duplicate source ID
  if (
    error.code ===
    "23505"
  ) {
    return false;
  }

  console.error(
    "Failed to reserve community delivery:",
    error
  );

  throw error;
}

// ======================================================
// MARK DELIVERY SUCCESSFUL
// ======================================================

async function markDeliverySent(
  sourceId: string,
  instagramUserId:
    string |
    null
) {
  const {
    error,
  } = await supabaseAdmin
    .from(
      "community_link_deliveries"
    )
    .update({
      instagram_user_id:
        instagramUserId,

      sent_at:
        new Date()
          .toISOString(),
    })
    .eq(
      "source_id",
      sourceId
    );

  if (error) {
    console.error(
      "Failed to mark community link sent:",
      error
    );
  }
}

// ======================================================
// REMOVE FAILED RESERVATION
// ======================================================

async function removeDeliveryReservation(
  sourceId: string
) {
  const {
    error,
  } = await supabaseAdmin
    .from(
      "community_link_deliveries"
    )
    .delete()
    .eq(
      "source_id",
      sourceId
    );

  if (error) {
    console.error(
      "Failed to remove delivery reservation:",
      error
    );
  }
}

// ======================================================
// COMMUNITY TRIGGER
//
// Works with:
// community
// COMMUNITY
// Community
// community🔥
// community bro
// comunity
// communty
// commmunity
// communityy
// etc.
// ======================================================

function isCommunityTrigger(
  text: string
) {
  const words =
    text
      .toLowerCase()
      .match(
        /[a-z]+/g
      ) ??
    [];

  const target =
    "community";

  for (
    const word of
    words
  ) {
    // Exact match
    if (
      word ===
      target
    ) {
      return true;
    }

    // Avoid fuzzy matching tiny words.
    if (
      word.length < 6
    ) {
      continue;
    }

    // Allow up to 2 edits.
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

// ======================================================
// LEVENSHTEIN DISTANCE
// ======================================================

function levenshteinDistance(
  a: string,
  b: string
) {
  const matrix:
    number[][] =
      Array.from(
        {
          length:
            b.length +
            1,
        },
        () =>
          Array(
            a.length +
            1
          ).fill(
            0
          )
      );

  for (
    let i = 0;
    i <= b.length;
    i++
  ) {
    matrix[i][0] =
      i;
  }

  for (
    let j = 0;
    j <= a.length;
    j++
  ) {
    matrix[0][j] =
      j;
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
            ] +
              1,

            matrix[i][
              j - 1
            ] +
              1,

            matrix[
              i - 1
            ][j] +
              1
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
// PRIVATE REPLY FROM COMMENT
// ======================================================

async function sendPrivateReply(
  commentId: string,
  text: string
) {
  const accessToken =
    process.env
      .INSTAGRAM_ACCESS_TOKEN;

  const accountId =
    process.env
      .INSTAGRAM_ACCOUNT_ID;

  const version =
    process.env
      .INSTAGRAM_GRAPH_VERSION ??
    "v26.0";

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
              text,
            },
          }),
      }
    );

  const data =
    await response.json();

  if (
    !response.ok
  ) {
    console.error(
      "Instagram private reply error:",
      data
    );

    throw new Error(
      "Instagram private reply failed"
    );
  }

  return data;
}

// ======================================================
// NORMAL INSTAGRAM DM
// ======================================================

async function sendInstagramMessage(
  recipientId: string,
  text: string
) {
  const accessToken =
    process.env
      .INSTAGRAM_ACCESS_TOKEN;

  const accountId =
    process.env
      .INSTAGRAM_ACCOUNT_ID;

  const version =
    process.env
      .INSTAGRAM_GRAPH_VERSION ??
    "v26.0";

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
              id:
                recipientId,
            },

            message: {
              text,
            },
          }),
      }
    );

  const data =
    await response.json();

  if (
    !response.ok
  ) {
    console.error(
      "Instagram DM error:",
      data
    );

    throw new Error(
      "Instagram DM failed"
    );
  }

  return data;
}

// ======================================================
// VERIFY INSTAGRAM WEBHOOK SIGNATURE
// ======================================================

function verifyInstagramSignature(
  req: NextRequest,
  rawBody: string
) {
  const appSecret =
    process.env
      .INSTAGRAM_APP_SECRET;

  if (!appSecret) {
    console.error(
      "INSTAGRAM_APP_SECRET is missing"
    );

    return false;
  }

  const signature =
    req.headers.get(
      "x-hub-signature-256"
    );

  if (!signature) {
    console.error(
      "x-hub-signature-256 is missing"
    );

    return false;
  }

  const expected =
    "sha256=" +
    crypto
      .createHmac(
        "sha256",
        appSecret
      )
      .update(
        rawBody
      )
      .digest(
        "hex"
      );

  const actualBuffer =
    Buffer.from(
      signature
    );

  const expectedBuffer =
    Buffer.from(
      expected
    );

  if (
    actualBuffer.length !==
    expectedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    actualBuffer,
    expectedBuffer
  );
}