import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import OpenAI from "openai";

import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const FIRST_DM =
  "Hey bro! I saw that you're interested in the calisthenics community. Do you want me to add you to the waitlist for when it releases?";

type WaitlistDecision = {
  reply: string;
  action: "reply" | "ask_email" | "decline";
};

// ======================================================
// GET
// Meta webhook verification
// ======================================================

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (
    mode === "subscribe" &&
    token === process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN
  ) {
    console.log("Instagram webhook verified");

    return new NextResponse(challenge ?? "", {
      status: 200,
    });
  }

  console.error("Instagram webhook verification failed");

  return new NextResponse("Forbidden", {
    status: 403,
  });
}

// ======================================================
// POST
// Receives comment + message webhooks
// ======================================================

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();

    if (!verifyInstagramSignature(req, rawBody)) {
      console.error("Invalid Instagram webhook signature");

      return NextResponse.json(
        {
          error: "Invalid signature",
        },
        {
          status: 401,
        }
      );
    }

    const body = JSON.parse(rawBody);

    console.log(
      "INSTAGRAM EVENT:",
      JSON.stringify(body, null, 2)
    );

    if (body.object !== "instagram") {
      return NextResponse.json({
        received: true,
      });
    }

    for (const entry of body.entry ?? []) {
  console.log(
    "ENTRY DEBUG:",
    JSON.stringify(entry, null, 2)
  );

  console.log(
    "ENTRY FIELD:",
    entry.field
  );

  console.log(
    "ENTRY VALUE:",
    JSON.stringify(entry.value, null, 2)
  );

  if (
    entry.field === "comments" &&
    entry.value
  ) {
    console.log(
      "COMMENT WEBHOOK DETECTED"
    );

    await handleComment(entry.value);

    continue;
  }

  for (const event of entry.messaging ?? []) {
    await handleMessage(event);
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
        error: "Webhook failed",
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

async function handleComment(value: any) {
  console.log(
  "HANDLE COMMENT CALLED:",
  JSON.stringify(value, null, 2)
);
  const commentId = value?.id;

  const username =
    value?.from?.username ?? null;

  const text =
    value?.text ?? "";

  const mediaId =
    value?.media?.id ?? null;

  if (!commentId || !text) {
    return;
  }

  console.log("NEW COMMENT:", {
    commentId,
    username,
    text,
    mediaId,
  });

  // Only trigger on COMMUNITY / typos
  if (!isCommunityTrigger(text)) {
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
  // CHECK IF EXACT COMMENT ALREADY PROCESSED
  // ==================================================

  const {
    data: existingComment,
    error: existingCommentError,
  } = await supabaseAdmin
    .from("community_waitlist_leads")
    .select("id, status")
    .eq("source_comment_id", commentId)
    .maybeSingle();

  if (existingCommentError) {
    console.error(
      "Comment lookup failed:",
      existingCommentError
    );

    return;
  }

  if (existingComment) {
    console.log(
      "Comment already processed"
    );

    return;
  }

  // ==================================================
  // CHECK IF USER ALREADY ENTERED FUNNEL
  // ==================================================

  if (username) {
    const {
      data: existingUsers,
      error: existingUserError,
    } = await supabaseAdmin
      .from("community_waitlist_leads")
      .select("id, status")
      .ilike(
        "instagram_username",
        username
      )
      .limit(1);

    if (existingUserError) {
      console.error(
        "Username lookup failed:",
        existingUserError
      );

      return;
    }

    if (
      existingUsers &&
      existingUsers.length > 0
    ) {
      console.log(
        "Instagram user already exists in waitlist funnel:",
        username
      );

      return;
    }
  }

  // ==================================================
  // RESERVE COMMENT
  //
  // Stops duplicate webhook requests from sending
  // the private message twice.
  // ==================================================

  const {
    error: reserveError,
  } = await supabaseAdmin
    .from("community_waitlist_leads")
    .insert({
      instagram_username:
        username,

      status:
        "pending",

      source_comment_id:
        commentId,

      source_media_id:
        mediaId,

      source_comment_text:
        text,
    });

  if (reserveError) {
    if (
      reserveError.code === "23505"
    ) {
      console.log(
        "Duplicate comment ignored"
      );

      return;
    }

    console.error(
      "Failed to reserve comment:",
      reserveError
    );

    return;
  }

  try {
    // ==================================================
    // SEND PRIVATE REPLY FROM COMMENT
    // ==================================================
console.log( "ATTEMPTING PRIVATE REPLY TO COMMENT:", commentId );
    const result =
    
      await sendPrivateReply(
        commentId,
        FIRST_DM
      );

    const recipientId =
      result?.recipient_id;

    if (!recipientId) {
      throw new Error(
        "Instagram did not return recipient_id"
      );
    }

    console.log(
      "PRIVATE REPLY SENT:",
      {
        username,
        recipientId,
      }
    );

    // ==================================================
    // LINK INSTAGRAM DM ID TO WAITLIST LEAD
    // ==================================================

    const {
      error: updateError,
    } = await supabaseAdmin
      .from("community_waitlist_leads")
      .update({
        instagram_user_id:
          recipientId,

        status:
          "awaiting_confirmation",

        updated_at:
          new Date().toISOString(),
      })
      .eq(
        "source_comment_id",
        commentId
      );

    if (updateError) {
      console.error(
        "Failed to update waitlist lead:",
        updateError
      );

      return;
    }

    await saveAssistantMessage(
      recipientId,
      FIRST_DM
    );
  } catch (error) {
    console.error(
      "Private reply failed:",
      error
    );

    // Delete reservation so a later retry can work.
    await supabaseAdmin
      .from("community_waitlist_leads")
      .delete()
      .eq(
        "source_comment_id",
        commentId
      );

    throw error;
  }
}

// ======================================================
// HANDLE INSTAGRAM DM
// ======================================================

async function handleMessage(event: any) {
  const senderId =
    event?.sender?.id;

  const message =
    event?.message;

  if (!senderId || !message) {
    return;
  }

  // Ignore messages sent by our own account.
  if (message.is_echo) {
    return;
  }

  const text =
    message.text;

  const messageId =
    message.mid;

  if (!text || !messageId) {
    return;
  }

  console.log("NEW INSTAGRAM DM:", {
    senderId,
    text,
    messageId,
  });

  // ==================================================
  // LOOK FOR EXISTING WAITLIST LEAD
  // ==================================================

  const {
    data: lead,
    error: leadError,
  } = await supabaseAdmin
    .from("community_waitlist_leads")
    .select("*")
    .eq(
      "instagram_user_id",
      senderId
    )
    .maybeSingle();

  if (leadError) {
    console.error(
      "Waitlist lead lookup failed:",
      leadError
    );

    return;
  }

  // ==================================================
  // NEW DIRECT-DM ENTRY
  //
  // If they're not already in the funnel but they DM
  // "community" or a close typo, start the waitlist.
  // ==================================================

  if (!lead) {
    if (!isCommunityTrigger(text)) {
      console.log(
        "Normal DM unrelated to community waitlist"
      );

      return;
    }

    console.log(
      "DIRECT COMMUNITY DM DETECTED:",
      text
    );

    // Save incoming DM first for duplicate protection.
    const saved =
      await saveUserMessage(
        senderId,
        text,
        messageId
      );

    if (!saved) {
      console.log(
        "Duplicate direct community DM ignored:",
        messageId
      );

      return;
    }
const instagramUsername =
  await getInstagramUsername(
    senderId,
    messageId
  );

console.log(
  "FINAL INSTAGRAM USERNAME:",
  instagramUsername
);

console.log(
  "DIRECT DM USERNAME:",
  instagramUsername
);
    const {
      error: createLeadError,
    } = await supabaseAdmin
      .from("community_waitlist_leads")
      .insert({
        instagram_user_id:
          senderId,

       instagram_username:
  instagramUsername,

        status:
          "awaiting_confirmation",

        // Keeps your existing NOT NULL + UNIQUE
        // source_comment_id column happy.
        source_comment_id:
          `dm:${messageId}`,

        source_media_id:
          null,

        source_comment_text:
          text,

        updated_at:
          new Date().toISOString(),
      });

    if (createLeadError) {
      // Another webhook request may have created
      // the lead at almost the same time.
      if (
        createLeadError.code === "23505"
      ) {
        console.log(
          "Direct DM lead already exists"
        );

        return;
      }

      console.error(
        "Failed to create direct-DM waitlist lead:",
        createLeadError
      );

      return;
    }

    await sendInstagramMessage(
      senderId,
      FIRST_DM
    );

    await saveAssistantMessage(
      senderId,
      FIRST_DM
    );

    console.log(
      "DIRECT DM WAITLIST FUNNEL STARTED:",
      senderId
    );

    return;
  }

  // ==================================================
  // AUTOMATION ALREADY FINISHED
  // ==================================================

  if (
    lead.status === "waitlisted" ||
    lead.status === "declined"
  ) {
    console.log(
      "Waitlist automation already finished for:",
      senderId
    );

    return;
  }

  // ==================================================
  // SAVE MESSAGE + DUPLICATE PROTECTION
  // ==================================================

  const saved =
    await saveUserMessage(
      senderId,
      text,
      messageId
    );

  if (!saved) {
    console.log(
      "Duplicate Instagram message ignored:",
      messageId
    );

    return;
  }

  // ==================================================
  // EMAIL SENT
  // ==================================================

  const email =
    extractEmail(text);

  if (email) {
    await completeWaitlist(
      senderId,
      email
    );

    return;
  }

  // ==================================================
  // LOAD CONVERSATION
  // ==================================================

  const conversation =
    await getConversation(
      senderId
    );

  // ==================================================
  // AI DECIDES NEXT RESPONSE
  // ==================================================

  const decision =
    await generateWaitlistReply({
      status:
        lead.status,

      conversation,
    });

  console.log(
    "WAITLIST AI DECISION:",
    decision
  );

  // ==================================================
  // THEY WANT TO JOIN
  // ==================================================

  if (
    decision.action ===
    "ask_email"
  ) {
    await updateLeadStatus(
      senderId,
      "awaiting_email"
    );
  }

  // ==================================================
  // THEY DON'T WANT TO JOIN
  // ==================================================

  if (
    decision.action ===
    "decline"
  ) {
    await updateLeadStatus(
      senderId,
      "declined"
    );
  }

  // ==================================================
  // SEND RESPONSE
  // ==================================================

  await sendInstagramMessage(
    senderId,
    decision.reply
  );

  await saveAssistantMessage(
    senderId,
    decision.reply
  );
}

// ======================================================
// OPENAI WAITLIST CONVERSATION
// ======================================================

async function generateWaitlistReply(
  input: {
    status: string;

    conversation: {
      role:
        | "user"
        | "assistant";

      content: string;
    }[];
  }
): Promise<WaitlistDecision> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is missing"
    );
  }

  const communityPrice =
    process.env
      .COMMUNITY_PRICE_TEXT ??
    "$10/month";

  const response =
    await openai.responses.create({
      model:
        process.env
          .OPENAI_MODEL ??
        "gpt-5.6-luna",

      reasoning: {
        effort: "none",
      },

      store: false,

      instructions: `
You handle Instagram DMs for a calisthenics community waitlist.

The person originally commented on an Instagram Reel or post because they were interested in the community.

The first private message already sent to them was:

"Hey bro! I saw that you're interested in the calisthenics community. Do you want me to add you to the waitlist for when it releases?"

CURRENT WAITLIST STATUS:
${input.status}

MAIN GOAL:
Get people who genuinely want early access onto the waitlist.

If they want to join the waitlist, ask for the best email address to add them.

Do not ask for unnecessary information.

ABOUT THE COMMUNITY:
- it is focused on calisthenics
- it will help people learn and improve at calisthenics
- it has not launched yet
- the waitlist is for people who want to know when it releases
- do not invent a release date
- the planned price is ${communityPrice}

PRICE RULE:
NEVER proactively mention the price.

Only mention the price if the person directly asks:
- how much it costs
- whether it is free
- what the price is
- whether there is a membership fee

If they directly ask, answer honestly using the planned price above.

STYLE:
- natural Instagram DM style
- casual
- friendly
- concise
- "bro" is okay when natural
- usually 1 or 2 short sentences
- do not sound corporate
- do not write huge paragraphs
- do not use em dashes
- do not use en dashes
- don't pressure them
- don't use fake urgency
- respond directly to what they said

CONSENT / WAITLIST LOGIC:

If they clearly want to be added, for example:
- "yes"
- "yeah"
- "yep"
- "add me"
- "i'm in"
- "im down"
- "sure"
- "definitely"
- "put me on it"
- "sign me up"
- "100%"

Then:
- action = "ask_email"
- naturally ask them for the best email for the waitlist

If they clearly do NOT want to join:
- action = "decline"
- send a short friendly response
- do not keep selling

If they ask questions or are unsure:
- action = "reply"
- answer their question naturally
- do NOT ask for their email until they actually show interest

If the status is "awaiting_email":
- they have already agreed to join
- if they have not provided an email, naturally ask/remind them for the best email
- action should normally be "ask_email"

IMPORTANT:
- do not explicitly claim to be a specific named person
- do not invent personal experiences
- if directly asked whether the replies are automated or AI-generated, answer accurately
- never ask for passwords
- never ask for payment card details
- never invent prices, offers or launch dates
`,

      input:
        input.conversation.map(
          (message) => ({
            role:
              message.role,

            content:
              message.content,
          })
        ),

      max_output_tokens: 120,

      text: {
        verbosity: "low",

        format: {
          type:
            "json_schema",

          name:
            "community_waitlist_decision",

          strict: true,

          schema: {
            type:
              "object",

            properties: {
              reply: {
                type:
                  "string",
              },

              action: {
                type:
                  "string",

                enum: [
                  "reply",
                  "ask_email",
                  "decline",
                ],
              },
            },

            required: [
              "reply",
              "action",
            ],

            additionalProperties:
              false,
          },
        },
      },
    });

  if (!response.output_text) {
    throw new Error(
      "OpenAI returned no output"
    );
  }

  return JSON.parse(
    response.output_text
  ) as WaitlistDecision;
}

async function getInstagramUsername(
  senderId: string,
  messageId: string
): Promise<string | null> {
  const accessToken =
    process.env.INSTAGRAM_ACCESS_TOKEN;

  const accountId =
    process.env.INSTAGRAM_ACCOUNT_ID;

  const version =
    process.env.INSTAGRAM_GRAPH_VERSION ??
    "v26.0";

  if (!accessToken || !accountId) {
    console.error(
      "Missing Instagram credentials for username lookup"
    );

    return null;
  }

  // ==================================================
  // METHOD 1:
  // LOOK UP THE EXACT MESSAGE
  // ==================================================

  try {
    const params =
      new URLSearchParams({
        fields:
          "id,created_time,from,to,message",
      });

    const response =
      await fetch(
        `https://graph.instagram.com/${version}/${messageId}?${params}`,
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
      "MESSAGE USERNAME LOOKUP:",
      JSON.stringify(data)
    );

    if (
      response.ok &&
      data?.from?.username
    ) {
      return data.from.username;
    }
  } catch (error) {
    console.error(
      "Message username lookup failed:",
      error
    );
  }

  // ==================================================
  // METHOD 2:
  // FIND CONVERSATION USING SENDER IGSID
  // ==================================================

  try {
    const conversationParams =
      new URLSearchParams({
        user_id:
          senderId,
      });

    const conversationResponse =
      await fetch(
        `https://graph.instagram.com/${version}/${accountId}/conversations?${conversationParams}`,
        {
          headers: {
            Authorization:
              `Bearer ${accessToken}`,
          },
        }
      );

    const conversationData =
      await conversationResponse.json();

    console.log(
      "CONVERSATION LOOKUP:",
      JSON.stringify(
        conversationData
      )
    );

    if (
      !conversationResponse.ok
    ) {
      return null;
    }

    const conversationId =
      conversationData
        ?.data?.[0]?.id;

    if (!conversationId) {
      console.error(
        "No conversation found for:",
        senderId
      );

      return null;
    }

    // ==================================================
    // GET RECENT MESSAGES + THEIR SENDERS
    // ==================================================

    const messageParams =
      new URLSearchParams({
        fields:
          "messages.limit(20){from,to}",
      });

    const messagesResponse =
      await fetch(
        `https://graph.instagram.com/${version}/${conversationId}?${messageParams}`,
        {
          headers: {
            Authorization:
              `Bearer ${accessToken}`,
          },
        }
      );

    const messagesData =
      await messagesResponse.json();

    console.log(
      "CONVERSATION MESSAGES:",
      JSON.stringify(
        messagesData
      )
    );

    if (!messagesResponse.ok) {
      return null;
    }

    const messages =
      messagesData?.messages
        ?.data ?? [];

    for (const item of messages) {
      if (
        String(item?.from?.id) ===
          String(senderId) &&
        item?.from?.username
      ) {
        return item.from.username;
      }
    }

    return null;
  } catch (error) {
    console.error(
      "Conversation username lookup failed:",
      error
    );

    return null;
  }
}
// ======================================================
// COMPLETE WAITLIST
// ======================================================

async function completeWaitlist(
  senderId: string,
  email: string
) {
  const {
    error,
  } = await supabaseAdmin
    .from("community_waitlist_leads")
    .update({
      email:
        email.toLowerCase(),

      status:
        "waitlisted",

      updated_at:
        new Date().toISOString(),
    })
    .eq(
      "instagram_user_id",
      senderId
    );

  if (error) {
    console.error(
      "Failed to save waitlist email:",
      error
    );

    return;
  }

  const confirmation =
    "you're on the waitlist bro, i'll let you know when it releases 🤝";

  await sendInstagramMessage(
    senderId,
    confirmation
  );

  await saveAssistantMessage(
    senderId,
    confirmation
  );

  console.log(
    "WAITLIST SIGNUP COMPLETE:",
    {
      senderId,
      email,
    }
  );
}

// ======================================================
// LOAD CONVERSATION MEMORY
// ======================================================

async function getConversation(
  senderId: string
) {
  const {
    data,
    error,
  } = await supabaseAdmin
    .from(
      "community_waitlist_messages"
    )
    .select(
      "role, content, created_at"
    )
    .eq(
      "instagram_user_id",
      senderId
    )
    .order(
      "created_at",
      {
        ascending: false,
      }
    )
    .limit(20);

  if (error) {
    console.error(
      "Conversation loading failed:",
      error
    );

    throw error;
  }

  return (
    data ?? []
  )
    .reverse()
    .map(
      (message) => ({
        role:
          message.role as
            | "user"
            | "assistant",

        content:
          message.content,
      })
    );
}

// ======================================================
// SAVE USER MESSAGE
// ======================================================

async function saveUserMessage(
  senderId: string,
  text: string,
  messageId: string
): Promise<boolean> {
  const {
    error,
  } = await supabaseAdmin
    .from(
      "community_waitlist_messages"
    )
    .insert({
      instagram_user_id:
        senderId,

      instagram_message_id:
        messageId,

      role:
        "user",

      content:
        text,
    });

  if (!error) {
    return true;
  }

  // PostgreSQL unique constraint violation
  if (
    error.code === "23505"
  ) {
    return false;
  }

  console.error(
    "User message save failed:",
    error
  );

  throw error;
}

// ======================================================
// SAVE ASSISTANT MESSAGE
// ======================================================

async function saveAssistantMessage(
  senderId: string,
  text: string
) {
  const {
    error,
  } = await supabaseAdmin
    .from(
      "community_waitlist_messages"
    )
    .insert({
      instagram_user_id:
        senderId,

      role:
        "assistant",

      content:
        text,
    });

  if (error) {
    console.error(
      "Assistant message save failed:",
      error
    );
  }
}

// ======================================================
// UPDATE WAITLIST STATUS
// ======================================================

async function updateLeadStatus(
  senderId: string,
  status: string
) {
  const {
    error,
  } = await supabaseAdmin
    .from(
      "community_waitlist_leads"
    )
    .update({
      status,

      updated_at:
        new Date().toISOString(),
    })
    .eq(
      "instagram_user_id",
      senderId
    );

  if (error) {
    console.error(
      "Lead status update failed:",
      error
    );
  }
}

// ======================================================
// EMAIL EXTRACTION
// ======================================================

function extractEmail(
  text: string
) {
  const match =
    text.match(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
    );

  return (
    match?.[0] ??
    null
  );
}

// ======================================================
// COMMUNITY TRIGGER MATCHING
// ======================================================

function isCommunityTrigger(
  text: string
) {
  const words =
    text
      .toLowerCase()
      .match(/[a-z]+/g) ??
    [];

  const target =
    "community";

  for (const word of words) {
    // Exact:
    // community
    if (
      word === target
    ) {
      return true;
    }

    // Prevent tiny random words being fuzzy-matched.
    if (
      word.length < 6
    ) {
      continue;
    }

    // Common typos such as:
    //
    // comunity
    // communty
    // commmunity
    // communityy
    // comunty

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
// PRIVATE DM FROM COMMENT
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
        method: "POST",

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

  if (!response.ok) {
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
        method: "POST",

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

  if (!response.ok) {
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
// VERIFY META / INSTAGRAM WEBHOOK SIGNATURE
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
      .update(rawBody)
      .digest("hex");

  const actualBuffer =
    Buffer.from(signature);

  const expectedBuffer =
    Buffer.from(expected);

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